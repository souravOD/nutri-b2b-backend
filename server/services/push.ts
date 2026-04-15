// ─── Push Notification Service ────────────────────────────────────────────────
// Sends FCM push notifications via Firebase Admin SDK.
// Supports bulk segment-based sends and single-user sends.
// Stale tokens are automatically pruned after each send.
// ─────────────────────────────────────────────────────────────────────────────

import * as admin from "firebase-admin";
import { db } from "../lib/database.js";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";

let firebaseApp: admin.app.App | null = null;

function getFirebaseApp(): admin.app.App | null {
  if (firebaseApp) return firebaseApp;

  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    logger.warn("[push] Firebase credentials not set — push notifications disabled");
    return null;
  }

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
  logger.info("[push] Firebase Admin SDK initialized");
  return firebaseApp;
}

export interface PushPayload {
  title:          string;
  body:           string;
  data?:          Record<string, string>;
  vendorId:       string;
  targetSegment?: "all" | "active" | "with_profile" | "inactive";
}

export interface PushResult {
  sent:    number;
  skipped: number;
  errors:  number;
}

/**
 * Send a push notification to all registered devices for a vendor segment.
 */
export async function sendPush(payload: PushPayload): Promise<PushResult> {
  const app = getFirebaseApp();
  if (!app) return { sent: 0, skipped: 0, errors: 0 };

  const tokens = await db.execute(sql`
    SELECT pt.device_token
    FROM   gold.b2b_push_tokens pt
    JOIN   gold.b2b_customers   c  ON c.id = pt.customer_id
    WHERE  c.vendor_id = ${payload.vendorId}::uuid
      ${sql.raw(recipientFilterSQL(payload.targetSegment ?? "all"))}
    AND    pt.device_token IS NOT NULL
  `);

  if (!tokens.rows?.length) return { sent: 0, skipped: 0, errors: 0 };

  const deviceTokens: string[] = tokens.rows.map((r: any) => r.device_token);
  const BATCH_SIZE = 500;
  let sent = 0;
  let errors = 0;
  const staleTokens: string[] = [];

  for (let i = 0; i < deviceTokens.length; i += BATCH_SIZE) {
    const batch = deviceTokens.slice(i, i + BATCH_SIZE);
    try {
      const response = await admin.messaging(app).sendEachForMulticast({
        tokens:       batch,
        notification: { title: payload.title, body: payload.body },
        data:         payload.data ?? {},
      });

      sent   += response.successCount;
      errors += response.failureCount;

      response.responses.forEach((resp, idx) => {
        if (!resp.success && resp.error) {
          const code = resp.error.code ?? "";
          if (
            code === "messaging/invalid-registration-token" ||
            code === "messaging/registration-token-not-registered"
          ) {
            staleTokens.push(batch[idx]);
          }
        }
      });
    } catch (err: any) {
      logger.error(`[push] Batch send failed: ${err.message}`);
      errors += batch.length;
    }
  }

  // Prune stale tokens
  if (staleTokens.length) {
    await db.execute(sql`
      DELETE FROM gold.b2b_push_tokens
      WHERE device_token = ANY(${staleTokens})
    `);
    logger.info(`[push] Cleaned up ${staleTokens.length} invalid token(s)`);
  }

  logger.info(`[push] Sent ${sent}, errors ${errors}, cleaned ${staleTokens.length}`);
  return { sent, errors, skipped: staleTokens.length };
}

/**
 * Send a push notification to a single user's registered devices.
 */
export async function sendPushToUser(
  customerId: string,
  vendorId:   string,
  title:      string,
  body:       string,
  data?:      Record<string, string>,
): Promise<boolean> {
  const app = getFirebaseApp();
  if (!app) return false;

  const tokens = await db.execute(sql`
    SELECT device_token
    FROM   gold.b2b_push_tokens
    WHERE  customer_id  = ${customerId}::uuid
      AND  vendor_id    = ${vendorId}::uuid
  `);

  if (!tokens.rows?.length) return false;

  try {
    await admin.messaging(app).sendEachForMulticast({
      tokens:       tokens.rows.map((r: any) => r.device_token),
      notification: { title, body },
      data:         data ?? {},
    });
    return true;
  } catch (err: any) {
    logger.error(`[push] Single-user send failed: ${err.message}`);
    return false;
  }
}

function recipientFilterSQL(segment: string): string {
  switch (segment) {
    case "active":
      return "AND c.status = 'active'";
    case "with_profile":
      return "AND c.status = 'active' AND EXISTS (SELECT 1 FROM gold.b2b_customer_health_profiles hp WHERE hp.customer_id = c.id)";
    case "inactive":
      return "AND c.status = 'inactive'";
    default: // "all"
      return "AND c.status = 'active'";
  }
}
