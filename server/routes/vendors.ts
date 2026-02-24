// ─── Vendor Management Router ────────────────────────────────────────────────
// Phase 4: PRD 2 — Vendor stats, update, suspend/reactivate
// ──────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { requireAuth, requirePermissionMiddleware } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";
import { Client, Databases, Query } from "node-appwrite";

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

function getDbId() {
    return mustEnv("APPWRITE_DB_ID");
}

function getVendorsCol() {
    return process.env.APPWRITE_VENDORS_COL || "";
}

// ── GET /vendors/:vendorId/stats ────────────────────────────────────────────
// Returns vendor detail with aggregate counts (products, users, customers, last ingestion)
// Requires read:vendors permission
router.get(
    "/:vendorId/stats",
    requireAuth as any,
    requirePermissionMiddleware("read:vendors") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const { vendorId } = req.params;

            // Vendor-scoped: vendor_admin can only view their own vendor
            if (auth.role !== "superadmin" && auth.vendorId !== vendorId) {
                return res.status(403).json({ error: "Cannot view stats for a different vendor" });
            }

            // Fetch vendor record
            const vendorResult = await db.execute(sql`
                SELECT id, name, slug, status, catalog_version, api_endpoint,
                       contact_email, team_id, domains, owner_user_id, billing_email,
                       created_at, updated_at
                FROM gold.vendors WHERE id = ${vendorId} LIMIT 1
            `);

            const vendor = vendorResult.rows?.[0] as any;
            if (!vendor) {
                return res.status(404).json({ error: "Vendor not found" });
            }

            // Aggregate counts in parallel
            const [productCountResult, userCountResult, customerCountResult, lastIngestionResult] =
                await Promise.all([
                    db.execute(sql`
                        SELECT COUNT(*)::int AS count FROM gold.products WHERE vendor_id = ${vendorId}
                    `),
                    db.execute(sql`
                        SELECT COUNT(*)::int AS count FROM gold.b2b_user_links
                        WHERE vendor_id = ${vendorId} AND status = 'active'
                    `),
                    db.execute(sql`
                        SELECT COUNT(*)::int AS count FROM gold.b2b_customers WHERE vendor_id = ${vendorId}
                    `),
                    db.execute(sql`
                        SELECT MAX(started_at) AS last_ingestion
                        FROM orchestration.orchestration_runs
                        WHERE vendor_id = ${vendorId}
                    `),
                ]);

            return res.json({
                vendor: {
                    id: vendor.id,
                    name: vendor.name,
                    slug: vendor.slug,
                    status: vendor.status,
                    catalogVersion: vendor.catalog_version,
                    apiEndpoint: vendor.api_endpoint,
                    contactEmail: vendor.contact_email,
                    billingEmail: vendor.billing_email,
                    teamId: vendor.team_id,
                    domains: vendor.domains,
                    ownerUserId: vendor.owner_user_id,
                    createdAt: vendor.created_at,
                    updatedAt: vendor.updated_at,
                },
                stats: {
                    productCount: (productCountResult.rows?.[0] as any)?.count ?? 0,
                    userCount: (userCountResult.rows?.[0] as any)?.count ?? 0,
                    customerCount: (customerCountResult.rows?.[0] as any)?.count ?? 0,
                    lastIngestion: (lastIngestionResult.rows?.[0] as any)?.last_ingestion ?? null,
                },
            });
        } catch (err: any) {
            console.error("[vendors] GET /:vendorId/stats error:", err?.message || err);
            return res.status(500).json({ error: "Internal server error" });
        }
    }
);

