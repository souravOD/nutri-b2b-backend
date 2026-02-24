/**
 * Product Quality Scoring Service
 *
 * Computes a 0–100 quality score across 6 dimensions for each product:
 *   1. completeness  — % of required/expected fields filled
 *   2. accuracy      — basic validation checks (barcode format, price, etc.)
 *   3. nutrition     — nutrition data quality (jsonb or inline columns)
 *   4. image         — image_url present and non-empty
 *   5. allergen      — allergens array populated
 *   6. taxonomy      — category, dietary_tags present
 *
 * Each dimension is scored 0–100; overall_score = weighted average.
 */

import { db, primaryPool } from "../lib/database.js";
import { productQualityScores } from "../../shared/schema.js";
import { sql } from "drizzle-orm";

// ── Types ────────────────────────────────────────────────────

/** Raw product row fetched via SQL (includes columns NOT in Drizzle schema) */
export interface RawProductRow {
    id: string;
    vendor_id: string;
    name: string | null;
    brand: string | null;
    description: string | null;
    barcode: string | null;
    gtin_type: string | null;
    price: string | null; // numeric → string in pg
    serving_size: string | null;
    serving_size_g: string | null;
    package_weight: string | null;
    package_weight_g: string | null;
    image_url: string | null;
    product_url: string | null;
    category_id: string | null;
    manufacturer: string | null;
    country_of_origin: string | null;
    // Inline nutrition columns
    calories: string | null;
    total_fat_g: string | null;
    saturated_fat_g: string | null;
    total_carbs_g: string | null;
    protein_g: string | null;
    sodium_mg: string | null;
    dietary_fiber_g: string | null;
    total_sugars_g: string | null;
    // Arrays / jsonb (decoded by pg driver)
    allergens: string[] | null;
    dietary_tags: string[] | null;
    certifications: string[] | null;
    ingredients: string[] | null;
    nutrition: Record<string, any> | null;
    vendor_specific_attrs: Record<string, any> | null;
}

export interface QualityScoreResult {
    overallScore: number;
    completeness: number;
    accuracy: number;
    nutritionScore: number;
    imageScore: number;
    allergenScore: number;
    taxonomyScore: number;
    missingFields: string[];
    warnings: Array<{ field: string; message: string; severity: "info" | "warn" | "error" }>;
}

// ── Weights ──────────────────────────────────────────────────

const WEIGHTS = {
    completeness: 0.30,
    accuracy: 0.15,
    nutrition: 0.20,
    image: 0.10,
    allergen: 0.15,
    taxonomy: 0.10,
} as const;

// ── Core scoring function (pure, no I/O) ─────────────────────

/**
 * Score a product row across all 6 dimensions.
 * All scores are integers 0–100.
 */
