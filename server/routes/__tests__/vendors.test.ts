/// <reference types="jest" />

/**
 * Unit tests for the vendors router (routes/vendors.ts)
 *
 * Covers: GET /vendors/:id/stats, PATCH /vendors/:id,
 *         POST /vendors/:id/suspend, POST /vendors/:id/reactivate,
 *         permission enforcement, edge cases
 */

// ── Mocks ─────────────────────────────────────────────────────────

// Mock node-appwrite
jest.mock("node-appwrite", () => {
    const mockClient = {
        setEndpoint: jest.fn().mockReturnThis(),
        setProject: jest.fn().mockReturnThis(),
        setKey: jest.fn().mockReturnThis(),
    };
    const mockDatabases = {
        listDocuments: jest.fn().mockResolvedValue({ documents: [], total: 0 }),
        updateDocument: jest.fn().mockResolvedValue({}),
    };
    return {
        Client: jest.fn(() => mockClient),
        Databases: jest.fn(() => mockDatabases),
        Query: {
            equal: jest.fn((k: string, v: any) => `${k}=${v}`),
            limit: jest.fn((n: number) => `limit=${n}`),
        },
        ID: { unique: jest.fn(() => "mock-id") },
        Account: jest.fn(),
    };
});

// Mock database
const mockExecute = jest.fn();
jest.mock("../../lib/database.js", () => ({
    db: { execute: mockExecute },
    readDb: { execute: jest.fn() },
    primaryPool: { query: jest.fn() },
}));

