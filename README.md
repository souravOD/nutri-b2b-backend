# Nutri B2B — Backend (Express + Supabase + Appwrite)

Production-ready backend for the Nutri B2B platform. This repository exposes REST endpoints for products, customers, jobs/ingestion, health/metrics and onboarding. The service runs locally as a long‑lived Node server and deploys to **Vercel** via a lightweight adapter that wraps the Express app as serverless functions.

> **Stack**: Node 20, Express, `pg`, Supabase (DB/Storage), Appwrite (Auth/Profiles), CSV ingestion worker.

---

## Quick Start (Local)

1. **Install**
   ```bash
   npm install
   ```

2. **Configure env**
   Copy `.env.example` to `.env` and fill values. **Use a pooled DB URL** for serverless (Supabase *Connection Pooling* or Neon). For local dev, a direct Postgres URL is fine.

3. **Run**
   ```bash
   npm run dev
   ```
   Server listens on `http://127.0.0.1:5000` by default.

4. **Smoke test**
   ```bash
   curl http://127.0.0.1:5000/health
   curl http://127.0.0.1:5000/healthz
   ```

---

## Environment Variables

| Name | Required | Description |
|---|:---:|---|
| `DATABASE_URL` | ✅ | **Pooled** Postgres connection string (Supabase Connection Pooling / Neon). |
| `READ_DATABASE_URL` |  | Optional read‑replica (also pooled). Falls back to `DATABASE_URL` when unset. |
| `SUPABASE_URL` | ✅ | Supabase project URL (e.g., `https://xyzcompany.supabase.co`). |
| `SUPABASE_ANON_KEY` | ✅ | Supabase anon key (frontend safe, used here server‑side for some SDK flows). |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key (server‑only; required for ingestion + Storage writes). |
| `SUPABASE_CSV_BUCKET` | ✅ | Supabase Storage bucket for CSVs & error reports (e.g., `ingestion`). |
| `APPWRITE_ENDPOINT` | ✅ | Appwrite endpoint (e.g., `https://cloud.appwrite.io/v1`). |
| `APPWRITE_PROJECT_ID` | ✅ | Appwrite project ID. |
| `APPWRITE_API_KEY` | ✅ | Appwrite API key (server‑only) for onboarding/setup actions. |
| `APPWRITE_DB_ID` | ✅ | Appwrite DB (e.g., `b2b`). |
| `APPWRITE_USERPROFILES_COL` | ✅ | Appwrite collection name for user profiles. |
| `APPWRITE_VENDORS_COL` | ✅ | Appwrite collection name for vendors. |
| `CORS_ORIGINS` |  | Comma‑separated allowed origins. If omitted, localhost is allowed in dev; set in prod. |
| `CORS_ALLOW_ALL` |  | Set to `1` to allow any origin (not recommended for prod). |
| `QUEUE_TICK_SECRET` |  | Optional token to protect the cron endpoint `/api/queue-tick`. |

> **Tip:** Never commit `.env` — only `.env.example` is tracked.

---

## Local Auth: Getting an Appwrite JWT

Most API routes require `X-Appwrite-JWT` header. Quick ways to get one:
- From your frontend (user must be logged‑in): call `account.createJWT()` and copy the token.
- From Appwrite console: create a temporary session and generate a JWT.
- Or expose a local auth route in your UI that returns the current JWT for testing.

Use it like:
```bash
curl -H "X-Appwrite-JWT: <jwt>" http://127.0.0.1:5000/products
```

---

## API Overview (selected)

> Full routes are registered in `server/routes.ts`. Below are helpful probes.

- `GET /health` → service health (db connectivity, etc.)  
- `GET /healthz` → cheap liveness endpoint  
- `GET /metrics` → simple counters (auth required in prod)  
- `GET /products` (auth) → list products  
- `POST /jobs` (auth) → start ingestion job (CSV upload flow)  
- `GET /jobs/:id` (auth) → job status  

