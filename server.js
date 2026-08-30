// REELFORGE backend — handles video generation requests.
// The video-provider API key lives ONLY here, as an environment variable,
// never in frontend code. The browser talks to this server; this server
// talks to the video provider (Segmind, using their Seedance models).

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
const SITE_URL = process.env.SITE_URL || 'https://reelforge.dev';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Service-role client: can update any profile. Backend only, never the browser.
const supaAdmin = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

// What each thing costs and how many credits it grants.
// Credits are counted in hundredths: 100 credits ~= a 5s 720p Seedance 2.0 render.
const PACKS = {
  payg10:  { name: 'REELFORGE — 600 credits',   amount: 1000, credits: 600,  mode: 'payment' },
  payg20:  { name: 'REELFORGE — 1,300 credits', amount: 2000, credits: 1300, mode: 'payment' },
  payg30:  { name: 'REELFORGE — 2,000 credits', amount: 3000, credits: 2000, mode: 'payment' },
  creator: { name: 'REELFORGE Creator',         amount: 3125, credits: 2500, mode: 'subscription' },
  studio:  { name: 'REELFORGE Studio',          amount: 8000, credits: 8000, mode: 'subscription' }
};

// ---- Credit pricing ----
// Credits charged per second of output. MUST stay in sync with index.html.
// Derived from Segmind's published per-second API rates plus margin.
const CREDIT_RATES = {
  'seedance-2.0': { '480p': 10, '720p': 20, '1080p': 45, '4k': 180 },
  'seedance-2.5': { '480p': 17, '720p': 35, '1080p': 85 }
};

const DURATION_LIMITS = {
  'seedance-2.0': { min: 4, max: 15 },
  'seedance-2.5': { min: 4, max: 30 }
};

const VALID_RATIOS = ['9:16', '1:1', '16:9', 'adaptive'];

// Returns the cost in credits, or null if the combination isn't allowed.
// This is the authority on pricing — never trust a number sent by the browser.
function creditCost(model, quality, duration) {
  const rates = CREDIT_RATES[model];
  if (!rates) return null;
  const rate = rates[quality];
  if (!rate) return null;
  const limits = DURATION_LIMITS[model];
  const d = Number(duration);
  if (!Number.isInteger(d) || d < limits.min || d > limits.max) return null;
  return Math.ceil(rate * d);
}

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

// Deducts credits from a user, backend-side. Returns the new balance,
// or -1 if they don't have enough. Uses spend_credits_for (service-role only)
// because spend_credits relies on auth.uid(), which is null for the backend.
async function spendCreditsFor(userId, amount) {
  if (!supaAdmin) return -1;
  const { data, error } = await supaAdmin.rpc('spend_credits_for', {
    target_user: userId,
    amount: amount
  });
  if (error) {
    console.error('spend_credits_for failed:', error);
    return -1;
  }
  return data;
}

// Gives credits back when a render fails, so nobody pays for nothing.
async function refundCreditsFor(userId, amount) {
  if (!supaAdmin || !userId || !amount) return;
  const { error } = await supaAdmin.rpc('spend_credits_for', {
    target_user: userId,
    amount: -amount
  });
  if (error) console.error('refund failed:', error);
  else console.log(`Refunded ${amount} credits to ${userId}`);
}

// How many finished clips we keep playable per user. Older ones have their
// video file deleted from storage, but the history row stays — so the user
// still sees what they made, it just can't be played back any more.
const KEEP_PER_USER = 10;

