import { Router, type Request, type Response } from "express";
import { requireAuth, requirePermissionMiddleware, requireRoleMiddleware, type AuthContext } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";
import { Client, Databases, Query, Teams } from "node-appwrite";

const router = Router();

// ── Appwrite admin helpers ────────────────────────────────────────
function mustEnv(key: string): string {
    const v = process.env[key];
    if (!v) throw new Error(`Missing env var: ${key}`);
    return v;
}

function createAdminClient(): Client {
    return new Client()
        .setEndpoint(mustEnv("APPWRITE_ENDPOINT"))
        .setProject(mustEnv("APPWRITE_PROJECT_ID"))
        .setKey(mustEnv("APPWRITE_API_KEY"));
}

function adminDatabases() {
    return new Databases(createAdminClient());
}

function adminTeams() {
    return new Teams(createAdminClient());
}

function getDbId() {
    return mustEnv("APPWRITE_DB_ID");
}

function getUserProfilesCol() {
    return process.env.APPWRITE_USERPROFILES_COL || "";
}

// ── Helpers ───────────────────────────────────────────────────────
function problem(res: Response, status: number, detail: string) {
    return res.status(status).json({
        type: "about:blank",
        title: status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Error",
        status,
        detail,
    });
}

/**
 * Map a B2B platform role to the corresponding Appwrite Team role.
 * Appwrite teams use: "owner", "admin", "member" (custom roles also possible).
 */
function toTeamRole(role: string): string {
    switch (role) {
        case "vendor_admin": return "admin";
        case "vendor_operator": return "member";   // operator = team member
        case "vendor_viewer": return "member";      // viewer = team member
        default: return "member";
    }
}

// ── Resolve vendor scope ─────────────────────────────────────────
function resolveVendorScope(auth: AuthContext, queryVendorId?: string): string | null {
    if (auth.role === "superadmin") {
        return queryVendorId ? String(queryVendorId) : null; // null = all vendors
    }
    return auth.vendorId;
}

// ── GET /users ──────────────────────────────────────────────────
// List users for the current vendor (or specified vendor for superadmin)
router.get(
    "/",
    requireAuth as any,
    requirePermissionMiddleware("manage:users") as any,
    async (req: Request, res: Response) => {
        try {
            const auth: AuthContext = (req as any).auth;
            const vendorId = resolveVendorScope(auth, req.query.vendor_id as string);

            let result;
            if (vendorId) {
                result = await db.execute(sql`
                    SELECT
                        u.id,
                        u.email,
                        u.display_name,
                        u.appwrite_user_id,
                        ul.role,
                        ul.status,
                        ul.vendor_id,
                        ul.created_at,
                        ul.updated_at
                    FROM gold.b2b_user_links ul
                    JOIN gold.b2b_users u ON u.id = ul.user_id
                    WHERE ul.vendor_id = ${vendorId}::uuid
                    ORDER BY ul.created_at DESC
                    LIMIT 200
                `);
            } else {
                // Superadmin with no vendor filter: show all users
                result = await db.execute(sql`
                    SELECT
                        u.id,
                        u.email,
                        u.display_name,
                        u.appwrite_user_id,
                        ul.role,
                        ul.status,
                        ul.vendor_id,
                        ul.created_at,
                        ul.updated_at
                    FROM gold.b2b_user_links ul
                    JOIN gold.b2b_users u ON u.id = ul.user_id
                    ORDER BY ul.created_at DESC
                    LIMIT 200
                `);
            }

            const data = (result.rows || []).map((r: any) => ({
                userId: r.id,
                email: r.email,
                displayName: r.display_name,
                role: r.role,
                status: r.status,
                linkedAt: r.created_at,
            }));

            return res.json({ data });
        } catch (err: any) {
            console.error("[GET /users]", err);
            return problem(res, 500, err?.message || "Failed to list users");
        }
    }
);

