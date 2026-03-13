import {
  type Vendor,
  type InsertVendor,
  vendors,
  users,
  products,
  customers,
  customerHealthProfiles,
  customerHealthConditions,
  customerAllergens,
  customerDietaryPreferences,
  healthConditions,
  taxAllergens,
  taxTags,
  ingestionJobs,
  matchesCache,
  type InsertCustomerHealthProfile,
} from "../shared/schema.js";
import { db } from "./lib/database.js";
import { and, desc, eq, count, sql } from "drizzle-orm";
import { calculateHealthMetrics, deriveDailyLimits } from "./lib/health.js";
import { resolveConditionIds, resolveAllergenIds, resolveDietIds } from "./lib/taxonomy.js";
import { toGoldProductStatus, toGoldCustomerStatus, toGoldActivityLevel } from "./lib/gold-mappers.js";

/** Flatten taxonomy input: accept string[] or { code?, label?, conditionCode? }[] and return unique non-empty strings for resolver */
function flattenTaxonomyInput(arr: (string | { code?: string; label?: string; conditionCode?: string })[]): string[] {
  if (!Array.isArray(arr)) return [];
  const result: string[] = [];
  for (const item of arr) {
    if (typeof item === "string" && item.trim()) result.push(item.trim());
    else if (item && typeof item === "object") {
      const code = (item as any).conditionCode ?? (item as any).code;
      const label = (item as any).label;
      if (code && typeof code === "string") result.push(code.trim());
      if (label && typeof label === "string") result.push(label.trim());
    }
  }
  return [...new Set(result)].filter(Boolean);
}

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

