-- Migration 031: Add A/B test columns to gold.b2b_campaigns
--
-- Background:
--   The New Campaign dialog has an "Enable A/B Test" toggle that reveals Subject B
--   and Message B fields. The UI state exists in the frontend but the data was never
--   persisted — the backend POST handler and DB table had no A/B columns.
--
-- This migration is safe to run multiple times (IF NOT EXISTS guards).

ALTER TABLE gold.b2b_campaigns
  ADD COLUMN IF NOT EXISTS ab_test_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS subject_b       TEXT,
  ADD COLUMN IF NOT EXISTS message_b       TEXT;
