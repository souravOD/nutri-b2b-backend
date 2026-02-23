import { sql } from "drizzle-orm";
import {
  pgSchema,
  pgTable,
  text,
  varchar,
  uuid,
  timestamp,
  numeric,
  integer,
  jsonb,
  boolean,
  index,
  uniqueIndex,
  primaryKey,
  date,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

const gold = pgSchema("gold");

// Core tables (gold)
export const vendors = gold.table("vendors", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug"),
  status: text("status").notNull().default("active"),
  catalogVersion: integer("catalog_version").notNull().default(1),
  apiEndpoint: text("api_endpoint"),
  contactEmail: text("contact_email"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),

  // Compatibility-layer columns
  settingsJson: jsonb("settings_json").default(sql`'{}'::jsonb`),
  teamId: text("team_id"),
  domains: text("domains").array().default(sql`'{}'::text[]`),
  ownerUserId: text("owner_user_id"),
  billingEmail: text("billing_email"),
}, (table) => ({
  slugUnique: uniqueIndex("vendors_slug_key").on(table.slug),
}));

export const users = gold.table("b2b_users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  appwriteUserId: text("appwrite_user_id"),
  source: text("source").notNull().default("appwrite"),
  vendorId: uuid("vendor_id").references(() => vendors.id),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
}, (table) => ({
  emailUnique: uniqueIndex("idx_b2b_users_email_lower").on(sql`lower(${table.email})`),
  appwriteUnique: uniqueIndex("idx_b2b_users_appwrite_user_id").on(table.appwriteUserId),
}));

export const userLinks = gold.table("b2b_user_links", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  role: text("role").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
}, (table) => ({
  uniqueUserVendor: uniqueIndex("idx_b2b_user_links_user_vendor").on(table.userId, table.vendorId),
  uniqueUser: uniqueIndex("idx_b2b_user_links_user_unique").on(table.userId),
}));

export const products = gold.table("products", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  brand: text("brand"),
  description: text("description"),
  categoryId: uuid("category_id"),
  price: numeric("price", { precision: 10, scale: 2 }),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),

  barcode: text("barcode"),
  gtinType: text("gtin_type"),
  servingSize: text("serving_size"),
  packageWeight: text("package_weight"),
  subCategoryId: uuid("sub_category_id"),
  cuisineId: uuid("cuisine_id"),
  marketId: uuid("market_id"),

  // Compatibility-layer fields
  nutrition: jsonb("nutrition"),
  dietaryTags: text("dietary_tags").array(),
  allergens: text("allergens").array(),
  certifications: text("certifications").array(),
  regulatoryCodes: text("regulatory_codes").array(),
  ingredients: text("ingredients").array(),
  notes: text("notes"),
  searchTsv: text("search_tsv"),
  softDeletedAt: timestamp("soft_deleted_at"),

  // Existing gold canonical url column mapped to API field name
  sourceUrl: text("product_url"),
}, (table) => ({
  uniqueVendorExternal: uniqueIndex("idx_gold_products_vendor_external_uq").on(table.vendorId, table.externalId),
}));

export const customers = gold.table("b2b_customers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  externalId: text("external_id").notNull(),
  globalCustomerId: uuid("global_customer_id"),
  email: text("email").notNull(),
  fullName: text("full_name").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  dob: date("date_of_birth"),
  age: integer("age"),
  gender: text("gender"),
  phone: text("phone"),
  locationCountry: text("location_country"),
  locationRegion: text("location_region"),
  locationCity: text("location_city"),
  locationPostalCode: text("location_postal_code"),
  accountStatus: text("account_status").notNull().default("active"),
  sourceSystem: text("source_system"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),

  // Compatibility-layer fields
  location: jsonb("location"),
  customTags: text("custom_tags").array(),
  notes: text("notes"),
  productNotes: jsonb("product_notes").default(sql`'{}'::jsonb`),
  searchTsv: text("search_tsv"),
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
}, (table) => ({
  uniqueVendorExternal: uniqueIndex("idx_b2b_customers_vendor_external").on(table.vendorId, table.externalId),
}));

