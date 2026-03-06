-- 021_gold_products_inline_nutrition.sql
-- Adds inline nutrition columns from gold 2.sql for fallback when nutrition jsonb is empty.
-- Quality-scoring and product detail can use these. Safe to re-run.

ALTER TABLE gold.products
  ADD COLUMN IF NOT EXISTS calories numeric(10,2),
  ADD COLUMN IF NOT EXISTS total_fat_g numeric(10,2),
  ADD COLUMN IF NOT EXISTS saturated_fat_g numeric(10,2),
  ADD COLUMN IF NOT EXISTS sodium_mg numeric(10,2),
  ADD COLUMN IF NOT EXISTS total_carbs_g numeric(10,2),
  ADD COLUMN IF NOT EXISTS total_sugars_g numeric(10,2),
  ADD COLUMN IF NOT EXISTS added_sugars_g numeric(10,2),
  ADD COLUMN IF NOT EXISTS protein_g numeric(10,2),
  ADD COLUMN IF NOT EXISTS dietary_fiber_g numeric(10,2),
  ADD COLUMN IF NOT EXISTS potassium_mg numeric(10,2),
  ADD COLUMN IF NOT EXISTS phosphorus_mg numeric(10,2);
