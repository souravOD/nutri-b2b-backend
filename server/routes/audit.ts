// ─── Audit Log Router ────────────────────────────────────────────────────────
// Phase 6: PRD 5 & 6 — REST endpoint for querying the gold.audit_log table.
//
// IMPORTANT: The write helper already exists in `server/lib/audit.ts`
// (`auditAction`, `auditRBACChange`, etc.).  This router only exposes
// the **read** side so the frontend can display the audit trail.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { requireAuth, requirePermissionMiddleware } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { auditLog } from "../../shared/schema.js";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

const router = Router();

// ── GET /audit ───────────────────────────────────────────────────────────────
// List audit entries with optional filters.
//
// Query params:
//   - entity    (string)   — filter by table_name (e.g. "b2b_user_links")
//   - entityId  (string)   — filter by record_id (uuid)
//   - action    (string)   — filter by action (INSERT/UPDATE/DELETE)
//   - from      (ISO 8601) — start of date range  (changed_at >=)
//   - to        (ISO 8601) — end of date range    (changed_at <=)
//   - limit     (number, default 50, max 100)
//   - offset    (number, default 0)
router.get(
    "/",
    requireAuth as any,
    requirePermissionMiddleware("read:audit") as any,
    async (req: Request, res: Response) => {
        try {
            // Parse query parameters
            const entity = req.query.entity as string | undefined;
            const entityId = req.query.entityId as string | undefined;
            const action = req.query.action as string | undefined;
            const from = req.query.from as string | undefined;
            const to = req.query.to as string | undefined;
            const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
            const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

            // Build dynamic WHERE conditions
            const conditions: any[] = [];

            if (entity) {
                conditions.push(eq(auditLog.tableName, entity));
            }
            if (entityId) {
                conditions.push(eq(auditLog.recordId, entityId));
            }
            if (action) {
                conditions.push(eq(auditLog.action, action));
            }
            if (from) {
                conditions.push(gte(auditLog.changedAt, new Date(from)));
            }
            if (to) {
                conditions.push(lte(auditLog.changedAt, new Date(to)));
            }

            // Count total
            const countQuery = conditions.length > 0
                ? db.select({ count: sql<number>`count(*)::int` }).from(auditLog).where(and(...conditions))
                : db.select({ count: sql<number>`count(*)::int` }).from(auditLog);
            const [countRow] = await countQuery;
            const total: number = countRow?.count ?? 0;

            // Fetch entries
            let dataQuery: any = db.select().from(auditLog);
            if (conditions.length > 0) {
                dataQuery = dataQuery.where(and(...conditions));
            }
            const rows = await dataQuery
                .orderBy(desc(auditLog.changedAt))
                .limit(limit)
                .offset(offset);

            const entries = rows.map((row: any) => ({
                id: row.id,
                tableName: row.tableName,
                recordId: row.recordId,
                action: row.action,
                oldValues: row.oldValues,
                newValues: row.newValues,
                changedBy: row.changedBy,
                changedAt: row.changedAt,
                ipAddress: row.ipAddress,
                userAgent: row.userAgent,
            }));

            return res.json({ entries, total, limit, offset });
        } catch (err: any) {
            console.error("[audit] GET / error:", err?.message || err);
            return res.status(500).json({ code: "internal_error", detail: "Failed to fetch audit log" });
        }
    }
);

export default router;