export const customerHealthProfiles = gold.table("b2b_customer_health_profiles", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  customerId: uuid("b2b_customer_id").notNull().references(() => customers.id),

  heightCm: numeric("height_cm", { precision: 5, scale: 2 }),
  weightKg: numeric("weight_kg", { precision: 5, scale: 2 }),
  bmi: numeric("bmi", { precision: 5, scale: 2 }),
  bmr: numeric("bmr", { precision: 8, scale: 2 }),
  tdee: numeric("tdee", { precision: 8, scale: 2 }),
  activityLevel: text("activity_level"),

  healthGoal: text("health_goal"),
  targetWeightKg: numeric("target_weight_kg", { precision: 5, scale: 2 }),
  targetCalories: integer("target_calories"),
  targetProteinG: numeric("target_protein_g", { precision: 6, scale: 2 }),
  targetCarbsG: numeric("target_carbs_g", { precision: 6, scale: 2 }),
  targetFatG: numeric("target_fat_g", { precision: 6, scale: 2 }),
  targetFiberG: numeric("target_fiber_g", { precision: 5, scale: 2 }),
  targetSodiumMg: integer("target_sodium_mg"),
  targetSugarG: numeric("target_sugar_g", { precision: 5, scale: 2 }),

  // Compatibility-layer fields
  age: integer("age"),
  gender: text("gender"),
  conditions: text("conditions").array().default(sql`'{}'::text[]`),
  dietGoals: text("diet_goals").array().default(sql`'{}'::text[]`),
  macroTargets: jsonb("macro_targets").default(sql`'{}'::jsonb`),
  avoidAllergens: text("avoid_allergens").array().default(sql`'{}'::text[]`),
  tdeeCached: numeric("tdee_cached", { precision: 8, scale: 2 }),
  derivedLimits: jsonb("derived_limits").default(sql`'{}'::jsonb`),

  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  updatedBy: uuid("updated_by"),
}, (table) => ({
  uniqueCustomer: uniqueIndex("b2b_customer_health_profiles_b2b_customer_id_key").on(table.customerId),
}));

export const vendorMappings = gold.table("b2b_vendor_mappings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  mode: text("mode").notNull(),
  map: jsonb("map").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

// Taxonomy aliases mapped to canonical gold tables
export const taxCategories = gold.table("product_categories", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("slug"),
  label: text("name").notNull(),
  parentId: uuid("parent_category_id").references((): AnyPgColumn => taxCategories.id),
  description: text("description"),
  level: integer("level"),
  createdAt: timestamp("created_at"),
});

export const taxTags = gold.table("dietary_preferences", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull(),
  label: text("name").notNull(),
  category: text("category"),
  description: text("description"),
  createdAt: timestamp("created_at"),
});

export const taxAllergens = gold.table("allergens", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull(),
  label: text("name").notNull(),
  category: text("category"),
  description: text("description"),
  createdAt: timestamp("created_at"),
});

export const healthConditions = gold.table("health_conditions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull(),
  label: text("name").notNull(),
  category: text("category"),
  description: text("description"),
  createdAt: timestamp("created_at"),
});

export const taxCuisines = gold.table("cuisines", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull(),
  label: text("name").notNull(),
  parentId: uuid("parent_cuisine_id").references((): AnyPgColumn => taxCuisines.id),
  region: text("region"),
  country: text("country"),
  description: text("description"),
  createdAt: timestamp("created_at"),
});

export const taxCertifications = gold.table("certifications", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull(),
  label: text("name").notNull(),
  category: text("category"),
  region: text("region"),
  description: text("description"),
  createdAt: timestamp("created_at"),
});

export const auditLog = gold.table("audit_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tableName: varchar("table_name", { length: 100 }).notNull(),
  recordId: uuid("record_id").notNull(),
  action: varchar("action", { length: 20 }),
  oldValues: jsonb("old_values"),
  newValues: jsonb("new_values"),
  changedBy: uuid("changed_by"),
  changedAt: timestamp("changed_at").notNull().default(sql`now()`),
  ipAddress: varchar("ip_address", { length: 50 }),
  userAgent: text("user_agent"),
}, (table) => ({
  changedAtIdx: index("audit_log_changed_at_idx").on(table.changedAt),
  recordIdx: index("audit_log_table_record_idx").on(table.tableName, table.recordId),
}));

// API Keys (gold schema)
export const apiKeys = gold.table("api_keys", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  keyPrefix: varchar("key_prefix", { length: 20 }).notNull(),
  keyHash: text("key_hash").notNull(),
  hmacSecretRef: text("hmac_secret_ref"),
  label: varchar("label", { length: 100 }),
  environment: varchar("environment", { length: 10 }).notNull().default("live"),
  scopes: text("scopes").array().default(sql`ARRAY['ingest:products', 'ingest:customers']`),
  rateLimitRpm: integer("rate_limit_rpm").notNull().default(100),
  isActive: boolean("is_active").notNull().default(true),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  revokedAt: timestamp("revoked_at"),
});

