# 03_gold.sql Alignment Guide

When your database schema source is **03_gold.sql**, run these steps to align the B2B app.

## 1. Run B2B Compatibility Migrations

```bash
cd nutri-b2b-backend
npm run db:migrate:03gold
```

This runs migrations 018, 019, 020, 022:
- **018** — `sub_category_id`, `cuisine_id`, `market_id` on gold.products
- **019** — `nutrition`, `dietary_tags`, `allergens`, etc. on gold.products
- **020** — `image_url`, `manufacturer`, etc. on gold.products
- **022** — `phone`, `country`, `timezone` on gold.b2b_users (Profile page)

## 2. Verify Schemas

03_gold.sql defines only the `gold` schema. The B2B app also needs:

| Schema/Table | Used For | How to Create |
|-------------|----------|---------------|
| orchestration.orchestration_runs | Jobs page, run detail | Python orchestrator or separate setup |
| orchestration.pipeline_runs | Jobs pipeline list | Same as above |
| orchestration.pipeline_step_logs | Run step logs | Same as above |
| public.diet_rules | Customer matching (condition policy) | Migration 001 or equivalent |
| bronze.raw_products, bronze.raw_customers | Ingestion pipeline | Migration 011 |
| public.ingestion_jobs | Ingest flow | Migration 011 |

Run verification:

```bash
npm run db:verify-schema
```

If any are missing, apply the referenced migrations or create the schema/tables.

## 3. Code Changes Already Applied

- **profile.ts** — Audit log INSERT now uses 03_gold.audit_log columns (table_name, record_id, action, old_values, new_values, changed_by, changed_at)
