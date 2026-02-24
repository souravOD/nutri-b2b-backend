/**
 * Tests for the Compliance router.
 */
import express from "express";
import request from "supertest";

// ── Mock database ────────────────────────────────────────────────────────────
const mockExecute = jest.fn();
jest.mock("../../lib/database.js", () => ({
    db: { execute: (...args: any[]) => mockExecute(...args) },
}));

// ── Mock alerts (insertAlert) ────────────────────────────────────────────────
const mockInsertAlert = jest.fn().mockResolvedValue({ id: "alert-1" });
jest.mock("../alerts.js", () => ({
    insertAlert: (...args: any[]) => mockInsertAlert(...args),
}));

// ── Mock auth ────────────────────────────────────────────────────────────────
jest.mock("../../lib/auth.js", () => ({
    requireAuth: (req: any, _res: any, next: any) => next(),
    requirePermissionMiddleware: (..._perms: string[]) =>
        (req: any, _res: any, next: any) => {
            if (!req.auth) return _res.status(403).json({ code: "permission_denied" });
            next();
        },
}));

import complianceRouter from "../compliance.js";

// ── Test helpers ─────────────────────────────────────────────────────────────
const VENDOR_ID = "aaaa-bbbb-cccc-dddd";

const adminAuth = {
    userId: "user-1",
    appwriteUserId: "aw-1",
    email: "admin@example.com",
    vendorId: VENDOR_ID,
    role: "vendor_admin" as const,
    permissions: ["read:vendors", "write:vendors"],
};

function createApp(auth: any) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.auth = auth;
        next();
    });
    app.use("/compliance", complianceRouter);
    return app;
}

beforeEach(() => {
    mockExecute.mockReset();
    mockInsertAlert.mockReset();
    mockInsertAlert.mockResolvedValue({ id: "alert-1" });
});

// ─── GET /compliance/rules ──────────────────────────────────────────────────

describe("GET /compliance/rules", () => {
    it("returns active rules for the vendor", async () => {
        const mockRules = [
            { id: "r1", title: "Nutrition info", regulation: "EU-FIC", check_type: "nutrition_completeness" },
        ];
        mockExecute.mockResolvedValueOnce({ rows: mockRules });

        const app = createApp(adminAuth);
        const res = await request(app).get("/compliance/rules").expect(200);

        expect(res.body.data).toEqual(mockRules);
    });

    it("returns 400 when vendor context is missing", async () => {
        const app = createApp({ ...adminAuth, vendorId: null });
        const res = await request(app).get("/compliance/rules").expect(400);
        expect(res.body.code).toBe("bad_request");
    });
});

// ─── GET /compliance/checks ─────────────────────────────────────────────────

describe("GET /compliance/checks", () => {
    it("returns paginated checks", async () => {
        mockExecute
            .mockResolvedValueOnce({ rows: [{ total: 1 }] })
            .mockResolvedValueOnce({ rows: [{ id: "c1", status: "compliant" }] });

        const app = createApp(adminAuth);
        const res = await request(app).get("/compliance/checks").expect(200);

        expect(res.body.data).toHaveLength(1);
        expect(res.body.total).toBe(1);
    });

    it("rejects invalid status filter", async () => {
        const app = createApp(adminAuth);
        const res = await request(app).get("/compliance/checks?status=bogus").expect(400);
        expect(res.body.code).toBe("bad_request");
    });
});

// ─── GET /compliance/summary ────────────────────────────────────────────────

describe("GET /compliance/summary", () => {
    it("returns aggregated summary", async () => {
        mockExecute.mockResolvedValueOnce({
            rows: [{
                total_rules_checked: 5,
                compliant: 3,
                warning: 1,
                non_compliant: 1,
                overall_score: 85,
            }],
        });

        const app = createApp(adminAuth);
        const res = await request(app).get("/compliance/summary").expect(200);

        expect(res.body).toEqual({
            totalRulesChecked: 5,
            compliant: 3,
            warning: 1,
            nonCompliant: 1,
            overallScore: 85,
        });
    });
});

// ─── POST /compliance/run ───────────────────────────────────────────────────

describe("POST /compliance/run", () => {
    it("evaluates rules and returns check results", async () => {
        // 1: fetch rules
        mockExecute.mockResolvedValueOnce({
            rows: [
                { id: "r1", title: "Allergens", regulation: "EU-FIC", check_type: "allergen_declaration", severity: "critical" },
            ],
        });
        // 2: product stats
        mockExecute.mockResolvedValueOnce({
            rows: [{
                total_products: 100,
                with_nutrition: 90,
                with_allergens: 40,  // 40% → non_compliant
                with_ingredients: 80,
                with_barcode: 95,
                with_certifications: 50,
            }],
        });
        // 3: insert check
        mockExecute.mockResolvedValueOnce({
            rows: [{ id: "chk-1", status: "non_compliant", score: 40, products_checked: 100, products_failed: 60 }],
        });

        const app = createApp(adminAuth);
        const res = await request(app).post("/compliance/run").expect(200);

        expect(res.body.checks).toHaveLength(1);
        expect(res.body.checks[0].status).toBe("non_compliant");

        // Should have inserted an alert for non-compliant
        expect(mockInsertAlert).toHaveBeenCalledTimes(1);
        expect(mockInsertAlert).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "compliance",
                priority: "high",
            }),
        );
    });

    it("returns empty when no active rules exist", async () => {
        mockExecute.mockResolvedValueOnce({ rows: [] });

        const app = createApp(adminAuth);
        const res = await request(app).post("/compliance/run").expect(200);

        expect(res.body.checks).toEqual([]);
        expect(mockInsertAlert).not.toHaveBeenCalled();
    });
});

// ─── PATCH /compliance/checks/:id ───────────────────────────────────────────

describe("PATCH /compliance/checks/:id", () => {
    it("updates the next_review date", async () => {
        mockExecute.mockResolvedValueOnce({
            rows: [{ id: "c1", next_review: "2025-04-01" }],
        });

        const app = createApp(adminAuth);
        const res = await request(app)
            .patch("/compliance/checks/c1")
            .send({ next_review: "2025-04-01" })
            .expect(200);

        expect(res.body.ok).toBe(true);
    });

    it("rejects missing next_review body", async () => {
        const app = createApp(adminAuth);
        const res = await request(app)
            .patch("/compliance/checks/c1")
            .send({})
            .expect(400);

        expect(res.body.code).toBe("bad_request");
    });

    it("returns 404 for non-existent check", async () => {
        mockExecute.mockResolvedValueOnce({ rows: [] });

        const app = createApp(adminAuth);
        const res = await request(app)
            .patch("/compliance/checks/nope")
            .send({ next_review: "2025-04-01" })
            .expect(404);

        expect(res.body.code).toBe("not_found");
    });
});
