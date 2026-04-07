// ─── Campaigns Router ────────────────────────────────────────────────────────
// CRUD for vendor-scoped email/message campaigns
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { requireAuth, requirePermissionMiddleware } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";

const router = Router();

const VALID_SEGMENTS = ["all", "active", "with_profile", "inactive"] as const;
type Segment = typeof VALID_SEGMENTS[number];
const VALID_STATUSES = ["draft", "active", "sent"] as const;

// ── Segment SQL helper ───────────────────────────────────────────────────────
// Returns { count, members[] } for a vendor + segment combination
async function resolveSegment(vendorId: string, segment: Segment) {
  let whereClause: string;
  switch (segment) {
    case "active":
      whereClause = `c.account_status = 'active'`;
      break;
    case "inactive":
      whereClause = `c.account_status = 'inactive'`;
      break;
    case "with_profile":
      whereClause = `EXISTS (
        SELECT 1 FROM gold.b2b_customer_health_profiles hp
        WHERE hp.customer_id = c.id OR hp.b2b_customer_id = c.id
      )`;
      break;
    case "all":
    default:
      whereClause = `true`;
      break;
  }

  const countResult = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM gold.b2b_customers c
    WHERE c.vendor_id = ${vendorId}::uuid
      AND ${sql.raw(whereClause)}
  `);
  const count = (countResult.rows?.[0] as any)?.count ?? 0;

  const membersResult = await db.execute(sql`
    SELECT c.id, c.first_name, c.last_name, c.email
    FROM gold.b2b_customers c
    WHERE c.vendor_id = ${vendorId}::uuid
      AND ${sql.raw(whereClause)}
    ORDER BY c.created_at DESC
    LIMIT 100
  `);
  return { count, members: membersResult.rows ?? [] };
}

// ── GET /campaigns/segment-preview ──────────────────────────────────────────
// ?segment=all|active|inactive|with_profile
// Returns { count, segment } — used by the create dialog for live preview
router.get(
  "/segment-preview",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    const segment = (req.query.segment as string) ?? "all";
    if (!VALID_SEGMENTS.includes(segment as Segment)) {
      return res.status(400).json({ code: "bad_request", detail: `segment must be one of: ${VALID_SEGMENTS.join(", ")}` });
    }

    try {
      const { count } = await resolveSegment(vendorId, segment as Segment);
      return res.json({ segment, count });
    } catch (err: any) {
      console.error("[campaigns] GET /segment-preview error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to resolve segment" });
    }
  },
);

// ── GET /campaigns ───────────────────────────────────────────────────────────
router.get(
  "/",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });
    try {
      const result = await db.execute(sql`
        SELECT id, name, target_segment, subject, message, status, sent_at,
               recipient_count, created_at, updated_at
        FROM gold.b2b_campaigns
        WHERE vendor_id = ${vendorId}::uuid
        ORDER BY created_at DESC
      `);
      return res.json({ campaigns: result.rows ?? [] });
    } catch (err: any) {
      console.error("[campaigns] GET / error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to fetch campaigns" });
    }
  },
);

// ── POST /campaigns ──────────────────────────────────────────────────────────
router.post(
  "/",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    const { name, target_segment = "all", subject, message } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ code: "bad_request", detail: "name is required" });
    if (!subject?.trim()) return res.status(400).json({ code: "bad_request", detail: "subject is required" });
    if (!message?.trim()) return res.status(400).json({ code: "bad_request", detail: "message is required" });
    if (!VALID_SEGMENTS.includes(target_segment)) {
      return res.status(400).json({ code: "bad_request", detail: `target_segment must be one of: ${VALID_SEGMENTS.join(", ")}` });
    }

    try {
      const result = await db.execute(sql`
        INSERT INTO gold.b2b_campaigns (vendor_id, name, target_segment, subject, message)
        VALUES (${vendorId}::uuid, ${name.trim()}, ${target_segment}, ${subject.trim()}, ${message.trim()})
        RETURNING id, name, target_segment, subject, message, status, sent_at,
                  recipient_count, created_at, updated_at
      `);
      return res.status(201).json({ campaign: result.rows?.[0] });
    } catch (err: any) {
      console.error("[campaigns] POST / error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to create campaign" });
    }
  },
);

// ── GET /campaigns/:id/recipients ────────────────────────────────────────────
// Returns the resolved member list for a campaign's target_segment
router.get(
  "/:id/recipients",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    const { id } = req.params;
    try {
      const campaignResult = await db.execute(sql`
        SELECT target_segment FROM gold.b2b_campaigns
        WHERE id = ${id}::uuid AND vendor_id = ${vendorId}::uuid
      `);
      if (!campaignResult.rows?.length) {
        return res.status(404).json({ code: "not_found", detail: "Campaign not found" });
      }
      const segment = (campaignResult.rows[0] as any).target_segment as Segment;
      const { count, members } = await resolveSegment(vendorId, segment);
      return res.json({ segment, count, members });
    } catch (err: any) {
      console.error("[campaigns] GET /:id/recipients error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to resolve recipients" });
    }
  },
);

// ── PATCH /campaigns/:id ─────────────────────────────────────────────────────
router.patch(
  "/:id",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    const { id } = req.params;
    const { status } = req.body || {};
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ code: "bad_request", detail: `status must be one of: ${VALID_STATUSES.join(", ")}` });
    }

    try {
      // When activating, resolve the segment count and store it
      let recipientCount: number | null = null;
      if (status === "active") {
        const campaignResult = await db.execute(sql`
          SELECT target_segment FROM gold.b2b_campaigns
          WHERE id = ${id}::uuid AND vendor_id = ${vendorId}::uuid
        `);
        if (campaignResult.rows?.length) {
          const segment = (campaignResult.rows[0] as any).target_segment as Segment;
          const { count } = await resolveSegment(vendorId, segment);
          recipientCount = count;
        }
      }

      const result = await db.execute(sql`
        UPDATE gold.b2b_campaigns
        SET status = ${status},
            sent_at = CASE WHEN ${status} = 'sent' THEN now() ELSE sent_at END,
            recipient_count = CASE WHEN ${recipientCount !== null} THEN ${recipientCount} ELSE recipient_count END,
            updated_at = now()
        WHERE id = ${id}::uuid AND vendor_id = ${vendorId}::uuid
        RETURNING id, name, status, sent_at, recipient_count, updated_at
      `);
      if (!result.rows?.length) {
        return res.status(404).json({ code: "not_found", detail: "Campaign not found" });
      }
      return res.json({ campaign: result.rows[0] });
    } catch (err: any) {
      console.error("[campaigns] PATCH /:id error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to update campaign" });
    }
  },
);

// ── DELETE /campaigns/:id ────────────────────────────────────────────────────
router.delete(
  "/:id",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    const { id } = req.params;
    try {
      const result = await db.execute(sql`
        DELETE FROM gold.b2b_campaigns
        WHERE id = ${id}::uuid AND vendor_id = ${vendorId}::uuid AND status = 'draft'
        RETURNING id
      `);
      if (!result.rows?.length) {
        return res.status(404).json({ code: "not_found", detail: "Campaign not found or not in draft status" });
      }
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[campaigns] DELETE /:id error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to delete campaign" });
    }
  },
);

export default router;
