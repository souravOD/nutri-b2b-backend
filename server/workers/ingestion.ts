import { db } from '../lib/database.js';
import { storage } from '../storage.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { emitWebhookEvent } from '../lib/webhooks.js';
import { stgProducts, stgCustomers, products, customers } from '../../shared/schema.js';
import { eq, sql } from 'drizzle-orm';
import type { QueueJob } from '../lib/queue.js';
import csvParser from 'csv-parser';
import { Readable } from 'stream';


const CSV_BUCKET = process.env.SUPABASE_CSV_BUCKET ?? "csv-uploads";

export interface IngestionResult {
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{
    row: number;
    field?: string;
    code: string;
    message: string;
    raw?: any;
  }>;
}

export async function processIngestionJob(job: QueueJob): Promise<IngestionResult> {
  const { vendorId, mode, params } = job;
  const jobId = job.id;

  console.log(`Starting ${mode} ingestion job ${jobId} for vendor ${vendorId}`);

  try {
    // Use the exact path & bucket that the API layered in during /jobs and /jobs/:id/upload.
    const bucket = params?.bucket || CSV_BUCKET;             // <= use params.bucket if present
    const filePath = params?.path 
      || `vendors/${vendorId}/jobs/${jobId}/data.csv`;       // <= default to your upload path

    const { data: fileData, error } = await supabaseAdmin.storage
      .from(bucket)
      .download(filePath);

    if (error) {
      throw new Error(`Failed to download file: ${error?.message ?? "unknown error"}`)
    }

    const fileBuffer = await fileData.arrayBuffer();
    const fileContent = Buffer.from(fileBuffer).toString('utf-8');

    let result: IngestionResult;

    if (mode === 'products') {
      result = await processProductsCSV(jobId, vendorId, fileContent);
    } else if (mode === 'customers') {
      result = await processCustomersCSV(jobId, vendorId, fileContent);
    } else {
      throw new Error(`Unsupported ingestion mode: ${mode}`);
    }

    // Generate errors CSV if there are errors
    if (result.errors.length > 0) {
      await generateErrorsCSV(jobId, result.errors);
    }

    // Update job completion
    await storage.updateIngestionJob(jobId, {
      status: 'completed',
      finishedAt: new Date(),
      progressPct: 100,
      totals: {
        processed: result.processed,
        succeeded: result.succeeded,
        failed: result.failed
      }
    });

    // Emit webhook
    await emitWebhookEvent(vendorId, 'job.completed', {
      jobId,
      mode,
      result
    });

    console.log(`Completed ingestion job ${jobId}: ${result.succeeded}/${result.processed} rows succeeded`);
    return result;

  } catch (error) {
    console.error(`Ingestion job ${jobId} failed:`, error);

    await storage.updateIngestionJob(jobId, {
      status: 'failed',
      finishedAt: new Date(),
      errorUrl: `Failed: ${(error as Error).message}`
    });

    // Emit failure webhook
    await emitWebhookEvent(vendorId, 'job.failed', {
      jobId,
      mode,
      error: (error as Error).message
    });

    throw error;
  }
}

