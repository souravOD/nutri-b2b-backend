-- 011_bronze_ingest_tables.sql
-- Creates the Bronze schema and landing tables for the data ingestion pipeline.
-- Also ensures ingestion_jobs exists in public schema (idempotent).

-- ────────────────────────────────────────────────────────────────
-- Schema
-- ────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS bronze;

-- ────────────────────────────────────────────────────────────────
-- ingestion_jobs (public) — ensure it exists even if 001 was
-- applied against a different database / skipped.
-- ────────────────────────────────────────────────────────────────

-- Drop the enum constraint so we can store any mode string
-- (the original migration used a strict enum — we need flexibility).
DO $$
BEGIN
  -- Only create if the table doesn't already exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ingestion_jobs'
  ) THEN
    CREATE TABLE public.ingestion_jobs (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      vendor_id    uuid NOT NULL,
      mode         text NOT NULL,
      status       text NOT NULL DEFAULT 'queued',
      progress_pct integer NOT NULL DEFAULT 0,
      totals       jsonb DEFAULT '{}'::jsonb,
      error_url    text,
      started_at   timestamptz,
      finished_at  timestamptz,
      attempt      integer NOT NULL DEFAULT 1,
      params       jsonb DEFAULT '{}'::jsonb,
      created_at   timestamptz NOT NULL DEFAULT now()
    );
  END IF;
END $$;

-- If the table already exists but mode is an enum, alter it to text
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ingestion_jobs'
      AND column_name = 'mode' AND udt_name = 'job_mode'
  ) THEN
    ALTER TABLE public.ingestion_jobs
      ALTER COLUMN mode TYPE text USING mode::text;
  END IF;
  -- Same for status
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ingestion_jobs'
      AND column_name = 'status' AND udt_name = 'job_status'
  ) THEN
    ALTER TABLE public.ingestion_jobs
      ALTER COLUMN status TYPE text USING status::text;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────
-- Bronze Landing Tables
-- ────────────────────────────────────────────────────────────────

-- raw_products: all product data lands here first
CREATE TABLE IF NOT EXISTS bronze.raw_products (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  vendor_id           uuid NOT NULL,
  source_name         text NOT NULL,
  source_record_id    text,
  ingestion_run_id    uuid NOT NULL,
  raw_payload         jsonb NOT NULL,
  payload_language    varchar(10),
  file_name           text,
  row_number          integer,
  data_hash           text NOT NULL,
  -- Product-specific columns
  image_url_original  text,
  asset_storage_uri   text,
  nutrition_payload   jsonb,
  -- Timestamps
  landed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_products_data_hash
  ON bronze.raw_products (data_hash);
CREATE INDEX IF NOT EXISTS idx_raw_products_vendor_run
  ON bronze.raw_products (vendor_id, ingestion_run_id);

-- raw_customers: all customer data lands here first
CREATE TABLE IF NOT EXISTS bronze.raw_customers (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  vendor_id           uuid NOT NULL,
  source_name         text NOT NULL,
  source_record_id    text,
  ingestion_run_id    uuid NOT NULL,
  raw_payload         jsonb NOT NULL,
  payload_language    varchar(10),
  file_name           text,
  row_number          integer,
  data_hash           text NOT NULL,
  -- Customer-specific columns
  email               text,
  full_name           text,
  customer_type       varchar(10) DEFAULT 'b2b',
  -- Timestamps
  landed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_customers_data_hash
  ON bronze.raw_customers (data_hash);
CREATE INDEX IF NOT EXISTS idx_raw_customers_vendor_run
  ON bronze.raw_customers (vendor_id, ingestion_run_id);

-- raw_customer_health_profiles: health profile data
CREATE TABLE IF NOT EXISTS bronze.raw_customer_health_profiles (
  id                        uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  vendor_id                 uuid NOT NULL,
  source_name               text NOT NULL,
  source_record_id          text,
  ingestion_run_id          uuid NOT NULL,
  raw_payload               jsonb NOT NULL,
  payload_language          varchar(10),
  file_name                 text,
  row_number                integer,
  data_hash                 text NOT NULL,
  -- Health-specific columns
  customer_type             varchar(10) DEFAULT 'b2b',
  customer_source_record_id text,
  -- Timestamps
  landed_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_health_data_hash
  ON bronze.raw_customer_health_profiles (data_hash);
CREATE INDEX IF NOT EXISTS idx_raw_health_vendor_run
  ON bronze.raw_customer_health_profiles (vendor_id, ingestion_run_id);

-- raw_ingredients: ingredient data
CREATE TABLE IF NOT EXISTS bronze.raw_ingredients (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  vendor_id           uuid NOT NULL,
  source_name         text NOT NULL,
  source_record_id    text,
  ingestion_run_id    uuid NOT NULL,
  raw_payload         jsonb NOT NULL,
  payload_language    varchar(10),
  file_name           text,
  row_number          integer,
  data_hash           text NOT NULL,
  landed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_ingredients_data_hash
  ON bronze.raw_ingredients (data_hash);

-- raw_recipes: recipe data
CREATE TABLE IF NOT EXISTS bronze.raw_recipes (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  vendor_id           uuid NOT NULL,
  source_name         text NOT NULL,
  source_record_id    text,
  ingestion_run_id    uuid NOT NULL,
  raw_payload         jsonb NOT NULL,
  payload_language    varchar(10),
  file_name           text,
  row_number          integer,
  data_hash           text NOT NULL,
  landed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_recipes_data_hash
  ON bronze.raw_recipes (data_hash);

-- ────────────────────────────────────────────────────────────────
-- Comments
-- ────────────────────────────────────────────────────────────────
COMMENT ON SCHEMA bronze IS 'Raw landing zone for all ingested data (pre-validation).';
COMMENT ON TABLE bronze.raw_products IS 'Product data as received from vendors, before any transformation.';
COMMENT ON TABLE bronze.raw_customers IS 'Customer data as received from vendors, before any transformation.';
COMMENT ON TABLE bronze.raw_customer_health_profiles IS 'Customer health profile data as received, before transformation.';