// ── GET /users/:userId ──────────────────────────────────────────
// Get user detail (includes link info for the scoped vendor)
router.get(
    "/:userId",
    requireAuth as any,
    requirePermissionMiddleware("manage:users") as any,
    async (req: Request, res: Response) => {
        try {
            const auth: AuthContext = (req as any).auth;
            const vendorId = resolveVendorScope(auth, req.query.vendor_id as string);
            const { userId } = req.params;

            let result;
            if (vendorId) {
                result = await db.execute(sql`
                    SELECT
                        u.id,
                        u.email,
                        u.display_name,
                        u.appwrite_user_id,
                        ul.role,
                        ul.status,
                        ul.vendor_id,
                        ul.created_at,
                        ul.updated_at
                    FROM gold.b2b_user_links ul
                    JOIN gold.b2b_users u ON u.id = ul.user_id
                    WHERE u.id = ${userId}::uuid
                      AND ul.vendor_id = ${vendorId}::uuid
                    LIMIT 1
                `);
            } else {
                // Superadmin without vendor filter — find any link for this user
                result = await db.execute(sql`
                    SELECT
                        u.id,
                        u.email,
                        u.display_name,
                        u.appwrite_user_id,
                        ul.role,
                        ul.status,
                        ul.vendor_id,
                        ul.created_at,
                        ul.updated_at
                    FROM gold.b2b_user_links ul
                    JOIN gold.b2b_users u ON u.id = ul.user_id
                    WHERE u.id = ${userId}::uuid
                    LIMIT 1
                `);
            }

            if ((result.rows?.length || 0) === 0) {
                return problem(res, 404, "User not found");
            }

            return res.json({ user: result.rows![0] });
        } catch (err: any) {
            console.error("[GET /users/:userId]", err);
            return problem(res, 500, err?.message || "Failed to get user");
        }
    }
);

// ── PATCH /users/:userId/role ───────────────────────────────────
// Change user role (dual-write: Supabase b2b_user_links + Appwrite user_profiles + team membership)
router.patch(
    "/:userId/role",
    requireAuth as any,
    requirePermissionMiddleware("manage:users") as any,
    async (req: Request, res: Response) => {
        try {
            const auth: AuthContext = (req as any).auth;
            const { userId } = req.params;
            const { role } = req.body;

            // Validate role
            const validRoles = ["vendor_admin", "vendor_operator", "vendor_viewer"];
            if (!role || !validRoles.includes(role)) {
                return problem(res, 400, `Invalid role. Must be one of: ${validRoles.join(", ")}`);
            }

            // Cannot change own role
            if (userId === auth.userId) {
                return problem(res, 400, "Cannot change your own role");
            }

            const vendorId = resolveVendorScope(auth, req.query.vendor_id as string);

            // Verify user exists in this vendor
            const check = await db.execute(sql`
                SELECT ul.id, u.appwrite_user_id
                FROM gold.b2b_user_links ul
                JOIN gold.b2b_users u ON u.id = ul.user_id
                WHERE u.id = ${userId}::uuid
                  AND ul.vendor_id = ${vendorId}::uuid
                  AND ul.status = 'active'
                LIMIT 1
            `);

            if ((check.rows?.length || 0) === 0) {
                return problem(res, 404, "User not found or inactive in this vendor");
            }

            const row: any = check.rows![0];

            // Prevent non-superadmin from editing superadmin users
            if (auth.role !== "superadmin") {
                const targetLink = await db.execute(sql`
                    SELECT role FROM gold.b2b_user_links
                    WHERE user_id = ${userId}::uuid
                      AND vendor_id = ${vendorId}::uuid
                    LIMIT 1
                `);
                const targetRole = (targetLink.rows?.[0] as any)?.role;
                if (targetRole === "superadmin") {
                    return problem(res, 403, "Only a superadmin can change another superadmin's role");
                }
            }

            // 1) Update Supabase b2b_user_links
            await db.execute(sql`
                UPDATE gold.b2b_user_links
                SET role = ${role}, updated_at = now()
                WHERE user_id = ${userId}::uuid
                  AND vendor_id = ${vendorId}::uuid
            `);

            // 2) Dual-write: Update Appwrite user_profiles document (non-fatal)
            const profilesCol = getUserProfilesCol();
            if (row.appwrite_user_id && profilesCol) {
                try {
                    const adb = adminDatabases();
                    // Find the user's profile document by appwrite_user_id
                    const docs = await adb.listDocuments(getDbId(), profilesCol, [
                        Query.equal("user_id", row.appwrite_user_id),
                        Query.limit(1),
                    ]);
                    if (docs.documents.length > 0) {
                        await adb.updateDocument(getDbId(), profilesCol, docs.documents[0].$id, {
                            role,
                        });
                    }
                } catch (awErr: any) {
                    console.warn("[PATCH /users/:userId/role] Appwrite profile update skipped:", awErr?.message);
                }
            }

            // 3) Dual-write: Update Appwrite Team membership role (non-fatal)
            // Look up the vendor's team_id so we can update membership
            if (row.appwrite_user_id) {
                try {
                    const vendorResult = await db.execute(sql`
                        SELECT team_id FROM gold.vendors
                        WHERE id = ${vendorId}::uuid
                        LIMIT 1
                    `);
                    const teamId = (vendorResult.rows?.[0] as any)?.team_id;
                    if (teamId) {
                        const teams = adminTeams();
                        // List memberships in the team, find the user's membership
                        const memberships = await teams.listMemberships(teamId, [
                            Query.equal("userId", row.appwrite_user_id),
                            Query.limit(1),
                        ]);
                        if (memberships.memberships.length > 0) {
                            const membershipId = memberships.memberships[0].$id;
                            await teams.updateMembership(teamId, membershipId, [toTeamRole(role)]);
                        }
                    }
                } catch (awErr: any) {
                    console.warn("[PATCH /users/:userId/role] Appwrite team role update skipped:", awErr?.message);
                }
            }

            return res.json({ userId, role, updated: true });
        } catch (err: any) {
            console.error("[PATCH /users/:userId/role]", err);
            return problem(res, 500, err?.message || "Failed to update role");
        }
    }
);