// ── PATCH /vendors/:vendorId ────────────────────────────────────────────────
// Update vendor fields (dual-write: Supabase + Appwrite vendors collection)
// Requires write:vendors permission
router.patch(
    "/:vendorId",
    requireAuth as any,
    requirePermissionMiddleware("write:vendors") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const { vendorId } = req.params;

            // Vendor-scoped: vendor_admin can update their own vendor only
            if (auth.role !== "superadmin" && auth.vendorId !== vendorId) {
                return res.status(403).json({ error: "Cannot update a different vendor" });
            }

            const { name, contactEmail, billingEmail, apiEndpoint, domains } = req.body;

            // Build SET clauses dynamically
            const setParts: any[] = [];
            if (name !== undefined) setParts.push(sql`name = ${name}`);
            if (contactEmail !== undefined) setParts.push(sql`contact_email = ${contactEmail}`);
            if (billingEmail !== undefined) setParts.push(sql`billing_email = ${billingEmail}`);
            if (apiEndpoint !== undefined) setParts.push(sql`api_endpoint = ${apiEndpoint}`);
            if (domains !== undefined && Array.isArray(domains)) {
                setParts.push(sql`domains = ${sql`ARRAY[${sql.join(domains.map((d: string) => sql`${d}`), sql`, `)}]::text[]`}`);
            }
            setParts.push(sql`updated_at = now()`);

            if (setParts.length <= 1) {
                return res.status(400).json({ error: "No updatable fields provided" });
            }

            const result = await db.execute(sql`
                UPDATE gold.vendors
                SET ${sql.join(setParts, sql`, `)}
                WHERE id = ${vendorId}
                RETURNING id, name, slug, status, contact_email, billing_email,
                          api_endpoint, domains, team_id, updated_at
            `);

            const updated = result.rows?.[0] as any;
            if (!updated) {
                return res.status(404).json({ error: "Vendor not found" });
            }

            // Appwrite dual-write (non-fatal)
            const vendorsCol = getVendorsCol();
            if (vendorsCol) {
                try {
                    const dbs = adminDatabases();
                    const docs = await dbs.listDocuments(getDbId(), vendorsCol, [
                        Query.equal("slug", [updated.slug]),
                        Query.limit(1),
                    ]);
                    if (docs.total > 0) {
                        const docId = docs.documents[0].$id;
                        const patch: Record<string, any> = {};
                        if (name !== undefined) patch.name = name;
                        if (contactEmail !== undefined) patch.contact_email = contactEmail;
                        if (billingEmail !== undefined) patch.billing_email = billingEmail;
                        if (domains !== undefined) patch.domains = domains;
                        if (Object.keys(patch).length > 0) {
                            await dbs.updateDocument(getDbId(), vendorsCol, docId, patch);
                        }
                    }
                } catch (awErr: any) {
                    console.warn("[vendors] Appwrite dual-write failed (non-fatal):", awErr?.message || awErr);
                }
            }

            return res.json({
                vendor: {
                    id: updated.id,
                    name: updated.name,
                    slug: updated.slug,
                    status: updated.status,
                    contactEmail: updated.contact_email,
                    billingEmail: updated.billing_email,
                    apiEndpoint: updated.api_endpoint,
                    domains: updated.domains,
                    teamId: updated.team_id,
                    updatedAt: updated.updated_at,
                },
            });
        } catch (err: any) {
            console.error("[vendors] PATCH /:vendorId error:", err?.message || err);
            return res.status(500).json({ error: "Internal server error" });
        }
    }
);