// Deletes the stored video files for everything beyond the newest
// KEEP_PER_USER renders. Keeps storage flat no matter how much someone makes.
async function pruneOldRenders(userId) {
  if (!supaAdmin || !userId) return;
  try {
    const { data, error } = await supaAdmin
      .from('renders')
      .select('id, storage_path')
      .eq('user_id', userId)
      .not('storage_path', 'is', null)
      .order('created_at', { ascending: false })
      .range(KEEP_PER_USER, KEEP_PER_USER + 199);

    if (error) throw error;
    if (!data || !data.length) return;

    const paths = data.map(r => r.storage_path).filter(Boolean);
    if (!paths.length) return;

    const { error: delErr } = await supaAdmin.storage.from('renders').remove(paths);
    if (delErr) throw delErr;

    // Clear the path so we don't try to delete these again, and so the
    // profile page knows the clip has expired.
    const { error: updErr } = await supaAdmin
      .from('renders')
      .update({ storage_path: null, video_url: null })
      .in('id', data.map(r => r.id));
    if (updErr) throw updErr;

    console.log(`Pruned ${paths.length} old clip(s) for ${userId}`);
  } catch (err) {
    console.error('pruneOldRenders failed:', err);
  }
}

// Copies a finished render into our own storage and records it, so the
// user's profile gallery still works after the provider's URL expires.
// Best-effort: if archiving fails the user still gets their video, they
// just won't see it in their gallery later.
async function archiveRender(job, providerUrl) {
  if (!supaAdmin || !job || !job.userId || !providerUrl) return providerUrl;

  try {
    const videoRes = await fetch(providerUrl);
    if (!videoRes.ok) throw new Error('download failed: ' + videoRes.status);
    const buffer = Buffer.from(await videoRes.arrayBuffer());

    const path = `${job.userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;

    const { error: upErr } = await supaAdmin.storage
      .from('renders')
      .upload(path, buffer, { contentType: 'video/mp4', upsert: false });
    if (upErr) throw upErr;

    const { data: pub } = supaAdmin.storage.from('renders').getPublicUrl(path);
    const storedUrl = pub?.publicUrl || providerUrl;

    const { error: insErr } = await supaAdmin.from('renders').insert({
      user_id: job.userId,
      video_url: storedUrl,
      storage_path: path,
      prompt: job.prompt || null,
      model: job.model || null,
      quality: job.quality || null,
      ratio: job.ratio || null,
      duration: job.duration ? parseInt(job.duration, 10) : null,
      credits: job.cost || null
    });
    if (insErr) throw insErr;

    console.log(`Archived render for ${job.userId} -> ${path}`);

    // Keep only the newest few clips per user so storage stays bounded.
    await pruneOldRenders(job.userId);

    return storedUrl;
  } catch (err) {
    // Don't fail the render over this — the user already paid and the
    // clip exists. They just lose the gallery entry.
    console.error('archiveRender failed:', err);
    return providerUrl;
  }
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
  const { prompt, ratio, model, quality, duration, image, accessToken } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'A prompt is required.' });
  }
  if (!supaAdmin) {
    return res.status(500).json({ error: 'Server not configured.' });
  }

  // Who is this? Verified against Supabase, not taken on trust.
  const { data: userData, error: userErr } = await supaAdmin.auth.getUser(accessToken);
  if (userErr || !userData || !userData.user) {
    return res.status(401).json({ error: 'Please log in again.' });
  }
  const userId = userData.user.id;

  // Work out the price here. The browser's opinion of the cost is ignored.
  const cost = creditCost(model, quality, duration);
  if (cost === null) {
    return res.status(400).json({ error: 'Invalid model, resolution or length.' });
  }
  if (ratio && VALID_RATIOS.indexOf(ratio) === -1) {
    return res.status(400).json({ error: 'Invalid aspect ratio.' });
  }

  // Take the credits before doing any work.
  const newBalance = await spendCreditsFor(userId, cost);
  if (newBalance === -1) {
    return res.status(402).json({ error: 'Not enough credits — buy more to keep generating.' });
  }

  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  // MOCK MODE — runs automatically until you add a real SEGMIND_API_KEY.
  // Lets you test the full frontend <-> backend flow before paying for
  // any real generations.
  if (!SEGMIND_API_KEY) {
    jobs[jobId] = {
      status: 'queued', progress: 0, videoUrl: null,
      prompt, ratio, model, quality, duration,
      userId, cost, refunded: false
    };
    simulateMockRender(jobId);
    return res.json({ jobId, mode: 'mock', credits: cost, balance: newBalance });
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
        duration: parseInt(duration, 10),
        resolution: quality,
        aspect_ratio: image ? 'adaptive' : ratio,
        generate_audio: true
      }, image ? { first_frame_url: image } : {}))
    });

    const data = await response.json();

    if (!response.ok || !data?.request_id) {
      console.error('Segmind submit error:', response.status, JSON.stringify(data));
      await refundCreditsFor(userId, cost);
      return res.status(502).json({ error: 'Video provider error', detail: data });
    }

    jobs[jobId] = {
      status: 'processing', progress: 5, videoUrl: null,
      segmindRequestId: data.request_id,
      prompt, ratio, model, quality, duration,
      userId, cost, refunded: false
    };
    pollSegmindJob(jobId, data.request_id);
    return res.json({ jobId, mode: 'live', credits: cost, balance: newBalance });
  } catch (err) {
    console.error('Segmind request failed:', err);
    await refundCreditsFor(userId, cost);
    return res.status(500).json({ error: 'Failed to reach video provider', detail: String(err) });
  }
});

// ---- Poll job status (called by the frontend) ----
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Marks a job failed and refunds its credits exactly once.
async function failJob(jobId, message) {
  const job = jobs[jobId];
  if (!job || job.refunded) return;
  job.status = 'error';
  job.error = message;
  job.refunded = true;
  await refundCreditsFor(job.userId, job.cost);
}

// ---- Poll Segmind's actual task status until it's done ----
async function pollSegmindJob(jobId, requestId) {
  // Render time scales with clip length, and 2.5 is slower than 2.0.
  // A 30s clip can take well over 15 minutes, so a flat timeout kills
  // jobs that are still running fine on Segmind's side.
  // Budget: 90s of waiting per second of video, floor of 8 minutes,
  // ceiling of 30 minutes.
  const job0 = jobs[jobId] || {};
  const seconds = Number(job0.duration) || 5;
  const slowModel = (job0.model || '').indexOf('2.5') !== -1;
  const budgetMs = Math.min(
    30 * 60 * 1000,
    Math.max(8 * 60 * 1000, seconds * (slowModel ? 120 : 90) * 1000)
  );
  const maxAttempts = Math.ceil(budgetMs / 5000);
  console.log(`Polling job ${jobId}: up to ${Math.round(budgetMs/60000)} min (${seconds}s clip)`);
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
        const providerUrl = resultData?.output || null;

        // Copy it into our own storage so it survives the provider's
        // link expiring, then serve that copy to the browser.
        const finalUrl = providerUrl
          ? await archiveRender(jobs[jobId], providerUrl)
          : null;

        if (!jobs[jobId]) return; // job cleared while we were archiving
        jobs[jobId].status = 'complete';
        jobs[jobId].progress = 100;
        jobs[jobId].videoUrl = finalUrl;
        return;
      }

      if (statusData.status === 'FAILED') {
        await failJob(jobId, statusData?.error || 'Segmind reported generation failure');
        return;
      }

      // still QUEUED or PROCESSING
      jobs[jobId].progress = Math.min(90, 10 + attempts * 3);

      if (attempts < maxAttempts) {
        setTimeout(check, 5000);
      } else {
        // Segmind has very likely finished and billed us by now, so log the
        // request id — the clip can still be pulled from the Segmind
        // dashboard rather than being paid for and lost.
        console.error(
          `TIMEOUT after ${Math.round(attempts*5/60)} min. ` +
          `Segmind request_id=${requestId} (user ${jobs[jobId]?.userId}) ` +
          `— clip may exist and be recoverable.`
        );
        await failJob(jobId, 'Render took too long and timed out — credits refunded');
      }
    } catch (err) {
      console.error('Segmind poll error:', err);
      if (attempts < maxAttempts) {
        setTimeout(check, 5000);
      } else {
        await failJob(jobId, 'Failed to poll Segmind status');
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
