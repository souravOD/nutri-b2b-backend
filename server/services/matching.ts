// server/services/matching.ts
import type { Request } from "express";
import Redis from "ioredis";
import { db, readDb } from "../lib/database.js";
import {
  products,
  customers,
  customerHealthProfiles,
  vendors,
  matchesCache,
  dietRules,
} from "../../shared/schema.js";
import { and, eq, desc, sql } from "drizzle-orm";
import { auditAction } from "../lib/audit.js";

// Optional Redis (already in your repo)
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

function redisKey(vendorId: string, customerId: string, catalogVersion: number, k: number) {
  return `matches:v${vendorId}:c${customerId}:cv${catalogVersion}:k${k}:algo2`; // add :algo2
}



// --- helpers ---------------------------------------------------------------

// (c) two-pass candidate fetch: first with required tags; if empty, retry without them
async function fetchCandidates(
  vendorId: string,
  avoidAllergens: string[],
  requiredTags: string[]
) {
  const base = and(
    eq(products.vendorId, vendorId),
    eq(products.status, "active"),
    sql`NOT (coalesce(${products.allergens}, '{}') && ${textArray(avoidAllergens)})`
  );

  // pass 1: honor required tags if present
  const pass1Where = requiredTags.length
    ? and(base, sql`${products.dietaryTags} @> ${textArray(requiredTags)}`)
    : base;

  const pass1 = await readDb
    .select()
    .from(products)
    .where(pass1Where)
    .orderBy(desc(products.updatedAt))
    .limit(500);

  if (pass1.length || !requiredTags.length) return pass1;

  // pass 2: fallback without required tags so strict rules can't zero results
  return await readDb
    .select()
    .from(products)
    .where(base)
    .orderBy(desc(products.updatedAt))
    .limit(500);
}

/** SQL literal for a text[] array */
function textArray(a: string[]) {
  if (!a?.length) return sql`ARRAY[]::text[]`;
  // ARRAY['a','b','c']::text[]
  return sql`ARRAY[${sql.join(a.map((x) => sql`${x}`), sql`, `)}]::text[]`;
}

type Limits = Record<string, number>;
type Policy = {
  hard_limits?: Limits;
  soft_limits?: Limits;
  required_tags?: string[];
  bonus_tags?: string[];
  penalty_tags?: string[];
};

function mergePolicies(policies: Policy[]): Policy {
  const out: Policy = { hard_limits: {}, soft_limits: {}, required_tags: [], bonus_tags: [], penalty_tags: [] };
  for (const p of policies) {
    Object.assign(out.hard_limits!, p.hard_limits);
    Object.assign(out.soft_limits!, p.soft_limits);
    out.required_tags!.push(...(p.required_tags ?? []));
    out.bonus_tags!.push(...(p.bonus_tags ?? []));
    out.penalty_tags!.push(...(p.penalty_tags ?? []));
  }
  // de-dupe tag lists
  out.required_tags = Array.from(new Set(out.required_tags));
  out.bonus_tags = Array.from(new Set(out.bonus_tags));
  out.penalty_tags = Array.from(new Set(out.penalty_tags));
  return out;
}

function over(x: number | undefined, limit: number | undefined) {
  if (x == null || limit == null || limit <= 0) return 0;
  return x > limit ? (x - limit) / limit : 0;
}