async function processProductsCSV(
  jobId: string,
  vendorId: string,
  csvContent: string
): Promise<IngestionResult> {
  const errors: IngestionResult['errors'] = [];
  let processed = 0;
  let succeeded = 0;

  // Parse CSV and load into staging table using COPY
  const stagingData: any[] = [];
  
  return new Promise((resolve, reject) => {
    const parser = csvParser({
      skipEmptyLines: true,
      skipLinesWithError: false
    });

    let rowNumber = 0;

    parser.on('data', (row) => {
      rowNumber++;
      processed++;

      try {
        // Basic validation and transformation
        const stagingRow = {
          jobId,
          vendorId,
          externalId: row.external_id || row.id,
          name: row.name,
          brand: row.brand,
          description: row.description,
          categoryId: row.category_id,
          price: row.price,
          currency: row.currency || 'USD',
          barcode: row.barcode,
          gtinType: row.gtin_type,
          ingredients: row.ingredients,
          nutrition: row.nutrition ? JSON.stringify(row.nutrition) : null,
          servingSize: row.serving_size,
          packageWeight: row.package_weight,
          dietaryTags: row.dietary_tags,
          allergens: row.allergens,
          certifications: row.certifications,
          regulatoryCodes: row.regulatory_codes,
          sourceUrl: row.source_url,
          rawData: row
        };

        // Validate required fields
        if (!stagingRow.externalId) {
          errors.push({
            row: rowNumber,
            field: 'external_id',
            code: 'required',
            message: 'External ID is required',
            raw: row
          });
          return;
        }

        if (!stagingRow.name) {
          errors.push({
            row: rowNumber,
            field: 'name',
            code: 'required',
            message: 'Product name is required',
            raw: row
          });
          return;
        }

        stagingData.push(stagingRow);
      } catch (error) {
        errors.push({
          row: rowNumber,
          code: 'parse_error',
          message: `Failed to parse row: ${(error as Error).message}`,
          raw: row
        });
      }
    });

    parser.on('end', async () => {
      try {
        // Bulk insert into staging table
        if (stagingData.length > 0) {
          await db.insert(stgProducts).values(stagingData);
        }

        // Validate and merge to live table in batches
        const batchSize = 100000; // 100k rows per batch
        let offset = 0;

        while (offset < stagingData.length) {
          const batch = stagingData.slice(offset, offset + batchSize);
          
          // Use UPSERT with ON CONFLICT
          await db.execute(sql`
            INSERT INTO products (
              vendor_id, external_id, name, brand, description,
              category_id, price, currency, status
            )
            SELECT
              vendor_id,
              external_id,
              name,
              brand,
              description,
              /* Safely cast category_id: allow blank/quoted -> NULL; only cast valid UUIDs */
              CASE
                WHEN NULLIF(trim(both '"' from category_id), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN (NULLIF(trim(both '"' from category_id), ''))::uuid
                ELSE NULL
              END AS category_id,
              /* Safely cast price: allow blank/quoted -> NULL; only cast numeric */
              CASE
                WHEN NULLIF(trim(both '"' from price), '') ~* '^-?\d+(\.\d+)?$'
                  THEN (NULLIF(trim(both '"' from price), ''))::numeric
                ELSE NULL
              END AS price,
              /* Normalize currency; default to 'USD' if blank */
              COALESCE(NULLIF(trim(both '"' from currency), ''), 'USD') AS currency,
              'active' AS status
            FROM stg_products
            WHERE job_id = ${jobId}
              AND external_id IS NOT NULL
              AND name IS NOT NULL
            LIMIT ${batchSize} OFFSET ${offset}
            ON CONFLICT (vendor_id, external_id)
            DO UPDATE SET
              name = EXCLUDED.name,
              brand = EXCLUDED.brand,
              description = EXCLUDED.description,
              price = EXCLUDED.price,
              updated_at = now()
          `);

          succeeded += batch.length;
          offset += batchSize;

          // Update progress
          const progressPct = Math.floor((offset / stagingData.length) * 100);
          await storage.updateIngestionJob(jobId, { progressPct });
        }

        // Analyze affected partitions for performance
        await db.execute(sql`ANALYZE products`);

        // Cleanup staging data
        await db.delete(stgProducts).where(eq(stgProducts.jobId, jobId));

        resolve({
          processed,
          succeeded,
          failed: processed - succeeded,
          errors
        });
      } catch (error) {
        reject(error);
      }
    });

    parser.on('error', (error) => {
      reject(error);
    });

    // Parse the CSV
    const stream = Readable.from(csvContent);
    stream.pipe(parser);
  });
}

