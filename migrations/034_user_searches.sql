-- Migration 034: User search history
-- Stores per-user search queries to power the "Recent searches" feature
-- in the search suggestions dropdown. Capped at 10 entries per user (enforced
-- in application layer). Queries are de-duplicated on upsert so the same term
-- only appears once per user, with its most recent timestamp.

CREATE TABLE IF NOT EXISTS gold.user_searches (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL,
  vendor_id   UUID,
  query       TEXT        NOT NULL,
  searched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_searches_user
  ON gold.user_searches (user_id);

CREATE INDEX IF NOT EXISTS idx_user_searches_at
  ON gold.user_searches (searched_at);
