-- Migration 023: gold.b2b_chat_sessions (PRD-01)
-- Chatbot session persistence for B2B users.
-- user_id is TEXT (Appwrite user ID).

CREATE TABLE IF NOT EXISTS gold.b2b_chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES gold.vendors(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  session_data JSONB NOT NULL DEFAULT '{}',
  message_count INT NOT NULL DEFAULT 0,
  last_intent VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 minutes'
);

CREATE INDEX IF NOT EXISTS idx_b2b_chat_sessions_vendor ON gold.b2b_chat_sessions(vendor_id);
CREATE INDEX IF NOT EXISTS idx_b2b_chat_sessions_user ON gold.b2b_chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_b2b_chat_sessions_expires ON gold.b2b_chat_sessions(expires_at)
  WHERE expires_at < NOW();
