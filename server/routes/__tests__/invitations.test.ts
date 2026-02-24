/// <reference types="jest" />

/**
 * Unit tests for the invitations router.
 *
 * Strategy: test the route handler logic in isolation by importing the router
 * and exercising it via supertest against an Express app with mocked auth.
 */

// ── Mocks ────────────────────────────────────────────────────────

// Mock node-appwrite
jest.mock("node-appwrite", () => {
    const mockClient = {
        setEndpoint: jest.fn().mockReturnThis(),
        setProject: jest.fn().mockReturnThis(),
        setKey: jest.fn().mockReturnThis(),
        setJWT: jest.fn().mockReturnThis(),
    };
    const mockDatabases = {
        createDocument: jest.fn().mockResolvedValue({ $id: "aw-doc-123" }),
        updateDocument: jest.fn().mockResolvedValue({}),
        deleteDocument: jest.fn().mockResolvedValue({}),
    };
    return {
        Client: jest.fn(() => mockClient),
        Databases: jest.fn(() => mockDatabases),
        ID: { unique: jest.fn().mockReturnValue("aw-unique-id") },
        Query: { equal: jest.fn(), limit: jest.fn() },
        Account: jest.fn(),
        Teams: jest.fn(),
    };
});

// Mock database
const mockExecute = jest.fn();
jest.mock("../../lib/database.js", () => ({
    db: { execute: mockExecute },
    readDb: { execute: jest.fn() },
    primaryPool: { query: jest.fn() },
}));

