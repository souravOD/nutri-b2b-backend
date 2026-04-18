// ─── Segments Router ──────────────────────────────────────────────────────────
// CRUD for vendor-scoped member segments + rule-based preview engine.
// Segments store a list of rules (field / op / value) and a logic combinator
// (AND | OR). The same rule engine is exported for use in campaigns.ts so that
// campaigns targeting a segment UUID resolve correctly.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { requireAuth, requirePermissionMiddleware } from "../lib/auth.js";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";

const router = Router();

// ── Types ────────────────────────────────────────────────────────────────────

export type RuleCondition = {
  field: string;
  op: "eq" | "neq" | "gte" | "lte" | "contains";
  value: string | number | boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whitelist of allowed field names to prevent SQL injection via field names.
const ALLOWED_FIELDS = new Set([
  "account_status",
  "age",
  "gender",
  "location_country",
  "location_city",
  "customer_tier",
  "has_health_profile",
  "created_at",
  "custom_tags",
]);

// Allowed ops per field type.
const STRING_OPS = new Set(["eq", "neq"]);
const NUMBER_OPS = new Set(["eq", "gte", "lte"]);
const DATE_OPS   = new Set(["gte", "lte"]);
const BOOL_OPS   = new Set(["eq"]);
const TAG_OPS    = new Set(["contains"]);

// ── Rule Engine ──────────────────────────────────────────────────────────────
// Builds a SQL WHERE fragment from an array of RuleCondition objects.
// Values are escaped manually — field names are whitelisted. Unknown fields
// or disallowed ops produce a safe 'true' fragment (never matches nothing).

function escapeString(v: unknown): string {
  return String(v).replace(/'/g, "''");
}

function ruleToSQL(r: RuleCondition): string {
  if (!ALLOWED_FIELDS.has(r.field)) return "true";

  switch (r.field) {
    case "account_status":
    case "gender":
    case "location_country":
    case "location_city":
    case "customer_tier": {
      if (!STRING_OPS.has(r.op)) return "true";
      const col = `c.${r.field}`;
      const op = r.op === "eq" ? "=" : "<>";
      return `${col} ${op} '${escapeString(r.value)}'`;
    }

    case "age": {
      if (!NUMBER_OPS.has(r.op)) return "true";
      const n = parseInt(String(r.value), 10);
      if (isNaN(n)) return "true";
      const op = r.op === "eq" ? "=" : r.op === "gte" ? ">=" : "<=";
      return `c.age ${op} ${n}`;
    }

    case "created_at": {
      if (!DATE_OPS.has(r.op)) return "true";
      // Validate ISO date format before injecting.
      const d = String(r.value);
      if (!/^\d{4}-\d{2}-\d{2}/.test(d)) return "true";
      const op = r.op === "gte" ? ">=" : "<=";
      return `c.created_at ${op} '${escapeString(d)}'::timestamptz`;
    }

    case "has_health_profile": {
      if (!BOOL_OPS.has(r.op)) return "true";
      const exists = `EXISTS (
        SELECT 1 FROM gold.b2b_customer_health_profiles hp
        WHERE hp.customer_id = c.id OR hp.b2b_customer_id = c.id
      )`;
      const want = r.value === true || r.value === "true";
      return want ? exists : `NOT ${exists}`;
    }

    case "custom_tags": {
      if (!TAG_OPS.has(r.op)) return "true";
      return `'${escapeString(r.value)}' = ANY(c.custom_tags)`;
    }

    default:
      return "true";
  }
}

export function buildWhereClause(rules: RuleCondition[], logic: "AND" | "OR"): string {
  if (!rules || rules.length === 0) return "true";
  const parts = rules.map(ruleToSQL);
  return `(${parts.join(` ${logic === "OR" ? "OR" : "AND"} `)})`;
}

// ── Shared count + members query ──────────────────────────────────────────────
async function resolveRules(
  vendorId: string,
  rules: RuleCondition[],
  logic: "AND" | "OR",
  excludeOptOut = false,
  limit: number | null = 100,
) {
  const whereClause = buildWhereClause(rules, logic);
  const optOutFilter = excludeOptOut
    ? `AND (c.email_opt_out IS NULL OR c.email_opt_out = false) AND c.email IS NOT NULL`
    : "";
  const limitClause = limit !== null ? `LIMIT ${limit}` : "";

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
    ${sql.raw(limitClause)}
  `);

  return { count, members: membersResult.rows ?? [] };
}

// ── Resolve a saved segment by ID (used by campaigns.ts) ─────────────────────
export async function resolveSegmentById(
  vendorId: string,
  segmentId: string,
  excludeOptOut = false,
  limit: number | null = 100,
) {
  const result = await db.execute(sql`
    SELECT rules, logic FROM gold.b2b_member_segments
    WHERE id = ${segmentId}::uuid AND vendor_id = ${vendorId}::uuid
  `);
  if (!result.rows?.length) return { count: 0, members: [] };
  const { rules, logic } = result.rows[0] as any;
  return resolveRules(vendorId, rules ?? [], logic ?? "AND", excludeOptOut, limit);
}

export async function resolveSegmentEmailsById(
  vendorId: string,
  segmentId: string,
): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT rules, logic FROM gold.b2b_member_segments
    WHERE id = ${segmentId}::uuid AND vendor_id = ${vendorId}::uuid
  `);
  if (!result.rows?.length) return [];
  const { rules, logic } = result.rows[0] as any;
  const { members } = await resolveRules(vendorId, rules ?? [], logic ?? "AND", true, null);
  return (members as any[]).map((m) => m.email).filter(Boolean);
}

// ── POST /segments/preview ────────────────────────────────────────────────────
// Preview member count for an unsaved set of rules. Does NOT persist anything.
router.post(
  "/preview",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    const { rules = [], logic = "AND" } = req.body || {};
    if (!Array.isArray(rules)) {
      return res.status(400).json({ code: "bad_request", detail: "rules must be an array" });
    }

    try {
      const { count } = await resolveRules(vendorId, rules, logic === "OR" ? "OR" : "AND");
      return res.json({ count });
    } catch (err: any) {
      console.error("[segments] POST /preview error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to preview segment" });
    }
  },
);

