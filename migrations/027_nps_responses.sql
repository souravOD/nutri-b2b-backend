-- Migration 027: Create NPS responses table
CREATE TABLE IF NOT EXISTS gold.b2b_nps_responses (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    UUID        NOT NULL REFERENCES gold.vendors(id) ON DELETE CASCADE,
  score        INTEGER     NOT NULL CHECK (score BETWEEN 1 AND 10),
  comment      TEXT,
  respondent_key TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nps_vendor_created ON gold.b2b_nps_responses(vendor_id, created_at DESC);