function getNumber(obj: any, key: string): number | undefined {
  const v = obj?.[key];
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// --- main API --------------------------------------------------------------

export async function getMatchesForCustomer(
  vendorId: string,
  customerId: string,
  k = 20,
  req?: Request
) {
  // 1) Vendor catalog version (for cache key)
  const vRow = await db
    .select({ cv: vendors.catalogVersion })
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .limit(1);
  const catalogVersion = vRow[0]?.cv ?? 1;

  // 2) Try Redis first
  const rkey = redisKey(vendorId, customerId, catalogVersion, k);
  if (redis) {
    const cached = await redis.get(rkey);
    if (cached) return { items: JSON.parse(cached), cached: true, catalogVersion };
  }

  // 3) Try DB cache second
  const dbCache = await db
    .select({ results: matchesCache.results })
    .from(matchesCache)
    .where(
      and(
        eq(matchesCache.vendorId, vendorId),
        eq(matchesCache.customerId, customerId),
        eq(matchesCache.catalogVersion, catalogVersion),
        sql`now() < ${matchesCache.ttlAt}`
      )
    )
    .limit(1);
  if (dbCache[0]?.results) return { items: dbCache[0].results as any[], cached: true, catalogVersion };

  // 4) Load profile + compile policy
  const profile = (
    await readDb
      .select()
      .from(customerHealthProfiles)
      .where(eq(customerHealthProfiles.customerId, customerId))
      .limit(1)
  )[0];

  if (!profile) {
    return { items: [], cached: false, catalogVersion };
  }

  const avoidAllergens: string[] = (profile as any).avoidAllergens ?? [];
  const preferredDiets: string[] = (profile as any).dietGoals ?? [];

  // Vendor diet rules matching conditions[]
  const conds: string[] = (profile as any).conditions ?? [];
  const rules = conds.length
    ? await readDb
        .select({ policy: dietRules.policy })
        .from(dietRules)
        .where(and(eq(dietRules.vendorId, vendorId), sql`${dietRules.conditionCode} = ANY (${textArray(conds)})`, sql`${dietRules.active} = true`))
    : [];
  const merged: Policy = mergePolicies(rules.map((r) => r.policy as Policy));

  // existing limits
  const derived = ((profile as any).derivedLimits ?? {}) as Limits;
  const hardLimits: Limits = { ...(merged.hard_limits ?? {}), ...derived };
  const softLimits: Limits = { ...(merged.soft_limits ?? {}) };

  // ✅ CHANGED: only policy-required tags are *hard*.
  // User goals are *preferences* (for scoring)
  const requiredTags: string[] = merged.required_tags ?? [];
  const preferTags: string[] = Array.from(
    new Set([...(merged.bonus_tags ?? []), ...preferredDiets])
  );

  // 5) Candidates (two-pass: required-tags → fallback if pass1 is empty)
  const candidates = await fetchCandidates(
    vendorId,
    avoidAllergens,
    requiredTags
  );

  // 6) Score & final hard checks
  const W_DIET = 0.30, W_SOFT = -0.20, W_RECENCY = 0.05;
  const now = Date.now();
  const items = candidates
    .map((p: any) => {
      const n = (p.nutrition ?? {}) as Record<string, any>;

      // hard limits: reject only when value is known and exceeds
      for (const [key, lim] of Object.entries(hardLimits)) {
        const v = n[key];
        if (v != null && Number.isFinite(Number(v)) && Number(v) > Number(lim)) return null;
      }

      // preference hit: overlap with preferTags
      const pTags: string[] = p.dietaryTags ?? [];
      const dietHit = preferTags.length
        ? preferTags.filter(t => pTags.includes(t)).length / preferTags.length
        : 0;

      // soft sodium penalty (same as today)
      let penalty = 0;
      if (n.sodium_mg != null && hardLimits.sodium_mg) {
        const v = Number(n.sodium_mg), L = Number(hardLimits.sodium_mg);
        if (Number.isFinite(v) && Number.isFinite(L) && L > 0) {
          penalty = Math.min(0.2, Math.max(0, ((v - 0.5 * L) / (0.5 * L)) * 0.2));
        }
      }

      // small recency boost (unused before)
      const updated = p.updatedAt ? new Date(p.updatedAt).getTime() : now;
      const ageDays = Math.max(0, (now - updated) / 86_400_000);
      const recency = Math.max(0, 1 - Math.min(ageDays / 90, 1)); // 0..1 within ~90d

      const _score = Math.max(0, Math.min(1, 0.6 + 0.4 * dietHit + W_SOFT * penalty + W_RECENCY * recency));
      const score_pct = Math.round(_score * 100);

      return { ...p, _score, score_pct, _updatedAtMs: updated };
    })
    .filter(Boolean)
    // ⬇️ THIS WAS MISSING: sort by score desc, then recency desc
    .sort((a: any, b: any) => (b._score - a._score) || (b._updatedAtMs - a._updatedAtMs))
    .slice(0, k);
  

  // 7) Cache (Redis + DB)
  if (redis) await redis.setex(redisKey(vendorId, customerId, catalogVersion, k), 15 * 60, JSON.stringify(items));
  await db
    .insert(matchesCache)
    .values({
      vendorId,
      customerId,
      catalogVersion,
      results: items as any,
      ttlAt: sql`now() + interval '15 minutes'`,
    })
    .onConflictDoUpdate({
      target: [matchesCache.vendorId, matchesCache.customerId, matchesCache.catalogVersion],
      set: { results: items as any, ttlAt: sql`now() + interval '15 minutes'` },
    });

  // 8) Audit (optional)
  if (req) {
    await auditAction(req, {
      action: "read",
      entity: "matches",
      entityId: `${customerId}`,
      after: { count: items.length, k },
    }).catch(() => {});
  }

  return { items, cached: false, catalogVersion };
}

export async function getMatchesForCustomerWithOverrides(
  vendorId: string,
  customerId: string,
  overrides: Partial<{ avoidAllergens: string[]; dietGoals: string[]; conditions: string[]; derivedLimits: Record<string, number> }>,
  k = 20,
  req?: Request
) {
  const vRow = await db.select({ cv: vendors.catalogVersion }).from(vendors).where(eq(vendors.id, vendorId)).limit(1);
  const catalogVersion = vRow[0]?.cv ?? 1;

  const profile = (await readDb.select().from(customerHealthProfiles).where(eq(customerHealthProfiles.customerId, customerId)).limit(1))[0] ?? {};
  const avoidAllergens = Array.from(new Set([...(profile as any).avoidAllergens ?? [], ...(overrides.avoidAllergens ?? [])]));
  const preferredDiets = Array.from(new Set([...(profile as any).dietGoals ?? [], ...(overrides.dietGoals ?? [])]));
  const conditions     = Array.from(new Set([...(profile as any).conditions ?? [], ...(overrides.conditions ?? [])]));

  const rules = conditions.length
    ? await readDb.select({ policy: dietRules.policy })
        .from(dietRules)
        .where(and(eq(dietRules.vendorId, vendorId), sql`${dietRules.conditionCode} = ANY (${textArray(conditions)})`, eq(dietRules.active, true)))
    : [];
  const merged = mergePolicies(rules.map((r: any) => r.policy));
  const derived = ((profile as any).derivedLimits ?? {}) as Record<string, number>;
  const hardLimits = { ...(merged.hard_limits ?? {}), ...derived, ...(overrides.derivedLimits ?? {}) };
  const requiredTags: string[] = merged.required_tags ?? [];
  const preferTags   : string[] = Array.from(new Set([...(merged.bonus_tags ?? []), ...preferredDiets]));

  const candidates = await fetchCandidates(vendorId, avoidAllergens, requiredTags);
  const now = Date.now();
  const items = candidates
    .map((p: any) => {
      const n = (p.nutrition ?? {}) as Record<string, any>;
      for (const [key, lim] of Object.entries(hardLimits)) {
        const v = n?.[key];
        if (v != null && Number.isFinite(Number(v)) && Number(v) > Number(lim)) return null;
      }
      const tags: string[] = p.dietaryTags ?? [];
      const hit = preferTags.length ? preferTags.filter(t => tags.includes(t)).length / preferTags.length : 0;
      let penalty = 0;
      if (n?.sodium_mg != null && hardLimits?.sodium_mg) {
        const v = Number(n.sodium_mg), L = Number(hardLimits.sodium_mg);
        if (Number.isFinite(v) && Number.isFinite(L) && L > 0) {
          penalty = Math.min(0.2, Math.max(0, ((v - 0.5 * L) / (0.5 * L)) * 0.2));
        }
      }
      const updated = p.updatedAt ? new Date(p.updatedAt).getTime() : now;
      const ageDays = Math.max(0, (now - updated) / 86_400_000);
      const recency = Math.max(0, 1 - Math.min(ageDays / 90, 1));
      const score01 = Math.max(0, Math.min(1, 0.6 + 0.4 * hit - penalty + 0.05 * recency));
      return { ...p, _score: score01, score_pct: Math.round(score01 * 100), _updatedAtMs: updated };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => (b._score - a._score) || (b._updatedAtMs - a._updatedAtMs))
    .slice(0, k);

  if (req) {
    await auditAction(req, { action: "read", entity: "matches.preview", entityId: `${customerId}`, after: { count: items.length, k } }).catch(() => {});
  }
  return { items, cached: false, catalogVersion };
}