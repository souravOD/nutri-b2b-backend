/**
 * Ingest Routes
 * -------------
 * Express router for the B2B data ingestion API.
 *
 * Endpoints:
 *   POST /api/v1/ingest/products          – Batch product ingestion
 *   POST /api/v1/ingest/customers         – Batch customer ingestion
 *   POST /api/v1/ingest/customers/health  – Batch health profile ingestion
 *   POST /api/v1/ingest/products/images   – Image URL or multipart upload
 *   POST /api/v1/ingest/csv               – Initiate CSV upload (returns TUS URL)
 *   GET  /api/v1/ingest/status/:runId     – Check ingestion run status
 *   POST /api/v1/keys                     – Create API key
 *   GET  /api/v1/keys                     – List API keys for vendor
 *   DELETE /api/v1/keys/:id               – Revoke API key
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import multer from "multer";
import { db } from "../lib/database.js";
import { sql, eq, and, desc } from "drizzle-orm";
import { ingestionJobs, orchestrationRuns, pipelineRuns } from "../../shared/schema.js";
import { universalAuth } from "../middleware/api-key-auth.js";
import {
    ingestProductsSchema,
    ingestCustomersSchema,
    ingestHealthProfilesSchema,
    ingestImagesSchema,
    csvUploadParamsSchema,
    csvCompleteSchema,
    createApiKeySchema,
} from "../lib/validators/ingest-validators.js";
import {
    computeDataHash,
    newRunId,
    resolveBronzeTable,
    landInBronze,
    triggerOrchestrator,
    maybeOverflowToStorage,
    uploadImageToStorage,
    type BronzeRecord,
} from "../services/ingest-service.js";
import { createResumableUpload, supabaseAdmin, ensureBucket } from "../lib/supabase.js";
import { storeSecret } from "../lib/supabase.js";

const router = Router();

// Image uploads — max 10 files, 10MB each
const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});

// ────────────────────────────────────────────────────────────────
// Helper
// ────────────────────────────────────────────────────────────────

function ok(res: Response, data: unknown, status = 200) {
    return res.status(status).json(data);
}

function problem(res: Response, status: number, detail: string) {
    return res.status(status).json({
        type: "about:blank",
        title: status === 400 ? "Bad Request" : status === 401 ? "Unauthorized" : "Error",
        status,
        detail,
    });
}

// ────────────────────────────────────────────────────────────────
// 1. POST /api/v1/ingest/products
// ────────────────────────────────────────────────────────────────

router.post(
    "/products",
    universalAuth(["ingest:products"]) as any,
    async (req: any, res: Response) => {
        try {
            const parsed = ingestProductsSchema.safeParse(req.body);
            if (!parsed.success) {
                return problem(res, 400, parsed.error.issues.map(i => i.message).join("; "));
            }

            const { records, source_name, idempotency_key } = parsed.data;
            const vendorId = req.auth!.vendorId;
            const runId = newRunId();

            // Check payload overflow
            await maybeOverflowToStorage(vendorId, runId, records);

            // Transform to BronzeRecords
            const bronzeRecords: BronzeRecord[] = records.map((rec, idx) => ({
                vendor_id: vendorId,
                source_name,
                source_record_id: rec.external_id || rec.source_record_id || null,
                ingestion_run_id: runId,
                raw_payload: rec as Record<string, unknown>,
                row_number: idx + 1,
                data_hash: computeDataHash(vendorId, rec as Record<string, unknown>),
                // Extract known fields if present
                image_url_original: (rec as any).image_url || null,
                nutrition_payload: (rec as any).nutrition || null,
            }));

            // Land in Bronze
            const result = await landInBronze("raw_products", bronzeRecords);

            // Trigger the orchestrator (it creates its own run row)
            const trigger = await triggerOrchestrator({
                flow_name: "bronze_to_gold",
                vendor_id: vendorId,
                source_name: source_name || "products",
            });

            return ok(res, {
                ok: true,
                run_id: trigger.run_id,
                ...result,
                ingestion_run_id: runId,
            }, 202);
        } catch (err: any) {
            console.error("[POST /ingest/products]", err);
            return problem(res, 500, err?.message || "Ingestion failed");
        }
    }
);

// ────────────────────────────────────────────────────────────────
// 2. POST /api/v1/ingest/customers
// ────────────────────────────────────────────────────────────────

router.post(
    "/customers",
    universalAuth(["ingest:customers"]) as any,
    async (req: any, res: Response) => {
        try {
            const parsed = ingestCustomersSchema.safeParse(req.body);
            if (!parsed.success) {
                return problem(res, 400, parsed.error.issues.map(i => i.message).join("; "));
            }

            const { records, source_name, idempotency_key } = parsed.data;
            const vendorId = req.auth!.vendorId;
            const runId = newRunId();

            await maybeOverflowToStorage(vendorId, runId, records);

            const bronzeRecords: BronzeRecord[] = records.map((rec, idx) => ({
                vendor_id: vendorId,
                source_name,
                source_record_id: rec.external_id || rec.source_record_id || null,
                ingestion_run_id: runId,
                raw_payload: rec as Record<string, unknown>,
                row_number: idx + 1,
                data_hash: computeDataHash(vendorId, rec as Record<string, unknown>),
                email: (rec as any).email || null,
                full_name: (rec as any).full_name || (rec as any).name || null,
                customer_type: "b2b" as const,
            }));

            const result = await landInBronze("raw_customers", bronzeRecords);

            const trigger = await triggerOrchestrator({
                flow_name: "bronze_to_gold",
                vendor_id: vendorId,
                source_name: source_name || "customers",
            });

            return ok(res, {
                ok: true,
                run_id: trigger.run_id,
                ...result,
                ingestion_run_id: runId,
            }, 202);
        } catch (err: any) {
            console.error("[POST /ingest/customers]", err);
            return problem(res, 500, err?.message || "Ingestion failed");
        }
    }
);

// ────────────────────────────────────────────────────────────────
// 3. POST /api/v1/ingest/customers/health
// ────────────────────────────────────────────────────────────────

router.post(
    "/customers/health",
    universalAuth(["ingest:customers"]) as any,
    async (req: any, res: Response) => {
        try {
            const parsed = ingestHealthProfilesSchema.safeParse(req.body);
            if (!parsed.success) {
                return problem(res, 400, parsed.error.issues.map(i => i.message).join("; "));
            }

            const { records, source_name, idempotency_key } = parsed.data;
            const vendorId = req.auth!.vendorId;
            const runId = newRunId();

            const bronzeRecords: BronzeRecord[] = records.map((rec, idx) => ({
                vendor_id: vendorId,
                source_name,
                source_record_id: rec.external_id || rec.source_record_id || null,
                ingestion_run_id: runId,
                raw_payload: rec as Record<string, unknown>,
                row_number: idx + 1,
                data_hash: computeDataHash(vendorId, rec as Record<string, unknown>),
                customer_type: "b2b" as const,
                customer_source_record_id: (rec as any).customer_external_id || null,
            }));

            const result = await landInBronze("raw_customer_health_profiles", bronzeRecords);

            const trigger = await triggerOrchestrator({
                flow_name: "bronze_to_gold",
                vendor_id: vendorId,
                source_name: source_name || "customer_health_profiles",
            });

            return ok(res, {
                ok: true,
                run_id: trigger.run_id,
                ...result,
                ingestion_run_id: runId,
            }, 202);
        } catch (err: any) {
            console.error("[POST /ingest/customers/health]", err);
            return problem(res, 500, err?.message || "Ingestion failed");
        }
    }
);

// ────────────────────────────────────────────────────────────────
// 4. POST /api/v1/ingest/products/images
//    Supports: JSON (image URLs) or multipart (file uploads)
// ────────────────────────────────────────────────────────────────

router.post(
    "/products/images",
    universalAuth(["ingest:products"]) as any,
    (req, res, next) => {
        // Auto-detect: if multipart, use multer; else pass through
        const ct = (req.headers["content-type"] || "").toLowerCase();
        if (ct.includes("multipart/form-data")) {
            return imageUpload.array("images", 10)(req, res, next);
        }
        next();
    },
    async (req: any, res: Response) => {
        try {
            const vendorId = req.auth!.vendorId;
            const runId = newRunId();
            const ct = (req.headers["content-type"] || "").toLowerCase();

            let bronzeRecords: BronzeRecord[] = [];

            if (ct.includes("multipart/form-data")) {
                // ── Multipart: file uploads ──
                const files = req.files || [];
                const metaStr = (req.body?.metadata || req.body?.records) as string;
                let metadata: Array<{ external_id: string }> = [];
                try {
                    metadata = typeof metaStr === "string" ? JSON.parse(metaStr) : (metaStr || []);
                } catch {
                    return problem(res, 400, "Invalid metadata JSON");
                }

                if (files.length === 0) {
                    return problem(res, 400, "No image files uploaded");
                }

                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    const meta = metadata[i] || { external_id: `img_${i}` };
                    const externalId = meta.external_id || `img_${i}`;

                    // Upload to Supabase Storage
                    const storageUri = await uploadImageToStorage(
                        vendorId,
                        externalId,
                        file.buffer,
                        file.mimetype
                    );

                    bronzeRecords.push({
                        vendor_id: vendorId,
                        source_name: "api_image_upload",
                        source_record_id: externalId,
                        ingestion_run_id: runId,
                        raw_payload: {
                            external_id: externalId,
                            file_name: file.originalname,
                            mime_type: file.mimetype,
                            size_bytes: file.size,
                        },
                        row_number: i + 1,
                        data_hash: computeDataHash(vendorId, {
                            external_id: externalId,
                            file_name: file.originalname,
                            size: file.size,
                        }),
                        asset_storage_uri: storageUri,
                    });
                }
            } else {
                // ── JSON: image URL references ──
                const parsed = ingestImagesSchema.safeParse(req.body);
                if (!parsed.success) {
                    return problem(res, 400, parsed.error.issues.map(i => i.message).join("; "));
                }

                bronzeRecords = parsed.data.records.map((rec, idx) => ({
                    vendor_id: vendorId,
                    source_name: parsed.data.source_name,
                    source_record_id: rec.external_id,
                    ingestion_run_id: runId,
                    raw_payload: rec as Record<string, unknown>,
                    row_number: idx + 1,
                    data_hash: computeDataHash(vendorId, rec as Record<string, unknown>),
                    image_url_original: rec.image_url || null,
                }));
            }

            const result = await landInBronze("raw_products", bronzeRecords);

            const trigger = await triggerOrchestrator({
                flow_name: "bronze_to_gold",
                vendor_id: vendorId,
                source_name: "images",
            });

            return ok(res, {
                ok: true,
                run_id: trigger.run_id,
                ...result,
                ingestion_run_id: runId,
            }, 202);
        } catch (err: any) {
            console.error("[POST /ingest/products/images]", err);
            return problem(res, 500, err?.message || "Image ingestion failed");
        }
    }
);

// ────────────────────────────────────────────────────────────────
// 5. POST /api/v1/ingest/csv
//    Returns a signed TUS upload URL for GB-scale CSV uploads
// ────────────────────────────────────────────────────────────────

router.post(
    "/csv",
    universalAuth(["ingest:products", "ingest:customers"]) as any,
    async (req: any, res: Response) => {
        try {
            const parsed = csvUploadParamsSchema.safeParse(req.body);
            if (!parsed.success) {
                return problem(res, 400, parsed.error.issues.map(i => i.message).join("; "));
            }

            const { mode, source_name } = parsed.data;
            const vendorId = req.auth!.vendorId;
            const runId = newRunId();
            const jobId = crypto.randomUUID();

            const bucket = process.env.SUPABASE_CSV_BUCKET ?? "csv-uploads";
            const storagePath = `vendors/${vendorId}/${mode}/${jobId}_${mode}.csv`;

            // Ensure the storage bucket exists (creates if missing)
            await ensureBucket(bucket);

            // Get a signed upload URL for TUS resumable upload
            const uploadData = await createResumableUpload(bucket, storagePath);

            // Return the upload URL so the client can upload via TUS.
            // The orchestrator will be triggered when the client calls POST /jobs/upload
            // after completing the TUS upload.

            return ok(res, {
                ok: true,
                ingestion_run_id: runId,
                upload: {
                    url: uploadData.signedUrl,
                    token: uploadData.token,
                    bucket,
                    path: storagePath,
                },
            }, 201);
        } catch (err: any) {
            console.error("[POST /ingest/csv]", err);
            return problem(res, 500, err?.message || "CSV upload initiation failed");
        }
    }
);

// ────────────────────────────────────────────────────────────────
// 5b. POST /api/v1/ingest/csv/complete
//     Called after the client finishes uploading CSV to Supabase Storage.
//     Triggers the full_ingestion orchestration flow.
// ────────────────────────────────────────────────────────────────

router.post(
    "/csv/complete",
    universalAuth(["ingest:products", "ingest:customers"]) as any,
    async (req: any, res: Response) => {
        try {
            const parsed = csvCompleteSchema.safeParse(req.body);
            if (!parsed.success) {
                return problem(res, 400, parsed.error.issues.map(i => i.message).join("; "));
            }

            const { run_id, bucket, path, mode } = parsed.data;
            const vendorId = req.auth!.vendorId;

            // Validate path belongs to this vendor (prevent cross-tenant ingestion)
            const expectedPrefix = `vendors/${vendorId}/`;
            if (!path.startsWith(expectedPrefix)) {
                return problem(res, 403, "Storage path does not belong to this vendor");
            }

            // Try to trigger the orchestrator — but don't fail if it's unavailable.
            // The CSV is already safely stored in Supabase Storage.
            let orchestratorRunId: string | null = null;
            let orchestratorReached = false;

            try {
                const trigger = await triggerOrchestrator({
                    flow_name: "full_ingestion",
                    vendor_id: vendorId,
                    source_name: mode,
                    storage_bucket: bucket,
                    storage_path: path,
                });
                orchestratorRunId = trigger.run_id;
                orchestratorReached = true;
            } catch (orchErr: any) {
                console.warn(
                    `[POST /ingest/csv/complete] Orchestrator unreachable, ` +
                    `recording run as pending. Error: ${orchErr?.message}`
                );

                // Create a pending orchestration run in the DB so the Jobs page
                // can display it, and the orchestrator can pick it up later.
                orchestratorRunId = run_id;
                try {
                    await db.insert(orchestrationRuns).values({
                        id: run_id,
                        vendorId,
                        flowName: "full_ingestion",
                        triggerType: "api",
                        sourceName: mode,
                        status: "pending",
                        progressPct: 0,
                        totals: {},
                        config: { storage_bucket: bucket, storage_path: path },
                    }).onConflictDoNothing();
                } catch (dbErr: any) {
                    console.error("[POST /ingest/csv/complete] DB insert failed:", dbErr?.message);
                    // Still return success — the CSV is stored
                }
            }

            return ok(res, {
                ok: true,
                run_id: orchestratorRunId,
                ingestion_run_id: run_id,
                orchestrator_reached: orchestratorReached,
            }, 202);
        } catch (err: any) {
            console.error("[POST /ingest/csv/complete]", err);
            return problem(res, 500, err?.message || "CSV completion trigger failed");
        }
    }
);

// ────────────────────────────────────────────────────────────────
// 6. GET /api/v1/ingest/runs
//    List orchestration runs for the authenticated vendor.
// ────────────────────────────────────────────────────────────────

router.get(
    "/runs",
    universalAuth() as any,
    async (req: any, res: Response) => {
        try {
            const vendorId = req.auth!.vendorId;
            const runs = await db
                .select()
                .from(orchestrationRuns)
                .where(eq(orchestrationRuns.vendorId, vendorId))
                .orderBy(desc(orchestrationRuns.createdAt))
                .limit(50);

            return ok(res, { data: runs });
        } catch (err: any) {
            console.error("[GET /ingest/runs]", err);
            return problem(res, 500, err?.message || "Failed to list runs");
        }
    }
);

// ────────────────────────────────────────────────────────────────
// 6b. GET /api/v1/ingest/runs/:id
//     Single orchestration run detail with pipeline layer breakdown.
// ────────────────────────────────────────────────────────────────

router.get(
    "/runs/:id",
    universalAuth() as any,
    async (req: any, res: Response) => {
        try {
            const vendorId = req.auth!.vendorId;
            const [run] = await db
                .select()
                .from(orchestrationRuns)
                .where(
                    and(
                        eq(orchestrationRuns.id, req.params.id),
                        eq(orchestrationRuns.vendorId, vendorId),
                    )
                )
                .limit(1);

            if (!run) {
                return problem(res, 404, "Orchestration run not found");
            }

            // Layer-level detail from pipeline_runs
            const layers = await db
                .select()
                .from(pipelineRuns)
                .where(eq(pipelineRuns.orchestrationRunId, run.id))
                .orderBy(pipelineRuns.runNumber);

            return ok(res, { data: { ...run, layers } });
        } catch (err: any) {
            console.error("[GET /ingest/runs/:id]", err);
            return problem(res, 500, err?.message || "Failed to get run detail");
        }
    }
);

// ────────────────────────────────────────────────────────────────
// 7. GET /api/v1/ingest/status/:runId
//    Returns the status of an ingestion run.
//    Tries ingestionJobs first (compat), then falls back to orchestrationRuns.
// ────────────────────────────────────────────────────────────────

router.get(
    "/status/:runId",
    universalAuth() as any,
    async (req: any, res: Response) => {
        try {
            const vendorId = req.auth!.vendorId;
            const runId = req.params.runId;

            // Try ingestion_jobs first (compat layer)
            const [job] = await db
                .select()
                .from(ingestionJobs)
                .where(
                    and(
                        eq(ingestionJobs.id, runId),
                        eq(ingestionJobs.vendorId, vendorId),
                    )
                );

            if (!job) {
                // Fallback: check orchestration_runs
                const [orchRun] = await db
                    .select()
                    .from(orchestrationRuns)
                    .where(
                        and(
                            eq(orchestrationRuns.id, runId),
                            eq(orchestrationRuns.vendorId, vendorId),
                        )
                    );
                if (orchRun) {
                    return ok(res, {
                        id: orchRun.id,
                        mode: orchRun.sourceName || orchRun.flowName,
                        status: orchRun.status,
                        progress_pct: orchRun.progressPct ?? 0,
                        totals: orchRun.totals,
                        bronze_records: orchRun.totalRecordsWritten ?? 0,
                        ingestion_run_id: orchRun.id,
                        started_at: orchRun.startedAt,
                        finished_at: orchRun.completedAt,
                        created_at: orchRun.createdAt,
                    });
                }
                return problem(res, 404, "Ingestion run not found");
            }

            // Compute counts from Bronze tables for this run
            const params = (job.params || {}) as any;
            const ingestionRunId = params.ingestion_run_id || runId;
            const mode = job.mode;
            const table = resolveBronzeTable(mode);

            let bronzeCounts = { total: 0 };
            try {
                const countResult = await db.execute(sql`
          SELECT count(*)::int as total
          FROM ${sql.raw(`bronze.${table}`)}
          WHERE ingestion_run_id = ${ingestionRunId}::uuid
        `);
                bronzeCounts = (countResult.rows as any)?.[0] || { total: 0 };
            } catch {
                // Bronze table may not have data yet
            }

            return ok(res, {
                id: job.id,
                mode: job.mode,
                status: job.status,
                progress_pct: job.progressPct,
                totals: job.totals,
                bronze_records: bronzeCounts.total,
                ingestion_run_id: ingestionRunId,
                started_at: job.startedAt,
                finished_at: job.finishedAt,
                created_at: job.createdAt,
            });
        } catch (err: any) {
            console.error("[GET /ingest/status]", err);
            return problem(res, 500, err?.message || "Status check failed");
        }
    }
);

// ────────────────────────────────────────────────────────────────
// 7. POST /api/v1/keys — Create API key
// ────────────────────────────────────────────────────────────────

router.post(
    "/keys",
    universalAuth() as any,
    async (req: any, res: Response) => {
        try {
            // Only admins can create keys
            if (req.auth!.role !== "superadmin" && req.auth!.role !== "vendor_admin") {
                return problem(res, 403, "Only admins can create API keys");
            }

            const parsed = createApiKeySchema.safeParse(req.body);
            if (!parsed.success) {
                return problem(res, 400, parsed.error.issues.map(i => i.message).join("; "));
            }

            const { label, environment, scopes, rate_limit_rpm, expires_in_days } = parsed.data;
            const vendorId = req.auth!.vendorId;

            // Generate key: nutri_live_<32 random hex chars>
            const envPrefix = environment === "test" ? "nutri_test_" : "nutri_live_";
            const randomPart = crypto.randomBytes(16).toString("hex");
            const fullKey = `${envPrefix}${randomPart}`;
            const keyPrefix = crypto.createHash("sha256").update(fullKey).digest("hex").slice(0, 16); // 64-bit lookup prefix
            const keyHash = crypto.createHash("sha256").update(fullKey).digest("hex");

            // Generate HMAC secret
            const hmacSecret = crypto.randomBytes(32).toString("hex");

            // Store HMAC secret in Vault
            let hmacSecretRef: string | null = null;
            try {
                const vaultResult = await storeSecret(
                    `api_key_hmac_${keyPrefix}`,
                    hmacSecret,
                    `HMAC secret for API key ${label} (${vendorId})`
                );
                // Extract Vault ID from result
                hmacSecretRef = (vaultResult as any)?.[0]?.id || null;
            } catch (err) {
                console.warn("[keys] Vault store failed, HMAC auth will be unavailable:", err);
            }

            // Compute expiry
            const expiresAt = expires_in_days
                ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
                : null;

            // Insert key record
            await db.execute(sql`
        INSERT INTO gold.api_keys (
          vendor_id, key_prefix, key_hash, hmac_secret_ref,
          label, environment, scopes, rate_limit_rpm,
          expires_at, created_by
        ) VALUES (
          ${vendorId}::uuid,
          ${keyPrefix},
          ${keyHash},
          ${hmacSecretRef},
          ${label},
          ${environment},
          ${scopes}::text[],
          ${rate_limit_rpm},
          ${expiresAt ? sql`${expiresAt}::timestamptz` : sql`NULL`},
          ${req.auth!.userId}::uuid
        )
      `);

            // Return key + HMAC secret (shown ONCE, never again)
            return ok(res, {
                ok: true,
                api_key: fullKey,
                hmac_secret: hmacSecret,
                key_prefix: keyPrefix,
                environment,
                scopes,
                expires_at: expiresAt,
                warning: "Store these credentials securely. The API key and HMAC secret are shown only once.",
            }, 201);
        } catch (err: any) {
            console.error("[POST /keys]", err);
            return problem(res, 500, err?.message || "Key creation failed");
        }
    }
);

// ────────────────────────────────────────────────────────────────
// 8. GET /api/v1/keys — List API keys for vendor
// ────────────────────────────────────────────────────────────────

router.get(
    "/keys",
    universalAuth() as any,
    async (req: any, res: Response) => {
        try {
            const vendorId = req.auth!.vendorId;

            const result = await db.execute(sql`
        SELECT id, key_prefix, label, environment, scopes,
               rate_limit_rpm, is_active, last_used_at,
               expires_at, created_at, revoked_at
        FROM gold.api_keys
        WHERE vendor_id = ${vendorId}::uuid
        ORDER BY created_at DESC
      `);

            return ok(res, { data: result.rows });
        } catch (err: any) {
            console.error("[GET /keys]", err);
            return problem(res, 500, err?.message || "Key listing failed");
        }
    }
);

// ────────────────────────────────────────────────────────────────
// 9. DELETE /api/v1/keys/:id — Revoke API key
// ────────────────────────────────────────────────────────────────

router.delete(
    "/keys/:id",
    universalAuth() as any,
    async (req: any, res: Response) => {
        try {
            if (req.auth!.role !== "superadmin" && req.auth!.role !== "vendor_admin") {
                return problem(res, 403, "Only admins can revoke API keys");
            }

            const vendorId = req.auth!.vendorId;
            const keyId = req.params.id;

            const result = await db.execute(sql`
        UPDATE gold.api_keys
        SET is_active = false, revoked_at = now()
        WHERE id = ${keyId}::uuid
          AND vendor_id = ${vendorId}::uuid
          AND is_active = true
        RETURNING id
      `);

            if (!result.rows?.length) {
                return problem(res, 404, "API key not found or already revoked");
            }

            return ok(res, { ok: true, revoked: keyId });
        } catch (err: any) {
            console.error("[DELETE /keys]", err);
            return problem(res, 500, err?.message || "Key revocation failed");
        }
    }
);

export default router;
