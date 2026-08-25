// REELFORGE backend — handles video generation requests.
// The video-provider API key lives ONLY here, as an environment variable,
// never in frontend code. The browser talks to this server; this server
// talks to the video provider (Segmind, using their Seedance 2.0 model).

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;

// ---- Stripe / Supabase config (all from environment variables) ----
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE_URL = process.env.SITE_URL || 'https://sammy8112.github.io/Reelforge-frontend/';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Service-role client: can update any profile. Backend only, never the browser.
const supaAdmin = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

// What each thing costs and how many credits it grants.
const PACKS = {
  payg10:  { name: 'REELFORGE — 6 credits',  amount: 1000, credits: 6,  mode: 'payment' },
  payg20:  { name: 'REELFORGE — 13 credits', amount: 2000, credits: 13, mode: 'payment' },
  payg30:  { name: 'REELFORGE — 20 credits', amount: 3000, credits: 20, mode: 'payment' },
  creator: { name: 'REELFORGE Creator',      amount: 3125, credits: 25, mode: 'subscription' },
  studio:  { name: 'REELFORGE Studio',       amount: 8000, credits: 80, mode: 'subscription' }
};

// ---- Stripe webhook ----
// Registered BEFORE express.json() because signature checking needs the raw body.
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(500).send('Stripe not configured');

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      await grantCredits(session.metadata.user_id, parseInt(session.metadata.credits, 10), event.id);
    }

    // Monthly subscription renewals
    if (event.type === 'invoice.paid' && event.data.object.billing_reason === 'subscription_cycle') {
      const invoice = event.data.object;
      const sub = await stripe.subscriptions.retrieve(invoice.subscription);
      await grantCredits(sub.metadata.user_id, parseInt(sub.metadata.credits, 10), event.id);
    }
  } catch (err) {
    console.error('Webhook handling error:', err);
    return res.status(500).send('handler failed');
  }

  res.json({ received: true });
});

// Adds credits to a user. Records the Stripe event id so a repeated
// webhook delivery can't grant the same credits twice.
async function grantCredits(userId, credits, eventId) {
  if (!supaAdmin || !userId || !credits) {
    console.error('grantCredits missing data', { userId, credits });
    return;
  }
  const { error } = await supaAdmin.rpc('grant_credits', {
    target_user: userId,
    amount: credits,
    event_id: eventId
  });
  if (error) console.error('grant_credits failed:', error);
  else console.log(`Granted ${credits} credits to ${userId}`);
}

app.use(express.json({ limit: '10mb' }));

// ---- Create a Stripe Checkout session ----
app.post('/api/checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Payments not configured yet.' });
  if (!supaAdmin) return res.status(500).json({ error: 'Server not configured.' });

  const { pack, accessToken } = req.body;
  const chosen = PACKS[pack];
  if (!chosen) return res.status(400).json({ error: 'Unknown pack.' });

  // Verify the user really is who they say they are
  const { data: userData, error: userErr } = await supaAdmin.auth.getUser(accessToken);
  if (userErr || !userData || !userData.user) {
    return res.status(401).json({ error: 'Please log in again.' });
  }
  const user = userData.user;

  try {
    const priceData = {
      currency: 'gbp',
      product_data: { name: chosen.name },
      unit_amount: chosen.amount
    };
    if (chosen.mode === 'subscription') priceData.recurring = { interval: 'month' };

    const session = await stripe.checkout.sessions.create({
      mode: chosen.mode,
      line_items: [{ price_data: priceData, quantity: 1 }],
      customer_email: user.email,
      success_url: `${SITE_URL}?purchase=success`,
      cancel_url: `${SITE_URL}?purchase=cancelled`,
      metadata: { user_id: user.id, credits: String(chosen.credits) },
      subscription_data: chosen.mode === 'subscription'
        ? { metadata: { user_id: user.id, credits: String(chosen.credits) } }
        : undefined
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
});

// ---- Config ----
// Set this in your hosting provider's environment variables, never in code.
const SEGMIND_API_KEY = process.env.SEGMIND_API_KEY;
const SEGMIND_BASE = 'https://api.segmind.com/v2';
const MODEL_IDS = { 'seedance-2.0': 'seedance-2.0', 'seedance-2.5': 'seedance-2.5' };
const SEGMIND_STATUS_URL = (id) => `https://api.segmind.com/v2/requests/${id}/status`;
const SEGMIND_RESULT_URL = (id) => `https://api.segmind.com/v2/requests/${id}`;

// In-memory job store. Fine for a demo; swap for a real database (Postgres,
// SQLite, etc.) once you have real users and need jobs to survive a restart.
const jobs = {};

// ---- Health check ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: SEGMIND_API_KEY ? 'live' : 'mock' });
});

