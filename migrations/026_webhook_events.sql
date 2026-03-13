-- Migration 026: Add events column to webhook_endpoints
-- Stores the list of event types the endpoint subscribes to.

ALTER TABLE public.webhook_endpoints
  ADD COLUMN IF NOT EXISTS events text[] NOT NULL DEFAULT ARRAY['product.match.found', 'import.completed']::text[];
