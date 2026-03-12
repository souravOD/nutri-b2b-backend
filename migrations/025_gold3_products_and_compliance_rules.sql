-- Migration 025: Gold 3 products alignment + 7 new compliance rules
--
-- 1. Adds remaining gold 3 columns to gold.products (mpn, plu_code)
-- 2. Seeds 7 new compliance rules for gold 3 product attributes
--
-- Prerequisites: migrations 016, 018, 019, 020, 021, 024 applied

-- =====================================================================
-- 1. Gold 3 products: add mpn, plu_code
-- =====================================================================

ALTER TABLE gold.products
    ADD COLUMN IF NOT EXISTS mpn character varying(100),
    ADD COLUMN IF NOT EXISTS plu_code character varying(5);

-- =====================================================================
-- 2. Seed 7 new compliance rules
-- =====================================================================
-- Ensure partial unique index exists (created in 024; idempotent here)
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_compliance_rules_global_seed
    ON gold.b2b_compliance_rules (title, check_type)
    WHERE vendor_id IS NULL;

INSERT INTO gold.b2b_compliance_rules (vendor_id, title, description, regulation, check_type, severity, is_active)
VALUES
    (NULL, 'Image Presence', 'Products should have an image URL for better UX and traceability.', 'custom', 'image_presence', 'info', true),
    (NULL, 'Serving Size', 'Products must include serving size information.', 'fda', 'serving_size_presence', 'warning', true),
    (NULL, 'Regulatory Codes', 'Products should include regulatory codes where applicable.', 'fda', 'regulatory_codes_presence', 'info', true),
    (NULL, 'Country of Origin', 'Products should declare country of origin for traceability.', 'custom', 'country_of_origin_presence', 'info', true),
    (NULL, 'Manufacturer', 'Products should include manufacturer information.', 'fda', 'manufacturer_presence', 'warning', true),
    (NULL, 'Inline Nutrition', 'Products should have core nutrition data (calories, fat, sodium, carbs, protein).', 'fda', 'inline_nutrition_completeness', 'warning', true),
    (NULL, 'Dietary Tags', 'Products should include dietary tags for filtering.', 'custom', 'dietary_tags_presence', 'info', true)
ON CONFLICT (title, check_type) WHERE vendor_id IS NULL DO NOTHING;
