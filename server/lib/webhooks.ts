import crypto from 'crypto';
import { db } from './database.js';
import { webhookEndpoints, webhookDeliveries } from '@shared/schema';
import { and, eq } from 'drizzle-orm';
import { getSecret } from './supabase.js';

export interface WebhookPayload {
  eventType: string;
  vendorId: string;
  eventId: string;
  occurredAt: string;
  data: any;
}

// Generate HMAC-SHA256 signature (Stripe-style)
export function signWebhookPayload(
  payload: string,
  secret: string,
  timestamp: number
): string {
  const signedPayload = `${timestamp}\n${payload}`;
  return crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');
}

// Verify webhook signature
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
  timestamp: number,
  toleranceSeconds = 300
): boolean {
  try {
    // Check timestamp tolerance
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
      return false;
    }

    // Verify signature
    const expectedSignature = signWebhookPayload(payload, secret, timestamp);
    const providedSignature = signature.replace('sha256=', '');
    
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(providedSignature, 'hex')
    );
  } catch (error) {
    return false;
  }
}

// Deliver webhook with retry logic
export async function deliverWebhook(
  endpointId: string,
  eventType: string,
  data: any
): Promise<void> {
  try {
    // Get endpoint configuration
    const endpoint = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpointId))
      .limit(1);

    if (!endpoint[0] || !endpoint[0].enabled) {
      console.log(`Webhook endpoint ${endpointId} not found or disabled`);
      return;
    }

    const config = endpoint[0];
    const timestamp = Math.floor(Date.now() / 1000);
    
    const payload: WebhookPayload = {
      eventType,
      vendorId: config.vendorId,
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      data
    };

    const payloadString = JSON.stringify(payload);
    
    // Get webhook secret from vault
    let signature = '';
    if (config.secretRef) {
      try {
        const secret = await getSecret(config.secretRef);
        signature = `sha256=${signWebhookPayload(payloadString, secret, timestamp)}`;
      } catch (error) {
        console.error(`Failed to get webhook secret: ${error}`);
      }
    }

    // Create delivery record
    const delivery = await db.insert(webhookDeliveries).values({
      endpointId,
      eventType: eventType as any,
      payload,
      signature,
      status: 'pending',
      attempt: 1
    }).returning();

    const deliveryId = delivery[0].id;

    // Attempt delivery
    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Timestamp': timestamp.toString(),
          'X-Signature': signature,
          'X-Event-Type': eventType,
          'X-Delivery-ID': deliveryId,
          'User-Agent': 'Odyssey-Webhooks/1.0'
        },
        body: payloadString,
        signal: AbortSignal.timeout(30000) // 30 second timeout
      });

      if (response.ok) {
        // Mark as delivered
        await db.update(webhookDeliveries)
          .set({ status: 'delivered' })
          .where(eq(webhookDeliveries.id, deliveryId));
        
        console.log(`Webhook delivered successfully to ${config.url}`);
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      // Mark as failed and schedule retry if needed
      const shouldRetry = delivery[0].attempt < (config.retriesMax || 3);
      
      await db.update(webhookDeliveries)
        .set({
          status: shouldRetry ? 'retry' : 'failed',
          lastError: errorMessage
        })
        .where(eq(webhookDeliveries.id, deliveryId));

      if (shouldRetry) {
        // Schedule retry with exponential backoff
        const delay = Math.pow(2, delivery[0].attempt) * 1000; // 2^attempt seconds
        setTimeout(() => retryWebhookDelivery(deliveryId), delay);
      } else {
        console.error(`Webhook delivery failed permanently: ${errorMessage}`);
      }
    }
  } catch (error) {
    console.error('Webhook delivery error:', error);
  }
}

// Retry webhook delivery
async function retryWebhookDelivery(deliveryId: string): Promise<void> {
  try {
    const delivery = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);

    if (!delivery[0] || delivery[0].status !== 'retry') {
      return;
    }

    const record = delivery[0];
    const newAttempt = record.attempt + 1;

    // Update attempt count
    await db.update(webhookDeliveries)
      .set({ 
        attempt: newAttempt,
        status: 'pending'
      })
      .where(eq(webhookDeliveries.id, deliveryId));

    // Re-deliver
    const endpoint = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, record.endpointId))
      .limit(1);

    if (endpoint[0]) {
      await deliverWebhook(
        record.endpointId,
        record.eventType,
        (record.payload as any)?.data
      );
    }
  } catch (error) {
    console.error('Webhook retry error:', error);
  }
}

// Emit webhook events
export async function emitWebhookEvent(
  vendorId: string,
  eventType: string,
  data: any
): Promise<void> {
  try {
    // Get all enabled endpoints for this vendor
    const endpoints = await db
      .select()
      .from(webhookEndpoints)
      .where(and(
        eq(webhookEndpoints.vendorId, vendorId),
        eq(webhookEndpoints.enabled, true)
      ));

    // Deliver to all endpoints
    const deliveryPromises = endpoints.map((endpoint: any) =>
      deliverWebhook(endpoint.id, eventType, data)
    );

    await Promise.allSettled(deliveryPromises);
  } catch (error) {
    console.error('Failed to emit webhook event:', error);
  }
}

// Generate idempotency key for webhooks
export function generateIdempotencyKey(): string {
  return `whk_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}
