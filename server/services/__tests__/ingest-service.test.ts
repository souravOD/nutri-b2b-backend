/// <reference types="jest" />

// Mock database and supabase modules to avoid real connections during tests
jest.mock("../../lib/database.js", () => ({
    db: { execute: jest.fn() },
    readDb: { execute: jest.fn() },
    primaryPool: { query: jest.fn() },
}));

jest.mock("../../lib/supabase.js", () => ({
    supabaseAdmin: {
        storage: { from: jest.fn() },
    },
}));

import { computeDataHash, newRunId, resolveBronzeTable } from "../ingest-service.js";

describe("ingest-service helpers", () => {
    // ── computeDataHash ──
    describe("computeDataHash", () => {
        it("produces deterministic output for the same input", () => {
            const payload = { name: "Protein Bar", barcode: "123456" };
            const h1 = computeDataHash("vendor-1", payload);
            const h2 = computeDataHash("vendor-1", payload);
            expect(h1).toBe(h2);
        });

        it("produces different hashes for different vendors", () => {
            const payload = { name: "Protein Bar" };
            const h1 = computeDataHash("vendor-1", payload);
            const h2 = computeDataHash("vendor-2", payload);
            expect(h1).not.toBe(h2);
        });

        it("produces same hash regardless of key order", () => {
            const h1 = computeDataHash("v", { a: 1, b: 2 });
            const h2 = computeDataHash("v", { b: 2, a: 1 });
            expect(h1).toBe(h2);
        });

        it("returns a 64-char hex string (SHA-256)", () => {
            const h = computeDataHash("v", { x: 1 });
            expect(h).toMatch(/^[0-9a-f]{64}$/);
        });
    });

    // ── newRunId ──
    describe("newRunId", () => {
        it("returns a valid UUID v4 string", () => {
            const id = newRunId();
            expect(id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            );
        });

        it("returns unique values on repeated calls", () => {
            const ids = new Set(Array.from({ length: 100 }, () => newRunId()));
            expect(ids.size).toBe(100);
        });
    });

    // ── resolveBronzeTable ──
    describe("resolveBronzeTable", () => {
        it('maps "products" to raw_products', () => {
            expect(resolveBronzeTable("products")).toBe("raw_products");
        });

        it('maps "customers" to raw_customers', () => {
            expect(resolveBronzeTable("customers")).toBe("raw_customers");
        });

        it('maps "customer_health_profiles" to raw_customer_health_profiles', () => {
            expect(resolveBronzeTable("customer_health_profiles")).toBe(
                "raw_customer_health_profiles"
            );
        });

        it('maps "ingredients" to raw_ingredients', () => {
            expect(resolveBronzeTable("ingredients")).toBe("raw_ingredients");
        });

        it('maps "recipes" to raw_recipes', () => {
            expect(resolveBronzeTable("recipes")).toBe("raw_recipes");
        });

        it("defaults unknown modes to raw_products", () => {
            expect(resolveBronzeTable("foobar")).toBe("raw_products");
            expect(resolveBronzeTable("")).toBe("raw_products");
        });
    });
});
