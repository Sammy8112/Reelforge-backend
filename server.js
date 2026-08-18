// REELFORGE backend — handles video generation requests.
// The video-provider API key lives ONLY here, as an environment variable,
// never in frontend code. The browser talks to this server; this server
// talks to the video provider.

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ---- Config ----
// Set these in your hosting provider's environment variables, never in code.
const KLING_API_KEY = process.env.KLING_API_KEY;
const KLING_API_URL = 'https://api.klingai.com/v1/videos/text2video'; // confirm exact path in provider docs when you sign up

// In-memory job store. Fine for a demo; swap for a real database (Postgres,
// SQLite, etc.) once you have real users and need jobs to survive a restart.
const jobs = {};

// ---- Health check ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: KLING_API_KEY ? 'live' : 'mock' });
});

// ---- Kick off a video generation job ----
app.post('/api/generate', async (req, res) => {
  const { prompt, style, ratio } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'A prompt is required.' });
  }

  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  // MOCK MODE — runs automatically until you add a real KLING_API_KEY.
  // Lets you test the full frontend <-> backend flow before paying for
  // any real generations.
  if (!KLING_API_KEY) {
    jobs[jobId] = { status: 'queued', progress: 0, videoUrl: null, prompt, style, ratio };
    simulateMockRender(jobId);
    return res.json({ jobId, mode: 'mock' });
  }

  // LIVE MODE — real call to the video provider.
  try {
    const response = await fetch(KLING_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KLING_API_KEY}`
      },
      body: JSON.stringify({
        prompt: `${prompt}, ${style} style`,
        aspect_ratio: ratio
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Video provider error', detail: errText });
    }

    const data = await response.json();
    // NOTE: the exact response shape (where the provider job id lives) will
    // differ — check Kling's actual API docs once you have access and adjust
    // this line to match.
    jobs[jobId] = { status: 'processing', progress: 5, videoUrl: null, providerJobId: data.id };
    return res.json({ jobId, mode: 'live' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach video provider', detail: String(err) });
  }
});

// ---- Poll job status ----
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

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
  console.log(`Mode: ${KLING_API_KEY ? 'LIVE (using real API key)' : 'MOCK (no KLING_API_KEY set yet)'}`);
});
