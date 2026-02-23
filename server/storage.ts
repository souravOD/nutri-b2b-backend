import {
  type Vendor,
  type InsertVendor,
  vendors,
  users,
  products,
  customers,
  customerHealthProfiles,
  ingestionJobs,
  matchesCache,
  type InsertCustomerHealthProfile,
} from "../shared/schema.js";
import { db } from "./lib/database.js";
import { and, desc, eq, count, sql } from "drizzle-orm";
import { calculateHealthMetrics } from "./lib/health.js";

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

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

function toGoldCustomerStatus(status?: string | null): "active" | "inactive" | "suspended" {
  const s = String(status || "active").toLowerCase();
  if (s === "archived") return "inactive";
  if (s === "inactive") return "inactive";
  if (s === "suspended") return "suspended";
  return "active";
}

function toGoldProductStatus(status?: string | null): "active" | "discontinued" | "out_of_stock" {
  const s = String(status || "active").toLowerCase();
  if (s === "inactive" || s === "discontinued") return "discontinued";
  if (s === "out_of_stock") return "out_of_stock";
  return "active";
}

function toGoldGender(gender?: string | null): string | null {
  if (!gender) return null;
  const g = String(gender).toLowerCase();
  if (g === "unspecified") return "prefer_not_to_say";
  if (["male", "female", "other", "prefer_not_to_say"].includes(g)) return g;
  return "prefer_not_to_say";
}

