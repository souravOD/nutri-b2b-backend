# Ingestion Orchestrator (External Service)

The Jobs and Import features depend on an **external Python orchestrator service** that is **not included in this repository**. This document describes the integration contract and how to run the system with or without it.

---

## Overview

When a user uploads a CSV (via the Import Wizard) or triggers product/customer ingestion via the API, the B2B backend either:

1. **Calls the orchestrator** — If running, the orchestrator processes the CSV from Supabase Storage, writes to Bronze/Gold tables, and updates `orchestration.orchestration_runs`.
2. **Records a pending run** — If the orchestrator is unreachable, the backend inserts a row in `orchestration.orchestration_runs` with `status = 'pending'` so the Jobs page can display it. The CSV is stored safely in Supabase Storage and can be processed when the orchestrator comes online.

---

## Environment Variable

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCHESTRATOR_URL` | `http://localhost:8100` | Base URL of the ingestion orchestrator HTTP API |

---

## API Contract (What the Orchestrator Must Expose)

### POST /api/trigger

Initiates an ingestion flow. Called by the B2B backend after a CSV is uploaded to Supabase Storage or when batch product/customer records are landed in Bronze.

**Request body:**
```json
{
  "flow_name": "full_ingestion" | "bronze_to_gold",
  "vendor_id": "uuid",
  "source_name": "products" | "customers" | "csv_upload" | ...,
  "storage_bucket": "bucket-name",
  "storage_path": "vendors/{vendor_id}/.../file.csv"
}
```

- `flow_name`: `full_ingestion` — process CSV from Storage; `bronze_to_gold` — process records already in Bronze.
- `storage_bucket` / `storage_path`: Required for `full_ingestion`; omit for `bronze_to_gold`.

**Response:**
```json
{
  "run_id": "uuid",
  "status": "pending" | "running",
  "flow_name": "full_ingestion"
}
```

The orchestrator should create a row in `orchestration.orchestration_runs` with the returned `run_id` and process the flow asynchronously.

---

### GET /api/runs/:runId

Returns the current status of an orchestration run. Called by the backend when serving `GET /jobs/:id` (legacy) or when the frontend polls run details.

**Response:**
```json
{
  "id": "uuid",
  "status": "pending" | "running" | "completed" | "failed",
  "progress_pct": 85,
  "current_layer": "silver_dedup",
  "total_errors": 2,
  "total_records_written": 1500,
  "started_at": "2025-03-10T12:00:00Z",
  "completed_at": "2025-03-10T12:05:00Z",
  "error_message": null
}
```

---

## Database Tables (Managed by Orchestrator)

The orchestrator reads from and writes to:

- `orchestration.orchestration_runs` — Run metadata (created by orchestrator on trigger)
- `orchestration.pipeline_runs` — Per-layer progress
- Bronze tables (`bronze.raw_products`, `bronze.raw_customers`, etc.) — Source for `bronze_to_gold`
- Gold tables (`gold.products`, `gold.b2b_customers`, etc.) — Target for processing

Schema migrations are in `migrations/011_bronze_ingest_tables.sql` and `migrations/012_orchestration_vendor_support.sql`.

---

## Running Without the Orchestrator

**Jobs page**: Still works. Runs are listed from `orchestration.orchestration_runs`. CSV imports create **pending** runs that appear on the Jobs page.

**Import Wizard**: Completes successfully — the CSV is stored in Supabase Storage and a pending run is recorded. When the orchestrator is eventually started, it can poll for pending runs or you can manually retry triggers.

**API health**: Use `GET /api/v1/admin/orchestrator-status` (auth required) to check whether the orchestrator is reachable.

---

## Implementing an Orchestrator

To build a full orchestrator service:

1. Expose HTTP endpoints as above on port 8100 (or your chosen port).
2. On `POST /api/trigger` (flow_name `full_ingestion`):
   - Download CSV from Supabase Storage using `storage_bucket` and `storage_path`.
   - Parse CSV, validate, and land rows in Bronze tables.
   - Run Bronze → Silver → Gold transforms.
   - Update `orchestration.orchestration_runs` status and `orchestration.pipeline_runs`.
3. Share the same Supabase and Postgres connection as the B2B backend.
4. Add the service to your deployment (e.g., a separate container in docker-compose).

---

## Docker Compose

The ingestion orchestrator is **not** defined in the project's `docker-compose.yml`. The compose file includes:

- `backend` (Node, port 5000)
- `frontend` (Next.js, port 3000)
- `rag` (RAG pipeline for search/chat, port 8000) — **different from the ingestion orchestrator**
- `db` and `migrator` (optional, profile `localdb`)

To run the full Jobs pipeline, add an orchestrator service and set `ORCHESTRATOR_URL` for the backend to point at it.
