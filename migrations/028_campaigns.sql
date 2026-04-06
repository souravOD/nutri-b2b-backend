-- Migration 028: Create campaigns table
CREATE TABLE IF NOT EXISTS gold.b2b_campaigns (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id        UUID        NOT NULL REFERENCES gold.vendors(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  target_segment   TEXT        NOT NULL DEFAULT 'all',
  subject          TEXT        NOT NULL,
  message          TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'sent')),
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_vendor ON gold.b2b_campaigns(vendor_id, created_at DESC);