// ── GET /segments ─────────────────────────────────────────────────────────────
router.get(
  "/",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    try {
      const result = await db.execute(sql`
        SELECT id, name, description, logic, rules, member_count, created_at, updated_at
        FROM gold.b2b_member_segments
        WHERE vendor_id = ${vendorId}::uuid
        ORDER BY created_at DESC
      `);
      return res.json({ segments: result.rows ?? [] });
    } catch (err: any) {
      console.error("[segments] GET / error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to fetch segments" });
    }
  },
);

// ── POST /segments ────────────────────────────────────────────────────────────
router.post(
  "/",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    const { name, description = null, logic = "AND", rules = [] } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ code: "bad_request", detail: "name is required" });
    if (!Array.isArray(rules)) return res.status(400).json({ code: "bad_request", detail: "rules must be an array" });
    const logicVal: "AND" | "OR" = logic === "OR" ? "OR" : "AND";

    try {
      // Cache member count at save time.
      const { count } = await resolveRules(vendorId, rules, logicVal);

      const result = await db.execute(sql`
        INSERT INTO gold.b2b_member_segments
          (vendor_id, name, description, logic, rules, member_count)
        VALUES
          (${vendorId}::uuid, ${name.trim()}, ${description}, ${logicVal}, ${JSON.stringify(rules)}::jsonb, ${count})
        RETURNING id, name, description, logic, rules, member_count, created_at, updated_at
      `);
      return res.status(201).json({ segment: result.rows?.[0] });
    } catch (err: any) {
      console.error("[segments] POST / error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to create segment" });
    }
  },
);

// ── GET /segments/:id ─────────────────────────────────────────────────────────
router.get(
  "/:id",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ code: "bad_request", detail: "Invalid segment id" });

    try {
      const result = await db.execute(sql`
        SELECT id, name, description, logic, rules, member_count, created_at, updated_at
        FROM gold.b2b_member_segments
        WHERE id = ${id}::uuid AND vendor_id = ${vendorId}::uuid
      `);
      if (!result.rows?.length) return res.status(404).json({ code: "not_found", detail: "Segment not found" });
      return res.json({ segment: result.rows[0] });
    } catch (err: any) {
      console.error("[segments] GET /:id error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to fetch segment" });
    }
  },
);

// ── PUT /segments/:id ─────────────────────────────────────────────────────────
router.put(
  "/:id",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ code: "bad_request", detail: "Invalid segment id" });

    const { name, description = null, logic = "AND", rules = [] } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ code: "bad_request", detail: "name is required" });
    if (!Array.isArray(rules)) return res.status(400).json({ code: "bad_request", detail: "rules must be an array" });
    const logicVal: "AND" | "OR" = logic === "OR" ? "OR" : "AND";

    try {
      // Recache member count on update.
      const { count } = await resolveRules(vendorId, rules, logicVal);

      const result = await db.execute(sql`
        UPDATE gold.b2b_member_segments
        SET name = ${name.trim()},
            description = ${description},
            logic = ${logicVal},
            rules = ${JSON.stringify(rules)}::jsonb,
            member_count = ${count},
            updated_at = now()
        WHERE id = ${id}::uuid AND vendor_id = ${vendorId}::uuid
        RETURNING id, name, description, logic, rules, member_count, created_at, updated_at
      `);
      if (!result.rows?.length) return res.status(404).json({ code: "not_found", detail: "Segment not found" });
      return res.json({ segment: result.rows[0] });
    } catch (err: any) {
      console.error("[segments] PUT /:id error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to update segment" });
    }
  },
);

// ── DELETE /segments/:id ──────────────────────────────────────────────────────
router.delete(
  "/:id",
  requireAuth as any,
  requirePermissionMiddleware("manage:settings") as any,
  async (req: Request, res: Response) => {
    const vendorId = (req as any).auth?.vendorId;
    if (!vendorId) return res.status(403).json({ code: "forbidden", detail: "No vendor context" });

    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ code: "bad_request", detail: "Invalid segment id" });

    try {
      const result = await db.execute(sql`
        DELETE FROM gold.b2b_member_segments
        WHERE id = ${id}::uuid AND vendor_id = ${vendorId}::uuid
        RETURNING id
      `);
      if (!result.rows?.length) return res.status(404).json({ code: "not_found", detail: "Segment not found" });
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[segments] DELETE /:id error:", err?.message || err);
      return res.status(500).json({ code: "internal_error", detail: "Failed to delete segment" });
    }
  },
);

export default router;
