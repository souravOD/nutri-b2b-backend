import { Router, type Request, type Response } from "express";
import { randomUUID, randomBytes } from "crypto";
import { requireAuth, requirePermissionMiddleware, type AuthContext } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";
import { Client, Databases, ID, Query, Teams, Users } from "node-appwrite";

const router = Router();

// ── Appwrite admin helpers ────────────────────────────────────────
function mustEnv(key: string): string {
    const v = process.env[key];
    if (!v) throw new Error(`Missing env var: ${key}`);
    return v;
}

function createAdminClient() {
    return new Client()
        .setEndpoint(mustEnv("APPWRITE_ENDPOINT"))
        .setProject(mustEnv("APPWRITE_PROJECT_ID"))
        .setKey(mustEnv("APPWRITE_API_KEY"));
}

function adminDatabases() {
    return new Databases(createAdminClient());
}

function getInvitationsCol() {
    return process.env.APPWRITE_INVITATIONS_COL || "";
}

function getDbId() {
    return mustEnv("APPWRITE_DB_ID");
}

// ── Helpers ───────────────────────────────────────────────────────
function generateToken(): string {
    return randomBytes(32).toString("base64url");
}

function problem(res: Response, status: number, detail: string) {
    return res.status(status).json({
        type: "about:blank",
        title: status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Error",
        status,
        detail,
    });
}

// ── GET /invitations ─────────────────────────────────────────────
// List invitations for the current vendor (or all vendors for superadmin)
router.get(
    "/",
    requireAuth as any,
    requirePermissionMiddleware("manage:users") as any,
    async (req: Request, res: Response) => {
        try {
            const auth: AuthContext = (req as any).auth;
            const vendorId = auth.role === "superadmin" && req.query.vendor_id
                ? String(req.query.vendor_id)
                : auth.vendorId;

            const result = await db.execute(sql`
        SELECT
          i.id, i.vendor_id, i.email, i.role, i.status, i.message,
          i.token, i.expires_at, i.accepted_at, i.created_at,
          u.email AS invited_by_email
        FROM gold.invitations i
        LEFT JOIN gold.b2b_users u ON u.id = i.invited_by
        WHERE i.vendor_id = ${vendorId}::uuid
        ORDER BY i.created_at DESC
        LIMIT 100
      `);

            return res.json({ invitations: result.rows || [] });
        } catch (err: any) {
            console.error("[GET /invitations]", err);
            return problem(res, 500, err?.message || "Failed to list invitations");
        }
    }
);

