import { sql } from "drizzle-orm";
import { 
  pgTable, 
  text, 
  varchar, 
  uuid, 
  timestamp, 
  numeric, 
  integer, 
  jsonb, 
  boolean,
  pgEnum,
  index,
  uniqueIndex,
  primaryKey
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

// Enums
export const userRoleEnum = pgEnum('user_role', ['superadmin', 'vendor_admin', 'vendor_operator', 'vendor_viewer']);
export const vendorStatusEnum = pgEnum('vendor_status', ['active', 'inactive', 'suspended']);
export const productStatusEnum = pgEnum('product_status', ['active', 'inactive']);
export const customerGenderEnum = pgEnum('customer_gender', ['male', 'female', 'other', 'unspecified']);
export const activityLevelEnum = pgEnum('activity_level', ['sedentary', 'light', 'moderate', 'very', 'extra']);
export const jobStatusEnum = pgEnum('job_status', ['queued', 'running', 'failed', 'completed', 'canceled']);
export const jobModeEnum = pgEnum('job_mode', ['products', 'customers', 'api_sync']);
export const sourceEnum = pgEnum('source', ['csv', 'api']);
export const gtinTypeEnum = pgEnum('gtin_type', ['UPC', 'EAN', 'ISBN']);
export const authTypeEnum = pgEnum('auth_type', ['api_key', 'oauth2', 'basic']);
export const synonymDomainEnum = pgEnum('synonym_domain', ['allergen', 'condition', 'unit', 'diet', 'gender', 'activity']);
export const consentTypeEnum = pgEnum('consent_type', ['data_processing', 'health_data', 'marketing']);
export const webhookEventEnum = pgEnum('webhook_event', ['job.completed', 'job.failed', 'product.updated', 'customer.updated']);
export const deliveryStatusEnum = pgEnum('delivery_status', ['pending', 'delivered', 'failed', 'retry']);

// Core tables
export const vendors = pgTable("vendors", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  status: vendorStatusEnum("status").notNull().default('active'),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  settingsJson: jsonb("settings_json").default('{}'),
  catalogVersion: integer("catalog_version").notNull().default(1)
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`)
});

export const userLinks = pgTable("user_links", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  role: userRoleEnum("role").notNull(),
  status: text("status").notNull().default('active'),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`)
}, (table) => ({
  uniqueUserVendor: uniqueIndex("unique_user_vendor").on(table.userId, table.vendorId)
}));

export const platformAdmins = pgTable("platform_admins", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  createdBy: uuid("created_by").references(() => users.id)
});

// Product tables (partitioned)
export const products = pgTable("products", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  brand: text("brand"),
  description: text("description"),
  categoryId: uuid("category_id"),
  price: numeric("price", { precision: 12, scale: 2 }),
  currency: varchar("currency", { length: 3 }).notNull().default('USD'),
  status: productStatusEnum("status").notNull().default('active'),
  searchTsv: text("search_tsv"), // tsvector will be handled in SQL
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  // Optional fields
  barcode: text("barcode"),
  gtinType: gtinTypeEnum("gtin_type"),
  ingredients:  text("ingredients").array(),
  subCategoryId: uuid("sub_category_id"),
  cuisineId: uuid("cuisine_id"),
  marketId: uuid("market_id"),
  nutrition: jsonb("nutrition"),
  servingSize: text("serving_size"),
  packageWeight: text("package_weight"),
  dietaryTags: text("dietary_tags").array(),
  allergens: text("allergens").array(),
  certifications: text("certifications").array(),
  regulatoryCodes: text("regulatory_codes").array(),
  sourceUrl: text("source_url"),
  // Global vendor-scoped notes per product
  notes: text("notes"),
  softDeletedAt: timestamp("soft_deleted_at")
}, (table) => ({
  uniqueVendorExternal: uniqueIndex("unique_vendor_external_id").on(table.vendorId, table.externalId),
  uniqueVendorBarcode: uniqueIndex("unique_vendor_barcode").on(table.vendorId, table.barcode)
}));