// Mock auth module — same pattern as users tests
jest.mock("../../lib/auth.js", () => {
    const originalModule = jest.requireActual("../../lib/auth.js") as any;
    return {
        ...originalModule,
        requireAuth: (req: any, _res: any, next: any) => {
            // auth is pre-set by the test helper middleware
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

// Set required env vars before importing router
process.env.APPWRITE_ENDPOINT = "https://test.appwrite.io/v1";
process.env.APPWRITE_PROJECT_ID = "test-project";
process.env.APPWRITE_API_KEY = "test-key";
process.env.APPWRITE_DB_ID = "test-db";
process.env.APPWRITE_VENDORS_COL = "vendors";

import express from "express";
import request from "supertest";
import vendorsRouter from "../vendors.js";

// ── Test app setup ───────────────────────────────────────────────

function createApp(auth: any) {
    const app = express();
    app.use(express.json());
    // Inject auth context before routes
    app.use((req: any, _res, next) => {
        req.auth = auth;
        next();
    });
    app.use("/vendors", vendorsRouter);
    return app;
}

const superadminAuth = {
    userId: "sa-1",
    email: "sa@system.com",
    vendorId: "vendor-system",
    role: "superadmin",
    permissions: ["*"],
};

const vendorAdminAuth = {
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

// ── Mock vendor row ──────────────────────────────────────────────
const mockVendor = {
    id: "vendor-1",
    name: "Acme Corp",
    slug: "acme-corp",
    status: "active",
    catalog_version: 1,
    api_endpoint: null,
    contact_email: "contact@acme.com",
    billing_email: "billing@acme.com",
    team_id: "team-1",
    domains: ["acme.com"],
    owner_user_id: "owner-1",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
};

// ── Tests ─────────────────────────────────────────────────────────

describe("Vendors Router", () => {
    beforeEach(() => {
        mockExecute.mockReset();
    });

    // ── GET /vendors/:vendorId/stats ──────────────────────────────

    describe("GET /vendors/:vendorId/stats", () => {
        it("returns vendor with stats for own vendor", async () => {
            // 1) vendor lookup
            mockExecute.mockResolvedValueOnce({ rows: [mockVendor] });
            // 2-5) parallel count queries
            mockExecute.mockResolvedValueOnce({ rows: [{ count: 42 }] });
            mockExecute.mockResolvedValueOnce({ rows: [{ count: 5 }] });
            mockExecute.mockResolvedValueOnce({ rows: [{ count: 100 }] });
            mockExecute.mockResolvedValueOnce({ rows: [{ last_ingestion: "2025-06-01T12:00:00Z" }] });

            const app = createApp(vendorAdminAuth);
            const res = await request(app).get("/vendors/vendor-1/stats");

            expect(res.status).toBe(200);
            expect(res.body.vendor.name).toBe("Acme Corp");
            expect(res.body.stats.productCount).toBe(42);
            expect(res.body.stats.userCount).toBe(5);
            expect(res.body.stats.customerCount).toBe(100);
        });

        it("returns 403 for vendor_admin viewing another vendor", async () => {
            const app = createApp(vendorAdminAuth);
            const res = await request(app).get("/vendors/vendor-999/stats");

            expect(res.status).toBe(403);
        });

        it("allows superadmin to view any vendor stats", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [mockVendor] });
            mockExecute.mockResolvedValueOnce({ rows: [{ count: 10 }] });
            mockExecute.mockResolvedValueOnce({ rows: [{ count: 2 }] });
            mockExecute.mockResolvedValueOnce({ rows: [{ count: 50 }] });
            mockExecute.mockResolvedValueOnce({ rows: [{ last_ingestion: null }] });

            const app = createApp(superadminAuth);
            const res = await request(app).get("/vendors/vendor-1/stats");

            expect(res.status).toBe(200);
            expect(res.body.vendor.id).toBe("vendor-1");
        });

        it("returns 404 for non-existent vendor", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] });
            const app = createApp(superadminAuth);
            const res = await request(app).get("/vendors/non-existent/stats");
            expect(res.status).toBe(404);
        });

        it("returns 403 for viewer (no read:vendors permission)", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app).get("/vendors/vendor-1/stats");
            expect(res.status).toBe(403);
        });
    });

    // ── PATCH /vendors/:vendorId ──────────────────────────────────

    describe("PATCH /vendors/:vendorId", () => {
        it("updates vendor fields for own vendor", async () => {
            const updatedVendor = {
                ...mockVendor,
                name: "Acme Corp Updated",
                updated_at: "2025-06-01T12:00:00Z",
            };
            mockExecute.mockResolvedValueOnce({ rows: [updatedVendor] });

            const app = createApp(vendorAdminAuth);
            const res = await request(app)
                .patch("/vendors/vendor-1")
                .send({ name: "Acme Corp Updated" });

            expect(res.status).toBe(200);
            expect(res.body.vendor.name).toBe("Acme Corp Updated");
        });

        it("returns 400 if no updatable fields", async () => {
            const app = createApp(vendorAdminAuth);
            const res = await request(app)
                .patch("/vendors/vendor-1")
                .send({});
            expect(res.status).toBe(400);
        });

        it("returns 403 for vendor_admin updating another vendor", async () => {
            const app = createApp(vendorAdminAuth);
            const res = await request(app)
                .patch("/vendors/vendor-999")
                .send({ name: "Hacked" });
            expect(res.status).toBe(403);
        });

        it("returns 404 for non-existent vendor", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] });
            const app = createApp(superadminAuth);
            const res = await request(app)
                .patch("/vendors/non-existent")
                .send({ name: "Ghost" });
            expect(res.status).toBe(404);
        });

        it("allows superadmin to update any vendor", async () => {
            const updatedVendor = {
                ...mockVendor,
                contact_email: "new@acme.com",
            };
            mockExecute.mockResolvedValueOnce({ rows: [updatedVendor] });

            const app = createApp(superadminAuth);
            const res = await request(app)
                .patch("/vendors/vendor-1")
                .send({ contactEmail: "new@acme.com" });

            expect(res.status).toBe(200);
            expect(res.body.vendor.contactEmail).toBe("new@acme.com");
        });

        it("returns 403 for viewer (no write:vendors permission)", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app)
                .patch("/vendors/vendor-1")
                .send({ name: "Nope" });
            expect(res.status).toBe(403);
        });
    });

    // ── POST /vendors/:vendorId/suspend ───────────────────────────

    describe("POST /vendors/:vendorId/suspend", () => {
        it("suspends a vendor (superadmin)", async () => {
            const suspendedVendor = {
                id: "vendor-1",
                name: "Acme Corp",
                slug: "acme-corp",
                status: "suspended",
                updated_at: "2025-06-01T12:00:00Z",
            };
            mockExecute.mockResolvedValueOnce({ rows: [suspendedVendor] });

            const app = createApp(superadminAuth);
            const res = await request(app).post("/vendors/vendor-1/suspend");

            expect(res.status).toBe(200);
            expect(res.body.vendor.status).toBe("suspended");
        });

        it("returns 403 for non-superadmin", async () => {
            const app = createApp(vendorAdminAuth);
            const res = await request(app).post("/vendors/vendor-1/suspend");
            expect(res.status).toBe(403);
        });

        it("prevents suspending own vendor", async () => {
            const app = createApp(superadminAuth);
            const res = await request(app).post("/vendors/vendor-system/suspend");
            expect(res.status).toBe(400);
        });

        it("returns 409 for already suspended vendor", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] }); // UPDATE returns nothing
            mockExecute.mockResolvedValueOnce({ rows: [{ id: "vendor-1", status: "suspended" }] }); // check exists
            const app = createApp(superadminAuth);
            const res = await request(app).post("/vendors/vendor-1/suspend");
            expect(res.status).toBe(409);
        });

        it("returns 404 for non-existent vendor", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] }); // UPDATE returns nothing
            mockExecute.mockResolvedValueOnce({ rows: [] }); // check not found
            const app = createApp(superadminAuth);
            const res = await request(app).post("/vendors/non-existent/suspend");
            expect(res.status).toBe(404);
        });
    });

    // ── POST /vendors/:vendorId/reactivate ────────────────────────

    describe("POST /vendors/:vendorId/reactivate", () => {
        it("reactivates a suspended vendor (superadmin)", async () => {
            const reactivatedVendor = {
                id: "vendor-1",
                name: "Acme Corp",
                slug: "acme-corp",
                status: "active",
                updated_at: "2025-06-01T12:00:00Z",
            };
            mockExecute.mockResolvedValueOnce({ rows: [reactivatedVendor] });

            const app = createApp(superadminAuth);
            const res = await request(app).post("/vendors/vendor-1/reactivate");

            expect(res.status).toBe(200);
            expect(res.body.vendor.status).toBe("active");
        });

        it("returns 403 for non-superadmin", async () => {
            const app = createApp(vendorAdminAuth);
            const res = await request(app).post("/vendors/vendor-1/reactivate");
            expect(res.status).toBe(403);
        });

        it("returns 409 if vendor is not suspended", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] }); // UPDATE returns nothing
            mockExecute.mockResolvedValueOnce({ rows: [{ id: "vendor-1", status: "active" }] }); // check exists
            const app = createApp(superadminAuth);
            const res = await request(app).post("/vendors/vendor-1/reactivate");
            expect(res.status).toBe(409);
        });

        it("returns 404 for non-existent vendor", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] }); // UPDATE returns nothing
            mockExecute.mockResolvedValueOnce({ rows: [] }); // check not found
            const app = createApp(superadminAuth);
            const res = await request(app).post("/vendors/non-existent/reactivate");
            expect(res.status).toBe(404);
        });
    });
});
