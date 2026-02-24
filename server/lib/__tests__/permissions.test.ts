/// <reference types="jest" />

// Mock node-appwrite (imported at module scope by auth.ts)
jest.mock("node-appwrite", () => {
    const mockClient = {
        setEndpoint: jest.fn().mockReturnThis(),
        setProject: jest.fn().mockReturnThis(),
        setJWT: jest.fn().mockReturnThis(),
        setKey: jest.fn().mockReturnThis(),
    };
    return {
        Client: jest.fn(() => mockClient),
        Account: jest.fn(() => ({ get: jest.fn() })),
        Databases: jest.fn(),
        Query: { equal: jest.fn(), limit: jest.fn() },
        Teams: jest.fn(),
    };
});

// Mock database to avoid real connections
jest.mock("../database.js", () => ({
    db: { execute: jest.fn() },
    readDb: { execute: jest.fn() },
    primaryPool: { query: jest.fn() },
}));

import {
    computePermissions,
    hasPermission,
    requirePermission,
    requireRole,
    requirePermissionMiddleware,
    type AuthContext,
} from "../auth.js";

// ─── computePermissions ─────────────────────────────────────────────

describe("computePermissions", () => {
    it("gives superadmin the wildcard", () => {
        const perms = computePermissions("superadmin");
        expect(perms).toEqual(["*"]);
    });

    it("gives vendor_admin 13 explicit permissions including manage:*", () => {
        const perms = computePermissions("vendor_admin");
        expect(perms).toContain("manage:users");
        expect(perms).toContain("manage:api_keys");
        expect(perms).toContain("manage:settings");
        expect(perms).toContain("read:audit");
        expect(perms).toContain("read:vendors");
        expect(perms).toContain("write:vendors");
        expect(perms).toHaveLength(13);
    });

    it("gives vendor_operator 7 read/write permissions, no manage:*", () => {
        const perms = computePermissions("vendor_operator");
        expect(perms).toContain("read:products");
        expect(perms).toContain("write:products");
        expect(perms).toContain("read:ingest");
        expect(perms).not.toContain("manage:users");
        expect(perms).not.toContain("read:audit");
        expect(perms).not.toContain("read:vendors");
        expect(perms).toHaveLength(7);
    });

    it("gives vendor_viewer only 3 read permissions", () => {
        const perms = computePermissions("vendor_viewer");
        expect(perms).toEqual(["read:products", "read:customers", "read:matches"]);
    });
});

// ─── hasPermission ──────────────────────────────────────────────────

describe("hasPermission", () => {
    const ctx = (role: AuthContext["role"]): AuthContext => ({
        userId: "u1",
        appwriteUserId: "u1",
        email: "a@b.com",
        vendorId: "v1",
        role,
        permissions: computePermissions(role),
    });

    it("superadmin has any permission via wildcard", () => {
        expect(hasPermission(ctx("superadmin"), "manage:users")).toBe(true);
        expect(hasPermission(ctx("superadmin"), "nonexistent:perm")).toBe(true);
    });

    it("vendor_admin has manage:users", () => {
        expect(hasPermission(ctx("vendor_admin"), "manage:users")).toBe(true);
    });

    it("vendor_operator lacks manage:users", () => {
        expect(hasPermission(ctx("vendor_operator"), "manage:users")).toBe(false);
    });

    it("vendor_viewer lacks write:products", () => {
        expect(hasPermission(ctx("vendor_viewer"), "write:products")).toBe(false);
    });

    it("vendor_viewer has read:products", () => {
        expect(hasPermission(ctx("vendor_viewer"), "read:products")).toBe(true);
    });
});

// ─── requirePermission (throw-based) ────────────────────────────────

describe("requirePermission", () => {
    const ctx = (role: AuthContext["role"]): AuthContext => ({
        userId: "u1", appwriteUserId: "u1", email: "a@b.com", vendorId: "v1",
        role, permissions: computePermissions(role),
    });

    it("does not throw for superadmin", () => {
        expect(() => requirePermission(ctx("superadmin"), "manage:users")).not.toThrow();
    });

    it("throws for vendor_viewer trying manage:users", () => {
        expect(() => requirePermission(ctx("vendor_viewer"), "manage:users")).toThrow("Permission denied");
    });
});

// ─── requireRole ────────────────────────────────────────────────────

describe("requireRole", () => {
    const ctx = (role: AuthContext["role"]): AuthContext => ({
        userId: "u1", appwriteUserId: "u1", email: "a@b.com", vendorId: "v1",
        role, permissions: computePermissions(role),
    });

    it("superadmin passes any role check", () => {
        expect(() => requireRole(ctx("superadmin"), "vendor_admin")).not.toThrow();
    });

    it("vendor_admin passes when allowed", () => {
        expect(() => requireRole(ctx("vendor_admin"), "vendor_admin", "vendor_operator")).not.toThrow();
    });

    it("vendor_viewer fails when not in allowed list", () => {
        expect(() => requireRole(ctx("vendor_viewer"), "vendor_admin")).toThrow("Role not authorized");
    });
});

// ─── requirePermissionMiddleware ────────────────────────────────────

describe("requirePermissionMiddleware", () => {
    const mockRes = () => {
        const res: any = {};
        res.status = jest.fn().mockReturnValue(res);
        res.json = jest.fn().mockReturnValue(res);
        return res;
    };
    const mockNext = jest.fn();

    beforeEach(() => {
        mockNext.mockClear();
    });

    it("calls next() when permissions are satisfied", () => {
        const req: any = {
            auth: {
                userId: "u1", email: "a@b.com", vendorId: "v1",
                role: "vendor_admin",
                permissions: computePermissions("vendor_admin"),
            },
        };
        const res = mockRes();
        requirePermissionMiddleware("manage:users")(req, res, mockNext);
        expect(mockNext).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    it("returns 403 when permissions are missing", () => {
        const req: any = {
            auth: {
                userId: "u1", email: "a@b.com", vendorId: "v1",
                role: "vendor_viewer",
                permissions: computePermissions("vendor_viewer"),
            },
        };
        const res = mockRes();
        requirePermissionMiddleware("manage:users")(req, res, mockNext);
        expect(mockNext).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ code: "permission_denied" })
        );
    });

    it("passes superadmin for any permission via wildcard", () => {
        const req: any = {
            auth: {
                userId: "u1", email: "a@b.com", vendorId: "v1",
                role: "superadmin",
                permissions: ["*"],
            },
        };
        const res = mockRes();
        requirePermissionMiddleware("manage:users", "manage:settings")(req, res, mockNext);
        expect(mockNext).toHaveBeenCalled();
    });

    it("returns 401 when no auth context is present", () => {
        const req: any = {};
        const res = mockRes();
        requirePermissionMiddleware("manage:users")(req, res, mockNext);
        expect(mockNext).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
    });

    it("requires ALL listed permissions", () => {
        const req: any = {
            auth: {
                userId: "u1", email: "a@b.com", vendorId: "v1",
                role: "vendor_operator",
                permissions: computePermissions("vendor_operator"),
            },
        };
        const res = mockRes();
        // operator has read:products but not manage:users
        requirePermissionMiddleware("read:products", "manage:users")(req, res, mockNext);
        expect(mockNext).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });
});
