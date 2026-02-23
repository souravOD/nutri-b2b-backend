-- 012_orchestration_vendor_support.sql
-- Adds vendor_id, source_name, progress_pct, totals to orchestration_runs
-- so the B2B backend can query runs by vendor and display progress.

-- Also enables Supabase Realtime publication for live dashboard.

BEGIN;

-- 1. Add new columns to orchestration_runs
ALTER TABLE orchestration.orchestration_runs
  ADD COLUMN IF NOT EXISTS vendor_id     uuid,
  ADD COLUMN IF NOT EXISTS source_name   varchar(100),
  ADD COLUMN IF NOT EXISTS progress_pct  integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS totals        jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS error_message text;

-- 2. Index for B2B queries: list runs by vendor
CREATE INDEX IF NOT EXISTS idx_orch_runs_vendor_id
  ON orchestration.orchestration_runs (vendor_id)
  WHERE vendor_id IS NOT NULL;

-- 3. Composite index for vendor + status queries
CREATE INDEX IF NOT EXISTS idx_orch_runs_vendor_status
  ON orchestration.orchestration_runs (vendor_id, status)
  WHERE vendor_id IS NOT NULL;

-- 4. Index for created_at ordering (used in list queries)
CREATE INDEX IF NOT EXISTS idx_orch_runs_created_at
  ON orchestration.orchestration_runs (created_at DESC);

-- 5. Add pipeline_name to pipeline_runs (denorm for easy B2B reads)
DO $$
BEGIN
  -- pipeline_runs already has pipeline_id FK; add denormalized name for read convenience
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'orchestration'
      AND table_name = 'pipeline_runs'
      AND column_name = 'pipeline_name'
  ) THEN
    ALTER TABLE orchestration.pipeline_runs
      ADD COLUMN pipeline_name varchar(100);
  END IF;
END $$;

-- 6. Enable Supabase Realtime on orchestration tables (for future Phase 2)
-- Supabase uses the `supabase_realtime` publication. Add tables to it.
DO $$
BEGIN
  -- Create publication if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

ALTER PUBLICATION supabase_realtime ADD TABLE orchestration.orchestration_runs;
ALTER PUBLICATION supabase_realtime ADD TABLE orchestration.pipeline_runs;

COMMIT;
