/// <reference types="jest" />

/**
 * Unit tests for the audit log router (routes/audit.ts)
 *
 * Covers: GET /audit (filters, pagination, permission enforcement)
 *
 * NOTE: The write helpers (auditAction, auditRBACChange, etc.) are in
 * server/lib/audit.ts and tested separately.
 */

// ── Mocks ─────────────────────────────────────────────────────────

const mockFrom = jest.fn();
const mockWhere = jest.fn();
const mockOrderBy = jest.fn();
const mockLimit = jest.fn();
const mockOffset = jest.fn();
const mockSelect = jest.fn();

// Chain mock for Drizzle query builder
const chainMock = {
    from: mockFrom,
    where: mockWhere,
    orderBy: mockOrderBy,
    limit: mockLimit,
    offset: mockOffset,
};

// Reset the chain for each call
function setupChain(countResult: any[], dataResult: any[]) {
    // For the count query: db.select({count}).from(auditLog) -> optional .where() -> result
    // For the data query: db.select().from(auditLog) -> optional .where() -> .orderBy() -> .limit() -> .offset() -> result

    let callCount = 0;

    mockSelect.mockImplementation(() => {
        callCount++;
        return { from: mockFrom };
    });

    mockFrom.mockImplementation(() => {
        if (callCount === 1) {
            // count query - may or may not have .where
            return {
                where: jest.fn().mockResolvedValue(countResult),
                then: (resolve: any) => resolve(countResult),
            };
        }
        // data query
        return {
            where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({
                    limit: jest.fn().mockReturnValue({
                        offset: jest.fn().mockResolvedValue(dataResult),
                    }),
                }),
            }),
            orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue({
                    offset: jest.fn().mockResolvedValue(dataResult),
                }),
            }),
        };
    });
}

jest.mock("../../lib/database.js", () => ({
    db: {
        select: (...args: any[]) => mockSelect(...args),
    },
    readDb: { select: jest.fn() },
    primaryPool: { query: jest.fn() },
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
import auditRouter from "../audit.js";

// ── Test app setup ───────────────────────────────────────────────

function createApp(auth: any) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.auth = auth;
        next();
    });
    app.use("/audit", auditRouter);
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

describe("Audit Router", () => {
    beforeEach(() => {
        mockSelect.mockReset();
        mockFrom.mockReset();
    });

    describe("GET /audit", () => {
        it("returns paginated entries", async () => {
            const entries = [
                {
                    id: "entry-1", tableName: "b2b_user_links", recordId: "rec-1",
                    action: "UPDATE", oldValues: { role: "viewer" }, newValues: { role: "admin" },
                    changedBy: "user-1", changedAt: "2025-06-01T00:00:00Z",
                    ipAddress: "1.2.3.4", userAgent: "test-ua",
                },
            ];

            setupChain([{ count: 1 }], entries);

            const app = createApp(adminAuth);
            const res = await request(app).get("/audit");

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(1);
            expect(res.body.limit).toBe(50);
            expect(res.body.offset).toBe(0);
            expect(res.body.entries).toHaveLength(1);
            expect(res.body.entries[0].tableName).toBe("b2b_user_links");
        });

        it("returns empty when no entries", async () => {
            setupChain([{ count: 0 }], []);

            const app = createApp(adminAuth);
            const res = await request(app).get("/audit");

            expect(res.status).toBe(200);
            expect(res.body.entries).toHaveLength(0);
            expect(res.body.total).toBe(0);
        });

        it("returns 403 for vendor_viewer", async () => {
            const app = createApp(viewerAuth);
            const res = await request(app).get("/audit");
            expect(res.status).toBe(403);
        });

        it("returns 403 for vendor_operator", async () => {
            const app = createApp(operatorAuth);
            const res = await request(app).get("/audit");
            expect(res.status).toBe(403);
        });

        it("allows superadmin", async () => {
            setupChain([{ count: 0 }], []);

            const app = createApp(superadminAuth);
            const res = await request(app).get("/audit");
            expect(res.status).toBe(200);
        });

        it("allows vendor_admin with read:audit", async () => {
            setupChain([{ count: 0 }], []);

            const app = createApp(adminAuth);
            const res = await request(app).get("/audit");
            expect(res.status).toBe(200);
        });
    });
});
