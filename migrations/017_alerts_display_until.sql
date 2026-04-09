-- Migration 017: Fix b2b_alerts table schema gaps
--
-- Background:
--   Migration 016 created gold.b2b_alerts but was missing columns that are
--   present in the Drizzle schema (shared/schema.ts) and used in live queries:
--     - display_until: used in POST /api/alerts (INSERT) and GET /api/alerts/banners (WHERE filter)
--     - updated_at:    present in Drizzle schema definition
--
--   Additionally the status CHECK constraint did not include 'active', which is
--   the Drizzle schema's declared default value.
--
-- This migration is safe to run multiple times (IF NOT EXISTS / IF EXISTS guards).

-- 1. Add missing columns
ALTER TABLE gold.b2b_alerts
  ADD COLUMN IF NOT EXISTS display_until  timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();

-- 2. Widen status CHECK constraint to include 'active'
--    Drop the old constraint first (name may vary; both common names are tried)
ALTER TABLE gold.b2b_alerts
  DROP CONSTRAINT IF EXISTS b2b_alerts_status_check;

ALTER TABLE gold.b2b_alerts
  DROP CONSTRAINT IF EXISTS b2b_alerts_status_check1;

ALTER TABLE gold.b2b_alerts
  ADD CONSTRAINT b2b_alerts_status_check
  CHECK (status IN ('unread', 'read', 'dismissed', 'active'));
