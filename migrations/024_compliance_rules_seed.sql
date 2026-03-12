-- Migration 024: Seed default compliance rules
--
-- Inserts global (vendor_id = NULL) compliance rules so the Compliance
-- feature works out-of-the-box. Uses ON CONFLICT for idempotent re-runs.
--
-- Check types must match evaluateRule() in compliance.ts:
--   nutrition_completeness, allergen_declaration, ingredient_listing,
--   barcode_presence, certification_check

-- Partial unique index for global rules — allows idempotent seed inserts
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_compliance_rules_global_seed
    ON gold.b2b_compliance_rules (title, check_type)
    WHERE vendor_id IS NULL;

-- Seed global default rules (vendor_id = NULL applies to all vendors)
INSERT INTO gold.b2b_compliance_rules (vendor_id, title, description, regulation, check_type, severity, is_active)
VALUES
    (NULL, 'Nutrition Completeness', 'Products must have nutrition data populated for regulatory compliance.', 'fda', 'nutrition_completeness', 'warning', true),
    (NULL, 'Allergen Declaration', 'Products must declare allergen information.', 'fda', 'allergen_declaration', 'warning', true),
    (NULL, 'Ingredient Listing', 'Products must include ingredient lists.', 'fda', 'ingredient_listing', 'warning', true),
    (NULL, 'Barcode Presence', 'Products should have barcodes for traceability.', 'custom', 'barcode_presence', 'info', true),
    (NULL, 'Certification Check', 'Products should include certification data where applicable.', 'custom', 'certification_check', 'info', true)
ON CONFLICT (title, check_type) WHERE vendor_id IS NULL DO NOTHING;
