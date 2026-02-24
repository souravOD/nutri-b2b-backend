-- Migration 016: B2B feature tables
--
-- Creates:
--   1. gold.b2b_alerts              — vendor-scoped user-facing notifications
--   2. gold.b2b_compliance_rules    — regulatory check definitions
--   3. gold.b2b_compliance_checks   — compliance audit trail per vendor/rule
--   4. gold.b2b_role_permissions    — dynamic role → permission mapping
--   5. gold.b2b_webhooks            — webhook endpoints (post-MVP, table only)
--   6. gold.b2b_ip_allowlist        — IP restrictions (post-MVP, table only)
--
-- All tables use CREATE TABLE IF NOT EXISTS for idempotent re-runs.
-- Seed data uses ON CONFLICT DO NOTHING for safe re-application.

-- =====================================================================
-- 1. gold.b2b_alerts
-- =====================================================================

CREATE TABLE IF NOT EXISTS gold.b2b_alerts (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_id       uuid NOT NULL REFERENCES gold.vendors(id),
    type            varchar(30) NOT NULL
                    CHECK (type IN ('quality','compliance','ingestion','match','system')),
    priority        varchar(10) NOT NULL DEFAULT 'medium'
                    CHECK (priority IN ('high','medium','low')),
    title           varchar(255) NOT NULL,
    description     text,
    status          varchar(15) NOT NULL DEFAULT 'unread'
                    CHECK (status IN ('unread','read','dismissed')),
    source_table    varchar(100),
    source_id       uuid,
    created_at      timestamptz DEFAULT now() NOT NULL,
    read_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_b2b_alerts_vendor
    ON gold.b2b_alerts(vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_b2b_alerts_status
    ON gold.b2b_alerts(vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_b2b_alerts_type
    ON gold.b2b_alerts(type);
CREATE INDEX IF NOT EXISTS idx_b2b_alerts_priority
    ON gold.b2b_alerts(priority) WHERE priority = 'high';

-- =====================================================================
-- 2. gold.b2b_compliance_rules
-- =====================================================================

CREATE TABLE IF NOT EXISTS gold.b2b_compliance_rules (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_id       uuid REFERENCES gold.vendors(id),  -- NULL = global rule
    title           varchar(255) NOT NULL,
    description     text,
    regulation      varchar(50) NOT NULL
                    CHECK (regulation IN ('fda','usda','eu_fic','codex','custom')),
    check_type      varchar(50) NOT NULL,
    severity        varchar(15) NOT NULL DEFAULT 'warning'
                    CHECK (severity IN ('critical','warning','info')),
    check_config    jsonb DEFAULT '{}',
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compliance_rules_vendor
    ON gold.b2b_compliance_rules(vendor_id);
CREATE INDEX IF NOT EXISTS idx_compliance_rules_active
    ON gold.b2b_compliance_rules(is_active) WHERE is_active = true;

-- =====================================================================
-- 3. gold.b2b_compliance_checks
-- =====================================================================

CREATE TABLE IF NOT EXISTS gold.b2b_compliance_checks (
    id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_id           uuid NOT NULL REFERENCES gold.vendors(id),
    rule_id             uuid NOT NULL REFERENCES gold.b2b_compliance_rules(id),
    status              varchar(20) NOT NULL
                        CHECK (status IN ('compliant','warning','non_compliant')),
    score               integer CHECK (score >= 0 AND score <= 100),
    products_checked    integer DEFAULT 0,
    products_failed     integer DEFAULT 0,
    details             jsonb DEFAULT '{}',
    checked_by          uuid REFERENCES gold.b2b_users(id),
    checked_at          timestamptz DEFAULT now() NOT NULL,
    next_review         date
);

CREATE INDEX IF NOT EXISTS idx_compliance_checks_vendor
    ON gold.b2b_compliance_checks(vendor_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_checks_rule
    ON gold.b2b_compliance_checks(rule_id);
CREATE INDEX IF NOT EXISTS idx_compliance_checks_status
    ON gold.b2b_compliance_checks(status);

-- =====================================================================
-- 4. gold.b2b_role_permissions
-- =====================================================================

CREATE TABLE IF NOT EXISTS gold.b2b_role_permissions (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_id       uuid REFERENCES gold.vendors(id),   -- NULL = global default
    role            text NOT NULL
                    CHECK (role IN ('superadmin','vendor_admin','vendor_operator','vendor_viewer')),
    permission      text NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    UNIQUE(vendor_id, role, permission)
);

CREATE INDEX IF NOT EXISTS idx_role_perms_vendor
    ON gold.b2b_role_permissions(vendor_id, role);

-- Seed global defaults (vendor_id = NULL) — reproduces current hardcoded computePermissions()
-- superadmin gets wildcard '*' in code, no rows needed

-- vendor_admin permissions (13 total)
INSERT INTO gold.b2b_role_permissions (vendor_id, role, permission) VALUES
    (NULL, 'vendor_admin', 'read:vendors'),
    (NULL, 'vendor_admin', 'write:vendors'),
    (NULL, 'vendor_admin', 'read:products'),
    (NULL, 'vendor_admin', 'write:products'),
    (NULL, 'vendor_admin', 'read:customers'),
    (NULL, 'vendor_admin', 'write:customers'),
    (NULL, 'vendor_admin', 'read:ingest'),
    (NULL, 'vendor_admin', 'write:ingest'),
    (NULL, 'vendor_admin', 'read:matches'),
    (NULL, 'vendor_admin', 'read:audit'),
    (NULL, 'vendor_admin', 'manage:users'),
    (NULL, 'vendor_admin', 'manage:api_keys'),
    (NULL, 'vendor_admin', 'manage:settings')
ON CONFLICT DO NOTHING;

-- vendor_operator permissions (7 total)
INSERT INTO gold.b2b_role_permissions (vendor_id, role, permission) VALUES
    (NULL, 'vendor_operator', 'read:products'),
    (NULL, 'vendor_operator', 'write:products'),
    (NULL, 'vendor_operator', 'read:customers'),
    (NULL, 'vendor_operator', 'write:customers'),
    (NULL, 'vendor_operator', 'read:ingest'),
    (NULL, 'vendor_operator', 'write:ingest'),
    (NULL, 'vendor_operator', 'read:matches')
ON CONFLICT DO NOTHING;

-- vendor_viewer permissions (3 total)
INSERT INTO gold.b2b_role_permissions (vendor_id, role, permission) VALUES
    (NULL, 'vendor_viewer', 'read:products'),
    (NULL, 'vendor_viewer', 'read:customers'),
    (NULL, 'vendor_viewer', 'read:matches')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- 5. gold.b2b_webhooks (post-MVP — table only, no app logic)
-- =====================================================================

CREATE TABLE IF NOT EXISTS gold.b2b_webhooks (
    id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_id           uuid NOT NULL REFERENCES gold.vendors(id),
    url                 varchar(1000) NOT NULL,
    events              text[] NOT NULL,
    secret              text,
    is_active           boolean DEFAULT true,
    last_triggered_at   timestamptz,
    failure_count       integer DEFAULT 0,
    created_at          timestamptz DEFAULT now() NOT NULL,
    updated_at          timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_b2b_webhooks_vendor
    ON gold.b2b_webhooks(vendor_id);
CREATE INDEX IF NOT EXISTS idx_b2b_webhooks_active
    ON gold.b2b_webhooks(is_active) WHERE is_active = true;

-- =====================================================================
-- 6. gold.b2b_ip_allowlist (post-MVP — table only, no app logic)
-- =====================================================================

CREATE TABLE IF NOT EXISTS gold.b2b_ip_allowlist (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_id       uuid NOT NULL REFERENCES gold.vendors(id),
    cidr            inet NOT NULL,
    label           varchar(100),
    is_active       boolean DEFAULT true,
    created_at      timestamptz DEFAULT now() NOT NULL,
    created_by      uuid REFERENCES gold.b2b_users(id)
);

CREATE INDEX IF NOT EXISTS idx_b2b_ip_allowlist_vendor
    ON gold.b2b_ip_allowlist(vendor_id);