// ── POST /invitations ────────────────────────────────────────────
// Create a new invitation (dual-write: Supabase + Appwrite)
router.post(
    "/",
    requireAuth as any,
    requirePermissionMiddleware("manage:users") as any,
    async (req: Request, res: Response) => {
        try {
            const auth: AuthContext = (req as any).auth;
            const { email, role = "vendor_viewer", message } = req.body;

            if (!email || typeof email !== "string") {
                return problem(res, 400, "email is required");
            }

            const normalizedEmail = email.trim().toLowerCase();

            // Validate role
            const validRoles = ["vendor_admin", "vendor_operator", "vendor_viewer"];
            if (!validRoles.includes(role)) {
                return problem(res, 400, `Invalid role: ${role}. Must be one of: ${validRoles.join(", ")}`);
            }

            // Check for existing pending invitation — update it instead of blocking
            const existing = await db.execute(sql`
        SELECT id, appwrite_doc_id FROM gold.invitations
        WHERE lower(email) = ${normalizedEmail}
          AND vendor_id = ${auth.vendorId}::uuid
          AND status = 'pending'
        LIMIT 1
      `);

            const existingRow = existing.rows?.[0] as any;
            if (existingRow) {
                // Clean up old Appwrite doc if it exists
                const oldDocId = existingRow.appwrite_doc_id;
                if (oldDocId) {
                    try {
                        const invCol = getInvitationsCol();
                        if (invCol) {
                            await adminDatabases().deleteDocument(getDbId(), invCol, oldDocId);
                        }
                    } catch { /* best-effort cleanup */ }
                }

                // Delete the old Supabase record so we can create a fresh one
                await db.execute(sql`
          DELETE FROM gold.invitations WHERE id = ${existingRow.id}::uuid
        `);
                console.info(`[POST /invitations] Replaced existing pending invite for ${normalizedEmail}`);
            }

            // Generate unique token for email link
            const token = generateToken();
            const invId = randomUUID();
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

            // 1) Write to Supabase
            await db.execute(sql`
        INSERT INTO gold.invitations (id, vendor_id, email, role, invited_by, status, message, token, expires_at)
        VALUES (
          ${invId}::uuid,
          ${auth.vendorId}::uuid,
          ${normalizedEmail},
          ${role},
          ${auth.userId}::uuid,
          'pending',
          ${message || null},
          ${token},
          ${expiresAt.toISOString()}::timestamptz
        )
      `);

            // 2) Look up the vendor's Appwrite team_id (needed for both steps below)
            let teamId: string | null = null;
            try {
                const vendorRow = await db.execute(sql`
          SELECT team_id FROM gold.vendors WHERE id = ${auth.vendorId}::uuid LIMIT 1
        `);
                teamId = (vendorRow.rows?.[0] as any)?.team_id || null;
            } catch (err: any) {
                console.warn("[POST /invitations] Could not look up team_id:", err?.message);
            }

            // 2b) Upsert b2b_users + b2b_user_links so invited user appears in User Management
            try {
                const displayName = normalizedEmail.split("@")[0] || "user";

                // Upsert b2b_users — use ON CONFLICT on the functional unique index lower(email)
                const userUpsert = await db.execute(sql`
                    INSERT INTO gold.b2b_users (email, display_name, source, vendor_id, status)
                    VALUES (
                        ${normalizedEmail},
                        ${displayName},
                        'invitation',
                        ${auth.vendorId}::uuid,
                        'invited'
                    )
                    ON CONFLICT ((lower(email))) DO UPDATE SET updated_at = now()
                    RETURNING id
                `);
                const invitedUserId = (userUpsert.rows?.[0] as any)?.id;

                if (invitedUserId) {
                    // Upsert b2b_user_links — only update if the current status is 'invited'
                    // (never downgrade an active user back to invited)
                    await db.execute(sql`
                        INSERT INTO gold.b2b_user_links (user_id, vendor_id, role, status)
                        VALUES (
                            ${invitedUserId}::uuid,
                            ${auth.vendorId}::uuid,
                            ${role},
                            'invited'
                        )
                        ON CONFLICT (user_id) DO UPDATE SET
                            role = EXCLUDED.role,
                            updated_at = now()
                        WHERE gold.b2b_user_links.status = 'invited'
                    `);
                    console.info(`[POST /invitations] Upserted b2b_users/links for ${normalizedEmail} (status=invited)`);
                }
            } catch (upsertErr: any) {
                // Non-fatal — invitation still works, just user won't appear in management UI yet
                console.warn("[POST /invitations] b2b_users upsert skipped:", upsertErr?.message);
            }

            // 3) Dual-write to Appwrite invitations collection (non-fatal)
            let appwriteDocId: string | null = null;
            const invCol = getInvitationsCol();
            if (invCol) {
                try {
                    const adb = adminDatabases();
                    const doc = await adb.createDocument(getDbId(), invCol, ID.unique(), {
                        vendor_id: auth.vendorId,
                        team_id: teamId || "",
                        email: normalizedEmail,
                        role,
                        invited_by_user_id: auth.userId,
                        invited_by_name: auth.email,       // use inviter's email as name
                        status: "pending",
                        expires_at: expiresAt.toISOString(),
                    });
                    appwriteDocId = doc.$id;

                    // Store Appwrite doc ID back into Supabase for reconciliation
                    await db.execute(sql`
            UPDATE gold.invitations SET appwrite_doc_id = ${appwriteDocId}
            WHERE id = ${invId}::uuid
          `);
                } catch (awErr: any) {
                    console.warn("[POST /invitations] Appwrite dual-write skipped:", awErr?.message);
                }
            }

            // 4) Build the invite link for the admin to share
            // NOTE: teams.createMembership() was removed because when called
            // with a server API key it auto-accepts and NEVER sends an email.
            // Instead, the invited user will register via /invite/accept which
            // triggers account.createVerification() — the same flow as registration.
            const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
            const inviteLink = `${frontendUrl}/invite/accept?token=${token}`;

            console.info(`[POST /invitations] Invite created for ${normalizedEmail} → ${inviteLink}`);

            return res.status(201).json({
                id: invId,
                email: normalizedEmail,
                role,
                status: "pending",
                token,
                expires_at: expiresAt.toISOString(),
                appwrite_doc_id: appwriteDocId,
                invite_link: inviteLink,
                team_id: teamId,
            });
        } catch (err: any) {
            console.error("[POST /invitations]", err);
            return problem(res, 500, err?.message || "Failed to create invitation");
        }
    }
);


