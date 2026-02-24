-- Migration 013: Invitations table for user invite flow (dual-write with Appwrite)
--
-- Stores pending/accepted/expired/revoked invitations.
-- The complete-registration route checks this before defaulting to viewer.

CREATE TABLE IF NOT EXISTS gold.invitations (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_id       uuid NOT NULL REFERENCES gold.vendors(id),
    email           text NOT NULL,
    role            text NOT NULL DEFAULT 'vendor_viewer'
                    CHECK (role IN ('vendor_admin','vendor_operator','vendor_viewer')),
    invited_by      uuid REFERENCES gold.b2b_users(id),
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted','expired','revoked')),
    message         text,
    appwrite_doc_id text,           -- Appwrite $id for dual-write reconciliation
    token           text UNIQUE,    -- Unique invite token for email link
    expires_at      timestamptz NOT NULL DEFAULT now() + interval '7 days',
    accepted_at     timestamptz,
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_vendor ON gold.invitations(vendor_id);
CREATE INDEX IF NOT EXISTS idx_inv_email  ON gold.invitations(lower(email));
CREATE INDEX IF NOT EXISTS idx_inv_status ON gold.invitations(status);
CREATE INDEX IF NOT EXISTS idx_inv_token  ON gold.invitations(token) WHERE token IS NOT NULL;