// Bronze schema table references (for service layer)
const bronze = pgSchema("bronze");

export const rawProducts = bronze.table("raw_products", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id"),
  sourceName: text("source_name").notNull(),
  sourceRecordId: text("source_record_id"),
  ingestionRunId: uuid("ingestion_run_id").notNull(),
  rawPayload: jsonb("raw_payload").notNull(),
  nutritionPayload: jsonb("nutrition_payload"),
  assetPayload: jsonb("asset_payload"),
  payloadLanguage: text("payload_language"),
  fileName: text("file_name"),
  rowNumber: integer("row_number"),
  assetStorageUri: text("asset_storage_uri"),
  imageUrlOriginal: text("image_url_original"),
  imageEnriched: boolean("image_enriched").notNull().default(false),
  enrichedImageUrl: text("enriched_image_url"),
  arrivedAt: timestamp("arrived_at").notNull().default(sql`now()`),
  dataHash: text("data_hash"),
});

export const rawCustomers = bronze.table("raw_customers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id"),
  sourceName: text("source_name").notNull(),
  sourceRecordId: text("source_record_id"),
  ingestionRunId: uuid("ingestion_run_id").notNull(),
  customerType: text("customer_type").default("unknown"),
  email: text("email"),
  fullName: text("full_name"),
  rawPayload: jsonb("raw_payload").notNull(),
  payloadLanguage: text("payload_language"),
  fileName: text("file_name"),
  rowNumber: integer("row_number"),
  arrivedAt: timestamp("arrived_at").notNull().default(sql`now()`),
  dataHash: text("data_hash"),
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration Schema (read-only from B2B — managed by Python orchestrator)
// ─────────────────────────────────────────────────────────────────────────────
const orchestration = pgSchema("orchestration");

export const orchestrationRuns = orchestration.table("orchestration_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  flowName: varchar("flow_name", { length: 100 }).notNull(),
  flowType: varchar("flow_type", { length: 30 }).notNull().default("batch"),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  triggerType: varchar("trigger_type", { length: 30 }).notNull(),
  triggeredBy: varchar("triggered_by", { length: 255 }),
  vendorId: uuid("vendor_id"),
  sourceName: varchar("source_name", { length: 100 }),
  layers: text("layers").array(),
  currentLayer: varchar("current_layer", { length: 50 }),
  progressPct: integer("progress_pct").default(0),
  totalRecordsProcessed: integer("total_records_processed").default(0),
  totalRecordsWritten: integer("total_records_written").default(0),
  totalDqIssues: integer("total_dq_issues").default(0),
  totalErrors: integer("total_errors").default(0),
  totals: jsonb("totals").default(sql`'{}'::jsonb`),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  durationSeconds: numeric("duration_seconds", { precision: 10, scale: 2 }),
  config: jsonb("config").default(sql`'{}'::jsonb`),
  metadata: jsonb("metadata").default(sql`'{}'::jsonb`),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const pipelineRuns = orchestration.table("pipeline_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  pipelineId: uuid("pipeline_id").notNull(),
  pipelineName: varchar("pipeline_name", { length: 100 }),
  orchestrationRunId: uuid("orchestration_run_id").notNull(),
  runNumber: integer("run_number").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  triggerType: varchar("trigger_type", { length: 30 }).notNull().default("manual"),
  triggeredBy: varchar("triggered_by", { length: 255 }),
  sourceTable: varchar("source_table", { length: 100 }),
  targetTable: varchar("target_table", { length: 100 }),
  batchSize: integer("batch_size").default(100),
  incremental: boolean("incremental").default(true),
  dryRun: boolean("dry_run").default(false),
  runConfig: jsonb("run_config").default(sql`'{}'::jsonb`),
  recordsInput: integer("records_input").default(0),
  recordsProcessed: integer("records_processed").default(0),
  recordsWritten: integer("records_written").default(0),
  recordsSkipped: integer("records_skipped").default(0),
  recordsFailed: integer("records_failed").default(0),
  dqIssuesFound: integer("dq_issues_found").default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  durationSeconds: numeric("duration_seconds", { precision: 10, scale: 2 }),
  errorMessage: text("error_message"),
  errorDetails: jsonb("error_details"),
  retryCount: integer("retry_count").default(0),
  maxRetries: integer("max_retries").default(3),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const pipelineStepLogs = orchestration.table("pipeline_step_logs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  pipelineRunId: uuid("pipeline_run_id").notNull(),
  stepName: varchar("step_name", { length: 100 }).notNull(),
  stepOrder: integer("step_order").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  recordsIn: integer("records_in").default(0),
  recordsOut: integer("records_out").default(0),
  recordsError: integer("records_error").default(0),
  stateDelta: jsonb("state_delta").default(sql`'{}'::jsonb`),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),
  errorTraceback: text("error_traceback"),
});

