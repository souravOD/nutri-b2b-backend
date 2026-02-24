/// <reference types="jest" />

/**
 * Unit tests for the quality router (routes/quality.ts)
 *
 * Covers:
 *   GET  /quality/products/:id          — single product quality score
 *   GET  /quality/vendor-summary        — vendor-wide quality averages
 *   POST /quality/products/:id/rescore  — trigger re-score
 *   Permission enforcement for all roles
 */

// ── Mocks ─────────────────────────────────────────────────────────

const mockSelect = jest.fn();
const mockFrom = jest.fn();
const mockWhere = jest.fn();
const mockLimit = jest.fn();

// Mock database
jest.mock("../../lib/database.js", () => ({
    db: {
        select: (...args: any[]) => mockSelect(...args),
        insert: jest.fn(),
    },
    readDb: { select: jest.fn() },
    primaryPool: { query: jest.fn() },
}));

// Mock quality scoring service
const mockScoreAndUpsert = jest.fn();
const mockGetVendorQualitySummary = jest.fn();

jest.mock("../../services/quality-scoring.js", () => ({
    scoreAndUpsert: (...args: any[]) => mockScoreAndUpsert(...args),
    getVendorQualitySummary: (...args: any[]) => mockGetVendorQualitySummary(...args),
}));

// Mock auth module
jest.mock("../../lib/auth.js", () => {
    const originalModule = jest.requireActual("../../lib/auth.js") as any;
    return {
        ...originalModule,
        requireAuth: (req: any, _res: any, next: any) => {
            next();
        },
        requirePermissionMiddleware: (...perms: string[]) => {
            return (req: any, res: any, next: any) => {
                const auth = req.auth;
                if (!auth) return res.status(401).json({ code: "unauthorized" });
                const has = auth.permissions.includes("*") ||
                    perms.every((p: string) => auth.permissions.includes(p));
                if (!has) return res.status(403).json({ code: "permission_denied" });
                next();
            };
        },
    };
});

import express from "express";
import request from "supertest";
import qualityRouter from "../quality.js";

// ── Test app setup ───────────────────────────────────────────────

function createApp(auth: any) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.auth = auth;
        next();
    });
    app.use("/quality", qualityRouter);
    return app;
}

const adminAuth = {
    userId: "user-admin-id",
    email: "admin@acme.com",
    vendorId: "vendor-1",
    role: "vendor_admin",
    permissions: [
        "read:vendors", "write:vendors",
        "read:products", "write:products",
        "read:customers", "write:customers",
        "read:ingest", "write:ingest",
        "read:matches", "read:audit",
        "manage:users", "manage:api_keys", "manage:settings",
    ],
};

const viewerAuth = {
    userId: "user-viewer-id",
    email: "viewer@acme.com",
    vendorId: "vendor-1",
    role: "vendor_viewer",
    permissions: ["read:products", "read:customers", "read:matches"],
};

const operatorAuth = {
    userId: "user-op-id",
    email: "op@acme.com",
    vendorId: "vendor-1",
    role: "vendor_operator",
    permissions: [
        "read:products", "write:products",
        "read:customers", "write:customers",
        "read:ingest", "write:ingest",
        "read:matches",
    ],
};

const superadminAuth = {
    userId: "sa-1",
    email: "sa@system.com",
    vendorId: "vendor-system",
    role: "superadmin",
    permissions: ["*"],
};

const sampleScore = {
    id: "score-1",
    vendorId: "vendor-1",
    productId: "prod-1",
    overallScore: 85,
    completeness: 90,
    accuracy: 80,
    nutritionScore: 95,
    imageScore: 100,
    allergenScore: 70,
    taxonomyScore: 80,
    missingFields: [],
    warnings: [],
    scoredAt: "2025-06-01T00:00:00Z",
    scoredBy: "system",
    runId: null,
};

// ── Tests ─────────────────────────────────────────────────────────

