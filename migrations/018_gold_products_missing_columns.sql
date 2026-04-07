-- 018_gold_products_missing_columns.sql
-- Adds sub_category_id, cuisine_id, market_id to gold.products if missing.
-- Safe to re-run; ADD COLUMN IF NOT EXISTS is idempotent.
-- Run this if you see: column "sub_category_id" does not exist

ALTER TABLE gold.products
  ADD COLUMN IF NOT EXISTS sub_category_id uuid,
  ADD COLUMN IF NOT EXISTS cuisine_id uuid,
  ADD COLUMN IF NOT EXISTS market_id uuid;
