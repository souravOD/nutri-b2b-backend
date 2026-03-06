import { db } from "./database.js";
import { healthConditions, taxAllergens, taxTags } from "../../shared/schema.js";
import { sql } from "drizzle-orm";

/** Resolve input (code or label) to taxonomy id; matches by code first, then by name/label */
async function resolveByCodeOrLabel(
  table: typeof healthConditions | typeof taxAllergens | typeof taxTags,
  codeColumn: any,
  labelColumn: any,
  inputs: string[]
): Promise<string[]> {
  if (!inputs?.length) return [];
  const normalized = inputs.map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return [];
  const placeholders = sql.join(normalized.map((n) => sql`${n}`), sql`, `);
  const byCode = await db
    .select({ id: table.id })
    .from(table)
    .where(sql`lower(${codeColumn}) IN (${placeholders})`);
  const byLabel = await db
    .select({ id: table.id })
    .from(table)
    .where(sql`lower(${labelColumn}) IN (${placeholders})`);
  let allIds = [...byCode.map((r) => r.id), ...byLabel.map((r) => r.id)];

  // Fallback: if exact match failed, try ILIKE on label (e.g. "dairy" -> "Milk (dairy)", "hypertension" -> "Hypertension (High Blood Pressure)")
  if (allIds.length === 0 && normalized.length > 0) {
    for (const n of normalized) {
      const pattern = `%${n}%`;
      const likeMatch = await db
        .select({ id: table.id })
        .from(table)
        .where(sql`${labelColumn} ILIKE ${pattern}`);
      allIds = [...allIds, ...likeMatch.map((r) => r.id)];
    }
    allIds = [...new Set(allIds)];
  }

  const result = [...new Set(allIds)];

  // [DEBUG] Log resolution - helps diagnose when inputs don't match DB
  if (inputs.length > 0 && result.length === 0) {
    console.warn("[taxonomy resolveByCodeOrLabel] no matches:", { inputs, normalized, byCodeCount: byCode.length, byLabelCount: byLabel.length });
  }

  return result;
}

/** Resolve condition codes/labels to health_conditions.id */
export async function resolveConditionIds(codes: string[]): Promise<string[]> {
  return resolveByCodeOrLabel(healthConditions, healthConditions.code, healthConditions.label, codes);
}

/** Resolve allergen codes/labels to allergens.id. Also matches common_names array if exact match fails. */
export async function resolveAllergenIds(codes: string[]): Promise<string[]> {
  const ids = await resolveByCodeOrLabel(taxAllergens, taxAllergens.code, taxAllergens.label, codes);
  if (ids.length > 0) return ids;

  // Fallback: match against common_names array (gold.allergens.common_names)
  const normalized = codes.map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return [];

  const found: string[] = [];
  for (const n of normalized) {
    const rows = await db.execute(sql`
      SELECT id FROM gold.allergens
      WHERE EXISTS (
        SELECT 1 FROM unnest(COALESCE(common_names, ARRAY[]::text[])) AS cn
        WHERE lower(cn) = ${n}
      )
    `);
    const r = rows.rows as { id: string }[] | undefined;
    if (r?.length) found.push(...r.map((x) => x.id));
  }
  return [...new Set(found)];
}

/** Resolve diet codes/labels to dietary_preferences.id */
export async function resolveDietIds(codes: string[]): Promise<string[]> {
  return resolveByCodeOrLabel(taxTags, taxTags.code, taxTags.label, codes);
}
