-- 015_add_invited_status.sql
-- Adds 'invited' to BOTH b2b_users and b2b_user_links status check constraints
-- so invited users can be tracked before they accept.

-- Fix b2b_users status constraint
ALTER TABLE gold.b2b_users
  DROP CONSTRAINT IF EXISTS b2b_users_status_check;

ALTER TABLE gold.b2b_users
  ADD CONSTRAINT b2b_users_status_check
  CHECK (status IN ('active', 'inactive', 'suspended', 'invited'));

-- Fix b2b_user_links status constraint
ALTER TABLE gold.b2b_user_links
  DROP CONSTRAINT IF EXISTS b2b_user_links_status_check;

ALTER TABLE gold.b2b_user_links
  ADD CONSTRAINT b2b_user_links_status_check
  CHECK (status IN ('active', 'inactive', 'suspended', 'invited'));
