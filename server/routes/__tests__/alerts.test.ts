/**
 * Tests for the Alerts router.
 * Mirrors the patterns in settings.test.ts — mocks db + auth, uses supertest.
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
    requirePermissionMiddleware: (..._perms: string[]) =>
        (req: any, _res: any, next: any) => {
            // If no auth injected, reject
            if (!req.auth) {
                return _res.status(403).json({ code: "permission_denied" });
            }
            next();
        },
}));

import alertsRouter, { insertAlert } from "../alerts.js";

// ── Test helpers ─────────────────────────────────────────────────────────────
function createApp(auth: any) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.auth = auth;
        next();
    });
    app.use("/alerts", alertsRouter);
    return app;
}

const VENDOR_ID = "aaaa-bbbb-cccc-dddd";
const OTHER_VENDOR_ID = "zzzz-yyyy-xxxx-wwww";

const adminAuth = {
    userId: "user-1",
    appwriteUserId: "aw-1",
    email: "admin@example.com",
    vendorId: VENDOR_ID,
    role: "vendor_admin" as const,
    permissions: [
        "read:vendors",
        "write:vendors",
        "read:products",
        "write:products",
        "manage:users",
        "manage:api_keys",
        "manage:settings",
    ],
};

const viewerAuth = {
    ...adminAuth,
    userId: "user-2",
    role: "vendor_viewer" as const,
    permissions: ["read:products", "read:customers"],
};

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
    mockExecute.mockReset();
});

describe("GET /alerts", () => {
    it("returns paginated alerts for the vendor", async () => {
        const mockAlerts = [
            { id: "a1", vendor_id: VENDOR_ID, type: "quality", priority: "high", title: "Test", status: "unread" },
        ];
        // First call = count, second call = rows
        mockExecute
            .mockResolvedValueOnce({ rows: [{ total: 1 }] })
            .mockResolvedValueOnce({ rows: mockAlerts });

        const app = createApp(adminAuth);
        const res = await request(app).get("/alerts").expect(200);

        expect(res.body.data).toEqual(mockAlerts);
        expect(res.body.total).toBe(1);
        expect(res.body.page).toBe(1);
    });

    it("rejects invalid type filter", async () => {
        const app = createApp(adminAuth);
        const res = await request(app).get("/alerts?type=bogus").expect(400);
        expect(res.body.code).toBe("bad_request");
    });

    it("rejects invalid priority filter", async () => {
        const app = createApp(adminAuth);
        const res = await request(app).get("/alerts?priority=extreme").expect(400);
        expect(res.body.code).toBe("bad_request");
    });

    it("rejects invalid status filter", async () => {
        const app = createApp(adminAuth);
        const res = await request(app).get("/alerts?status=pending").expect(400);
        expect(res.body.code).toBe("bad_request");
    });

    it("returns 403 when auth is missing", async () => {
        const app = createApp(null); // no auth injected
        const res = await request(app).get("/alerts").expect(403);
        expect(res.body.code).toBe("permission_denied");
    });
});

describe("GET /alerts/summary", () => {
    it("returns correct aggregate counts", async () => {
        mockExecute.mockResolvedValueOnce({
            rows: [{ total: 10, unread: 5, high_priority: 3, high_priority_unread: 2 }],
        });

        const app = createApp(adminAuth);
        const res = await request(app).get("/alerts/summary").expect(200);

        expect(res.body).toEqual({
            total: 10,
            unread: 5,
            highPriority: 3,
            highPriorityUnread: 2,
        });
    });

    it("returns zeros when no alerts exist", async () => {
        mockExecute.mockResolvedValueOnce({
            rows: [{ total: 0, unread: 0, high_priority: 0, high_priority_unread: 0 }],
        });

        const app = createApp(adminAuth);
        const res = await request(app).get("/alerts/summary").expect(200);
        expect(res.body.total).toBe(0);
    });
});

describe("PATCH /alerts/:id", () => {
    it("marks an alert as read", async () => {
        mockExecute.mockResolvedValueOnce({
            rows: [{ id: "a1", status: "read", read_at: new Date().toISOString() }],
        });

        const app = createApp(adminAuth);
        const res = await request(app)
            .patch("/alerts/a1")
            .send({ status: "read" })
            .expect(200);

        expect(res.body.ok).toBe(true);
        expect(res.body.alert.status).toBe("read");
    });

    it("marks an alert as dismissed", async () => {
        mockExecute.mockResolvedValueOnce({
            rows: [{ id: "a1", status: "dismissed", read_at: new Date().toISOString() }],
        });

        const app = createApp(adminAuth);
        const res = await request(app)
            .patch("/alerts/a1")
            .send({ status: "dismissed" })
            .expect(200);

        expect(res.body.alert.status).toBe("dismissed");
    });

    it("rejects invalid status value", async () => {
        const app = createApp(adminAuth);
        const res = await request(app)
            .patch("/alerts/a1")
            .send({ status: "unread" })
            .expect(400);

        expect(res.body.code).toBe("bad_request");
    });

    it("rejects missing status body", async () => {
        const app = createApp(adminAuth);
        const res = await request(app)
            .patch("/alerts/a1")
            .send({})
            .expect(400);

        expect(res.body.code).toBe("bad_request");
    });

    it("returns 404 for non-existent or cross-vendor alert", async () => {
        mockExecute.mockResolvedValueOnce({ rows: [] }); // no rows returned

        const app = createApp(adminAuth);
        const res = await request(app)
            .patch("/alerts/nonexistent-id")
            .send({ status: "read" })
            .expect(404);

        expect(res.body.code).toBe("not_found");
    });
});

describe("insertAlert (helper)", () => {
    it("inserts an alert and returns the id", async () => {
        mockExecute.mockResolvedValueOnce({ rows: [{ id: "new-alert-1" }] });

        const result = await insertAlert({
            vendorId: VENDOR_ID,
            type: "quality",
            priority: "high",
            title: "Test alert",
            description: "Test description",
            sourceTable: "products",
            sourceId: "prod-1",
        });

        expect(result).toEqual({ id: "new-alert-1" });
        expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("returns null on DB error (non-fatal)", async () => {
        mockExecute.mockRejectedValueOnce(new Error("DB down"));

        const result = await insertAlert({
            vendorId: VENDOR_ID,
            type: "system",
            title: "Should not throw",
        });

        expect(result).toBeNull();
    });
});
