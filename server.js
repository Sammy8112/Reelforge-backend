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
// Kling's international API is served from the Singapore region.
const KLING_BASE_URL = 'https://api-singapore.klingai.com';
const KLING_CREATE_URL = `${KLING_BASE_URL}/v1/videos/text2video`;

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
    const response = await fetch(KLING_CREATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KLING_API_KEY}`
      },
      body: JSON.stringify({
        model_name: 'kling-v2-6',
        prompt: `${prompt}, ${style} style`,
        negative_prompt: '',
        duration: '5',
        mode: 'std',
        sound: 'off',
        aspect_ratio: ratio,
        callback_url: '',
        external_task_id: jobId
      })
    });

    const data = await response.json();

    if (!response.ok || !data?.data?.task_id) {
      console.error('Kling create-task error:', response.status, JSON.stringify(data));
      return res.status(502).json({ error: 'Video provider error', detail: data });
    }

    const klingTaskId = data.data.task_id;
    jobs[jobId] = { status: 'processing', progress: 5, videoUrl: null, klingTaskId };
    pollKlingTask(jobId, klingTaskId);
    return res.json({ jobId, mode: 'live' });
  } catch (err) {
    console.error('Kling request failed:', err);
    return res.status(500).json({ error: 'Failed to reach video provider', detail: String(err) });
  }
});

// ---- Poll job status ----
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ---- Poll Kling's actual task status until it's done ----
async function pollKlingTask(jobId, klingTaskId) {
  const maxAttempts = 40; // ~ up to a few minutes, generous for video gen
  let attempts = 0;

  const check = async () => {
    if (!jobs[jobId]) return; // job was cleared
    attempts++;

    try {
      const res = await fetch(`${KLING_CREATE_URL}/${klingTaskId}`, {
        headers: { 'Authorization': `Bearer ${KLING_API_KEY}` }
      });
      const data = await res.json();
      const task = data?.data;

      if (task?.task_status === 'succeed') {
        const videoUrl = task?.task_result?.videos?.[0]?.url;
        jobs[jobId].status = 'complete';
        jobs[jobId].progress = 100;
        jobs[jobId].videoUrl = videoUrl || null;
        return;
      }

      if (task?.task_status === 'failed') {
        jobs[jobId].status = 'error';
        jobs[jobId].error = task?.task_status_msg || 'Kling reported generation failure';
        return;
      }

      // still processing
      jobs[jobId].progress = Math.min(90, 10 + attempts * 5);

      if (attempts < maxAttempts) {
        setTimeout(check, 4000);
      } else {
        jobs[jobId].status = 'error';
        jobs[jobId].error = 'Timed out waiting for Kling';
      }
    } catch (err) {
      console.error('Kling poll error:', err);
      if (attempts < maxAttempts) {
        setTimeout(check, 4000);
      } else {
        jobs[jobId].status = 'error';
        jobs[jobId].error = 'Failed to poll Kling status';
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
  console.log(`Mode: ${KLING_API_KEY ? 'LIVE (using real API key)' : 'MOCK (no KLING_API_KEY set yet)'}`);
});