export function scoreProduct(row: RawProductRow): QualityScoreResult {
    const missing: string[] = [];
    const warnings: QualityScoreResult["warnings"] = [];

    // 1. Completeness — check presence of key fields
    const completenessFields: Array<{ key: keyof RawProductRow; label: string; weight: number }> = [
        { key: "name", label: "name", weight: 15 },
        { key: "brand", label: "brand", weight: 10 },
        { key: "description", label: "description", weight: 10 },
        { key: "barcode", label: "barcode", weight: 10 },
        { key: "price", label: "price", weight: 5 },
        { key: "serving_size", label: "serving_size", weight: 5 },
        { key: "package_weight", label: "package_weight", weight: 5 },
        { key: "image_url", label: "image_url", weight: 10 },
        { key: "category_id", label: "category_id", weight: 10 },
        { key: "manufacturer", label: "manufacturer", weight: 5 },
        { key: "country_of_origin", label: "country_of_origin", weight: 5 },
        { key: "ingredients", label: "ingredients", weight: 10 },
    ];

    let completenessEarned = 0;
    let completenessTotal = 0;
    for (const f of completenessFields) {
        completenessTotal += f.weight;
        const val = row[f.key];
        const filled =
            val !== null &&
            val !== undefined &&
            val !== "" &&
            !(Array.isArray(val) && val.length === 0);
        if (filled) {
            completenessEarned += f.weight;
        } else {
            missing.push(f.label);
        }
    }
    const completeness = Math.round((completenessEarned / completenessTotal) * 100);

    // 2. Accuracy — validation checks
    let accuracyChecks = 0;
    let accuracyPassed = 0;

    // Barcode format
    accuracyChecks++;
    if (row.barcode) {
        const cleanBarcode = row.barcode.replace(/[^0-9]/g, "");
        if (cleanBarcode.length >= 8 && cleanBarcode.length <= 14) {
            accuracyPassed++;
        } else {
            warnings.push({ field: "barcode", message: `Barcode length ${cleanBarcode.length} is unusual (expected 8-14 digits)`, severity: "warn" });
        }
    } else {
        accuracyPassed += 0.5; // No barcode isn't an accuracy error, just a completeness one
    }

    // Price sanity
    accuracyChecks++;
    if (row.price) {
        const p = parseFloat(row.price);
        if (!isNaN(p) && p > 0 && p < 100000) {
            accuracyPassed++;
        } else {
            warnings.push({ field: "price", message: `Price ${row.price} seems invalid`, severity: "warn" });
        }
    } else {
        accuracyPassed += 0.5;
    }

    // Name length sanity
    accuracyChecks++;
    if (row.name && row.name.length >= 2 && row.name.length <= 500) {
        accuracyPassed++;
    } else if (row.name) {
        warnings.push({ field: "name", message: `Name length ${row.name.length} is unusual`, severity: "warn" });
    }

    // Serving size / package weight numeric check
    accuracyChecks++;
    if (row.serving_size_g || row.package_weight_g) {
        const sg = row.serving_size_g ? parseFloat(row.serving_size_g) : null;
        const pw = row.package_weight_g ? parseFloat(row.package_weight_g) : null;
        if ((sg !== null && sg > 0) || (pw !== null && pw > 0)) {
            accuracyPassed++;
        } else {
            warnings.push({ field: "serving_size_g", message: "Numeric serving/package weight is zero or negative", severity: "warn" });
        }
    } else {
        accuracyPassed += 0.5;
    }

    const accuracy = Math.round((accuracyPassed / accuracyChecks) * 100);

    // 3. Nutrition — check for inline nutrition data
    let nutritionScore = 0;
    const coreNutrients = [
        row.calories, row.total_fat_g, row.total_carbs_g, row.protein_g,
        row.sodium_mg, row.saturated_fat_g,
    ];
    const filledNutrients = coreNutrients.filter((v) => v !== null && v !== undefined && v !== "").length;

    if (filledNutrients >= 4) {
        nutritionScore = 100;
    } else if (filledNutrients >= 2) {
        nutritionScore = 60;
    } else if (filledNutrients >= 1) {
        nutritionScore = 30;
    } else {
        // Fallback: check jsonb nutrition field
        if (row.nutrition && typeof row.nutrition === "object" && Object.keys(row.nutrition).length > 0) {
            nutritionScore = 50; // jsonb present but not as reliable as inline
        } else {
            nutritionScore = 0;
            warnings.push({ field: "nutrition", message: "No nutrition data available", severity: "error" });
        }
    }

    // 4. Image — binary check with URL validation
    let imageScore = 0;
    if (row.image_url && row.image_url.trim().length > 0) {
        try {
            new URL(row.image_url);
            imageScore = 100;
        } catch {
            imageScore = 50; // Has value but not a valid URL
            warnings.push({ field: "image_url", message: "Image URL is not a valid URL", severity: "info" });
        }
    } else {
        imageScore = 0;
        // Already tracked in missing fields
    }

    // 5. Allergen — allergens array populated
    let allergenScore = 0;
    if (row.allergens && Array.isArray(row.allergens) && row.allergens.length > 0) {
        allergenScore = 100;
    } else if (row.ingredients && Array.isArray(row.ingredients) && row.ingredients.length > 0) {
        // Has ingredients but no allergens — partial credit (could derive allergens)
        allergenScore = 40;
        warnings.push({ field: "allergens", message: "No allergen declarations despite having ingredients", severity: "warn" });
    } else {
        allergenScore = 0;
        warnings.push({ field: "allergens", message: "No allergen or ingredient data", severity: "error" });
    }

    // 6. Taxonomy — category + dietary tags
    let taxonomyScore = 0;
    let taxonomyPoints = 0;
    if (row.category_id) taxonomyPoints += 50;
    if (row.dietary_tags && Array.isArray(row.dietary_tags) && row.dietary_tags.length > 0) taxonomyPoints += 30;
    if (row.certifications && Array.isArray(row.certifications) && row.certifications.length > 0) taxonomyPoints += 20;
    taxonomyScore = taxonomyPoints;

    // ── Overall weighted score ─────────────────────────────────
    const overallScore = Math.round(
        completeness * WEIGHTS.completeness +
        accuracy * WEIGHTS.accuracy +
        nutritionScore * WEIGHTS.nutrition +
        imageScore * WEIGHTS.image +
        allergenScore * WEIGHTS.allergen +
        taxonomyScore * WEIGHTS.taxonomy,
    );

    return {
        overallScore: clamp(overallScore),
        completeness: clamp(completeness),
        accuracy: clamp(accuracy),
        nutritionScore: clamp(nutritionScore),
        imageScore: clamp(imageScore),
        allergenScore: clamp(allergenScore),
        taxonomyScore: clamp(taxonomyScore),
        missingFields: missing,
        warnings,
    };
}

function clamp(v: number): number {
    return Math.max(0, Math.min(100, v));
}

