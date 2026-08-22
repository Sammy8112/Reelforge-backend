// REELFORGE backend — handles video generation requests.
// The video-provider API key lives ONLY here, as an environment variable,
// never in frontend code. The browser talks to this server; this server
// talks to the video provider (Segmind, using their Seedance 2.0 model).

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ---- Config ----
// Set this in your hosting provider's environment variables, never in code.
const SEGMIND_API_KEY = process.env.SEGMIND_API_KEY;
const SEGMIND_SUBMIT_URL = 'https://api.segmind.com/v2/seedance-2.0';
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
  const { prompt, style, ratio } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'A prompt is required.' });
  }

  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  // MOCK MODE — runs automatically until you add a real SEGMIND_API_KEY.
  // Lets you test the full frontend <-> backend flow before paying for
  // any real generations.
  if (!SEGMIND_API_KEY) {
    jobs[jobId] = { status: 'queued', progress: 0, videoUrl: null, prompt, style, ratio };
    simulateMockRender(jobId);
    return res.json({ jobId, mode: 'mock' });
  }

  // LIVE MODE — real call to Segmind.
  try {
    const response = await fetch(SEGMIND_SUBMIT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': SEGMIND_API_KEY
      },
      body: JSON.stringify({
        prompt: `${prompt}, ${style} style`,
        duration: 5,
        resolution: '720p',
        aspect_ratio: ratio,
        generate_audio: false
      })
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
