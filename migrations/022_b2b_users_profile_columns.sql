-- 022_b2b_users_profile_columns.sql
-- Adds phone, country, timezone to gold.b2b_users for Profile page.
-- Aligns with 03_gold.sql + B2B profile route expectations.
-- Safe to re-run; ADD COLUMN IF NOT EXISTS is idempotent.

ALTER TABLE gold.b2b_users
  ADD COLUMN IF NOT EXISTS phone character varying(50),
  ADD COLUMN IF NOT EXISTS country character varying(5),
  ADD COLUMN IF NOT EXISTS timezone character varying(50);
