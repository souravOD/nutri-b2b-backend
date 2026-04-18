-- Migration 036: Member Segmentation Builder
-- Creates the b2b_member_segments table for saving rule-based member segments.
-- Rules are stored as JSONB: [{ field, op, value }]
-- Logic is either 'AND' or 'OR' (how rules are combined).

CREATE TABLE IF NOT EXISTS gold.b2b_member_segments (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  vendor_id    uuid NOT NULL REFERENCES gold.vendors(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  logic        text NOT NULL DEFAULT 'AND' CHECK (logic IN ('AND', 'OR')),
  rules        jsonb NOT NULL DEFAULT '[]'::jsonb,
  member_count integer,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_b2b_member_segments_vendor
  ON gold.b2b_member_segments(vendor_id);