// Orchestration types (read-only)
export type OrchestrationRun = typeof orchestrationRuns.$inferSelect;
export type PipelineRun = typeof pipelineRuns.$inferSelect;
export type PipelineStepLog = typeof pipelineStepLogs.$inferSelect;

// -----------------------------------------------------------------------------
// Disconnected/legacy operational tables (kept in public schema for compatibility)
// -----------------------------------------------------------------------------
export const ingestionJobs = pgTable("ingestion_jobs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull().default("queued"),
  progressPct: integer("progress_pct").notNull().default(0),
  totals: jsonb("totals").default(sql`'{}'::jsonb`),
  errorUrl: text("error_url"),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  attempt: integer("attempt").notNull().default(1),
  params: jsonb("params").default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const ingestionJobErrors = pgTable("ingestion_job_errors", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: uuid("job_id").notNull(),
  rowNo: integer("row_no").notNull(),
  field: text("field"),
  code: text("code").notNull(),
  message: text("message").notNull(),
  raw: jsonb("raw"),
});

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
  rawData: jsonb("raw_data"),
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
  rawData: jsonb("raw_data"),
});

export const dietRules = pgTable("diet_rules", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull(),
  conditionCode: text("condition_code").notNull(),
  policy: jsonb("policy").notNull(),
  active: boolean("active").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const matchesCache = pgTable("matches_cache", {
  vendorId: uuid("vendor_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  catalogVersion: integer("catalog_version").notNull(),
  results: jsonb("results").notNull(),
  ttlAt: timestamp("ttl_at").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.vendorId, table.customerId, table.catalogVersion] }),
}));

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: uuid("vendor_id").notNull(),
  url: text("url").notNull(),
  secretRef: text("secret_ref"),
  enabled: boolean("enabled").notNull().default(true),
  description: text("description"),
  retriesMax: integer("retries_max").notNull().default(3),
  toleranceSec: integer("tolerance_sec").notNull().default(300),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  endpointId: uuid("endpoint_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"),
  attempt: integer("attempt").notNull().default(1),
  lastError: text("last_error"),
  signature: text("signature"),
  timestamp: timestamp("timestamp").notNull().default(sql`now()`),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  vendorId: uuid("vendor_id"),
  method: text("method"),
  path: text("path"),
  requestHash: text("request_hash").notNull(),
  responseHash: text("response_hash"),
  responseStatus: integer("response_status"),
  responseBody: jsonb("response_body"),
  status: text("status").notNull().default("processing"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at"),
  expiresAt: timestamp("expires_at"),
});

// Insert schemas
export const insertVendorSchema = createInsertSchema(vendors).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserLinkSchema = createInsertSchema(userLinks).omit({ id: true, createdAt: true, updatedAt: true });
export const insertProductSchema = createInsertSchema(products).omit({ id: true, createdAt: true, updatedAt: true, searchTsv: true });
export const insertCustomerSchema = createInsertSchema(customers).omit({ id: true, createdAt: true, updatedAt: true, searchTsv: true });
export const insertCustomerHealthProfileSchema = createInsertSchema(customerHealthProfiles).omit({ id: true, createdAt: true, updatedAt: true });
export const insertIngestionJobSchema = createInsertSchema(ingestionJobs).omit({ id: true, createdAt: true });
export const insertWebhookEndpointSchema = createInsertSchema(webhookEndpoints).omit({ id: true, createdAt: true, updatedAt: true });
export const insertAuditLogSchema = createInsertSchema(auditLog).omit({ id: true, changedAt: true });

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
export type ApiKey = typeof apiKeys.$inferSelect;
export type RawProduct = typeof rawProducts.$inferSelect;
export type RawCustomer = typeof rawCustomers.$inferSelect;

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

// Shared runtime types
export interface AuthContext {
  userId: string;
  email: string;
  vendorId: string;
  role: "superadmin" | "vendor_admin" | "vendor_operator" | "vendor_viewer";
  permissions: string[];
}

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
  sort?: "relevance" | "-updated_at" | "name";
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