// ── POST /invitations/promote-to-owner ──────────────────────────
// Upgrades the current admin's team membership to "owner" role.
// Required so the admin can call client-side teams.createMembership()
// which sends the invitation email.
// If the user is NOT a team member yet (e.g. superadmin), adds them as owner.
router.post(
    "/promote-to-owner",
    requireAuth as any,
    requirePermissionMiddleware("manage:users") as any,
    async (req: Request, res: Response) => {
        try {
            const auth: AuthContext = (req as any).auth;

            // Look up vendor team_id
            const vendorRow = await db.execute(sql`
                SELECT team_id FROM gold.vendors WHERE id = ${auth.vendorId}::uuid LIMIT 1
            `);
            const teamId = (vendorRow.rows?.[0] as any)?.team_id;
            if (!teamId) {
                return problem(res, 404, "No team_id found for your vendor");
            }

            const teamsApi = new Teams(createAdminClient());

            // Use the APPWRITE user ID (not Supabase user ID) to find membership
            const appwriteUserId = auth.appwriteUserId;

            // List current memberships to find the admin's membership  
            const memberships = await teamsApi.listMemberships(teamId);
            const myMembership = memberships.memberships.find(
                (m: any) => m.userId === appwriteUserId
            );

            if (!myMembership) {
                // User is NOT a member of this team — add them as owner
                // This happens for superadmins who may not be in every vendor team
                console.info(`[promote-to-owner] ${auth.email} not in team ${teamId}, adding as owner`);
                await teamsApi.createMembership(
                    teamId,
                    ["owner"],
                    auth.email,         // email
                    appwriteUserId,     // userId — direct add via server key
                );
                return res.json({ ok: true, added: true });
            }

            // Check if already owner
            if (myMembership.roles?.includes("owner")) {
                return res.json({ ok: true, alreadyOwner: true });
            }

            // Update to owner
            await teamsApi.updateMembership(teamId, myMembership.$id, ["owner"]);

            console.info(`[POST /invitations/promote-to-owner] ${auth.email} promoted to owner of team ${teamId}`);
            return res.json({ ok: true });
        } catch (err: any) {
            console.error("[POST /invitations/promote-to-owner]", err);
            return problem(res, 500, err?.message || "Failed to promote to owner");
        }
    }
);



// ── GET /invitations/validate ────────────────────────────────────
// Public endpoint — validates an invitation token for the accept-invite page
router.get(
    "/validate",
    async (req: Request, res: Response) => {
        try {
            const token = String(req.query.token || "").trim();
            if (!token) {
                return problem(res, 400, "token query parameter is required");
            }

            const result = await db.execute(sql`
                SELECT
                    i.id, i.email, i.role, i.status, i.expires_at,
                    v.name AS vendor_name
                FROM gold.invitations i
                LEFT JOIN gold.vendors v ON v.id = i.vendor_id
                WHERE i.token = ${token}
                LIMIT 1
            `);

            const row = result.rows?.[0] as any;
            if (!row) {
                return problem(res, 404, "Invitation not found");
            }

            if (row.status !== "pending") {
                return problem(res, 410, `Invitation is ${row.status}`);
            }

            // Check expiry
            if (row.expires_at && new Date(row.expires_at) < new Date()) {
                return problem(res, 410, "Invitation has expired");
            }

            return res.json({
                id: row.id,
                email: row.email,
                role: row.role,
                vendor_name: row.vendor_name || "Unknown",
            });
        } catch (err: any) {
            console.error("[GET /invitations/validate]", err);
            return problem(res, 500, err?.message || "Failed to validate invitation");
        }
    }
);

