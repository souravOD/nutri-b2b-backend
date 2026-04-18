-- Migration 035: Expand role CHECK constraints to include wellness_manager and marketing_manager
--
-- The original migration 016 only allowed 4 roles in the CHECK constraint.
-- wellness_manager and marketing_manager were added to the application layer later
-- but the DB constraint was never updated, causing INSERT/UPDATE failures for those roles.

-- ── gold.b2b_role_permissions ──────────────────────────────────────────────────
ALTER TABLE gold.b2b_role_permissions
  DROP CONSTRAINT IF EXISTS b2b_role_permissions_role_check;

ALTER TABLE gold.b2b_role_permissions
  ADD CONSTRAINT b2b_role_permissions_role_check
  CHECK (role IN (
    'superadmin', 'vendor_admin', 'vendor_operator', 'vendor_viewer',
    'wellness_manager', 'marketing_manager'
  ));

-- ── gold.b2b_user_links ────────────────────────────────────────────────────────
ALTER TABLE gold.b2b_user_links
  DROP CONSTRAINT IF EXISTS b2b_user_links_role_check;

ALTER TABLE gold.b2b_user_links
  ADD CONSTRAINT b2b_user_links_role_check
  CHECK (role IN (
    'superadmin', 'vendor_admin', 'vendor_operator', 'vendor_viewer',
    'wellness_manager', 'marketing_manager'
  ));

-- ── gold.invitations ──────────────────────────────────────────────────────────
-- migration 013 inline CHECK only had 3 roles; update it to match
ALTER TABLE gold.invitations
  DROP CONSTRAINT IF EXISTS b2b_invitations_role_check;

ALTER TABLE gold.invitations
  DROP CONSTRAINT IF EXISTS invitations_role_check;

ALTER TABLE gold.invitations
  ADD CONSTRAINT invitations_role_check
  CHECK (role IN (
    'vendor_admin', 'vendor_operator', 'vendor_viewer',
    'wellness_manager', 'marketing_manager'
  ));

-- Seed global defaults for the two new roles (mirrors auth.ts computePermissions)
INSERT INTO gold.b2b_role_permissions (vendor_id, role, permission) VALUES
  (NULL, 'wellness_manager',  'read:customers'),
  (NULL, 'wellness_manager',  'read:products'),
  (NULL, 'wellness_manager',  'read:matches'),
  (NULL, 'wellness_manager',  'read:audit'),
  (NULL, 'marketing_manager', 'read:customers'),
  (NULL, 'marketing_manager', 'read:products'),
  (NULL, 'marketing_manager', 'read:vendors'),
  (NULL, 'marketing_manager', 'write:vendors'),
  (NULL, 'marketing_manager', 'read:audit')
ON CONFLICT DO NOTHING;
