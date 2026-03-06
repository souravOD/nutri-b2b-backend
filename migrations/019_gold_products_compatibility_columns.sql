-- 019_gold_products_compatibility_columns.sql
-- Adds compatibility-layer columns to gold.products if missing.
-- Fixes: column "nutrition" does not exist (and dietary_tags, allergens, etc.)
-- Safe to re-run; ADD COLUMN IF NOT EXISTS is idempotent.

ALTER TABLE gold.products
  ADD COLUMN IF NOT EXISTS nutrition jsonb,
  ADD COLUMN IF NOT EXISTS dietary_tags text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS allergens text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS certifications text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS regulatory_codes text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS ingredients text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS search_tsv tsvector,
  ADD COLUMN IF NOT EXISTS soft_deleted_at timestamp without time zone,
  ADD COLUMN IF NOT EXISTS product_url text;
