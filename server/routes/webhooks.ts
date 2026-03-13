// ─── Webhook Endpoints Router ────────────────────────────────────────────────
// CRUD management for vendor webhook endpoints + a /test action.
// Mounted at: POST/GET /api/v1/webhooks
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { requireAuth } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { webhookEndpoints } from "../../shared/schema.js";
import { and, eq } from "drizzle-orm";

const router = Router();

const ALLOWED_EVENTS = [
  "product.match.found",
  "import.completed",
  "compliance.alert",
  "customer.profile.updated",
  "quality.score.low",
];

function ok(res: any, data: any) {
  return res.json({ success: true, data });
}

function err(res: any, status: number, message: string) {
  return res.status(status).json({ success: false, error: message });
}

// ── GET /api/v1/webhooks ──────────────────────────────────────────────────────
router.get("/", requireAuth as any, async (req: any, res) => {
  try {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return err(res, 401, "Unauthorized");

    const endpoints = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.vendorId, vendorId))
      .orderBy(webhookEndpoints.createdAt);

    return ok(res, endpoints);
  } catch (e: any) {
    console.error("[webhooks] GET error:", e?.message);
    return err(res, 500, "Failed to load webhooks");
  }
});

// ── POST /api/v1/webhooks ─────────────────────────────────────────────────────
router.post("/", requireAuth as any, async (req: any, res) => {
  try {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return err(res, 401, "Unauthorized");

    const { url, description, events, enabled } = req.body ?? {};

    if (!url || typeof url !== "string" || !url.startsWith("http")) {
      return err(res, 400, "A valid http(s) URL is required");
    }

    const safeEvents: string[] = Array.isArray(events)
      ? events.filter((e: any) => typeof e === "string" && ALLOWED_EVENTS.includes(e))
      : ["product.match.found", "import.completed"];

    const [created] = await db
      .insert(webhookEndpoints)
      .values({
        vendorId,
        url: url.trim(),
        description: description ?? null,
        events: safeEvents,
        enabled: enabled !== false,
      })
      .returning();

    return res.status(201).json({ success: true, data: created });
  } catch (e: any) {
    console.error("[webhooks] POST error:", e?.message);
    return err(res, 500, "Failed to create webhook");
  }
});

// ── PUT /api/v1/webhooks/:id ──────────────────────────────────────────────────
router.put("/:id", requireAuth as any, async (req: any, res) => {
  try {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return err(res, 401, "Unauthorized");

    const { id } = req.params;
    const { url, description, events, enabled } = req.body ?? {};

    const existing = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.vendorId, vendorId)))
      .limit(1);

    if (!existing[0]) return err(res, 404, "Webhook not found");

    const updates: Partial<typeof webhookEndpoints.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (url !== undefined) {
      if (typeof url !== "string" || !url.startsWith("http")) {
        return err(res, 400, "A valid http(s) URL is required");
      }
      updates.url = url.trim();
    }
    if (description !== undefined) updates.description = description;
    if (enabled !== undefined) updates.enabled = Boolean(enabled);
    if (Array.isArray(events)) {
      updates.events = events.filter((e: any) => typeof e === "string" && ALLOWED_EVENTS.includes(e));
    }

    const [updated] = await db
      .update(webhookEndpoints)
      .set(updates)
      .where(eq(webhookEndpoints.id, id))
      .returning();

    return ok(res, updated);
  } catch (e: any) {
    console.error("[webhooks] PUT error:", e?.message);
    return err(res, 500, "Failed to update webhook");
  }
});

// ── DELETE /api/v1/webhooks/:id ───────────────────────────────────────────────
router.delete("/:id", requireAuth as any, async (req: any, res) => {
  try {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return err(res, 401, "Unauthorized");

    const { id } = req.params;

    const existing = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.vendorId, vendorId)))
      .limit(1);

    if (!existing[0]) return err(res, 404, "Webhook not found");

    await db
      .delete(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.vendorId, vendorId)));

    return ok(res, { deleted: id });
  } catch (e: any) {
    console.error("[webhooks] DELETE error:", e?.message);
    return err(res, 500, "Failed to delete webhook");
  }
});

// ── POST /api/v1/webhooks/:id/test ────────────────────────────────────────────
// Fires a test ping to the endpoint and returns the HTTP result.
router.post("/:id/test", requireAuth as any, async (req: any, res) => {
  try {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return err(res, 401, "Unauthorized");

    const { id } = req.params;

    const existing = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.vendorId, vendorId)))
      .limit(1);

    if (!existing[0]) return err(res, 404, "Webhook not found");

    const endpoint = existing[0];
    const testPayload = {
      eventType: "webhook.test",
      vendorId,
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      data: { message: "This is a test delivery from the B2B portal." },
    };

    let status: number | null = null;
    let responseBody = "";
    let success = false;

    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testPayload),
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
      responseBody = await response.text().catch(() => "");
      success = response.ok;
    } catch (fetchErr: any) {
      responseBody = fetchErr?.message ?? "Connection failed";
    }

    return ok(res, { success, status, responseBody });
  } catch (e: any) {
    console.error("[webhooks] TEST error:", e?.message);
    return err(res, 500, "Test delivery failed");
  }
});

export default router;