/** Build Postgres text[] literal from string array */
function toTextArray(arr: string[] | undefined): ReturnType<typeof sql> {
  const a = (arr ?? []).filter(Boolean);
  if (a.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(a.map((x) => sql`${x}`), sql`, `)}]::text[]`;
}

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = typeof customers.$inferInsert;

export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type InsertIngestionJob = typeof ingestionJobs.$inferInsert;

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export type CustomerHealthProfile = typeof customerHealthProfiles.$inferSelect;

type CreateCustomerWithHealthArgs = {
  vendorId: string;
  userId: string | null;
  customer: {
    fullName: string;
    email: string;
    phone?: string | null;
    customTags?: string[];
    age?: number | null;
    gender?: string | null;
    status?: string | null;
    locationCity?: string | null;
    locationRegion?: string | null;
    locationPostalCode?: string | null;
    locationCountry?: string | null;
  };
  health?: {
    age?: number;
    gender?: string;
    activityLevel?: string;
    heightCm?: string | null;
    weightKg?: string | null;
    conditions?: string[];
    dietGoals?: string[];
    avoidAllergens?: string[];
    macroTargets?: Record<string, any>;
    bmi?: string | null;
    bmr?: string | null;
    tdeeCached?: string | null;
    derivedLimits?: any;
  } | null;
};

type HealthStatus = "Healthy" | "Degraded" | "Down";

export interface ReplicaStatus {
  id: string;
  status: HealthStatus;
  lag: number;
}

export interface DatabasePartitions {
  products: number;
  customers: number;
  vendors: number;
}

export interface DatabaseHealth {
  status: HealthStatus;
  primaryConnected?: boolean;
  readReplicaConnected?: boolean;
  responseTime?: number;
  recentInserts?: { products: number; customers: number };
  replicaStatus?: ReplicaStatus[];
  partitions?: DatabasePartitions;
}

export interface SystemMetrics {
  products: number;
  customers: number;
  vendors: number;
  pendingJobs?: number;
  activeCustomers?: number;
  profilesWithMatchesPct?: number;
  recentProducts?: number;
  recentCustomers?: number;
  uptime?: number;
  database?: DatabaseHealth;
}

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getVendor(id: string): Promise<Vendor | undefined>;
  getVendors(): Promise<Vendor[]>;
  createVendor(vendor: InsertVendor): Promise<Vendor>;
  updateVendor(id: string, updates: Partial<InsertVendor>): Promise<Vendor | undefined>;

  getProducts(vendorId: string, filters?: any): Promise<Product[]>;
  getProduct(id: string, vendorId: string): Promise<Product | undefined>;
  createProducts(products: InsertProduct[]): Promise<Product[]>;
  updateProduct(id: string, vendorId: string, updates: Partial<InsertProduct>): Promise<Product | undefined>;
  deleteProduct(id: string, vendorId: string): Promise<boolean>;

  getCustomers(vendorId: string, filters?: any): Promise<Customer[]>;
  getCustomersWithHealth(vendorId: string, filters?: any): Promise<(Customer & { healthProfile?: { dietGoals: string[]; avoidAllergens: string[]; conditions: string[] } | null })[]>;
  getCustomer(id: string, vendorId: string): Promise<Customer | undefined>;
  createCustomers(customers: InsertCustomer[]): Promise<Customer[]>;
  updateCustomer(id: string, vendorId: string, updates: Partial<InsertCustomer>): Promise<Customer | undefined>;
  deleteCustomer(id: string, vendorId: string): Promise<boolean>;
  getCustomerWithProfile(id: string, vendorId?: string | null): Promise<(Customer & { healthProfile: CustomerHealthProfile | null }) | null>;

  upsertCustomerHealth(customerId: string, vendorId: string, patch: Partial<InsertCustomerHealthProfile>): Promise<CustomerHealthProfile>;

  getIngestionJob(id: string): Promise<IngestionJob | undefined>;
  getIngestionJobs(vendorId: string, status?: string): Promise<IngestionJob[]>;
  createIngestionJob(job: InsertIngestionJob): Promise<IngestionJob>;
  updateIngestionJob(id: string, updates: Partial<IngestionJob>): Promise<IngestionJob | undefined>;

  getSystemMetrics(vendorId?: string | null): Promise<SystemMetrics>;
  getDatabaseHealth(): Promise<DatabaseHealth>;

  searchProducts(vendorId: string, query: string, filters?: any): Promise<Product[]>;
  searchCustomers(vendorId: string, query: string, filters?: any): Promise<Customer[]>;

  getMatches(customerId: string, vendorId: string, k?: number): Promise<Product[]>;
}

function genExternalId() {
  return "ext_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function toNumericString(v: any): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return String(n);
}

function toGoldGender(gender?: string | null): string | null {
  if (!gender) return null;
  const g = String(gender).toLowerCase();
  if (g === "unspecified") return "prefer_not_to_say";
  if (["male", "female", "other", "prefer_not_to_say"].includes(g)) return g;
  return "prefer_not_to_say";
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0];
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const normalized = email.trim().toLowerCase();
    const result = await db.select().from(users).where(sql`lower(${users.email}) = ${normalized}`).limit(1);
    return result[0];
  }

  async createUser(user: InsertUser): Promise<User> {
    const normalizedUser = { ...user, email: user.email.trim().toLowerCase() };
    const result = await db.insert(users).values(normalizedUser).returning();
    return result[0];
  }

  async getVendor(id: string): Promise<Vendor | undefined> {
    const result = await db.select().from(vendors).where(eq(vendors.id, id)).limit(1);
    return result[0];
  }

  async getVendors(): Promise<Vendor[]> {
    return await db.select().from(vendors).orderBy(desc(vendors.createdAt));
  }

  async createVendor(vendor: InsertVendor): Promise<Vendor> {
    const result = await db.insert(vendors).values(vendor).returning();
    return result[0];
  }

  async updateVendor(id: string, updates: Partial<InsertVendor>): Promise<Vendor | undefined> {
    const result = await db
      .update(vendors)
      .set({ ...updates, updatedAt: sql`now()` })
      .where(eq(vendors.id, id))
      .returning();
    return result[0];
  }

  async getProducts(vendorId: string, filters?: any): Promise<Product[]> {
    const status = filters?.status ? toGoldProductStatus(filters.status) : null;
    const pageSize = Math.min(200, Math.max(1, Number(filters?.pageSize ?? filters?.limit ?? 50) || 50));
    const page = Math.max(1, Number(filters?.page ?? 1) || 1);
    const offset = Number.isFinite(Number(filters?.offset))
      ? Math.max(0, Number(filters.offset))
      : (page - 1) * pageSize;

    const where: any[] = [sql`vendor_id = ${vendorId}`];
    if (status) where.push(sql`status = ${status}`);

    // coreCols: absolute minimum columns that exist in any gold.products setup
    const coreCols = sql`
        id,
        vendor_id AS "vendorId",
        external_id AS "externalId",
        name,
        brand,
        description,
        category_id AS "categoryId",
        barcode,
        gtin_type AS "gtinType",
        price,
        currency,
        serving_size AS "servingSize",
        package_weight AS "packageWeight",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    // gold2Cols: inline nutrition + product_url/image_url (gold 2.x schema, likely present)
    const gold2Cols = sql`
        image_url AS "imageUrl",
        product_url AS "sourceUrl",
        notes,
        calories,
        total_fat_g AS "totalFatG",
        saturated_fat_g AS "saturatedFatG",
        sodium_mg AS "sodiumMg",
        total_carbs_g AS "totalCarbsG",
        total_sugars_g AS "totalSugarsG",
        added_sugars_g AS "addedSugarsG",
        protein_g AS "proteinG",
        dietary_fiber_g AS "dietaryFiberG",
        potassium_mg AS "potassiumMg"
    `;
    // compatCols: jsonb/array compatibility columns added by migrations 018/019
    const compatCols = sql`
        sub_category_id AS "subCategoryId",
        cuisine_id AS "cuisineId",
        market_id AS "marketId",
        nutrition,
        dietary_tags AS "dietaryTags",
        allergens,
        certifications,
        regulatory_codes AS "regulatoryCodes",
        ingredients,
        phosphorus_mg AS "phosphorusMg"
    `;

    let out: { rows?: any[] };
    try {
      out = await db.execute(sql`
        SELECT ${coreCols}, ${gold2Cols}, ${compatCols}
        FROM gold.products
        WHERE ${sql.join(where, sql` AND `)}
        ORDER BY updated_at DESC
        LIMIT ${pageSize}
        OFFSET ${offset}
      `);
    } catch (e: any) {
      if (e?.message?.includes?.("does not exist")) {
        try {
          out = await db.execute(sql`
            SELECT ${coreCols}, ${gold2Cols}
            FROM gold.products
            WHERE ${sql.join(where, sql` AND `)}
            ORDER BY updated_at DESC
            LIMIT ${pageSize}
            OFFSET ${offset}
          `);
        } catch (e2: any) {
          if (e2?.message?.includes?.("does not exist")) {
            out = await db.execute(sql`
              SELECT ${coreCols}
              FROM gold.products
              WHERE ${sql.join(where, sql` AND `)}
              ORDER BY updated_at DESC
              LIMIT ${pageSize}
              OFFSET ${offset}
            `);
          } else throw e2;
        }
      } else throw e;
    }

    return (out.rows || []) as Product[];
  }

  async getProduct(id: string, vendorId: string): Promise<Product | undefined> {
    const coreCols = sql`
        id,
        vendor_id AS "vendorId",
        external_id AS "externalId",
        name,
        brand,
        description,
        category_id AS "categoryId",
        barcode,
        gtin_type AS "gtinType",
        price,
        currency,
        serving_size AS "servingSize",
        package_weight AS "packageWeight",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const gold2Cols = sql`
        image_url AS "imageUrl",
        product_url AS "sourceUrl",
        notes,
        calories,
        total_fat_g AS "totalFatG",
        saturated_fat_g AS "saturatedFatG",
        sodium_mg AS "sodiumMg",
        total_carbs_g AS "totalCarbsG",
        total_sugars_g AS "totalSugarsG",
        added_sugars_g AS "addedSugarsG",
        protein_g AS "proteinG",
        dietary_fiber_g AS "dietaryFiberG",
        potassium_mg AS "potassiumMg"
    `;
    const compatCols = sql`
        sub_category_id AS "subCategoryId",
        cuisine_id AS "cuisineId",
        market_id AS "marketId",
        nutrition,
        dietary_tags AS "dietaryTags",
        allergens,
        certifications,
        regulatory_codes AS "regulatoryCodes",
        ingredients,
        phosphorus_mg AS "phosphorusMg"
    `;

    let out: { rows?: any[] };
    try {
      out = await db.execute(sql`
        SELECT ${coreCols}, ${gold2Cols}, ${compatCols}
        FROM gold.products
        WHERE id = ${id} AND vendor_id = ${vendorId}
        LIMIT 1
      `);
    } catch (e: any) {
      if (e?.message?.includes?.("does not exist")) {
        try {
          out = await db.execute(sql`
            SELECT ${coreCols}, ${gold2Cols}
            FROM gold.products
            WHERE id = ${id} AND vendor_id = ${vendorId}
            LIMIT 1
          `);
        } catch (e2: any) {
          if (e2?.message?.includes?.("does not exist")) {
            out = await db.execute(sql`
              SELECT ${coreCols}
              FROM gold.products
              WHERE id = ${id} AND vendor_id = ${vendorId}
              LIMIT 1
            `);
          } else throw e2;
        }
      } else throw e;
    }
    return (out.rows?.[0] as Product | undefined) ?? undefined;
  }

  async createProducts(productList: InsertProduct[]): Promise<Product[]> {
    if (productList.length === 0) return [];
    const created: Product[] = [];

    for (const p of productList) {
      const nutritionJson = p.nutrition && typeof p.nutrition === "object"
        ? JSON.stringify(p.nutrition)
        : null;
      const out = await db.execute(sql`
        INSERT INTO gold.products (
          vendor_id,
          external_id,
          name,
          brand,
          description,
          category_id,
          sub_category_id,
          cuisine_id,
          market_id,
          barcode,
          gtin_type,
          price,
          currency,
          serving_size,
          package_weight,
          product_url,
          notes,
          status,
          nutrition,
          dietary_tags,
          allergens,
          certifications,
          regulatory_codes,
          ingredients
        )
        VALUES (
          ${p.vendorId},
          ${p.externalId},
          ${p.name},
          ${p.brand ?? null},
          ${p.description ?? null},
          ${p.categoryId ?? null},
          ${p.subCategoryId ?? null},
          ${p.cuisineId ?? null},
          ${p.marketId ?? null},
          ${p.barcode ?? null},
          ${p.gtinType ?? null},
          ${p.price ?? null},
          ${p.currency ?? "USD"},
          ${p.servingSize ?? null},
          ${p.packageWeight ?? null},
          ${p.sourceUrl ?? null},
          ${p.notes ?? null},
          ${toGoldProductStatus(p.status as any)},
          ${nutritionJson}::jsonb,
          ${toTextArray(p.dietaryTags ?? [])},
          ${toTextArray(p.allergens ?? [])},
          ${toTextArray(p.certifications ?? [])},
          ${toTextArray(p.regulatoryCodes ?? [])},
          ${toTextArray(p.ingredients ?? [])}
        )
        RETURNING
          id,
          vendor_id AS "vendorId",
          external_id AS "externalId",
          name,
          brand,
          description,
          category_id AS "categoryId",
          sub_category_id AS "subCategoryId",
          cuisine_id AS "cuisineId",
          market_id AS "marketId",
          barcode,
          gtin_type AS "gtinType",
          price,
          currency,
          serving_size AS "servingSize",
          package_weight AS "packageWeight",
          product_url AS "sourceUrl",
          notes,
          status,
          nutrition,
          dietary_tags AS "dietaryTags",
          allergens,
          certifications,
          regulatory_codes AS "regulatoryCodes",
          ingredients,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `);
      if (out.rows?.[0]) created.push(out.rows[0] as Product);
    }

    return created;
  }

  async updateProduct(id: string, vendorId: string, updates: Partial<InsertProduct>): Promise<Product | undefined> {
    const setParts: any[] = [];
    if (updates.externalId !== undefined) setParts.push(sql`external_id = ${updates.externalId}`);
    if (updates.name !== undefined) setParts.push(sql`name = ${updates.name}`);
    if (updates.brand !== undefined) setParts.push(sql`brand = ${updates.brand}`);
    if (updates.description !== undefined) setParts.push(sql`description = ${updates.description}`);
    if (updates.categoryId !== undefined) setParts.push(sql`category_id = ${updates.categoryId}`);
    if (updates.subCategoryId !== undefined) setParts.push(sql`sub_category_id = ${updates.subCategoryId}`);
    if (updates.cuisineId !== undefined) setParts.push(sql`cuisine_id = ${updates.cuisineId}`);
    if (updates.marketId !== undefined) setParts.push(sql`market_id = ${updates.marketId}`);
    if (updates.barcode !== undefined) setParts.push(sql`barcode = ${updates.barcode}`);
    if (updates.gtinType !== undefined) setParts.push(sql`gtin_type = ${updates.gtinType}`);
    if (updates.price !== undefined) setParts.push(sql`price = ${updates.price}`);
    if (updates.currency !== undefined) setParts.push(sql`currency = ${updates.currency}`);
    if (updates.servingSize !== undefined) setParts.push(sql`serving_size = ${updates.servingSize}`);
    if (updates.packageWeight !== undefined) setParts.push(sql`package_weight = ${updates.packageWeight}`);
    if (updates.sourceUrl !== undefined) setParts.push(sql`product_url = ${updates.sourceUrl}`);
    if (updates.notes !== undefined) setParts.push(sql`notes = ${updates.notes}`);
    if (updates.status !== undefined) setParts.push(sql`status = ${toGoldProductStatus(updates.status as any)}`);
    if (updates.nutrition !== undefined) {
      const nutritionJson = updates.nutrition && typeof updates.nutrition === "object"
        ? JSON.stringify(updates.nutrition)
        : null;
      setParts.push(sql`nutrition = ${nutritionJson}::jsonb`);
    }
    if (updates.dietaryTags !== undefined) setParts.push(sql`dietary_tags = ${toTextArray(updates.dietaryTags)}`);
    if (updates.allergens !== undefined) setParts.push(sql`allergens = ${toTextArray(updates.allergens)}`);
    if (updates.certifications !== undefined) setParts.push(sql`certifications = ${toTextArray(updates.certifications)}`);
    if (updates.regulatoryCodes !== undefined) setParts.push(sql`regulatory_codes = ${toTextArray(updates.regulatoryCodes)}`);
    if (updates.ingredients !== undefined) setParts.push(sql`ingredients = ${toTextArray(updates.ingredients)}`);
    setParts.push(sql`updated_at = now()`);

    const out = await db.execute(sql`
      UPDATE gold.products
      SET ${sql.join(setParts, sql`, `)}
      WHERE id = ${id} AND vendor_id = ${vendorId}
      RETURNING
        id,
        vendor_id AS "vendorId",
        external_id AS "externalId",
        name,
        brand,
        description,
        category_id AS "categoryId",
        sub_category_id AS "subCategoryId",
        cuisine_id AS "cuisineId",
        market_id AS "marketId",
        barcode,
        gtin_type AS "gtinType",
        price,
        currency,
        serving_size AS "servingSize",
        package_weight AS "packageWeight",
        product_url AS "sourceUrl",
        notes,
        status,
        nutrition,
        dietary_tags AS "dietaryTags",
        allergens,
        certifications,
        regulatory_codes AS "regulatoryCodes",
        ingredients,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `);
    return (out.rows?.[0] as Product | undefined) ?? undefined;
  }

  async deleteProduct(id: string, vendorId: string): Promise<boolean> {
    const result = await db
      .delete(products)
      .where(and(eq(products.id, id), eq(products.vendorId, vendorId)))
      .returning({ id: products.id });
    return result.length > 0;
  }

  async getCustomers(vendorId: string, filters?: any): Promise<Customer[]> {
    const status = filters?.status ? toGoldCustomerStatus(filters.status) : null;
    const pageSize = Math.min(200, Math.max(1, Number(filters?.pageSize ?? filters?.limit ?? 50) || 50));
    const page = Math.max(1, Number(filters?.page ?? 1) || 1);
    const offset = Number.isFinite(Number(filters?.offset))
      ? Math.max(0, Number(filters.offset))
      : (page - 1) * pageSize;

    const where: any[] = [sql`vendor_id = ${vendorId}`];
    if (status) where.push(sql`account_status = ${status}`);

    const out = await db.execute(sql`
      SELECT
        id,
        vendor_id AS "vendorId",
        external_id AS "externalId",
        global_customer_id AS "globalCustomerId",
        email,
        full_name AS "fullName",
        first_name AS "firstName",
        last_name AS "lastName",
        date_of_birth AS "dob",
        age,
        gender,
        phone,
        location_country AS "locationCountry",
        location_region AS "locationRegion",
        location_city AS "locationCity",
        location_postal_code AS "locationPostalCode",
        account_status AS "accountStatus",
        source_system AS "sourceSystem",
        notes,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        COALESCE(custom_tags, ARRAY[]::text[]) AS "customTags",
        COALESCE(product_notes, '{}'::jsonb) AS "productNotes"
      FROM gold.b2b_customers
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY updated_at DESC
      LIMIT ${pageSize}
      OFFSET ${offset}
    `);

    return (out.rows || []) as Customer[];
  }

  /** Like getCustomers but includes healthProfile with dietGoals, avoidAllergens, conditions from junction tables */
  async getCustomersWithHealth(vendorId: string, filters?: any): Promise<(Customer & { healthProfile?: { dietGoals: string[]; avoidAllergens: string[]; conditions: string[] } | null })[]> {
    const status = filters?.status ? toGoldCustomerStatus(filters.status) : null;
    const pageSize = Math.min(200, Math.max(1, Number(filters?.pageSize ?? filters?.limit ?? 50) || 50));
    const page = Math.max(1, Number(filters?.page ?? 1) || 1);
    const offset = Number.isFinite(Number(filters?.offset))
      ? Math.max(0, Number(filters.offset))
      : (page - 1) * pageSize;

    const where = status ? sql`c.vendor_id = ${vendorId} AND c.account_status = ${status}` : sql`c.vendor_id = ${vendorId}`;

    const out = await db.execute(sql`
      SELECT
        c.id,
        c.vendor_id AS "vendorId",
        c.external_id AS "externalId",
        c.global_customer_id AS "globalCustomerId",
        c.email,
        c.full_name AS "fullName",
        c.first_name AS "firstName",
        c.last_name AS "lastName",
        c.date_of_birth AS "dob",
        c.age,
        c.gender,
        c.phone,
        c.location_country AS "locationCountry",
        c.location_region AS "locationRegion",
        c.location_city AS "locationCity",
        c.location_postal_code AS "locationPostalCode",
        c.account_status AS "accountStatus",
        c.source_system AS "sourceSystem",
        c.notes,
        c.created_at AS "createdAt",
        c.updated_at AS "updatedAt",
        COALESCE(c.custom_tags, ARRAY[]::text[]) AS "customTags",
        COALESCE(c.product_notes, '{}'::jsonb) AS "productNotes",
        (SELECT COALESCE(array_agg(hc.name ORDER BY hc.name), ARRAY[]::text[])
         FROM gold.b2b_customer_health_conditions chc
         JOIN gold.health_conditions hc ON chc.condition_id = hc.id
         WHERE chc.b2b_customer_id = c.id) AS "conditions",
        (SELECT COALESCE(array_agg(a.name ORDER BY a.name), ARRAY[]::text[])
         FROM gold.b2b_customer_allergens ca
         JOIN gold.allergens a ON ca.allergen_id = a.id
         WHERE ca.b2b_customer_id = c.id) AS "avoidAllergens",
        (SELECT COALESCE(array_agg(dp.name ORDER BY dp.name), ARRAY[]::text[])
         FROM gold.b2b_customer_dietary_preferences cdp
         JOIN gold.dietary_preferences dp ON cdp.diet_id = dp.id
         WHERE cdp.b2b_customer_id = c.id) AS "dietGoals"
      FROM gold.b2b_customers c
      WHERE ${where}
      ORDER BY c.updated_at DESC
      LIMIT ${pageSize}
      OFFSET ${offset}
    `);

    const rows = (out.rows || []) as any[];
    return rows.map((r) => {
      const { conditions, avoidAllergens, dietGoals, ...customer } = r;
      return {
        ...customer,
        healthProfile:
          (conditions?.length || avoidAllergens?.length || dietGoals?.length)
            ? { conditions: conditions ?? [], avoidAllergens: avoidAllergens ?? [], dietGoals: dietGoals ?? [] }
            : null,
      };
    });
  }

  async getCustomer(id: string, vendorId: string): Promise<Customer | undefined> {
    const out = await db.execute(sql`
      SELECT
        id,
        vendor_id AS "vendorId",
        external_id AS "externalId",
        global_customer_id AS "globalCustomerId",
        email,
        full_name AS "fullName",
        first_name AS "firstName",
        last_name AS "lastName",
        date_of_birth AS "dob",
        age,
        gender,
        phone,
        location_country AS "locationCountry",
        location_region AS "locationRegion",
        location_city AS "locationCity",
        location_postal_code AS "locationPostalCode",
        account_status AS "accountStatus",
        source_system AS "sourceSystem",
        notes,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        COALESCE(custom_tags, ARRAY[]::text[]) AS "customTags",
        COALESCE(product_notes, '{}'::jsonb) AS "productNotes"
      FROM gold.b2b_customers
      WHERE id = ${id} AND vendor_id = ${vendorId}
      LIMIT 1
    `);
    return (out.rows?.[0] as Customer | undefined) ?? undefined;
  }

  async getCustomerWithProfile(id: string, vendorId?: string | null) {
    const where = vendorId
      ? and(eq(customers.id, id), eq(customers.vendorId, vendorId))
      : eq(customers.id, id);

    const rows = await db
      .select({
        customer: customers,
        health: customerHealthProfiles,
      })
      .from(customers)
      .leftJoin(customerHealthProfiles, eq(customerHealthProfiles.customerId, customers.id))
      .where(where)
      .limit(1);

    if (!rows.length) return null;

    const [conditionRows, allergenRows, dietRows] = await Promise.all([
      db.select({ code: healthConditions.code, label: healthConditions.label })
        .from(customerHealthConditions)
        .innerJoin(healthConditions, eq(healthConditions.id, customerHealthConditions.conditionId))
        .where(eq(customerHealthConditions.customerId, id)),
      db.select({ code: taxAllergens.code, label: taxAllergens.label })
        .from(customerAllergens)
        .innerJoin(taxAllergens, eq(taxAllergens.id, customerAllergens.allergenId))
        .where(eq(customerAllergens.customerId, id)),
      db.select({ code: taxTags.code, label: taxTags.label })
        .from(customerDietaryPreferences)
        .innerJoin(taxTags, eq(taxTags.id, customerDietaryPreferences.dietId))
        .where(eq(customerDietaryPreferences.customerId, id)),
    ]);
    const conditionCodes = conditionRows.map((x) => x.code);
    const conditionLabels = conditionRows.map((x) => x.label ?? x.code);
    const allergenLabels = allergenRows.map((x) => x.label ?? x.code);
    const dietLabels = dietRows.map((x) => x.label ?? x.code);

    const hp = rows[0].health;
    const cust = rows[0].customer;
    const hasJunctionData = conditionLabels.length > 0 || allergenLabels.length > 0 || dietLabels.length > 0;

    const health = hp
      ? (() => {
          const tdee = hp.tdee ?? null;
          const derivedLimits = deriveDailyLimits(
            { ...hp, tdee, conditions: conditionCodes },
            []
          );
          return {
            ...hp,
            age: cust.age ?? hp.age ?? undefined,
            gender: cust.gender ?? hp.gender ?? undefined,
            conditions: conditionLabels,
            avoidAllergens: allergenLabels,
            dietGoals: dietLabels,
            derivedLimits,
            macroTargets: {
              protein_g: hp.targetProteinG ?? undefined,
              carbs_g: hp.targetCarbsG ?? undefined,
              fat_g: hp.targetFatG ?? undefined,
              calories: hp.targetCalories ?? undefined,
            },
          };
        })()
      : hasJunctionData
        ? {
            age: cust.age ?? undefined,
            gender: cust.gender ?? undefined,
            conditions: conditionLabels,
            avoidAllergens: allergenLabels,
            dietGoals: dietLabels,
          }
        : null;

    return {
      ...rows[0].customer,
      healthProfile: health,
    };
  }

  async createCustomers(customerList: InsertCustomer[]): Promise<Customer[]> {
    if (customerList.length === 0) return [];
    return await db.insert(customers).values(customerList).returning();
  }

  async updateCustomer(id: string, vendorId: string, updates: Partial<InsertCustomer>): Promise<Customer | undefined> {
    const result = await db
      .update(customers)
      .set({ ...updates, updatedAt: sql`now()` })
      .where(and(eq(customers.id, id), eq(customers.vendorId, vendorId)))
      .returning();
    return result[0];
  }

  async upsertCustomerHealth(
    customerId: string,
    vendorId: string,
    patch: Partial<InsertCustomerHealthProfile>
  ): Promise<CustomerHealthProfile> {
    const p = patch as any;
    const [cust] = await db
      .select({ id: customers.id, age: customers.age, gender: customers.gender })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.vendorId, vendorId)))
      .limit(1);

    if (!cust) throw new Error("Customer not found");

    const activityLevel = toGoldActivityLevel(p.activityLevel as string | null);
    const age = p.age ?? cust.age ?? null;
    const gender = toGoldGender(p.gender ?? cust.gender ?? null);
    const heightCm = toNumericString(p.heightCm);
    const weightKg = toNumericString(p.weightKg);
    const macroTargets = (p.macroTargets ?? {}) as Record<string, number>;
    const conditions = Array.isArray(p.conditions) ? flattenTaxonomyInput(p.conditions) : [];
    const dietGoals = Array.isArray(p.dietGoals) ? flattenTaxonomyInput(p.dietGoals) : [];
    const avoidAllergens = Array.isArray(p.avoidAllergens) ? flattenTaxonomyInput(p.avoidAllergens) : [];

    const [existingProfile] = await db.select()
      .from(customerHealthProfiles)
      .where(eq(customerHealthProfiles.customerId, customerId))
      .limit(1);

    const effectiveHeight = heightCm ?? existingProfile?.heightCm ?? null;
    const effectiveWeight = weightKg ?? existingProfile?.weightKg ?? null;
    const effectiveAge = age ?? cust.age ?? null;

    let bmi: string | null = toNumericString(p.bmi);
    let bmr: string | null = toNumericString(p.bmr);
    let tdee: string | null = toNumericString(p.tdeeCached ?? p.tdee);

    if (
      effectiveHeight != null &&
      effectiveWeight != null &&
      effectiveAge != null
    ) {
      const metrics = calculateHealthMetrics({
        heightCm: String(effectiveHeight),
        weightKg: String(effectiveWeight),
        age: Number(effectiveAge),
        gender: gender ?? "prefer_not_to_say",
        activityLevel: activityLevel ?? "sedentary",
        conditions,
        dietGoals,
        avoidAllergens,
        macroTargets,
      } as any);
      bmi = String(metrics.bmi);
      bmr = String(metrics.bmr);
      tdee = String(metrics.tdee);
    }

    const profilePayload: Partial<InsertCustomerHealthProfile> = {
      heightCm: heightCm ?? existingProfile?.heightCm ?? "0",
      weightKg: weightKg ?? existingProfile?.weightKg ?? "0",
      activityLevel: activityLevel ?? existingProfile?.activityLevel ?? "sedentary",
      bmi,
      bmr,
      tdee,
      healthGoal: p.healthGoal ?? existingProfile?.healthGoal ?? null,
      targetWeightKg: toNumericString(p.targetWeightKg ?? existingProfile?.targetWeightKg) ?? null,
      targetCalories: macroTargets.calories ?? p.targetCalories ?? existingProfile?.targetCalories ?? null,
      targetProteinG: toNumericString(macroTargets.protein_g ?? macroTargets.proteinG ?? p.targetProteinG ?? existingProfile?.targetProteinG) ?? null,
      targetCarbsG: toNumericString(macroTargets.carbs_g ?? macroTargets.carbsG ?? p.targetCarbsG ?? existingProfile?.targetCarbsG) ?? null,
      targetFatG: toNumericString(macroTargets.fat_g ?? macroTargets.fatG ?? p.targetFatG ?? existingProfile?.targetFatG) ?? null,
      targetFiberG: toNumericString(p.targetFiberG ?? existingProfile?.targetFiberG) ?? null,
      targetSodiumMg: p.targetSodiumMg ?? existingProfile?.targetSodiumMg ?? null,
      targetSugarG: toNumericString(p.targetSugarG ?? existingProfile?.targetSugarG) ?? null,
    };

    const result = await db.transaction(async (tx) => {
      if (age != null || gender != null) {
        await tx.update(customers)
          .set({
            ...(age != null && { age: Number(age) }),
            ...(gender != null && { gender }),
            updatedAt: sql`now()`,
          })
          .where(and(eq(customers.id, customerId), eq(customers.vendorId, vendorId)));
      }

      const [conditionIds, allergenIds, dietIds] = await Promise.all([
        resolveConditionIds(conditions),
        resolveAllergenIds(avoidAllergens),
        resolveDietIds(dietGoals),
      ]);

      // [DEBUG] Log resolver outputs - empty when input non-empty indicates resolution failure
      if (conditions.length || avoidAllergens.length || dietGoals.length) {
        const resolutionFailed =
          (conditions.length > 0 && conditionIds.length === 0) ||
          (avoidAllergens.length > 0 && allergenIds.length === 0) ||
          (dietGoals.length > 0 && dietIds.length === 0);
        if (resolutionFailed) {
          console.warn("[upsertCustomerHealth] taxonomy resolution returned empty for some inputs:", {
            conditions,
            conditionIds,
            avoidAllergens,
            allergenIds,
            dietGoals,
            dietIds,
          });
        }
      }

      await tx.delete(customerHealthConditions).where(eq(customerHealthConditions.customerId, customerId));
      await tx.delete(customerAllergens).where(eq(customerAllergens.customerId, customerId));
      await tx.delete(customerDietaryPreferences).where(eq(customerDietaryPreferences.customerId, customerId));

      if (conditionIds.length > 0) {
        await tx.insert(customerHealthConditions).values(
          conditionIds.map((conditionId) => ({ customerId, conditionId }))
        );
      }
      if (allergenIds.length > 0) {
        await tx.insert(customerAllergens).values(
          allergenIds.map((allergenId) => ({ customerId, allergenId }))
        );
      }
      if (dietIds.length > 0) {
        await tx.insert(customerDietaryPreferences).values(
          dietIds.map((dietId) => ({ customerId, dietId }))
        );
      }

      const [updated] = await tx
        .update(customerHealthProfiles)
        .set({ ...profilePayload, updatedAt: sql`now()` })
        .where(eq(customerHealthProfiles.customerId, customerId))
        .returning();

      if (updated) return updated;

      const [inserted] = await tx
        .insert(customerHealthProfiles)
        .values({
          customerId,
          ...profilePayload,
          heightCm: profilePayload.heightCm ?? "0",
          weightKg: profilePayload.weightKg ?? "0",
          activityLevel: profilePayload.activityLevel ?? "sedentary",
        })
        .returning();

      return inserted;
    });

    return result;
  }

  async createCustomerWithHealth(args: CreateCustomerWithHealthArgs) {
    const { vendorId, userId, customer, health } = args;

    const baseCustomer = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.vendorId, vendorId), sql`lower(${customers.email}) = ${customer.email.trim().toLowerCase()}`))
        .limit(1);

      let row: Customer;
      const locationUpdates: Record<string, any> = {};
      if (customer.locationCity != null) locationUpdates.locationCity = customer.locationCity;
      if (customer.locationRegion != null) locationUpdates.locationRegion = customer.locationRegion;
      if (customer.locationPostalCode != null) locationUpdates.locationPostalCode = customer.locationPostalCode;
      if (customer.locationCountry != null) locationUpdates.locationCountry = customer.locationCountry;

      if (existing[0]?.id) {
        const [updated] = await tx
          .update(customers)
          .set({
            fullName: customer.fullName,
            phone: customer.phone ?? null,
            customTags: customer.customTags ?? [],
            age: customer.age ?? null,
            gender: toGoldGender(customer.gender) ?? null,
            accountStatus: toGoldCustomerStatus(customer.status),
            ...locationUpdates,
            updatedAt: sql`now()`,
          })
          .where(and(eq(customers.id, existing[0].id), eq(customers.vendorId, vendorId)))
          .returning();

        row = updated;
      } else {
        const [created] = await tx
          .insert(customers)
          .values({
            vendorId,
            externalId: genExternalId(),
            fullName: customer.fullName,
            email: customer.email,
            phone: customer.phone ?? null,
            customTags: customer.customTags ?? [],
            age: customer.age ?? null,
            gender: toGoldGender(customer.gender) ?? null,
            accountStatus: toGoldCustomerStatus(customer.status),
            ...(customer.locationCity != null && { locationCity: customer.locationCity }),
            ...(customer.locationRegion != null && { locationRegion: customer.locationRegion }),
            ...(customer.locationPostalCode != null && { locationPostalCode: customer.locationPostalCode }),
            ...(customer.locationCountry != null && { locationCountry: customer.locationCountry }),
          })
          .returning();

        row = created;
      }

      return row;
    });

    let healthRow: CustomerHealthProfile | null = null;
    if (health) {
      healthRow = await this.upsertCustomerHealth(baseCustomer.id, vendorId, {
        age: health.age,
        gender: health.gender,
        activityLevel: health.activityLevel,
        heightCm: health.heightCm,
        weightKg: health.weightKg,
        conditions: health.conditions ?? [],
        dietGoals: health.dietGoals ?? [],
        avoidAllergens: health.avoidAllergens ?? [],
        macroTargets: health.macroTargets ?? {},
        bmi: health.bmi,
        bmr: health.bmr,
        tdeeCached: health.tdeeCached,
      });
    }

    return { customer: baseCustomer, health: healthRow };
  }

  async upsertCustomerProductNote(
    vendorId: string,
    customerId: string,
    productId: string,
    note: string | null,
    userId: string | null
  ) {
    const [row] = await db
      .select({ productNotes: customers.productNotes })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.vendorId, vendorId)))
      .limit(1);

    if (!row) throw new Error("Customer not found");

    const map: Record<string, any> = (row.productNotes as any) || {};
    if (note == null || note === "") {
      delete map[productId];
    } else {
      map[productId] = String(note);
    }

    const [updated] = await db
      .update(customers)
      .set({ productNotes: map as any, updatedAt: sql`now()` })
      .where(and(eq(customers.id, customerId), eq(customers.vendorId, vendorId)))
      .returning({ productNotes: customers.productNotes });

    return {
      customerId,
      productId,
      note: (updated?.productNotes as any)?.[productId] ?? null,
    };
  }

  async getCustomerProductNote(customerId: string, productId: string, vendorId: string) {
    const [row] = await db
      .select({ productNotes: customers.productNotes })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.vendorId, vendorId)))
      .limit(1);

    const map: Record<string, any> = (row?.productNotes as any) || {};
    return { customerId, productId, note: map[productId] ?? null };
  }

  async deleteCustomer(id: string, vendorId: string): Promise<boolean> {
    let deleted = false;
    await db.transaction(async (tx) => {
      await tx.delete(customerHealthProfiles).where(eq(customerHealthProfiles.customerId, id));
      await tx.delete(matchesCache).where(and(eq(matchesCache.vendorId, vendorId), eq(matchesCache.customerId, id)));

      const result = await tx
        .delete(customers)
        .where(and(eq(customers.id, id), eq(customers.vendorId, vendorId)))
        .returning({ id: customers.id });

      deleted = result.length > 0;
    });

    return deleted;
  }

  async getIngestionJob(id: string): Promise<IngestionJob | undefined> {
    const result = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, id)).limit(1);
    return result[0];
  }

  async getIngestionJobs(vendorId: string, status?: string): Promise<IngestionJob[]> {
    let q: any = db.select().from(ingestionJobs).where(eq(ingestionJobs.vendorId, vendorId));
    if (status) q = q.where(eq(ingestionJobs.status, status));
    return (await q.orderBy(desc(ingestionJobs.createdAt))) as IngestionJob[];
  }

  async createIngestionJob(job: InsertIngestionJob): Promise<IngestionJob> {
    const result = await db.insert(ingestionJobs).values(job).returning();
    return result[0];
  }

  async updateIngestionJob(id: string, updates: Partial<IngestionJob>): Promise<IngestionJob | undefined> {
    const result = await db.update(ingestionJobs).set(updates).where(eq(ingestionJobs.id, id)).returning();
    return result[0];
  }

  async getSystemMetrics(vendorId?: string | null): Promise<SystemMetrics> {
    if (!vendorId) {
      return {
        vendors: 0,
        products: 0,
        customers: 0,
        pendingJobs: 0,
        activeCustomers: 0,
        profilesWithMatchesPct: 0,
        database: await this.getDatabaseHealth(),
      };
    }

    const safeCount = async (query: any, missingTableDefault = 0): Promise<number> => {
      try {
        const r = await db.execute(query);
        return Number(r.rows?.[0]?.c ?? 0);
      } catch (e: any) {
        if (e?.code === "42P01") return missingTableDefault;
        throw e;
      }
    };

    const productsCount = await safeCount(
      sql`SELECT count(*)::int AS c FROM gold.products WHERE vendor_id = ${vendorId}`
    );
    const activeCustomers = await safeCount(
      sql`SELECT count(*)::int AS c FROM gold.b2b_customers WHERE vendor_id = ${vendorId} AND account_status = 'active'`
    );
    const totalCustomers = await safeCount(
      sql`SELECT count(*)::int AS c FROM gold.b2b_customers WHERE vendor_id = ${vendorId}`
    );
    const pendingJobs = await safeCount(
      sql`SELECT count(*)::int AS c FROM public.ingestion_jobs WHERE vendor_id = ${vendorId} AND status IN ('queued','pending','processing','running')`
    );
    const vendorCount = await safeCount(
      sql`SELECT count(*)::int AS c FROM gold.vendors WHERE id = ${vendorId}`
    );
    const matchedCustomers = await safeCount(
      sql`SELECT count(DISTINCT customer_id)::int AS c FROM public.matches_cache WHERE vendor_id = ${vendorId}`
    );
    const profilesWithMatchesPct = totalCustomers > 0 ? (matchedCustomers * 100) / totalCustomers : 0;

    return {
      vendors: vendorCount,
      products: productsCount,
      customers: totalCustomers,
      pendingJobs,
      activeCustomers,
      profilesWithMatchesPct,
      database: await this.getDatabaseHealth(),
    };
  }

  async getDatabaseHealth(): Promise<DatabaseHealth> {
    return {
      status: "Healthy",
      responseTime: 25,
      recentInserts: { products: 0, customers: 0 },
      replicaStatus: [{ id: "primary", status: "Healthy", lag: 0 }],
      partitions: { products: 0, customers: 0, vendors: 0 },
    };
  }

  async searchProducts(vendorId: string, query: string, filters?: any): Promise<Product[]> {
    const q = String(query || filters?.q || "").trim();
    const like = `%${q}%`;
    const status = filters?.status ? toGoldProductStatus(filters.status) : null;
    const pageSize = Math.min(200, Math.max(1, Number(filters?.pageSize ?? filters?.limit ?? 50) || 50));
    const page = Math.max(1, Number(filters?.page ?? 1) || 1);
    const offset = Number.isFinite(Number(filters?.offset))
      ? Math.max(0, Number(filters.offset))
      : (page - 1) * pageSize;

    const where: any[] = [sql`vendor_id = ${vendorId}`];
    if (q) {
      where.push(sql`(
        name ILIKE ${like}
        OR COALESCE(brand, '') ILIKE ${like}
        OR COALESCE(description, '') ILIKE ${like}
        OR COALESCE(external_id, '') ILIKE ${like}
      )`);
    }
    if (filters?.brand) where.push(sql`brand ILIKE ${`%${filters.brand}%`}`);
    if (filters?.categoryId) where.push(sql`category_id = ${filters.categoryId}`);
    if (status) where.push(sql`status = ${status}`);

    // searchCoreCols: absolute minimum columns
    const searchCoreCols = sql`
        id,
        vendor_id AS "vendorId",
        external_id AS "externalId",
        name,
        brand,
        description,
        category_id AS "categoryId",
        barcode,
        gtin_type AS "gtinType",
        price,
        currency,
        serving_size AS "servingSize",
        package_weight AS "packageWeight",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    // searchGold2Cols: inline nutrition + image_url/product_url (gold 2.x schema, likely present)
    const searchGold2Cols = sql`
        image_url AS "imageUrl",
        product_url AS "sourceUrl",
        notes,
        calories,
        total_fat_g AS "totalFatG",
        saturated_fat_g AS "saturatedFatG",
        sodium_mg AS "sodiumMg",
        total_carbs_g AS "totalCarbsG",
        total_sugars_g AS "totalSugarsG",
        added_sugars_g AS "addedSugarsG",
        protein_g AS "proteinG",
        dietary_fiber_g AS "dietaryFiberG",
        potassium_mg AS "potassiumMg"
    `;
    // searchCompatCols: compatibility columns from migrations 018/019
    const searchCompatCols = sql`
        sub_category_id AS "subCategoryId",
        cuisine_id AS "cuisineId",
        market_id AS "marketId",
        nutrition,
        dietary_tags AS "dietaryTags",
        allergens,
        certifications,
        regulatory_codes AS "regulatoryCodes",
        ingredients,
        phosphorus_mg AS "phosphorusMg"
    `;

    let out: { rows?: any[] };
    try {
      out = await db.execute(sql`
        SELECT ${searchCoreCols}, ${searchGold2Cols}, ${searchCompatCols}
        FROM gold.products
        WHERE ${sql.join(where, sql` AND `)}
        ORDER BY updated_at DESC
        LIMIT ${pageSize}
        OFFSET ${offset}
      `);
    } catch (e: any) {
      if (e?.message?.includes?.("does not exist")) {
        try {
          out = await db.execute(sql`
            SELECT ${searchCoreCols}, ${searchGold2Cols}
            FROM gold.products
            WHERE ${sql.join(where, sql` AND `)}
            ORDER BY updated_at DESC
            LIMIT ${pageSize}
            OFFSET ${offset}
          `);
        } catch (e2: any) {
          if (e2?.message?.includes?.("does not exist")) {
            out = await db.execute(sql`
              SELECT ${searchCoreCols}
              FROM gold.products
              WHERE ${sql.join(where, sql` AND `)}
              ORDER BY updated_at DESC
              LIMIT ${pageSize}
              OFFSET ${offset}
            `);
          } else throw e2;
        }
      } else throw e;
    }
    return (out.rows || []) as Product[];
  }

  async searchCustomers(vendorId: string, query: string, filters?: any): Promise<Customer[]> {
    const q = String(query || filters?.q || "").trim();
    const like = `%${q}%`;
    const status = filters?.status ? toGoldCustomerStatus(filters.status) : null;
    const pageSize = Math.min(200, Math.max(1, Number(filters?.pageSize ?? filters?.limit ?? 50) || 50));
    const page = Math.max(1, Number(filters?.page ?? 1) || 1);
    const offset = Number.isFinite(Number(filters?.offset))
      ? Math.max(0, Number(filters.offset))
      : (page - 1) * pageSize;

    const where: any[] = [sql`vendor_id = ${vendorId}`];
    if (q) {
      where.push(sql`(
        full_name ILIKE ${like}
        OR email ILIKE ${like}
        OR COALESCE(phone, '') ILIKE ${like}
      )`);
    }
    if (status) where.push(sql`account_status = ${status}`);

    const out = await db.execute(sql`
      SELECT
        id,
        vendor_id AS "vendorId",
        external_id AS "externalId",
        global_customer_id AS "globalCustomerId",
        email,
        full_name AS "fullName",
        first_name AS "firstName",
        last_name AS "lastName",
        date_of_birth AS "dob",
        age,
        gender,
        phone,
        location_country AS "locationCountry",
        location_region AS "locationRegion",
        location_city AS "locationCity",
        location_postal_code AS "locationPostalCode",
        account_status AS "accountStatus",
        source_system AS "sourceSystem",
        notes,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        COALESCE(custom_tags, ARRAY[]::text[]) AS "customTags",
        COALESCE(product_notes, '{}'::jsonb) AS "productNotes"
      FROM gold.b2b_customers
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY updated_at DESC
      LIMIT ${pageSize}
      OFFSET ${offset}
    `);
    return (out.rows || []) as Customer[];
  }

  async getMatches(_customerId: string, vendorId: string, k = 20): Promise<Product[]> {
    const out = await db.execute(sql`
      SELECT
        id,
        vendor_id AS "vendorId",
        external_id AS "externalId",
        name,
        brand,
        description,
        category_id AS "categoryId",
        sub_category_id AS "subCategoryId",
        cuisine_id AS "cuisineId",
        market_id AS "marketId",
        barcode,
        gtin_type AS "gtinType",
        price,
        currency,
        serving_size AS "servingSize",
        package_weight AS "packageWeight",
        product_url AS "sourceUrl",
        notes,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM gold.products
      WHERE vendor_id = ${vendorId} AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT ${Math.min(200, Math.max(1, Number(k) || 20))}
    `);
    return (out.rows || []) as Product[];
  }
}

export const storage = new DatabaseStorage();
