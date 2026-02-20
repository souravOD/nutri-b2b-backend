-- 009_b2b_onboarding_guardrails.sql
-- Adds deterministic vendor resolution helpers and onboarding lookup indexes.

CREATE SCHEMA IF NOT EXISTS gold;

-- -----------------------------------------------------------------------------
-- 1) Deterministic vendor resolver (team_id -> slug -> domain)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gold.resolve_b2b_vendor(
  p_team_id text,
  p_slug text,
  p_domain text
)
RETURNS TABLE (
  id uuid,
  slug text,
  team_id text,
  resolution text
)
LANGUAGE sql
STABLE
AS $$
  WITH by_team AS (
    SELECT v.id, v.slug, v.team_id, 'team_id'::text AS resolution
    FROM gold.vendors v
    WHERE p_team_id IS NOT NULL
      AND v.team_id = p_team_id
    LIMIT 1
  ),
  by_slug AS (
    SELECT v.id, v.slug, v.team_id, 'slug'::text AS resolution
    FROM gold.vendors v
    WHERE p_slug IS NOT NULL
      AND lower(v.slug) = lower(p_slug)
    LIMIT 1
  ),
  by_domain AS (
    SELECT v.id, v.slug, v.team_id, 'domain'::text AS resolution
    FROM gold.vendors v
    WHERE p_domain IS NOT NULL
      AND lower(p_domain) = ANY (COALESCE(v.domains, '{}'::text[]))
    LIMIT 1
  )
  SELECT * FROM by_team
  UNION ALL
  SELECT * FROM by_slug
  WHERE NOT EXISTS (SELECT 1 FROM by_team)
  UNION ALL
  SELECT * FROM by_domain
  WHERE NOT EXISTS (SELECT 1 FROM by_team)
    AND NOT EXISTS (SELECT 1 FROM by_slug)
  LIMIT 1;
$$;

-- -----------------------------------------------------------------------------
-- 2) Support single-vendor-per-user link policy and onboarding lookups
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_user_links_user_unique
  ON gold.b2b_user_links (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_user_links_user_vendor
  ON gold.b2b_user_links (user_id, vendor_id);

CREATE INDEX IF NOT EXISTS idx_b2b_user_links_user_vendor_lookup
  ON gold.b2b_user_links (user_id, vendor_id, status);

CREATE INDEX IF NOT EXISTS idx_gold_vendors_slug_lookup
  ON gold.vendors ((lower(slug)));

CREATE INDEX IF NOT EXISTS idx_gold_vendors_team_id_lookup
  ON gold.vendors (team_id)
  WHERE team_id IS NOT NULL;