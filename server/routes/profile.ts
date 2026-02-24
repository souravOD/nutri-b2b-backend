// ─── Profile Router ─────────────────────────────────────────────────────────
// Phase 4: Profile read/update (backend proxy for Appwrite + gold.b2b_users)
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";
import { Client, Users } from "node-appwrite";

const router = Router();

// ── Appwrite admin helpers ──────────────────────────────────────────────────
function createAdminClient(): Client | null {
    const endpoint = process.env.APPWRITE_ENDPOINT;
    const project = process.env.APPWRITE_PROJECT_ID;
    const key = process.env.APPWRITE_API_KEY;
    if (!endpoint || !project || !key) return null;

    return new Client()
        .setEndpoint(endpoint)
        .setProject(project)
        .setKey(key);
}

// ── GET /profile ────────────────────────────────────────────────────────────
// Returns merged profile data: Appwrite user + gold.b2b_users row
router.get(
    "/",
    requireAuth as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const appwriteUserId = auth.appwriteUserId;
            const userId = auth.userId;

            // Fetch from gold.b2b_users (where profile extensions live)
            const dbResult = await db.execute(sql`
                SELECT u.id, u.appwrite_user_id, u.email, u.display_name,
                       u.phone, u.country, u.timezone,
                       ul.vendor_id, ul.role
                FROM gold.b2b_users u
                LEFT JOIN gold.b2b_user_links ul ON ul.user_id = u.id
                WHERE u.id = ${userId}::uuid
                LIMIT 1
            `);

            const row = dbResult.rows?.[0] as any;
            if (!row) {
                return res.status(404).json({ code: "not_found", detail: "User profile not found" });
            }

            // Get Appwrite user for the name (may differ from display_name)
            let appwriteName = "";
            try {
                const client = createAdminClient();
                if (client && appwriteUserId) {
                    const users = new Users(client);
                    const awUser = await users.get(appwriteUserId);
                    appwriteName = awUser.name || "";
                }
            } catch {
                // Non-fatal — Appwrite might be unreachable
            }

            return res.json({
                id: row.id,
                appwriteUserId: row.appwrite_user_id,
                email: row.email || auth.email,
                displayName: row.display_name || appwriteName,
                phone: row.phone || null,
                country: row.country || null,
                timezone: row.timezone || null,
                vendorId: row.vendor_id || auth.vendorId,
                role: row.role || auth.role,
            });
        } catch (err: any) {
            console.error("[profile] GET / error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to fetch profile" });
        }
    },
);

// ── PUT /profile ────────────────────────────────────────────────────────────
// Update profile fields. Syncs display_name to Appwrite.
const MAX_FIELD = 255;

router.put(
    "/",
    requireAuth as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const userId = auth.userId;
            const appwriteUserId = auth.appwriteUserId;

            const { displayName, phone, country, timezone } = req.body || {};

            // Validate field lengths
            if (displayName && displayName.length > MAX_FIELD) {
                return res.status(400).json({ code: "bad_request", detail: "displayName too long (max 255)" });
            }
            if (phone && phone.length > 30) {
                return res.status(400).json({ code: "bad_request", detail: "phone too long (max 30)" });
            }
            if (country && country.length > 5) {
                return res.status(400).json({ code: "bad_request", detail: "country code too long (max 5)" });
            }
            if (timezone && timezone.length > 50) {
                return res.status(400).json({ code: "bad_request", detail: "timezone too long (max 50)" });
            }

            // Update gold.b2b_users
            const result = await db.execute(sql`
                UPDATE gold.b2b_users
                SET
                    display_name = COALESCE(${displayName || null}, display_name),
                    phone = COALESCE(${phone || null}, phone),
                    country = COALESCE(${country || null}, country),
                    timezone = COALESCE(${timezone || null}, timezone),
                    updated_at = now()
                WHERE id = ${userId}::uuid
                RETURNING id, display_name, phone, country, timezone
            `);

            if (!result.rows?.length) {
                return res.status(404).json({ code: "not_found", detail: "User not found" });
            }

            // Sync display_name to Appwrite (non-fatal)
            if (displayName) {
                try {
                    const client = createAdminClient();
                    if (client) {
                        const users = new Users(client);
                        await users.updateName(appwriteUserId, displayName);
                    }
                } catch (err: any) {
                    console.warn("[profile] Appwrite sync failed (non-fatal):", err?.message || err);
                }
            }

            // Audit log
            try {
                await db.execute(sql`
                    INSERT INTO gold.audit_log (actor_id, action, entity_type, entity_id, diff)
                    VALUES (
                        ${userId}::uuid,
                        'profile_update',
                        'user',
                        ${userId}::uuid,
                        ${JSON.stringify({ displayName, phone, country, timezone })}::jsonb
                    )
                `);
            } catch {
                // Non-fatal — don't fail the profile update if audit log insert fails
            }

            return res.json({ ok: true, profile: result.rows[0] });
        } catch (err: any) {
            console.error("[profile] PUT / error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to update profile" });
        }
    },
);

export default router;