// ── DELETE /users/:userId ───────────────────────────────────────
// Soft-deactivate a user (set status='inactive' in b2b_user_links, remove from Appwrite team)
router.delete(
    "/:userId",
    requireAuth as any,
    requirePermissionMiddleware("manage:users") as any,
    async (req: Request, res: Response) => {
        try {
            const auth: AuthContext = (req as any).auth;
            const { userId } = req.params;

            // Cannot deactivate self
            if (userId === auth.userId) {
                return problem(res, 400, "Cannot deactivate yourself");
            }

            const vendorId = resolveVendorScope(auth, req.query.vendor_id as string);

            // Verify user exists and is active in this vendor
            const check = await db.execute(sql`
                SELECT ul.id, u.appwrite_user_id
                FROM gold.b2b_user_links ul
                JOIN gold.b2b_users u ON u.id = ul.user_id
                WHERE u.id = ${userId}::uuid
                  AND ul.vendor_id = ${vendorId}::uuid
                  AND ul.status = 'active'
                LIMIT 1
            `);

            if ((check.rows?.length || 0) === 0) {
                return problem(res, 404, "User not found or already inactive");
            }

            const row: any = check.rows![0];

            // 1) Soft-deactivate in Supabase
            await db.execute(sql`
                UPDATE gold.b2b_user_links
                SET status = 'inactive', updated_at = now()
                WHERE user_id = ${userId}::uuid
                  AND vendor_id = ${vendorId}::uuid
            `);

            // 2) Remove from Appwrite Team (non-fatal)
            if (row.appwrite_user_id) {
                try {
                    const vendorResult = await db.execute(sql`
                        SELECT team_id FROM gold.vendors
                        WHERE id = ${vendorId}::uuid
                        LIMIT 1
                    `);
                    const teamId = (vendorResult.rows?.[0] as any)?.team_id;
                    if (teamId) {
                        const teams = adminTeams();
                        const memberships = await teams.listMemberships(teamId, [
                            Query.equal("userId", row.appwrite_user_id),
                            Query.limit(1),
                        ]);
                        if (memberships.memberships.length > 0) {
                            await teams.deleteMembership(teamId, memberships.memberships[0].$id);
                        }
                    }
                } catch (awErr: any) {
                    console.warn("[DELETE /users/:userId] Appwrite team removal skipped:", awErr?.message);
                }
            }

            return res.json({ userId, deactivated: true });
        } catch (err: any) {
            console.error("[DELETE /users/:userId]", err);
            return problem(res, 500, err?.message || "Failed to deactivate user");
        }
    }
);

