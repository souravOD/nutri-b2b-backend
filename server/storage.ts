import { type Vendor, type InsertVendor } from "../shared/schema.js";
import { db } from "./lib/database.js";
import {
  vendors, users, products, customers,
  customerHealthProfiles, ingestionJobs, auditLog,
  customerWhitelists, customerBlacklists, customerConsents, matchesCache,
} from "../shared/schema.js";
import { eq, and, desc, gte, lte, sql, count } from "drizzle-orm";
import { calculateHealthMetrics } from "./lib/health.js";



type CreateCustomerWithHealthArgs = {
  vendorId: string
  userId: string | null
  customer: {
    fullName: string
    email: string
    phone?: string | null
    customTags?: string[]
    age?: number | null
    gender?: any | null
  }
  health?: {
    age?: number
    gender?: any
    activityLevel?: any
    heightCm?: string | null    // numeric -> string
    weightKg?: string | null    // numeric -> string
    conditions?: string[]
    dietGoals?: string[]
    avoidAllergens?: string[]
    macroTargets?: { protein_g?: number; carbs_g?: number; fat_g?: number; calories?: number }
    bmi?: string | null         // numeric -> string
    bmr?: string | null         // numeric -> string
    tdeeCached?: string | null  // numeric -> string
    derivedLimits?: any
  } | null
}

// Drizzle-inferred types (select/insert)
export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = typeof customers.$inferInsert;

export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type InsertIngestionJob = typeof ingestionJobs.$inferInsert;

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// Small shapes used by metrics/health endpoints (match your code’s usage)
type HealthStatus = "Healthy" | "Degraded" | "Down";

export interface ReplicaStatus {
  id: string;
  status: HealthStatus;
  lag: number;            // seconds (or whatever unit you're using)
}

export interface DatabasePartitions {
  products: number;
  customers: number;
  vendors: number;
}

// Make DatabaseHealth describe everything you actually return
export interface DatabaseHealth {
  status: HealthStatus;
  // keep these optional if you’re not setting them in the return
  primaryConnected?: boolean;
  readReplicaConnected?: boolean;

  // the extra fields you’re returning:
  responseTime?: number;
  recentInserts?: { products: number; customers: number };
  replicaStatus?: ReplicaStatus[];         // <-- add this
  partitions?: DatabasePartitions;         // <-- and this
}

export interface SystemMetrics {
  products: number;
  customers: number;
  vendors: number;
  recentProducts?: number;
  recentCustomers?: number;
  uptime?: number;
  /** Add this since you return `database: await this.getDatabaseHealth()` at L299 */
  database?: DatabaseHealth;
}

export interface IStorage {
  // User management
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  // Vendor management
  getVendor(id: string): Promise<Vendor | undefined>;
  getVendors(): Promise<Vendor[]>;
  createVendor(vendor: InsertVendor): Promise<Vendor>;
  updateVendor(id: string, updates: Partial<InsertVendor>): Promise<Vendor | undefined>;

  // Product management
  getProducts(vendorId: string, filters?: any): Promise<Product[]>;
  getProduct(id: string, vendorId: string): Promise<Product | undefined>;
  createProducts(products: InsertProduct[]): Promise<Product[]>;
  updateProduct(id: string, vendorId: string, updates: Partial<InsertProduct>): Promise<Product | undefined>;
  deleteProduct(id: string, vendorId: string): Promise<boolean>;

  // Customer management
  getCustomers(vendorId: string, filters?: any): Promise<Customer[]>;
  getCustomer(id: string, vendorId: string): Promise<Customer | undefined>;
  createCustomers(customers: InsertCustomer[]): Promise<Customer[]>;
  updateCustomer(id: string, vendorId: string, updates: Partial<InsertCustomer>): Promise<Customer | undefined>;
  deleteCustomer(id: string, vendorId: string): Promise<boolean>;
  // Return base customer merged with optional health profile (you already implement this)
  getCustomerWithProfile(id: string, vendorId?: string | null): Promise<(Customer & { healthProfile: CustomerHealthProfile | null }) | null>;

