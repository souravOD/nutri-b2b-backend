-- Migration 033: FCM push notification device tokens
-- Stores per-customer browser/mobile FCM tokens so the backend can push alerts.
-- Tokens are cleaned up on logout and auto-pruned when Firebase reports stale tokens.
-- Note: references gold.b2b_vendors (not gold.vendors) — matches the rest of the schema.

CREATE TABLE IF NOT EXISTS gold.b2b_push_tokens (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID        NOT NULL REFERENCES gold.b2b_customers(id) ON DELETE CASCADE,
  vendor_id    UUID        NOT NULL REFERENCES gold.vendors(id)        ON DELETE CASCADE,
  device_token TEXT        NOT NULL,
  platform     TEXT        NOT NULL DEFAULT 'web'
               CHECK (platform IN ('web', 'ios', 'android')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT b2b_push_tokens_device_token_unique UNIQUE (device_token)
);

CREATE INDEX IF NOT EXISTS idx_b2b_push_tokens_vendor
  ON gold.b2b_push_tokens (vendor_id);

CREATE INDEX IF NOT EXISTS idx_b2b_push_tokens_customer
  ON gold.b2b_push_tokens (customer_id);

CREATE INDEX IF NOT EXISTS idx_b2b_push_tokens_vendor_platform
  ON gold.b2b_push_tokens (vendor_id, platform);
