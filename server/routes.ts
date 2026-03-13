import type { Express, Request, Response, NextFunction, RequestHandler } from "express";
import ingestRouter from "./routes/ingest.js";
import authContextRouter from "./routes/auth-context.js";
import invitationsRouter from "./routes/invitations.js";
import usersRouter from "./routes/users.js";
import vendorsRouter from "./routes/vendors.js";
import settingsRouter from "./routes/settings.js";
import rolePermissionsRouter from "./routes/role-permissions.js";
import auditRouter from "./routes/audit.js";
import qualityRouter from "./routes/quality.js";
import alertsRouter from "./routes/alerts.js";
import complianceRouter from "./routes/compliance.js";
import profileRouter from "./routes/profile.js";
import webhooksRouter from "./routes/webhooks.js";
import { storage } from "./storage.js";
import { extractJWT, requireAuth } from "./lib/auth.js";
import { and, eq, desc, sql, inArray } from "drizzle-orm";
import * as schema from "../shared/schema.js";
import { db } from "./lib/database.js";
import { supabaseAdmin } from "./lib/supabase.js";     // service-role client
import { triggerOrchestrator, getOrchestrationRunStatus, newRunId, checkOrchestratorHealth } from "./services/ingest-service.js";
import { getCircuitStatus, ragSearch, ragRecommend, ragMatch, ragChat, ragProductIntel, ragSubstitutions, ragSafetyCheck, ragSearchSuggest } from "./services/ragClient.js";
import { randomUUID } from "crypto";
import {
  addCreatorAsTeamAdmin,
  appwriteVendorSlugExists,
  createAppwriteTeam,
  createAppwriteVendorDocument,
  deleteAppwriteTeam,
  deleteAppwriteVendorDocument,
  getCurrentAppwriteUserFromJwt,
} from "./lib/appwriteAdmin.js";
import {
  deriveDomainFromEmail,
  isReservedVendorSlug,
  slugifyVendorName,
  withSlugSuffix,
} from "./lib/vendors.js";
import { validateVendorRegistrationInput } from "./lib/validators/vendorRegistration.js";
import { toGoldProductStatus, toGoldCustomerStatus, toGoldActivityLevel } from "./lib/gold-mappers.js";
import { safeErrorDetail } from "./lib/safe-error.js";
import multer from "multer";
import { ensureBucket } from "./lib/supabase.js";
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CSV_BUCKET = process.env.SUPABASE_CSV_BUCKET ?? "ingestion";
const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});


const MATCHING_ENABLED = process.env.B2B_ENABLE_MATCHING === "1";

/** PRD-10: In-memory store for chat report data keyed by session_id (for session-based export) */
const sessionReportStore = new Map<string, Record<string, unknown>[]>();

