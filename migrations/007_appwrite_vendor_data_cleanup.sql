-- 007_appwrite_vendor_data_cleanup.sql
-- Normalizes vendor records synced from Appwrite into gold.vendors.

-- -----------------------------------------------------------------------------
-- 1) Normalize vendor status -> active | inactive | suspended
-- -----------------------------------------------------------------------------
UPDATE gold.vendors
SET status = CASE
  WHEN status IS NULL THEN 'inactive'
  WHEN lower(trim(status)) IN ('active', 'enabled', 'onboarding', 'pending') THEN 'active'
  WHEN lower(trim(status)) IN ('inactive', 'disabled', 'deactivated', 'blocked') THEN 'inactive'
  WHEN lower(trim(status)) IN ('suspended', 'suspend', 'paused') THEN 'suspended'
  ELSE 'inactive'
END
WHERE status IS NULL
   OR lower(trim(status)) NOT IN ('active', 'inactive', 'suspended');

-- -----------------------------------------------------------------------------
-- 2) Null malformed placeholder values for billing/owner fields
-- -----------------------------------------------------------------------------
UPDATE gold.vendors
SET billing_email = NULL
WHERE billing_email IS NOT NULL
  AND (
    trim(billing_email) = ''
    OR lower(trim(billing_email)) IN ('na', 'n/a', 'none', 'null', 'undefined', 'unknown', '-')
    OR billing_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
  );

UPDATE gold.vendors
SET owner_user_id = NULL
WHERE owner_user_id IS NOT NULL
  AND (
    trim(owner_user_id) = ''
    OR lower(trim(owner_user_id)) IN ('na', 'n/a', 'none', 'null', 'undefined', 'unknown', '-')
  );

-- -----------------------------------------------------------------------------
-- 3) Lowercase + de-duplicate domains (only update malformed rows)
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
