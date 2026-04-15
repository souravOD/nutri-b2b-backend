// ─── Reports Router ───────────────────────────────────────────────────────────
// Scheduled report CRUD + SendGrid event webhook for bounce/unsubscribe handling.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { requireAuth, requirePermissionMiddleware } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const router = Router();

const VALID_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
const VALID_FORMATS = ["csv", "pdf"] as const;
const VALID_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

// ── POST /reports/schedule ────────────────────────────────────────────────────
// Creates a new scheduled report for the current vendor.
router.post(
  "/schedule",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    const { frequency, format, recipients, day_of_week } = req.body ?? {};

    if (!frequency || !VALID_FREQUENCIES.includes(frequency)) {
      return res.status(400).json({ code: "bad_request", detail: `frequency must be one of: ${VALID_FREQUENCIES.join(", ")}` });
    }
    if (!format || !VALID_FORMATS.includes(format)) {
      return res.status(400).json({ code: "bad_request", detail: `format must be one of: ${VALID_FORMATS.join(", ")}` });
    }
    if (!recipients?.trim()) {
      return res.status(400).json({ code: "bad_request", detail: "recipients (email address) is required" });
    }
    if (frequency === "weekly" && day_of_week && !VALID_DAYS.includes(day_of_week)) {
      return res.status(400).json({ code: "bad_request", detail: `day_of_week must be one of: ${VALID_DAYS.join(", ")}` });
    }

    try {
      const result = await db.execute(sql`
        INSERT INTO gold.b2b_scheduled_reports (vendor_id, frequency, format, email, day_of_week, is_active)
        VALUES (
          ${vendorId}::uuid,
          ${frequency},
          ${format},
          ${recipients.trim()},
          ${day_of_week ?? null},
          true
        )
        RETURNING id, vendor_id, frequency, format, email, day_of_week, is_active, last_sent_at, created_at
      `);
      return res.status(201).json({ schedule: result.rows?.[0] });
    } catch (err: any) {
      logger.error(`[reports] POST /schedule error: ${err?.message}`);
      return res.status(500).json({ code: "internal_error", detail: "Failed to create scheduled report" });
    }
  },
);

// ── GET /reports/schedule ─────────────────────────────────────────────────────
// Lists all active scheduled reports for the current vendor.
router.get(
  "/schedule",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    try {
      const result = await db.execute(sql`
        SELECT id, frequency, format, email, day_of_week, is_active, last_sent_at, created_at
        FROM gold.b2b_scheduled_reports
        WHERE vendor_id = ${vendorId}::uuid
        ORDER BY created_at DESC
      `);
      return res.json({ schedules: result.rows ?? [] });
    } catch (err: any) {
      logger.error(`[reports] GET /schedule error: ${err?.message}`);
      return res.status(500).json({ code: "internal_error", detail: "Failed to fetch scheduled reports" });
    }
  },
);

// ── DELETE /reports/schedule/:id ──────────────────────────────────────────────
// Deactivates (soft-deletes) a scheduled report.
router.delete(
  "/schedule/:id",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    const { id } = req.params;
    try {
      const result = await db.execute(sql`
        UPDATE gold.b2b_scheduled_reports
        SET is_active = false
        WHERE id = ${id}::uuid AND vendor_id = ${vendorId}::uuid
        RETURNING id
      `);
      if (!result.rows?.length) {
        return res.status(404).json({ code: "not_found", detail: "Scheduled report not found" });
      }
      return res.json({ ok: true });
    } catch (err: any) {
      logger.error(`[reports] DELETE /schedule/${id} error: ${err?.message}`);
      return res.status(500).json({ code: "internal_error", detail: "Failed to delete scheduled report" });
    }
  },
);

// ── POST /reports/webhook/resend ─────────────────────────────────────────────
// Receives Resend event webhooks (bounce, spam complaint).
// Sets email_opt_out=true on the matching customer record for compliance.
// Register this URL in Resend dashboard: Domains → your domain → Webhooks.
// Events to subscribe: email.bounced, email.complained
router.post(
  "/webhook/resend",
  async (req: Request, res: Response) => {
    // Resend sends a single event object per request (not an array)
    const event = req.body ?? {};

    // Resend event types that require opt-out
    const OPT_OUT_TYPES = new Set(["email.bounced", "email.complained"]);

    if (!OPT_OUT_TYPES.has(event.type)) {
      return res.json({ ok: true, processed: 0 });
    }

    // Resend payload: { type, created_at, data: { email_id, from, to, subject, ... } }
    const toAddress = (event.data?.to ?? "").toLowerCase().trim();
    if (!toAddress) {
      return res.json({ ok: true, processed: 0 });
    }

    try {
      await db.execute(sql`
        UPDATE gold.b2b_customers
        SET email_opt_out = true
        WHERE lower(email) = ${toAddress}
      `);
      logger.info(`[reports/webhook] Opted out ${toAddress} (event: ${event.type})`);
      return res.json({ ok: true, processed: 1 });
    } catch (err: any) {
      logger.error(`[reports/webhook] Resend webhook error: ${err?.message}`);
      // Always return 200 to Resend to prevent retries
      return res.json({ ok: false, error: err?.message });
    }
  },
);

export default router;