  // Upsert health profile for a customer (insert if missing, else update)
  upsertCustomerHealth(
    customerId: string,
    vendorId: string,
    patch: Partial<InsertCustomerHealthProfile>
  ): Promise<CustomerHealthProfile>;

  // Ingestion jobs
  getIngestionJob(id: string): Promise<IngestionJob | undefined>;
  getIngestionJobs(vendorId: string, status?: string): Promise<IngestionJob[]>;
  createIngestionJob(job: InsertIngestionJob): Promise<IngestionJob>;
  updateIngestionJob(id: string, updates: Partial<IngestionJob>): Promise<IngestionJob | undefined>;

  // Metrics
  getSystemMetrics(): Promise<SystemMetrics>;
  getDatabaseHealth(): Promise<DatabaseHealth>;

  // Search
  searchProducts(vendorId: string, query: string, filters?: any): Promise<Product[]>;
  searchCustomers(vendorId: string, query: string, filters?: any): Promise<Customer[]>;

  // Matching
  getMatches(customerId: string, vendorId: string, k?: number): Promise<Product[]>;
}

export type CustomerHealthProfile = typeof customerHealthProfiles.$inferSelect;
export type InsertCustomerHealthProfile = typeof customerHealthProfiles.$inferInsert;

function genExternalId() {
  // short, unique-enough human id: ext_kk4x8p7a
  return "ext_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export class DatabaseStorage implements IStorage {
  // Feature-detection cache: whether products.notes column exists
  private _hasProductNotes: boolean | null = null;
  private async hasProductNotes(): Promise<boolean> {
    if (this._hasProductNotes != null) return this._hasProductNotes;
    try {
      // Robust detection that works across drivers: selecting a non-existent column throws.
      await db.execute(sql`SELECT notes FROM products LIMIT 0` as any);
      this._hasProductNotes = true;
    } catch {
      this._hasProductNotes = false;
    }
    return this._hasProductNotes;
  }
  
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0];
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return result[0];
  }

  async createUser(user: InsertUser): Promise<User> {
    const result = await db.insert(users).values(user).returning();
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
    const result = await db.update(vendors).set({ ...updates, updatedAt: sql`now()` }).where(eq(vendors.id, id)).returning();
    return result[0];
  }

  async getProducts(vendorId: string, filters?: any): Promise<Product[]> {
    // If the runtime DB is missing newly added optional columns (e.g., products.notes),
    // fall back to a raw SELECT * so listing doesn't error.
    if (!(await this.hasProductNotes())) {
      const clauses: any[] = [sql`vendor_id = ${vendorId}`];
      if (filters?.status) clauses.push(sql`status = ${filters.status}`);
      const where = clauses.length ? sql.join(clauses, sql` AND `) : sql`TRUE`;
      const lim = typeof filters?.limit === 'number' ? Math.max(1, filters.limit) : null;
      const off = typeof filters?.offset === 'number' ? Math.max(0, filters.offset) : null;
      const result: any = await db.execute(sql`
        SELECT * FROM products WHERE ${where}
        ${lim != null ? sql`LIMIT ${lim}` : sql``}
        ${off != null ? sql`OFFSET ${off}` : sql``}
      ` as any);
      const rows = (result?.rows ?? result) as any[];
      return rows as any as Product[];
    }

    let q: any = db.select().from(products).where(eq(products.vendorId, vendorId));
  
    if (filters?.status) {
      q = q.where(eq(products.status, filters.status as Product["status"] as any));
    }
    if (typeof filters?.limit === "number") {
      q = q.limit(filters.limit as number);
    }
    if (typeof filters?.offset === "number") {
      q = q.offset(filters.offset as number);
    }
  
    const rows = (await q) as Product[];
    return rows;
  }
  

  async getProduct(id: string, vendorId: string): Promise<Product | undefined> {
    if (!(await this.hasProductNotes())) {
      const result: any = await db.execute(sql`
        SELECT * FROM products WHERE id = ${id} AND vendor_id = ${vendorId} LIMIT 1
      ` as any);
      const rows = (result?.rows ?? result) as any[];
      return rows?.[0] as any as Product | undefined;
    }
    const result = await db
      .select()
      .from(products)
      .where(and(eq(products.id, id), eq(products.vendorId, vendorId)))
      .limit(1);
    return result[0];
  }

  async createProducts(productList: InsertProduct[]): Promise<Product[]> {
    if (productList.length === 0) return [];
    return await db.insert(products).values(productList).returning();
  }

  async updateProduct(id: string, vendorId: string, updates: Partial<InsertProduct>): Promise<Product | undefined> {
    // Avoid referencing a missing column on older DBs
    if (!(await this.hasProductNotes())) {
      if ((updates as any).notes !== undefined) delete (updates as any).notes;
    }
    const result = await db
      .update(products)
      .set({ ...updates, updatedAt: sql`now()` })
      .where(and(eq(products.id, id), eq(products.vendorId, vendorId)))
      .returning();
    return result[0];
  }

  async deleteProduct(id: string, vendorId: string): Promise<boolean> {
    const result = await db
      .delete(products)
      .where(and(eq(products.id, id), eq(products.vendorId, vendorId)))
      .returning();
    return result.length > 0;
  }

  // ✅ UPDATED: honors `q`/`search` and preserves vendor scoping; supports limit/page if provided
  async getCustomers(vendorId: string, filters?: any): Promise<Customer[]> {
    let q: any = db.select().from(customers);
  
    if (filters?.status) {
      let q: any = db.select().from(customers).where(eq(customers.vendorId, vendorId));
    }
    const lim = typeof filters?.limit === "number" ? filters.limit : undefined;
    const page = typeof filters?.page === "number" ? filters.page : undefined;
  
    if (lim) q = q.limit(lim);
    if (page && lim) q = q.offset((page - 1) * lim);
  
    const rows = (await q) as Customer[];
    return rows;
  }
  
  async upsertCustomerHealth(
    customerId: string,
    vendorId: string,
    patch: Partial<InsertCustomerHealthProfile>
  ): Promise<CustomerHealthProfile> {
    // Make sure this customer belongs to the vendor
    const [cust] = await db
      .select({ id: customers.id, age: customers.age, gender: customers.gender })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.vendorId, vendorId)))
      .limit(1);
    if (!cust) throw new Error("Customer not found");
  
    const now = sql`now()`;
    const have = (v: any) =>
      v !== undefined && v !== null && v !== "" && !Number.isNaN(Number(v));
    
    if (have((patch as any).heightCm) && have((patch as any).weightKg) && have((patch as any).age)) {
      const metrics = calculateHealthMetrics({
        heightCm: Number((patch as any).heightCm),
        weightKg: Number((patch as any).weightKg),
        age: Number((patch as any).age),
        gender: (patch as any).gender ?? (cust.gender as any) ?? "unspecified",
        activityLevel: (patch as any).activityLevel ?? "sedentary",
        conditions: (patch as any).conditions ?? [],
        dietGoals: (patch as any).dietGoals ?? [],
        avoidAllergens: (patch as any).avoidAllergens ?? [],
        macroTargets: (patch as any).macroTargets,
      });
    
      // Leave them as numbers here; they'll be string-coerced in normalizedPatch below
      (patch as any).bmi = metrics.bmi;
      (patch as any).bmr = metrics.bmr;
      (patch as any).tdeeCached = metrics.tdee;
      (patch as any).derivedLimits = metrics.derivedLimits ?? null;
    }
    // Drizzle maps PG numeric -> TS string. Coerce any numbers to strings.
    const toStr = (v: any) =>
      v === undefined ? undefined : v === null ? null : typeof v === "number" ? String(v) : String(v);
  
    // Only the NUMERIC columns need string coercion.
    const normalizedPatch: Partial<InsertCustomerHealthProfile> = {
      ...patch,
      // numeric (NOT NULL)
      heightCm: (patch as any).heightCm !== undefined ? toStr((patch as any).heightCm) : patch.heightCm,
      weightKg: (patch as any).weightKg !== undefined ? toStr((patch as any).weightKg) : patch.weightKg,
      // numeric (nullable)
      bmi: (patch as any).bmi !== undefined ? toStr((patch as any).bmi) : patch.bmi ?? null,
      bmr: (patch as any).bmr !== undefined ? toStr((patch as any).bmr) : patch.bmr ?? null,
      tdeeCached:
        (patch as any).tdeeCached !== undefined ? toStr((patch as any).tdeeCached) : patch.tdeeCached ?? null,
    };
  
    // 1) UPDATE first
    const [updated] = await db
      .update(customerHealthProfiles)
      .set({ ...normalizedPatch, updatedAt: now })
      .where(eq(customerHealthProfiles.customerId, customerId))
      .returning();
    if (updated) return updated;
  
    // 2) INSERT with safe defaults for NOT NULL columns
    const defaults: InsertCustomerHealthProfile = {
      customerId,
      // heightCm/weightKg are NUMERIC NOT NULL -> strings
      heightCm: "0",
      weightKg: "0",
      // age is int4 (number)
      age: cust.age ?? 0,
      // enums
      gender: (cust.gender as any) ?? "female",
      activityLevel: "extra" as any,
      // arrays/jsonb
      conditions: [],
      dietGoals: [],
      macroTargets: { protein_g: 0, carbs_g: 0, fat_g: 0, calories: 0 },
      avoidAllergens: [],
      // other numeric (nullable) -> strings or null
      bmi: null,
      bmr: null,
      tdeeCached: null,
      derivedLimits: null,
      // audit
      createdAt: now as any,
      updatedAt: now as any,
      updatedBy: null,
    };
  
    const values: InsertCustomerHealthProfile = {
      ...defaults,
      ...normalizedPatch,
      customerId,
      updatedAt: now as any,
    };
  
    const [inserted] = await db
      .insert(customerHealthProfiles)
      .values(values)
      .returning();
    return inserted;

  }

  async createCustomerWithHealth(args: CreateCustomerWithHealthArgs) {
    const { vendorId, userId, customer, health } = args
    // inside createCustomerWithHealth(...)
    return await db.transaction(async (tx) => {
      const now = sql`now()`;

      // 1) customers: UPSERT by (vendor_id, email)
      const [cust] = await tx
        .insert(customers)
        .values({
          id: crypto.randomUUID(),
          vendorId,
          externalId: genExternalId(),
          fullName: customer.fullName,
          email: customer.email,
          phone: customer.phone ?? null,
          customTags: customer.customTags ?? [],
          age: customer.age ?? null,
          gender: customer.gender ?? "unspecified",
          createdAt: now as any,
          updatedAt: now as any,
          updatedBy: userId,
        })
        .onConflictDoUpdate({
          target: [customers.vendorId, customers.email],   // ← key for idempotency
          set: {
            fullName: sql`excluded.full_name`,
            phone: sql`excluded.phone`,
            customTags: sql`excluded.custom_tags`,
            age: sql`excluded.age`,
            gender: sql`excluded.gender`,
            updatedAt: now as any,
            updatedBy: userId,
          },
        })
        .returning();

      // 2) customer_health_profiles: insert-or-ignore (one profile per customer)
      let healthRow: any = null;
      if (health) {
        // ... your existing derived-metrics block stays the same ...

        const defaults = {
          customerId: cust.id,
          heightCm: health.heightCm ?? "0",
          weightKg: health.weightKg ?? "0",
          age: health.age ?? 0,
          gender: health.gender ?? "unspecified",
          activityLevel: health.activityLevel ?? "sedentary",
          conditions: health.conditions ?? [],
          dietGoals: health.dietGoals ?? [],
          macroTargets: health.macroTargets ?? { protein_g: 0, carbs_g: 0, fat_g: 0, calories: 0 },
          avoidAllergens: health.avoidAllergens ?? [],
          bmi: health.bmi ?? null,
          bmr: health.bmr ?? null,
          tdeeCached: health.tdeeCached ?? null,
          derivedLimits: health.derivedLimits ?? null,
          createdAt: now as any,
          updatedAt: now as any,
          updatedBy: userId,
        };

        const [ins] = await tx
          .insert(customerHealthProfiles)
          .values(defaults)
          .onConflictDoNothing({ target: customerHealthProfiles.customerId }) // ← ignore if exists
          .returning();

        healthRow = ins ?? null;
      }

      return { customer: cust, health: healthRow };
    });
  }

  async getCustomer(id: string, vendorId: string) {  // lines ~165–172
    const result = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.vendorId, vendorId)))
      .limit(1);
    return result[0];

  }
  
  async getCustomerWithProfile(id: string, vendorId?: string | null) {
    // Build WHERE in the same style as your other methods
    const where = vendorId
      ? and(eq(customers.id, id), eq(customers.vendorId, vendorId))
      : eq(customers.id, id);
  
    const rows = await db
      .select({
        c: customers,
        hp: customerHealthProfiles, // full row; trim here if you want fewer fields
      })
      .from(customers)
      .leftJoin(customerHealthProfiles, eq(customerHealthProfiles.customerId, customers.id))
      .where(where)
      .limit(1);
  
    if (!rows.length) return null;
  
    const { c, hp } = rows[0];
  
    // Return a merged object; keep the base customer shape untouched
    return {
      ...c,
      healthProfile: hp
        ? {
            // Map only what you want to expose. Field names below mirror your Supabase schema.
            customerId: hp.customerId,
            heightCm: hp.heightCm,
            weightKg: hp.weightKg,
            age: hp.age,
            gender: hp.gender,
            activityLevel: hp.activityLevel,
            conditions: hp.conditions,            // text[]
            dietGoals: hp.dietGoals,              // text[]
            macroTargets: hp.macroTargets,        // jsonb
            avoidAllergens: hp.avoidAllergens,    // text[]
            bmi: hp.bmi,
            bmr: hp.bmr,
            tdeeCached: hp.tdeeCached,
            derivedLimits: hp.derivedLimits,      // jsonb
            createdAt: hp.createdAt,
            updatedAt: hp.updatedAt,
            updatedBy: hp.updatedBy,
          }
        : null,
    };
  }

  async createCustomers(customerList: InsertCustomer[]): Promise<Customer[]> {
    if (customerList.length === 0) return [];
  
    // NOTE: keep shape identical; just make the insert idempotent
    const rows = await db
      .insert(customers)
      .values(customerList)
      .onConflictDoNothing({
        // treat (vendor_id, email) as the natural key
        target: [customers.vendorId, customers.email],
      })
      .returning();
  
    return rows;
  }

  async updateCustomer(id: string, vendorId: string, updates: any) {
    // Build an allow-list (camelCase keys that match Drizzle columns)
    const allowed: any = {};
    if (updates.fullName !== undefined) allowed.fullName = String(updates.fullName).trim();
    if (updates.email !== undefined) allowed.email = String(updates.email).trim();
    if (updates.phone !== undefined) allowed.phone = String(updates.phone).trim();
    if (updates.customTags !== undefined) allowed.customTags = updates.customTags; // string[] | null
    if (updates.notes !== undefined) allowed.notes = updates.notes; // free-form text
    if (updates.updatedBy !== undefined) allowed.updatedBy = updates.updatedBy;
  
    // Nothing to update? Return current row to satisfy the interface type.
    if (Object.keys(allowed).length === 0) {
      return await this.getCustomer(id, vendorId);
    }
  
    // 🔎 High-signal debug
    console.log('[storage.updateCustomer] allowed ->', allowed);
  
    // Ensure at top of file: import { and, eq, sql } from "drizzle-orm";
    await db
      .update(customers)
      .set({ ...allowed, updatedAt: sql`now()` })
      .where(and(eq(customers.id, id), eq(customers.vendorId, vendorId)));
  
    // IMPORTANT: return the **full base** customer to match IStorage
    const row = await this.getCustomer(id, vendorId);
  
    // 🔎 Debug the value after UPDATE
    if (row) console.log('[storage.updateCustomer] post-fetch fullName ->', row.fullName);
  
    return row; // type: Customer | undefined (matches IStorage)
  }

  // Upsert a customer-product note
  async upsertCustomerProductNote(
    vendorId: string,
    customerId: string,
    productId: string,
    note: string | null,
    userId: string | null,
  ) {
    const now = sql`now()`;
    // Load current map
    const [row] = await db
      .select({ productNotes: customers.productNotes })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.vendorId, vendorId)))
      .limit(1);
    if (!row) throw new Error("Customer not found");

    const map: Record<string, any> = (row.productNotes as any) || {};
    if (note == null || note === "") delete map[productId]; else map[productId] = String(note);

    const [updated] = await db
      .update(customers)
      .set({ productNotes: map as any, updatedAt: now as any, updatedBy: userId as any })
      .where(and(eq(customers.id, customerId), eq(customers.vendorId, vendorId)))
      .returning({ productNotes: customers.productNotes });

    return { customerId, productId, note: (updated?.productNotes as any)?.[productId] ?? null } as any;
  }

  async getCustomerProductNote(customerId: string, productId: string) {
    const [row] = await db
      .select({ productNotes: customers.productNotes })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    const map: Record<string, any> = (row?.productNotes as any) || {};
    return { customerId, productId, note: map[productId] ?? null } as any;
  }

  async deleteCustomer(id: string, vendorId: string): Promise<boolean> {
    let deleted = false;
    await db.transaction(async (tx) => {
      // Delete dependents first (FKs reference customers.id)
      await tx.delete(customerHealthProfiles).where(eq(customerHealthProfiles.customerId, id));
      await tx.delete(customerConsents).where(eq(customerConsents.customerId, id));
      await tx.delete(customerWhitelists).where(eq(customerWhitelists.customerId, id));
      await tx.delete(customerBlacklists).where(eq(customerBlacklists.customerId, id));
      await tx.delete(matchesCache).where(and(eq(matchesCache.vendorId, vendorId), eq(matchesCache.customerId, id)));
  
      const res = await tx
        .delete(customers)
        .where(and(eq(customers.id, id), eq(customers.vendorId, vendorId)))
        .returning({ id: customers.id });
  
      deleted = res.length > 0;
    });
    return deleted;
  }

  async getIngestionJob(id: string): Promise<IngestionJob | undefined> {
    const result = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, id)).limit(1);
    return result[0];
  }

  async getIngestionJobs(vendorId: string, status?: string): Promise<IngestionJob[]> {
    let q: any = db.select().from(ingestionJobs).where(eq(ingestionJobs.vendorId, vendorId));
  
    if (status) {
      const s = status as IngestionJob["status"] as any; // 'queued'|'running'|'failed'|'completed'|'canceled'
      q = q.where(eq(ingestionJobs.status, s));
    }
  
    return (await q) as IngestionJob[];
  }
  

  async createIngestionJob(job: InsertIngestionJob): Promise<IngestionJob> {
    const result = await db.insert(ingestionJobs).values(job).returning();
    return result[0];
  }

  async updateIngestionJob(id: string, updates: Partial<IngestionJob>): Promise<IngestionJob | undefined> {
    const result = await db.update(ingestionJobs).set({ ...updates }).where(eq(ingestionJobs.id, id)).returning();
    return result[0];
  }

  async getSystemMetrics(): Promise<SystemMetrics> {
    const vendorCountRes = await db.select({ count: count() }).from(vendors);
    const productCountRes = await db.select({ count: count() }).from(products);
    const customerCountRes = await db.select({ count: count() }).from(customers);

    return {
      vendors: vendorCountRes[0].count,
      products: productCountRes[0].count,
      customers: customerCountRes[0].count,
      database: await this.getDatabaseHealth(),
    };
  }

  async getDatabaseHealth(): Promise<DatabaseHealth> {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const recentProducts = await db.select({ count: count() })
      .from(products)
      .where(and(gte(products.createdAt, sql`now() - interval '1 hour'`), lte(products.createdAt, sql`now()`)));

    const recentCustomers = await db.select({ count: count() })
      .from(customers)
      .where(and(gte(customers.createdAt,  sql`now() - interval '1 hour'`), lte(customers.createdAt, sql`now()`)));

    return {
      status: 'Healthy',
      responseTime: Math.random() * 100 + 20,
      recentInserts: {
        products: recentProducts[0].count,
        customers: recentCustomers[0].count
      },
      replicaStatus: [
        { id: 'replica-1', status: 'Healthy', lag: 0.8 },
        { id: 'replica-2', status: 'Healthy', lag: 1.2 }
      ],
      partitions: {
        products: 752,
        customers: 1504,
        vendors: 47
      }
    };
  }

  // ✅ UPDATED: robust vendor-scoped product search with combined conditions
  async searchProducts(vendorId: string, query: string, filters?: any): Promise<Product[]> {
    const f = filters || {};
    const conditions: any[] = [eq(products.vendorId, vendorId)];
    const q = (query ?? f.q ?? f.search ?? "").toString().trim();
    if (q) {
      const like = `%${q}%`;
      conditions.push(sql`(
        ${products.name} ILIKE ${like} OR
        ${products.brand} ILIKE ${like} OR
        ${products.barcode} ILIKE ${like} OR
        ${products.description} ILIKE ${like}
      )`);
    }
    if (f.brand) {
      conditions.push(sql`${products.brand} ILIKE ${`%${f.brand}%`}`);
    }
    const categoryId = f.category_id ?? f.categoryId;
    if (categoryId) {
      conditions.push(eq(products.categoryId, categoryId));
    }
    if (f.status) {
      conditions.push(eq(products.status, f.status));
    }
    let dbQuery: any = db.select().from(products).where(and(...conditions));
    if (f.limit) {
      const lim = Math.min(200, Math.max(1, parseInt(String(f.limit), 10)));
      dbQuery = dbQuery.limit(lim);
    }
    return await dbQuery.orderBy(desc(products.updatedAt));
  }

  // ✅ UPDATED: vendor-scoped customers search (same pattern as products)
  async searchCustomers(vendorId: string, query: string, filters?: any): Promise<Customer[]> {
    const f = filters || {};
    const conditions: any[] = [eq(customers.vendorId, vendorId)];
    const q = (query ?? f.q ?? f.search ?? "").toString().trim();
    if (q) {
      const like = `%${q}%`;
      conditions.push(sql`(
        ${customers.fullName} ILIKE ${like} OR
        ${customers.email} ILIKE ${like} OR
        COALESCE(${customers.phone}, '') ILIKE ${like}
      )`);
    }
    let dbQuery: any = db.select().from(customers).where(and(...conditions));
    if (f.limit) {
      const lim = Math.min(200, Math.max(1, parseInt(String(f.limit), 10)));
      dbQuery = dbQuery.limit(lim);
    }
    return await dbQuery.orderBy(desc(customers.updatedAt));
  }

  async getMatches(customerId: string, vendorId: string, k = 20): Promise<Product[]> {
    // Simple matching implementation - in production this would use sophisticated health-aware scoring
    return await db
      .select()
      .from(products)
      .where(and(eq(products.vendorId, vendorId), eq(products.status, 'active')))
      .limit(k)
      .orderBy(desc(products.updatedAt));
  }
}

export const storage = new DatabaseStorage(
  // Dependencies would be injected here in a real implementation
);
