-- Migration 014: System settings table for vendor-scoped configuration (dual-write with Appwrite vendor_settings)
--
-- Key-value store per vendor. The frontend reads from Appwrite vendor_settings
-- collection; the backend reads from this table.

CREATE TABLE IF NOT EXISTS gold.system_settings (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_id   uuid NOT NULL REFERENCES gold.vendors(id),
    key         text NOT NULL,
    value       jsonb NOT NULL DEFAULT '{}',
    updated_by  uuid REFERENCES gold.b2b_users(id),
    updated_at  timestamptz DEFAULT now(),
    UNIQUE(vendor_id, key)
);

CREATE INDEX IF NOT EXISTS idx_settings_vendor ON gold.system_settings(vendor_id);
