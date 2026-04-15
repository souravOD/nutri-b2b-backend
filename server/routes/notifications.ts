// ─── Notifications Router ─────────────────────────────────────────────────────
// Manages FCM device token registration and provides push send endpoints.
//
// POST   /register-token   — save a browser FCM token
// DELETE /register-token   — remove token on logout / permission revoked
// POST   /send             — vendor-admin: send push to a segment of customers
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { requireAuth, requirePermissionMiddleware } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";
import { sendPush } from "../services/push.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── POST /notifications/register-token ───────────────────────────────────────
// Upserts an FCM device token for the authenticated user.
// Body: { device_token: string, platform?: "web" | "ios" | "android" }
router.post(
  "/register-token",
  requireAuth as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    const userId   = (req as any).auth?.userId;

    if (!vendorId) {
      return res.status(403).json({ code: "forbidden", detail: "No vendor context" });
    }

    const { device_token, platform } = req.body ?? {};
    if (!device_token?.trim()) {
      return res.status(400).json({ code: "bad_request", detail: "device_token is required" });
    }

    const p = ["web", "ios", "android"].includes(platform) ? platform : "web";

    try {
      const result = await db.execute(sql`
        INSERT INTO gold.b2b_push_tokens (customer_id, vendor_id, device_token, platform)
        VALUES (${userId}::uuid, ${vendorId}::uuid, ${device_token.trim()}, ${p})
        ON CONFLICT (device_token)
          DO UPDATE SET customer_id = EXCLUDED.customer_id, updated_at = now()
        RETURNING id, platform
      `);
      return res.json({ ok: true, platform: result.rows?.[0]?.platform ?? p });
    } catch (err: any) {
      logger.error(`[notifications] register-token error: ${err.message}`);
      return res.status(500).json({ code: "internal_error", detail: "Failed to register device token" });
    }
  },
);

// ── DELETE /notifications/register-token ─────────────────────────────────────
// Removes an FCM token for the current user (call on logout or permission revoke).
// Body: { device_token: string }
router.delete(
  "/register-token",
  requireAuth as any,
  async (req: Request, res: Response) => {
    const userId = (req as any).auth?.userId;
    const { device_token } = req.body ?? {};

    if (!device_token?.trim()) {
      return res.status(400).json({ code: "bad_request", detail: "device_token is required" });
    }

    try {
      await db.execute(sql`
        DELETE FROM gold.b2b_push_tokens
        WHERE device_token = ${device_token.trim()}
          AND customer_id  = ${userId}::uuid
      `);
      return res.json({ ok: true });
    } catch (err: any) {
      logger.error(`[notifications] unregister-token error: ${err.message}`);
      return res.status(500).json({ code: "internal_error", detail: "Failed to unregister device token" });
    }
  },
);

// ── POST /notifications/send ──────────────────────────────────────────────────
// Vendor-admin: send a push notification to a segment of customers.
// Body: { title: string, body: string, data?: Record<string,string>, target_segment?: string }
router.post(
  "/send",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) {
      return res.status(403).json({ code: "forbidden", detail: "No vendor context" });
    }

    const { title, body, data, target_segment } = req.body ?? {};
    if (!title?.trim()) return res.status(400).json({ code: "bad_request", detail: "title is required" });
    if (!body?.trim())  return res.status(400).json({ code: "bad_request", detail: "body is required" });

    try {
      const result = await sendPush({
        title:         title.trim(),
        body:          body.trim(),
        data,
        vendorId,
        targetSegment: target_segment ?? "all",
      });

      // Audit log
      await db.execute(sql`
        INSERT INTO gold.audit_log (action, entity_type, entity_id, vendor_id, details)
        VALUES (
          'push_notification_sent',
          'notification',
          NULL,
          ${vendorId}::uuid,
          ${JSON.stringify({ title, sent: result.sent, errors: result.errors })}
        )
      `);

      return res.json({ ok: true, ...result });
    } catch (err: any) {
      logger.error(`[notifications] send error: ${err.message}`);
      return res.status(500).json({ code: "internal_error", detail: "Failed to send push notification" });
    }
  },
);

export default router;
