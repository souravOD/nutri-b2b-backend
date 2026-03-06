# Gold Schema Comparison: gold 2.sql vs B2B Migrations

Compares `gold 2.sql` (canonical schema) with B2B compatibility layer. Use this to align your database.

---

## gold.products

| Column | gold 2.sql | B2B (migrations 005, 018, 019) |
|--------|:----------:|:------------------------------:|
| id, vendor_id, external_id, name, brand, description | ✓ | ✓ |
| category_id, barcode, gtin_type, price, currency | ✓ | ✓ |
| package_weight, serving_size, status, notes | ✓ | ✓ |
| product_url | ✓ | ✓ |
| **Inline nutrition** (calories, total_fat_g, protein_g, sodium_mg, etc.) | ✓ | — |
| image_url, global_product_id, manufacturer, country_of_origin | ✓ | — |
| package_weight_g, serving_size_g, servings_per_container | ✓ | — |
| vendor_specific_attrs, source_system, mpn, plu_code | ✓ | — |
| **sub_category_id, cuisine_id, market_id** | — | ✓ (018) |
| **nutrition** (jsonb) | — | ✓ (005/019) |
| **dietary_tags, allergens, certifications, regulatory_codes, ingredients** (text[]) | — | ✓ (005/019) |
| **search_tsv, soft_deleted_at** | — | ✓ (005/019) |

**Note:** gold 2.sql uses junction tables (`product_allergens`, `product_ingredients`, `product_certifications`) for allergens/ingredients. B2B uses denormalized arrays on `products` for simpler queries.

---

## gold.vendors

| Column | gold 2.sql | B2B (005) |
|--------|:----------:|:---------:|
| id, name, slug, status, catalog_version | ✓ | ✓ |
| api_endpoint, contact_email | ✓ | ✓ |
| vendor_type, country, industry | ✓ | — |
| **settings_json, team_id, domains, owner_user_id, billing_email** | — | ✓ (005) |

---

## gold.b2b_customers

| Column | gold 2.sql | B2B (005, 017) |
|--------|:----------:|:--------------:|
| id, vendor_id, external_id, email, full_name | ✓ | ✓ |
| first_name, last_name, date_of_birth, age, gender, phone | ✓ | ✓ |
| location_country, location_region, location_city, location_postal_code | ✓ | — |
| customer_segment, customer_tier, account_status | ✓ | ✓ |
| custom_tags, product_notes, notes | ✓ | ✓ |
| **location** (jsonb) | — | ✓ (005) |
| **search_tsv, created_by, updated_by** | — | ✓ (005, 017) |

---

## gold.b2b_customer_health_profiles

| Column | gold 2.sql | B2B (005) |
|--------|:----------:|:---------:|
| id, b2b_customer_id, height_cm, weight_kg, bmi, bmr | ✓ | ✓ |
| activity_level, health_goal, target_weight_kg | ✓ | ✓ |
| target_calories, target_protein_g, target_carbs_g, target_fat_g | ✓ | ✓ |
| target_fiber_g, target_sodium_mg, target_sugar_g | ✓ | — |
| **age, gender** | — | ✓ (005) |
| **conditions, diet_goals, macro_targets, avoid_allergens** | — | ✓ (005) |
| **tdee_cached, derived_limits, updated_by** | — | ✓ (005) |

---

## Other gold tables (B2B uses)

- **gold.b2b_users, gold.b2b_user_links, gold.b2b_vendor_mappings** — B2B auth (005)
- **gold.api_keys** — API key auth (010)
- **gold.invitations** — Invite flow (013)
- **gold.system_settings** — Settings (014)
- **gold.b2b_alerts, gold.b2b_compliance_*** — Features (016)
- **gold.allergens** — Taxonomy (gold 2.sql has it)

---

## Migration summary

If your DB was created from **gold 2.sql**, run these to add B2B compatibility columns:

1. **018** — `sub_category_id`, `cuisine_id`, `market_id` on gold.products  
2. **019** — `nutrition`, `dietary_tags`, `allergens`, `certifications`, `regulatory_codes`, `ingredients`, `notes`, `search_tsv`, `soft_deleted_at`, `product_url` on gold.products  
3. **005** — compatibility columns on gold.vendors, gold.b2b_customers, gold.b2b_customer_health_profiles  
4. **017** — any missing columns on gold.b2b_customers  

Run order: 005 → 017 → 018 → 019 (005 creates gold schema/tables if needed; 017/018/019 add columns).

---

## gold 2.sql columns B2B may use

If your DB is **not** from gold 2.sql, you may also need these on `gold.products` (used by quality-scoring, ingest):

- `image_url` (varchar)
- `manufacturer` (varchar)
- `country_of_origin` (varchar)
- `global_product_id` (uuid)

gold 2.sql has these. Migration 020 can add them if missing.