export const productImages = pgTable("product_images", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: uuid("product_id").notNull().references(() => products.id),
  url: text("url").notNull(),
  alt: text("alt"),
  order: integer("order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`)
});

export const productSources = pgTable("product_sources", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: uuid("product_id").notNull().references(() => products.id),
  source: sourceEnum("source").notNull(),
  sourceRef: text("source_ref"),
  ingestionJobId: uuid("ingestion_job_id"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`)
});

// Customer tables (partitioned)
export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  externalId: text("external_id").notNull(),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  dob: timestamp("dob"),
  age: integer("age"),
  gender: customerGenderEnum("gender"),
  location: jsonb("location"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  // Optional fields
  phone: text("phone"),
  customTags: text("custom_tags").array(),
  // Simple free-form notes per customer
  notes: text("notes"),
  // JSON map of productId -> note string (per customer)
  productNotes: jsonb("product_notes").default('{}'),
  searchTsv: text("search_tsv"),
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by")
}, (table) => ({
  uniqueVendorExternal: uniqueIndex("unique_customer_vendor_external").on(table.vendorId, table.externalId)
}));

export const customerHealthProfiles = pgTable("customer_health_profiles", {
  customerId: uuid("customer_id").primaryKey().references(() => customers.id),
  heightCm: numeric("height_cm", { precision: 5, scale: 2 }).notNull(),
  weightKg: numeric("weight_kg", { precision: 6, scale: 2 }).notNull(),
  age: integer("age").notNull(),
  gender: customerGenderEnum("gender").notNull(),
  activityLevel: activityLevelEnum("activity_level").notNull(),
  conditions: text("conditions").array().notNull().default(sql`'{}'::text[]`),
  dietGoals: text("diet_goals").array().notNull().default(sql`'{}'::text[]`),
  macroTargets: jsonb("macro_targets").notNull().default('{}'),
  avoidAllergens: text("avoid_allergens").array().notNull().default(sql`'{}'::text[]`),
  // Derived fields
  bmi: numeric("bmi", { precision: 5, scale: 2 }),
  bmr: numeric("bmr", { precision: 8, scale: 2 }),
  tdeeCached: numeric("tdee_cached", { precision: 8, scale: 2 }),
  derivedLimits: jsonb("derived_limits").default('{}'),
  // Audit fields
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  updatedBy: uuid("updated_by")
});

export const customerConsents = pgTable("customer_consents", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  consentType: consentTypeEnum("consent_type").notNull(),
  granted: boolean("granted").notNull(),
  version: text("version").notNull(),
  timestamp: timestamp("timestamp").notNull().default(sql`now()`)
});

export const customerWhitelists = pgTable("customer_whitelists", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  productId: uuid("product_id").notNull().references(() => products.id),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`)
});

export const customerBlacklists = pgTable("customer_blacklists", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  productId: uuid("product_id").notNull().references(() => products.id),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`)
});

// Taxonomy tables
export const taxCategories = pgTable("tax_categories", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => taxCategories.id),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`)
});

export const taxTags = pgTable("tax_tags", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => taxTags.id),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`)
});

export const taxAllergens = pgTable("tax_allergens", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => taxAllergens.id),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`)
});

export const taxCuisines = pgTable("tax_cuisines", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => taxCuisines.id),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`)
});

export const taxCertifications = pgTable("tax_certifications", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => taxCertifications.id),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`)
});

// Synonym tables
export const synonymsHeader = pgTable("synonyms_header", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  canonical: text("canonical").notNull(),
  synonyms: text("synonyms").array().notNull(),
  transformOps: jsonb("transform_ops").default('{}'),
  confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default('1.0')
});

export const synonymsValue = pgTable("synonyms_value", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  domain: synonymDomainEnum("domain").notNull(),
  canonical: text("canonical").notNull(),
  synonyms: text("synonyms").array().notNull()
});

