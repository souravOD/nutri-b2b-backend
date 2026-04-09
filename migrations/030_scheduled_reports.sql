-- Migration 030: Scheduled Reports
-- Stores report delivery schedules created via the analytics "Schedule Report" dialog.

CREATE TABLE IF NOT EXISTS gold.b2b_scheduled_reports (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  vendor_id    uuid NOT NULL REFERENCES gold.vendors(id) ON DELETE CASCADE,
  frequency    text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  day_of_week  text,          -- e.g. "Monday" (weekly only)
  format       text NOT NULL CHECK (format IN ('csv', 'pdf')),
  recipients   text[] NOT NULL,
  is_active    boolean DEFAULT true NOT NULL,
  created_at   timestamptz DEFAULT now() NOT NULL,
  last_sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_scheduled_reports_vendor
  ON gold.b2b_scheduled_reports (vendor_id);
