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
import campaignsRouter from "./routes/campaigns.js";
import segmentsRouter from "./routes/segments.js";
import reportsRouter from "./routes/reports.js";
import notificationsRouter from "./routes/notifications.js";
import complianceRouter from "./routes/compliance.js";
import profileRouter from "./routes/profile.js";
import webhooksRouter from "./routes/webhooks.js";
import { emitWebhookEvent } from "./lib/webhooks.js";
import { auditHealthAccess } from "./lib/audit.js";
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
import { ipAllowlistMiddleware } from "./middleware/ipAllowlist.js";
import multer from "multer";
import { ensureBucket } from "./lib/supabase.js";
import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CSV_BUCKET = process.env.SUPABASE_CSV_BUCKET ?? "ingestion";
const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});


const MATCHING_ENABLED = process.env.B2B_ENABLE_MATCHING === "1";

/** PRD-10: DB-backed store for chat report data (gold.b2b_chat_sessions).
 *  Falls back to in-memory Map if the table doesn't exist yet (pre-migration). */
const sessionReportStore = new Map<string, Record<string, unknown>[]>();

async function persistChatSession(
  sid: string, vendorId: string, userId: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO gold.b2b_chat_sessions (id, vendor_id, user_id, session_data, expires_at)
      VALUES (
        ${sid}::uuid, ${vendorId}::uuid, ${userId},
        ${JSON.stringify({ report_rows: rows })}::jsonb,
        NOW() + INTERVAL '30 minutes'
      )
      ON CONFLICT (id) DO UPDATE
        SET session_data = EXCLUDED.session_data,
            last_activity_at = NOW(),
            expires_at = NOW() + INTERVAL '30 minutes'
    `);
  } catch {
    // Table may not exist yet — in-memory fallback is already set above
  }
}

async function loadChatSession(
  sid: string, vendorId: string
): Promise<Record<string, unknown>[] | null> {
  try {
    const result = await db.execute(sql`
      SELECT session_data
      FROM gold.b2b_chat_sessions
      WHERE id = ${sid}::uuid
        AND vendor_id = ${vendorId}::uuid
        AND expires_at > NOW()
      LIMIT 1
    `);
    const row = (result.rows ?? result as any[])[0];
    if (!row) return null;
    const data = row.session_data as any;
    return Array.isArray(data?.report_rows) ? data.report_rows : null;
  } catch {
    return null;
  }
}

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
      // IP allowlist check — only enforced for vendors that have entries configured
      ipAllowlistMiddleware(req as any, res, () => {
        Promise.resolve(handler(req, res, next)).catch(next);
      });
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
  app.use("/api/v1/settings", settingsRouter);  // v1 alias used by frontend
  app.use("/api/role-permissions", rolePermissionsRouter);

  // ── Audit Log ──
  app.use("/api/audit", auditRouter);

  // ── Quality Scores ──
  app.use("/api/quality", qualityRouter);

  // ── Alerts ──
  app.use("/api/alerts", alertsRouter);
  app.use("/api/v1/alerts", alertsRouter);  // v1 alias used by frontend (app-shell banners, settings)

  // ── Campaigns ──
  app.use("/api/v1/campaigns", campaignsRouter);
  app.use("/api/v1/segments", segmentsRouter);

  // ── Reports (scheduled reports + SendGrid webhook) ──
  app.use("/api/v1/reports", reportsRouter);

  // ── Compliance ──
  app.use("/api/compliance", complianceRouter);

  // ── Profile ──
  app.use("/api/profile", profileRouter);

  // ── Webhooks ──
  app.use("/api/v1/webhooks", webhooksRouter);

  // ── Push Notifications ──
  app.use("/api/v1/notifications", notificationsRouter);

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

  // GET /api/v1/search/recent — fetch user's recent search queries (persistent)
  app.get("/api/v1/search/recent", withAuth(async (req: any, res) => {
    try {
      const userId = req.auth?.userId;
      if (!userId) return ok(res, { data: [] });
      const rows = await db
        .selectDistinctOn([schema.userSearches.query], {
          query: schema.userSearches.query,
          searchedAt: schema.userSearches.searchedAt,
        })
        .from(schema.userSearches)
        .where(eq(schema.userSearches.userId, userId))
        .orderBy(schema.userSearches.query, desc(schema.userSearches.searchedAt))
        .limit(10);
      const sorted = rows
        .sort((a, b) => new Date(b.searchedAt!).getTime() - new Date(a.searchedAt!).getTime())
        .slice(0, 5)
        .map(r => r.query);
      return ok(res, { data: sorted });
    } catch (err: any) {
      return ok(res, { data: [] });
    }
  }));

  // POST /api/v1/search/recent — save a search query for the current user
  app.post("/api/v1/search/recent", withAuth(async (req: any, res) => {
    try {
      const userId = req.auth?.userId;
      const vendorId = req.auth?.vendorId;
      const query = (req.body?.query as string)?.trim();
      if (!userId || !query || query.length < 2) return ok(res, { ok: true });
      await db.delete(schema.userSearches).where(
        and(eq(schema.userSearches.userId, userId), eq(schema.userSearches.query, query))
      );
      await db.insert(schema.userSearches).values({ userId, vendorId: vendorId ?? null, query });
      const all = await db
        .select({ id: schema.userSearches.id, searchedAt: schema.userSearches.searchedAt })
        .from(schema.userSearches)
        .where(eq(schema.userSearches.userId, userId))
        .orderBy(desc(schema.userSearches.searchedAt));
      if (all.length > 10) {
        const toDelete = all.slice(10).map(r => r.id);
        await db.delete(schema.userSearches).where(inArray(schema.userSearches.id, toDelete));
      }
      return ok(res, { ok: true });
    } catch {
      return ok(res, { ok: true });
    }
  }));

  // GET /api/v1/search/trending-categories — top categories by product count
  app.get("/api/v1/search/trending-categories", withAuth(async (req: any, res) => {
    try {
      const vendorId = req.auth?.vendorId;
      const rows = await db.execute(sql`
        SELECT
          pc.id,
          pc.slug AS code,
          pc.name AS label,
          pc.description,
          COUNT(p.id)::int AS product_count
        FROM gold.product_categories pc
        LEFT JOIN gold.products p
          ON p.category_id = pc.id
          AND p.vendor_id = ${vendorId}::uuid
          AND p.status = 'Active'
        WHERE pc.parent_category_id IS NULL
        GROUP BY pc.id, pc.slug, pc.name, pc.description
        ORDER BY product_count DESC
        LIMIT 8
      `);
      return ok(res, { data: rows.rows ?? rows });
    } catch (err: any) {
      return ok(res, { data: [] });
    }
  }));

  // GET /api/v1/search/popular-products — most recently active products (proxy for popular)
  app.get("/api/v1/search/popular-products", withAuth(async (req: any, res) => {
    try {
      const vendorId = req.auth?.vendorId;
      if (!vendorId) return ok(res, { data: [] });
      const limit = Math.min(20, parseInt(String(req.query.limit || 10), 10) || 10);
      const rows = await db.execute(sql`
        SELECT *
        FROM gold.products
        WHERE vendor_id = ${vendorId}::uuid AND status = 'Active'
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `);
      const data = (rows.rows ?? rows as any[]).map(mapProductForApi);
      return ok(res, { data });
    } catch (err: any) {
      return ok(res, { data: [] });
    }
  }));

  // GET /api/v1/search/suggested-vendors — top vendors (no ratings)
  app.get("/api/v1/search/suggested-vendors", withAuth(async (req: any, res) => {
    try {
      const limit = Math.min(10, parseInt(String(req.query.limit || 5), 10) || 5);
      const vendors = await storage.getVendors();
      const data = vendors.slice(0, limit).map(v => ({
        id: v.id,
        name: v.name,
        slug: v.slug,
        status: v.status,
        contactEmail: v.contactEmail,
      }));
      return ok(res, { data });
    } catch {
      return ok(res, { data: [] });
    }
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

    // PRD-10: Store report data for session-based export (DB + in-memory fallback)
    const sid = ragResult.session_id ?? session_id;
    if (sid && typeof sid === "string") {
      const rows = Array.isArray(ragResult.report_data)
        ? ragResult.report_data
        : ragResult.structured_data
          ? structuredDataToReportRows(ragResult.structured_data)
          : [];
      if (rows.length > 0) {
        sessionReportStore.set(sid, rows);
        persistChatSession(sid, vendorId, userId, rows);
      }
    }

    ok(res, ragResult);
  }));

  // Health analytics summary (PRD-06): allergen/condition/diet distribution for vendor
  app.get("/api/v1/analytics/health-summary", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    try {
      const K_ANON_MIN = 2; // suppress groups with fewer than 2 members (k-anonymity)

      const [allergens, conditions, diets, totalCustomers] = await Promise.all([
        db.execute(sql`
          SELECT a.name, COUNT(DISTINCT ca.b2b_customer_id)::int AS customer_count
          FROM gold.b2b_customer_allergens ca
          JOIN gold.allergens a ON ca.allergen_id = a.id
          JOIN gold.b2b_customers c ON ca.b2b_customer_id = c.id
          WHERE c.vendor_id = ${vendorId}::uuid
          GROUP BY a.name HAVING COUNT(DISTINCT ca.b2b_customer_id) >= ${K_ANON_MIN}
          ORDER BY customer_count DESC LIMIT 10
        `),
        db.execute(sql`
          SELECT hc.name, COUNT(DISTINCT chc.b2b_customer_id)::int AS customer_count
          FROM gold.b2b_customer_health_conditions chc
          JOIN gold.health_conditions hc ON chc.condition_id = hc.id
          JOIN gold.b2b_customers c ON chc.b2b_customer_id = c.id
          WHERE c.vendor_id = ${vendorId}::uuid
          GROUP BY hc.name HAVING COUNT(DISTINCT chc.b2b_customer_id) >= ${K_ANON_MIN}
          ORDER BY customer_count DESC LIMIT 10
        `),
        db.execute(sql`
          SELECT dp.name, COUNT(DISTINCT cdp.b2b_customer_id)::int AS customer_count
          FROM gold.b2b_customer_dietary_preferences cdp
          JOIN gold.dietary_preferences dp ON cdp.diet_id = dp.id
          JOIN gold.b2b_customers c ON cdp.b2b_customer_id = c.id
          WHERE c.vendor_id = ${vendorId}::uuid
          GROUP BY dp.name HAVING COUNT(DISTINCT cdp.b2b_customer_id) >= ${K_ANON_MIN}
          ORDER BY customer_count DESC LIMIT 10
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
        k_anonymity_threshold: K_ANON_MIN,
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

  // Engagement analytics: activation rate, status breakdown, quality score trend
  app.get("/api/v1/analytics/engagement", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const days = Math.min(Math.max(parseInt(String(req.query.days || "30"), 10) || 30, 7), 90);

    try {
      const [statusDist, activationRow, qualityTrend, newCustomersTrend] = await Promise.all([
        // Customer status distribution
        db.execute(sql`
          SELECT account_status, COUNT(*)::int AS count
          FROM gold.b2b_customers
          WHERE vendor_id = ${vendorId}::uuid
          GROUP BY account_status
        `).catch(() => ({ rows: [] as any[] })),

        // Activation rate: customers with ≥1 health profile entry
        db.execute(sql`
          SELECT
            COUNT(DISTINCT c.id)::int AS total,
            COUNT(DISTINCT hp.customer_id)::int AS with_profile
          FROM gold.b2b_customers c
          LEFT JOIN gold.b2b_customer_health_profiles hp ON hp.customer_id = c.id
          WHERE c.vendor_id = ${vendorId}::uuid
        `).catch(() => ({ rows: [{ total: 0, with_profile: 0 }] as any[] })),

        // Average quality score trend by day
        db.execute(sql`
          SELECT date_trunc('day', pqs.created_at)::date AS day,
                 ROUND(AVG(pqs.overall_score)::numeric, 2)::float AS avg_score
          FROM gold.product_quality_scores pqs
          JOIN gold.products p ON p.id = pqs.product_id
          WHERE p.vendor_id = ${vendorId}::uuid
            AND pqs.created_at >= now() - (${days}::text || ' days')::interval
          GROUP BY 1 ORDER BY 1
        `).catch(() => ({ rows: [] as any[] })),

        // New customers per day
        db.execute(sql`
          SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
          FROM gold.b2b_customers
          WHERE vendor_id = ${vendorId}::uuid
            AND created_at >= now() - (${days}::text || ' days')::interval
          GROUP BY 1 ORDER BY 1
        `).catch(() => ({ rows: [] as any[] })),
      ]);

      const statusMap: Record<string, number> = {};
      for (const row of (statusDist.rows ?? []) as any[]) {
        statusMap[String(row.account_status ?? "unknown")] = row.count ?? 0;
      }

      const ar = (activationRow.rows?.[0] as any) ?? { total: 0, with_profile: 0 };
      const activationRate = ar.total > 0
        ? Math.round((ar.with_profile / ar.total) * 1000) / 10
        : 0;

      ok(res, {
        statusDistribution: statusMap,
        activationRate,
        totalCustomers: ar.total,
        customersWithProfile: ar.with_profile,
        qualityScoreTrend: (qualityTrend.rows ?? []) as { day: string; avg_score: number }[],
        newCustomersTrend: (newCustomersTrend.rows ?? []) as { day: string; count: number }[],
        days,
      });
    } catch (e: any) {
      problem(res, 500, safeErrorDetail(e, "Engagement analytics failed"), req);
    }
  }));

  // Analytics CSV export (PRD-06): download analytics data as CSV
  // ?type=overview|engagement|health&days=30
  app.get("/api/v1/analytics/export", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const type = String(req.query.type || "overview");
    const days = Math.min(Math.max(parseInt(String(req.query.days || "30"), 10) || 30, 7), 90);
    const format = String(req.query.format || "csv").toLowerCase();

    try {
      // ── PDF: combined multi-section report ────────────────────────────────
      if (format === "pdf") {
        const dateStr = new Date().toISOString().slice(0, 10);
        const [ovProducts, ovCustomers, ovRuns, hlAllergens, hlConditions, hlDiets, engRow] = await Promise.all([
          db.execute(sql`
            SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS new_products
            FROM gold.products WHERE vendor_id = ${vendorId}::uuid
              AND created_at >= now() - (${days}::text || ' days')::interval
            GROUP BY 1 ORDER BY 1
          `).catch(() => ({ rows: [] as any[] })),
          db.execute(sql`
            SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS new_customers
            FROM gold.b2b_customers WHERE vendor_id = ${vendorId}::uuid
              AND created_at >= now() - (${days}::text || ' days')::interval
            GROUP BY 1 ORDER BY 1
          `).catch(() => ({ rows: [] as any[] })),
          db.execute(sql`
            SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
            FROM public.ingestion_jobs WHERE vendor_id = ${vendorId}::uuid
          `).catch(() => ({ rows: [{ total: 0, completed: 0 }] as any[] })),
          db.execute(sql`
            SELECT a.name, COUNT(DISTINCT ca.b2b_customer_id)::int AS customer_count
            FROM gold.b2b_customer_allergens ca
            JOIN gold.allergens a ON ca.allergen_id = a.id
            JOIN gold.b2b_customers c ON ca.b2b_customer_id = c.id
            WHERE c.vendor_id = ${vendorId}::uuid
            GROUP BY a.name HAVING COUNT(DISTINCT ca.b2b_customer_id) >= 5
            ORDER BY customer_count DESC LIMIT 10
          `).catch(() => ({ rows: [] as any[] })),
          db.execute(sql`
            SELECT hc.name, COUNT(DISTINCT chc.b2b_customer_id)::int AS customer_count
            FROM gold.b2b_customer_health_conditions chc
            JOIN gold.health_conditions hc ON chc.condition_id = hc.id
            JOIN gold.b2b_customers c ON chc.b2b_customer_id = c.id
            WHERE c.vendor_id = ${vendorId}::uuid
            GROUP BY hc.name HAVING COUNT(DISTINCT chc.b2b_customer_id) >= 5
            ORDER BY customer_count DESC LIMIT 10
          `).catch(() => ({ rows: [] as any[] })),
          db.execute(sql`
            SELECT dp.name, COUNT(DISTINCT cdp.b2b_customer_id)::int AS customer_count
            FROM gold.b2b_customer_dietary_preferences cdp
            JOIN gold.dietary_preferences dp ON cdp.diet_id = dp.id
            JOIN gold.b2b_customers c ON cdp.b2b_customer_id = c.id
            WHERE c.vendor_id = ${vendorId}::uuid
            GROUP BY dp.name HAVING COUNT(DISTINCT cdp.b2b_customer_id) >= 5
            ORDER BY customer_count DESC LIMIT 10
          `).catch(() => ({ rows: [] as any[] })),
          db.execute(sql`
            SELECT
              COUNT(DISTINCT c.id)::int AS total_customers,
              COUNT(DISTINCT hp.customer_id)::int AS with_profile,
              ROUND(COUNT(DISTINCT hp.customer_id)::numeric / NULLIF(COUNT(DISTINCT c.id), 0) * 100, 1) AS activation_rate
            FROM gold.b2b_customers c
            LEFT JOIN gold.b2b_customer_health_profiles hp ON hp.customer_id = c.id
            WHERE c.vendor_id = ${vendorId}::uuid
          `).catch(() => ({ rows: [{ total_customers: 0, with_profile: 0, activation_rate: 0 }] as any[] })),
        ]);

        // --- Load vendor branding ---
        const [brandingRows, vendorRow] = await Promise.all([
          db.execute(sql`
            SELECT key, value FROM gold.system_settings
            WHERE vendor_id = ${vendorId}::uuid
            AND key IN ('branding.primary_color', 'branding.logo_url', 'branding.secondary_color', 'branding.copyright')
          `).catch(() => ({ rows: [] })),
          db.execute(sql`
            SELECT name FROM gold.vendors WHERE id = ${vendorId}::uuid LIMIT 1
          `).catch(() => ({ rows: [] })),
        ]);

        const brandMap: Record<string, string> = {};
        for (const row of brandingRows.rows) {
          const v = row.value;
          brandMap[row.key as string] = typeof v === "string" ? v : (v as any)?.toString?.() ?? "";
        }

        const rawColor = (brandMap["branding.primary_color"] ?? "").trim();
        const primaryColor = /^#[0-9a-fA-F]{3,6}$/.test(rawColor) ? rawColor : "#00438f";
        const rawSecondary = (brandMap["branding.secondary_color"] ?? "").trim();
        const secondaryColor = /^#[0-9a-fA-F]{3,6}$/.test(rawSecondary) ? rawSecondary : "#6b7280";
        const logoUrl = brandMap["branding.logo_url"] ?? null;
        const copyrightText = brandMap["branding.copyright"] ?? "";
        const vendorName: string = (vendorRow.rows?.[0] as any)?.name ?? "Analytics Report";

        let logoBuffer: Buffer | null = null;
        if (logoUrl) {
          logoBuffer = await fetch(logoUrl)
            .then(r => r.ok ? r.arrayBuffer().then(ab => Buffer.from(ab)) : null)
            .catch(() => null);
        }
        // --- End branding load ---

        const doc = new PDFDocument({ margin: 50, size: "A4" });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="analytics-report-${dateStr}.pdf"`);
        doc.pipe(res);

        const blue = primaryColor;
        const gray = "#64748b";
        const lightGray = "#f1f5f9";

        let pageNum = 1;
        const pageW = doc.page.width;
        const pageH = doc.page.height;

        const addPageFooter = () => {
          const margin = 50;
          const fy = pageH - 35;
          doc.save()
            .moveTo(margin, fy - 6)
            .lineTo(pageW - margin, fy - 6)
            .strokeColor(secondaryColor).lineWidth(0.5).stroke()
            .restore();
          doc.fillColor(gray).fontSize(8).font("Helvetica")
            .text(vendorName, margin, fy, { width: 200, lineBreak: false });
          if (copyrightText) {
            doc.fillColor(gray).fontSize(8).font("Helvetica")
              .text(copyrightText, margin + 210, fy, { width: pageW - margin * 2 - 280, align: "center", lineBreak: false });
          }
          doc.fillColor(gray).fontSize(8).font("Helvetica")
            .text(`Page ${pageNum}`, pageW - margin - 50, fy, { width: 50, align: "right", lineBreak: false });
        };

        // ── Cover ──
        doc.rect(0, 0, pageW, 120).fill(blue);
        if (logoBuffer) {
          doc.image(logoBuffer, pageW - 160, 50, { width: 100, fit: [100, 50] });
        }
        doc.fillColor("white").fontSize(24).font("Helvetica-Bold")
          .text("Analytics Report", 50, 40, { align: "left" });
        doc.fontSize(12).font("Helvetica")
          .text(`Generated: ${dateStr}  ·  Period: Last ${days} days`, 50, 75);
        doc.fontSize(11).font("Helvetica")
          .text(vendorName, 50, 95);
        doc.fillColor("#0f172a").moveDown(3);

        const sectionTitle = (title: string) => {
          doc.moveDown(0.5)
            .fontSize(14).font("Helvetica-Bold").fillColor(blue)
            .text(title)
            .moveDown(0.3)
            .moveTo(50, doc.y).lineTo(pageW - 50, doc.y)
            .strokeColor(secondaryColor).lineWidth(1).stroke()
            .moveDown(0.4);
        };

        const tableRow = (cols: string[], widths: number[], isHeader = false) => {
          const startX = 50;
          const rowH = 18;
          const y = doc.y;
          if (isHeader) doc.rect(startX, y, widths.reduce((a, b) => a + b, 0), rowH).fill(lightGray);
          let x = startX;
          cols.forEach((col, i) => {
            doc.fillColor(isHeader ? gray : "#1e293b")
              .fontSize(isHeader ? 9 : 10)
              .font(isHeader ? "Helvetica-Bold" : "Helvetica")
              .text(String(col), x + 4, y + 4, { width: widths[i] - 8, lineBreak: false });
            x += widths[i];
          });
          doc.y = y + rowH + 2;
        };

        // ── Section 1: Overview ──
        sectionTitle("1. Overview");
        const runRow = (ovRuns.rows?.[0] as any) ?? { total: 0, completed: 0 };
        doc.fontSize(10).font("Helvetica").fillColor("#1e293b");
        doc.text(`Total ingestion jobs: ${runRow.total ?? 0}  ·  Completed: ${runRow.completed ?? 0}`).moveDown(0.5);

        if ((ovProducts.rows ?? []).length > 0 || (ovCustomers.rows ?? []).length > 0) {
          tableRow(["Date", "New Products", "New Customers"], [160, 160, 160], true);
          const daySet = new Set<string>([
            ...(ovProducts.rows ?? []).map((r: any) => String(r.day)),
            ...(ovCustomers.rows ?? []).map((r: any) => String(r.day)),
          ]);
          const prodMap = new Map((ovProducts.rows ?? []).map((r: any) => [String(r.day), r.new_products ?? 0]));
          const custMap = new Map((ovCustomers.rows ?? []).map((r: any) => [String(r.day), r.new_customers ?? 0]));
          for (const d of Array.from(daySet).sort()) {
            tableRow([d, String(prodMap.get(d) ?? 0), String(custMap.get(d) ?? 0)], [160, 160, 160]);
            if (doc.y > doc.page.height - 80) { addPageFooter(); pageNum++; doc.addPage(); }
          }
        } else {
          doc.fontSize(10).fillColor(gray).text("No data for this period.").moveDown(0.5);
        }

        // ── Section 2: Health ──
        addPageFooter(); pageNum++; doc.addPage();
        sectionTitle("2. Health Distribution");

        const renderHealthTable = (title: string, rows: any[]) => {
          doc.fontSize(11).font("Helvetica-Bold").fillColor("#1e293b").text(title).moveDown(0.3);
          if (rows.length === 0) {
            doc.fontSize(10).font("Helvetica").fillColor(gray).text("No data available (k-anonymity threshold not met).").moveDown(0.5);
            return;
          }
          tableRow(["Name", "Members"], [320, 100], true);
          for (const r of rows) {
            tableRow([String(r.name ?? ""), String(r.customer_count ?? 0)], [320, 100]);
            if (doc.y > doc.page.height - 80) { addPageFooter(); pageNum++; doc.addPage(); }
          }
          doc.moveDown(0.5);
        };

        renderHealthTable("Top Allergens", hlAllergens.rows ?? []);
        renderHealthTable("Top Health Conditions", hlConditions.rows ?? []);
        renderHealthTable("Top Dietary Preferences", hlDiets.rows ?? []);

        // ── Section 3: Engagement ──
        addPageFooter(); pageNum++; doc.addPage();
        sectionTitle("3. Engagement");
        const eng = (engRow.rows?.[0] as any) ?? { total_customers: 0, with_profile: 0, activation_rate: 0 };
        doc.fontSize(10).font("Helvetica").fillColor("#1e293b");
        doc.text(`Total customers: ${eng.total_customers ?? 0}`).moveDown(0.2);
        doc.text(`With health profile: ${eng.with_profile ?? 0}`).moveDown(0.2);
        doc.text(`Activation rate: ${eng.activation_rate ?? 0}%`).moveDown(0.8);

        addPageFooter();
        doc.end();
        return;
      }

      // ── PPTX: PowerPoint deck ───────────────────────────────────────────
      if (format === "pptx") {
        const dateStr = new Date().toISOString().slice(0, 10);
        const [ovProducts, ovCustomers, hlAllergens, hlConditions, engRow] = await Promise.all([
          db.execute(sql`
            SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS cnt
            FROM gold.b2b_products WHERE vendor_id = ${vendorId}::uuid
            AND created_at >= now() - (${days} || ' days')::interval
            GROUP BY 1 ORDER BY 1
          `).catch(() => ({ rows: [] })),
          db.execute(sql`
            SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS cnt
            FROM gold.b2b_customers WHERE vendor_id = ${vendorId}::uuid
            AND created_at >= now() - (${days} || ' days')::interval
            GROUP BY 1 ORDER BY 1
          `).catch(() => ({ rows: [] })),
          db.execute(sql`
            SELECT allergen AS name, count(*)::int AS customer_count
            FROM gold.b2b_customer_allergens ca
            JOIN gold.b2b_customers c ON c.id = ca.customer_id
            WHERE c.vendor_id = ${vendorId}::uuid
            GROUP BY 1 ORDER BY 2 DESC LIMIT 5
          `).catch(() => ({ rows: [] })),
          db.execute(sql`
            SELECT condition, count(*)::int AS customer_count
            FROM gold.b2b_customer_conditions cc
            JOIN gold.b2b_customers c ON c.id = cc.customer_id
            WHERE c.vendor_id = ${vendorId}::uuid
            GROUP BY 1 ORDER BY 2 DESC LIMIT 5
          `).catch(() => ({ rows: [] })),
          db.execute(sql`
            SELECT count(*)::int AS total_customers,
                   count(hp.customer_id)::int AS with_profile,
                   ROUND(count(hp.customer_id) * 100.0 / NULLIF(count(*), 0), 1) AS activation_rate
            FROM gold.b2b_customers c
            LEFT JOIN gold.b2b_customer_health_profiles hp ON hp.customer_id = c.id
            WHERE c.vendor_id = ${vendorId}::uuid
          `).catch(() => ({ rows: [{ total_customers: 0, with_profile: 0, activation_rate: 0 }] as any[] })),
        ]);

        // --- Load vendor branding for pptx ---
        const pptxBrandingRows = await db.execute(sql`
          SELECT key, value FROM gold.system_settings
          WHERE vendor_id = ${vendorId}::uuid
          AND key IN ('branding.primary_color', 'branding.logo_url')
        `).catch(() => ({ rows: [] }));
        const pptxBrandMap: Record<string, string> = {};
        for (const row of pptxBrandingRows.rows) {
          const v = row.value;
          pptxBrandMap[row.key as string] = typeof v === "string" ? v : (v as any)?.toString?.() ?? "";
        }
        const pptxRawColor = (pptxBrandMap["branding.primary_color"] ?? "").trim();
        const pptxBlue = /^#[0-9a-fA-F]{3,6}$/.test(pptxRawColor) ? pptxRawColor : "#00438f";
        const pptxLogoUrl = pptxBrandMap["branding.logo_url"] ?? null;
        let pptxLogoBuffer: Buffer | null = null;
        if (pptxLogoUrl) {
          pptxLogoBuffer = await fetch(pptxLogoUrl)
            .then(r => r.ok ? r.arrayBuffer().then(ab => Buffer.from(ab)) : null)
            .catch(() => null);
        }
        // ---

        const pptxgen = require("pptxgenjs");
        const prs = new pptxgen();
        const blueHex = pptxBlue.replace("#", "");

        // Slide 1 — Cover
        const s1 = prs.addSlide();
        s1.background = { color: blueHex };
        s1.addText("Analytics Report", { x: 0.5, y: 1.5, w: 9, h: 1.2, fontSize: 40, bold: true, color: "FFFFFF" });
        s1.addText(`Period: Last ${days} days  •  Generated ${dateStr}`, { x: 0.5, y: 2.8, w: 9, h: 0.5, fontSize: 16, color: "FFFFFF" });
        if (pptxLogoBuffer) {
          s1.addImage({ data: `image/png;base64,${pptxLogoBuffer.toString("base64")}`, x: 8, y: 0.3, w: 1.5, h: 0.75 });
        }

        // Slide 2 — Engagement KPIs
        const eng = engRow.rows[0] ?? { total_customers: 0, with_profile: 0, activation_rate: 0 };
        const s2 = prs.addSlide();
        s2.addText("Engagement", { x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 24, bold: true, color: blueHex });
        const kpis = [
          { label: "Total Customers", value: String(eng.total_customers ?? 0) },
          { label: "With Health Profile", value: String(eng.with_profile ?? 0) },
          { label: "Activation Rate", value: `${eng.activation_rate ?? 0}%` },
        ];
        kpis.forEach((kpi, i) => {
          s2.addText(kpi.value, { x: 0.5 + i * 3.2, y: 1.2, w: 3, h: 1, fontSize: 36, bold: true, color: blueHex });
          s2.addText(kpi.label, { x: 0.5 + i * 3.2, y: 2.3, w: 3, h: 0.4, fontSize: 12, color: "64748B" });
        });

        // Slide 3 — Health Distribution
        const s3 = prs.addSlide();
        s3.addText("Health Distribution", { x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 24, bold: true, color: blueHex });
        const tableRows3: any[][] = [
          [{ text: "Category", options: { bold: true } }, { text: "Name", options: { bold: true } }, { text: "Members", options: { bold: true } }],
          ...hlAllergens.rows.slice(0, 5).map((r: any) => [{ text: "Allergen" }, { text: String(r.name) }, { text: String(r.customer_count) }]),
          ...hlConditions.rows.slice(0, 5).map((r: any) => [{ text: "Condition" }, { text: String(r.condition) }, { text: String(r.customer_count) }]),
        ];
        s3.addTable(tableRows3, { x: 0.5, y: 1.1, w: 9, colW: [2.5, 4.5, 2], fontSize: 11 });

        // Slide 4 — Overview trend table
        const s4 = prs.addSlide();
        s4.addText("Overview Trends", { x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 24, bold: true, color: blueHex });
        const ovRows4: any[][] = [
          [{ text: "Day", options: { bold: true } }, { text: "New Products", options: { bold: true } }, { text: "New Customers", options: { bold: true } }],
          ...ovProducts.rows.slice(0, 10).map((r: any, i: number) => [
            { text: String(r.day ?? "") },
            { text: String(r.cnt ?? 0) },
            { text: String(ovCustomers.rows[i]?.cnt ?? 0) },
          ]),
        ];
        s4.addTable(ovRows4, { x: 0.5, y: 1.1, w: 9, colW: [3, 3, 3], fontSize: 11 });

        const pptxBuffer = await prs.write({ outputType: "nodebuffer" });
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
        res.setHeader("Content-Disposition", `attachment; filename="analytics-report-${dateStr}.pptx"`);
        return res.end(pptxBuffer);
      }

      let rows: Record<string, unknown>[] = [];
      let filename = `analytics-${type}-${new Date().toISOString().slice(0, 10)}.csv`;

      if (type === "overview") {
        const [products, customers, runs] = await Promise.all([
          db.execute(sql`
            SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS new_products
            FROM gold.products WHERE vendor_id = ${vendorId}::uuid
              AND created_at >= now() - (${days}::text || ' days')::interval
            GROUP BY 1 ORDER BY 1
          `).catch(() => ({ rows: [] as any[] })),
          db.execute(sql`
            SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS new_customers
            FROM gold.b2b_customers WHERE vendor_id = ${vendorId}::uuid
              AND created_at >= now() - (${days}::text || ' days')::interval
            GROUP BY 1 ORDER BY 1
          `).catch(() => ({ rows: [] as any[] })),
          db.execute(sql`
            SELECT date_trunc('day', started_at)::date AS day, COUNT(*)::int AS ingestion_runs
            FROM orchestration.orchestration_runs WHERE vendor_id = ${vendorId}::uuid
              AND started_at >= now() - (${days}::text || ' days')::interval
            GROUP BY 1 ORDER BY 1
          `).catch(() => ({ rows: [] as any[] })),
        ]);
        // Merge all days into one row per day
        const dayMap = new Map<string, Record<string, unknown>>();
        for (const r of (products.rows ?? []) as any[]) {
          const d = String(r.day); dayMap.set(d, { day: d, new_products: r.new_products, new_customers: 0, ingestion_runs: 0 });
        }
        for (const r of (customers.rows ?? []) as any[]) {
          const d = String(r.day); const existing = dayMap.get(d) ?? { day: d, new_products: 0, new_customers: 0, ingestion_runs: 0 };
          dayMap.set(d, { ...existing, new_customers: r.new_customers });
        }
        for (const r of (runs.rows ?? []) as any[]) {
          const d = String(r.day); const existing = dayMap.get(d) ?? { day: d, new_products: 0, new_customers: 0, ingestion_runs: 0 };
          dayMap.set(d, { ...existing, ingestion_runs: r.ingestion_runs });
        }
        rows = Array.from(dayMap.values()).sort((a, b) => String(a.day).localeCompare(String(b.day)));
      } else if (type === "health") {
        filename = `analytics-health-${new Date().toISOString().slice(0, 10)}.csv`;
        const K_ANON_MIN_CSV = 5;
        const [allergens, conditions, diets] = await Promise.all([
          db.execute(sql`
            SELECT 'allergen' AS category, a.name, COUNT(DISTINCT ca.b2b_customer_id)::int AS customer_count
            FROM gold.b2b_customer_allergens ca
            JOIN gold.allergens a ON ca.allergen_id = a.id
            JOIN gold.b2b_customers c ON ca.b2b_customer_id = c.id
            WHERE c.vendor_id = ${vendorId}::uuid
            GROUP BY a.name HAVING COUNT(DISTINCT ca.b2b_customer_id) >= ${K_ANON_MIN_CSV}
            ORDER BY customer_count DESC LIMIT 20
          `).catch(() => ({ rows: [] as any[] })),
          db.execute(sql`
            SELECT 'health_condition' AS category, hc.name, COUNT(DISTINCT chc.b2b_customer_id)::int AS customer_count
            FROM gold.b2b_customer_health_conditions chc
            JOIN gold.health_conditions hc ON chc.condition_id = hc.id
            JOIN gold.b2b_customers c ON chc.b2b_customer_id = c.id
            WHERE c.vendor_id = ${vendorId}::uuid
            GROUP BY hc.name HAVING COUNT(DISTINCT chc.b2b_customer_id) >= ${K_ANON_MIN_CSV}
            ORDER BY customer_count DESC LIMIT 20
          `).catch(() => ({ rows: [] as any[] })),
          db.execute(sql`
            SELECT 'dietary_preference' AS category, dp.name, COUNT(DISTINCT cdp.b2b_customer_id)::int AS customer_count
            FROM gold.b2b_customer_dietary_preferences cdp
            JOIN gold.dietary_preferences dp ON cdp.diet_id = dp.id
            JOIN gold.b2b_customers c ON cdp.b2b_customer_id = c.id
            WHERE c.vendor_id = ${vendorId}::uuid
            GROUP BY dp.name HAVING COUNT(DISTINCT cdp.b2b_customer_id) >= ${K_ANON_MIN_CSV}
            ORDER BY customer_count DESC LIMIT 20
          `).catch(() => ({ rows: [] as any[] })),
        ]);
        rows = [...(allergens.rows ?? []), ...(conditions.rows ?? []), ...(diets.rows ?? [])] as Record<string, unknown>[];
      } else if (type === "engagement") {
        filename = `analytics-engagement-${new Date().toISOString().slice(0, 10)}.csv`;
        const result = await db.execute(sql`
          SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS new_customers,
                 COUNT(DISTINCT CASE WHEN account_status = 'active' THEN id END)::int AS active_customers
          FROM gold.b2b_customers
          WHERE vendor_id = ${vendorId}::uuid
            AND created_at >= now() - (${days}::text || ' days')::interval
          GROUP BY 1 ORDER BY 1
        `).catch(() => ({ rows: [] as any[] }));
        rows = (result.rows ?? []) as Record<string, unknown>[];
      } else {
        return problem(res, 400, "Invalid export type. Use: overview, health, engagement", req);
      }

      if (rows.length === 0) {
        return res.status(200).send("No data available for the selected period.");
      }

      const headers = Object.keys(rows[0]);

      if (format === "xlsx") {
        // SpreadsheetML — no extra npm package required; Excel opens natively
        const xmlEscape = (v: any) =>
          String(v ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");

        const xlsxFilename = filename.replace(/\.csv$/, ".xlsx");
        const headerRow = headers.map((h) => `<Cell><Data ss:Type="String">${xmlEscape(h)}</Data></Cell>`).join("");
        const dataRows = rows
          .map((row) => {
            const cells = headers
              .map((h) => {
                const v = row[h];
                const isNum = typeof v === "number";
                return `<Cell><Data ss:Type="${isNum ? "Number" : "String"}">${xmlEscape(v)}</Data></Cell>`;
              })
              .join("");
            return `<Row>${cells}</Row>`;
          })
          .join("");

        const xml = `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="Analytics">
    <Table>
      <Row>${headerRow}</Row>
      ${dataRows}
    </Table>
  </Worksheet>
</Workbook>`;

        res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${xlsxFilename}"`);
        return res.send(xml);
      }

      const csvLines = [
        headers.map((h) => `"${String(h).replace(/"/g, '""')}"`).join(","),
        ...rows.map((row) =>
          headers.map((h) => `"${String(row[h] ?? "").replace(/"/g, '""')}"`).join(",")
        ),
      ];

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(csvLines.join("\r\n"));
    } catch (e: any) {
      problem(res, 500, safeErrorDetail(e, "Analytics export failed"), req);
    }
  }));

  // Goal achievement: avg % of members hitting calorie + macro targets
  app.get("/api/v1/analytics/goal-achievement", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    const days = Math.min(Math.max(parseInt(String(req.query.days || "30"), 10) || 30, 7), 90);
    try {
      const result = await db.execute(sql`
        SELECT
          COUNT(DISTINCT ml.user_id)::int AS members_tracked,
          ROUND(
            AVG(CASE
              WHEN hp.target_calories IS NOT NULL AND hp.target_calories > 0
              THEN LEAST(ml.total_calories / hp.target_calories, 1.5) * 100
              ELSE NULL END
            )::numeric, 1
          ) AS avg_calorie_achievement_pct,
          ROUND(
            AVG(CASE
              WHEN hp.target_protein_g IS NOT NULL AND hp.target_protein_g > 0
              THEN LEAST(ml.total_protein_g / hp.target_protein_g, 1.5) * 100
              ELSE NULL END
            )::numeric, 1
          ) AS avg_protein_achievement_pct,
          ROUND(
            AVG(CASE
              WHEN hp.target_carbs_g IS NOT NULL AND hp.target_carbs_g > 0
              THEN LEAST(ml.total_carbs_g / hp.target_carbs_g, 1.5) * 100
              ELSE NULL END
            )::numeric, 1
          ) AS avg_carbs_achievement_pct
        FROM (
          SELECT user_id, logged_date,
            COALESCE(SUM(calories), 0) AS total_calories,
            COALESCE(SUM(protein_g), 0) AS total_protein_g,
            COALESCE(SUM(carbs_g), 0) AS total_carbs_g
          FROM gold.meal_logs
          WHERE logged_date >= now() - (${days}::text || ' days')::interval
          GROUP BY user_id, logged_date
        ) ml
        JOIN gold.b2b_customers c ON c.id = ml.user_id
        LEFT JOIN gold.b2c_customer_health_profiles hp ON hp.customer_id = ml.user_id
        WHERE c.vendor_id = ${vendorId}::uuid
      `).catch(() => ({ rows: [] as any[] }));

      const row = (result.rows?.[0] as any) ?? {};
      const metrics: { metric: string; achieved_pct: number }[] = [];
      if (row.avg_calorie_achievement_pct != null) metrics.push({ metric: "Calories",  achieved_pct: Number(row.avg_calorie_achievement_pct) });
      if (row.avg_protein_achievement_pct != null) metrics.push({ metric: "Protein",   achieved_pct: Number(row.avg_protein_achievement_pct) });
      if (row.avg_carbs_achievement_pct   != null) metrics.push({ metric: "Carbs",     achieved_pct: Number(row.avg_carbs_achievement_pct) });
      ok(res, {
        members_tracked: row.members_tracked ?? 0,
        metrics,
        days,
      });
    } catch (e: any) {
      problem(res, 500, safeErrorDetail(e, "Goal achievement failed"), req);
    }
  }));

  // Top-rated recipes per partner (B2B-020)
  app.get("/api/v1/analytics/top-recipes", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit || "10"), 10)));
    try {
      const result = await db.execute(sql`
        SELECT
          r.id,
          r.name,
          r.description,
          r.image_url,
          ROUND(AVG(rr.rating)::numeric, 2) AS avg_rating,
          COUNT(rr.id)::int AS rating_count
        FROM gold.recipe_ratings rr
        JOIN gold.recipes r ON r.id = rr.recipe_id
        JOIN gold.b2c_customers bc ON bc.id = rr.user_id
        JOIN gold.b2b_customers c ON c.id = bc.id
        WHERE c.vendor_id = ${vendorId}::uuid
        GROUP BY r.id, r.name, r.description, r.image_url
        HAVING COUNT(rr.id) >= 1
        ORDER BY avg_rating DESC, rating_count DESC
        LIMIT ${limit}
      `).catch(() => ({ rows: [] as any[] }));

      ok(res, { recipes: result.rows ?? [], limit });
    } catch (e: any) {
      problem(res, 500, safeErrorDetail(e, "Top recipes failed"), req);
    }
  }));

  // NPS: submit score + get aggregate analytics
  app.post("/api/v1/nps", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    const { score, comment, respondent_key } = req.body || {};
    const parsedScore = parseInt(String(score), 10);
    if (isNaN(parsedScore) || parsedScore < 1 || parsedScore > 10) {
      return problem(res, 400, "score must be an integer between 1 and 10", req);
    }
    try {
      await db.execute(sql`
        INSERT INTO gold.b2b_nps_responses (vendor_id, score, comment, respondent_key)
        VALUES (${vendorId}::uuid, ${parsedScore}, ${comment?.trim() || null}, ${respondent_key?.trim() || null})
      `);
      ok(res, { ok: true });
    } catch (e: any) {
      problem(res, 500, safeErrorDetail(e, "Failed to save NPS response"), req);
    }
  }));

  app.get("/api/v1/analytics/nps", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    const days = Math.min(Math.max(parseInt(String(req.query.days || "90"), 10) || 90, 7), 365);
    try {
      const result = await db.execute(sql`
        SELECT
          COUNT(*)::int AS total_responses,
          ROUND(AVG(score)::numeric, 1) AS avg_score,
          COUNT(*) FILTER (WHERE score >= 9)::int AS promoters,
          COUNT(*) FILTER (WHERE score <= 6)::int AS detractors,
          COUNT(*) FILTER (WHERE score BETWEEN 7 AND 8)::int AS passives
        FROM gold.b2b_nps_responses
        WHERE vendor_id = ${vendorId}::uuid
          AND created_at >= now() - (${days}::text || ' days')::interval
      `).catch(() => ({ rows: [] as any[] }));

      const row = (result.rows?.[0] as any) ?? {};
      const total = row.total_responses ?? 0;
      const promoters = row.promoters ?? 0;
      const detractors = row.detractors ?? 0;
      const npsScore = total >= 5
        ? Math.round((promoters / total - detractors / total) * 100)
        : null;

      ok(res, {
        total_responses: total,
        avg_score: row.avg_score ?? null,
        promoters,
        passives: row.passives ?? 0,
        detractors,
        nps_score: npsScore,
        days,
      });
    } catch (e: any) {
      problem(res, 500, safeErrorDetail(e, "NPS analytics failed"), req);
    }
  }));

  // ── Scheduled Reports ──────────────────────────────────────────────────────
  // Compute the next delivery date for a given schedule
  function nextDeliveryDate(frequency: string, dayOfWeek?: string): string {
    const now = new Date();
    if (frequency === "daily") {
      const next = new Date(now);
      next.setDate(next.getDate() + 1);
      next.setHours(8, 0, 0, 0);
      return next.toISOString();
    }
    if (frequency === "monthly") {
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 8, 0, 0, 0);
      return next.toISOString();
    }
    // weekly
    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const targetDay = days.indexOf(dayOfWeek ?? "Monday");
    const next = new Date(now);
    const diff = (targetDay - now.getDay() + 7) % 7 || 7;
    next.setDate(now.getDate() + diff);
    next.setHours(8, 0, 0, 0);
    return next.toISOString();
  }

  app.post("/api/v1/reports/schedule", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    const { frequency, day_of_week, format, recipients } = req.body ?? {};
    if (!["daily","weekly","monthly"].includes(frequency)) return problem(res, 400, "Invalid frequency", req);
    if (!["csv","pdf"].includes(format)) return problem(res, 400, "Invalid format", req);
    if (!Array.isArray(recipients) || recipients.length === 0) return problem(res, 400, "At least one recipient required", req);
    try {
      const result = await db.execute(sql`
        INSERT INTO gold.b2b_scheduled_reports (vendor_id, frequency, day_of_week, format, recipients)
        VALUES (${vendorId}::uuid, ${frequency}, ${day_of_week ?? null}, ${format}, ${recipients}::text[])
        RETURNING id, frequency, day_of_week, format, recipients, created_at
      `);
      const row = result.rows[0] as any;
      res.json({
        id: row.id,
        frequency: row.frequency,
        day_of_week: row.day_of_week,
        format: row.format,
        recipients: row.recipients,
        next_delivery: nextDeliveryDate(frequency, day_of_week),
      });
    } catch (e) {
      problem(res, 500, safeErrorDetail(e, "Failed to save schedule"), req);
    }
  }));

  app.get("/api/v1/reports/schedules", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    try {
      const result = await db.execute(sql`
        SELECT id, frequency, day_of_week, format, recipients, is_active, created_at, last_sent_at
        FROM gold.b2b_scheduled_reports
        WHERE vendor_id = ${vendorId}::uuid AND is_active = true
        ORDER BY created_at DESC
      `);
      res.json({ schedules: result.rows });
    } catch (e) {
      problem(res, 500, safeErrorDetail(e, "Failed to fetch schedules"), req);
    }
  }));

  // ROI calculations: budget adherence, food waste reduction, health cost savings
  app.get("/api/v1/analytics/roi", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    try {
      const [activationRow, goalRow, savingsRow] = await Promise.all([
        db.execute(sql`
          SELECT
            COUNT(DISTINCT c.id)::int AS total,
            COUNT(DISTINCT hp.customer_id)::int AS with_profile
          FROM gold.b2b_customers c
          LEFT JOIN gold.b2b_customer_health_profiles hp ON hp.customer_id = c.id
          WHERE c.vendor_id = ${vendorId}::uuid
        `).catch(() => ({ rows: [{ total: 0, with_profile: 0 }] as any[] })),
        db.execute(sql`
          SELECT ROUND(AVG(
            CASE WHEN hp.target_calories IS NOT NULL AND hp.target_calories > 0
            THEN LEAST(ml.total_calories / hp.target_calories, 1.5) * 100 END
          )::numeric, 1) AS avg_calorie_pct
          FROM (
            SELECT user_id, COALESCE(SUM(calories), 0) AS total_calories
            FROM gold.meal_logs
            WHERE logged_date >= now() - '30 days'::interval
            GROUP BY user_id
          ) ml
          JOIN gold.b2b_customers c ON c.id = ml.user_id
          LEFT JOIN gold.b2c_customer_health_profiles hp ON hp.customer_id = ml.user_id
          WHERE c.vendor_id = ${vendorId}::uuid
        `).catch(() => ({ rows: [] as any[] })),
        db.execute(sql`
          SELECT value FROM gold.system_settings
          WHERE vendor_id = ${vendorId}::uuid AND key = 'roi.savings_per_member' LIMIT 1
        `).catch(() => ({ rows: [] as any[] })),
      ]);

      const ar = (activationRow.rows?.[0] as any) ?? { total: 0, with_profile: 0 };
      const activatedMembers: number = ar.with_profile ?? 0;

      const rawSavings = (savingsRow.rows?.[0] as any)?.value;
      const savingsPerMember: number = (typeof rawSavings === "number" ? rawSavings
        : typeof rawSavings === "string" ? parseFloat(rawSavings)
        : typeof rawSavings === "object" && rawSavings !== null ? Number(Object.values(rawSavings)[0])
        : NaN) || 1500;

      const avgCaloriePct = (goalRow.rows?.[0] as any)?.avg_calorie_pct ?? null;

      ok(res, {
        budgetAdherence: avgCaloriePct !== null ? `${Math.min(Math.round(Number(avgCaloriePct)), 100)}%` : null,
        foodWasteReduction: activatedMembers > 0 ? `$${(activatedMembers * 15).toLocaleString()}/mo` : null,
        healthCostSavings: activatedMembers > 0 ? `$${(activatedMembers * savingsPerMember).toLocaleString()}/yr` : null,
      });
    } catch (e: any) {
      problem(res, 500, safeErrorDetail(e, "ROI calculation failed"), req);
    }
  }));

  // Cohort retention: members grouped by join month, how many are still active
  app.get("/api/v1/analytics/retention", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    const days = Math.min(Math.max(parseInt(String(req.query.days || "180"), 10) || 180, 30), 365);
    try {
      const result = await db.execute(sql`
        SELECT
          to_char(date_trunc('month', created_at), 'YYYY-MM') AS cohort_month,
          COUNT(*)::int AS cohort_size,
          COUNT(*) FILTER (WHERE account_status = 'active')::int AS retained_count
        FROM gold.b2b_customers
        WHERE vendor_id = ${vendorId}::uuid
          AND created_at >= now() - (${days}::text || ' days')::interval
        GROUP BY cohort_month
        ORDER BY cohort_month
      `).catch(() => ({ rows: [] as any[] }));

      const cohorts = (result.rows ?? []).map((r: any) => ({
        cohort_month: String(r.cohort_month),
        cohort_size: r.cohort_size ?? 0,
        retained_count: r.retained_count ?? 0,
        retention_pct: (r.cohort_size ?? 0) > 0
          ? Math.round(((r.retained_count ?? 0) / r.cohort_size) * 100)
          : 0,
      }));

      ok(res, { cohorts, days });
    } catch (e: any) {
      problem(res, 500, safeErrorDetail(e, "Retention analytics failed"), req);
    }
  }));

  // Customer segmentation: counts by health-profile status and account_status
  app.get("/api/v1/customers/segments", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    try {
      const rows = await db.execute(sql`
        SELECT
          CASE WHEN hp.customer_id IS NOT NULL THEN 'with_profile' ELSE 'no_profile' END AS segment,
          c.account_status,
          COUNT(*)::int AS count
        FROM gold.b2b_customers c
        LEFT JOIN (
          SELECT DISTINCT customer_id FROM gold.b2b_customer_health_profiles
        ) hp ON hp.customer_id = c.id
        WHERE c.vendor_id = ${vendorId}::uuid
        GROUP BY 1, 2
      `).catch(() => ({ rows: [] as any[] }));

      const segments: Record<string, number> = {
        active_with_profile: 0,
        active_no_profile: 0,
        archived: 0,
      };
      for (const r of (rows.rows ?? []) as any[]) {
        if (r.account_status !== "active") {
          segments.archived = (segments.archived ?? 0) + (r.count ?? 0);
        } else if (r.segment === "with_profile") {
          segments.active_with_profile = (r.count ?? 0);
        } else {
          segments.active_no_profile = (r.count ?? 0);
        }
      }
      ok(res, { segments });
    } catch (e: any) {
      problem(res, 500, safeErrorDetail(e, "Segment query failed"), req);
    }
  }));

  // Churn / at-risk identification
  // Healthy   = active + updated within 30 days
  // At-risk   = active + NOT updated within 30 days (stale engagement signal)
  // Churned   = account_status = 'inactive' or 'archived'
  app.get("/api/v1/analytics/churn", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    try {
      const [countsResult, atRiskResult] = await Promise.all([
        db.execute(sql`
          SELECT
            COUNT(*) FILTER (
              WHERE account_status = 'active'
                AND updated_at >= now() - interval '30 days'
            )::int AS healthy,
            COUNT(*) FILTER (
              WHERE account_status = 'active'
                AND updated_at < now() - interval '30 days'
            )::int AS at_risk,
            COUNT(*) FILTER (
              WHERE account_status IN ('inactive', 'archived')
            )::int AS churned
          FROM gold.b2b_customers
          WHERE vendor_id = ${vendorId}::uuid
        `).catch(() => ({ rows: [{ healthy: 0, at_risk: 0, churned: 0 }] as any[] })),
        db.execute(sql`
          SELECT id, full_name, email, updated_at, customer_segment
          FROM gold.b2b_customers
          WHERE vendor_id = ${vendorId}::uuid
            AND account_status = 'active'
            AND updated_at < now() - interval '30 days'
          ORDER BY updated_at ASC
          LIMIT 10
        `).catch(() => ({ rows: [] as any[] })),
      ]);

      const counts = (countsResult.rows?.[0] as any) ?? { healthy: 0, at_risk: 0, churned: 0 };
      const healthy = counts.healthy ?? 0;
      const atRisk = counts.at_risk ?? 0;
      const churned = counts.churned ?? 0;
      const total = healthy + atRisk + churned;
      const atRiskRate = total > 0 ? Math.round((atRisk / total) * 1000) / 10 : 0;

      const atRiskCustomers = ((atRiskResult.rows ?? []) as any[]).map(r => ({
        id: r.id,
        fullName: r.full_name ?? "",
        email: r.email ?? "",
        updatedAt: r.updated_at,
        customerSegment: r.customer_segment ?? null,
      }));

      ok(res, { healthy, atRisk, churned, atRiskRate, atRiskCustomers });
    } catch (e: any) {
      problem(res, 500, safeErrorDetail(e, "Churn query failed"), req);
    }
  }));

  // CRM Integration: sync customers to configured CRM provider (Salesforce / HubSpot)
  app.post("/api/v1/integrations/crm/sync", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    try {
      // Read CRM settings stored in system_settings
      const settingRows = await db.execute(sql`
        SELECT key, value FROM gold.system_settings
        WHERE vendor_id = ${vendorId}::uuid
          AND key IN ('crm.provider', 'crm.access_token', 'crm.instance_url', 'crm.api_key')
      `).catch(() => ({ rows: [] as any[] }));

      const crmSettings: Record<string, string> = {};
      for (const r of (settingRows.rows ?? []) as any[]) {
        crmSettings[r.key] = String(r.value ?? "");
      }

      const provider = crmSettings["crm.provider"] || "none";
      if (provider === "none" || !provider) {
        return res.status(400).json({ error: "No CRM provider configured. Set crm.provider in settings." });
      }

      // Fetch customers for this vendor (limited batch for sync)
      const customerRows = await db.execute(sql`
        SELECT c.id, c.email, c.full_name, c.phone, c.account_status, c.created_at
        FROM gold.b2b_customers c
        WHERE c.vendor_id = ${vendorId}::uuid AND c.account_status = 'active'
        LIMIT 100
      `).catch(() => ({ rows: [] as any[] }));

      const customers = (customerRows.rows ?? []) as any[];

      if (provider === "hubspot") {
        const apiKey = crmSettings["crm.api_key"] || crmSettings["crm.access_token"] || "";
        if (!apiKey) return res.status(400).json({ error: "HubSpot API key not configured (crm.api_key)" });

        let synced = 0;
        let failed = 0;
        for (const c of customers) {
          try {
            const resp = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
              body: JSON.stringify({
                properties: {
                  email: c.email,
                  firstname: String(c.full_name ?? "").split(" ")[0] || c.full_name,
                  lastname: String(c.full_name ?? "").split(" ").slice(1).join(" ") || "",
                  phone: c.phone || "",
                },
              }),
            });
            if (resp.ok || resp.status === 409) synced++; else failed++;
          } catch { failed++; }
        }
        return ok(res, { provider: "hubspot", synced, failed, total: customers.length });

      } else if (provider === "salesforce") {
        const accessToken = crmSettings["crm.access_token"] || "";
        const instanceUrl = crmSettings["crm.instance_url"] || "";
        if (!accessToken || !instanceUrl) {
          return res.status(400).json({ error: "Salesforce access_token and instance_url required" });
        }

        let synced = 0;
        let failed = 0;
        for (const c of customers) {
          try {
            const resp = await fetch(`${instanceUrl}/services/data/v57.0/sobjects/Contact`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
              body: JSON.stringify({
                Email: c.email,
                FirstName: String(c.full_name ?? "").split(" ")[0] || c.full_name,
                LastName: String(c.full_name ?? "").split(" ").slice(1).join(" ") || "Unknown",
                Phone: c.phone || "",
              }),
            });
            if (resp.ok || resp.status === 409) synced++; else failed++;
          } catch { failed++; }
        }
        return ok(res, { provider: "salesforce", synced, failed, total: customers.length });

      } else {
        return res.status(400).json({ error: `Unknown CRM provider: ${provider}` });
      }
    } catch (e: any) {
      problem(res, 500, safeErrorDetail(e, "CRM sync failed"), req);
    }
  }));

  // Chat report export (PRD-10): CSV download from report data or session
  app.post("/api/v1/chat/export", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const b = req.body ?? {};
    let reportData = b.report_data ?? b.rows ?? b.data;

    // PRD-10: Session-based retrieval — check in-memory first, then DB
    if ((!Array.isArray(reportData) || reportData.length === 0) && b.session_id) {
      const sid = String(b.session_id);
      const stored = sessionReportStore.get(sid);
      if (stored && stored.length > 0) {
        reportData = stored;
      } else {
        const dbRows = await loadChatSession(sid, vendorId);
        if (dbRows && dbRows.length > 0) reportData = dbRows;
      }
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

  // ── Catalog Sync ─────────────────────────────────────────────────────────────
  // GET /api/v1/catalog/sync/config — read saved catalog sync settings
  app.get("/api/v1/catalog/sync/config", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    try {
      const rows = await db.execute(sql`
        SELECT key, value FROM gold.system_settings
        WHERE vendor_id = ${vendorId}::uuid
          AND key IN ('catalog_sync.platform', 'catalog_sync.store_url')
      `).catch(() => ({ rows: [] as any[] }));
      const cfg: Record<string, string> = {};
      for (const r of (rows.rows ?? []) as any[]) cfg[r.key as string] = String(r.value ?? "");
      res.json({
        platform: cfg["catalog_sync.platform"] || "shopify",
        store_url: cfg["catalog_sync.store_url"] || "",
        // api_key is write-only — never returned
      });
    } catch (e) {
      problem(res, 500, safeErrorDetail(e, "Failed to read catalog config"), req);
    }
  }));

  // PUT /api/v1/catalog/sync/config — save catalog sync settings
  app.put("/api/v1/catalog/sync/config", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    const { platform, store_url, api_key } = req.body ?? {};
    if (!platform || !store_url) return problem(res, 400, "platform and store_url required", req);
    try {
      const upsert = async (key: string, value: string) => db.execute(sql`
        INSERT INTO gold.system_settings (vendor_id, key, value)
        VALUES (${vendorId}::uuid, ${key}, ${value})
        ON CONFLICT (vendor_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `).catch(() => {});
      await upsert("catalog_sync.platform", platform);
      await upsert("catalog_sync.store_url", store_url);
      if (api_key) await upsert("catalog_sync.api_key", api_key);
      res.json({ ok: true });
    } catch (e) {
      problem(res, 500, safeErrorDetail(e, "Failed to save catalog config"), req);
    }
  }));

  // POST /api/v1/catalog/sync — pull products from partner API and ingest
  app.post("/api/v1/catalog/sync", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);
    const { platform, store_url, api_key } = req.body ?? {};
    if (!platform || !store_url || !api_key) return problem(res, 400, "platform, store_url, and api_key required", req);

    try {
      // Build partner-specific fetch
      let partnerUrl = "";
      const headers: Record<string, string> = { "Accept": "application/json" };

      if (platform === "shopify") {
        partnerUrl = `https://${store_url}/admin/api/2024-01/products.json?limit=50&status=active`;
        headers["X-Shopify-Access-Token"] = api_key;
      } else if (platform === "woocommerce") {
        partnerUrl = `https://${store_url}/wp-json/wc/v3/products?per_page=50&status=publish`;
        headers["Authorization"] = `Basic ${Buffer.from(api_key).toString("base64")}`;
      } else if (platform === "bigcommerce") {
        // store_url is the store hash for BigCommerce
        partnerUrl = `https://api.bigcommerce.com/stores/${store_url}/v3/catalog/products?limit=50&is_visible=true`;
        headers["X-Auth-Token"] = api_key;
        headers["Content-Type"] = "application/json";
      } else {
        // custom — store_url is a full URL returning a JSON array of products
        partnerUrl = store_url;
        headers["Authorization"] = `Bearer ${api_key}`;
      }

      let partnerData: any;
      try {
        const fetchRes = await fetch(partnerUrl, { headers, signal: AbortSignal.timeout(15_000) });
        if (!fetchRes.ok) {
          return problem(res, 502, `Partner API returned ${fetchRes.status}: ${fetchRes.statusText}`, req);
        }
        partnerData = await fetchRes.json();
      } catch (fetchErr: any) {
        return problem(res, 502, `Cannot reach partner API: ${fetchErr?.message ?? "timeout"}`, req);
      }

      // Normalise product list from different API shapes
      let rawProducts: any[] = [];
      if (platform === "shopify") rawProducts = Array.isArray(partnerData?.products) ? partnerData.products : [];
      else if (platform === "bigcommerce") rawProducts = Array.isArray(partnerData?.data) ? partnerData.data : [];
      else rawProducts = Array.isArray(partnerData) ? partnerData : (partnerData?.data ?? partnerData?.products ?? []);

      if (rawProducts.length === 0) return res.json({ synced: 0, source: platform });

      // Map to ingest schema
      const records = rawProducts.slice(0, 200).map((p: any) => ({
        external_id: String(p.id ?? p.sku ?? p.external_id ?? Math.random()),
        name: p.title ?? p.name ?? "Unnamed Product",
        brand: p.vendor ?? p.brand ?? null,
        description: p.body_html ?? p.description ?? null,
        price: p.variants?.[0]?.price ?? p.price ?? p.sale_price ?? null,
        status: (p.status === "active" || p.status === "publish" || p.is_visible) ? "active" : "inactive",
        source_name: platform,
      }));

      // Use the existing ingest route internally (POST to our own ingest endpoint)
      const ingestUrl = `http://localhost:${process.env.PORT ?? 3001}/api/v1/ingest/products`;
      let synced = 0;
      try {
        const ingestRes = await fetch(ingestUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": req.headers.authorization ?? "" },
          body: JSON.stringify({ records, source_name: platform }),
          signal: AbortSignal.timeout(30_000),
        });
        if (ingestRes.ok) {
          const body = await ingestRes.json().catch(() => ({}));
          synced = body?.inserted ?? body?.synced ?? records.length;
        } else {
          synced = 0;
        }
      } catch {
        // fallback: report raw count
        synced = records.length;
      }

      res.json({ synced, source: platform, total_fetched: rawProducts.length });
    } catch (e) {
      problem(res, 500, safeErrorDetail(e, "Catalog sync failed"), req);
    }
  }));

  // Public branding config (no auth) — used by login/register pages
  // ?slug=xxx → resolve vendorName from gold.vendors + load branding settings
  app.get("/api/config/branding", async (req: Request, res: Response) => {
    const slug = (req.query.slug as string)?.trim();
    const GENERIC_COPYRIGHT = "© 2024. All rights reserved.";

    let vendorName: string | null = null;
    let vendorId: string | null = null;

    if (slug) {
      const row = await db.execute(sql`
        SELECT id, name FROM gold.vendors
        WHERE lower(slug) = lower(${slug}) AND status = 'active'
        LIMIT 1
      `);
      const vendor = row.rows?.[0] as any;
      vendorName = vendor?.name?.trim() || null;
      vendorId = vendor?.id || null;
    }

    if (!vendorName) {
      vendorName = (process.env.VENDOR_NAME ?? "").trim() || null;
    }

    let logoUrl: string | null = null;
    let faviconUrl: string | null = null;
    let primaryColor: string | null = null;
    let secondaryColor: string | null = null;
    let accentColor: string | null = null;
    let welcomeMessage: string | null = null;
    let fontUrl: string | null = null;
    let ga4MeasurementId: string | null = null;
    let mixpanelToken: string | null = null;
    let copyrightText = (process.env.VENDOR_COPYRIGHT ?? "").trim() || GENERIC_COPYRIGHT;

    if (vendorId) {
      const brandingRows = await db.execute(sql`
        SELECT key, value FROM gold.system_settings
        WHERE vendor_id = ${vendorId}::uuid
          AND key IN (
            'branding.logo_url', 'branding.favicon_url',
            'branding.primary_color', 'branding.secondary_color', 'branding.accent_color',
            'branding.copyright', 'branding.welcome_message', 'branding.font_url',
            'integration.ga4_measurement_id', 'integration.mixpanel_token'
          )
      `).catch(() => ({ rows: [] as any[] }));

      for (const r of (brandingRows.rows ?? []) as any[]) {
        const val = String(r.value ?? "").trim();
        if (r.key === "branding.logo_url" && val) logoUrl = val;
        if (r.key === "branding.favicon_url" && val) faviconUrl = val;
        if (r.key === "branding.primary_color" && val) primaryColor = val;
        if (r.key === "branding.secondary_color" && val) secondaryColor = val;
        if (r.key === "branding.accent_color" && val) accentColor = val;
        if (r.key === "branding.copyright" && val) copyrightText = val;
        if (r.key === "branding.welcome_message" && val) welcomeMessage = val;
        if (r.key === "branding.font_url" && val) fontUrl = val;
        if (r.key === "integration.ga4_measurement_id" && val) ga4MeasurementId = val;
        if (r.key === "integration.mixpanel_token" && val) mixpanelToken = val;
      }
    }

    ok(res, { vendorName, copyrightText, logoUrl, faviconUrl, primaryColor, secondaryColor, accentColor, welcomeMessage, fontUrl, ga4MeasurementId, mixpanelToken });
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
        let total = data.length + (page - 1) * limit;
        try {
          const countRow = await db.execute(
            sql`SELECT COUNT(*)::int AS total FROM gold.products WHERE vendor_id = ${vendorId}::uuid`
          );
          total = (countRow.rows?.[0] as any)?.total ?? total;
        } catch { /* non-fatal: fall back to page-derived estimate */ }
        return ok(res, { data, page, pageSize: limit, total });
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

    // Map RAG or product data to the shape ProductIntelCard expects:
    // { summary, insights, market_demand_index, regional_popularity, sentiment }
    const buildIntelResponse = (r: any, fromFallback: boolean) => {
      const dietItems: any[] = Array.isArray(r?.diet_compatibility) ? r.diet_compatibility : [];
      const dietNames: string[] = dietItems.map((d: any) => (typeof d === "string" ? d : d?.diet)).filter(Boolean);
      const ingredients: string[] = Array.isArray(r?.ingredients) ? r.ingredients : (product.ingredients ?? []);
      const allergens: string[] = Array.isArray(r?.allergens) ? r.allergens : (product.allergens ?? []);

      const insights: string[] = [];
      if (ingredients.length > 0) insights.push(`Key ingredients: ${ingredients.slice(0, 5).join(", ")}`);
      if (allergens.length > 0) insights.push(`Contains allergens: ${allergens.join(", ")}`);
      if (dietNames.length > 0) insights.push(`Suitable for: ${dietNames.join(", ")} diets`);
      if (product.dietaryTags?.length && dietNames.length === 0) insights.push(`Dietary tags: ${product.dietaryTags.slice(0, 4).join(", ")}`);

      const summary: string | null =
        (typeof r?.customer_suitability === "string" && r.customer_suitability) ||
        (insights.length > 0 ? insights.join(". ") : null);

      return {
        summary,
        insights: insights.length > 0 ? insights : undefined,
        market_demand_index: r?.market_demand_index ?? null,
        regional_popularity: r?.regional_popularity ?? null,
        sentiment: r?.sentiment ?? null,
        fallback: fromFallback,
      };
    };

    if (ragResult) return ok(res, buildIntelResponse(ragResult, false));

    ok(res, buildIntelResponse({}, true));
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

    // SQL fallback: find customers in this vendor who have no allergen conflicts with this product.
    // Mirrors the customer-to-product SQL fallback (matching/:customerId) using the same junction tables.
    try {
      const fallbackRows = await db.execute(sql`
        SELECT
          c.id,
          c.email,
          c.full_name                                                    AS customer_name,
          COALESCE(
            (SELECT COUNT(*)::int
             FROM gold.b2b_customer_allergens ca
             JOIN gold.product_allergens pa ON pa.allergen_id = ca.allergen_id
             WHERE ca.b2b_customer_id = c.id
               AND pa.product_id = ${productId}::uuid
               AND ca.is_active = true),
            0
          )                                                               AS allergen_conflicts,
          COALESCE(
            (SELECT COUNT(*)::int
             FROM gold.b2b_customer_dietary_preferences cdp
             JOIN gold.product_dietary_preferences pdp ON pdp.diet_id = cdp.diet_id
             WHERE cdp.b2b_customer_id = c.id
               AND pdp.product_id = ${productId}::uuid
               AND cdp.is_active = true
               AND pdp.is_compatible = true),
            0
          )                                                               AS diet_matches
        FROM gold.b2b_customers c
        WHERE c.vendor_id = ${vendorId}::uuid
          AND c.account_status = 'active'
        ORDER BY allergen_conflicts ASC, diet_matches DESC
        LIMIT ${limit}
      `);

      // HIPAA: health-derived fields (safety_status, reasons, warnings) must not be returned.
      // Customers with allergen conflicts are excluded entirely — their absence reveals nothing.
      const customers = (fallbackRows.rows as any[])
        .filter((r) => parseInt(String(r.allergen_conflicts ?? "0"), 10) === 0)
        .map((r) => {
          const dietMatches = parseInt(String(r.diet_matches ?? "0"), 10);
          return {
            id: r.id,
            customer_id: r.id,
            name: r.customer_name,
            customer_name: r.customer_name,
            email: r.email,
            match_score: Math.min(1, dietMatches / 5),
          };
        });

      return ok(res, {
        customers,
        summary: { total_matched: customers.length },
        fallback: true,
      });
    } catch (sqlErr: any) {
      console.error("[matching-customers] SQL fallback error:", sqlErr?.message);
      return ok(res, { customers: [], fallback: true, message: "Matching engine unavailable" });
    }
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

    // SQL fallback — same logic as the POST variant above
    try {
      const fallbackRows = await db.execute(sql`
        SELECT
          c.id,
          c.email,
          c.full_name                                                    AS customer_name,
          COALESCE(
            (SELECT COUNT(*)::int
             FROM gold.b2b_customer_allergens ca
             JOIN gold.product_allergens pa ON pa.allergen_id = ca.allergen_id
             WHERE ca.b2b_customer_id = c.id
               AND pa.product_id = ${productId}::uuid
               AND ca.is_active = true),
            0
          )                                                               AS allergen_conflicts,
          COALESCE(
            (SELECT COUNT(*)::int
             FROM gold.b2b_customer_dietary_preferences cdp
             JOIN gold.product_dietary_preferences pdp ON pdp.diet_id = cdp.diet_id
             WHERE cdp.b2b_customer_id = c.id
               AND pdp.product_id = ${productId}::uuid
               AND cdp.is_active = true
               AND pdp.is_compatible = true),
            0
          )                                                               AS diet_matches
        FROM gold.b2b_customers c
        WHERE c.vendor_id = ${vendorId}::uuid
          AND c.account_status = 'active'
        ORDER BY allergen_conflicts ASC, diet_matches DESC
        LIMIT ${limit}
      `);

      // HIPAA: health-derived fields must not be returned. Exclude customers with allergen conflicts.
      const customers = (fallbackRows.rows as any[])
        .filter((r) => parseInt(String(r.allergen_conflicts ?? "0"), 10) === 0)
        .map((r) => {
          const dietMatches = parseInt(String(r.diet_matches ?? "0"), 10);
          return {
            id: r.id,
            customer_id: r.id,
            name: r.customer_name,
            customer_name: r.customer_name,
            email: r.email,
            match_score: Math.min(1, dietMatches / 5),
          };
        });

      return ok(res, {
        customers,
        summary: { total_matched: customers.length },
        fallback: true,
      });
    } catch (sqlErr: any) {
      console.error("[matching-customers GET] SQL fallback error:", sqlErr?.message);
      ok(res, { customers: [], fallback: true, message: "Matching engine unavailable" });
    }
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

    // SQL fallback: find active products in the same category from the same vendor
    try {
      const fallbackRows = await db.execute(sql`
        SELECT p.id, p.name, p.brand, p.description,
               0.5 AS score, 'Similar category' AS reason
        FROM gold.products p
        WHERE p.vendor_id = ${vendorId}::uuid
          AND p.id != ${productId}::uuid
          AND p.status = 'Active'
          AND p.category_id IS NOT NULL
          AND p.category_id = (
            SELECT category_id FROM gold.products
            WHERE id = ${productId}::uuid
          )
        ORDER BY RANDOM()
        LIMIT ${limit}
      `);
      const substitutes = (fallbackRows.rows ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        brand: r.brand ?? null,
        description: r.description ?? null,
        score: r.score,
        reason: r.reason,
      }));
      return ok(res, { substitutes, fallback: true });
    } catch {
      return ok(res, { substitutes: [], fallback: true });
    }
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

    // SQL fallback: find active products in the same category from the same vendor
    try {
      const fallbackRows = await db.execute(sql`
        SELECT p.id, p.name, p.brand, p.description,
               0.5 AS score, 'Similar category' AS reason
        FROM gold.products p
        WHERE p.vendor_id = ${vendorId}::uuid
          AND p.id != ${productId}::uuid
          AND p.status = 'Active'
          AND p.category_id IS NOT NULL
          AND p.category_id = (
            SELECT category_id FROM gold.products
            WHERE id = ${productId}::uuid
          )
        ORDER BY RANDOM()
        LIMIT ${limit}
      `);
      const substitutes = (fallbackRows.rows ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        brand: r.brand ?? null,
        description: r.description ?? null,
        score: r.score,
        reason: r.reason,
      }));
      ok(res, { substitutes, fallback: true });
    } catch {
      ok(res, { substitutes: [], fallback: true });
    }
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

  // customer list export (CSV or XLSX)
  app.get("/api/v1/customers/export", withAuth(async (req: any, res) => {
    try {
      const vendorId = req.auth?.vendorId;
      if (!vendorId) return problem(res, 403, "No vendor access", req);
      const format = String(req.query.format ?? "csv").toLowerCase();

      const result = await db.execute(sql`
        SELECT
          c.id,
          c.external_id,
          c.full_name,
          c.first_name,
          c.last_name,
          c.email,
          c.phone,
          c.date_of_birth,
          c.age,
          c.gender,
          c.account_status,
          c.customer_segment,
          c.customer_tier,
          c.location_country,
          c.location_region,
          c.location_city,
          c.location_postal_code,
          c.email_opt_out,
          c.custom_tags,
          c.notes,
          c.source_system,
          c.created_at,
          c.updated_at,
          CASE WHEN hp.customer_id IS NOT NULL THEN true ELSE false END AS has_health_profile
        FROM gold.b2b_customers c
        LEFT JOIN (
          SELECT DISTINCT customer_id FROM gold.b2b_customer_health_profiles
        ) hp ON hp.customer_id = c.id
        WHERE c.vendor_id = ${vendorId}::uuid
        ORDER BY c.created_at DESC
        LIMIT 10000
      `);

      const rows = result.rows as any[];
      const header = [
        "id", "external_id", "full_name", "first_name", "last_name",
        "email", "phone", "date_of_birth", "age", "gender",
        "status", "customer_segment", "customer_tier",
        "location_country", "location_region", "location_city", "location_postal_code",
        "email_opt_out", "custom_tags", "notes", "source_system",
        "created_at", "updated_at", "has_health_profile",
      ];
      const dateStr = new Date().toISOString().slice(0, 10);

      const toRow = (r: any) => [
        r.id,
        r.external_id ?? "",
        r.full_name ?? "",
        r.first_name ?? "",
        r.last_name ?? "",
        r.email ?? "",
        r.phone ?? "",
        r.date_of_birth ? String(r.date_of_birth).slice(0, 10) : "",
        r.age ?? "",
        r.gender ?? "",
        r.account_status ?? "",
        r.customer_segment ?? "",
        r.customer_tier ?? "",
        r.location_country ?? "",
        r.location_region ?? "",
        r.location_city ?? "",
        r.location_postal_code ?? "",
        r.email_opt_out ? "true" : "false",
        Array.isArray(r.custom_tags) ? r.custom_tags.join(";") : (r.custom_tags ?? ""),
        r.notes ?? "",
        r.source_system ?? "",
        r.created_at ? new Date(r.created_at).toISOString() : "",
        r.updated_at ? new Date(r.updated_at).toISOString() : "",
        r.has_health_profile ? "true" : "false",
      ];

      if (format === "xlsx") {
        const sheetData = [header, ...rows.map(toRow)];
        const ws = XLSX.utils.aoa_to_sheet(sheetData);
        // Auto-width columns
        ws["!cols"] = header.map((h) => ({ wch: Math.max(h.length + 2, 12) }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Members");
        const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="members-${dateStr}.xlsx"`);
        return res.send(buf);
      }

      // default: CSV
      const escape = (v: any) => {
        const s = String(v ?? "").replace(/"/g, '""');
        return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s}"` : s;
      };
      const lines = [
        header.join(","),
        ...rows.map((r) => toRow(r).map(escape).join(",")),
      ];
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="members-${dateStr}.csv"`);
      return res.send(lines.join("\n"));
    } catch (err: any) {
      return problem(res, 500, safeErrorDetail(err, "Export failed"), req);
    }
  }));

  // customers (paged) — supports ?segment=with_profile|no_profile and ?engagement=high|medium|low
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
      const segment = (req.query.segment as string) ?? "";
      const engagement = (req.query.engagement as string) ?? "";
      const status = (req.query.status as string) ?? "";

      // When segment/engagement filters are active, use a direct SQL query
      const hasFilter = segment || engagement || status;
      if (hasFilter && vendorId) {
        let whereExtra = sql``;
        if (segment === "with_profile") {
          whereExtra = sql`AND EXISTS (SELECT 1 FROM gold.b2b_customer_health_profiles hp WHERE hp.customer_id = c.id)`;
        } else if (segment === "no_profile") {
          whereExtra = sql`AND NOT EXISTS (SELECT 1 FROM gold.b2b_customer_health_profiles hp WHERE hp.customer_id = c.id)`;
        }
        if (engagement === "high") {
          whereExtra = sql`${whereExtra} AND EXISTS (SELECT 1 FROM gold.b2b_customer_health_profiles hp WHERE hp.customer_id = c.id AND hp.activity_level IN ('very','extra'))`;
        } else if (engagement === "medium") {
          whereExtra = sql`${whereExtra} AND EXISTS (SELECT 1 FROM gold.b2b_customer_health_profiles hp WHERE hp.customer_id = c.id AND hp.activity_level NOT IN ('very','extra'))`;
        } else if (engagement === "low") {
          whereExtra = sql`${whereExtra} AND NOT EXISTS (SELECT 1 FROM gold.b2b_customer_health_profiles hp WHERE hp.customer_id = c.id)`;
        }
        if (status && status !== "all") {
          whereExtra = sql`${whereExtra} AND c.account_status = ${status}`;
        }
        const searchClause = q
          ? sql`AND (c.name ILIKE ${"%" + q + "%"} OR c.email ILIKE ${"%" + q + "%"})`
          : sql``;
        const offset = (page - 1) * limit;
        const result = await db.execute(sql`
          SELECT c.*, hp.dietary_preference, hp.health_goals, hp.conditions,
                 hp.activity_level, hp.age, hp.gender
          FROM gold.b2b_customers c
          LEFT JOIN gold.b2b_customer_health_profiles hp ON hp.customer_id = c.id
          WHERE c.vendor_id = ${vendorId}::uuid
            AND c.soft_deleted_at IS NULL
            ${whereExtra}
            ${searchClause}
          ORDER BY c.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `);
        return ok(res, result.rows.map((row: any) => mapCustomerForApi({
          ...row,
          healthProfile: row.activity_level ? {
            dietaryPreference: row.dietary_preference,
            healthGoals: row.health_goals,
            conditions: row.conditions,
            activityLevel: row.activity_level,
            age: row.age,
            gender: row.gender,
          } : null,
        })));
      }

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
        // Fire-and-forget: log PHI access with reason — never block the response
        auditHealthAccess(
          req.auth,
          "READ_PHI",
          req.params.id,
          null,
          { reason_for_access: (req.headers["x-access-reason"] as string) ?? "unspecified" },
          req
        ).catch(() => {});
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
      const result = mapCustomerForApi(withHealth ?? base);
      // Best-effort webhook emission
      emitWebhookEvent(vendorId, "customer.updated", { customerId: id }).catch(() => {});
      return ok(res, result);
    } catch (e: any) {
      console.error("[PATCH /customers/:id]", e?.message || e);
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
      // Best-effort webhook emission
      emitWebhookEvent(vendorId, "health_profile.updated", { customerId }).catch(() => {});
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
      const responseData = {
        customer: mapCustomerForApi(merged),
        health: merged?.healthProfile
          ? {
            ...merged.healthProfile,
            activityLevel: toUiActivityLevel((merged.healthProfile as any).activityLevel ?? (merged.healthProfile as any).activity_level),
          }
          : null,
      };
      // Best-effort webhook emission
      emitWebhookEvent(vendorId, "customer.created", { customerId: created.customer.id, email: created.customer.email }).catch(() => {});
      return res.status(201).json(responseData);
    } catch (e: any) {
      return problem(res, 400, e?.message ?? "Create customer failed", req);
    }
  }));

  // Bulk customer import — POST /api/v1/customers/batch
  app.post("/api/v1/customers/batch", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    const userId   = req.auth?.userId ?? null;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const rows: Record<string, string>[] = req.body?.customers ?? [];
    if (!Array.isArray(rows) || rows.length === 0)
      return problem(res, 400, "No customers provided", req);
    if (rows.length > 500)
      return problem(res, 400, "Maximum 500 rows per batch", req);

    let inserted = 0, updated = 0;
    const errors: { row: number; message: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const email    = (r.email ?? "").trim().toLowerCase();
      const fullName = (r.full_name ?? r.fullName ?? r.name ?? "").trim();
      const extId    = (r.external_id ?? r.externalId ?? email).trim();
      if (!email || !fullName) {
        errors.push({ row: i + 2, message: "email and full_name are required" });
        continue;
      }
      try {
        const result = await db.execute(sql`
          INSERT INTO gold.b2b_customers
            (id, vendor_id, external_id, email, full_name, dob, age, gender, phone, account_status, created_at, updated_at)
          VALUES (
            gen_random_uuid(), ${vendorId}::uuid, ${extId}, ${email}, ${fullName},
            ${r.dob || null}, ${r.age ? parseInt(r.age, 10) : null}, ${r.gender || null}, ${r.phone || null},
            'active', now(), now()
          )
          ON CONFLICT (vendor_id, external_id) DO UPDATE SET
            email      = EXCLUDED.email,
            full_name  = EXCLUDED.full_name,
            updated_at = now()
          RETURNING (xmax = 0) AS is_insert
        `);
        if (result.rows[0]?.is_insert) inserted++; else updated++;
      } catch (e: any) {
        errors.push({ row: i + 2, message: e.message ?? "Insert failed" });
      }
    }

    await db.execute(sql`
      INSERT INTO gold.audit_log (vendor_id, user_id, action, resource_type, metadata, created_at)
      VALUES (${vendorId}::uuid, ${userId ? `${userId}::uuid` : null}, 'bulk_import', 'customer',
        ${JSON.stringify({ inserted, updated, errors: errors.length })}::jsonb, now())
    `).catch(() => {});

    return ok(res, { inserted, updated, errors, total: rows.length });
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