**HTTP samples**: see [`docs/TESTING.http`](docs/TESTING.http).  
**Postman collection**: see [`docs/postman/Nutri-B2B.postman_collection.json`](docs/postman/Nutri-B2B.postman_collection.json).

---

## Deploy to Vercel (Serverless)

This repo contains a minimal **Vercel adapter** under `api/` and `vercel.json`. It wraps the Express app and exposes a **cron‑driven ingestion tick**.

### 1) Connect GitHub

1. Push this repository to GitHub (instructions below).  
2. In **Vercel → New Project → Import Git Repository**, select this repo.  
3. Framework preset: *Other*. Node version: **20.x** (Project Settings → General → Node.js).

### 2) Configure Environment Variables (Vercel → Project → Settings → Environment Variables)

Add all variables from the table above (copy from `.env.example`).  
**Important:** `DATABASE_URL` **must** be a *pooled* connection string on Vercel (Supabase Connection Pooling / Neon).

### 3) Deploy

Vercel will auto‑build and deploy on push to your selected branch (e.g., `Backend`).

### 4) Cron for Ingestion

Long‑running workers aren’t supported on serverless. Instead, schedule a small **cron “tick”** that processes a job each minute.

- **Create Cron**: Vercel → Project → Settings → **Cron Jobs** → Add Job  
  - Schedule: `*/1 * * * *`  
  - Target: `https://<your-app>.vercel.app/api/queue-tick?secret=<QUEUE_TICK_SECRET>`

> Set `QUEUE_TICK_SECRET` env var first, then include it as a query param or header (`X-Queue-Secret`).

### 5) Test Production

```bash
curl https://<your-app>.vercel.app/healthz
curl -H "X-Appwrite-JWT: <jwt>" https://<your-app>.vercel.app/products
```

---

## Repo Layout (high level)

```
.
├─ api/                    # Vercel serverless entry points (adapter)
│  ├─ index.ts             # Builds Express app and handles requests
│  └─ queue-tick.ts        # Cron endpoint to process ingestion jobs
├─ server/                 # Your actual backend source (Express app, routes, workers)
│  ├─ index.ts             # Local server + long-running worker (dev)
│  ├─ routes.ts            # Registers all routes (auth protected)
│  ├─ routes/              # Route modules (onboard, etc.)
│  ├─ lib/                 # DB/Supabase/Appwrite utilities
│  └─ workers/ingestion.ts # CSV ingestion pipeline
├─ docs/                   # Dev & QA resources
│  ├─ TESTING.http         # Handy REST Client requests
│  └─ postman/             # Postman collection
├─ vercel.json
├─ .env.example
└─ README.md               # (this file)
```

---

## Troubleshooting

**DB connection spikes / ECONNRESET on Vercel**  
→ Switch `DATABASE_URL` to a **pooled** connection. Supabase: *Project → Database → Connection Pooling* (use the pooled URL).

**CORS 403 in production**  
→ Set `CORS_ORIGINS` to include your frontend origin(s), e.g. `https://your-frontend.vercel.app`. In dev, localhost is auto‑allowed.

**Ingestion times out**  
→ Very large CSVs may exceed a single function’s duration. The cron **tick** runs one job at a time. If still too big, consider chunking or moving heavy ingestion to a tiny always‑on worker service.

**401 Unauthorized on protected routes**  
→ Provide `X-Appwrite-JWT` from a valid user session (`account.createJWT()`), and ensure the backend validates via Appwrite SDK.

---

## Contributing & PRs

- Create a feature branch from `Backend`, e.g. `feat/ingestion-progress-ui`.
- Run locally with sample env; add/update docs as needed.
- Open a PR; the template will prompt for env changes and test steps.
- Vercel will build a preview automatically on PRs.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the PR template in `.github/`.

---

## License

Copyright (c) 2025. All rights reserved.
