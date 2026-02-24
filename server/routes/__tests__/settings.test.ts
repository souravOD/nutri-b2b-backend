/// <reference types="jest" />

/**
 * Unit tests for the settings router (routes/settings.ts)
 *
 * Covers: GET /settings, GET /settings/:key, PUT /settings/:key,
 *         permission enforcement, input validation, edge cases
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
        createDocument: jest.fn().mockResolvedValue({}),
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

// Mock auth module — same pattern as users/vendors tests
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

// Set required env vars before importing router
process.env.APPWRITE_ENDPOINT = "https://test.appwrite.io/v1";
process.env.APPWRITE_PROJECT_ID = "test-project";
process.env.APPWRITE_API_KEY = "test-key";
process.env.APPWRITE_DB_ID = "test-db";
process.env.APPWRITE_VENDOR_SETTINGS_COL = "vendor_settings";

import express from "express";
import request from "supertest";
import settingsRouter from "../settings.js";

// ── Test app setup ───────────────────────────────────────────────

function createApp(auth: any) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.auth = auth;
        next();
    });
    app.use("/settings", settingsRouter);
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

// ── Tests ─────────────────────────────────────────────────────────

describe("Settings Router", () => {
    beforeEach(() => {
        mockExecute.mockReset();
    });

    // ── GET /settings ────────────────────────────────────────────

    describe("GET /settings", () => {
        it("returns all settings for the vendor", async () => {
            mockExecute.mockResolvedValueOnce({
                rows: [
                    { key: "general.platform_name", value: "Acme Platform", updated_by: "user-1", updated_at: "2025-01-01T00:00:00Z" },
                    { key: "notifications.health_alerts", value: true, updated_by: "user-1", updated_at: "2025-01-01T00:00:00Z" },
                ],
            });

            const app = createApp(adminAuth);
            const res = await request(app).get("/settings");

            expect(res.status).toBe(200);
            expect(res.body.settings["general.platform_name"].value).toBe("Acme Platform");
            expect(res.body.settings["notifications.health_alerts"].value).toBe(true);
        });

        it("returns empty settings when none exist", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] });

            const app = createApp(adminAuth);
            const res = await request(app).get("/settings");

            expect(res.status).toBe(200);
            expect(Object.keys(res.body.settings)).toHaveLength(0);
        });

        it("returns 403 for vendor_viewer", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app).get("/settings");
            expect(res.status).toBe(403);
        });

        it("returns 403 for vendor_operator", async () => {
            const app = createApp(operatorAuth);
            const res = await request(app).get("/settings");
            expect(res.status).toBe(403);
        });

        it("allows superadmin", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] });
            const app = createApp(superadminAuth);
            const res = await request(app).get("/settings");
            expect(res.status).toBe(200);
        });
    });

    // ── GET /settings/:key ───────────────────────────────────────

    describe("GET /settings/:key", () => {
        it("returns a single setting", async () => {
            mockExecute.mockResolvedValueOnce({
                rows: [{ key: "general.platform_name", value: "Acme Platform", updated_by: "user-1", updated_at: "2025-06-01T00:00:00Z" }],
            });

            const app = createApp(adminAuth);
            const res = await request(app).get("/settings/general.platform_name");

            expect(res.status).toBe(200);
            expect(res.body.setting.key).toBe("general.platform_name");
            expect(res.body.setting.value).toBe("Acme Platform");
        });

        it("returns 404 for non-existent key", async () => {
            mockExecute.mockResolvedValueOnce({ rows: [] });

            const app = createApp(adminAuth);
            const res = await request(app).get("/settings/nonexistent");
            expect(res.status).toBe(404);
        });

        it("returns 403 for viewer", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app).get("/settings/some.key");
            expect(res.status).toBe(403);
        });
    });

    // ── PUT /settings/:key ───────────────────────────────────────

    describe("PUT /settings/:key", () => {
        it("upserts a setting", async () => {
            mockExecute.mockResolvedValueOnce({
                rows: [{ key: "general.platform_name", value: "New Name", updated_by: "user-admin-id", updated_at: "2025-06-01T00:00:00Z" }],
            });

            const app = createApp(adminAuth);
            const res = await request(app)
                .put("/settings/general.platform_name")
                .send({ value: "New Name" });

            expect(res.status).toBe(200);
            expect(res.body.setting.value).toBe("New Name");
        });

        it("upserts a boolean setting", async () => {
            mockExecute.mockResolvedValueOnce({
                rows: [{ key: "general.maintenance_mode", value: true, updated_by: "user-admin-id", updated_at: "2025-06-01T00:00:00Z" }],
            });

            const app = createApp(adminAuth);
            const res = await request(app)
                .put("/settings/general.maintenance_mode")
                .send({ value: true });

            expect(res.status).toBe(200);
            expect(res.body.setting.value).toBe(true);
        });

        it("upserts an object setting", async () => {
            const objVal = { threshold: 100, enabled: true };
            mockExecute.mockResolvedValueOnce({
                rows: [{ key: "notifications.config", value: objVal, updated_by: "user-admin-id", updated_at: "2025-06-01T00:00:00Z" }],
            });

            const app = createApp(adminAuth);
            const res = await request(app)
                .put("/settings/notifications.config")
                .send({ value: objVal });

            expect(res.status).toBe(200);
            expect(res.body.setting.value.threshold).toBe(100);
        });

        it("returns 400 when value is missing", async () => {
            const app = createApp(adminAuth);
            const res = await request(app)
                .put("/settings/general.platform_name")
                .send({});
            expect(res.status).toBe(400);
        });

        it("returns 400 for invalid key format", async () => {
            const app = createApp(adminAuth);
            const res = await request(app)
                .put("/settings/invalid key!")
                .send({ value: "test" });
            expect(res.status).toBe(400);
        });

        it("returns 403 for viewer", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app)
                .put("/settings/general.platform_name")
                .send({ value: "Nope" });
            expect(res.status).toBe(403);
        });

        it("returns 403 for operator", async () => {
            const app = createApp(operatorAuth);
            const res = await request(app)
                .put("/settings/general.platform_name")
                .send({ value: "Nope" });
            expect(res.status).toBe(403);
        });

        it("allows superadmin to upsert", async () => {
            mockExecute.mockResolvedValueOnce({
                rows: [{ key: "general.platform_name", value: "SA Value", updated_by: "sa-1", updated_at: "2025-06-01T00:00:00Z" }],
            });

            const app = createApp(superadminAuth);
            const res = await request(app)
                .put("/settings/general.platform_name")
                .send({ value: "SA Value" });

            expect(res.status).toBe(200);
            expect(res.body.setting.value).toBe("SA Value");
        });
    });
});