export const vendorMappings = pgTable("vendor_mappings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  mode: jobModeEnum("mode").notNull(),
  map: jsonb("map").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`)
});

// Ingestion tables
export const ingestionJobs = pgTable("ingestion_jobs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  mode: jobModeEnum("mode").notNull(),
  status: jobStatusEnum("status").notNull().default('queued'),
  progressPct: integer("progress_pct").notNull().default(0),
  totals: jsonb("totals").default('{}'),
  errorUrl: text("error_url"),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  attempt: integer("attempt").notNull().default(1),
  params: jsonb("params").default('{}'),
  createdAt: timestamp("created_at").notNull().default(sql`now()`)
});

export const ingestionJobErrors = pgTable("ingestion_job_errors", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: uuid("job_id").notNull().references(() => ingestionJobs.id),
  rowNo: integer("row_no").notNull(),
  field: text("field"),
  code: text("code").notNull(),
  message: text("message").notNull(),
  raw: jsonb("raw")
});

// Staging tables
export const stgProducts = pgTable("stg_products", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: uuid("job_id").notNull(),
  vendorId: uuid("vendor_id").notNull(),
  externalId: text("external_id"),
  name: text("name"),
  brand: text("brand"),
  description: text("description"),
  categoryId: text("category_id"),
  price: text("price"),
  currency: text("currency"),
  barcode: text("barcode"),
  gtinType: text("gtin_type"),
  ingredients: text("ingredients"),
  nutrition: text("nutrition"),
  servingSize: text("serving_size"),
  packageWeight: text("package_weight"),
  dietaryTags: text("dietary_tags"),
  allergens: text("allergens"),
  certifications: text("certifications"),
  regulatoryCodes: text("regulatory_codes"),
  sourceUrl: text("source_url"),
  rawData: jsonb("raw_data")
});

export const stgCustomers = pgTable("stg_customers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: uuid("job_id").notNull(),
  vendorId: uuid("vendor_id").notNull(),
  externalId: text("external_id"),
  fullName: text("full_name"),
  email: text("email"),
  dob: text("dob"),
  age: text("age"),
  gender: text("gender"),
  location: text("location"),
  phone: text("phone"),
  customTags: text("custom_tags"),
  rawData: jsonb("raw_data")
});

export const stgVendorRaw = pgTable("stg_vendor_raw", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  source: text("source").notNull(),
  pageId: text("page_id"),
  payload: jsonb("payload").notNull(),
  fetchedAt: timestamp("fetched_at").notNull().default(sql`now()`)
});

// Connector tables
export const connectors = pgTable("connectors", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  source: text("source").notNull(),
  baseUrl: text("base_url").notNull(),
  authType: authTypeEnum("auth_type").notNull(),
  rateLimitRpm: integer("rate_limit_rpm").notNull().default(60),
  secretsRef: text("secrets_ref"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`)
});

export const connectorCursors = pgTable("connector_cursors", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  source: text("source").notNull(),
  cursor: text("cursor"),
  syncedAt: timestamp("synced_at"),
  status: text("status").notNull().default('pending')
});

// Cache tables
export const matchesCache = pgTable("matches_cache", {
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  catalogVersion: integer("catalog_version").notNull(),
  results: jsonb("results").notNull(),
  ttlAt: timestamp("ttl_at").notNull()
}, (table) => ({
  pk: primaryKey({ columns: [table.vendorId, table.customerId, table.catalogVersion] })
}));

// Policy tables
export const dietRules = pgTable("diet_rules", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  conditionCode: text("condition_code").notNull(),
  policy: jsonb("policy").notNull(),
  active: boolean("active").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`)
});

export const scoringPolicies = pgTable("scoring_policies", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  weights: jsonb("weights").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`)
});