// ── DB helpers ────────────────────────────────────────────────

/**
 * Fetch a single raw product from gold.products using raw SQL
 * (includes image_url which is not in the Drizzle schema).
 */
export async function fetchRawProduct(productId: string): Promise<RawProductRow | null> {
    const { rows } = await primaryPool.query(
        `SELECT id, vendor_id, name, brand, description, barcode, gtin_type,
            price, serving_size, serving_size_g, package_weight, package_weight_g,
            image_url, product_url, category_id, manufacturer, country_of_origin,
            calories, total_fat_g, saturated_fat_g, total_carbs_g, protein_g,
            sodium_mg, dietary_fiber_g, total_sugars_g,
            allergens, dietary_tags, certifications, ingredients,
            nutrition, vendor_specific_attrs
     FROM gold.products
     WHERE id = $1`,
        [productId],
    );
    return (rows[0] as RawProductRow) ?? null;
}

/**
 * Score a product and upsert the result into gold.product_quality_scores.
 * Uses ON CONFLICT (product_id) DO UPDATE for idempotent writes.
 */
export async function scoreAndUpsert(
    productId: string,
    vendorId: string,
    runId?: string,
    scoredBy = "system",
): Promise<QualityScoreResult> {
    const row = await fetchRawProduct(productId);
    if (!row) throw new Error(`Product ${productId} not found`);

    const result = scoreProduct(row);

    await db
        .insert(productQualityScores)
        .values({
            vendorId,
            productId,
            overallScore: result.overallScore,
            completeness: result.completeness,
            accuracy: result.accuracy,
            nutritionScore: result.nutritionScore,
            imageScore: result.imageScore,
            allergenScore: result.allergenScore,
            taxonomyScore: result.taxonomyScore,
            missingFields: result.missingFields,
            warnings: result.warnings,
            scoredBy,
            runId: runId ?? null,
        })
        .onConflictDoUpdate({
            target: productQualityScores.productId,
            set: {
                vendorId,
                overallScore: result.overallScore,
                completeness: result.completeness,
                accuracy: result.accuracy,
                nutritionScore: result.nutritionScore,
                imageScore: result.imageScore,
                allergenScore: result.allergenScore,
                taxonomyScore: result.taxonomyScore,
                missingFields: result.missingFields,
                warnings: result.warnings,
                scoredAt: sql`now()`,
                scoredBy,
                runId: runId ?? null,
            },
        });

    return result;
}

/**
 * Get vendor-level quality summary: avg scores across all products.
 */
export async function getVendorQualitySummary(vendorId: string) {
    const [row] = await db
        .select({
            totalProducts: sql<number>`count(*)::int`,
            avgOverall: sql<number>`round(avg(${productQualityScores.overallScore}))::int`,
            avgCompleteness: sql<number>`round(avg(${productQualityScores.completeness}))::int`,
            avgAccuracy: sql<number>`round(avg(${productQualityScores.accuracy}))::int`,
            avgNutrition: sql<number>`round(avg(${productQualityScores.nutritionScore}))::int`,
            avgImage: sql<number>`round(avg(${productQualityScores.imageScore}))::int`,
            avgAllergen: sql<number>`round(avg(${productQualityScores.allergenScore}))::int`,
            avgTaxonomy: sql<number>`round(avg(${productQualityScores.taxonomyScore}))::int`,
            gradeA: sql<number>`count(*) filter (where ${productQualityScores.overallScore} >= 80)::int`,
            gradeB: sql<number>`count(*) filter (where ${productQualityScores.overallScore} >= 60 and ${productQualityScores.overallScore} < 80)::int`,
            gradeC: sql<number>`count(*) filter (where ${productQualityScores.overallScore} >= 40 and ${productQualityScores.overallScore} < 60)::int`,
            gradeD: sql<number>`count(*) filter (where ${productQualityScores.overallScore} >= 20 and ${productQualityScores.overallScore} < 40)::int`,
            gradeF: sql<number>`count(*) filter (where ${productQualityScores.overallScore} < 20)::int`,
        })
        .from(productQualityScores)
        .where(sql`${productQualityScores.vendorId} = ${vendorId}`);

    return {
        totalProducts: row?.totalProducts ?? 0,
        averages: {
            overall: row?.avgOverall ?? 0,
            completeness: row?.avgCompleteness ?? 0,
            accuracy: row?.avgAccuracy ?? 0,
            nutrition: row?.avgNutrition ?? 0,
            image: row?.avgImage ?? 0,
            allergen: row?.avgAllergen ?? 0,
            taxonomy: row?.avgTaxonomy ?? 0,
        },
        gradeDistribution: {
            A: row?.gradeA ?? 0,
            B: row?.gradeB ?? 0,
            C: row?.gradeC ?? 0,
            D: row?.gradeD ?? 0,
            F: row?.gradeF ?? 0,
        },
    };
}
