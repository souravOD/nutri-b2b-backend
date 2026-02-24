/// <reference types="jest" />

/**
 * Unit tests for the quality scoring service (services/quality-scoring.ts)
 *
 * Tests the pure `scoreProduct()` function with various product scenarios.
 */

import { scoreProduct, type RawProductRow, type QualityScoreResult } from "../../services/quality-scoring.js";

// Helper: create a minimal product row with all nulls
function emptyProduct(overrides: Partial<RawProductRow> = {}): RawProductRow {
    return {
        id: "prod-1",
        vendor_id: "vendor-1",
        name: null,
        brand: null,
        description: null,
        barcode: null,
        gtin_type: null,
        price: null,
        serving_size: null,
        serving_size_g: null,
        package_weight: null,
        package_weight_g: null,
        image_url: null,
        product_url: null,
        category_id: null,
        manufacturer: null,
        country_of_origin: null,
        calories: null,
        total_fat_g: null,
        saturated_fat_g: null,
        total_carbs_g: null,
        protein_g: null,
        sodium_mg: null,
        dietary_fiber_g: null,
        total_sugars_g: null,
        allergens: null,
        dietary_tags: null,
        certifications: null,
        ingredients: null,
        nutrition: null,
        vendor_specific_attrs: null,
        ...overrides,
    };
}

// Helper: create a fully-populated product
function fullProduct(overrides: Partial<RawProductRow> = {}): RawProductRow {
    return emptyProduct({
        name: "Organic Almond Butter",
        brand: "NutriCo",
        description: "Premium organic almond butter, creamy texture",
        barcode: "012345678901",
        price: "12.99",
        serving_size: "2 tbsp (32g)",
        serving_size_g: "32",
        package_weight: "16 oz",
        package_weight_g: "454",
        image_url: "https://cdn.example.com/products/almond-butter.jpg",
        category_id: "cat-nuts-butters",
        manufacturer: "NutriCo Foods LLC",
        country_of_origin: "US",
        calories: "190",
        total_fat_g: "17",
        saturated_fat_g: "1.5",
        total_carbs_g: "7",
        protein_g: "7",
        sodium_mg: "0",
        dietary_fiber_g: "3",
        total_sugars_g: "2",
        allergens: ["tree_nuts"],
        dietary_tags: ["vegan", "gluten_free"],
        certifications: ["USDA_organic"],
        ingredients: ["almonds", "salt"],
        ...overrides,
    });
}

