# REELFORGE Backend — Setup Steps

## What this is
A small server that sits between your website and the video generation
provider. It keeps your API key secret and handles the generation job.

Right now it runs in **MOCK MODE** — no API key needed — and returns a
placeholder video so you can test the entire flow (frontend → backend →
job polling → video playback) before spending anything on real generations.

---

## Step 1 — Get a real video API key

1. Go to a provider's site — Kling AI (klingai.com) is a good first pick
2. Sign up for API/developer access, generate a key
3. Do not paste it into any code file. You'll add it as an environment
   variable when you deploy.

Note: server.js calls a placeholder endpoint URL for Kling (KLING_API_URL)
— once you have real docs access, confirm the exact endpoint path and
request format and update that one line. Providers tweak their exact
request shape often enough that it's worth double checking against their
current docs at that point.

---

## Step 2 — Deploy the backend

Using Railway (railway.app) — easiest, works entirely from a browser,
no local install needed:

1. Push this folder to a new GitHub repo (works from GitHub's web
   uploader — no computer needed)
2. In Railway: "New Project" → "Deploy from GitHub repo"
3. Railway auto-detects it's a Node app and deploys it
4. Once deployed, Railway gives you a public URL like
   https://reelforge-backend-production.up.railway.app

---

## Step 3 — Add your API key (turns on LIVE mode)

1. In Railway, open your project → "Variables" tab
2. Add a variable: KLING_API_KEY = your real key
3. Redeploy (Railway usually does this automatically on save)
4. Your backend logs will now say "Mode: LIVE" instead of "Mode: MOCK"

---

## Step 4 — Connect your frontend to the real backend

In index.html, find this line near the bottom:
const BACKEND_URL = 'http://localhost:3001';

Change it to your Railway URL:
const BACKEND_URL = 'https://reelforge-backend-production.up.railway.app';

Then re-deploy the frontend (Netlify Drop, upload the updated file again).

---

## You're live

Prompt in → real video out, powered by your own key, no exposed secrets.
