/// <reference types="jest" />

/**
 * Unit tests for the users router (routes/users.ts)
 *
 * Covers: GET /users, GET /users/:userId, PATCH /users/:userId/role,
 *         DELETE /users/:userId, permission enforcement
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
    const mockTeams = {
        listMemberships: jest.fn().mockResolvedValue({ memberships: [] }),
        updateMembership: jest.fn().mockResolvedValue({}),
        deleteMembership: jest.fn().mockResolvedValue({}),
    };
    return {
        Client: jest.fn(() => mockClient),
        Databases: jest.fn(() => mockDatabases),
        Teams: jest.fn(() => mockTeams),
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

// Mock auth module — same pattern as invitations tests
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
process.env.APPWRITE_USERPROFILES_COL = "user_profiles";

import express from "express";
import request from "supertest";
import usersRouter from "../users.js";

// ── Test app setup ───────────────────────────────────────────────

function createApp(auth: any) {
    const app = express();
    app.use(express.json());
    // Inject auth context before routes
    app.use((req: any, _res, next) => {
        req.auth = auth;
        next();
    });
    app.use("/users", usersRouter);
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

const superadminAuth = {
    userId: "sa-1",
    email: "sa@system.com",
    vendorId: "vendor-system",
    role: "superadmin",
    permissions: ["*"],
};

// ── Tests ─────────────────────────────────────────────────────────

describe("Users Router", () => {
    beforeEach(() => {
        mockExecute.mockReset();
    });

    // ── GET /users ────────────────────────────────────────────────

    describe("GET /users", () => {
        it("returns users for the vendor", async () => {
            const rows = [
                { id: "u1", email: "a@v.com", display_name: "Alice", role: "vendor_admin", status: "active" },
                { id: "u2", email: "b@v.com", display_name: "Bob", role: "vendor_viewer", status: "active" },
            ];
            mockExecute.mockResolvedValueOnce({ rows });

            const app = createApp(adminAuth);
            const res = await request(app).get("/users");

            expect(res.status).toBe(200);
            expect(res.body.users).toHaveLength(2);
            expect(res.body.users[0].email).toBe("a@v.com");
        });

        it("returns 403 for vendor_viewer", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app).get("/users");
            expect(res.status).toBe(403);
        });

        it("allows superadmin to query any vendor", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] });
            const app = createApp(superadminAuth);
            const res = await request(app).get("/users?vendor_id=vendor-99");
            expect(res.status).toBe(200);
        });
    });

    // ── GET /users/:userId ────────────────────────────────────────

    describe("GET /users/:userId", () => {
        it("returns a single user detail", async () => {
            const mockUser = {
                id: "u1", email: "a@v.com", display_name: "Alice",
                role: "vendor_admin", status: "active", vendor_id: "vendor-1",
            };
            mockExecute.mockResolvedValueOnce({ rows: [mockUser] });

            const app = createApp(adminAuth);
            const res = await request(app).get("/users/u1");

            expect(res.status).toBe(200);
            expect(res.body.user.email).toBe("a@v.com");
        });

        it("returns 404 for non-existent user", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] });
            const app = createApp(adminAuth);
            const res = await request(app).get("/users/non-existent");
            expect(res.status).toBe(404);
        });
    });

    // ── PATCH /users/:userId/role ─────────────────────────────────

    describe("PATCH /users/:userId/role", () => {
        it("changes user role successfully", async () => {
            // check query
            mockExecute.mockResolvedValueOnce({
                rows: [{ id: "link-1", appwrite_user_id: "aw-u1" }],
            });
            // update b2b_user_links
            mockExecute.mockResolvedValueOnce({ rows: [] });

            const app = createApp(adminAuth);
            const res = await request(app)
                .patch("/users/u1/role")
                .send({ role: "vendor_operator" });

            expect(res.status).toBe(200);
            expect(res.body.role).toBe("vendor_operator");
            expect(res.body.updated).toBe(true);
        });

        it("rejects invalid role", async () => {
            const app = createApp(adminAuth);
            const res = await request(app)
                .patch("/users/u1/role")
                .send({ role: "superadmin" });
            expect(res.status).toBe(400);
        });

        it("prevents self role change", async () => {
            const app = createApp(adminAuth);
            const res = await request(app)
                .patch("/users/user-admin-id/role")
                .send({ role: "vendor_viewer" });

            expect(res.status).toBe(400);
            expect(res.body.detail).toContain("own role");
        });

        it("returns 404 for non-existent user", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] });
            const app = createApp(adminAuth);
            const res = await request(app)
                .patch("/users/non-existent/role")
                .send({ role: "vendor_viewer" });
            expect(res.status).toBe(404);
        });

        it("returns 403 for vendor_viewer", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app)
                .patch("/users/u1/role")
                .send({ role: "vendor_operator" });
            expect(res.status).toBe(403);
        });
    });

    // ── DELETE /users/:userId ─────────────────────────────────────

    describe("DELETE /users/:userId", () => {
        it("deactivates a user", async () => {
            // check query
            mockExecute.mockResolvedValueOnce({
                rows: [{ id: "link-1", appwrite_user_id: "aw-u1" }],
            });
            // soft-deactivate
            mockExecute.mockResolvedValueOnce({ rows: [] });

            const app = createApp(adminAuth);
            const res = await request(app).delete("/users/u1");

            expect(res.status).toBe(200);
            expect(res.body.deactivated).toBe(true);
        });

        it("prevents self-deactivation", async () => {
            const app = createApp(adminAuth);
            const res = await request(app).delete("/users/user-admin-id");

            expect(res.status).toBe(400);
            expect(res.body.detail).toContain("yourself");
        });

        it("returns 404 for non-existent user", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] });
            const app = createApp(adminAuth);
            const res = await request(app).delete("/users/non-existent");
            expect(res.status).toBe(404);
        });

        it("returns 403 for vendor_viewer", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app).delete("/users/u1");
            expect(res.status).toBe(403);
        });
    });
});
