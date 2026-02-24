/**
 * Tests for the Profile router.
 * Mirrors the patterns in alerts.test.ts — mocks db + auth, uses supertest.
 */
import express from "express";
import request from "supertest";

// ── Mock database ────────────────────────────────────────────────────────────
const mockExecute = jest.fn();
jest.mock("../../lib/database.js", () => ({
    db: { execute: (...args: any[]) => mockExecute(...args) },
}));

// ── Mock auth ────────────────────────────────────────────────────────────────
jest.mock("../../lib/auth.js", () => ({
    requireAuth: (req: any, _res: any, next: any) => next(),
}));

// ── Mock Appwrite ────────────────────────────────────────────────────────────
jest.mock("node-appwrite", () => ({
    Client: jest.fn().mockImplementation(() => ({
        setEndpoint: jest.fn().mockReturnThis(),
        setProject: jest.fn().mockReturnThis(),
        setKey: jest.fn().mockReturnThis(),
    })),
    Users: jest.fn().mockImplementation(() => ({
        get: jest.fn().mockResolvedValue({ name: "Alice Admin" }),
        updateName: jest.fn().mockResolvedValue({}),
    })),
}));

// Set env vars before importing
process.env.APPWRITE_ENDPOINT = "https://cloud.appwrite.io/v1";
process.env.APPWRITE_PROJECT_ID = "test-project";
process.env.APPWRITE_API_KEY = "test-key";

import profileRouter from "../profile.js";

// ── Test helpers ─────────────────────────────────────────────────────────────
function createApp(auth: any) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.auth = auth;
        next();
    });
    app.use("/profile", profileRouter);
    return app;
}

const adminAuth = {
    userId: "aaa-bbb-ccc",
    appwriteUserId: "aw-user-123",
    email: "alice@example.com",
    vendorId: "vnd-111",
    role: "vendor_admin" as const,
    permissions: ["read:vendors", "write:vendors"],
};

beforeEach(() => {
    mockExecute.mockReset();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /profile", () => {
    it("returns merged profile data", async () => {
        mockExecute.mockResolvedValueOnce({
            rows: [
                {
                    id: "aaa-bbb-ccc",
                    appwrite_user_id: "aw-user-123",
                    email: "alice@example.com",
                    display_name: "Alice Admin",
                    phone: "+1555000",
                    country: "US",
                    timezone: "America/New_York",
                    vendor_id: "vnd-111",
                    role: "vendor_admin",
                },
            ],
        });

        const app = createApp(adminAuth);
        const res = await request(app).get("/profile").expect(200);

        expect(res.body.displayName).toBe("Alice Admin");
        expect(res.body.email).toBe("alice@example.com");
        expect(res.body.phone).toBe("+1555000");
        expect(res.body.role).toBe("vendor_admin");
    });

    it("returns 404 if user not found in DB", async () => {
        mockExecute.mockResolvedValueOnce({ rows: [] });

        const app = createApp(adminAuth);
        const res = await request(app).get("/profile").expect(404);
        expect(res.body.code).toBe("not_found");
    });
});

describe("PUT /profile", () => {
    it("updates profile fields", async () => {
        mockExecute
            .mockResolvedValueOnce({
                rows: [
                    {
                        id: "aaa-bbb-ccc",
                        display_name: "Alice Updated",
                        phone: "+1555999",
                        country: "US",
                        timezone: "America/Chicago",
                    },
                ],
            })
            .mockResolvedValueOnce({ rows: [] }); // audit log insert

        const app = createApp(adminAuth);
        const res = await request(app)
            .put("/profile")
            .send({ displayName: "Alice Updated", phone: "+1555999", timezone: "America/Chicago" })
            .expect(200);

        expect(res.body.ok).toBe(true);
        expect(res.body.profile.display_name).toBe("Alice Updated");
    });

    it("rejects displayName too long", async () => {
        const app = createApp(adminAuth);
        const res = await request(app)
            .put("/profile")
            .send({ displayName: "A".repeat(300) })
            .expect(400);

        expect(res.body.code).toBe("bad_request");
    });

    it("rejects phone too long", async () => {
        const app = createApp(adminAuth);
        const res = await request(app)
            .put("/profile")
            .send({ phone: "1".repeat(40) })
            .expect(400);

        expect(res.body.detail).toContain("phone");
    });

    it("rejects country too long", async () => {
        const app = createApp(adminAuth);
        const res = await request(app)
            .put("/profile")
            .send({ country: "ABCDEF" })
            .expect(400);

        expect(res.body.detail).toContain("country");
    });

    it("returns 404 if user not found during update", async () => {
        mockExecute.mockResolvedValueOnce({ rows: [] });

        const app = createApp(adminAuth);
        const res = await request(app)
            .put("/profile")
            .send({ displayName: "Nobody" })
            .expect(404);

        expect(res.body.code).toBe("not_found");
    });
});
