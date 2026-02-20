-- 006_backfill_public_to_gold.sql
-- One-time backfill from legacy public schema into new gold b2b auth/mapping tables.
-- Safe to re-run; no-op if legacy tables are absent.

-- -----------------------------------------------------------------------------
-- 1) public.users -> gold.b2b_users
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE NOTICE 'Skipping users backfill: public.users does not exist.';
    RETURN;
  END IF;

  WITH ranked AS (
    SELECT
      u.*,
      NULLIF(lower(trim(u.appwrite_user_id)), '') AS appwrite_user_id_clean,
      row_number() OVER (
        PARTITION BY lower(u.email)
        ORDER BY COALESCE(u.updated_at, u.created_at) DESC, u.id DESC
      ) AS email_rn,
      row_number() OVER (
        PARTITION BY NULLIF(lower(trim(u.appwrite_user_id)), '')
        ORDER BY COALESCE(u.updated_at, u.created_at) DESC, u.id DESC
      ) AS appwrite_rn
    FROM public.users u
    WHERE u.email IS NOT NULL
  ),
  src AS (
    SELECT
      r.id,
      r.email,
      COALESCE(NULLIF(r.display_name, ''), NULLIF(r."displayName", ''), split_part(r.email, '@', 1)) AS display_name,
      CASE WHEN r.appwrite_user_id_clean IS NULL THEN NULL
           WHEN r.appwrite_rn = 1 THEN r.appwrite_user_id_clean
           ELSE NULL END AS appwrite_user_id,
      COALESCE(NULLIF(r.source, ''), 'appwrite') AS source,
      r.vendor_id,
      'active'::text AS status,
      COALESCE(r.created_at, now()) AS created_at,
      COALESCE(r.updated_at, now()) AS updated_at
    FROM ranked r
    WHERE r.email_rn = 1
  )
  UPDATE gold.b2b_users g
     SET display_name = s.display_name,
         appwrite_user_id = COALESCE(g.appwrite_user_id, s.appwrite_user_id),
         source = COALESCE(g.source, s.source),
         vendor_id = COALESCE(g.vendor_id, s.vendor_id),
         updated_at = now()
    FROM src s
   WHERE lower(g.email) = lower(s.email);

  WITH ranked AS (
    SELECT
      u.*,
      NULLIF(lower(trim(u.appwrite_user_id)), '') AS appwrite_user_id_clean,
      row_number() OVER (
        PARTITION BY lower(u.email)
        ORDER BY COALESCE(u.updated_at, u.created_at) DESC, u.id DESC
      ) AS email_rn,
      row_number() OVER (
        PARTITION BY NULLIF(lower(trim(u.appwrite_user_id)), '')
        ORDER BY COALESCE(u.updated_at, u.created_at) DESC, u.id DESC
      ) AS appwrite_rn
    FROM public.users u
    WHERE u.email IS NOT NULL
  )
  INSERT INTO gold.b2b_users (
    id,
    email,
    display_name,
    appwrite_user_id,
    source,
    vendor_id,
    status,
    created_at,
    updated_at
  )
  SELECT
    r.id,
    r.email,
    COALESCE(NULLIF(r.display_name, ''), NULLIF(r."displayName", ''), split_part(r.email, '@', 1)) AS display_name,
    CASE WHEN r.appwrite_user_id_clean IS NULL THEN NULL
         WHEN r.appwrite_rn = 1 THEN r.appwrite_user_id_clean
         ELSE NULL END AS appwrite_user_id,
    COALESCE(NULLIF(r.source, ''), 'appwrite') AS source,
    r.vendor_id,
    'active'::text AS status,
    COALESCE(r.created_at, now()) AS created_at,
    COALESCE(r.updated_at, now()) AS updated_at
  FROM ranked r
  WHERE r.email_rn = 1
    AND NOT EXISTS (
      SELECT 1
      FROM gold.b2b_users g
      WHERE lower(g.email) = lower(r.email)
    );
END $$;

-- -----------------------------------------------------------------------------
-- 2) public.user_links -> gold.b2b_user_links (single vendor per user)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.user_links') IS NULL THEN
    RAISE NOTICE 'Skipping user_links backfill: public.user_links does not exist.';
    RETURN;
  END IF;

  WITH ranked AS (
    SELECT
      l.*,
      row_number() OVER (
        PARTITION BY l.user_id
        ORDER BY COALESCE(l.updated_at, l.created_at) DESC, l.id DESC
      ) AS rn
    FROM public.user_links l
    WHERE l.user_id IS NOT NULL
      AND l.vendor_id IS NOT NULL
  ),
  src AS (
    SELECT
      r.user_id,
      r.vendor_id,
      CASE lower(COALESCE(r.role::text, 'viewer'))
        WHEN 'viewer' THEN 'vendor_viewer'
        WHEN 'operator' THEN 'vendor_operator'
        WHEN 'admin' THEN 'vendor_admin'
        WHEN 'vendor_viewer' THEN 'vendor_viewer'
        WHEN 'vendor_operator' THEN 'vendor_operator'
        WHEN 'vendor_admin' THEN 'vendor_admin'
        WHEN 'superadmin' THEN 'superadmin'
        ELSE 'vendor_viewer'
      END AS role,
      CASE lower(COALESCE(r.status, 'active'))
        WHEN 'active' THEN 'active'
        WHEN 'inactive' THEN 'inactive'
        WHEN 'suspended' THEN 'suspended'
        ELSE 'active'
      END AS status,
      COALESCE(r.created_at, now()) AS created_at,
      COALESCE(r.updated_at, now()) AS updated_at
    FROM ranked r
    JOIN gold.b2b_users u ON u.id = r.user_id
    JOIN gold.vendors v ON v.id = r.vendor_id
    WHERE r.rn = 1
  )
  INSERT INTO gold.b2b_user_links (
    user_id,
    vendor_id,
    role,
    status,
    created_at,
    updated_at
  )
  SELECT
    s.user_id,
    s.vendor_id,
    s.role,
    s.status,
    s.created_at,
    s.updated_at
  FROM src s
  ON CONFLICT (user_id)
  DO UPDATE
     SET vendor_id = EXCLUDED.vendor_id,
         role = EXCLUDED.role,
         status = EXCLUDED.status,
         updated_at = now();
END $$;

-- -----------------------------------------------------------------------------
-- 3) public.vendor_mappings -> gold.b2b_vendor_mappings
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.vendor_mappings') IS NULL THEN
    RAISE NOTICE 'Skipping vendor_mappings backfill: public.vendor_mappings does not exist.';
    RETURN;
  END IF;

  INSERT INTO gold.b2b_vendor_mappings (
    id,
    vendor_id,
    mode,
    map,
    version,
    created_at,
    updated_at
  )
  SELECT
    vm.id,
    vm.vendor_id,
    CASE lower(COALESCE(vm.mode::text, 'products'))
      WHEN 'products' THEN 'products'
      WHEN 'customers' THEN 'customers'
      WHEN 'api_sync' THEN 'api_sync'
      ELSE 'products'
    END AS mode,
    vm.map,
    COALESCE(vm.version, 1) AS version,
    COALESCE(vm.created_at, now()) AS created_at,
    COALESCE(vm.updated_at, now()) AS updated_at
  FROM public.vendor_mappings vm
  JOIN gold.vendors v ON v.id = vm.vendor_id
  ON CONFLICT (id)
  DO UPDATE
     SET vendor_id = EXCLUDED.vendor_id,
         mode = EXCLUDED.mode,
         map = EXCLUDED.map,
         version = EXCLUDED.version,
         updated_at = now();
END $$;
