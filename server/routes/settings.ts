// ─── Settings Router ─────────────────────────────────────────────────────────
// Phase 5: PRD 3 — Vendor-scoped key-value settings (dual-write to Appwrite)
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { requireAuth, requirePermissionMiddleware } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";
import { Client, Databases, Query } from "node-appwrite";

const router = Router();

// ── Appwrite admin helpers (same pattern as vendors/users routers) ─────────
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

function getDbId() {
    return mustEnv("APPWRITE_DB_ID");
}

function getSettingsCol() {
    return process.env.APPWRITE_VENDOR_SETTINGS_COL || "";
}

// ── GET /settings ────────────────────────────────────────────────────────────
// List all settings for the authenticated user's vendor
router.get(
    "/",
    requireAuth as any,
    requirePermissionMiddleware("manage:settings") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const vendorId = auth.vendorId;

            const result = await db.execute(sql`
                SELECT key, value, updated_by, updated_at
                FROM gold.system_settings
                WHERE vendor_id = ${vendorId}
                ORDER BY key
            `);

            const settings: Record<string, any> = {};
            for (const row of result.rows as any[]) {
                settings[row.key] = {
                    value: row.value,
                    updatedBy: row.updated_by,
                    updatedAt: row.updated_at,
                };
            }

            return res.json({ settings });
        } catch (err: any) {
            console.error("[settings] GET / error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to fetch settings" });
        }
    }
);

// ── GET /settings/:key ───────────────────────────────────────────────────────
// Get a single setting by key
router.get(
    "/:key",
    requireAuth as any,
    requirePermissionMiddleware("manage:settings") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const vendorId = auth.vendorId;
            const { key } = req.params;

            const result = await db.execute(sql`
                SELECT key, value, updated_by, updated_at
                FROM gold.system_settings
                WHERE vendor_id = ${vendorId}
                  AND key = ${key}
                LIMIT 1
            `);

            const row = result.rows[0] as any;
            if (!row) {
                return res.status(404).json({ code: "not_found", detail: `Setting '${key}' not found` });
            }

            return res.json({
                setting: {
                    key: row.key,
                    value: row.value,
                    updatedBy: row.updated_by,
                    updatedAt: row.updated_at,
                },
            });
        } catch (err: any) {
            console.error("[settings] GET /:key error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to fetch setting" });
        }
    }
);

// ── PUT /settings/:key ───────────────────────────────────────────────────────
// Upsert a setting. Creates if it doesn't exist, updates if it does.
// Dual-writes to Appwrite vendor_settings collection (non-fatal).
router.put(
    "/:key",
    requireAuth as any,
    requirePermissionMiddleware("manage:settings") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const vendorId = auth.vendorId;
            const { key } = req.params;
            const { value } = req.body;

            if (value === undefined) {
                return res.status(400).json({ code: "bad_request", detail: "Missing 'value' in request body" });
            }

            // Validate key: must be a non-empty alphanumeric + underscores/dots string
            if (!key || !/^[a-zA-Z0-9_.]+$/.test(key)) {
                return res.status(400).json({
                    code: "bad_request",
                    detail: "Setting key must contain only alphanumeric characters, underscores, or dots",
                });
            }

            // Upsert into gold.system_settings using ON CONFLICT
            const result = await db.execute(sql`
                INSERT INTO gold.system_settings (vendor_id, key, value, updated_by, updated_at)
                VALUES (${vendorId}, ${key}, ${JSON.stringify(value)}::jsonb, ${auth.userId}, now())
                ON CONFLICT (vendor_id, key)
                DO UPDATE SET
                    value = ${JSON.stringify(value)}::jsonb,
                    updated_by = ${auth.userId},
                    updated_at = now()
                RETURNING key, value, updated_by, updated_at
            `);

            const row = result.rows[0] as any;
            if (!row) {
                return res.status(500).json({ code: "internal_error", detail: "Upsert failed" });
            }

            // Appwrite dual-write (non-fatal)
            const settingsCol = getSettingsCol();
            if (settingsCol) {
                try {
                    const dbs = adminDatabases();
                    // Look for existing doc with matching vendor_id and key
                    const docs = await dbs.listDocuments(getDbId(), settingsCol, [
                        Query.equal("vendor_id", [vendorId]),
                        Query.equal("key", [key]),
                        Query.limit(1),
                    ]);
                    if (docs.total > 0) {
                        await dbs.updateDocument(getDbId(), settingsCol, docs.documents[0].$id, {
                            value: JSON.stringify(value),
                            updated_by: auth.userId,
                        });
                    } else {
                        await dbs.createDocument(getDbId(), settingsCol, "unique()", {
                            vendor_id: vendorId,
                            key,
                            value: JSON.stringify(value),
                            updated_by: auth.userId,
                        });
                    }
                } catch (awErr: any) {
                    console.warn("[settings] Appwrite dual-write failed (non-fatal):", awErr?.message || awErr);
                }
            }

            return res.json({
                setting: {
                    key: row.key,
                    value: row.value,
                    updatedBy: row.updated_by,
                    updatedAt: row.updated_at,
                },
            });
        } catch (err: any) {
            console.error("[settings] PUT /:key error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to save setting" });
        }
    }
);

export default router;