function structuredDataToReportRows(sd: any): Record<string, unknown>[] {
  if (!sd || typeof sd !== "object") return [];
  if (Array.isArray(sd.rows) && Array.isArray(sd.columns)) {
    return sd.rows.map((row: any[]) => {
      const obj: Record<string, unknown> = {};
      (sd.columns as string[]).forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  }
  if (Array.isArray(sd.items)) return sd.items;
  if (Array.isArray(sd.products)) return sd.products;
  if (Array.isArray(sd.customers)) return sd.customers;
  return [];
}


// const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
//   auth: { persistSession: false },
// });
// --- small helpers ---

function modeDir(mode?: string) {
  const m = String(mode || "").toLowerCase();
  if (m.startsWith("product")) return "product";
  if (m.startsWith("customer")) return "customers";
  if (m.startsWith("api")) return "apis";
  return "others";
}

function computeStoragePath(vendorId: string, jobId: string, mode?: string) {
  const dir = modeDir(mode);
  return `vendors/${vendorId}/${dir}/${jobId}_${dir}.csv`;
}

function sniffCsvHeadersFromBuffer(buf: Buffer): string[] {
  const firstLine = buf.toString("utf8").split(/\r?\n/)[0] || "";
  // simple CSV split with quotes
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') {
      if (inQ && firstLine[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
    } else if (ch === "," && !inQ) { out.push(cur.trim()); cur = ""; }
    else { cur += ch; }
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}


// ensureBucket is now imported from ./lib/supabase.js (M6 fix)

// ── Hoisted helpers (L5: previously duplicated in POST & PUT /products) ──
const toArr = (v: any): string[] | undefined => {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
};
const toNumStr = (n: any): string | undefined => {
  if (n === undefined || n === null || n === "") return undefined;
  const s = String(n);
  return isNaN(Number(s)) ? undefined : s;
};

function ok(res: Response, data: any) {
  return res.status(200).type("application/json").json(data);
}

// NORMALIZE service/fallback outputs to a plain array
const asArray = (x: any) => (Array.isArray(x) ? x : (x?.data ?? x?.items ?? []));

// Render a JS string[] as a Postgres text[] literal for Drizzle's sql template
const textArray = (a: string[]) =>
  (a && a.length)
    ? sql`ARRAY[${sql.join(a.map(x => sql`${x}`), sql`, `)}]::text[]`
    : sql`ARRAY[]::text[]`;

// Merge multiple Policy objects the same way the service does
type Policy = {
  hard_limits?: Record<string, number>;
  soft_limits?: Record<string, number>;
  required_tags?: string[];
  bonus_tags?: string[];
  penalty_tags?: string[];
};

function mergePolicies(policies: Policy[]): Policy {
  const out: Policy = { hard_limits: {}, soft_limits: {}, required_tags: [], bonus_tags: [], penalty_tags: [] };
  for (const p of policies) {
    if (p?.hard_limits) Object.assign(out.hard_limits!, p.hard_limits);
    if (p?.soft_limits) Object.assign(out.soft_limits!, p.soft_limits);
    if (p?.required_tags) out.required_tags!.push(...p.required_tags);
    if (p?.bonus_tags) out.bonus_tags!.push(...p.bonus_tags);
    if (p?.penalty_tags) out.penalty_tags!.push(...p.penalty_tags);
  }
  out.required_tags = Array.from(new Set(out.required_tags));
  out.bonus_tags = Array.from(new Set(out.bonus_tags));
  out.penalty_tags = Array.from(new Set(out.penalty_tags));
  return out;
}

// GUARANTEE both _score (0..1) and score_pct (0..100) for the client
const withScorePct = (p: any) => {
  const raw01 =
    typeof p?._score === "number" ? p._score :
      typeof p?.score === "number" ? p.score :
        (typeof p?.score_pct === "number" ? p.score_pct / 100 : undefined);
  if (raw01 == null) return p;
  const pct = Math.round(raw01 * 100);
  return { ...p, _score: raw01, score_pct: pct };
};

function toUiProductStatus(status?: string): "active" | "inactive" {
  const s = String(status || "active").toLowerCase();
  return s === "active" ? "active" : "inactive";
}

function toUiCustomerStatus(status?: string): "active" | "archived" {
  const s = String(status || "active").toLowerCase();
  return s === "active" ? "active" : "archived";
}

function toUiActivityLevel(activity?: string): "sedentary" | "light" | "moderate" | "very" | "extra" {
  const a = String(activity || "sedentary").toLowerCase();
  if (a === "lightly_active" || a === "light") return "light";
  if (a === "moderately_active" || a === "moderate") return "moderate";
  if (a === "very_active" || a === "very") return "very";
  if (a === "extra_active" || a === "extra") return "extra";
  return "sedentary";
}

/** Build nutrition object from inline columns when nutrition jsonb is empty (gold 2.sql style). */
function nutritionFromRow(row: any): Record<string, number> | null {
  const n = row?.nutrition;
  if (n && typeof n === "object" && Object.keys(n).length > 0) return n as Record<string, number>;
  const toNum = (v: any) => (v != null && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  const cal = toNum(row?.calories);
  const fat = toNum(row?.totalFatG ?? row?.total_fat_g);
  const sat = toNum(row?.saturatedFatG ?? row?.saturated_fat_g);
  const sod = toNum(row?.sodiumMg ?? row?.sodium_mg);
  const carbs = toNum(row?.totalCarbsG ?? row?.total_carbs_g);
  const sugar = toNum(row?.totalSugarsG ?? row?.total_sugars_g);
  const added = toNum(row?.addedSugarsG ?? row?.added_sugars_g);
  const protein = toNum(row?.proteinG ?? row?.protein_g);
  const pot = toNum(row?.potassiumMg ?? row?.potassium_mg);
  const phos = toNum(row?.phosphorusMg ?? row?.phosphorus_mg);
  const out: Record<string, number> = {};
  if (cal != null) out.calories = cal;
  if (fat != null) out.fat_g = fat;
  if (sat != null) out.saturated_fat_g = sat;
  if (sod != null) out.sodium_mg = sod;
  if (carbs != null) out.carbs_g = carbs;
  if (sugar != null) out.sugar_g = sugar;
  if (added != null) out.added_sugar_g = added;
  if (protein != null) out.protein_g = protein;
  if (pot != null) out.potassium_mg = pot;
  if (phos != null) out.phosphorus_mg = phos;
  return Object.keys(out).length > 0 ? out : null;
}

function mapProductForApi(row: any) {
  if (!row) return row;
  const nutrition = nutritionFromRow(row) ?? row.nutrition;
  const { calories, totalFatG, saturatedFatG, sodiumMg, totalCarbsG, totalSugarsG, addedSugarsG, proteinG, potassiumMg, phosphorusMg, ...rest } = row;
  return {
    ...rest,
    nutrition,
    imageUrl: row.imageUrl ?? row.image_url ?? null,
    status: toUiProductStatus(row.status),
  };
}

function mapCustomerForApi(row: any) {
  if (!row) return row;
  const mapped = {
    ...row,
    status: toUiCustomerStatus(row.accountStatus ?? row.account_status ?? row.status),
    account_status: row.accountStatus ?? row.account_status ?? null,
  } as any;

  if (mapped.healthProfile) {
    mapped.healthProfile = {
      ...mapped.healthProfile,
      activityLevel: toUiActivityLevel(
        mapped.healthProfile.activityLevel ?? mapped.healthProfile.activity_level
      ),
      activity_level: mapped.healthProfile.activityLevel ?? mapped.healthProfile.activity_level,
    };
  }

  return mapped;
}

function problem(res: Response, status: number, detail: string, req: Request) {
  return res
    .status(status)
    .type("application/problem+json")
    .json({
      type: "about:blank",
      title: status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Error",
      status,
      detail,
      instance: req.path,
    });
}

function adminError(res: Response, status: number, code: string, message: string, detail?: any) {
  return res.status(status).json({
    ok: false,
    code,
    message,
    ...(detail ? { detail } : {}),
  });
}

async function slugExistsInSupabase(slug: string): Promise<boolean> {
  const out = await db.execute(sql`
    SELECT 1
    FROM gold.vendors
    WHERE lower(slug) = lower(${slug})
    LIMIT 1
  `);
  return (out.rows || []).length > 0;
}

async function resolveUniqueVendorSlug(companyName: string): Promise<string> {
  const baseSlug = slugifyVendorName(companyName);
  if (isReservedVendorSlug(baseSlug)) {
    throw new Error("Generated slug is reserved.");
  }

  for (let attempt = 1; attempt <= 1000; attempt++) {
    const candidate = withSlugSuffix(baseSlug, attempt);
    if (isReservedVendorSlug(candidate)) continue;

    const [inAppwrite, inSupabase] = await Promise.all([
      appwriteVendorSlugExists(candidate),
      slugExistsInSupabase(candidate),
    ]);
    if (!inAppwrite && !inSupabase) return candidate;
  }

  throw new Error("Unable to generate a unique vendor slug.");
}

/**
 * Correct auth wrapper:
 * - delegates to requireAuth(req,res,next)
 * - surfaces auth on both res.locals.auth and req.auth (for backwards compatibility)
 */
const withAuth = (handler: RequestHandler): RequestHandler => {
  return (req: Request & { auth?: any }, res: Response, next: NextFunction) => {
    requireAuth(req, res, () => {
      // mirror onto req.auth for existing code that expects it
      try {
        if (!req.auth) req.auth = (res as any).locals?.auth;
      } catch { }
      Promise.resolve(handler(req, res, next)).catch(next);
    });
  };
};

// ---------- ROUTES ----------

export function registerRoutes(app: Express) {
  // ── Ingest API (v1) ──
  app.use("/api/v1/ingest", ingestRouter);
  app.use("/api/v1", ingestRouter);  // keys endpoints at /api/v1/keys

  // ── Auth context (role/permissions for frontend) ──
  app.use("/api/auth", authContextRouter);

  // ── Invitations CRUD ──
  app.use("/api/invitations", invitationsRouter);

  // ── Users CRUD ──
  app.use("/api/users", usersRouter);

  // ── Vendor Management ──
  app.use("/api/vendors", vendorsRouter);

  // ── Settings ──
  app.use("/api/settings", settingsRouter);
  app.use("/api/role-permissions", rolePermissionsRouter);

  // ── Audit Log ──
  app.use("/api/audit", auditRouter);

  // ── Quality Scores ──
  app.use("/api/quality", qualityRouter);

  // ── Alerts ──
  app.use("/api/alerts", alertsRouter);

  // ── Compliance ──
  app.use("/api/compliance", complianceRouter);

  // ── Profile ──
  app.use("/api/profile", profileRouter);

  // ── Webhooks ──
  app.use("/api/v1/webhooks", webhooksRouter);

  // health
  app.get("/health", (_req, res) => {
    ok(res, {
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? "dev",
    });
  });

  // Admin endpoint for circuit breaker diagnostics (PRD-01)
  app.get("/api/v1/admin/rag-status", withAuth(async (_req: any, res) => {
    ok(res, getCircuitStatus());
  }));

  // Admin endpoint for ingestion orchestrator connectivity
  app.get("/api/v1/admin/orchestrator-status", withAuth(async (_req: any, res) => {
    const status = await checkOrchestratorHealth();
    ok(res, status);
  }));

  // Search suggestions (PRD-03): "Did You Mean?" query expansion
  app.get("/api/v1/search/suggestions", withAuth(async (req: any, res) => {
    const q = (req.query.q as string)?.trim();
    const vendorId = req.auth?.vendorId;
    if (!q || q.length < 3) return ok(res, { suggestions: [], entities_found: null });
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const ragResult = await ragSearchSuggest({ query: q, vendor_id: vendorId });
    if (ragResult) return ok(res, ragResult);
    ok(res, { suggestions: [], entities_found: null, fallback: true });
  }));

  // Graph-enhanced product search (PRD-03): POST /api/v1/search/products
  app.post("/api/v1/search/products", withAuth(async (req: any, res) => {
    try {
      const vendorId = req.auth?.vendorId;
      if (!vendorId) return problem(res, 403, "No vendor access", req);

      const b = req.body ?? {};
      const query = (b.query as string)?.trim() || undefined;
      const filters = (b.filters && typeof b.filters === "object") ? b.filters : {};
      const limit = Math.min(200, Math.max(1, typeof b.limit === "number" ? b.limit : parseInt(String(b.limit || 20), 10) || 20));

      const brand = filters.brand ?? filters.Brand;
      const status = filters.status ?? filters.Status;
      const category_id = filters.category_id ?? filters.categoryId ?? filters.CategoryId;

      if (!query) {
        return problem(res, 400, "query is required", req);
      }

      const s: any = storage as any;

      // Same logic as GET /products when q is present: RAG first, then SQL fallback
      const ragResult = await ragSearch({
        query,
        vendor_id: vendorId,
        filters: { brand, status, category_id },
        limit,
      });

      if (ragResult?.results?.length) {
        const enriched: any[] = [];
        for (const r of ragResult.results) {
          const prod = await s.getProduct?.(r.id, vendorId);
          if (prod) {
            enriched.push({
              ...mapProductForApi(prod),
              _score: r.score,
              _reasons: r.reasons ?? [],
            });
          }
        }
        return ok(res, {
          results: enriched,
          query_interpretation: ragResult.query_interpretation ?? null,
        });
      }

      // SQL fallback
      if (typeof s.searchProducts === "function") {
        const itemsOrResult = await s.searchProducts(
          vendorId,
          query,
          { brand, status, categoryId: category_id, page: 1, pageSize: limit }
        );
        const data = (itemsOrResult?.items ?? itemsOrResult) || [];
        const arr = Array.isArray(data) ? data.map(mapProductForApi) : [];
        return ok(res, {
          results: arr.map((p: any) => ({ ...p, _score: null, _reasons: [] })),
          query_interpretation: null,
          fallback: true,
        });
      }

      if (typeof s.getProducts === "function") {
        const result = await s.getProducts(vendorId, { page: 1, pageSize: limit });
        const data = Array.isArray(result) ? result.map(mapProductForApi) : [];
        return ok(res, {
          results: data.map((p: any) => ({ ...p, _score: null, _reasons: [] })),
          query_interpretation: null,
          fallback: true,
        });
      }

      ok(res, { results: [], query_interpretation: null, fallback: true });
    } catch (err: any) {
      return problem(res, 500, safeErrorDetail(err, "Search failed"), req);
    }
  }));

  // Safety check (PRD-07): product-customer safety analysis
  const safetyCheckHandler = withAuth(async (req: any, res: Response) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const b = req.body ?? {};
    const ragResult = await ragSafetyCheck({
      vendor_id: vendorId,
      product_ids: Array.isArray(b.product_ids) ? b.product_ids : b.product_ids ? [b.product_ids] : undefined,
      customer_ids: Array.isArray(b.customer_ids) ? b.customer_ids : b.customer_ids ? [b.customer_ids] : undefined,
    });

    if (ragResult) return ok(res, ragResult);

    ok(res, { conflicts: [], summary: "Safety check unavailable", fallback: true });
  });

  app.post("/api/v1/safety-check", safetyCheckHandler);
  app.post("/api/v1/compliance/safety-check", safetyCheckHandler);

  // Chat (PRD-05): RAG chatbot proxy
  app.post("/api/v1/chat", withAuth(async (req: any, res) => {
    const { message, session_id } = req.body ?? {};
    const vendorId = req.auth?.vendorId;
    const userId = req.auth?.appwriteUserId ?? req.auth?.userId;

    if (!message?.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }
    if (!vendorId || !userId) {
      return problem(res, 403, "Vendor or user context required", req);
    }

    const ragResult = await ragChat({
      message: String(message).trim(),
      vendor_id: vendorId,
      user_id: userId,
      session_id: session_id || null,
    });

    if (!ragResult) {
      return ok(res, {
        response: "The chat service is temporarily unavailable. Please try again in a moment.",
        intent: null,
        session_id: session_id ?? null,
        fallback: true,
      });
    }

    // PRD-10: Store report data for session-based export
    const sid = ragResult.session_id ?? session_id;
    if (sid && typeof sid === "string") {
      const rows = Array.isArray(ragResult.report_data)
        ? ragResult.report_data
        : ragResult.structured_data
          ? structuredDataToReportRows(ragResult.structured_data)
          : [];
      if (rows.length > 0) sessionReportStore.set(sid, rows);
    }

    ok(res, ragResult);
  }));

  // Health analytics summary (PRD-06): allergen/condition/diet distribution for vendor
  app.get("/api/v1/analytics/health-summary", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    try {
      const [allergens, conditions, diets, totalCustomers] = await Promise.all([
        db.execute(sql`
          SELECT a.name, COUNT(DISTINCT ca.b2b_customer_id)::int AS customer_count
          FROM gold.b2b_customer_allergens ca
          JOIN gold.allergens a ON ca.allergen_id = a.id
          JOIN gold.b2b_customers c ON ca.b2b_customer_id = c.id
          WHERE c.vendor_id = ${vendorId}::uuid
          GROUP BY a.name ORDER BY customer_count DESC LIMIT 10
        `),
        db.execute(sql`
          SELECT hc.name, COUNT(DISTINCT chc.b2b_customer_id)::int AS customer_count
          FROM gold.b2b_customer_health_conditions chc
          JOIN gold.health_conditions hc ON chc.condition_id = hc.id
          JOIN gold.b2b_customers c ON chc.b2b_customer_id = c.id
          WHERE c.vendor_id = ${vendorId}::uuid
          GROUP BY hc.name ORDER BY customer_count DESC LIMIT 10
        `),
        db.execute(sql`
          SELECT dp.name, COUNT(DISTINCT cdp.b2b_customer_id)::int AS customer_count
          FROM gold.b2b_customer_dietary_preferences cdp
          JOIN gold.dietary_preferences dp ON cdp.diet_id = dp.id
          JOIN gold.b2b_customers c ON cdp.b2b_customer_id = c.id
          WHERE c.vendor_id = ${vendorId}::uuid
          GROUP BY dp.name ORDER BY customer_count DESC LIMIT 10
        `),
        db.execute(sql`
          SELECT COUNT(*)::int AS total FROM gold.b2b_customers
          WHERE vendor_id = ${vendorId}::uuid AND account_status = 'active'
        `),
      ]);

      ok(res, {
        allergen_distribution: (allergens.rows ?? []) as { name: string; customer_count: number }[],
        health_condition_distribution: (conditions.rows ?? []) as { name: string; customer_count: number }[],
        dietary_preference_distribution: (diets.rows ?? []) as { name: string; customer_count: number }[],
        total_customers: (totalCustomers.rows?.[0] as any)?.total ?? 0,
      });
    } catch (e: any) {
      problem(res, 500, safeErrorDetail(e, "Health summary failed"), req);
    }
  }));

  // Analytics overview: aggregated metrics over time (product/customer growth, ingestion runs)
  app.get("/api/v1/analytics/overview", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const days = Math.min(Math.max(parseInt(String(req.query.days || "30"), 10) || 30, 7), 90);

    try {
      const productTrend = await db.execute(sql`
        SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
        FROM gold.products
        WHERE vendor_id = ${vendorId}::uuid AND created_at >= now() - (${days}::text || ' days')::interval
        GROUP BY 1 ORDER BY 1
      `).catch(() => ({ rows: [] as any[] }));
      const customerTrend = await db.execute(sql`
        SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
        FROM gold.b2b_customers
        WHERE vendor_id = ${vendorId}::uuid AND created_at >= now() - (${days}::text || ' days')::interval
        GROUP BY 1 ORDER BY 1
      `).catch(() => ({ rows: [] as any[] }));
      const runTrend = await db.execute(sql`
        SELECT date_trunc('day', started_at)::date AS day, COUNT(*)::int AS count
        FROM orchestration.orchestration_runs
        WHERE vendor_id = ${vendorId}::uuid AND started_at >= now() - (${days}::text || ' days')::interval
        GROUP BY 1 ORDER BY 1
      `).catch(() => ({ rows: [] as any[] }));
      const totalProducts = await db.execute(sql`
        SELECT COUNT(*)::int AS count FROM gold.products WHERE vendor_id = ${vendorId}::uuid
      `).catch(() => ({ rows: [{ count: 0 }] as any[] }));
      const totalCustomers = await db.execute(sql`
        SELECT COUNT(*)::int AS count FROM gold.b2b_customers
        WHERE vendor_id = ${vendorId}::uuid AND account_status = 'active'
      `).catch(() => ({ rows: [{ count: 0 }] as any[] }));
      const totalJobs = await db.execute(sql`
        SELECT COUNT(*)::int AS count FROM public.ingestion_jobs
        WHERE vendor_id = ${vendorId}::uuid AND status = 'completed'
      `).catch(() => ({ rows: [{ count: 0 }] as any[] }));

      ok(res, {
        productTrend: (productTrend.rows ?? []) as { day: string; count: number }[],
        customerTrend: (customerTrend.rows ?? []) as { day: string; count: number }[],
        runTrend: (runTrend.rows ?? []) as { day: string; count: number }[],
        totals: {
          products: (totalProducts.rows?.[0] as any)?.count ?? 0,
          customers: (totalCustomers.rows?.[0] as any)?.count ?? 0,
          completedJobs: (totalJobs.rows?.[0] as any)?.count ?? 0,
        },
        days,
      });
    } catch (e: any) {
      problem(res, 500, safeErrorDetail(e, "Analytics overview failed"), req);
    }
  }));

  // Chat report export (PRD-10): CSV download from report data or session
  app.post("/api/v1/chat/export", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const b = req.body ?? {};
    let reportData = b.report_data ?? b.rows ?? b.data;

    // PRD-10: Session-based retrieval when report_data not in body
    if ((!Array.isArray(reportData) || reportData.length === 0) && b.session_id) {
      const stored = sessionReportStore.get(String(b.session_id));
      if (stored && stored.length > 0) reportData = stored;
    }

    const rawFilename = (b.filename as string) || `report-${Date.now()}.csv`;
    const filename = String(rawFilename).replace(/["\\\r\n\x00-\x1f]/g, "_").slice(0, 200) || "report.csv";

    if (!Array.isArray(reportData) || reportData.length === 0) {
      return res.status(400).json({ error: "report_data (array of rows) or session_id with stored report required for export" });
    }

    const headers = Object.keys(reportData[0] as object);
    const csvRows = [
      headers.map((h) => `"${String(h).replace(/"/g, '""')}"`).join(","),
      ...reportData.map((row: any) =>
        headers.map((h) => `"${String(row?.[h] ?? "").replace(/"/g, '""')}"`).join(",")
      ),
    ];
    const csv = csvRows.join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  }));

  // Public branding config (no auth) — used by login/register pages
  // ?slug=xxx → resolve vendorName from gold.vendors; copyright is generic
  app.get("/api/config/branding", async (req: Request, res: Response) => {
    const slug = (req.query.slug as string)?.trim();
    const GENERIC_COPYRIGHT = "© 2024. All rights reserved.";

    let vendorName: string | null = null;

    if (slug) {
      const row = await db.execute(sql`
        SELECT name FROM gold.vendors
        WHERE lower(slug) = lower(${slug}) AND status = 'active'
        LIMIT 1
      `);
      vendorName = (row.rows?.[0] as any)?.name?.trim() || null;
    }

    if (!vendorName) {
      vendorName = (process.env.VENDOR_NAME ?? "").trim() || null;
    }

    ok(res, {
      vendorName,
      copyrightText: GENERIC_COPYRIGHT,
    });
  });

  // metrics
  app.get("/metrics", withAuth(async (req: any, res) => {
    const s: any = storage as any;
    const vendorId = req.auth?.vendorId ?? null;

    if (typeof s.getSystemMetrics === "function") {
      try {
        const m = await s.getSystemMetrics(vendorId);
        return ok(res, {
          totalProducts: m.products ?? 0,
          activeCustomers: m.activeCustomers ?? 0,
          profilesWithMatchesPct: m.profilesWithMatchesPct ?? 0,
          pendingJobs: m.pendingJobs ?? 0,
          uptimeSec: Math.floor(process.uptime()),
          database: m.database,
        });
      } catch (e: any) {
        console.warn("[metrics] error:", e?.message || e);
      }
    }

    // fallback stub so the dashboard never breaks
    return ok(res, {
      totalProducts: 0,
      activeCustomers: 0,
      profilesWithMatchesPct: 0,
      pendingJobs: 0,
      uptimeSec: Math.floor(process.uptime()),
      api: "ok",
      vendorId,
    });
  }));

  // GET /vendors — list all vendors (direct SQL, avoids stale Drizzle schema)
  app.get("/vendors", withAuth(async (req: any, res) => {
    try {
      const result = await db.execute(sql`
        SELECT id, name, slug, status, team_id, billing_email,
               contact_email, country, api_endpoint, created_at, updated_at
        FROM gold.vendors
        ORDER BY created_at DESC
        LIMIT 200
      `);
      const data = (result.rows || []).map((r: any) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        teamId: r.team_id,
        billingEmail: r.billing_email,
        contactEmail: r.contact_email,
        country: r.country,
        apiEndpoint: r.api_endpoint,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      return ok(res, { data });
    } catch (e: any) {
      console.error("[vendors] GET error:", e?.message || e);
      return res.status(500).json({ error: "Failed to load vendors" });
    }
  }));

  app.post("/admin/vendors/register", withAuth(async (req: any, res) => {
    const traceId = randomUUID();
    const auth = req.auth;

    if (auth?.role !== "superadmin") {
      return adminError(res, 403, "forbidden", "Only superadmin can register vendors.");
    }

    const validated = validateVendorRegistrationInput(req.body ?? {});
    if (!validated.ok) {
      return adminError(res, 400, "invalid_input", validated.message);
    }

    const jwt = extractJWT(req);
    if (!jwt) {
      return adminError(res, 401, "invalid_token", "Missing Appwrite JWT.");
    }

    let appwriteUser: { id: string; email: string; name: string | null };
    try {
      appwriteUser = await getCurrentAppwriteUserFromJwt(jwt);
    } catch (err: any) {
      return adminError(res, 401, "invalid_token", err?.message || "Invalid Appwrite JWT.");
    }

    const input = validated.data;
    const domain = deriveDomainFromEmail(input.billingEmail);
    if (!domain) {
      return adminError(res, 400, "invalid_input", "billingEmail must contain a valid domain.");
    }

    let createdTeamId: string | null = null;
    let createdVendorDocId: string | null = null;
    let resolvedSlug = "";

    try {
      resolvedSlug = await resolveUniqueVendorSlug(input.companyName);

      const team = await createAppwriteTeam(input.companyName);
      createdTeamId = team.teamId;

      try {
        await addCreatorAsTeamAdmin(team.teamId, appwriteUser.id, appwriteUser.name);
      } catch (err: any) {
        try {
          await deleteAppwriteTeam(team.teamId);
        } catch {
          // no-op best effort rollback
        }
        console.error(
          JSON.stringify({
            trace_id: traceId,
            code: "appwrite_membership_create_failed",
            slug: resolvedSlug,
            team_id: team.teamId,
            owner_user_id: appwriteUser.id,
            rollback: true,
            error: err?.message || String(err),
          })
        );
        return adminError(res, 502, "appwrite_membership_create_failed", "Failed to add creator as team admin.");
      }

      // Only include fields that exist in the Appwrite vendors collection schema.
      // phone, country, timezone are NOT attributes in the Appwrite collection.
      const appwriteVendorPayload = {
        name: input.companyName,
        slug: resolvedSlug,
        billing_email: input.billingEmail,
        owner_user_id: appwriteUser.id,
        created_at: new Date().toISOString(),
        status: "active" as const,
        team_id: team.teamId,
        domains: [domain],
      };

      try {
        const doc = await createAppwriteVendorDocument(appwriteVendorPayload);
        createdVendorDocId = doc.documentId;
      } catch (err: any) {
        try {
          await deleteAppwriteTeam(team.teamId);
        } catch {
          // no-op best effort rollback
        }
        console.error(
          JSON.stringify({
            trace_id: traceId,
            code: "appwrite_vendor_create_failed",
            slug: resolvedSlug,
            team_id: team.teamId,
            owner_user_id: appwriteUser.id,
            rollback: true,
            error: err?.message || String(err),
          })
        );
        return adminError(res, 502, "appwrite_vendor_create_failed", "Failed to create vendor document in Appwrite.");
      }

      try {
        // Only insert columns that actually exist in gold.vendors.
        // phone and timezone columns do NOT exist in the table.
        const inserted = await db.execute(sql`
          INSERT INTO gold.vendors (
            name,
            slug,
            status,
            team_id,
            domains,
            owner_user_id,
            billing_email,
            contact_email,
            country
          )
          VALUES (
            ${input.companyName},
            ${resolvedSlug},
            'active',
            ${team.teamId},
            ${textArray([domain])},
            ${appwriteUser.id},
            ${input.billingEmail},
            ${input.billingEmail},
            ${input.country}
          )
          RETURNING id, name, slug, team_id, domains
        `);

        const vendor = inserted.rows?.[0] as any;
        console.info(
          JSON.stringify({
            trace_id: traceId,
            code: "vendor_registered",
            slug: resolvedSlug,
            team_id: team.teamId,
            owner_user_id: appwriteUser.id,
            rollback: false,
          })
        );

        return res.status(201).json({
          ok: true,
          vendor: {
            id: vendor.id,
            slug: vendor.slug,
            name: vendor.name,
            team_id: vendor.team_id,
            domains: vendor.domains || [domain],
          },
          appwrite: {
            vendor_doc_id: createdVendorDocId,
            team_id: team.teamId,
          },
        });
      } catch (err: any) {
        let rollbackError = "";
        try {
          if (createdVendorDocId) await deleteAppwriteVendorDocument(createdVendorDocId);
        } catch (rollbackErr: any) {
          rollbackError = `vendor_doc_rollback_failed:${rollbackErr?.message || String(rollbackErr)}`;
        }
        try {
          if (createdTeamId) await deleteAppwriteTeam(createdTeamId);
        } catch (rollbackErr: any) {
          rollbackError = rollbackError
            ? `${rollbackError};team_rollback_failed:${rollbackErr?.message || String(rollbackErr)}`
            : `team_rollback_failed:${rollbackErr?.message || String(rollbackErr)}`;
        }

        console.error(
          JSON.stringify({
            trace_id: traceId,
            code: "supabase_insert_failed_rolled_back",
            slug: resolvedSlug,
            team_id: createdTeamId,
            owner_user_id: appwriteUser.id,
            rollback: true,
            rollback_error: rollbackError || null,
            error: err?.message || String(err),
          })
        );

        return adminError(
          res,
          500,
          "supabase_insert_failed_rolled_back",
          "Failed to persist vendor in Supabase. Appwrite changes were rolled back.",
          rollbackError ? { rollback_error: rollbackError } : undefined
        );
      }
    } catch (err: any) {
      console.error(
        JSON.stringify({
          trace_id: traceId,
          code: "appwrite_team_create_failed",
          slug: resolvedSlug || null,
          team_id: createdTeamId,
          owner_user_id: appwriteUser.id,
          rollback: Boolean(createdTeamId),
          error: err?.message || String(err),
        })
      );
      return adminError(res, 502, "appwrite_team_create_failed", err?.message || "Failed to create Appwrite team.");
    }
  }));

  // products (list/search)
  app.get("/products", withAuth(async (req: any, res) => {
    try {
      const s: any = storage as any;
      const vendorId = req.auth?.vendorId;

      const page = Math.max(1, parseInt((req.query.page as string) || "1"));
      const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || "50")));

      const q = (req.query.q as string)?.trim() || undefined;
      const brand = (req.query.brand as string) || undefined;
      const status = (req.query.status as string) || undefined;
      const categoryId = (req.query.category_id as string) || undefined;

      // RAG integration (PRD-03): when search query present, try graph search first
      if (q && vendorId) {
        const ragResult = await ragSearch({
          query: q,
          vendor_id: vendorId,
          filters: { brand, status, category_id: categoryId },
          limit,
        });
        if (ragResult?.results?.length) {
          const enriched: any[] = [];
          for (const r of ragResult.results) {
            const prod = await s.getProduct?.(r.id, vendorId);
            if (prod) {
              enriched.push({
                ...mapProductForApi(prod),
                _score: r.score,
                _reasons: r.reasons ?? [],
              });
            }
          }
          return ok(res, {
            data: enriched,
            page,
            pageSize: limit,
            total: enriched.length,
            query_interpretation: ragResult.query_interpretation ?? null,
          });
        }
      }

      // SQL fallback: existing search/list path
      if ((q || brand || status || categoryId) && typeof s.searchProducts === "function") {
        const itemsOrResult = await s.searchProducts(
          vendorId,
          q ?? "",
          { brand, status, categoryId, page, pageSize: limit }
        );

        const data = (itemsOrResult?.items ?? itemsOrResult) || [];
        const total = itemsOrResult?.total ?? (Array.isArray(data) ? data.length : 0);

        return ok(res, { data: Array.isArray(data) ? data.map(mapProductForApi) : [], page, pageSize: limit, total });
      }

      if (typeof s.getProducts === "function") {
        const result = await s.getProducts(vendorId, { page, pageSize: limit });
        const data = Array.isArray(result) ? result.map(mapProductForApi) : [];
        return ok(res, data);
      }

      return ok(res, { data: [], page, pageSize: limit, total: 0 });
    } catch (err: any) {
      return problem(res, 500, safeErrorDetail(err, "Failed to load products"), req);
    }
  }));

  // product by id
  app.get("/products/:id", withAuth(async (req: any, res) => {
    try {
      const s: any = storage as any;
      const vendorId = req.auth?.vendorId;
      if (typeof s.getProduct === "function") {
        const product = await s.getProduct(req.params.id, vendorId);
        if (!product) return problem(res, 404, "Product not found", req);
        return ok(res, mapProductForApi(product));
      }
      return problem(res, 404, "Product not found", req);
    } catch (err: any) {
      return problem(res, 500, safeErrorDetail(err, "Failed to load product"), req);
    }
  }));

  // Product ingredient intelligence (PRD-08)
  const productIntelHandler = withAuth(async (req: any, res: Response) => {
    const productId = String(req.params.id);
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const s: any = storage as any;
    const product = typeof s.getProduct === "function" ? await s.getProduct(productId, vendorId) : null;
    if (!product) return problem(res, 404, "Product not found", req);

    const ragResult = await ragProductIntel({ product_id: productId, vendor_id: vendorId });
    if (ragResult) return ok(res, ragResult);

    ok(res, {
      ingredients: product.ingredients ?? [],
      allergens: product.allergens ?? [],
      diet_compatibility: product.dietaryTags ?? [],
      customer_suitability: null,
      fallback: true,
    });
  });

  app.get("/products/:id/intel", productIntelHandler);
  app.get("/api/v1/products/:id/intelligence", productIntelHandler);

  // PRD-04: POST /api/v1/products/:id/matching-customers (body: limit, includeWarnings, include_reasons)
  app.post("/api/v1/products/:id/matching-customers", withAuth(async (req: any, res) => {
    const productId = String(req.params.id);
    const vendorId = req.auth?.vendorId;
    const b = req.body ?? {};
    const limit = Math.min(100, Math.max(1, parseInt(b.limit ?? "50", 10) || 50));

    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const s: any = storage as any;
    const product = typeof s.getProduct === "function" ? await s.getProduct(productId, vendorId) : null;
    if (!product) return problem(res, 404, "Product not found", req);

    const ragResult = await ragMatch({
      product_id: productId,
      vendor_id: vendorId,
      limit,
    });
    if (ragResult?.customers?.length) return ok(res, ragResult);

    return ok(res, { customers: [], fallback: true, message: "Matching engine unavailable" });
  }));

  // Product-to-customer matching (PRD-04): which customers can safely use this product
  app.get("/products/:id/matching-customers", withAuth(async (req: any, res) => {
    const productId = String(req.params.id);
    const vendorId = req.auth?.vendorId;
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "50", 10) || 50));

    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const s: any = storage as any;
    const product = typeof s.getProduct === "function" ? await s.getProduct(productId, vendorId) : null;
    if (!product) return problem(res, 404, "Product not found", req);

    const ragResult = await ragMatch({
      product_id: productId,
      vendor_id: vendorId,
      limit,
    });
    if (ragResult?.customers?.length) return ok(res, ragResult);

    ok(res, { customers: [], fallback: true, message: "Matching engine unavailable" });
  }));

  // PRD-09: POST /api/v1/products/:id/substitutions (body: customer_id, limit)
  app.post("/api/v1/products/:id/substitutions", withAuth(async (req: any, res) => {
    const productId = String(req.params.id);
    const vendorId = req.auth?.vendorId;
    const b = req.body ?? {};
    const customerId = (b.customer_id as string) || undefined;
    const limit = Math.min(50, Math.max(1, parseInt(String(b.limit ?? "10"), 10) || 10));

    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const s: any = storage as any;
    const product = typeof s.getProduct === "function" ? await s.getProduct(productId, vendorId) : null;
    if (!product) return problem(res, 404, "Product not found", req);

    const ragResult = await ragSubstitutions({
      product_id: productId,
      vendor_id: vendorId,
      customer_id: customerId || undefined,
      limit,
    });
    if (ragResult?.substitutes?.length) return ok(res, ragResult);

    return ok(res, { substitutes: [], fallback: true });
  }));

  // Product substitutions (PRD-09)
  app.get("/products/:id/substitutions", withAuth(async (req: any, res) => {
    const productId = String(req.params.id);
    const vendorId = req.auth?.vendorId;
    const customerId = (req.query.customer_id as string) || undefined;
    const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) || "10", 10) || 10));

    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const s: any = storage as any;
    const product = typeof s.getProduct === "function" ? await s.getProduct(productId, vendorId) : null;
    if (!product) return problem(res, 404, "Product not found", req);

    const ragResult = await ragSubstitutions({
      product_id: productId,
      vendor_id: vendorId,
      customer_id: customerId || undefined,
      limit,
    });
    if (ragResult?.substitutes?.length) return ok(res, ragResult);

    ok(res, { substitutes: [], fallback: true });
  }));

  // --- CREATE product ---
  app.post("/products", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const b = req.body ?? {};

    // helpers (hoisted to file level — see toArr / toNumStr above)

    // accept sku/external_id/externalId, require both externalId and name
    const externalId = (b.external_id ?? b.externalId ?? b.sku ?? "").toString().trim();
    const name = (b.name ?? "").toString().trim();
    if (!externalId || !name) {
      return problem(res, 400, "Fields 'name' and 'external_id' (or 'sku') are required", req);
    }

    // map request -> InsertProduct (camelCase)
    const insert: schema.InsertProduct = {
      vendorId,
      externalId,
      name,
      description: b.description ?? null,
      brand: b.brand ?? null,
      status: toGoldProductStatus(b.status ?? "active"),

      categoryId: b.category_id ?? b.categoryId ?? null,
      subCategoryId: b.sub_category_id ?? b.subCategoryId ?? null,
      cuisineId: b.cuisine_id ?? b.cuisineId ?? null,
      marketId: b.market_id ?? b.marketId ?? null,

      barcode: b.barcode ?? null,
      gtinType: b.gtin_type ?? b.gtinType ?? null,          // enum: "UPC" | "EAN" | "ISBN" (or null)

      price: toNumStr(b.price) ?? null,                     // NUMERIC → send as string
      currency: (b.currency ?? undefined),                  // DB default 'USD' will apply if omitted

      servingSize: b.serving_size ?? b.servingSize ?? null,
      packageWeight: b.package_weight ?? b.packageWeight ?? null,

      nutrition: b.nutrition ?? null,                       // must be an object if provided

      dietaryTags: toArr(b.dietary_tags ?? b.dietaryTags ?? b.tags) ?? null,
      allergens: toArr(b.allergens) ?? null,
      certifications: toArr(b.certifications) ?? null,
      regulatoryCodes: toArr(b.regulatory_codes ?? b.regulatoryCodes) ?? null,

      // your schema has ingredients as a single text field
      ingredients: toArr(b.ingredients) ?? null,

      sourceUrl: b.source_url ?? b.sourceUrl ?? null,
    };

    try {
      const created = await storage.createProducts([insert]);
      return res.status(201).json(mapProductForApi(created[0]));
    } catch (e: any) {
      console.error("[POST /products]", e);
      return problem(res, 400, e?.message || "Create failed", req);
    }
  }));

  // --- UPDATE product ---
  app.put("/products/:id", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    const id = req.params.id;

    const b = req.body ?? {};
    // helpers (hoisted to file level — see toArr / toNumStr above)

    // Partial update (only apply provided fields)
    const updates: Partial<schema.InsertProduct> = {
      externalId: (b.external_id ?? b.externalId ?? b.sku ?? undefined),
      name: b.name ?? undefined,
      description: b.description ?? undefined,
      brand: b.brand ?? undefined,
      status: b.status !== undefined ? toGoldProductStatus(b.status) : undefined,

      categoryId: b.category_id ?? b.categoryId ?? undefined,
      subCategoryId: b.sub_category_id ?? b.subCategoryId ?? undefined,
      cuisineId: b.cuisine_id ?? b.cuisineId ?? undefined,
      marketId: b.market_id ?? b.marketId ?? undefined,

      barcode: b.barcode ?? undefined,
      gtinType: b.gtin_type ?? b.gtinType ?? undefined,

      price: toNumStr(b.price) ?? undefined,
      currency: (b.currency ?? undefined),

      servingSize: b.serving_size ?? b.servingSize ?? undefined,
      packageWeight: b.package_weight ?? b.packageWeight ?? undefined,

      nutrition: b.nutrition ?? undefined,

      dietaryTags: toArr(b.dietary_tags ?? b.dietaryTags ?? b.tags),
      allergens: toArr(b.allergens),
      certifications: toArr(b.certifications),
      regulatoryCodes: toArr(b.regulatory_codes ?? b.regulatoryCodes),

      ingredients: toArr(b.ingredients),

      sourceUrl: b.source_url ?? b.sourceUrl ?? undefined,
      notes: b.notes ?? undefined,
    };

    Object.keys(updates).forEach(k => (updates as any)[k] === undefined && delete (updates as any)[k]);

    try {
      const s: any = storage as any;
      if (typeof s.updateProduct !== "function") return problem(res, 404, "Update not supported", req);
      const updated = await s.updateProduct(id, vendorId, updates);
      if (!updated) return problem(res, 404, "Product not found", req);
      return ok(res, mapProductForApi(updated));
    } catch (err: any) {
      return problem(res, 500, safeErrorDetail(err, "Failed to update product"), req);
    }
  }));

  // --- DELETE product ---
  app.delete("/products/:id", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    const id = req.params.id;
    try {
      const s: any = storage as any;
      if (typeof s.deleteProduct !== "function") return problem(res, 404, "Delete not supported", req);
      const okDel = await s.deleteProduct(id, vendorId);
      if (!okDel) return problem(res, 404, "Product not found", req);
      return ok(res, { ok: true });
    } catch (err: any) {
      return problem(res, 500, safeErrorDetail(err, "Failed to delete product"), req);
    }
  }));

  // customers (paged)
  app.get("/customers", withAuth(async (req: any, res) => {
    try {
      const s: any = storage as any;
      const vendorId = req.auth?.vendorId ?? null;
      const id = (req.query.id as string) ?? "";
      if (id) {
        if (typeof s.getCustomer === "function") {
          const one = await storage.getCustomerWithProfile(id, vendorId);
          if (!one) return problem(res, 404, "Customer not found", req);
          return ok(res, mapCustomerForApi(one));
        }
        return problem(res, 404, "Customer not found", req);
      }

      const qRaw = (req.query.q as string) ?? "";
      const q = qRaw.trim();
      const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
      const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || "50", 10)));

      if (q) {
        const itemsOrArray =
          typeof s.searchCustomers === "function"
            ? await s.searchCustomers(vendorId, q, { limit, page })
            : await s.getCustomers(vendorId, { limit, page });

        const rows = (itemsOrArray?.items ?? itemsOrArray) || [];
        return ok(res, Array.isArray(rows) ? rows.map(mapCustomerForApi) : []);
      }

      const items = typeof s.getCustomersWithHealth === "function"
        ? await s.getCustomersWithHealth(vendorId, { page, pageSize: limit })
        : await s.getCustomers(vendorId, { page, pageSize: limit });
      return ok(res, Array.isArray(items) ? items.map(mapCustomerForApi) : []);
    } catch (err: any) {
      return problem(res, 500, safeErrorDetail(err, "Failed to load customers"), req);
    }
  }));

  // customer by id
  app.get("/customers/:id", withAuth(async (req: any, res) => {
    try {
      const s: any = storage as any;
      const vendorId = req.auth?.vendorId;
      if (typeof s.getCustomer === "function") {
        const customer = await storage.getCustomerWithProfile(req.params.id, vendorId);
        if (!customer) return problem(res, 404, "Customer not found", req);
        return ok(res, mapCustomerForApi(customer));
      }
      return problem(res, 404, "Customer not found", req);
    } catch (err: any) {
      return problem(res, 500, safeErrorDetail(err, "Failed to load customer"), req);
    }
  }));

  // PRD-02: GET /api/v1/customers/:id/recommendations (alias for /matching/:customerId)
  app.get("/api/v1/customers/:id/recommendations", withAuth(async (req: any, res) => {
    const customerId = String(req.params.id);
    if (!MATCHING_ENABLED) {
      return res.status(503).json({
        ok: false,
        code: "MATCHING_DISABLED",
        message: "Matching is temporarily disconnected. Neo4j integration is pending.",
      });
    }
    const limitRaw = Number(req.query.limit ?? req.query.top ?? 20);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 20;

    const row = await db
      .select({ vendorId: schema.customers.vendorId })
      .from(schema.customers)
      .where(eq(schema.customers.id, customerId))
      .limit(1);

    const vendorId: string | undefined = row?.[0]?.vendorId ?? req.auth?.vendorId;
    if (!vendorId) return ok(res, { products: [], explanation: null, fallback: true, message: "No vendor access" });

    const chpForRag = schema.customerHealthProfiles;
    const profileRow = await db
      .select({
        avoidAllergens: chpForRag.avoidAllergens,
        dietGoals: chpForRag.dietGoals,
        conditions: chpForRag.conditions,
        derivedLimits: chpForRag.derivedLimits,
        activityLevel: chpForRag.activityLevel,
        healthGoal: chpForRag.healthGoal,
      })
      .from(chpForRag)
      .where(eq(chpForRag.customerId, customerId))
      .limit(1);
    const hp = profileRow?.[0];
    const ragResult = await ragRecommend({
      b2b_customer_id: customerId,
      vendor_id: vendorId,
      allergens: hp?.avoidAllergens ?? [],
      health_conditions: hp?.conditions ?? [],
      dietary_preferences: hp?.dietGoals ?? [],
      health_profile: hp ? { derived_limits: hp.derivedLimits, activity_level: hp.activityLevel, health_goal: hp.healthGoal } : undefined,
      limit,
    });
    if (ragResult?.products?.length) {
      const s: any = storage as any;
      const enriched: any[] = [];
      for (const r of ragResult.products) {
        const prod = await s.getProduct?.(r.id, vendorId);
        if (prod) {
          enriched.push({
            ...mapProductForApi(prod),
            score: typeof r.score === "number" ? r.score : 0,
            reasons: r.reasons ?? [],
          });
        }
      }
      return ok(res, { products: enriched, explanation: ragResult.explanation ?? null, fallback: false });
    }

    let preferred: any[] = [];
    const USE_SERVICE = process.env.USE_MATCHING_SERVICE === "1";
    if (USE_SERVICE) {
      try {
        const svc = await import("./services/matching.js");
        if (typeof svc.getMatchesForCustomer === "function") {
          const raw = await svc.getMatchesForCustomer(vendorId, customerId, limit);
          preferred = asArray(raw).map(withScorePct).slice(0, limit);
        }
      } catch { /* fall through */ }
    }

    if (preferred.length > 0) {
      const products = preferred.map((p: any) => ({
        ...mapProductForApi(p),
        score: p._score ?? (typeof p.score_pct === "number" ? p.score_pct / 100 : 0),
        reasons: p._reasons ?? [],
      }));
      return ok(res, { products, explanation: null, fallback: true });
    }

    const chp = schema.customerHealthProfiles;
    const cx = await db
      .select({ avoidAllergens: chp.avoidAllergens, dietGoals: chp.dietGoals, derivedLimits: chp.derivedLimits, conditions: chp.conditions })
      .from(chp)
      .where(eq(chp.customerId, customerId))
      .limit(1);

    const avoidRaw = cx?.[0]?.avoidAllergens ?? [];
    const avoid: string[] = Array.isArray(avoidRaw) ? avoidRaw : [avoidRaw].filter(Boolean);
    const goals = cx?.[0]?.dietGoals ?? [];
    const limits = (cx?.[0]?.derivedLimits as any) ?? {};
    const conds = cx?.[0]?.conditions ?? [];

    const rules = conds.length
      ? await db
        .select({ policy: schema.dietRules.policy })
        .from(schema.dietRules)
        .where(and(
          eq(schema.dietRules.vendorId, vendorId),
          sql`${schema.dietRules.conditionCode} = ANY (${textArray(conds as string[])})`,
          eq(schema.dietRules.active, true)
        ))
      : [];

    const merged = mergePolicies((rules ?? []).map((r: any) => r.policy));
    const requiredTags: string[] = merged.required_tags ?? [];
    const preferTags: string[] = Array.from(new Set([...(merged.bonus_tags ?? []), ...goals]));
    const hardLimits: Record<string, number> = { ...(merged.hard_limits ?? {}), ...limits };

    const p = schema.products;
    const whereClause = requiredTags.length
      ? and(
        eq(p.vendorId, vendorId),
        eq(p.status, "active"),
        sql`NOT (coalesce(${p.allergens}, '{}') && ${textArray(avoid)})`,
        sql`${textArray(requiredTags)} <@ coalesce(${p.dietaryTags}, '{}')`
      )
      : and(
        eq(p.vendorId, vendorId),
        eq(p.status, "active"),
        sql`NOT (coalesce(${p.allergens}, '{}') && ${textArray(avoid)})`
      );

    const base = await db.select().from(p).where(whereClause).orderBy(desc(p.updatedAt)).limit(200);
    const now = Date.now();
    const items = base
      .map((r: any) => {
        for (const [k, lim] of Object.entries(hardLimits as Record<string, number>)) {
          const v = r?.nutrition?.[k];
          if (v != null && Number.isFinite(Number(v)) && Number(v) > Number(lim)) return null;
        }
        const tags: string[] = r.dietaryTags ?? [];
        const hit = preferTags.length ? preferTags.filter(g => tags.includes(g)).length / preferTags.length : 0;
        let penalty = 0;
        if (r?.nutrition?.sodium_mg != null && hardLimits?.sodium_mg) {
          const v = Number(r.nutrition.sodium_mg), L = Number(hardLimits.sodium_mg);
          if (Number.isFinite(v) && Number.isFinite(L) && L > 0) {
            penalty = Math.min(0.2, Math.max(0, ((v - 0.5 * L) / (0.5 * L)) * 0.2));
          }
        }
        const updated = r.updatedAt ? new Date(r.updatedAt).getTime() : now;
        const ageDays = Math.max(0, (now - updated) / 86_400_000);
        const recency = Math.max(0, 1 - Math.min(ageDays / 90, 1));
        const score01 = Math.max(0, Math.min(1, 0.6 + 0.4 * hit - penalty + 0.05 * recency));
        return { ...r, score: score01, reasons: [], _updatedAtMs: updated };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => (b.score - a.score) || (b._updatedAtMs - a._updatedAtMs))
      .slice(0, limit);

    const products = items.map((r: any) => ({
      ...mapProductForApi(r),
      score: r.score ?? 0,
      reasons: r.reasons ?? [],
    }));
    return ok(res, { products, explanation: null, fallback: true });
  }));

  // GET /taxonomy/diets?top=10[&all=1] (auth required, read-only dropdown data)
  app.get("/taxonomy/diets", withAuth(async (_req: any, res) => {
    const top = Number.isFinite(+_req.query.top) ? Math.max(1, +_req.query.top) : 10;
    const all = String(_req.query.all ?? "0") === "1";
    const q = await db.execute(sql`
      select code, name as label
      from gold.dietary_preferences
      order by name asc
      limit ${all ? 5000 : top}
    `);
    return ok(res, { data: (q.rows ?? []).map((r: any) => ({ code: r.code, label: r.label })) });
  }));

  // GET /taxonomy/allergens?top=10[&all=1] (auth required, read-only dropdown data)
  app.get("/taxonomy/allergens", withAuth(async (_req: any, res) => {
    const top = Number.isFinite(+_req.query.top) ? Math.max(1, +_req.query.top) : 10;
    const all = String(_req.query.all ?? "0") === "1";
    const q = await db.execute(sql`
      select code, name as label
      from gold.allergens
      order by name asc
      limit ${all ? 5000 : top}
    `);
    return ok(res, { data: (q.rows ?? []).map((r: any) => ({ code: r.code, label: r.label })) });
  }));

  // GET /taxonomy/conditions?top=10[&all=1] (auth required, read-only dropdown data)
  app.get("/taxonomy/conditions", withAuth(async (req: any, res) => {
    const top = Number.isFinite(+req.query.top) ? Math.max(1, +req.query.top) : 10;
    const all = String(req.query.all ?? "0") === "1";
    const q = await db.execute(sql`
      select code as condition_code, name as label
      from gold.health_conditions
      order by name asc
      limit ${all ? 5000 : top}
    `);
    return ok(res, { data: (q.rows ?? []).map((r: any) => ({ conditionCode: r.condition_code, label: r.label })) });
  }));

  // GET /taxonomy/debug (auth) - list codes/names for allergens and conditions to verify DB data
  app.get("/taxonomy/debug", withAuth(async (_req: any, res) => {
    try {
      const [allergens, conditions, diets] = await Promise.all([
        db.execute(sql`SELECT code, name FROM gold.allergens ORDER BY name ASC LIMIT 50`),
        db.execute(sql`SELECT code, name FROM gold.health_conditions ORDER BY name ASC LIMIT 50`),
        db.execute(sql`SELECT code, name FROM gold.dietary_preferences ORDER BY name ASC LIMIT 50`),
      ]);
      return ok(res, {
        allergens: (allergens.rows ?? []) as { code: string; name: string }[],
        conditions: (conditions.rows ?? []) as { code: string; name: string }[],
        diets: (diets.rows ?? []) as { code: string; name: string }[],
      });
    } catch (e: any) {
      return problem(res, 500, safeErrorDetail(e, "Taxonomy debug failed"), _req);
    }
  }));

  // GET /taxonomy/health-goals (auth required, read-only dropdown for Dietary Goals / health_goal)
  app.get("/taxonomy/health-goals", withAuth(async (_req: any, res) => {
    const goals = [
      { code: "weight_loss", label: "Weight Loss" },
      { code: "muscle_gain", label: "Muscle Gain" },
      { code: "keto", label: "Keto Diet" },
      { code: "maintenance", label: "Weight Maintenance" },
      { code: "heart_health", label: "Heart Health" },
      { code: "diabetes_management", label: "Diabetes Management" },
      { code: "low_sodium", label: "Low Sodium" },
      { code: "high_protein", label: "High Protein" },
      { code: "balanced", label: "Balanced Diet" },
      { code: "paleo", label: "Paleo" },
      { code: "mediterranean", label: "Mediterranean" },
      { code: "plant_based", label: "Plant Based" },
    ];
    return ok(res, { data: goals });
  }));

  // UPDATE customer (profile fields)
  app.patch("/customers/:id", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    const userId = req.auth?.userId ?? null;
    const id = String(req.params.id);
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const b = (req.body ?? {}) as any;

    // Normalize tags from multiple shapes → array
    const normalizeTags = (v: any): string[] | undefined => {
      if (Array.isArray(v)) return v.filter(Boolean);
      if (Array.isArray(b.customTags)) return b.customTags.filter(Boolean);
      if (typeof v === "string") {
        return v.split(",").map((s) => s.trim()).filter(Boolean);
      }
      return undefined;
    };

    // Build DB update object (snake_case column names)
    const updates: Partial<typeof schema.customers.$inferInsert> = {};

    if (b.fullName !== undefined || b.name !== undefined) {
      updates.fullName = String(b.fullName ?? b.name).trim();
    }
    if (b.email !== undefined) updates.email = String(b.email).trim();
    if (b.phone !== undefined) updates.phone = String(b.phone).trim();

    const tags = Array.isArray(b.tags) ? b.tags : b.customTags;
    if (tags !== undefined) updates.customTags = tags;

    if (b.notes !== undefined) updates.notes = String(b.notes);
    if (b.status !== undefined || b.account_status !== undefined) {
      updates.accountStatus = toGoldCustomerStatus(b.status ?? b.account_status);
    }

    // Location (map to individual columns; DB has no location jsonb)
    if (b.location && typeof b.location === "object") {
      const l = b.location;
      if (typeof l.country === "string" && l.country.trim()) updates.locationCountry = l.country.trim().toUpperCase();
      if (typeof l.state === "string" && l.state.trim()) updates.locationRegion = l.state.trim();
      if (typeof l.city === "string" && l.city.trim()) updates.locationCity = l.city.trim();
      if (typeof l.postal === "string" && l.postal.trim()) updates.locationPostalCode = l.postal.trim();
    }

    // Debug logging removed (M1 fix — was leaking PII)

    const base = await storage.updateCustomer(id, vendorId, updates);
    if (!base) return problem(res, 404, "Customer not found", req);

    try {
      const withHealth = await storage.getCustomerWithProfile(id, vendorId);
      return ok(res, mapCustomerForApi(withHealth ?? base));
    } catch (e: any) {
      console.error("[PATCH /customers/:id]", e);
      return problem(res, 400, e?.message || "Update failed", req);
    }
  }));

  // Customer-product notes endpoints
  app.get("/customers/:id/products/:productId/notes", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    const row = await (storage as any).getCustomerProductNote(String(req.params.id), String(req.params.productId), vendorId);
    return ok(res, row ?? { note: null });
  }));

  app.patch("/customers/:id/products/:productId/notes", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    const userId = req.auth?.userId ?? null;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    const note = (req.body?.note ?? req.body?.text ?? null) as string | null;
    const row = await (storage as any).upsertCustomerProductNote(
      vendorId,
      String(req.params.id),
      String(req.params.productId),
      note,
      userId,
    );
    return ok(res, row);
  }));

  // UPSERT health profile for a customer
  app.patch("/customers/:id/health", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    const userId = req.auth?.userId ?? null;
    const customerId = String(req.params.id);
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const b = req.body ?? {};

    // Coerce numbers reliably
    const toNum = (v: any) =>
      v === "" || v === null || v === undefined || Number.isNaN(Number(v))
        ? undefined
        : Number(v);

    // Normalize request -> camelCase fields expected by Drizzle
    const patch = {
      heightCm: toNum(b.heightCm ?? b.height_cm),
      weightKg: toNum(b.weightKg ?? b.weight_kg),
      age: b.age !== undefined ? toNum(b.age) : undefined,
      gender: b.gender ?? undefined,
      activityLevel: (b.activityLevel ?? b.activity_level) !== undefined
        ? toGoldActivityLevel(b.activityLevel ?? b.activity_level)
        : undefined,
      healthGoal: typeof b.healthGoal === "string" && b.healthGoal.trim() ? b.healthGoal.trim() : undefined,
      conditions: Array.isArray(b.conditions) ? b.conditions : undefined,
      dietGoals: Array.isArray(b.dietGoals) ? b.dietGoals : undefined,
      macroTargets: b.macroTargets ?? b.macro_targets ?? undefined, // jsonb
      avoidAllergens: Array.isArray(b.avoidAllergens) ? b.avoidAllergens : undefined,
      bmi: toNum(b.bmi),
      bmr: toNum(b.bmr),
      tdeeCached: toNum(b.tdeeCached ?? b.tdee_cached),
      derivedLimits: b.derivedLimits ?? b.derived_limits ?? undefined,
    };

    // Drop only undefined (so 0 / empty-arrays still update)
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined)
    );

    try {
      await storage.upsertCustomerHealth(customerId, vendorId, clean);
      const withProfile = await storage.getCustomerWithProfile(customerId, vendorId);
      const hp = withProfile?.healthProfile;
      return res.status(200).json({
        ...hp,
        activityLevel: toUiActivityLevel((hp as any)?.activityLevel ?? (hp as any)?.activity_level),
      });
    } catch (e: any) {
      return problem(res, 400, e?.message ?? "Health update failed", req);
    }
  }));

  // routes.ts
  app.post("/customers", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    const userId = req.auth?.userId ?? null;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const b = req.body ?? {};

    // Basic customer fields the form already collects
    const customerInput: Record<string, any> = {
      fullName: b.name ?? b.fullName,    // UI uses "name"
      email: b.email,
      phone: b.phone ?? null,
      // accept both `customTags` and legacy `tags`
      customTags: Array.isArray(b.customTags) ? b.customTags : (Array.isArray(b.tags) ? b.tags : []),
      // optional sync of age/gender to customers table if given in health
      age: b.health?.age ?? null,
      gender: b.health?.gender ?? null,
      status: b.status ?? "active",
    };
    // Location (city, state, postal, country)
    if (b.location && typeof b.location === "object") {
      const l = b.location;
      if (typeof l.city === "string" && l.city.trim()) customerInput.locationCity = l.city.trim();
      if (typeof l.state === "string" && l.state.trim()) customerInput.locationRegion = l.state.trim();
      if (typeof l.postal === "string" && l.postal.trim()) customerInput.locationPostalCode = l.postal.trim();
      if (typeof l.country === "string" && l.country.trim()) customerInput.locationCountry = l.country.trim().toUpperCase();
    }

    // Normalize health (optional block)
    const h = b.health ?? null;
    const toStr = (v: any) =>
      v === undefined || v === null ? null : typeof v === "number" ? String(v) : String(v);
    const toNum = (v: any) =>
      v === "" || v === null || v === undefined || Number.isNaN(Number(v)) ? undefined : Number(v);

    const healthInput = h
      ? {
        age: toNum(h.age),
        gender: h.gender ?? undefined,
        activityLevel: toGoldActivityLevel(h.activityLevel ?? undefined),
        heightCm: h.heightCm !== undefined ? toStr(h.heightCm) : undefined, // numeric -> string
        weightKg: h.weightKg !== undefined ? toStr(h.weightKg) : undefined, // numeric -> string
        healthGoal: typeof h.healthGoal === "string" && h.healthGoal.trim() ? h.healthGoal.trim() : undefined,
        conditions: Array.isArray(h.conditions) ? h.conditions : [],
        dietGoals: Array.isArray(h.dietGoals) ? h.dietGoals : [],
        avoidAllergens: Array.isArray(h.avoidAllergens) ? h.avoidAllergens : [],
        macroTargets: h.macroTargets ?? { protein_g: 0, carbs_g: 0, fat_g: 0, calories: 0 },
        bmi: h.bmi !== undefined ? toStr(h.bmi) : null,
        bmr: h.bmr !== undefined ? toStr(h.bmr) : null,
        tdeeCached: h.tdeeCached !== undefined ? toStr(h.tdeeCached) : null,
        derivedLimits: h.derivedLimits ?? null,
      }
      : null;

    try {
      const created = await storage.createCustomerWithHealth({
        vendorId,
        userId,
        customer: customerInput,
        health: healthInput,
      });
      // Return full profile with junction data (dietGoals, avoidAllergens, conditions)
      const full = await storage.getCustomerWithProfile(created.customer.id, vendorId);
      const merged = full ?? { ...created.customer, healthProfile: created.health };
      return res.status(201).json({
        customer: mapCustomerForApi(merged),
        health: merged?.healthProfile
          ? {
            ...merged.healthProfile,
            activityLevel: toUiActivityLevel((merged.healthProfile as any).activityLevel ?? (merged.healthProfile as any).activity_level),
          }
          : null,
      });
    } catch (e: any) {
      return problem(res, 400, e?.message ?? "Create customer failed", req);
    }
  }));


  // customer matches (uses services/matching if available)
  app.get("/matching/:customerId", withAuth(async (req: any, res) => {
    if (!MATCHING_ENABLED) {
      return res.status(503).json({
        ok: false,
        code: "MATCHING_DISABLED",
        message: "Matching is temporarily disconnected. Neo4j integration is pending.",
      });
    }
    const customerId = String(req.params.customerId);
    const limitRaw = Number(req.query.limit ?? req.query.top ?? 24);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 24;

    // 1) Source of truth: vendor from the *customer* row
    const row = await db
      .select({ vendorId: schema.customers.vendorId })
      .from(schema.customers)
      .where(eq(schema.customers.id, customerId))
      .limit(1);

    const vendorId: string | undefined = row?.[0]?.vendorId ?? req.auth?.vendorId;
    if (!vendorId) return ok(res, { data: [] });

    // RAG integration (PRD-02, PRD-04): try graph recommend first
    // customerHealthProfiles has no avoidAllergens/conditions/dietGoals columns;
    // those live in junction tables — use raw SQL to join them in one query.
    const profileRaw = await db.execute(sql`
      SELECT
        chp.activity_level   AS "activityLevel",
        chp.health_goal      AS "healthGoal",
        COALESCE(
          (SELECT array_agg(a.code)
           FROM gold.b2b_customer_allergens ca
           JOIN gold.allergens a ON a.id = ca.allergen_id
           WHERE ca.b2b_customer_id = chp.b2b_customer_id AND ca.is_active = true),
          '{}'::text[]
        ) AS "avoidAllergens",
        COALESCE(
          (SELECT array_agg(hc.code)
           FROM gold.b2b_customer_health_conditions cc
           JOIN gold.health_conditions hc ON hc.id = cc.condition_id
           WHERE cc.b2b_customer_id = chp.b2b_customer_id AND cc.is_active = true),
          '{}'::text[]
        ) AS "conditions",
        COALESCE(
          (SELECT array_agg(dp.code)
           FROM gold.b2b_customer_dietary_preferences cdp
           JOIN gold.dietary_preferences dp ON dp.id = cdp.diet_id
           WHERE cdp.b2b_customer_id = chp.b2b_customer_id AND cdp.is_active = true),
          '{}'::text[]
        ) AS "dietGoals"
      FROM gold.b2b_customer_health_profiles chp
      WHERE chp.b2b_customer_id = ${customerId}::uuid
      LIMIT 1
    `);
    const hp = (profileRaw.rows[0] as any) ?? null;
    const ragResult = await ragRecommend({
      b2b_customer_id: customerId,
      vendor_id: vendorId,
      allergens: hp?.avoidAllergens ?? [],
      health_conditions: hp?.conditions ?? [],
      dietary_preferences: hp?.dietGoals ?? [],
      health_profile: hp ? { derived_limits: hp.derivedLimits, activity_level: hp.activityLevel, health_goal: hp.healthGoal } : undefined,
      limit,
    });
    if (ragResult?.products?.length) {
      const s: any = storage as any;
      const enriched: any[] = [];
      for (const r of ragResult.products) {
        const prod = await s.getProduct?.(r.id, vendorId);
        if (prod) {
          enriched.push({
            ...mapProductForApi(prod),
            _score: r.score,
            score_pct: typeof r.score === "number" ? Math.round(r.score * 100) : r.score,
            _reasons: r.reasons ?? [],
          });
        }
      }
      return ok(res, { data: enriched, explanation: ragResult.explanation ?? null });
    }

    let preferred: any[] = [];
    // 2) Try the matching service
    const USE_SERVICE = process.env.USE_MATCHING_SERVICE === "1";
    if (USE_SERVICE) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const svc = await import("./services/matching.js");
        if (typeof svc.getMatchesForCustomer === "function") {
          const raw = await svc.getMatchesForCustomer(vendorId, customerId, limit);
          preferred = asArray(raw).map(withScorePct).slice(0, limit);
        }
      } catch {
        // swallow & continue to fallback
      }
    }

    // 3) Fallback: simple but faithful prefilter + scoring

    // Reuse health profile data fetched above (no second DB round-trip)
    const avoidRaw = hp?.avoidAllergens ?? [];
    const avoid: string[] = Array.isArray(avoidRaw) ? avoidRaw : [avoidRaw].filter(Boolean);
    const goals: string[] = hp?.dietGoals ?? [];
    const limits = {}; // derivedLimits not persisted in DB; hard limits come from dietRules only
    const conds: string[] = hp?.conditions ?? [];

    // Fetch vendor diet policies for the customer's conditions
    let rules: any[] = [];
    if (conds.length) {
      try {
        rules = await db
          .select({ policy: schema.dietRules.policy })
          .from(schema.dietRules)
          .where(and(
            eq(schema.dietRules.vendorId, vendorId),
            sql`${schema.dietRules.conditionCode} = ANY (${textArray(conds as string[])})`,
            eq(schema.dietRules.active, true)
          ));
      } catch {
        // diet_rules table not yet created in DB — skip policy filtering, fall back to allergen-only matching
        rules = [];
      }
    }

    // Merge policies into require/prefer/limits; combine with derivedLimits
    const merged = mergePolicies((rules ?? []).map((r: any) => r.policy));
    const requiredTags: string[] = merged.required_tags ?? [];
    const preferTags: string[] = Array.from(new Set([...(merged.bonus_tags ?? []), ...goals]));
    const hardLimits: Record<string, number> = { ...(merged.hard_limits ?? {}), ...limits };

    // gold.products has no allergens/dietary_tags columns — use junction tables
    const avoidSql = avoid.length
      ? sql`AND NOT EXISTS (
          SELECT 1 FROM gold.product_allergens pa
          JOIN gold.allergens a ON a.id = pa.allergen_id
          WHERE pa.product_id = p.id
            AND a.code = ANY(ARRAY[${sql.join(avoid.map((a: string) => sql`${a}`), sql`, `)}]::text[])
        )`
      : sql``;

    const reqSql = requiredTags.length
      ? sql`AND (
          SELECT COUNT(DISTINCT dp2.code)
          FROM gold.product_dietary_preferences pdp2
          JOIN gold.dietary_preferences dp2 ON dp2.id = pdp2.diet_id
          WHERE pdp2.product_id = p.id
            AND dp2.code = ANY(ARRAY[${sql.join(requiredTags.map((t: string) => sql`${t}`), sql`, `)}]::text[])
            AND pdp2.is_compatible = true
        ) = ${requiredTags.length}`
      : sql``;

    const rawResult = await db.execute(sql`
      SELECT
        p.id,
        p.vendor_id       AS "vendorId",
        p.external_id     AS "externalId",
        p.name,
        p.brand,
        p.description,
        p.category_id     AS "categoryId",
        p.price,
        p.currency,
        p.status,
        p.calories,
        p.protein_g       AS "proteinG",
        p.sodium_mg       AS "sodiumMg",
        p.total_fat_g     AS "totalFatG",
        p.image_url       AS "imageUrl",
        p.updated_at      AS "updatedAt",
        p.created_at      AS "createdAt",
        COALESCE(
          (SELECT array_agg(a.code)
           FROM gold.product_allergens pa
           JOIN gold.allergens a ON a.id = pa.allergen_id
           WHERE pa.product_id = p.id),
          '{}'::text[]
        ) AS "allergens",
        COALESCE(
          (SELECT array_agg(dp.code)
           FROM gold.product_dietary_preferences pdp
           JOIN gold.dietary_preferences dp ON dp.id = pdp.diet_id
           WHERE pdp.product_id = p.id AND pdp.is_compatible = true),
          '{}'::text[]
        ) AS "dietaryTags"
      FROM gold.products p
      WHERE p.vendor_id = ${vendorId}::uuid
        AND p.status = 'active'
        ${avoidSql}
        ${reqSql}
      ORDER BY p.updated_at DESC
      LIMIT 200
    `);
    const base: any[] = rawResult.rows as any[];

    // score like the service: preferences + small sodium penalty; only drop on *known* hard-limit exceed
    const now = Date.now();
    const items = base
      .map((r: any) => {
        // hard-limit reject only if value is known and exceeds (unchanged)
        for (const [k, lim] of Object.entries(hardLimits as Record<string, number>)) {
          const v = r?.nutrition?.[k];
          if (v != null && Number.isFinite(Number(v)) && Number(v) > Number(lim)) return null;
        }

        // preference hit (unchanged)
        const tags: string[] = r.dietaryTags ?? [];
        const hit = preferTags.length ? preferTags.filter(g => tags.includes(g)).length / preferTags.length : 0;

        // sodium soft penalty (unchanged)
        let penalty = 0;
        if (r?.nutrition?.sodium_mg != null && hardLimits?.sodium_mg) {
          const v = Number(r.nutrition.sodium_mg), L = Number(hardLimits.sodium_mg);
          if (Number.isFinite(v) && Number.isFinite(L) && L > 0) {
            penalty = Math.min(0.2, Math.max(0, ((v - 0.5 * L) / (0.5 * L)) * 0.2));
          }
        }

        // small recency boost
        const updated = r.updatedAt ? new Date(r.updatedAt).getTime() : now;
        const ageDays = Math.max(0, (now - updated) / 86_400_000);
        const recency = Math.max(0, 1 - Math.min(ageDays / 90, 1));

        const score01 = Math.max(0, Math.min(1, 0.6 + 0.4 * hit - penalty + 0.05 * recency));
        return { ...r, _score: score01, score_pct: Math.round(score01 * 100), _updatedAtMs: updated };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => (b._score - a._score) || (b._updatedAtMs - a._updatedAtMs))
      .slice(0, limit);

    return ok(res, { data: items });
  }));

  // PREVIEW matches with ad-hoc overrides (no persistence)
  // POST /matching/:customerId/preview
  app.post("/matching/:customerId/preview", withAuth(async (req: any, res) => {
    if (!MATCHING_ENABLED) {
      return res.status(503).json({
        ok: false,
        code: "MATCHING_DISABLED",
        message: "Matching preview is temporarily disconnected. Neo4j integration is pending.",
      });
    }
    try {
      const customerId = String(req.params.customerId);
      const limitRaw = Number(req.query.limit ?? req.body?.limit ?? 24);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 24;

      // Source vendor from the customer row
      const row = await db
        .select({ vendorId: schema.customers.vendorId })
        .from(schema.customers)
        .where(eq(schema.customers.id, customerId))
        .limit(1);
      const vendorId: string | undefined = row?.[0]?.vendorId ?? req.auth?.vendorId;
      if (!vendorId) return ok(res, { data: [] });

      // Load existing profile
      const chp = schema.customerHealthProfiles;
      const base = await db
        .select({
          avoidAllergens: chp.avoidAllergens,
          dietGoals: chp.dietGoals,
          conditions: chp.conditions,
          derivedLimits: chp.derivedLimits,
        })
        .from(chp)
        .where(eq(chp.customerId, customerId))
        .limit(1);

      const profile = {
        avoidAllergens: base?.[0]?.avoidAllergens ?? [],
        dietGoals: base?.[0]?.dietGoals ?? [],
        conditions: base?.[0]?.conditions ?? [],
        derivedLimits: (base?.[0]?.derivedLimits as any) ?? {},
      };

      // Merge overrides (from UI) WITHOUT persisting
      const b = (req.body ?? {}) as Partial<{ allergens: string[]; preferred: string[]; conditions: string[]; required: string[] }>;
      const fromRequired = (b.required ?? []).filter(s => /^no\s+/i.test(s)).map(s => s.replace(/^no\s+/i, ""));
      const preview = {
        avoidAllergens: Array.from(new Set([...(profile.avoidAllergens ?? []), ...(b.allergens ?? []), ...fromRequired])),
        dietGoals: Array.from(new Set([...(profile.dietGoals ?? []), ...(b.preferred ?? [])])),
        conditions: Array.from(new Set([...(profile.conditions ?? []), ...(b.conditions ?? [])])),
        derivedLimits: profile.derivedLimits ?? {},
      };

      // RAG integration (PRD-02, PRD-04): try graph recommend with preview overrides
      const ragResult = await ragRecommend({
        b2b_customer_id: customerId,
        vendor_id: vendorId,
        allergens: preview.avoidAllergens,
        health_conditions: preview.conditions,
        dietary_preferences: preview.dietGoals,
        health_profile: { derived_limits: preview.derivedLimits },
        limit,
      });
      if (ragResult?.products?.length) {
        const s: any = storage as any;
        const enriched: any[] = [];
        for (const r of ragResult.products) {
          const prod = await s.getProduct?.(r.id, vendorId);
          if (prod) {
            enriched.push({
              ...mapProductForApi(prod),
              _score: r.score,
              score_pct: typeof r.score === "number" ? Math.round(r.score * 100) : r.score,
              _reasons: r.reasons ?? [],
            });
          }
        }
        return ok(res, { data: enriched.slice(0, limit), explanation: ragResult.explanation ?? null });
      }

      // Prefer service helper if enabled
      if (process.env.USE_MATCHING_SERVICE === "1") {
        try {
          const svc = await import("./services/matching.js");
          if (typeof svc.getMatchesForCustomerWithOverrides === "function") {
            const out = await svc.getMatchesForCustomerWithOverrides(vendorId, customerId, preview, limit, req);
            return ok(res, { data: (out?.items ?? out ?? []).slice(0, limit) });
          }
        } catch { /* fall through to fallback */ }
      }

      // Fallback: apply vendor diet_rules + allergens + limits
      const rules = preview.conditions?.length
        ? await db.select({ policy: schema.dietRules.policy })
          .from(schema.dietRules)
          .where(and(
            eq(schema.dietRules.vendorId, vendorId),
            sql`${schema.dietRules.conditionCode} = ANY (${textArray(preview.conditions)})`,
            eq(schema.dietRules.active, true)
          ))
        : [];
      const merged = mergePolicies((rules ?? []).map((r: any) => r.policy));
      const requiredTags: string[] = merged.required_tags ?? [];
      const preferTags: string[] = Array.from(new Set([...(merged.bonus_tags ?? []), ...(preview.dietGoals ?? [])]));
      const hardLimits: Record<string, number> = { ...(merged.hard_limits ?? {}), ...(preview.derivedLimits ?? {}) };

      const p = schema.products;
      const conds: any[] = [
        eq(p.vendorId, vendorId),
        eq(p.status, "active"),
        sql`NOT (coalesce(${p.allergens}, '{}') && ${textArray(preview.avoidAllergens ?? [])})`,
      ];

      if (requiredTags.length) {
        conds.push(sql`${textArray(requiredTags)} <@ coalesce(${p.dietaryTags}, '{}')`);
      }

      const baseRows = await db
        .select()
        .from(p)
        .where(and(...conds))
        .orderBy(desc(p.updatedAt))
        .limit(500);

      const now = Date.now();
      const items = baseRows.map((r: any) => {
        // Hard drops on known hard-limit exceed
        for (const [k, lim] of Object.entries(hardLimits)) {
          const v = r?.nutrition?.[k];
          if (v != null && Number.isFinite(Number(v)) && Number(v) > Number(lim)) return null;
        }
        const tags: string[] = r.dietaryTags ?? [];
        const hit = preferTags.length ? preferTags.filter(t => tags.includes(t)).length / preferTags.length : 0;

        // light sodium soft-penalty if limit present
        let penalty = 0;
        if (r?.nutrition?.sodium_mg != null && hardLimits?.sodium_mg) {
          const v = Number(r.nutrition.sodium_mg), L = Number(hardLimits.sodium_mg);
          if (Number.isFinite(v) && Number.isFinite(L) && L > 0) {
            penalty = Math.min(0.2, Math.max(0, ((v - 0.5 * L) / (0.5 * L)) * 0.2));
          }
        }

        const updated = r.updatedAt ? new Date(r.updatedAt).getTime() : now;
        const ageDays = Math.max(0, (now - updated) / 86_400_000);
        const recency = Math.max(0, 1 - Math.min(ageDays / 90, 1));
        const score01 = Math.max(0, Math.min(1, 0.6 + 0.4 * hit - penalty + 0.05 * recency));
        return { ...r, _score: score01, score_pct: Math.round(score01 * 100), _updatedAtMs: updated };
      }).filter(Boolean)
        .sort((a: any, b: any) => (b._score - a._score) || (b._updatedAtMs - a._updatedAtMs))
        .slice(0, limit);

      return ok(res, { data: items });
    } catch (err: any) {
      // 🔴 without this, Express sends an HTML error page -> frontend .json() throws -> red popup
      const message = err?.message ?? String(err);
      return res.status(500).type("application/json").json({ error: message });
    }
  }));

  app.delete("/customers/:id", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    const id = String(req.params.id);
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const okDel = await storage.deleteCustomer(id, vendorId);
    if (!okDel) return problem(res, 404, "Customer not found", req);

    return res.status(204).send(); // Frontend accepts 204 or 200
  }));


  // ─────────────────────────────────────────────────────────────────────────────
  // Ingestion endpoints (backed by orchestration.* schema)
  // ─────────────────────────────────────────────────────────────────────────────

  // Create an upload target for a CSV import.
  // Returns the Supabase Storage bucket + path the frontend should upload to.
  app.post("/jobs", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId as string | undefined;
    if (!vendorId) return res.status(401).json({ message: "Missing vendor" });
    const mode = ((req.query.mode as string) || "products") as "products" | "customers" | "api_sync";

    const runId = newRunId();
    const storagePath = computeStoragePath(vendorId, runId, mode);
    await ensureBucket(CSV_BUCKET);

    return ok(res, { runId, bucket: CSV_BUCKET, path: storagePath, mode });
  }));

  type MulterRequest = Request & {
    file?: Express.Multer.File;
    files?: Express.Multer.File[];
  };

  // Upload CSV + trigger the orchestrator.
  // Returns the orchestration run_id for the frontend to poll.
  app.post("/jobs/upload",
    withAuth(async (req: any, res) => {
      // Auth runs FIRST, then multer parses upload — prevents unauthenticated file uploads
      await new Promise<void>((resolve, reject) => {
        uploadMw.single("file")(req, res, (err: any) => err ? reject(err) : resolve());
      });

      const vendorId = req.auth?.vendorId as string | undefined;
      if (!vendorId) return res.status(401).json({ message: "Missing vendor" });

      const mode = String(req.body?.mode || req.query.mode || "products");
      const bucket = String(req.body?.bucket || CSV_BUCKET);
      const storagePath = String(req.body?.path || req.query.path || "");

      if (!storagePath) {
        return res.status(400).json({ message: "Missing storage path. Call POST /jobs first." });
      }

      // Validate path belongs to this vendor (prevent path traversal)
      const expectedPrefix = `vendors/${vendorId}/`;
      if (!storagePath.startsWith(expectedPrefix)) {
        return res.status(403).json({ message: "Storage path does not belong to this vendor" });
      }

      // Validate file
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file || !file.buffer?.length) {
        return res.status(400).json({ message: "Missing CSV file in 'file' field" });
      }

      // 1. Ensure bucket exists
      try { await ensureBucket(bucket); } catch (_) { }

      // 2. Upload to Supabase Storage
      const { error: upErr } = await supabaseAdmin
        .storage
        .from(bucket)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype || "text/csv",
          upsert: true,
        });

      if (upErr) {
        console.error("[upload] Supabase upload failed:", upErr);
        return res.status(502).json({ message: `Storage upload failed: ${upErr.message}` });
      }

      // 3. Trigger orchestrator — it creates the orchestration_run and returns run_id
      try {
        const trigger = await triggerOrchestrator({
          flow_name: "full_ingestion",
          vendor_id: vendorId,
          source_name: mode,
          storage_bucket: bucket,
          storage_path: storagePath,
        });

        return ok(res, {
          run_id: trigger.run_id,
          status: trigger.status,
          flow_name: trigger.flow_name,
          bucket,
          path: storagePath,
          size: file.size,
          mime: file.mimetype || "text/csv",
        });
      } catch (triggerErr: any) {
        // Upload succeeded but orchestrator trigger failed.
        // Return partial success so the frontend knows the file is uploaded.
        console.error("[upload] Orchestrator trigger failed:", triggerErr);
        return res.status(202).json({
          message: "CSV uploaded but orchestrator trigger failed. The file is stored and can be retried.",
          bucket,
          path: storagePath,
          error: triggerErr?.message,
        });
      }
    })
  );

  // Get a single orchestration run (polled by the frontend wizard for progress)
  app.get("/jobs/:id", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId as string | undefined;
    const runId = String(req.params.id);
    if (!vendorId) return res.status(401).json({ message: "Missing vendor" });

    // Verify vendor ownership via DB (orchestrator response may omit vendor_id)
    const [dbRun] = await db.select({ vendorId: schema.orchestrationRuns.vendorId })
      .from(schema.orchestrationRuns)
      .where(eq(schema.orchestrationRuns.id, runId));
    if (!dbRun || dbRun.vendorId !== vendorId) {
      return res.status(404).json({ message: "Run not found" });
    }

    const run = await getOrchestrationRunStatus(runId);

    // Optionally fetch pipeline-level detail
    const pipelines = await db.select()
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.orchestrationRunId, runId))
      .orderBy(schema.pipelineRuns.createdAt);

    return ok(res, { ...run, pipelines });
  }));

  // Get errors for an orchestration run (step-level failure details)
  app.get("/jobs/:id/errors", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId as string | undefined;
    const runId = String(req.params.id);
    if (!vendorId) return res.status(401).json({ message: "Missing vendor" });

    // Verify vendor owns this run
    const [run] = await db.select({ vendorId: schema.orchestrationRuns.vendorId })
      .from(schema.orchestrationRuns)
      .where(eq(schema.orchestrationRuns.id, runId));
    if (!run || run.vendorId !== vendorId) {
      return res.status(404).json({ message: "Run not found" });
    }

    // Get all pipeline runs for this orchestration run
    const pipelines = await db.select({ id: schema.pipelineRuns.id })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.orchestrationRunId, runId));

    const pipelineIds = pipelines.map(p => p.id);
    if (!pipelineIds.length) {
      return ok(res, { data: [] });
    }

    // Get step logs for failed steps
    const stepLogs = await db.select()
      .from(schema.pipelineStepLogs)
      .where(
        and(
          inArray(schema.pipelineStepLogs.pipelineRunId, pipelineIds),
          eq(schema.pipelineStepLogs.status, "failed"),
        )
      );

    return ok(res, {
      data: stepLogs.map(s => ({
        stepName: s.stepName,
        status: s.status,
        errorMessage: s.errorMessage,
        // errorTraceback omitted — internal stack traces should not be exposed to tenants
        recordsIn: s.recordsIn,
        recordsOut: s.recordsOut,
        recordsError: s.recordsError,
        durationMs: s.durationMs,
      })),
    });
  }));

  // List orchestration runs for a vendor (Jobs page and Search)
  app.get("/jobs", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId as string;
    const statusFilter = (req.query.status as string) || undefined;
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 100;

    const conditions = [eq(schema.orchestrationRuns.vendorId, vendorId)];
    if (statusFilter) {
      // Map UI status names to orchestration status
      const statusMap: Record<string, string> = {
        running: "running",
        completed: "completed",
        failed: "failed",
        pending: "pending",
        queued: "pending",
        processing: "running",
      };
      const dbStatus = statusMap[statusFilter.toLowerCase()] || statusFilter;
      conditions.push(eq(schema.orchestrationRuns.status, dbStatus));
    }

    const runs = await db.select()
      .from(schema.orchestrationRuns)
      .where(and(...conditions))
      .orderBy(desc(schema.orchestrationRuns.createdAt))
      .limit(limit);

    return ok(res, { data: runs, page: 1, pageSize: runs.length, total: runs.length });
  }));

  // database health (if implemented)
  app.get("/database/health", withAuth(async (_req: any, res) => {
    const s: any = storage as any;
    if (typeof s.getDatabaseHealth === "function") {
      const health = await s.getDatabaseHealth(true);
      return ok(res, health);
    }
    return ok(res, { status: "unknown" });
  }));
}