describe("Quality Scoring Service", () => {
    describe("scoreProduct()", () => {
        it("scores a fully populated product highly", () => {
            const result = scoreProduct(fullProduct());

            expect(result.overallScore).toBeGreaterThanOrEqual(80);
            expect(result.completeness).toBe(100);
            expect(result.nutritionScore).toBe(100);
            expect(result.imageScore).toBe(100);
            expect(result.allergenScore).toBe(100);
            expect(result.taxonomyScore).toBe(100); // category + tags + certs
            expect(result.missingFields).toHaveLength(0);
        });

        it("scores an empty product as grade F", () => {
            const result = scoreProduct(emptyProduct());

            expect(result.overallScore).toBeLessThan(20);
            expect(result.completeness).toBe(0);
            expect(result.nutritionScore).toBe(0);
            expect(result.imageScore).toBe(0);
            expect(result.allergenScore).toBe(0);
            expect(result.taxonomyScore).toBe(0);
            expect(result.missingFields.length).toBeGreaterThan(0);
        });

        it("awards partial nutrition score for some nutrients", () => {
            const result = scoreProduct(emptyProduct({
                name: "Test",
                calories: "100",
                protein_g: "5",
            }));

            // 2 nutrients filled → nutritionScore should be 60
            expect(result.nutritionScore).toBe(60);
        });

        it("awards fallback nutrition score for jsonb nutrition field", () => {
            const result = scoreProduct(emptyProduct({
                name: "Test",
                nutrition: { calories: 100, protein: 5 },
            }));

            expect(result.nutritionScore).toBe(50);
        });

        it("validates barcode format", () => {
            // Good barcode (12 digits = UPC)
            const good = scoreProduct(emptyProduct({
                name: "Test",
                barcode: "012345678901",
            }));
            expect(good.warnings.find(w => w.field === "barcode")).toBeUndefined();

            // Bad barcode (too short)
            const bad = scoreProduct(emptyProduct({
                name: "Test",
                barcode: "123",
            }));
            expect(bad.warnings.find(w => w.field === "barcode")).toBeDefined();
        });

        it("validates price sanity", () => {
            // Good price
            const good = scoreProduct(emptyProduct({
                name: "Test",
                price: "5.99",
            }));
            expect(good.warnings.find(w => w.field === "price")).toBeUndefined();

            // Bad price (negative)
            const bad = scoreProduct(emptyProduct({
                name: "Test",
                price: "-10",
            }));
            expect(bad.warnings.find(w => w.field === "price")).toBeDefined();
        });

        it("validates image URL format", () => {
            // Valid URL
            const valid = scoreProduct(emptyProduct({
                name: "Test",
                image_url: "https://cdn.example.com/img.jpg",
            }));
            expect(valid.imageScore).toBe(100);

            // Invalid URL (not a URL)
            const invalid = scoreProduct(emptyProduct({
                name: "Test",
                image_url: "not-a-url",
            }));
            expect(invalid.imageScore).toBe(50);
        });

        it("gives partial allergen score when ingredients exist but no allergens", () => {
            const result = scoreProduct(emptyProduct({
                name: "Test",
                ingredients: ["flour", "sugar", "butter"],
                allergens: null,
            }));

            expect(result.allergenScore).toBe(40);
            expect(result.warnings.find(w => w.field === "allergens" && w.severity === "warn")).toBeDefined();
        });

        it("scores taxonomy dimensions independently", () => {
            // Only category
            const catOnly = scoreProduct(emptyProduct({
                name: "Test",
                category_id: "cat-1",
            }));
            expect(catOnly.taxonomyScore).toBe(50);

            // Category + dietary tags
            const catTags = scoreProduct(emptyProduct({
                name: "Test",
                category_id: "cat-1",
                dietary_tags: ["vegan"],
            }));
            expect(catTags.taxonomyScore).toBe(80);

            // Category + tags + certs
            const all = scoreProduct(emptyProduct({
                name: "Test",
                category_id: "cat-1",
                dietary_tags: ["vegan"],
                certifications: ["organic"],
            }));
            expect(all.taxonomyScore).toBe(100);
        });

        it("clamps all scores between 0 and 100", () => {
            const result = scoreProduct(fullProduct());

            expect(result.overallScore).toBeGreaterThanOrEqual(0);
            expect(result.overallScore).toBeLessThanOrEqual(100);
            expect(result.completeness).toBeGreaterThanOrEqual(0);
            expect(result.completeness).toBeLessThanOrEqual(100);
            expect(result.accuracy).toBeGreaterThanOrEqual(0);
            expect(result.accuracy).toBeLessThanOrEqual(100);
            expect(result.nutritionScore).toBeGreaterThanOrEqual(0);
            expect(result.nutritionScore).toBeLessThanOrEqual(100);
            expect(result.imageScore).toBeGreaterThanOrEqual(0);
            expect(result.imageScore).toBeLessThanOrEqual(100);
            expect(result.allergenScore).toBeGreaterThanOrEqual(0);
            expect(result.allergenScore).toBeLessThanOrEqual(100);
            expect(result.taxonomyScore).toBeGreaterThanOrEqual(0);
            expect(result.taxonomyScore).toBeLessThanOrEqual(100);
        });

        it("tracks missing fields correctly", () => {
            const result = scoreProduct(emptyProduct({
                name: "Test Product",
                brand: "Test Brand",
            }));

            expect(result.missingFields).not.toContain("name");
            expect(result.missingFields).not.toContain("brand");
            expect(result.missingFields).toContain("description");
            expect(result.missingFields).toContain("barcode");
            expect(result.missingFields).toContain("image_url");
        });
    });
});