// Webhook tables
export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  url: text("url").notNull(),
  secretRef: text("secret_ref"),
  enabled: boolean("enabled").notNull().default(true),
  description: text("description"),
  retriesMax: integer("retries_max").notNull().default(3),
  toleranceSec: integer("tolerance_sec").notNull().default(300),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`)
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  endpointId: uuid("endpoint_id").notNull().references(() => webhookEndpoints.id),
  eventType: webhookEventEnum("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  status: deliveryStatusEnum("status").notNull().default('pending'),
  attempt: integer("attempt").notNull().default(1),
  lastError: text("last_error"),
  signature: text("signature"),
  timestamp: timestamp("timestamp").notNull().default(sql`now()`)
});

// Idempotency table
export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  method: text("method").notNull(),
  path: text("path").notNull(),
  requestHash: text("request_hash").notNull(),
  responseHash: text("response_hash"),
  status: text("status").notNull().default('processing'),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  expiresAt: timestamp("expires_at").notNull()
});

// Audit table
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  actorUserId: uuid("actor_user_id"),
  actorRole: text("actor_role"),
  vendorId: uuid("vendor_id").references(() => vendors.id),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  ip: text("ip"),
  ua: text("ua"),
  justification: text("justification"),
  timestamp: timestamp("timestamp").notNull().default(sql`now()`)
}, (table) => ({
  timestampIdx: index("audit_log_timestamp_idx").on(table.timestamp),
  vendorIdx: index("audit_log_vendor_idx").on(table.vendorId),
  entityIdx: index("audit_log_entity_idx").on(table.entity, table.entityId)
}));

// Insert schemas
export const insertVendorSchema = createInsertSchema(vendors).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserLinkSchema = createInsertSchema(userLinks).omit({ id: true, createdAt: true, updatedAt: true });
export const insertProductSchema = createInsertSchema(products).omit({ id: true, createdAt: true, updatedAt: true, searchTsv: true });
export const insertCustomerSchema = createInsertSchema(customers).omit({ id: true, createdAt: true, updatedAt: true, searchTsv: true });
export const insertCustomerHealthProfileSchema = createInsertSchema(customerHealthProfiles).omit({ bmi: true, bmr: true, tdeeCached: true, derivedLimits: true, createdAt: true, updatedAt: true });
export const insertIngestionJobSchema = createInsertSchema(ingestionJobs).omit({ id: true, createdAt: true });
export const insertWebhookEndpointSchema = createInsertSchema(webhookEndpoints).omit({ id: true, createdAt: true, updatedAt: true });
export const insertAuditLogSchema = createInsertSchema(auditLog).omit({ id: true, timestamp: true });

// Select types
export type Vendor = typeof vendors.$inferSelect;
export type User = typeof users.$inferSelect;
export type UserLink = typeof userLinks.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type CustomerHealthProfile = typeof customerHealthProfiles.$inferSelect;
export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;

// Insert types
export type InsertVendor = z.infer<typeof insertVendorSchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertUserLink = z.infer<typeof insertUserLinkSchema>;
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type InsertCustomerHealthProfile = z.infer<typeof insertCustomerHealthProfileSchema>;
export type InsertIngestionJob = z.infer<typeof insertIngestionJobSchema>;
export type InsertWebhookEndpoint = z.infer<typeof insertWebhookEndpointSchema>;
export type InsertAuditLogEntry = z.infer<typeof insertAuditLogSchema>;

// API types
export interface PaginationParams {
  cursor?: string;
  limit?: number;
}

export interface SearchFilters {
  q?: string;
  brand?: string;
  categoryId?: string;
  tags?: string[];
  allergens?: string[];
  updatedAfter?: string;
  sort?: 'relevance' | '-updated_at' | 'name';
}

export interface MatchingParams {
  customerId: string;
  k?: number;
  filters?: SearchFilters;
}

export interface HealthMetrics {
  bmi: number;
  bmr: number;
  tdee: number;
  derivedLimits: Record<string, any>;
}

export interface JobProgress {
  processed: number;
  total: number;
  errors: number;
  warnings: number;
}

export interface SystemMetrics {
  searchP95: number;
  matchesP95: number;
  dailyJobs: number;
  availability: number;
  activeJobs: number;
  lastUpdated: string;
}

export interface DatabaseHealth {
  primary: {
    cpu: number;
    memory: number;
    connections: number;
    maxConnections: number;
  };
  replicas: Array<{
    id: string;
    status: string;
    lag: number;
  }>;
  partitions: {
    products: number;
    customers: number;
    vendors: number;
  };
}
