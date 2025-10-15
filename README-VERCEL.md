# Deploying the B2B Backend to Vercel

This adapter lets you deploy your existing Express backend to Vercel **without changing your current source files**.
It introduces two serverless functions under `api/` and a root `vercel.json` that rewrites all requests to the Express app.

## What’s included
- `vercel.json` — Node.js serverless runtime, catch-all rewrite to `/api/index.ts`
- `api/index.ts` — Creates the Express app (JSON, CORS, onboarding, routes) and handles requests
- `api/queue-tick.ts` — One-shot queue processor endpoint for ingestion jobs (use with Vercel Cron)
- `.env.example` — Environment variables template for Vercel Project Settings

## Setup (Vercel Dashboard)
1. **Add these files** to the repo (commit & push).
2. In Vercel Project → **Settings → Environment Variables**, add values from `.env.example`:
   - Use a **pooled** Postgres connection string for `DATABASE_URL` (Supabase *Connection Pooling* or Neon).
   - Provide `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY`.
   - Set `APPWRITE_*` variables to match your Appwrite project.
   - Optionally set `READ_DATABASE_URL`, `CORS_ORIGINS`, and `QUEUE_TICK_SECRET`.
3. **Deploy**.

## Local dev (unchanged)
- Keep using `npm run dev` which starts `server/index.ts` on port 5000.

## Ingestion jobs on Vercel
Vercel functions are stateless; the long-running queue worker from `server/index.ts` won’t auto-run.
Instead, schedule a Vercel **Cron Job** to hit `/api/queue-tick` every minute (or trigger manually). Each tick will:
- Atomically `dequeue()` one queued+uploaded job,
- Run `processIngestionJob(job)`,
- Mark failures with retry logic (like the in-process worker).

Optionally, protect the endpoint by setting `QUEUE_TICK_SECRET` and including `X-Queue-Secret: <value>` in your cron request.

## CORS
- If `CORS_ALLOW_ALL=1` → allows any origin.
- Otherwise, set `CORS_ORIGINS` to a comma-separated list (e.g., `http://localhost:3000,https://your-frontend.vercel.app`).
- In dev, `localhost` origins are auto-allowed.

## Notes
- Do **not** commit `.env` with secrets. Use `.env.example` + Vercel env vars.
- If you see many DB connections on Vercel, switch to a **pooled** connection string.
- The adapter keeps your existing routes intact: `/products`, `/customers`, `/jobs`, `/metrics`, `/health`, `/onboard`.
- Any `/api/*` paths will return 404 (matching your existing backend semantics).
