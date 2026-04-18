// ─── Campaigns Router ────────────────────────────────────────────────────────
// CRUD for vendor-scoped email/message campaigns
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { requireAuth, requirePermissionMiddleware } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";
import { sendBulkEmail } from "../services/email/bulk-sender.js";
import { renderCampaignEmail } from "../services/email/templates.js";
import { resolveSegmentById, resolveSegmentEmailsById } from "./segments.js";

const router = Router();

const VALID_SEGMENTS = ["all", "active", "with_profile", "inactive"] as const;
type Segment = typeof VALID_SEGMENTS[number];
const VALID_STATUSES = ["draft", "active", "sent"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidSegment(s: string): boolean {
  return VALID_SEGMENTS.includes(s as Segment) || UUID_RE.test(s);
}

// ── Segment SQL helper ───────────────────────────────────────────────────────
// Returns { count, members[] } for a vendor + segment combination.
// Pass excludeOptOut=true when sending to filter out email_opt_out customers.
// If segment is a UUID, resolves via the b2b_member_segments rule engine.
async function resolveSegment(vendorId: string, segment: string, excludeOptOut = false) {
  // Delegate to saved segment rule engine when segment is a UUID.
  if (UUID_RE.test(segment)) {
    return resolveSegmentById(vendorId, segment, excludeOptOut, 100);
  }

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

  // Compliance: exclude customers who have opted out of marketing emails.
  // Requires the email_opt_out column (migration: ALTER TABLE gold.b2b_customers ADD COLUMN email_opt_out BOOLEAN DEFAULT FALSE).
  const optOutFilter = excludeOptOut
    ? `AND (c.email_opt_out IS NULL OR c.email_opt_out = false) AND c.email IS NOT NULL`
    : "";

  const countResult = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM gold.b2b_customers c
    WHERE c.vendor_id = ${vendorId}::uuid
      AND ${sql.raw(whereClause)}
      ${sql.raw(optOutFilter)}
  `);
  const count = (countResult.rows?.[0] as any)?.count ?? 0;

  const membersResult = await db.execute(sql`
    SELECT c.id, c.first_name, c.last_name, c.email
    FROM gold.b2b_customers c
    WHERE c.vendor_id = ${vendorId}::uuid
      AND ${sql.raw(whereClause)}
      ${sql.raw(optOutFilter)}
    ORDER BY c.created_at DESC
    LIMIT 100
  `);
  return { count, members: membersResult.rows ?? [] };
}

// ── Send recipient resolver (no LIMIT) ───────────────────────────────────────
// Returns all opted-in emails for a segment. Used exclusively by the send endpoint.
// If segment is a UUID, resolves via the b2b_member_segments rule engine.
async function resolveAllRecipients(vendorId: string, segment: string): Promise<string[]> {
  if (UUID_RE.test(segment)) {
    return resolveSegmentEmailsById(vendorId, segment);
  }

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

  const result = await db.execute(sql`
    SELECT c.email
    FROM gold.b2b_customers c
    WHERE c.vendor_id = ${vendorId}::uuid
      AND c.email IS NOT NULL
      AND (c.email_opt_out IS NULL OR c.email_opt_out = false)
      AND ${sql.raw(whereClause)}
    ORDER BY c.id
  `);
  return (result.rows ?? []).map((r: any) => r.email).filter(Boolean);
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
    if (!isValidSegment(segment)) {
      return res.status(400).json({ code: "bad_request", detail: `segment must be one of: ${VALID_SEGMENTS.join(", ")} or a saved segment UUID` });
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
               recipient_count, ab_test_enabled, subject_b, message_b, created_at, updated_at
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

    const { name, target_segment = "all", subject, message, ab_test_enabled, subject_b, message_b } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ code: "bad_request", detail: "name is required" });
    if (!subject?.trim()) return res.status(400).json({ code: "bad_request", detail: "subject is required" });
    if (!message?.trim()) return res.status(400).json({ code: "bad_request", detail: "message is required" });
    if (!isValidSegment(target_segment)) {
      return res.status(400).json({ code: "bad_request", detail: `target_segment must be one of: ${VALID_SEGMENTS.join(", ")} or a saved segment UUID` });
    }
    const abEnabled = Boolean(ab_test_enabled);
    const subjectB = abEnabled ? (subject_b?.trim() ?? null) : null;
    const messageB = abEnabled ? (message_b?.trim() ?? null) : null;

    try {
      const result = await db.execute(sql`
        INSERT INTO gold.b2b_campaigns (vendor_id, name, target_segment, subject, message, ab_test_enabled, subject_b, message_b)
        VALUES (${vendorId}::uuid, ${name.trim()}, ${target_segment}, ${subject.trim()}, ${message.trim()}, ${abEnabled}, ${subjectB}, ${messageB})
        RETURNING id, name, target_segment, subject, message, status, sent_at,
                  recipient_count, ab_test_enabled, subject_b, message_b, created_at, updated_at
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
      const segment = (campaignResult.rows[0] as any).target_segment as string;
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
          const segment = (campaignResult.rows[0] as any).target_segment as string;
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

// ── POST /campaigns/:id/send ─────────────────────────────────────────────────
// Sends the campaign to all opted-in segment recipients via SendGrid.
// Guards against double-sends (409 if already sent).
router.post(
  "/:id/send",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    const { id } = req.params;
    try {
      // 1. Fetch campaign
      const campResult = await db.execute(sql`
        SELECT id, name, target_segment, subject, message, status
        FROM gold.b2b_campaigns
        WHERE id = ${id}::uuid AND vendor_id = ${vendorId}::uuid
      `);
      if (!campResult.rows?.length) {
        return res.status(404).json({ code: "not_found", detail: "Campaign not found" });
      }
      const campaign = campResult.rows[0] as any;
      if (campaign.status === "sent") {
        return res.status(409).json({ code: "already_sent", detail: "Campaign has already been sent" });
      }

      // 2. Resolve ALL opted-in recipients (no LIMIT — resolveSegment caps at 100 for previews)
      const emails = await resolveAllRecipients(vendorId, campaign.target_segment as string);
      if (!emails.length) {
        return res.status(422).json({ code: "no_recipients", detail: "No opted-in recipients found for this segment" });
      }

      // 3. Render and send
      const html = renderCampaignEmail(campaign.subject, campaign.message);
      const result = await sendBulkEmail(emails, campaign.subject, html);

      // 4. Mark campaign as sent
      await db.execute(sql`
        UPDATE gold.b2b_campaigns
        SET status = 'sent', sent_at = now(), recipient_count = ${emails.length}, updated_at = now()
        WHERE id = ${id}::uuid AND vendor_id = ${vendorId}::uuid
      `);

      return res.json({ ok: true, sent: result.sent, skipped: result.skipped });
    } catch (err: any) {
      console.error("[campaigns] POST /:id/send error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to send campaign" });
    }
  },
);

export default router;