async function processCustomersCSV(
  jobId: string,
  vendorId: string,
  csvContent: string
): Promise<IngestionResult> {
  const errors: IngestionResult['errors'] = [];
  let processed = 0;
  let succeeded = 0;

  // Similar implementation to products but for customers
  const stagingData: any[] = [];
  
  return new Promise((resolve, reject) => {
    const parser = csvParser({
      skipEmptyLines: true,
      skipLinesWithError: false
    });

    let rowNumber = 0;

    parser.on('data', (row) => {
      rowNumber++;
      processed++;

      try {
        const stagingRow = {
          jobId,
          vendorId,
          externalId: row.external_id || row.id,
          fullName: row.full_name || row.name,
          email: row.email,
          dob: row.dob || row.date_of_birth,
          age: row.age,
          gender: row.gender,
          location: row.location ? JSON.stringify(row.location) : null,
          phone: row.phone,
          customTags: row.custom_tags,
          rawData: row
        };

        // Validate required fields
        if (!stagingRow.externalId) {
          errors.push({
            row: rowNumber,
            field: 'external_id',
            code: 'required',
            message: 'External ID is required',
            raw: row
          });
          return;
        }

        if (!stagingRow.fullName) {
          errors.push({
            row: rowNumber,
            field: 'full_name',
            code: 'required',
            message: 'Customer name is required',
            raw: row
          });
          return;
        }

        if (!stagingRow.email) {
          errors.push({
            row: rowNumber,
            field: 'email',
            code: 'required',
            message: 'Email is required',
            raw: row
          });
          return;
        }

        stagingData.push(stagingRow);
      } catch (error) {
        errors.push({
          row: rowNumber,
          code: 'parse_error',
          message: `Failed to parse row: ${(error as Error).message}`,
          raw: row
        });
      }
    });

    parser.on('end', async () => {
      try {
        // Bulk insert into staging table
        if (stagingData.length > 0) {
          await db.insert(stgCustomers).values(stagingData);
        }

        // Merge to live table
        await db.execute(sql`
          INSERT INTO customers (
            vendor_id, external_id, full_name, email,
            dob, age, gender, location, phone
          )
          SELECT
            vendor_id,
            external_id,
            full_name,
            email,
            /* Safe casts for optional typed fields */
            CASE
              WHEN NULLIF(trim(both '"' from dob), '') IS NOT NULL
                THEN (NULLIF(trim(both '"' from dob), ''))::date
              ELSE NULL
            END AS dob,
            CASE
              WHEN NULLIF(trim(both '"' from age), '') ~* '^-?\d+$'
                THEN (NULLIF(trim(both '"' from age), ''))::integer
              ELSE NULL
            END AS age,
            /* Map 'unknown' -> 'unspecified' to match enum; blank -> NULL */
            CASE lower(NULLIF(trim(both '"' from gender), ''))
              WHEN 'male' THEN 'male'::customer_gender
              WHEN 'female' THEN 'female'::customer_gender
              WHEN 'other' THEN 'other'::customer_gender
              WHEN 'unknown' THEN 'unspecified'::customer_gender
              WHEN 'unspecified' THEN 'unspecified'::customer_gender
              ELSE NULL
            END AS gender,
            /* Location: only cast if looks like JSON (starts with { or [) */
            CASE
              WHEN NULLIF(trim(both ' ' from location), '') IS NOT NULL AND left(ltrim(location), 1) IN ('{','[')
                THEN (location)::jsonb
              ELSE NULL
            END AS location,
            phone
          FROM stg_customers
          WHERE job_id = ${jobId}
            AND external_id IS NOT NULL
            AND full_name IS NOT NULL
            AND email IS NOT NULL
          ON CONFLICT (vendor_id, external_id)
          DO UPDATE SET
            full_name = EXCLUDED.full_name,
            email = EXCLUDED.email,
            updated_at = now()
        `);

        succeeded = stagingData.length;

        // Analyze affected partitions
        await db.execute(sql`ANALYZE customers`);

        // Cleanup staging data
        await db.delete(stgCustomers).where(eq(stgCustomers.jobId, jobId));

        resolve({
          processed,
          succeeded,
          failed: processed - succeeded,
          errors
        });
      } catch (error) {
        reject(error);
      }
    });

    parser.on('error', (error) => {
      reject(error);
    });

    // Parse the CSV
    const stream = Readable.from(csvContent);
    stream.pipe(parser);
  });
}

async function generateErrorsCSV(
  jobId: string,
  errors: IngestionResult['errors']
): Promise<void> {
  try {
    // Generate CSV content
    const headers = ['row', 'field', 'code', 'message', 'raw_data'];
    const csvRows = [headers.join(',')];

    for (const error of errors) {
      const row = [
        error.row,
        error.field || '',
        error.code,
        `"${error.message.replace(/"/g, '""')}"`,
        `"${JSON.stringify(error.raw || {}).replace(/"/g, '""')}"`
      ];
      csvRows.push(row.join(','));
    }

    const csvContent = csvRows.join('\n');

    // Upload errors CSV to Supabase Storage
    const errorFilePath = `${jobId}/errors.csv`;
    const { error } = await supabaseAdmin.storage
      .from(CSV_BUCKET)
      .upload(errorFilePath, csvContent, {
        contentType: 'text/csv',
        upsert: true
      });

    if (error) {
      console.error(`Failed to upload errors CSV: ${error.message}`);
    } else {
      console.log(`Uploaded errors CSV for job ${jobId}`);
    }
  } catch (error) {
    console.error('Failed to generate errors CSV:', error);
  }
}
