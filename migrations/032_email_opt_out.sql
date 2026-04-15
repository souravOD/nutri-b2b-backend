-- Migration 032: Add email_opt_out compliance flag to b2b_customers
-- Required before first live Resend send. Bounces/complaints set this via
-- the POST /api/v1/reports/webhook/resend endpoint.

ALTER TABLE gold.b2b_customers
  ADD COLUMN IF NOT EXISTS email_opt_out BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: only indexes opted-out rows (small set), keeping bulk-send
-- filter queries fast without bloating the main index.
CREATE INDEX IF NOT EXISTS idx_b2b_customers_email_opt_out
  ON gold.b2b_customers (email_opt_out)
  WHERE email_opt_out = true;