// ---- Kick off a video generation job ----
app.post('/api/generate', async (req, res) => {
  const { prompt, ratio, model, quality, duration, image } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'A prompt is required.' });
  }

  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  // MOCK MODE — runs automatically until you add a real SEGMIND_API_KEY.
  // Lets you test the full frontend <-> backend flow before paying for
  // any real generations.
  if (!SEGMIND_API_KEY) {
    jobs[jobId] = { status: 'queued', progress: 0, videoUrl: null, prompt, ratio, model, quality, duration };
    simulateMockRender(jobId);
    return res.json({ jobId, mode: 'mock' });
  }

  // LIVE MODE — real call to Segmind.
  try {
    const modelId = MODEL_IDS[model] || 'seedance-2.0';
    const response = await fetch(`${SEGMIND_BASE}/${modelId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': SEGMIND_API_KEY
      },
      body: JSON.stringify(Object.assign({
        prompt: prompt,
        duration: parseInt(duration, 10) || 5,
        resolution: quality || '720p',
        aspect_ratio: image ? 'adaptive' : ratio,
        generate_audio: true
      }, image ? { first_frame_url: image } : {}))
    });

    const data = await response.json();

    if (!response.ok || !data?.request_id) {
      console.error('Segmind submit error:', response.status, JSON.stringify(data));
      return res.status(502).json({ error: 'Video provider error', detail: data });
    }

    jobs[jobId] = { status: 'processing', progress: 5, videoUrl: null, segmindRequestId: data.request_id };
    pollSegmindJob(jobId, data.request_id);
    return res.json({ jobId, mode: 'live' });
  } catch (err) {
    console.error('Segmind request failed:', err);
    return res.status(500).json({ error: 'Failed to reach video provider', detail: String(err) });
  }
});

// ---- Poll job status (called by the frontend) ----
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ---- Poll Segmind's actual task status until it's done ----
async function pollSegmindJob(jobId, requestId) {
  const maxAttempts = 60; // video gen can take a few minutes
  let attempts = 0;

  const check = async () => {
    if (!jobs[jobId]) return; // job was cleared
    attempts++;

    try {
      const statusRes = await fetch(SEGMIND_STATUS_URL(requestId), {
        headers: { 'x-api-key': SEGMIND_API_KEY }
      });
      const statusData = await statusRes.json();

      if (statusData.status === 'COMPLETED') {
        const resultRes = await fetch(SEGMIND_RESULT_URL(requestId), {
          headers: { 'x-api-key': SEGMIND_API_KEY }
        });
        const resultData = await resultRes.json();
        jobs[jobId].status = 'complete';
        jobs[jobId].progress = 100;
        jobs[jobId].videoUrl = resultData?.output || null;
        return;
      }

      if (statusData.status === 'FAILED') {
        jobs[jobId].status = 'error';
        jobs[jobId].error = statusData?.error || 'Segmind reported generation failure';
        return;
      }

      // still QUEUED or PROCESSING
      jobs[jobId].progress = Math.min(90, 10 + attempts * 3);

      if (attempts < maxAttempts) {
        setTimeout(check, 5000);
      } else {
        jobs[jobId].status = 'error';
        jobs[jobId].error = 'Timed out waiting for Segmind';
      }
    } catch (err) {
      console.error('Segmind poll error:', err);
      if (attempts < maxAttempts) {
        setTimeout(check, 5000);
      } else {
        jobs[jobId].status = 'error';
        jobs[jobId].error = 'Failed to poll Segmind status';
      }
    }
  };

  check();
}

// ---- Mock render simulator (mode: no API key set yet) ----
function simulateMockRender(jobId) {
  let progress = 0;
  const interval = setInterval(() => {
    progress += 20;
    if (!jobs[jobId]) return clearInterval(interval);
    if (progress >= 100) {
      jobs[jobId].status = 'complete';
      jobs[jobId].progress = 100;
      // placeholder sample video so the full flow — including playback — works end to end
      jobs[jobId].videoUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
      clearInterval(interval);
    } else {
      jobs[jobId].status = 'processing';
      jobs[jobId].progress = progress;
    }
  }, 1200);
}

app.listen(PORT, () => {
  console.log(`REELFORGE backend running on port ${PORT}`);
  console.log(`Mode: ${SEGMIND_API_KEY ? 'LIVE (using real Segmind API key)' : 'MOCK (no SEGMIND_API_KEY set yet)'}`);
});
