-- 008_b2b_vendor_contract_hardening.sql
-- Hardens vendor/user contracts for unified B2B onboarding.

CREATE SCHEMA IF NOT EXISTS gold;

-- -----------------------------------------------------------------------------
-- 1) Vendor identity normalization (slug + team_id)
-- -----------------------------------------------------------------------------
UPDATE gold.vendors
SET slug = NULLIF(lower(trim(slug)), '')
WHERE slug IS DISTINCT FROM NULLIF(lower(trim(slug)), '');

CREATE UNIQUE INDEX IF NOT EXISTS idx_gold_vendors_slug_lower_uq
  ON gold.vendors ((lower(slug)))
  WHERE slug IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gold_vendors_team_id_uq
  ON gold.vendors (team_id)
  WHERE team_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2) Normalize domains and enforce active-vendor domain quality
-- -----------------------------------------------------------------------------
WITH normalized AS (
  SELECT
    v.id,
    COALESCE(
      array_agg(DISTINCT d.domain ORDER BY d.domain)
      FILTER (WHERE d.domain IS NOT NULL),
      '{}'::text[]
    ) AS cleaned_domains
  FROM gold.vendors v
  LEFT JOIN LATERAL (
    SELECT NULLIF(lower(trim(x)), '') AS domain
    FROM unnest(COALESCE(v.domains, '{}'::text[])) AS x
  ) d ON TRUE
  GROUP BY v.id
)
UPDATE gold.vendors v
SET domains = n.cleaned_domains
FROM normalized n
WHERE v.id = n.id
  AND COALESCE(v.domains, '{}'::text[]) IS DISTINCT FROM n.cleaned_domains;

-- Best effort fill from billing_email domain when domains are empty.
UPDATE gold.vendors
SET domains = ARRAY[lower(split_part(billing_email, '@', 2))]
WHERE status = 'active'
  AND coalesce(cardinality(domains), 0) = 0
  AND billing_email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$';

-- Remaining active vendors without domains become inactive to satisfy the contract.
UPDATE gold.vendors
SET status = 'inactive'
WHERE status = 'active'
  AND coalesce(cardinality(domains), 0) = 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vendors_active_requires_domains_check'
      AND conrelid = 'gold.vendors'::regclass
  ) THEN
    ALTER TABLE gold.vendors
      ADD CONSTRAINT vendors_active_requires_domains_check
      CHECK (status <> 'active' OR coalesce(cardinality(domains), 0) > 0);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3) Status check hardening
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vendors_status_check'
      AND conrelid = 'gold.vendors'::regclass
  ) THEN
    ALTER TABLE gold.vendors
      ADD CONSTRAINT vendors_status_check
      CHECK (status IN ('active', 'inactive', 'suspended'));
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4) Appwrite-backed user identity guardrails
-- -----------------------------------------------------------------------------
UPDATE gold.b2b_users
SET source = 'legacy'
WHERE source = 'appwrite'
  AND appwrite_user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_users_appwrite_user_id
  ON gold.b2b_users (appwrite_user_id)
  WHERE appwrite_user_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'b2b_users_appwrite_source_requires_id'
      AND conrelid = 'gold.b2b_users'::regclass
  ) THEN
    ALTER TABLE gold.b2b_users
      ADD CONSTRAINT b2b_users_appwrite_source_requires_id
      CHECK (source <> 'appwrite' OR appwrite_user_id IS NOT NULL);
  END IF;
END $$;