// ── POST /users/:userId/promote-superadmin ──────────────────────
// Promote a user to superadmin (only callable by existing superadmin)
router.post(
    "/:userId/promote-superadmin",
    requireAuth as any,
    requireRoleMiddleware("superadmin") as any,
    async (req: Request, res: Response) => {
        try {
            const auth: AuthContext = (req as any).auth;
            const { userId } = req.params;

            if (userId === auth.userId) {
                return problem(res, 400, "Cannot promote yourself");
            }

            // Check that user exists
            const check = await db.execute(sql`
                SELECT u.id, u.appwrite_user_id, u.email, ul.role
                FROM gold.b2b_user_links ul
                JOIN gold.b2b_users u ON u.id = ul.user_id
                WHERE u.id = ${userId}::uuid
                LIMIT 1
            `);
            const row = check.rows?.[0] as any;
            if (!row) return problem(res, 404, "User not found");
            if (row.role === "superadmin") return problem(res, 400, "User is already a superadmin");

            // Update Supabase
            await db.execute(sql`
                UPDATE gold.b2b_user_links
                SET role = 'superadmin', updated_at = now()
                WHERE user_id = ${userId}::uuid
            `);

            // Update Appwrite user_profiles if possible
            try {
                const profilesCol = getUserProfilesCol();
                if (profilesCol && row.appwrite_user_id) {
                    const adb = adminDatabases();
                    const docs = await adb.listDocuments(getDbId(), profilesCol, [
                        Query.equal("user_id", row.appwrite_user_id),
                        Query.limit(1),
                    ]);
                    if (docs.documents.length > 0) {
                        await adb.updateDocument(getDbId(), profilesCol, docs.documents[0].$id, {
                            role: "superadmin",
                        });
                    }
                }
            } catch (awErr: any) {
                console.warn("[promote-superadmin] Appwrite profile update skipped:", awErr?.message);
            }

            return res.json({ userId, role: "superadmin", promoted: true });
        } catch (err: any) {
            console.error("[POST /users/:userId/promote-superadmin]", err);
            return problem(res, 500, err?.message || "Failed to promote user");
        }
    }
);

// ── POST /users/:userId/demote-superadmin ───────────────────────
// Demote a superadmin back to vendor_admin (only callable by existing superadmin)
router.post(
    "/:userId/demote-superadmin",
    requireAuth as any,
    requireRoleMiddleware("superadmin") as any,
    async (req: Request, res: Response) => {
        try {
            const auth: AuthContext = (req as any).auth;
            const { userId } = req.params;

            if (userId === auth.userId) {
                return problem(res, 400, "Cannot demote yourself");
            }

            // Check that user exists and is actually superadmin
            const check = await db.execute(sql`
                SELECT u.id, u.appwrite_user_id, u.email, ul.role
                FROM gold.b2b_user_links ul
                JOIN gold.b2b_users u ON u.id = ul.user_id
                WHERE u.id = ${userId}::uuid
                LIMIT 1
            `);
            const row = check.rows?.[0] as any;
            if (!row) return problem(res, 404, "User not found");
            if (row.role !== "superadmin") return problem(res, 400, "User is not a superadmin");

            // Update Supabase
            await db.execute(sql`
                UPDATE gold.b2b_user_links
                SET role = 'vendor_admin', updated_at = now()
                WHERE user_id = ${userId}::uuid
            `);

            // Update Appwrite user_profiles if possible
            try {
                const profilesCol = getUserProfilesCol();
                if (profilesCol && row.appwrite_user_id) {
                    const adb = adminDatabases();
                    const docs = await adb.listDocuments(getDbId(), profilesCol, [
                        Query.equal("user_id", row.appwrite_user_id),
                        Query.limit(1),
                    ]);
                    if (docs.documents.length > 0) {
                        await adb.updateDocument(getDbId(), profilesCol, docs.documents[0].$id, {
                            role: "vendor_admin",
                        });
                    }
                }
            } catch (awErr: any) {
                console.warn("[demote-superadmin] Appwrite profile update skipped:", awErr?.message);
            }

            return res.json({ userId, role: "vendor_admin", demoted: true });
        } catch (err: any) {
            console.error("[POST /users/:userId/demote-superadmin]", err);
            return problem(res, 500, err?.message || "Failed to demote user");
        }
    }
);

export default router;
