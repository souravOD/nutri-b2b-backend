# Schema Changes: gold.products

**For team reference** — migrations 018 and 019 add missing columns to `gold.products` so the B2B portal works correctly.

## Problem

The `gold.products` table was missing columns that the application expects, causing:

- `column "sub_category_id" does not exist`
- `column "nutrition" does not exist`

## Migrations

### Migration 018 — Relationship IDs

**File:** `migrations/018_gold_products_missing_columns.sql`

Adds:

| Column           | Type | Description                    |
|------------------|------|--------------------------------|
| `sub_category_id`| uuid | Optional sub-category reference |
| `cuisine_id`     | uuid | Optional cuisine reference      |
| `market_id`      | uuid | Optional market reference       |

**Run:** `npm run db:migrate:018`

---

### Migration 019 — Compatibility / Nutrition Columns

**File:** `migrations/019_gold_products_compatibility_columns.sql`

Adds:

| Column            | Type      | Description                          |
|-------------------|-----------|--------------------------------------|
| `nutrition`       | jsonb     | Per-serving nutrition (calories, etc.)|
| `dietary_tags`    | text[]    | Diet labels (e.g. vegan, gluten-free)|
| `allergens`       | text[]    | Allergen list                        |
| `certifications`  | text[]    | Certifications (e.g. Organic)        |
| `regulatory_codes`| text[]    | Regulatory codes                     |
| `ingredients`     | text[]    | Ingredient list                      |
| `notes`           | text      | Vendor notes                         |
| `search_tsv`      | tsvector  | Full-text search vector              |
| `soft_deleted_at` | timestamp | Soft delete timestamp                |
| `product_url`     | text      | Source/product URL                   |

**Run:** `npm run db:migrate:019`

---

## Full gold.products Column Set (After Migrations)

Core: `id`, `vendor_id`, `external_id`, `name`, `brand`, `description`, `category_id`, `price`, `currency`, `status`, `created_at`, `updated_at`

Optional: `sub_category_id`, `cuisine_id`, `market_id`, `barcode`, `gtin_type`, `serving_size`, `package_weight`, `product_url`, `notes`, `nutrition`, `dietary_tags`, `allergens`, `certifications`, `regulatory_codes`, `ingredients`, `search_tsv`, `soft_deleted_at`

## Run Order

1. `npm run db:migrate:018`
2. `npm run db:migrate:019`

Both are idempotent (safe to re-run).

---

### Migration 020 — gold 2.sql alignment

**File:** `migrations/020_gold_products_gold2_alignment.sql`

Adds columns from `gold 2.sql` used by quality-scoring and ingest:

| Column | Type | Description |
|--------|------|--------------|
| `image_url` | varchar(1000) | Product image URL |
| `manufacturer` | varchar(255) | Manufacturer name |
| `country_of_origin` | varchar(100) | Country of origin |
| `global_product_id` | uuid | Cross-vendor product ID |
| `package_weight_g` | numeric | Weight in grams |
| `serving_size_g` | numeric | Serving size in grams |
| `servings_per_container` | numeric | Servings per package |
| `vendor_specific_attrs` | jsonb | Vendor-specific data |
| `source_system` | varchar(100) | Source system identifier |

**Run:** `npm run db:migrate:020`

---

## Data persistence fix (storage layer)

The storage layer was updated so **create** and **update** persist all product fields:

- **createProducts** — now inserts: `nutrition`, `dietary_tags`, `allergens`, `certifications`, `regulatory_codes`, `ingredients`, `sub_category_id`, `cuisine_id`, `market_id`
- **updateProduct** — now updates these fields when provided

Previously only basic fields (name, brand, price, etc.) were saved. Nutrition, ingredients, and compliance data entered in the form are now stored and displayed on the product detail page.

---

### Migration 021 — Inline nutrition columns

**File:** `migrations/021_gold_products_inline_nutrition.sql`

Adds inline nutrition columns for fallback when `nutrition` jsonb is empty (gold 2.sql style):

| Column | Type | Description |
|--------|------|--------------|
| `calories` | numeric | Calories per serving |
| `total_fat_g` | numeric | Total fat (g) |
| `saturated_fat_g` | numeric | Saturated fat (g) |
| `sodium_mg` | numeric | Sodium (mg) |
| `total_carbs_g` | numeric | Total carbs (g) |
| `total_sugars_g` | numeric | Total sugars (g) |
| `added_sugars_g` | numeric | Added sugars (g) |
| `protein_g` | numeric | Protein (g) |
| `dietary_fiber_g` | numeric | Fiber (g) |
| `potassium_mg` | numeric | Potassium (mg) |
| `phosphorus_mg` | numeric | Phosphorus (mg) |

**Run:** Apply migration 021 before using product detail with inline nutrition fallback. The storage layer will use these when `nutrition` jsonb is null/empty.