// Mock auth module — provide computePermissions and stub requireAuth / middleware
jest.mock("../../lib/auth.js", () => {
    const originalModule = jest.requireActual("../../lib/auth.js") as any;
    return {
        ...originalModule,
        // requireAuth just sets req.auth from test-injected value
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
process.env.APPWRITE_INVITATIONS_COL = "inv-col";

import express from "express";
import request from "supertest";
import invitationsRouter from "../../routes/invitations.js";

// ── Test app setup ───────────────────────────────────────────────

function createApp(auth: any) {
    const app = express();
    app.use(express.json());
    // Inject auth context before routes
    app.use((req: any, _res, next) => {
        req.auth = auth;
        next();
    });
    app.use("/invitations", invitationsRouter);
    return app;
}

const adminAuth = {
    userId: "user-1",
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
    userId: "user-2",
    email: "viewer@acme.com",
    vendorId: "vendor-1",
    role: "vendor_viewer",
    permissions: ["read:products", "read:customers", "read:matches"],
};

const superadminAuth = {
    userId: "sa-1",
    email: "sa@system.com",
    vendorId: null,
    role: "superadmin",
    permissions: ["*"],
};

// ── Tests ────────────────────────────────────────────────────────

describe("Invitations Router", () => {
    beforeEach(() => {
        mockExecute.mockReset();
    });

    // ── GET /invitations ──────────────────────────────────────────

    describe("GET /invitations", () => {
        it("returns invitation list for vendor_admin", async () => {
            const rows = [
                { id: "inv-1", email: "new@acme.com", role: "vendor_viewer", status: "pending" },
                { id: "inv-2", email: "old@acme.com", role: "vendor_operator", status: "accepted" },
            ];
            mockExecute.mockResolvedValueOnce({ rows });

            const app = createApp(adminAuth);
            const res = await request(app).get("/invitations");

            expect(res.status).toBe(200);
            expect(res.body.invitations).toHaveLength(2);
            expect(res.body.invitations[0].email).toBe("new@acme.com");
        });

        it("returns 403 for vendor_viewer", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app).get("/invitations");

            expect(res.status).toBe(403);
        });

        it("allows superadmin to query any vendor", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] });

            const app = createApp(superadminAuth);
            const res = await request(app).get("/invitations?vendor_id=vendor-99");

            expect(res.status).toBe(200);
        });
    });

    // ── POST /invitations ─────────────────────────────────────────

    describe("POST /invitations", () => {
        it("creates an invitation successfully", async () => {
            // No existing pending invitation
            mockExecute.mockResolvedValueOnce({ rows: [] });
            // INSERT
            mockExecute.mockResolvedValueOnce({ rows: [] });
            // UPDATE appwrite_doc_id
            mockExecute.mockResolvedValueOnce({ rows: [] });

            const app = createApp(adminAuth);
            const res = await request(app)
                .post("/invitations")
                .send({ email: "newuser@acme.com", role: "vendor_operator", message: "Welcome!" });

            expect(res.status).toBe(201);
            expect(res.body.email).toBe("newuser@acme.com");
            expect(res.body.role).toBe("vendor_operator");
            expect(res.body.status).toBe("pending");
            expect(res.body.token).toBeTruthy();
            expect(res.body.appwrite_doc_id).toBe("aw-doc-123");
        });

        it("rejects missing email", async () => {
            const app = createApp(adminAuth);
            const res = await request(app)
                .post("/invitations")
                .send({ role: "vendor_viewer" });

            expect(res.status).toBe(400);
            expect(res.body.detail).toContain("email");
        });

        it("rejects invalid role", async () => {
            const app = createApp(adminAuth);
            const res = await request(app)
                .post("/invitations")
                .send({ email: "test@acme.com", role: "superadmin" });

            expect(res.status).toBe(400);
            expect(res.body.detail).toContain("Invalid role");
        });

        it("rejects duplicate pending invitation", async () => {
            // Existing pending found
            mockExecute.mockResolvedValueOnce({ rows: [{ id: "existing-1" }] });

            const app = createApp(adminAuth);
            const res = await request(app)
                .post("/invitations")
                .send({ email: "exists@acme.com" });

            expect(res.status).toBe(409);
        });

        it("returns 403 for vendor_viewer", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app)
                .post("/invitations")
                .send({ email: "test@acme.com" });

            expect(res.status).toBe(403);
        });

        it("defaults role to vendor_viewer if not specified", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] });
            mockExecute.mockResolvedValueOnce({ rows: [] });
            mockExecute.mockResolvedValueOnce({ rows: [] });

            const app = createApp(adminAuth);
            const res = await request(app)
                .post("/invitations")
                .send({ email: "defaultrole@acme.com" });

            expect(res.status).toBe(201);
            expect(res.body.role).toBe("vendor_viewer");
        });
    });

    // ── PATCH /invitations/:id ────────────────────────────────────

    describe("PATCH /invitations/:id", () => {
        it("revokes a pending invitation", async () => {
            mockExecute.mockResolvedValueOnce({
                rows: [{ id: "inv-1", appwrite_doc_id: "aw-doc-1" }],
            });
            mockExecute.mockResolvedValueOnce({ rows: [] });

            const app = createApp(adminAuth);
            const res = await request(app)
                .patch("/invitations/inv-1")
                .send({ status: "revoked" });

            expect(res.status).toBe(200);
            expect(res.body.status).toBe("revoked");
        });

        it("rejects non-revoked status", async () => {
            const app = createApp(adminAuth);
            const res = await request(app)
                .patch("/invitations/inv-1")
                .send({ status: "accepted" });

            expect(res.status).toBe(400);
        });

        it("returns 404 for non-existent invitation", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] });

            const app = createApp(adminAuth);
            const res = await request(app)
                .patch("/invitations/nonexistent")
                .send({ status: "revoked" });

            expect(res.status).toBe(404);
        });
    });

    // ── DELETE /invitations/:id ───────────────────────────────────

    describe("DELETE /invitations/:id", () => {
        it("deletes an invitation", async () => {
            mockExecute.mockResolvedValueOnce({
                rows: [{ id: "inv-1", appwrite_doc_id: "aw-doc-1" }],
            });
            mockExecute.mockResolvedValueOnce({ rows: [] });

            const app = createApp(adminAuth);
            const res = await request(app).delete("/invitations/inv-1");

            expect(res.status).toBe(200);
            expect(res.body.deleted).toBe(true);
        });

        it("returns 404 for non-existent invitation", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] });

            const app = createApp(adminAuth);
            const res = await request(app).delete("/invitations/nonexistent");

            expect(res.status).toBe(404);
        });

        it("returns 403 for vendor_viewer", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app).delete("/invitations/inv-1");

            expect(res.status).toBe(403);
        });
    });
});
