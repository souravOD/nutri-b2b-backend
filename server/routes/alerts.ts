// ─── Alerts Router ──────────────────────────────────────────────────────────
// Phase 2: vendor-scoped alerts (quality, compliance, ingestion, system)
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { requireAuth, requirePermissionMiddleware } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";

const router = Router();

const VALID_TYPES = ["quality", "compliance", "ingestion", "match", "system"] as const;
const VALID_PRIORITIES = ["high", "medium", "low"] as const;
const VALID_STATUSES = ["unread", "read", "dismissed"] as const;
const MAX_PAGE_SIZE = 100;

// ── GET /alerts ─────────────────────────────────────────────────────────────
// List alerts for the authenticated user's vendor, with optional filters.
router.get(
    "/",
    requireAuth as any,
    requirePermissionMiddleware("read:vendors") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const vendorId = auth.vendorId;
            if (!vendorId) {
                return res.status(400).json({ code: "bad_request", detail: "Missing vendor context" });
            }

            const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
            const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt((req.query.limit as string) || "20", 10)));
            const offset = (page - 1) * limit;

            // Optional filters
            const typeFilter = (req.query.type as string) || null;
            const priorityFilter = (req.query.priority as string) || null;
            const statusFilter = (req.query.status as string) || null;

            // Validate filter values
            if (typeFilter && !VALID_TYPES.includes(typeFilter as any)) {
                return res.status(400).json({ code: "bad_request", detail: `Invalid type filter. Allowed: ${VALID_TYPES.join(", ")}` });
            }
            if (priorityFilter && !VALID_PRIORITIES.includes(priorityFilter as any)) {
                return res.status(400).json({ code: "bad_request", detail: `Invalid priority filter. Allowed: ${VALID_PRIORITIES.join(", ")}` });
            }
            if (statusFilter && !VALID_STATUSES.includes(statusFilter as any)) {
                return res.status(400).json({ code: "bad_request", detail: `Invalid status filter. Allowed: ${VALID_STATUSES.join(", ")}` });
            }

            // Build query with optional filters
            const conditions = [sql`vendor_id = ${vendorId}::uuid`];
            if (typeFilter) conditions.push(sql`type = ${typeFilter}`);
            if (priorityFilter) conditions.push(sql`priority = ${priorityFilter}`);
            if (statusFilter) conditions.push(sql`status = ${statusFilter}`);

            const where = sql.join(conditions, sql` AND `);

            const countResult = await db.execute(sql`
                SELECT count(*)::int AS total FROM gold.b2b_alerts WHERE ${where}
            `);
            const total = (countResult.rows?.[0] as any)?.total ?? 0;

            const result = await db.execute(sql`
                SELECT id, vendor_id, type, priority, title, description,
                       status, source_table, source_id, created_at, read_at
                FROM gold.b2b_alerts
                WHERE ${where}
                ORDER BY created_at DESC
                LIMIT ${limit} OFFSET ${offset}
            `);

            return res.json({
                data: result.rows || [],
                page,
                pageSize: limit,
                total,
            });
        } catch (err: any) {
            console.error("[alerts] GET / error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to fetch alerts" });
        }
    },
);

// ── GET /alerts/summary ─────────────────────────────────────────────────────
// Aggregate counts: total, unread, high-priority
router.get(
    "/summary",
    requireAuth as any,
    requirePermissionMiddleware("read:vendors") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const vendorId = auth.vendorId;
            if (!vendorId) {
                return res.status(400).json({ code: "bad_request", detail: "Missing vendor context" });
            }

            const result = await db.execute(sql`
                SELECT
                    count(*)::int AS total,
                    count(*) FILTER (WHERE status = 'unread')::int AS unread,
                    count(*) FILTER (WHERE priority = 'high')::int AS high_priority,
                    count(*) FILTER (WHERE priority = 'high' AND status = 'unread')::int AS high_priority_unread
                FROM gold.b2b_alerts
                WHERE vendor_id = ${vendorId}::uuid
            `);

            const row = result.rows?.[0] as any;
            return res.json({
                total: row?.total ?? 0,
                unread: row?.unread ?? 0,
                highPriority: row?.high_priority ?? 0,
                highPriorityUnread: row?.high_priority_unread ?? 0,
            });
        } catch (err: any) {
            console.error("[alerts] GET /summary error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to fetch alert summary" });
        }
    },
);

// ── PATCH /alerts/:id ───────────────────────────────────────────────────────
// Update alert status (read/dismissed). Sets read_at timestamp.
router.patch(
    "/:id",
    requireAuth as any,
    requirePermissionMiddleware("write:vendors") as any,
    async (req: Request, res: Response) => {
        try {
            const auth = (req as any).auth;
            const vendorId = auth.vendorId;
            const alertId = req.params.id;

            if (!vendorId) {
                return res.status(400).json({ code: "bad_request", detail: "Missing vendor context" });
            }
            if (!alertId) {
                return res.status(400).json({ code: "bad_request", detail: "Missing alert ID" });
            }

            const { status } = req.body || {};
            if (!status || !["read", "dismissed"].includes(status)) {
                return res.status(400).json({
                    code: "bad_request",
                    detail: "Body must include 'status' with value 'read' or 'dismissed'",
                });
            }

            // Verify alert belongs to this vendor before updating
            const result = await db.execute(sql`
                UPDATE gold.b2b_alerts
                SET status = ${status},
                    read_at = CASE WHEN ${status} IN ('read', 'dismissed') THEN now() ELSE read_at END
                WHERE id = ${alertId}::uuid
                  AND vendor_id = ${vendorId}::uuid
                RETURNING id, status, read_at
            `);

            if (!result.rows?.length) {
                return res.status(404).json({ code: "not_found", detail: "Alert not found or not owned by your vendor" });
            }

            return res.json({ ok: true, alert: result.rows[0] });
        } catch (err: any) {
            console.error("[alerts] PATCH /:id error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to update alert" });
        }
    },
);

// ── Helper: insert an alert (used from other modules) ───────────────────────
// Non-fatal: if the insert fails, it logs and returns null (never throws).
export async function insertAlert(opts: {
    vendorId: string;
    type: "quality" | "compliance" | "ingestion" | "match" | "system";
    priority?: "high" | "medium" | "low";
    title: string;
    description?: string;
    sourceTable?: string;
    sourceId?: string;
}): Promise<{ id: string } | null> {
    try {
        const result = await db.execute(sql`
            INSERT INTO gold.b2b_alerts (vendor_id, type, priority, title, description, source_table, source_id)
            VALUES (
                ${opts.vendorId}::uuid,
                ${opts.type},
                ${opts.priority || "medium"},
                ${opts.title.slice(0, 255)},
                ${opts.description || null},
                ${opts.sourceTable || null},
                ${opts.sourceId ? sql`${opts.sourceId}::uuid` : null}
            )
            RETURNING id
        `);
        return result.rows?.[0] as { id: string } | null;
    } catch (err: any) {
        console.warn("[alerts] insertAlert failed (non-fatal):", err?.message || err);
        return null;
    }
}

export default router;