// ── POST /invitations/set-password ───────────────────────────────
// Public endpoint — lets an invited user set their initial password
// after arriving via Appwrite's team invitation email.

router.post(
    "/set-password",
    async (req: Request, res: Response) => {
        try {
            const { token, userId, password, fullName } = req.body;

            if (!token || !userId || !password) {
                return problem(res, 400, "token, userId, and password are required");
            }

            if (String(password).length < 12) {
                return problem(res, 400, "Password must be at least 12 characters");
            }

            // 1) Validate the invitation token
            const invResult = await db.execute(sql`
                SELECT id, email, role, status, vendor_id
                FROM gold.invitations
                WHERE token = ${token} AND status = 'pending'
                LIMIT 1
            `);
            const inv = invResult.rows?.[0] as any;
            if (!inv) {
                return problem(res, 404, "Invalid or expired invitation");
            }

            // 2) Validate userId belongs to the invitation email
            const adminClient = createAdminClient();
            const users = new Users(adminClient);

            let appwriteUser;
            try {
                appwriteUser = await users.get(userId);
            } catch {
                return problem(res, 401, "Invalid user ID");
            }
            if (appwriteUser.email.toLowerCase() !== inv.email.toLowerCase()) {
                return problem(res, 403, "User ID does not match invitation email");
            }

            // 3) Check invitation expiry
            if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
                return problem(res, 410, "Invitation has expired");
            }

            // 4) Set password on the Appwrite Auth user
            await users.updatePassword(userId, password);

            // 3) Mark email as verified
            await users.updateEmailVerification(userId, true);

            // 4) Optionally update name
            if (fullName) {
                try {
                    await users.updateName(userId, fullName);
                } catch { /* non-fatal */ }
            }

            // 5) Mark invitation as accepted in Supabase
            await db.execute(sql`
                UPDATE gold.invitations
                SET status = 'accepted', accepted_at = now()
                WHERE id = ${inv.id}::uuid
            `);

            // 6) Mark invitation as accepted in Appwrite (if doc exists)
            const invCol = getInvitationsCol();
            if (invCol) {
                try {
                    const adb = adminDatabases();
                    // Find the doc by email
                    const docs = await adb.listDocuments(getDbId(), invCol, [
                        Query.equal("email", inv.email),
                        Query.equal("status", "pending"),
                        Query.limit(1),
                    ]);
                    if (docs.total > 0) {
                        await adb.updateDocument(getDbId(), invCol, docs.documents[0].$id, {
                            status: "accepted",
                        });
                    }
                } catch { /* non-fatal */ }
            }

            // 7) Activate the b2b_users + b2b_user_links records created at invite time
            try {
                const normalizedEmail = inv.email.trim().toLowerCase();
                const displayName = fullName || normalizedEmail.split("@")[0] || "user";

                // Update b2b_users: fill in appwrite_user_id, set status to active
                const userUpdate = await db.execute(sql`
                    UPDATE gold.b2b_users
                    SET
                        appwrite_user_id = ${userId},
                        display_name = COALESCE(NULLIF(display_name, ''), ${displayName}),
                        source = 'appwrite',
                        status = 'active',
                        updated_at = now()
                    WHERE lower(email) = lower(${normalizedEmail})
                      AND (appwrite_user_id IS NULL OR appwrite_user_id = ${userId})
                    RETURNING id
                `);
                const b2bUserId = (userUpdate.rows?.[0] as any)?.id;

                if (b2bUserId) {
                    // Activate the user link
                    await db.execute(sql`
                        UPDATE gold.b2b_user_links
                        SET status = 'active', updated_at = now()
                        WHERE user_id = ${b2bUserId}::uuid
                          AND status = 'invited'
                    `);
                    console.info(`[set-password] Activated b2b_users/links for ${normalizedEmail} (appwriteId=${userId})`);
                }
            } catch (activateErr: any) {
                // Non-fatal — /onboard/self can still fix this on next login
                console.warn("[set-password] b2b_users activation skipped:", activateErr?.message);
            }

            console.info(`[POST /invitations/set-password] Password set for ${inv.email} (userId=${userId})`);

            return res.json({
                ok: true,
                email: inv.email,
                role: inv.role,
            });
        } catch (err: any) {
            console.error("[POST /invitations/set-password]", err);
            return problem(res, 500, err?.message || "Failed to set password");
        }
    }
);


