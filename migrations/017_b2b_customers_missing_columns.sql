-- 017_b2b_customers_missing_columns.sql
-- Adds compatibility-layer columns to gold.b2b_customers if missing.
-- Safe to re-run; ADD COLUMN IF NOT EXISTS is idempotent.

ALTER TABLE gold.b2b_customers
  ADD COLUMN IF NOT EXISTS custom_tags text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS product_notes jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS search_tsv tsvector,
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS updated_by uuid;
