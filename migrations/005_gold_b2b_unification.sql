-- 005_gold_b2b_unification.sql
-- Unifies B2B auth + compatibility-layer columns inside gold schema.

CREATE SCHEMA IF NOT EXISTS gold;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------------------------------
-- 1) B2B auth/mapping tables in gold
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gold.b2b_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  appwrite_user_id text,
  source text NOT NULL DEFAULT 'appwrite',
  vendor_id uuid,
  status character varying(20) NOT NULL DEFAULT 'active',
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'b2b_users_vendor_id_fkey'
      AND conrelid = 'gold.b2b_users'::regclass
  ) THEN
    ALTER TABLE gold.b2b_users
      ADD CONSTRAINT b2b_users_vendor_id_fkey
      FOREIGN KEY (vendor_id)
      REFERENCES gold.vendors(id)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS gold.b2b_user_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'b2b_user_links_user_id_fkey'
      AND conrelid = 'gold.b2b_user_links'::regclass
  ) THEN
    ALTER TABLE gold.b2b_user_links
      ADD CONSTRAINT b2b_user_links_user_id_fkey
      FOREIGN KEY (user_id)
      REFERENCES gold.b2b_users(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'b2b_user_links_vendor_id_fkey'
      AND conrelid = 'gold.b2b_user_links'::regclass
  ) THEN
    ALTER TABLE gold.b2b_user_links
      ADD CONSTRAINT b2b_user_links_vendor_id_fkey
      FOREIGN KEY (vendor_id)
      REFERENCES gold.vendors(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'b2b_user_links_role_check'
      AND conrelid = 'gold.b2b_user_links'::regclass
  ) THEN
    ALTER TABLE gold.b2b_user_links
      ADD CONSTRAINT b2b_user_links_role_check
      CHECK (role IN ('superadmin', 'vendor_admin', 'vendor_operator', 'vendor_viewer'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'b2b_user_links_status_check'
      AND conrelid = 'gold.b2b_user_links'::regclass
  ) THEN
    ALTER TABLE gold.b2b_user_links
      ADD CONSTRAINT b2b_user_links_status_check
      CHECK (status IN ('active', 'inactive', 'suspended'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS gold.b2b_vendor_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL,
  mode text NOT NULL,
  map jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'b2b_vendor_mappings_vendor_id_fkey'
      AND conrelid = 'gold.b2b_vendor_mappings'::regclass
  ) THEN
    ALTER TABLE gold.b2b_vendor_mappings
      ADD CONSTRAINT b2b_vendor_mappings_vendor_id_fkey
      FOREIGN KEY (vendor_id)
      REFERENCES gold.vendors(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'b2b_vendor_mappings_mode_check'
      AND conrelid = 'gold.b2b_vendor_mappings'::regclass
  ) THEN
    ALTER TABLE gold.b2b_vendor_mappings
      ADD CONSTRAINT b2b_vendor_mappings_mode_check
      CHECK (mode IN ('products', 'customers', 'api_sync'));
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2) Compatibility-layer columns on existing gold core tables
-- -----------------------------------------------------------------------------
ALTER TABLE gold.vendors
  ADD COLUMN IF NOT EXISTS settings_json jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS team_id text,
  ADD COLUMN IF NOT EXISTS domains text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS owner_user_id text,
  ADD COLUMN IF NOT EXISTS billing_email text;

ALTER TABLE gold.products
  ADD COLUMN IF NOT EXISTS nutrition jsonb,
  ADD COLUMN IF NOT EXISTS dietary_tags text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS allergens text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS certifications text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS regulatory_codes text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS ingredients text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS search_tsv tsvector,
  ADD COLUMN IF NOT EXISTS soft_deleted_at timestamp without time zone;

ALTER TABLE gold.b2b_customers
  ADD COLUMN IF NOT EXISTS location jsonb,
  ADD COLUMN IF NOT EXISTS custom_tags text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS product_notes jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS search_tsv tsvector,
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS updated_by uuid;

ALTER TABLE gold.b2b_customer_health_profiles
  ADD COLUMN IF NOT EXISTS age integer,
  ADD COLUMN IF NOT EXISTS gender character varying(30),
  ADD COLUMN IF NOT EXISTS conditions text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS diet_goals text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS macro_targets jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS avoid_allergens text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS tdee_cached numeric(8,2),
  ADD COLUMN IF NOT EXISTS derived_limits jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'b2b_customer_health_profiles_b2b_customer_id_key'
      AND conrelid = 'gold.b2b_customer_health_profiles'::regclass
  ) THEN
    ALTER TABLE gold.b2b_customer_health_profiles
      ADD CONSTRAINT b2b_customer_health_profiles_b2b_customer_id_key UNIQUE (b2b_customer_id);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3) Updated-at + search triggers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gold.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION gold.set_products_search_tsv()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_tsv := to_tsvector(
    'english',
    concat_ws(
      ' ',
      COALESCE(NEW.name, ''),
      COALESCE(NEW.brand, ''),
      COALESCE(NEW.description, ''),
      COALESCE(array_to_string(NEW.dietary_tags, ' '), ''),
      COALESCE(array_to_string(NEW.allergens, ' '), '')
    )
  );
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION gold.set_b2b_customers_search_tsv()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_tsv := to_tsvector(
    'english',
    concat_ws(
      ' ',
      COALESCE(NEW.full_name, ''),
      COALESCE(NEW.email, ''),
      COALESCE(array_to_string(NEW.custom_tags, ' '), '')
    )
  );
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vendors_set_updated_at ON gold.vendors;
CREATE TRIGGER trg_vendors_set_updated_at
BEFORE UPDATE ON gold.vendors
FOR EACH ROW
EXECUTE FUNCTION gold.set_updated_at();