// ── POST /vendors/:vendorId/suspend ─────────────────────────────────────────
// Suspend a vendor (superadmin only)
router.post(
    "/:vendorId/suspend",
    requireAuth as any,
    requirePermissionMiddleware("write:vendors") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;

            // Only superadmin can suspend vendors
            if (auth.role !== "superadmin") {
                return res.status(403).json({ error: "Only superadmin can suspend vendors" });
            }

            const { vendorId } = req.params;

            // Prevent suspending own vendor
            if (auth.vendorId === vendorId) {
                return res.status(400).json({ error: "Cannot suspend your own vendor" });
            }

            const result = await db.execute(sql`
                UPDATE gold.vendors
                SET status = 'suspended', updated_at = now()
                WHERE id = ${vendorId} AND status != 'suspended'
                RETURNING id, name, slug, status, updated_at
            `);

            const updated = result.rows?.[0] as any;
            if (!updated) {
                // Could be not found or already suspended
                const check = await db.execute(sql`
                    SELECT id, status FROM gold.vendors WHERE id = ${vendorId} LIMIT 1
                `);
                if (!check.rows?.[0]) {
                    return res.status(404).json({ error: "Vendor not found" });
                }
                return res.status(409).json({ error: "Vendor is already suspended" });
            }

            // Appwrite dual-write: update status (non-fatal)
            const vendorsCol = getVendorsCol();
            if (vendorsCol) {
                try {
                    const dbs = adminDatabases();
                    const docs = await dbs.listDocuments(getDbId(), vendorsCol, [
                        Query.equal("slug", [updated.slug]),
                        Query.limit(1),
                    ]);
                    if (docs.total > 0) {
                        await dbs.updateDocument(getDbId(), vendorsCol, docs.documents[0].$id, {
                            status: "suspended",
                        });
                    }
                } catch (awErr: any) {
                    console.warn("[vendors] Appwrite suspend dual-write failed (non-fatal):", awErr?.message || awErr);
                }
            }

            return res.json({
                vendor: {
                    id: updated.id,
                    name: updated.name,
                    slug: updated.slug,
                    status: updated.status,
                    updatedAt: updated.updated_at,
                },
            });
        } catch (err: any) {
            console.error("[vendors] POST /:vendorId/suspend error:", err?.message || err);
            return res.status(500).json({ error: "Internal server error" });
        }
    }
);

// ── POST /vendors/:vendorId/reactivate ──────────────────────────────────────
// Reactivate a suspended vendor (superadmin only)
router.post(
    "/:vendorId/reactivate",
    requireAuth as any,
    requirePermissionMiddleware("write:vendors") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;

            // Only superadmin can reactivate vendors
            if (auth.role !== "superadmin") {
                return res.status(403).json({ error: "Only superadmin can reactivate vendors" });
            }

            const { vendorId } = req.params;

            const result = await db.execute(sql`
                UPDATE gold.vendors
                SET status = 'active', updated_at = now()
                WHERE id = ${vendorId} AND status = 'suspended'
                RETURNING id, name, slug, status, updated_at
            `);

            const updated = result.rows?.[0] as any;
            if (!updated) {
                const check = await db.execute(sql`
                    SELECT id, status FROM gold.vendors WHERE id = ${vendorId} LIMIT 1
                `);
                if (!check.rows?.[0]) {
                    return res.status(404).json({ error: "Vendor not found" });
                }
                return res.status(409).json({ error: "Vendor is not suspended" });
            }

            // Appwrite dual-write: update status (non-fatal)
            const vendorsCol = getVendorsCol();
            if (vendorsCol) {
                try {
                    const dbs = adminDatabases();
                    const docs = await dbs.listDocuments(getDbId(), vendorsCol, [
                        Query.equal("slug", [updated.slug]),
                        Query.limit(1),
                    ]);
                    if (docs.total > 0) {
                        await dbs.updateDocument(getDbId(), vendorsCol, docs.documents[0].$id, {
                            status: "active",
                        });
                    }
                } catch (awErr: any) {
                    console.warn("[vendors] Appwrite reactivate dual-write failed (non-fatal):", awErr?.message || awErr);
                }
            }

            return res.json({
                vendor: {
                    id: updated.id,
                    name: updated.name,
                    slug: updated.slug,
                    status: updated.status,
                    updatedAt: updated.updated_at,
                },
            });
        } catch (err: any) {
            console.error("[vendors] POST /:vendorId/reactivate error:", err?.message || err);
            return res.status(500).json({ error: "Internal server error" });
        }
    }
);

export default router;
