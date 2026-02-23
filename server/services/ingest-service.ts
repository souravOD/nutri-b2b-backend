/**
 * Ingest Service
 * --------------
 * Core Bronze-landing logic shared by all ingestion routes.
 * Handles: format detection, data hashing, batch insert into Bronze tables,
 * orchestrator triggering (via HTTP), and Supabase Storage overflow.
 */

import crypto from "crypto";
import { db, primaryPool } from "../lib/database.js";
import { sql } from "drizzle-orm";
import { supabaseAdmin } from "../lib/supabase.js";

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface BronzeLandingResult {
    ingestion_run_id: string;
    records_received: number;
    records_landed: number;
    records_deduplicated: number;
    errors: Array<{ index: number; error: string }>;
}

export interface BronzeRecord {
    vendor_id: string;
    source_name: string;
    source_record_id?: string | null;
    ingestion_run_id: string;
    raw_payload: Record<string, unknown>;
    payload_language?: string | null;
    file_name?: string | null;
    row_number?: number | null;
    data_hash: string;
    // Product-specific
    image_url_original?: string | null;
    asset_storage_uri?: string | null;
    nutrition_payload?: Record<string, unknown> | null;
    // Customer-specific
    email?: string | null;
    full_name?: string | null;
    customer_type?: "b2c" | "b2b" | "unknown";
    // Health profile specific
    customer_source_record_id?: string | null;
}

type BronzeTable =
    | "raw_products"
    | "raw_customers"
    | "raw_customer_health_profiles"
    | "raw_ingredients"
    | "raw_recipes";

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Compute a deterministic SHA-256 hash of the payload for deduplication */
export function computeDataHash(vendorId: string, payload: Record<string, unknown>): string {
    // Deterministic: sort keys, then hash vendorId + serialised payload
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    return crypto
        .createHash("sha256")
        .update(`${vendorId}:${canonical}`)
        .digest("hex");
}

/** Generate a new ingestion run ID */
export function newRunId(): string {
    return crypto.randomUUID();
}

/**
 * Map the mode string from the API to the Bronze table name.
 */
export function resolveBronzeTable(mode: string): BronzeTable {
    switch (mode) {
        case "products":
            return "raw_products";
        case "customers":
            return "raw_customers";
        case "customer_health_profiles":
            return "raw_customer_health_profiles";
        case "ingredients":
            return "raw_ingredients";
        case "recipes":
            return "raw_recipes";
        default:
            return "raw_products";
    }
}

// ────────────────────────────────────────────────────────────────
// Core Landing Logic
// ────────────────────────────────────────────────────────────────

/**
 * Land a batch of records into a Bronze table.
 *
 * Uses INSERT ... ON CONFLICT (data_hash) DO NOTHING for deduplication.
 * Returns the landing result with counts.
 */
export async function landInBronze(
    table: BronzeTable,
    records: BronzeRecord[],
): Promise<BronzeLandingResult> {
    if (!records.length) {
        return {
            ingestion_run_id: newRunId(),
            records_received: 0,
            records_landed: 0,
            records_deduplicated: 0,
            errors: [],
        };
    }

    const runId = records[0].ingestion_run_id;
    const errors: Array<{ index: number; error: string }> = [];
    let landed = 0;

    // Process in batches of 500 to avoid query size limits
    const BATCH_SIZE = 500;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);

        try {
            const result = await insertBronzeBatch(table, batch);
            landed += result;
        } catch (err: any) {
            // If batch fails, try individual inserts to isolate bad records
            for (let j = 0; j < batch.length; j++) {
                try {
                    const result = await insertBronzeBatch(table, [batch[j]]);
                    landed += result;
                } catch (recErr: any) {
                    errors.push({
                        index: i + j,
                        error: recErr?.message || "Insert failed",
                    });
                }
            }
        }
    }

    return {
        ingestion_run_id: runId,
        records_received: records.length,
        records_landed: landed,
        records_deduplicated: records.length - landed - errors.length,
        errors,
    };
}

/**
 * Insert a batch of records into the typed Bronze table.
 * Returns the number of rows actually inserted (deduped rows return 0).
 */
