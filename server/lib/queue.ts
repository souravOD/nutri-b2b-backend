import { db } from "./database.js";
import { ingestionJobs } from "../../shared/schema.js";
import { eq, sql } from "drizzle-orm";

export interface QueueJob {
  id: string;
  vendorId: string;
  mode: "products" | "customers" | "api_sync";
  params: any;
  attempt: number;
}

export class PostgresQueue {
  private running = false;
  private concurrency = 2;
  private workers: Array<Promise<void>> = [];

  /** Optional helper: push an existing job back to queued state */
  async enqueueExisting(jobId: string): Promise<void> {
    await db.execute(sql`
      UPDATE public.ingestion_jobs
      SET status = 'queued', started_at = NULL
      WHERE id = ${jobId}::uuid
    `);
  }

  /** Atomically claim one job (queued + uploaded), mark it running, and return it */
  async dequeue(): Promise<QueueJob | null> {
    // CTE pattern: claim exactly one row using SKIP LOCKED
    const result = await db.execute(sql`
      WITH one AS (
        SELECT id
        FROM public.ingestion_jobs
        WHERE status = 'queued'
          AND COALESCE(params->>'uploaded','false') = 'true'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.ingestion_jobs j
      SET status = 'running', started_at = NOW()
      FROM one
      WHERE j.id = one.id
      RETURNING j.id, j.vendor_id, j.mode, j.params, j.attempt
    `);

    if (!result.rows || result.rows.length === 0) return null;

    const row = result.rows[0] as any;
    return {
      id: row.id,
      vendorId: row.vendor_id,
      mode: row.mode,
      params: row.params,
      attempt: row.attempt ?? 1,
    };
  }

  async updateProgress(jobId: string, progressPct: number, totals?: any): Promise<void> {
    await db.update(ingestionJobs)
      .set({ progressPct, ...(totals ? { totals } : {}) })
      .where(eq(ingestionJobs.id, jobId));
  }

  async markCompleted(jobId: string, totals?: any): Promise<void> {
    await db.update(ingestionJobs)
      .set({ status: 'completed', finishedAt: sql`now()`, progressPct: 100, ...(totals ? { totals } : {}) })
      .where(eq(ingestionJobs.id, jobId));
  }

  async markFailed(jobId: string, errorMessage: string, shouldRetry = false): Promise<void> {
    if (shouldRetry) {
      await db.execute(sql`
        UPDATE public.ingestion_jobs
        SET status = 'queued',
            attempt = attempt + 1,
            started_at = NULL
        WHERE id = ${jobId}::uuid
          AND attempt < 3
      `);
    } else {
      await db.update(ingestionJobs)
        .set({
          status: 'failed',
          finishedAt: sql`now()`,
          // for now, stash the message in errorUrl; prod would store a signed URL
          errorUrl: (errorMessage || 'ingestion failed').slice(0, 500),
        })
        .where(eq(ingestionJobs.id, jobId));
    }
  }

  async start(process: (job: QueueJob) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.workers = Array.from({ length: this.concurrency }, () => this.worker(process));
    console.log(`[queue] started with ${this.concurrency} worker(s)`);
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.workers);
    this.workers = [];
    console.log("[queue] stopped");
  }

  private async worker(process: (job: QueueJob) => Promise<void>): Promise<void> {
    while (this.running) {
      try {
        const job = await this.dequeue();
        if (!job) {
          await this.sleep(1000);
          continue;
        }
        try {
          await process(job);
          // processIngestionJob updates job status itself (completed/failed)
        } catch (err: any) {
          console.error(`[queue] job ${job.id} error:`, err?.message || err);
          await this.markFailed(job.id, err?.message || String(err), job.attempt < 3);
        }
      } catch (loopErr) {
        console.error("[queue] worker loop error:", loopErr);
        await this.sleep(2000);
      }
    }
  }

  private sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }
}

export const queue = new PostgresQueue();
