-- 020_gold_products_gold2_alignment.sql
-- Adds columns from gold 2.sql that quality-scoring and ingest may use.
-- Safe to re-run; ADD COLUMN IF NOT EXISTS is idempotent.

ALTER TABLE gold.products
  ADD COLUMN IF NOT EXISTS image_url character varying(1000),
  ADD COLUMN IF NOT EXISTS manufacturer character varying(255),
  ADD COLUMN IF NOT EXISTS country_of_origin character varying(100),
  ADD COLUMN IF NOT EXISTS global_product_id uuid,
  ADD COLUMN IF NOT EXISTS package_weight_g numeric(10,2),
  ADD COLUMN IF NOT EXISTS serving_size_g numeric(10,2),
  ADD COLUMN IF NOT EXISTS servings_per_container numeric(5,2),
  ADD COLUMN IF NOT EXISTS vendor_specific_attrs jsonb,
  ADD COLUMN IF NOT EXISTS source_system character varying(100);
