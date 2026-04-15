// ─── Bulk Email Sender (Resend) ───────────────────────────────────────────────
// Victor's spec: batches of 100, 3 retries with exponential backoff.
// BullMQ replaces this when volume exceeds ~10K/day.
// ─────────────────────────────────────────────────────────────────────────────

import { Resend } from "resend";
import { logger } from "../../lib/logger.js";

const BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 300;

let resend: Resend | null = null;
if (process.env.RESEND_API_KEY) {
  resend = new Resend(process.env.RESEND_API_KEY);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendBatch(
  emails: string[],
  subject: string,
  html: string,
  fromEmail: string,
  attempt = 0,
): Promise<void> {
  if (!resend) throw new Error("Resend client not initialised");
  try {
    const messages = emails.map((to) => ({ from: fromEmail, to, subject, html }));
    const { error } = await resend.batch.send(messages);
    if (error) throw new Error(error.message);
  } catch (err: any) {
    if (attempt < MAX_RETRIES) {
      const delay = BASE_BACKOFF_MS * Math.pow(2, attempt); // 300 → 600 → 1200 ms
      logger.warn(`[bulk-sender] Batch failed (attempt ${attempt + 1}), retrying in ${delay}ms… ${err?.message}`);
      await sleep(delay);
      return sendBatch(emails, subject, html, fromEmail, attempt + 1);
    }
    throw err;
  }
}

export interface BulkSendResult {
  sent: number;
  skipped: boolean;
}

/**
 * Send an email to all recipients in batches of 100.
 * Silently skips (returns skipped:true) when RESEND_API_KEY is not configured.
 */
export async function sendBulkEmail(
  recipients: string[],
  subject: string,
  html: string,
): Promise<BulkSendResult> {
  if (!resend) {
    logger.warn("[bulk-sender] RESEND_API_KEY not set — skipping send");
    return { sent: 0, skipped: true };
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL ?? "info@nutriintel.ai";

  let totalSent = 0;
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    await sendBatch(batch, subject, html, fromEmail);
    totalSent += batch.length;
    logger.info(`[bulk-sender] Sent batch ${Math.floor(i / BATCH_SIZE) + 1} (${totalSent}/${recipients.length})`);
  }

  return { sent: totalSent, skipped: false };
}