DROP TRIGGER IF EXISTS trg_products_set_search_tsv ON gold.products;
CREATE TRIGGER trg_products_set_search_tsv
BEFORE INSERT OR UPDATE ON gold.products
FOR EACH ROW
EXECUTE FUNCTION gold.set_products_search_tsv();

DROP TRIGGER IF EXISTS trg_b2b_customers_set_search_tsv ON gold.b2b_customers;
CREATE TRIGGER trg_b2b_customers_set_search_tsv
BEFORE INSERT OR UPDATE ON gold.b2b_customers
FOR EACH ROW
EXECUTE FUNCTION gold.set_b2b_customers_search_tsv();

DROP TRIGGER IF EXISTS trg_b2b_customer_health_profiles_set_updated_at ON gold.b2b_customer_health_profiles;
CREATE TRIGGER trg_b2b_customer_health_profiles_set_updated_at
BEFORE UPDATE ON gold.b2b_customer_health_profiles
FOR EACH ROW
EXECUTE FUNCTION gold.set_updated_at();

DROP TRIGGER IF EXISTS trg_b2b_users_set_updated_at ON gold.b2b_users;
CREATE TRIGGER trg_b2b_users_set_updated_at
BEFORE UPDATE ON gold.b2b_users
FOR EACH ROW
EXECUTE FUNCTION gold.set_updated_at();

DROP TRIGGER IF EXISTS trg_b2b_user_links_set_updated_at ON gold.b2b_user_links;
CREATE TRIGGER trg_b2b_user_links_set_updated_at
BEFORE UPDATE ON gold.b2b_user_links
FOR EACH ROW
EXECUTE FUNCTION gold.set_updated_at();

DROP TRIGGER IF EXISTS trg_b2b_vendor_mappings_set_updated_at ON gold.b2b_vendor_mappings;
CREATE TRIGGER trg_b2b_vendor_mappings_set_updated_at
BEFORE UPDATE ON gold.b2b_vendor_mappings
FOR EACH ROW
EXECUTE FUNCTION gold.set_updated_at();

-- -----------------------------------------------------------------------------
-- 4) Constraints + indexes
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_users_email_lower
  ON gold.b2b_users ((lower(email)));

CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_users_appwrite_user_id
  ON gold.b2b_users (appwrite_user_id)
  WHERE appwrite_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_b2b_users_vendor_id
  ON gold.b2b_users (vendor_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_user_links_user_vendor
  ON gold.b2b_user_links (user_id, vendor_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_user_links_user_unique
  ON gold.b2b_user_links (user_id);

CREATE INDEX IF NOT EXISTS idx_b2b_user_links_vendor_id
  ON gold.b2b_user_links (vendor_id);

CREATE INDEX IF NOT EXISTS idx_b2b_vendor_mappings_vendor_mode
  ON gold.b2b_vendor_mappings (vendor_id, mode);

CREATE INDEX IF NOT EXISTS idx_gold_vendors_domains_gin
  ON gold.vendors USING gin (domains);

CREATE INDEX IF NOT EXISTS idx_gold_vendors_settings_json_gin
  ON gold.vendors USING gin (settings_json);

CREATE INDEX IF NOT EXISTS idx_gold_products_search_tsv
  ON gold.products USING gin (search_tsv);

CREATE INDEX IF NOT EXISTS idx_gold_products_dietary_tags_gin
  ON gold.products USING gin (dietary_tags);

CREATE INDEX IF NOT EXISTS idx_gold_products_allergens_gin
  ON gold.products USING gin (allergens);

CREATE INDEX IF NOT EXISTS idx_gold_products_certifications_gin
  ON gold.products USING gin (certifications);

CREATE INDEX IF NOT EXISTS idx_gold_products_nutrition_gin
  ON gold.products USING gin (nutrition);

DO $$
BEGIN
  IF to_regclass('gold.idx_gold_products_vendor_external_uq') IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM gold.products
      WHERE external_id IS NOT NULL
      GROUP BY vendor_id, external_id
      HAVING count(*) > 1
    ) THEN
      RAISE NOTICE 'Skipping unique index idx_gold_products_vendor_external_uq due to duplicate (vendor_id, external_id) values.';
    ELSE
      EXECUTE 'CREATE UNIQUE INDEX idx_gold_products_vendor_external_uq ON gold.products (vendor_id, external_id) WHERE external_id IS NOT NULL';
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gold_b2b_customers_search_tsv
  ON gold.b2b_customers USING gin (search_tsv);

CREATE INDEX IF NOT EXISTS idx_gold_b2b_customers_custom_tags_gin
  ON gold.b2b_customers USING gin (custom_tags);

CREATE INDEX IF NOT EXISTS idx_gold_b2b_customers_product_notes_gin
  ON gold.b2b_customers USING gin (product_notes);

CREATE INDEX IF NOT EXISTS idx_gold_b2b_customer_health_profiles_conditions_gin
  ON gold.b2b_customer_health_profiles USING gin (conditions);

CREATE INDEX IF NOT EXISTS idx_gold_b2b_customer_health_profiles_diet_goals_gin
  ON gold.b2b_customer_health_profiles USING gin (diet_goals);

CREATE INDEX IF NOT EXISTS idx_gold_b2b_customer_health_profiles_avoid_allergens_gin
  ON gold.b2b_customer_health_profiles USING gin (avoid_allergens);