async function insertBronzeBatch(
    table: BronzeTable,
    records: BronzeRecord[],
): Promise<number> {
    if (!records.length) return 0;

    // Build dynamic INSERT statement based on table type
    const values = records.map((r) => {
        const base = {
            vendor_id: r.vendor_id,
            source_name: r.source_name,
            source_record_id: r.source_record_id || null,
            ingestion_run_id: r.ingestion_run_id,
            raw_payload: JSON.stringify(r.raw_payload),
            payload_language: r.payload_language || null,
            file_name: r.file_name || null,
            row_number: r.row_number ?? null,
            data_hash: r.data_hash,
        };

        if (table === "raw_products") {
            return {
                ...base,
                image_url_original: r.image_url_original || null,
                asset_storage_uri: r.asset_storage_uri || null,
                nutrition_payload: r.nutrition_payload
                    ? JSON.stringify(r.nutrition_payload)
                    : null,
            };
        }

        if (table === "raw_customers") {
            return {
                ...base,
                email: r.email || null,
                full_name: r.full_name || null,
                customer_type: r.customer_type || "b2b",
            };
        }

        if (table === "raw_customer_health_profiles") {
            return {
                ...base,
                customer_type: r.customer_type || "b2b",
                customer_source_record_id: r.customer_source_record_id || null,
            };
        }

        return base;
    });

    // Use raw SQL for efficient batch insert with ON CONFLICT
    const colNames = Object.keys(values[0]);
    const placeholders = values.map((row, rowIdx) => {
        const cols = colNames.map((col, colIdx) => {
            const paramIdx = rowIdx * colNames.length + colIdx + 1;
            // Handle JSONB columns
            if (col === "raw_payload" || col === "nutrition_payload") {
                return `$${paramIdx}::jsonb`;
            }
            if (col === "vendor_id" || col === "ingestion_run_id") {
                return `$${paramIdx}::uuid`;
            }
            if (col === "row_number") {
                return `$${paramIdx}::int`;
            }
            return `$${paramIdx}`;
        });
        return `(${cols.join(", ")})`;
    });

    const flatParams = values.flatMap((row) =>
        colNames.map((col) => (row as any)[col])
    );

    const query = `
    INSERT INTO bronze.${table} (${colNames.join(", ")})
    VALUES ${placeholders.join(",\n")}
    ON CONFLICT (data_hash) DO NOTHING
  `;

    // Use the pg Pool directly so $N placeholders are properly bound as
    // parameterized values. Previously sql.raw(query) was used which
    // bypasses Drizzle's parameterization — flatParams were NOT bound.
    const result = await primaryPool.query(query, flatParams);
    return result.rowCount ?? 0;
}

// ────────────────────────────────────────────────────────────────
// Orchestration Integration — Trigger & Poll
// ────────────────────────────────────────────────────────────────

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://localhost:8100";

export interface OrchestratorTriggerResponse {
    run_id: string;
    status: string;
    flow_name: string;
}

/**
 * Trigger the Python orchestrator via its HTTP API.
 * The orchestrator creates the orchestration_run row and returns the run_id.
 *
 * Fire-and-forget from B2B's perspective — the orchestrator runs the flow
 * asynchronously; we only need the run_id for tracking.
 */
export async function triggerOrchestrator(params: {
    flow_name: "full_ingestion" | "bronze_to_gold";
    vendor_id: string;
    source_name: string;
    storage_bucket?: string;
    storage_path?: string;
}): Promise<OrchestratorTriggerResponse> {
    const res = await fetch(`${ORCHESTRATOR_URL}/api/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Orchestrator trigger failed (${res.status}): ${body}`);
    }

    return res.json() as Promise<OrchestratorTriggerResponse>;
}

/**
 * Poll the orchestrator for run status.
 * Returns null if the run is not found (404).
 */
export async function getOrchestrationRunStatus(runId: string): Promise<any | null> {
    const res = await fetch(`${ORCHESTRATOR_URL}/api/runs/${runId}`);
    if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`Orchestrator status check failed (${res.status})`);
    }
    return res.json();
}

// ────────────────────────────────────────────────────────────────
// Storage Overflow
// ────────────────────────────────────────────────────────────────

const OVERFLOW_BUCKET = process.env.SUPABASE_CSV_BUCKET ?? "ingestion";
const OVERFLOW_THRESHOLD = 1 * 1024 * 1024; // 1MB

/**
 * If the raw payload exceeds the overflow threshold, upload it to
 * Supabase Storage and return the storage URI. Otherwise return null.
 */
export async function maybeOverflowToStorage(
    vendorId: string,
    runId: string,
    payload: unknown,
): Promise<string | null> {
    const serialized = JSON.stringify(payload);
    if (serialized.length < OVERFLOW_THRESHOLD) return null;

    const path = `vendors/${vendorId}/overflow/${runId}_payload.json`;
    const { error } = await supabaseAdmin.storage
        .from(OVERFLOW_BUCKET)
        .upload(path, Buffer.from(serialized), {
            contentType: "application/json",
            upsert: true,
        });

    if (error) {
        console.error("[ingest-service] overflow upload failed:", error);
        return null;
    }

    return `${OVERFLOW_BUCKET}/${path}`;
}

// ────────────────────────────────────────────────────────────────
// Image Upload Helper
// ────────────────────────────────────────────────────────────────

const IMAGE_BUCKET = process.env.SUPABASE_IMAGE_BUCKET ?? "ingestion";

/**
 * Upload an image buffer to Supabase Storage.
 * Returns the storage URI.
 */
export async function uploadImageToStorage(
    vendorId: string,
    externalId: string,
    buffer: Buffer,
    mimeType: string,
): Promise<string> {
    const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
    const filename = `${externalId.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}.${ext}`;
    const path = `vendors/${vendorId}/images/${filename}`;

    const { error } = await supabaseAdmin.storage
        .from(IMAGE_BUCKET)
        .upload(path, buffer, {
            contentType: mimeType,
            upsert: true,
        });

    if (error) {
        throw new Error(`Image upload failed: ${error.message}`);
    }

    return `${IMAGE_BUCKET}/${path}`;
}
