/**
 * Hourly scheduled-report cron.
 * Queries gold.b2b_scheduled_reports for active reports that are due,
 * sends an email notification, and updates last_sent_at.
 *
 * Only starts when NOTIFICATION_CRON_ENABLED=true.
 * Frequency logic:
 *   daily   → due if last_sent_at is NULL or > 23 hours ago
 *   weekly  → due if last_sent_at is NULL or > 6 days ago
 *   monthly → due if last_sent_at is NULL or > 28 days ago
 */
import cron from "node-cron";
import { db } from "./database.js";
import { sql } from "drizzle-orm";
import { sendBulkEmail } from "../services/email/bulk-sender.js";
import { renderReportEmail } from "../services/email/templates.js";
import { logger } from "./logger.js";

async function runScheduledReports() {
  logger.info("[report-cron] Checking for due scheduled reports…");
  try {
    const due = await db.execute(sql`
      SELECT
        sr.id,
        sr.vendor_id::text AS vendor_id,
        sr.frequency,
        sr.format,
        sr.email,
        sr.day_of_week,
        sr.last_sent_at,
        v.name AS vendor_name
      FROM gold.b2b_scheduled_reports sr
      LEFT JOIN gold.b2b_vendors v ON v.id = sr.vendor_id
      WHERE sr.is_active = true
        AND (
          (sr.frequency = 'daily'   AND (sr.last_sent_at IS NULL OR sr.last_sent_at < now() - INTERVAL '23 hours'))
          OR
          (sr.frequency = 'weekly'  AND (sr.last_sent_at IS NULL OR sr.last_sent_at < now() - INTERVAL '6 days'))
          OR
          (sr.frequency = 'monthly' AND (sr.last_sent_at IS NULL OR sr.last_sent_at < now() - INTERVAL '28 days'))
        )
    `);

    if (!due.rows?.length) {
      logger.info("[report-cron] No reports due.");
      return;
    }

    logger.info(`[report-cron] ${due.rows.length} report(s) due.`);

    for (const row of due.rows as any[]) {
      try {
        const html = renderReportEmail(row.frequency, row.format, row.vendor_name ?? undefined);
        const subject = `Your ${row.frequency} ${row.format.toUpperCase()} report`;

        const result = await sendBulkEmail([row.email], subject, html);

        if (!result.skipped) {
          await db.execute(sql`
            UPDATE gold.b2b_scheduled_reports
            SET last_sent_at = now()
            WHERE id = ${row.id}::uuid
          `);
          logger.info(`[report-cron] Sent report ${row.id} to ${row.email}`);
        } else {
          logger.warn(`[report-cron] Skipped report ${row.id} — SENDGRID_API_KEY not set`);
        }
      } catch (err: any) {
        logger.error(`[report-cron] Failed to send report ${row.id}: ${err?.message}`);
      }
    }

    logger.info("[report-cron] Done.");
  } catch (err: any) {
    logger.error(`[report-cron] Error: ${err?.message}`);
  }
}

export function startReportCron() {
  if (process.env.NOTIFICATION_CRON_ENABLED !== "true") {
    logger.info("[report-cron] Disabled (NOTIFICATION_CRON_ENABLED != true). Skipping.");
    return;
  }
  // Run at the top of every hour
  cron.schedule("0 * * * *", runScheduledReports, { timezone: "UTC" });
  logger.info("[report-cron] Scheduled (hourly, UTC).");
}
