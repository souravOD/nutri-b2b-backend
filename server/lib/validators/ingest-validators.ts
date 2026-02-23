/**
 * Zod schemas for the ingestion API request envelopes.
 * These validate the outer structure; raw_payload contents are opaque JSONB.
 */

import { z } from "zod";

// ────────────────────────────────────────────────────────────────
// Shared
// ────────────────────────────────────────────────────────────────

/** A single record in a batch */
const baseRecordSchema = z.object({
    external_id: z.string().min(1, "external_id is required").optional(),
    source_record_id: z.string().optional(),
}).passthrough(); // allow any extra keys — they go into raw_payload

/** Standard ingestion envelope */
const ingestEnvelopeSchema = z.object({
    /** Source system identifier (e.g. "shopify", "csv_upload", "api") */
    source_name: z.string().min(1).default("api"),
    /** Batch of records */
    records: z.array(baseRecordSchema).min(1).max(10000),
    /** Optional: specify a specific ingestion run to append to */
    ingestion_run_id: z.string().uuid().optional(),
    /** Optional: Idempotency key sent by the caller */
    idempotency_key: z.string().optional(),
});

// ────────────────────────────────────────────────────────────────
// Products
// ────────────────────────────────────────────────────────────────

export const ingestProductsSchema = ingestEnvelopeSchema;
export type IngestProductsInput = z.infer<typeof ingestProductsSchema>;

// ────────────────────────────────────────────────────────────────
// Customers
// ────────────────────────────────────────────────────────────────

export const ingestCustomersSchema = ingestEnvelopeSchema;
export type IngestCustomersInput = z.infer<typeof ingestCustomersSchema>;

// ────────────────────────────────────────────────────────────────
// Customer Health Profiles
// ────────────────────────────────────────────────────────────────

export const ingestHealthProfilesSchema = ingestEnvelopeSchema;
export type IngestHealthProfilesInput = z.infer<typeof ingestHealthProfilesSchema>;

// ────────────────────────────────────────────────────────────────
// Product Images
// ────────────────────────────────────────────────────────────────

const imageRecordSchema = z.object({
    external_id: z.string().min(1, "external_id is required"),
    image_url: z.string().url().optional(),
});

export const ingestImagesSchema = z.object({
    source_name: z.string().min(1).default("api"),
    records: z.array(imageRecordSchema).min(1).max(500),
    idempotency_key: z.string().optional(),
});
export type IngestImagesInput = z.infer<typeof ingestImagesSchema>;

// ────────────────────────────────────────────────────────────────
// CSV Upload
// ────────────────────────────────────────────────────────────────

export const csvUploadParamsSchema = z.object({
    mode: z.enum(["products", "customers", "customer_health_profiles", "ingredients", "recipes"]),
    source_name: z.string().min(1).default("csv_upload"),
});
export type CsvUploadParams = z.infer<typeof csvUploadParamsSchema>;

export const csvCompleteSchema = z.object({
    /** The ingestion run ID returned by POST /csv */
    run_id: z.string().uuid(),
    /** Supabase Storage bucket where the CSV was uploaded */
    bucket: z.string().min(1),
    /** Path within the bucket */
    path: z.string().min(1),
    /** Import type — determines which pipeline flow sources the data */
    mode: z.enum(["products", "customers", "customer_health_profiles", "ingredients", "recipes"]),
});
export type CsvCompleteInput = z.infer<typeof csvCompleteSchema>;

// ────────────────────────────────────────────────────────────────
// API Key Management
// ────────────────────────────────────────────────────────────────

export const createApiKeySchema = z.object({
    label: z.string().min(1).max(100),
    environment: z.enum(["live", "test"]).default("live"),
    scopes: z.array(z.string()).min(1).default(["ingest:products", "ingest:customers"]),
    rate_limit_rpm: z.number().int().min(1).max(10000).default(100),
    expires_in_days: z.number().int().min(1).max(365).optional(),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export const revokeApiKeySchema = z.object({
    key_id: z.string().uuid(),
});
