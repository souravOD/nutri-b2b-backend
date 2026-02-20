import type { Express, Request, Response, NextFunction, RequestHandler } from "express";
import { storage } from "./storage.js";
import { extractJWT, requireAuth } from "./lib/auth.js";
import { and, eq, desc, sql } from "drizzle-orm";
import * as schema from "../shared/schema.js";
import { db } from "./lib/database.js";
import { supabaseAdmin } from "./lib/supabase.js";     // service-role client
import { queue } from "./lib/queue.js";                // your job queue
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
import Busboy from 'busboy';
import { createClient } from "@supabase/supabase-js";
import multer from "multer";


const upload = multer({ storage: multer.memoryStorage() });
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CSV_BUCKET = process.env.SUPABASE_CSV_BUCKET ?? "ingestion";
const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

const JOBS_ENABLED = process.env.B2B_ENABLE_JOBS === "1";
const MATCHING_ENABLED = process.env.B2B_ENABLE_MATCHING === "1";


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


async function ensureBucket(name: string) {
  const { data, error } = await supabaseAdmin.storage.listBuckets();
  if (!error && !data?.some(b => b.name === name)) {
    await supabaseAdmin.storage.createBucket(name, { public: false });
  }
}

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
    if (p?.hard_limits)  Object.assign(out.hard_limits!, p.hard_limits);
    if (p?.soft_limits)  Object.assign(out.soft_limits!, p.soft_limits);
    if (p?.required_tags) out.required_tags!.push(...p.required_tags);
    if (p?.bonus_tags)    out.bonus_tags!.push(...p.bonus_tags);
    if (p?.penalty_tags)  out.penalty_tags!.push(...p.penalty_tags);
  }
  out.required_tags = Array.from(new Set(out.required_tags));
  out.bonus_tags    = Array.from(new Set(out.bonus_tags));
  out.penalty_tags  = Array.from(new Set(out.penalty_tags));
  return out;
}

// GUARANTEE both _score (0..1) and score_pct (0..100) for the client
const withScorePct = (p: any) => {
  const raw01 =
    typeof p?._score === "number" ? p._score :
    typeof p?.score  === "number" ? p.score  :
    (typeof p?.score_pct === "number" ? p.score_pct / 100 : undefined);
  if (raw01 == null) return p;
  const pct = Math.round(raw01 * 100);
  return { ...p, _score: raw01, score_pct: pct };
};

function toGoldProductStatus(status?: string): "active" | "discontinued" | "out_of_stock" {
  const s = String(status || "active").toLowerCase();
  if (s === "inactive" || s === "discontinued") return "discontinued";
  if (s === "out_of_stock") return "out_of_stock";
  return "active";
}

function toUiProductStatus(status?: string): "active" | "inactive" {
  const s = String(status || "active").toLowerCase();
  return s === "active" ? "active" : "inactive";
}

function toGoldCustomerStatus(status?: string): "active" | "inactive" | "suspended" {
  const s = String(status || "active").toLowerCase();
  if (s === "archived") return "inactive";
  if (s === "inactive") return "inactive";
  if (s === "suspended") return "suspended";
  return "active";
}

function toUiCustomerStatus(status?: string): "active" | "archived" {
  const s = String(status || "active").toLowerCase();
  return s === "active" ? "active" : "archived";
}

function toGoldActivityLevel(activity?: string): "sedentary" | "lightly_active" | "moderately_active" | "very_active" | "extra_active" {
  const a = String(activity || "sedentary").toLowerCase();
  if (a === "light" || a === "lightly_active") return "lightly_active";
  if (a === "moderate" || a === "moderately_active") return "moderately_active";
  if (a === "very" || a === "very_active") return "very_active";
  if (a === "extra" || a === "extra_active") return "extra_active";
  return "sedentary";
}

function toUiActivityLevel(activity?: string): "sedentary" | "light" | "moderate" | "very" | "extra" {
  const a = String(activity || "sedentary").toLowerCase();
  if (a === "lightly_active" || a === "light") return "light";
  if (a === "moderately_active" || a === "moderate") return "moderate";
  if (a === "very_active" || a === "very") return "very";
  if (a === "extra_active" || a === "extra") return "extra";
  return "sedentary";
}

function mapProductForApi(row: any) {
  if (!row) return row;
  return {
    ...row,
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
      } catch {}
      return handler(req, res, next);
    });
  };
};