describe("Quality Router", () => {
    beforeEach(() => {
        mockSelect.mockReset();
        mockFrom.mockReset();
        mockWhere.mockReset();
        mockLimit.mockReset();
        mockScoreAndUpsert.mockReset();
        mockGetVendorQualitySummary.mockReset();
    });

    // ── GET /quality/products/:id ──────────────────────────────────

    describe("GET /quality/products/:id", () => {
        it("returns the quality score for a product", async () => {
            mockSelect.mockReturnValue({
                from: jest.fn().mockReturnValue({
                    where: jest.fn().mockReturnValue({
                        limit: jest.fn().mockResolvedValue([sampleScore]),
                    }),
                }),
            });

            const app = createApp(adminAuth);
            const res = await request(app).get("/quality/products/prod-1");

            expect(res.status).toBe(200);
            expect(res.body.productId).toBe("prod-1");
            expect(res.body.overallScore).toBe(85);
            expect(res.body.grade).toBe("A");
            expect(res.body.dimensions).toEqual({
                completeness: 90,
                accuracy: 80,
                nutrition: 95,
                image: 100,
                allergen: 70,
                taxonomy: 80,
            });
        });

        it("returns 404 when no score exists", async () => {
            mockSelect.mockReturnValue({
                from: jest.fn().mockReturnValue({
                    where: jest.fn().mockReturnValue({
                        limit: jest.fn().mockResolvedValue([]),
                    }),
                }),
            });

            const app = createApp(adminAuth);
            const res = await request(app).get("/quality/products/unknown-id");

            expect(res.status).toBe(404);
        });

        it("allows vendor_viewer (has read:products)", async () => {
            mockSelect.mockReturnValue({
                from: jest.fn().mockReturnValue({
                    where: jest.fn().mockReturnValue({
                        limit: jest.fn().mockResolvedValue([sampleScore]),
                    }),
                }),
            });

            const app = createApp(viewerAuth);
            const res = await request(app).get("/quality/products/prod-1");
            expect(res.status).toBe(200);
        });

        it("allows superadmin", async () => {
            mockSelect.mockReturnValue({
                from: jest.fn().mockReturnValue({
                    where: jest.fn().mockReturnValue({
                        limit: jest.fn().mockResolvedValue([sampleScore]),
                    }),
                }),
            });

            const app = createApp(superadminAuth);
            const res = await request(app).get("/quality/products/prod-1");
            expect(res.status).toBe(200);
        });
    });

    // ── GET /quality/vendor-summary ────────────────────────────────

    describe("GET /quality/vendor-summary", () => {
        const summaryResult = {
            totalProducts: 50,
            averages: { overall: 72, completeness: 80, accuracy: 75, nutrition: 65, image: 60, allergen: 85, taxonomy: 70 },
            gradeDistribution: { A: 10, B: 20, C: 15, D: 3, F: 2 },
        };

        it("returns vendor quality summary", async () => {
            mockGetVendorQualitySummary.mockResolvedValue(summaryResult);

            const app = createApp(adminAuth);
            const res = await request(app).get("/quality/vendor-summary");

            expect(res.status).toBe(200);
            expect(res.body.totalProducts).toBe(50);
            expect(res.body.averages.overall).toBe(72);
            expect(res.body.gradeDistribution.A).toBe(10);
        });

        it("returns 403 for vendor_viewer (no read:vendors)", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app).get("/quality/vendor-summary");
            expect(res.status).toBe(403);
        });

        it("returns 403 for vendor_operator (no read:vendors)", async () => {
            const app = createApp(operatorAuth);
            const res = await request(app).get("/quality/vendor-summary");
            expect(res.status).toBe(403);
        });

        it("allows superadmin", async () => {
            mockGetVendorQualitySummary.mockResolvedValue(summaryResult);

            const app = createApp(superadminAuth);
            const res = await request(app).get("/quality/vendor-summary");
            expect(res.status).toBe(200);
        });
    });

    // ── POST /quality/products/:id/rescore ─────────────────────────

    describe("POST /quality/products/:id/rescore", () => {
        const rescoreResult = {
            overallScore: 75,
            completeness: 80,
            accuracy: 70,
            nutritionScore: 90,
            imageScore: 50,
            allergenScore: 60,
            taxonomyScore: 80,
            missingFields: ["image_url"],
            warnings: [{ field: "image_url", message: "No image", severity: "error" }],
        };

        it("rescores a product and returns the result", async () => {
            mockScoreAndUpsert.mockResolvedValue(rescoreResult);

            const app = createApp(adminAuth);
            const res = await request(app).post("/quality/products/prod-1/rescore");

            expect(res.status).toBe(200);
            expect(res.body.productId).toBe("prod-1");
            expect(res.body.overallScore).toBe(75);
            expect(res.body.grade).toBe("B");
            expect(mockScoreAndUpsert).toHaveBeenCalledWith("prod-1", "vendor-1", undefined, "user-admin-id");
        });

        it("returns 404 when product not found", async () => {
            mockScoreAndUpsert.mockRejectedValue(new Error("Product xyz not found"));

            const app = createApp(adminAuth);
            const res = await request(app).post("/quality/products/xyz/rescore");
            expect(res.status).toBe(404);
        });

        it("returns 403 for vendor_viewer (no write:products)", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app).post("/quality/products/prod-1/rescore");
            expect(res.status).toBe(403);
        });

        it("allows vendor_operator (has write:products)", async () => {
            mockScoreAndUpsert.mockResolvedValue(rescoreResult);

            const app = createApp(operatorAuth);
            const res = await request(app).post("/quality/products/prod-1/rescore");
            expect(res.status).toBe(200);
        });

        it("allows superadmin", async () => {
            mockScoreAndUpsert.mockResolvedValue(rescoreResult);

            const app = createApp(superadminAuth);
            const res = await request(app).post("/quality/products/prod-1/rescore");
            expect(res.status).toBe(200);
        });
    });
});
