/**
 * Nightly membership expiry revocation cron.
 * Runs at 01:00 UTC every day.
 * Marks b2b_user_links as 'revoked' where membership_expires_at has passed
 * (accounting for optional grace period in system_settings).
 */
import cron from "node-cron";
import { db } from "./database.js";
import { sql } from "drizzle-orm";
import { emitWebhookEvent } from "./webhooks.js";
import { logger } from "./logger.js";

async function revokeExpiredMemberships() {
    logger.info("[revocation-cron] Checking for expired memberships…");
    try {
        // Look up the max grace period across all vendors (per-vendor grace read below)
        // We process per-vendor so each vendor's grace period is respected.
        const vendorRows = await db.execute(sql`
            SELECT DISTINCT ul.vendor_id::text AS vendor_id
            FROM gold.b2b_user_links ul
            WHERE ul.status = 'active'
              AND ul.membership_expires_at IS NOT NULL
              AND ul.membership_expires_at < now()
        `);

        for (const row of vendorRows.rows as any[]) {
            const vendorId = row.vendor_id;
            // Fetch grace period setting for this vendor (default 0)
            const graceSetting = await db.execute(sql`
                SELECT value FROM gold.system_settings
                WHERE vendor_id = ${vendorId}::uuid
                  AND key = 'access_revocation_grace_days'
                LIMIT 1
            `);
            const graceDays = parseInt((graceSetting.rows?.[0] as any)?.value ?? "0", 10) || 0;

            // Revoke links where expiry + grace has passed
            const revoked = await db.execute(sql`
                UPDATE gold.b2b_user_links
                SET status = 'revoked', updated_at = now()
                WHERE vendor_id = ${vendorId}::uuid
                  AND status = 'active'
                  AND membership_expires_at IS NOT NULL
                  AND (membership_expires_at + (${graceDays} || ' days')::interval) < now()
                RETURNING user_id::text AS user_id
            `);

            for (const r of revoked.rows as any[]) {
                logger.info(`[revocation-cron] Revoked user ${r.user_id} for vendor ${vendorId}`);
                emitWebhookEvent(vendorId, "member.deprovisioned", {
                    userId: r.user_id,
                    reason: "membership_expired",
                }).catch(() => {});
            }
        }
        logger.info("[revocation-cron] Done.");
    } catch (err: any) {
        logger.error(`[revocation-cron] Error: ${err?.message}`);
    }
}

export function startRevocationCron() {
    // Run at 01:00 UTC every day
    cron.schedule("0 1 * * *", revokeExpiredMemberships, { timezone: "UTC" });
    logger.info("[revocation-cron] Scheduled (daily at 01:00 UTC).");
}