// ── PATCH /invitations/:id ───────────────────────────────────────
// Revoke a pending invitation
router.patch(
    "/:id",
    requireAuth as any,
    requirePermissionMiddleware("manage:users") as any,
    async (req: Request, res: Response) => {
        try {
            const auth: AuthContext = (req as any).auth;
            const { id } = req.params;
            const { status } = req.body;

            if (status !== "revoked") {
                return problem(res, 400, "Only status='revoked' is allowed via PATCH");
            }

            // Verify invitation belongs to the user's vendor
            const check = await db.execute(sql`
        SELECT id, appwrite_doc_id FROM gold.invitations
        WHERE id = ${id}::uuid AND vendor_id = ${auth.vendorId}::uuid AND status = 'pending'
        LIMIT 1
      `);

            if ((check.rows?.length || 0) === 0) {
                return problem(res, 404, "Invitation not found or already processed");
            }

            // 1) Update Supabase
            await db.execute(sql`
        UPDATE gold.invitations
        SET status = 'revoked', updated_at = now()
        WHERE id = ${id}::uuid
      `);

            // 2) Dual-write to Appwrite
            const row: any = check.rows?.[0];
            const invCol = getInvitationsCol();
            if (row?.appwrite_doc_id && invCol) {
                try {
                    const adb = adminDatabases();
                    await adb.updateDocument(getDbId(), invCol, row.appwrite_doc_id, {
                        status: "revoked",
                    });
                } catch (awErr: any) {
                    console.warn("[PATCH /invitations] Appwrite dual-write skipped:", awErr?.message);
                }
            }

            return res.json({ id, status: "revoked" });
        } catch (err: any) {
            console.error("[PATCH /invitations]", err);
            return problem(res, 500, err?.message || "Failed to revoke invitation");
        }
    }
);

// ── DELETE /invitations/:id ──────────────────────────────────────
// Hard-delete an invitation
router.delete(
    "/:id",
    requireAuth as any,
    requirePermissionMiddleware("manage:users") as any,
    async (req: Request, res: Response) => {
        try {
            const auth: AuthContext = (req as any).auth;
            const { id } = req.params;

            // Verify invitation belongs to the user's vendor
            const check = await db.execute(sql`
        SELECT id, appwrite_doc_id FROM gold.invitations
        WHERE id = ${id}::uuid AND vendor_id = ${auth.vendorId}::uuid
        LIMIT 1
      `);

            if ((check.rows?.length || 0) === 0) {
                return problem(res, 404, "Invitation not found");
            }

            // 1) Delete from Supabase
            await db.execute(sql`
        DELETE FROM gold.invitations WHERE id = ${id}::uuid
      `);

            // 2) Delete from Appwrite
            const row: any = check.rows?.[0];
            const invCol = getInvitationsCol();
            if (row?.appwrite_doc_id && invCol) {
                try {
                    const adb = adminDatabases();
                    await adb.deleteDocument(getDbId(), invCol, row.appwrite_doc_id);
                } catch (awErr: any) {
                    console.warn("[DELETE /invitations] Appwrite dual-delete skipped:", awErr?.message);
                }
            }

            return res.json({ id, deleted: true });
        } catch (err: any) {
            console.error("[DELETE /invitations]", err);
            return problem(res, 500, err?.message || "Failed to delete invitation");
        }
    }
);

export default router;