function toGoldActivityLevel(activity?: string | null): string {
  const a = String(activity || "sedentary").toLowerCase();
  if (a === "light" || a === "lightly_active") return "lightly_active";
  if (a === "moderate" || a === "moderately_active") return "moderately_active";
  if (a === "very" || a === "very_active") return "very_active";
  if (a === "extra" || a === "extra_active") return "extra_active";
  return "sedentary";
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

    const out = await db.execute(sql`
      SELECT
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
        product_url AS "sourceUrl",
        notes,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM gold.products
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY updated_at DESC
      LIMIT ${pageSize}
      OFFSET ${offset}
    `);

    return (out.rows || []) as Product[];
  }

  async getProduct(id: string, vendorId: string): Promise<Product | undefined> {
    const out = await db.execute(sql`
      SELECT
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
        product_url AS "sourceUrl",
        notes,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM gold.products
      WHERE id = ${id} AND vendor_id = ${vendorId}
      LIMIT 1
    `);
    return (out.rows?.[0] as Product | undefined) ?? undefined;
  }

  async createProducts(productList: InsertProduct[]): Promise<Product[]> {
    if (productList.length === 0) return [];
    const created: Product[] = [];

    for (const p of productList) {
      const out = await db.execute(sql`
        INSERT INTO gold.products (
          vendor_id,
          external_id,
          name,
          brand,
          description,
          category_id,
          barcode,
          gtin_type,
          price,
          currency,
          serving_size,
          package_weight,
          product_url,
          notes,
          status
        )
        VALUES (
          ${p.vendorId},
          ${p.externalId},
          ${p.name},
          ${p.brand ?? null},
          ${p.description ?? null},
          ${p.categoryId ?? null},
          ${p.barcode ?? null},
          ${p.gtinType ?? null},
          ${p.price ?? null},
          ${p.currency ?? "USD"},
          ${p.servingSize ?? null},
          ${p.packageWeight ?? null},
          ${p.sourceUrl ?? null},
          ${p.notes ?? null},
          ${toGoldProductStatus(p.status as any)}
        )
        RETURNING
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
          product_url AS "sourceUrl",
          notes,
          status,
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
    if (updates.barcode !== undefined) setParts.push(sql`barcode = ${updates.barcode}`);
    if (updates.gtinType !== undefined) setParts.push(sql`gtin_type = ${updates.gtinType}`);
    if (updates.price !== undefined) setParts.push(sql`price = ${updates.price}`);
    if (updates.currency !== undefined) setParts.push(sql`currency = ${updates.currency}`);
    if (updates.servingSize !== undefined) setParts.push(sql`serving_size = ${updates.servingSize}`);
    if (updates.packageWeight !== undefined) setParts.push(sql`package_weight = ${updates.packageWeight}`);
    if (updates.sourceUrl !== undefined) setParts.push(sql`product_url = ${updates.sourceUrl}`);
    if (updates.notes !== undefined) setParts.push(sql`notes = ${updates.notes}`);
    if (updates.status !== undefined) setParts.push(sql`status = ${toGoldProductStatus(updates.status as any)}`);
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
        ARRAY[]::text[] AS "customTags"
      FROM gold.b2b_customers
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY updated_at DESC
      LIMIT ${pageSize}
      OFFSET ${offset}
    `);

    return (out.rows || []) as Customer[];
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
        ARRAY[]::text[] AS "customTags"
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
    return {
      ...rows[0].customer,
      healthProfile: rows[0].health ?? null,
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
    const [cust] = await db
      .select({ id: customers.id, age: customers.age, gender: customers.gender })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.vendorId, vendorId)))
      .limit(1);

    if (!cust) throw new Error("Customer not found");

    const normalizedPatch: Partial<InsertCustomerHealthProfile> = {
      ...patch,
      activityLevel: toGoldActivityLevel((patch as any).activityLevel as string | null),
      age: (patch as any).age ?? cust.age ?? undefined,
      gender: toGoldGender((patch as any).gender ?? cust.gender ?? null),
      heightCm: toNumericString((patch as any).heightCm),
      weightKg: toNumericString((patch as any).weightKg),
      bmi: toNumericString((patch as any).bmi),
      bmr: toNumericString((patch as any).bmr),
      tdeeCached: toNumericString((patch as any).tdeeCached),
      conditions: Array.isArray((patch as any).conditions) ? (patch as any).conditions : undefined,
      dietGoals: Array.isArray((patch as any).dietGoals) ? (patch as any).dietGoals : undefined,
      avoidAllergens: Array.isArray((patch as any).avoidAllergens) ? (patch as any).avoidAllergens : undefined,
      macroTargets: (patch as any).macroTargets ?? undefined,
      derivedLimits: (patch as any).derivedLimits ?? undefined,
    };

    // Merge with existing profile so partial updates still recompute BMI/TDEE
    const [existingProfile] = await db.select()
      .from(customerHealthProfiles)
      .where(eq(customerHealthProfiles.customerId, customerId))
      .limit(1);

    const effectiveHeight = normalizedPatch.heightCm ?? existingProfile?.heightCm ?? null;
    const effectiveWeight = normalizedPatch.weightKg ?? existingProfile?.weightKg ?? null;
    const effectiveAge = normalizedPatch.age ?? existingProfile?.age ?? cust.age ?? null;

    const haveMetricsInputs =
      effectiveHeight != null &&
      effectiveWeight != null &&
      effectiveAge != null;

    if (haveMetricsInputs) {
      const metrics = calculateHealthMetrics({
        heightCm: String(effectiveHeight),
        weightKg: String(effectiveWeight),
        age: Number(effectiveAge),
        gender: (normalizedPatch.gender as any) ?? existingProfile?.gender ?? "prefer_not_to_say",
        activityLevel: normalizedPatch.activityLevel ?? existingProfile?.activityLevel ?? "sedentary",
        conditions: normalizedPatch.conditions ?? existingProfile?.conditions ?? [],
        dietGoals: normalizedPatch.dietGoals ?? existingProfile?.dietGoals ?? [],
        avoidAllergens: normalizedPatch.avoidAllergens ?? existingProfile?.avoidAllergens ?? [],
        macroTargets: (normalizedPatch.macroTargets as any) ?? (existingProfile?.macroTargets as any) ?? {},
      } as any);

      normalizedPatch.bmi = String(metrics.bmi);
      normalizedPatch.bmr = String(metrics.bmr);
      normalizedPatch.tdeeCached = String(metrics.tdee);
      normalizedPatch.derivedLimits = metrics.derivedLimits;
    }

    const [updated] = await db
      .update(customerHealthProfiles)
      .set({ ...normalizedPatch, updatedAt: sql`now()` })
      .where(eq(customerHealthProfiles.customerId, customerId))
      .returning();

    if (updated) return updated;

    const defaults: InsertCustomerHealthProfile = {
      customerId,
      heightCm: "0",
      weightKg: "0",
      activityLevel: "sedentary",
      age: cust.age ?? 0,
      gender: toGoldGender(cust.gender) ?? "prefer_not_to_say",
      conditions: [],
      dietGoals: [],
      macroTargets: {},
      avoidAllergens: [],
      bmi: null,
      bmr: null,
      tdeeCached: null,
      derivedLimits: {},
      updatedBy: null,
      healthGoal: null,
      targetWeightKg: null,
      targetCalories: null,
      targetProteinG: null,
      targetCarbsG: null,
      targetFatG: null,
      targetFiberG: null,
      targetSodiumMg: null,
      targetSugarG: null,
      tdee: null,
    };

    const [inserted] = await db
      .insert(customerHealthProfiles)
      .values({ ...defaults, ...normalizedPatch, customerId })
      .returning();

    return inserted;
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
            updatedBy: userId,
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
            createdBy: userId,
            updatedBy: userId,
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
        derivedLimits: health.derivedLimits ?? {},
        updatedBy: userId,
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
      .set({ productNotes: map as any, updatedAt: sql`now()`, updatedBy: userId as any })
      .where(and(eq(customers.id, customerId), eq(customers.vendorId, vendorId)))
      .returning({ productNotes: customers.productNotes });

    return {
      customerId,
      productId,
      note: (updated?.productNotes as any)?.[productId] ?? null,
    };
  }

  async getCustomerProductNote(customerId: string, productId: string) {
    const [row] = await db
      .select({ productNotes: customers.productNotes })
      .from(customers)
      .where(eq(customers.id, customerId))
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

    const out = await db.execute(sql`
      SELECT
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
        product_url AS "sourceUrl",
        notes,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM gold.products
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY updated_at DESC
      LIMIT ${pageSize}
      OFFSET ${offset}
    `);
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
        ARRAY[]::text[] AS "customTags"
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