// ---------- ROUTES ----------

export function registerRoutes(app: Express) {
  // health
  app.get("/health", (_req, res) => {
    ok(res, {
      status: "healthy",
      timestamp: sql`now()`,
      version: process.env.npm_package_version ?? "dev",
    });
  });

  // metrics (stub if not implemented in storage)
  app.get("/metrics", withAuth(async (req: any, res) => {
    const s: any = storage as any;
    const vendorId = req.auth?.vendorId ?? null;

    if (typeof s.getSystemMetrics === "function") {
      try {
        const metrics = await s.getSystemMetrics(vendorId);
        return ok(res, metrics);
      } catch (e: any) {
        console.warn("[metrics] fallback:", e?.message || e);
      }
    }

    // fallback stub so the page renders
    return ok(res, {
      uptimeSec: Math.floor(process.uptime()),
      api: "ok",
      vendorId,
      notes: "metrics stub (implement storage.getSystemMetrics to replace)",
    });
  }));

  // vendors (stub if storage.getVendors missing)
  app.get("/vendors", withAuth(async (req: any, res) => {
    const s: any = storage as any;
    if (typeof s.getVendors === "function") {
      try {
        const vendors = await s.getVendors();
        return ok(res, { data: vendors });
      } catch (e: any) {
        console.warn("[vendors] fallback:", e?.message || e);
      }
    }
    return ok(res, { data: [] }); // empty list is fine for the Vendors page
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

      const appwriteVendorPayload = {
        name: input.companyName,
        slug: resolvedSlug,
        billing_email: input.billingEmail,
        owner_user_id: appwriteUser.id,
        created_at: new Date().toISOString(),
        status: "active" as const,
        team_id: team.teamId,
        domains: [domain],
        ...(input.phone ? { phone: input.phone } : {}),
        ...(input.country ? { country: input.country } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
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
            phone,
            country,
            timezone
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
            ${input.phone},
            ${input.country},
            ${input.timezone}
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
    
      const page  = Math.max(1, parseInt((req.query.page  as string) || "1"));
      const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || "50")));
    
      const q          = (req.query.q as string) || undefined;
      const brand      = (req.query.brand as string) || undefined;
      const status     = (req.query.status as string) || undefined;
      const categoryId = (req.query.category_id as string) || undefined;
    
      // If there's a search term or any filter, use the search path
      if ((q || brand || status || categoryId) && typeof s.searchProducts === "function") {
        const itemsOrResult = await s.searchProducts(
          vendorId,
          q,
          { brand, status, categoryId, page, pageSize: limit }
        );
    
        const data  = (itemsOrResult?.items ?? itemsOrResult) || [];
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
      return problem(res, 500, err?.message || "Failed to load products", req);
    }
  }));

  // product by id
  app.get("/products/:id", withAuth(async (req: any, res) => {
    const s: any = storage as any;
    const vendorId = req.auth?.vendorId;
    if (typeof s.getProduct === "function") {
      const product = await s.getProduct(req.params.id, vendorId);
      if (!product) return problem(res, 404, "Product not found", req);
      return ok(res, mapProductForApi(product));
    }
    return problem(res, 404, "Product not found", req);
  }));

  // --- CREATE product ---
  app.post("/products", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const b = req.body ?? {};

    // helpers
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
    const toArr = (v: any): string[] | undefined => {
      if (v == null) return undefined;
      if (Array.isArray(v)) return v.filter(Boolean).map(String);
      if (typeof v === "string") return v.split(",").map(s => s.trim()).filter(Boolean);
      return undefined;
    };
    const toNumStr = (n: any): string | undefined => {
      if (n === undefined || n === null || n === "") return undefined;
      const s = String(n);
      return isNaN(Number(s)) ? undefined : s;
    };

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
      return problem(res, 500, err?.message || "Failed to update product", req);
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
      return problem(res, 500, err?.message || "Failed to delete product", req);
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

      const items = await s.getCustomers(vendorId, { page, pageSize: limit });
      return ok(res, Array.isArray(items) ? items.map(mapCustomerForApi) : []);
    } catch (err: any) {
      return problem(res, 500, err?.message || "Failed to load customers", req);
    }
  }));

  // customer by id
  app.get("/customers/:id", withAuth(async (req: any, res) => {
    const s: any = storage as any;
    const vendorId = req.auth?.vendorId;
    if (typeof s.getCustomer === "function") {
      const customer = await storage.getCustomerWithProfile(req.params.id, vendorId);
      if (!customer) return problem(res, 404, "Customer not found", req);
      return ok(res, mapCustomerForApi(customer));
    }
    return problem(res, 404, "Customer not found", req);
  }));

  // GET /taxonomy/diets?top=10[&all=1]
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

  // GET /taxonomy/allergens?top=10[&all=1]
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

  // GET /taxonomy/conditions?top=10[&all=1]
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

  // UPDATE customer (profile fields)
  app.patch("/customers/:id", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    const userId   = req.auth?.userId ?? null;
    const id       = String(req.params.id);
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

    // Location (jsonb)
    if (b.location && typeof b.location === "object") {
      const l = b.location;
      updates.location = {
        city: typeof l.city === "string" ? l.city.trim() : null,
        state: typeof l.state === "string" ? l.state.trim() : null,
        postal: typeof l.postal === "string" ? l.postal.trim() : null,
        country: typeof l.country === "string" ? l.country.trim().toUpperCase() : null,
      } as any;
    }

    if (req.auth?.userId) updates.updatedBy = req.auth.userId;

    // 🔎 Debug
    console.log('[PATCH /customers/:id] body=', b);
    console.log('[PATCH /customers/:id] updates=', updates);
        
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
    const row = await (storage as any).getCustomerProductNote(String(req.params.id), String(req.params.productId));
    return ok(res, row ?? { note: null });
  }));

  app.patch("/customers/:id/products/:productId/notes", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    const userId   = req.auth?.userId ?? null;
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
    const vendorId   = req.auth?.vendorId;
    const userId     = req.auth?.userId ?? null;
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
      heightCm:       toNum(b.heightCm ?? b.height_cm),
      weightKg:       toNum(b.weightKg ?? b.weight_kg),
      age:            b.age !== undefined ? toNum(b.age) : undefined,
      gender:         b.gender ?? undefined,
      activityLevel:  (b.activityLevel ?? b.activity_level) !== undefined
        ? toGoldActivityLevel(b.activityLevel ?? b.activity_level)
        : undefined,
      conditions:     Array.isArray(b.conditions) ? b.conditions : undefined,
      dietGoals:      Array.isArray(b.dietGoals)  ? b.dietGoals  : undefined,
      macroTargets:   b.macroTargets ?? b.macro_targets ?? undefined, // jsonb
      avoidAllergens: Array.isArray(b.avoidAllergens) ? b.avoidAllergens : undefined,
      bmi:            toNum(b.bmi),
      bmr:            toNum(b.bmr),
      tdeeCached:     toNum(b.tdeeCached ?? b.tdee_cached),
      derivedLimits:  b.derivedLimits ?? b.derived_limits ?? undefined,
      updatedBy:      userId,
    };

    // Drop only undefined (so 0 / empty-arrays still update)
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined)
    );

    try {
      const row = await storage.upsertCustomerHealth(customerId, vendorId, clean);
      return res.status(200).json({
        ...row,
        activityLevel: toUiActivityLevel((row as any).activityLevel ?? (row as any).activity_level),
      });
    } catch (e: any) {
      return problem(res, 400, e?.message ?? "Health update failed", req);
    }
  }));

  // routes.ts
  app.post("/customers", withAuth(async (req: any, res) => {
    const vendorId = req.auth?.vendorId;
    const userId   = req.auth?.userId ?? null;
    if (!vendorId) return problem(res, 403, "No vendor access", req);

    const b = req.body ?? {};

    // Basic customer fields the form already collects
    const customerInput = {
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
      return res.status(201).json({
        customer: mapCustomerForApi(created.customer),
        health: created.health
          ? {
              ...created.health,
              activityLevel: toUiActivityLevel((created.health as any).activityLevel),
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
    
    let preferred: any[] = [];
    // 2) Try the service first
    const USE_SERVICE = process.env.USE_MATCHING_SERVICE === "1";
    if (USE_SERVICE) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const svc = require("./services/matching");
       if (typeof svc.getMatchesForCustomer === "function") {
         const raw = await svc.getMatchesForCustomer(vendorId, customerId, limit);
         preferred = asArray(raw).map(withScorePct).slice(0, limit);
       }
      } catch {
        // swallow & continue to fallback
      }
    }
  
    // 3) Fallback: simple but faithful prefilter + scoring
    const p = schema.products;
  
    // Bring in a bit of the profile (avoid + limits)
    const chp = schema.customerHealthProfiles;
    const cx = await db
      .select({
        avoidAllergens: chp.avoidAllergens,
        dietGoals:     chp.dietGoals,
        derivedLimits: chp.derivedLimits,
        conditions:    chp.conditions,
      })
      .from(chp)
      .where(eq(chp.customerId, customerId))
      .limit(1);
  
    const avoidRaw = cx?.[0]?.avoidAllergens ?? [];
    const avoid: string[] = Array.isArray(avoidRaw) ? avoidRaw : [avoidRaw].filter(Boolean);
    const goals  = cx?.[0]?.dietGoals ?? [];
    const limits = (cx?.[0]?.derivedLimits as any) ?? {};
    const conds = cx?.[0]?.conditions ?? [];

    // Fetch vendor diet policies for the customer's conditions
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

    // Merge policies into require/prefer/limits; combine with derivedLimits
    const merged = mergePolicies((rules ?? []).map((r: any) => r.policy));
    const requiredTags: string[] = merged.required_tags ?? [];
    const preferTags  : string[] = Array.from(new Set([...(merged.bonus_tags ?? []), ...goals]));
    const hardLimits  : Record<string, number> = { ...(merged.hard_limits ?? {}), ...limits };
      
    // vendor + active + NOT allergen conflicts (+ requiredTags if present)
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

    const base = await db
    .select()
    .from(p)
    .where(whereClause)
    .orderBy(desc(p.updatedAt))
    .limit(200);
  
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
    try{
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
          dietGoals:     chp.dietGoals,
          conditions:    chp.conditions,
          derivedLimits: chp.derivedLimits,
        })
        .from(chp)
        .where(eq(chp.customerId, customerId))
        .limit(1);

      const profile = {
        avoidAllergens: base?.[0]?.avoidAllergens ?? [],
        dietGoals:      base?.[0]?.dietGoals ?? [],
        conditions:     base?.[0]?.conditions ?? [],
        derivedLimits:  (base?.[0]?.derivedLimits as any) ?? {},
      };

      // Merge overrides (from UI) WITHOUT persisting
      const b = (req.body ?? {}) as Partial<{ allergens: string[]; preferred: string[]; conditions: string[]; required: string[] }>;
      const fromRequired = (b.required ?? []).filter(s => /^no\s+/i.test(s)).map(s => s.replace(/^no\s+/i, ""));
      const preview = {
        avoidAllergens: Array.from(new Set([...(profile.avoidAllergens ?? []), ...(b.allergens ?? []), ...fromRequired])),
        dietGoals:      Array.from(new Set([...(profile.dietGoals ?? []), ...(b.preferred ?? [])])),
        conditions:     Array.from(new Set([...(profile.conditions ?? []), ...(b.conditions ?? [])])),
        derivedLimits:  profile.derivedLimits ?? {},
      };

      // Prefer service helper if enabled
      if (process.env.USE_MATCHING_SERVICE === "1") {
        try {
          const svc = require("./services/matching");
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
      const preferTags  : string[] = Array.from(new Set([...(merged.bonus_tags ?? []), ...(preview.dietGoals ?? [])]));
      const hardLimits  : Record<string, number> = { ...(merged.hard_limits ?? {}), ...(preview.derivedLimits ?? {}) };

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
// Ingestion endpoints
// ─────────────────────────────────────────────────────────────────────────────

  // Create a job and tell the client where to upload the CSV
  app.post("/jobs", withAuth(async (req: any, res) => {
    if (!JOBS_ENABLED) {
      return res.status(503).json({
        ok: false,
        code: "JOBS_DISABLED",
        message: "Jobs and ingestion are temporarily disconnected in this phase.",
      });
    }
    const vendorId = req.auth?.vendorId as string | undefined;
    if (!vendorId) return res.status(401).json({ message: "Missing vendor" });
    const mode = ((req.query.mode as string) || "products") as "products" | "customers" | "api_sync";

    // create job
    const [job] = await db.insert(schema.ingestionJobs).values({
      vendorId,               // NOTE: camelCase – matches your other tables (e.g., customerId usage)
      mode,
      status: "queued",       // enum-safe; we'll flip to "running" in /start
      progressPct: 0,
      params: { source: "csv", name: `Import ${mode} CSV` },
    }).returning({ id: schema.ingestionJobs.id });

    const jobId = job.id as string;
    const storagePath = computeStoragePath(vendorId, jobId, mode);
    // after computing storagePath:
    await ensureBucket(CSV_BUCKET); // <— add
    // pre-store exact location so the UI knows and the worker doesn't guess
    await db.update(schema.ingestionJobs)
      .set({ params: { source: "csv", bucket: CSV_BUCKET, path: storagePath } })
      .where(eq(schema.ingestionJobs.id, jobId));

    return ok(res, { jobId, bucket: CSV_BUCKET, path: storagePath });
  }));

  type MulterRequest = Request & {
    file?: Express.Multer.File;
    files?: Express.Multer.File[];
  };  
  // Upload the CSV (multipart/form-data; field name MUST be 'file')
  app.post("/jobs/:id/upload",
    uploadMw.single("file"),        // <— field name MUST be "file"
    withAuth(async (req: any, res) => {
    if (!JOBS_ENABLED) {
        return res.status(503).json({
          ok: false,
          code: "JOBS_DISABLED",
          message: "Jobs and ingestion are temporarily disconnected in this phase.",
        });
      }
      const vendorId = req.auth?.vendorId as string | undefined;
      const jobId = String(req.params.id);
      const mode = String(req.query.mode || "products") as "products" | "customers" | "api_sync";
      if (!vendorId) return res.status(401).json({ message: "Missing vendor" });
  
      // 1) Read job and its planned bucket/path
      const [row] = await db
        .select({
          id: schema.ingestionJobs.id,
          vendorId: schema.ingestionJobs.vendorId,
          mode: schema.ingestionJobs.mode,
          params: schema.ingestionJobs.params,
        })
        .from(schema.ingestionJobs)
        .where(and(
          eq(schema.ingestionJobs.id, jobId),
          eq(schema.ingestionJobs.vendorId, vendorId),
        ));
  
      if (!row) return res.status(404).json({ message: "Job not found" });
  
      const p = (row.params || {}) as any;
      const bucket = String(p.bucket || process.env.SUPABASE_CSV_BUCKET || "ingestion");
      // If /jobs created 'path' already, use it; otherwise generate a sane default
      const storagePath = computeStoragePath(vendorId, jobId, mode);
  
      // 2) Validate file
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file || !file.buffer?.length) {
        return res.status(400).json({ message: "Missing CSV file in 'file' field" });
      }
  
      // 3) Ensure bucket exists
      try { await ensureBucket(bucket); } catch (_) {}
  
      // 4) Upload bytes using SERVICE-ROLE client
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
        
      // 5) Mark the job as 'uploaded'
      await db.update(schema.ingestionJobs)
        .set({
          params: {
            ...p,
            bucket,
            path: storagePath,
            contentType: file.mimetype || "text/csv",
            fileSize: file.size,
            uploaded: true,               // <— THIS IS WHAT THE WORKER READS
            source: p.source || "csv",
          },
          progressPct: 25,
        })
        .where(eq(schema.ingestionJobs.id, jobId));
  
      return ok(res, {
        ok: true,
        bucket,
        path: storagePath,
        size: file.size,
        mime: file.mimetype || "text/csv",
      });
    })
  );

  // Start processing (mark running and enqueue)
  app.post("/jobs/:id/start", withAuth(async (req: any, res) => {
    if (!JOBS_ENABLED) {
      return res.status(503).json({
        ok: false,
        code: "JOBS_DISABLED",
        message: "Jobs and ingestion are temporarily disconnected in this phase.",
      });
    }
    const vendorId = req.auth?.vendorId as string | undefined;
    const jobId = String(req.params.id);
    if (!vendorId) return res.status(401).json({ message: "Missing vendor" });
  
    const [row] = await db.select({
      params: schema.ingestionJobs.params
    }).from(schema.ingestionJobs)
      .where(and(
        eq(schema.ingestionJobs.id, jobId),
        eq(schema.ingestionJobs.vendorId, vendorId),
      ));
  
    const p = (row?.params || {}) as any;
    if (!p.bucket || !p.path || !p.uploaded) {
      return res.status(409).json({ message: "CSV not uploaded yet" });
    }
  
    const mapping = (req.body && (req.body.mapping || (req.body as any).map)) || null;
  
    await db.update(schema.ingestionJobs)
      .set({ status: "queued", startedAt: null, params: { ...p, ...(mapping ? { mapping } : {}) } })
      .where(eq(schema.ingestionJobs.id, jobId));
  
    return ok(res, { ok: true });
  }));

  // Single job (polled by the wizard)
  app.get("/jobs/:id", withAuth(async (req: any, res) => {
    if (!JOBS_ENABLED) {
      return ok(res, { id: String(req.params.id), status: "queued", progressPct: 0, disabled: true });
    }
    const vendorId = req.auth?.vendorId as string | undefined;
    const jobId = String(req.params.id);
    if (!vendorId) return res.status(401).json({ message: "Missing vendor" });

    const [job] = await db
      .select()
      .from(schema.ingestionJobs)
      .where(and(
        eq(schema.ingestionJobs.id, jobId),
        eq(schema.ingestionJobs.vendorId, vendorId),
      ));
    if (!job) return res.status(404).json({ message: "Job not found" });

    return ok(res, job);
  }));

  // Job errors (JSON)
  app.get("/jobs/:id/errors", withAuth(async (req: any, res) => {
    if (!JOBS_ENABLED) {
      return ok(res, { data: [] });
    }
    const vendorId = req.auth?.vendorId as string | undefined;
    const jobId = String(req.params.id);
    if (!vendorId) return res.status(401).json({ message: "Missing vendor" });

    // Ensure the job belongs to this vendor
    const [job] = await db
      .select({ id: schema.ingestionJobs.id, vendorId: schema.ingestionJobs.vendorId })
      .from(schema.ingestionJobs)
      .where(eq(schema.ingestionJobs.id, jobId));
    if (!job || job.vendorId !== vendorId) return res.status(404).json({ message: "Job not found" });

    const rows = await db
      .select({
        id: schema.ingestionJobErrors.id,
        rowNo: schema.ingestionJobErrors.rowNo,
        field: schema.ingestionJobErrors.field,
        code: schema.ingestionJobErrors.code,
        message: schema.ingestionJobErrors.message,
        raw: schema.ingestionJobErrors.raw,
      })
      .from(schema.ingestionJobErrors)
      .where(eq(schema.ingestionJobErrors.jobId, jobId));

    return ok(res, { data: rows });
  }));

  // Job errors CSV download
  app.get("/jobs/:id/errors.csv", withAuth(async (req: any, res) => {
    if (!JOBS_ENABLED) {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      return res.status(200).send("row_no,field,code,message,raw\n");
    }
    const vendorId = req.auth?.vendorId as string | undefined;
    const jobId = String(req.params.id);
    if (!vendorId) return res.status(401).json({ message: "Missing vendor" });

    const [job] = await db
      .select({ id: schema.ingestionJobs.id, vendorId: schema.ingestionJobs.vendorId })
      .from(schema.ingestionJobs)
      .where(eq(schema.ingestionJobs.id, jobId));
    if (!job || job.vendorId !== vendorId) return res.status(404).json({ message: "Job not found" });

    const rows = await db
      .select({
        rowNo: schema.ingestionJobErrors.rowNo,
        field: schema.ingestionJobErrors.field,
        code: schema.ingestionJobErrors.code,
        message: schema.ingestionJobErrors.message,
        raw: schema.ingestionJobErrors.raw,
      })
      .from(schema.ingestionJobErrors)
      .where(eq(schema.ingestionJobErrors.jobId, jobId));

    const header = ["row_no", "field", "code", "message", "raw"].join(",");
    const lines = rows.map((r: any) => {
      const esc = (s: any) => {
        const str = s == null ? "" : typeof s === "string" ? s : JSON.stringify(s);
        return '"' + String(str).replaceAll('"', '""') + '"';
      };
      return [r.rowNo, r.field ?? "", r.code ?? "", r.message ?? "", esc(r.raw ?? {})].join(",");
    });
    const csv = [header, ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=job_${jobId}_errors.csv`);
    return res.status(200).send(csv);
  }));

  // Export items CSV (best-effort)
  app.get("/jobs/:id/items.csv", withAuth(async (req: any, res) => {
    if (!JOBS_ENABLED) {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      return res.status(200).send("note\n\"Jobs are temporarily disconnected\"\n");
    }
    const vendorId = req.auth?.vendorId as string | undefined;
    const jobId = String(req.params.id);
    if (!vendorId) return res.status(401).json({ message: "Missing vendor" });

    const [job] = await db
      .select()
      .from(schema.ingestionJobs)
      .where(eq(schema.ingestionJobs.id, jobId));
    if (!job || job.vendorId !== vendorId) return res.status(404).json({ message: "Job not found" });

    const mode = String(job.mode || "products");
    let header = "";
    let rows: any[] = [];

    if (mode === "products") {
      // Try staging first (may be deleted post-merge)
      rows = await db
        .select({
          externalId: schema.stgProducts.externalId,
          name: schema.stgProducts.name,
          brand: schema.stgProducts.brand,
          categoryId: schema.stgProducts.categoryId,
          price: schema.stgProducts.price,
          currency: schema.stgProducts.currency,
        })
        .from(schema.stgProducts)
        .where(eq(schema.stgProducts.jobId, jobId));
      header = "external_id,name,brand,category_id,price,currency";
    } else if (mode === "customers") {
      rows = await db
        .select({
          externalId: schema.stgCustomers.externalId,
          fullName: schema.stgCustomers.fullName,
          email: schema.stgCustomers.email,
          phone: schema.stgCustomers.phone,
        })
        .from(schema.stgCustomers)
        .where(eq(schema.stgCustomers.jobId, jobId));
      header = "external_id,full_name,email,phone";
    } else {
      return res.status(501).json({ message: `Export not implemented for mode ${mode}` });
    }

    const esc = (s: any) => '"' + String(s ?? "").replaceAll('"', '""') + '"';
    const csvLines = [header];
    if (mode === "products") {
      csvLines.push(...rows.map((r: any) => [r.externalId, r.name, r.brand, r.categoryId, r.price, r.currency].map(esc).join(",")));
    } else {
      csvLines.push(...rows.map((r: any) => [r.externalId, r.fullName, r.email, r.phone].map(esc).join(",")));
    }

    if (rows.length === 0) {
      csvLines.push('"No staging rows available for this job (the worker may have already cleaned up)."');
    }

    const out = csvLines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=job_${jobId}_items.csv`);
    return res.status(200).send(out);
  }));

  // Jobs list (used by the Jobs page and Search)
  app.get("/jobs", withAuth(async (req: any, res) => {
    if (!JOBS_ENABLED) {
      return ok(res, { data: [], page: 1, pageSize: 0, total: 0, disabled: true });
    }
    const vendorId = req.auth?.vendorId as string;
    const qRaw = (req.query.q as string) ?? "";
    const q = qRaw.trim().toLowerCase();
    const statusUi = (req.query.status as string) || undefined;
    const typeUi = (req.query.type as string) || undefined; // Import|Export|Match (currently only Import maps)
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 100;

    // Map UI status to DB enum
    const statusMap: Record<string, string> = {
      running: "running",
      completed: "completed",
      failed: "failed",
      pending: "queued",
      queued: "queued",
      processing: "running",
    };
    const dbStatus = statusUi ? statusMap[String(statusUi).toLowerCase()] : undefined;

    // Base query scoped to vendor
    let base = await db.select().from(schema.ingestionJobs)
      .where(eq(schema.ingestionJobs.vendorId, vendorId))
      .orderBy(desc(schema.ingestionJobs.createdAt ?? sql`now()`))
      .limit(limit);

    // In-memory filters for q/type/status (cheap list)
    if (dbStatus) {
      base = base.filter((j: any) => String(j.status).toLowerCase() === dbStatus);
    }
    if (typeUi) {
      const t = String(typeUi).toLowerCase();
      // Today: products/customers/api_sync -> Import; keep flexible for future mapping
      base = base.filter((j: any) =>
        (t === "import" && ["products","customers","api_sync"].includes(String(j.mode).toLowerCase()))
        || (t === "match" && String(j.mode).toLowerCase().includes("match"))
        || (t === "export" && String(j.mode).toLowerCase().includes("export"))
      );
    }
    if (q) {
      base = base.filter((j: any) => {
        const created = j.createdAt ? new Date(j.createdAt).toISOString().toLowerCase() : "";
        const p = (j.params || {}) as any;
        return (
          String(j.id).toLowerCase().includes(q)
          || String(j.mode ?? "").toLowerCase().includes(q)
          || String(j.status ?? "").toLowerCase().includes(q)
          || String(p?.source ?? "").toLowerCase().includes(q)
          || String(p?.name ?? "").toLowerCase().includes(q)
          || created.includes(q)
        );
      });
    }

    return ok(res, { data: base, page: 1, pageSize: base.length, total: base.length });
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

