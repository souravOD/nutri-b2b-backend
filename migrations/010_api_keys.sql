-- 010_api_keys.sql
-- API key storage for M2M vendor authentication (HMAC + simple key modes).

CREATE SCHEMA IF NOT EXISTS gold;

-- API Keys table
CREATE TABLE IF NOT EXISTS gold.api_keys (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_id       uuid NOT NULL REFERENCES gold.vendors(id) ON DELETE CASCADE,
    key_prefix      varchar(20) NOT NULL,          -- 'nutri_live_abc1' (first 16 chars)
    key_hash        text NOT NULL,                 -- SHA-256 hash of the full key
    hmac_secret_ref text,                          -- Vault secret reference ID
    label           varchar(100),                  -- 'Production Integration'
    environment     varchar(10) DEFAULT 'live'
                    CHECK (environment IN ('live', 'test')),
    scopes          text[] DEFAULT ARRAY['ingest:products', 'ingest:customers'],
    rate_limit_rpm  int DEFAULT 100,               -- requests per minute
    is_active       boolean DEFAULT true NOT NULL,
    last_used_at    timestamptz,
    expires_at      timestamptz,                   -- optional TTL
    created_by      uuid,                          -- user who created the key
    created_at      timestamptz DEFAULT now() NOT NULL,
    revoked_at      timestamptz                    -- soft-revoke timestamp
);

-- Fast lookup by prefix (only active keys)
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_prefix_active
  ON gold.api_keys (key_prefix) WHERE is_active AND revoked_at IS NULL;

-- Vendor scoped listing
CREATE INDEX IF NOT EXISTS idx_api_keys_vendor
  ON gold.api_keys (vendor_id);

COMMENT ON TABLE gold.api_keys IS
  'Stores hashed API keys and Vault references for vendor M2M authentication.';
COMMENT ON COLUMN gold.api_keys.key_prefix IS
  'First 16 characters of the key, used for fast lookup without revealing the full key.';
COMMENT ON COLUMN gold.api_keys.hmac_secret_ref IS
  'UUID reference to the HMAC secret stored in Supabase Vault (vault.secrets).';
