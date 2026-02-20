import crypto from "crypto";
import type { Request } from "express";
import { and, desc, eq } from "drizzle-orm";

import { db } from "./database.js";
import { auditLog } from "../../shared/schema.js";
import type { AuthContext } from "./auth.js";

function isUuid(value?: string | null): value is string {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toGoldAction(action?: string): "INSERT" | "UPDATE" | "DELETE" {
  const a = String(action || "update").toLowerCase();
  if (a.includes("delete") || a.includes("remove")) return "DELETE";
  if (a.includes("create") || a.includes("insert") || a.includes("post")) return "INSERT";
  return "UPDATE";
}

function safeRecordId(candidate?: string | null, fallbackUserId?: string | null): string {
  if (isUuid(candidate)) return candidate;
  if (isUuid(fallbackUserId || null)) return fallbackUserId as string;
  return crypto.randomUUID();
}

function tableNameFromEntity(entity?: string | null): string {
  return String(entity || "unknown").slice(0, 100);
}

async function writeAudit(entry: {
  tableName: string;
  recordId?: string | null;
  action?: string;
  oldValues?: any;
  newValues?: any;
  changedBy?: string | null;
  req?: Request;
}) {
  const changedBy = isUuid(entry.changedBy || null) ? (entry.changedBy as string) : null;

  await db.insert(auditLog).values({
    tableName: tableNameFromEntity(entry.tableName),
    recordId: safeRecordId(entry.recordId || null, changedBy),
    action: toGoldAction(entry.action),
    oldValues: entry.oldValues ?? null,
    newValues: entry.newValues ?? null,
    changedBy,
    ipAddress: entry.req?.ip || entry.req?.socket?.remoteAddress || null,
    userAgent: entry.req?.get("User-Agent") || null,
  });
}

// Compatible with both old signatures:
// 1) auditAction(context, action, entity, entityId?, before?, after?, req?)
// 2) auditAction(req, { action, entity, entityId, before, after })
export async function auditAction(...args: any[]): Promise<void> {
  try {
    if (args[0] && typeof args[0] === "object" && "method" in args[0]) {
      const req = args[0] as Request;
      const payload = (args[1] || {}) as any;
      await writeAudit({
        tableName: payload.entity || payload.tableName || "unknown",
        recordId: payload.entityId || payload.recordId || null,
        action: payload.action,
        oldValues: payload.before || payload.oldValues,
        newValues: payload.after || payload.newValues,
        changedBy: null,
        req,
      });
      return;
    }

    const context = args[0] as AuthContext;
    const action = args[1] as string;
    const entity = args[2] as string;
    const entityId = args[3] as string | undefined;
    const before = args[4];
    const after = args[5];
    const req = args[6] as Request | undefined;

    await writeAudit({
      tableName: entity,
      recordId: entityId,
      action,
      oldValues: before,
      newValues: after,
      changedBy: context?.userId,
      req,
    });
  } catch (error) {
    // Audit logging should not fail the main operation
    console.error("Failed to create audit log:", error);
  }
}

export async function auditHealthAccess(
  context: AuthContext,
  action: string,
  customerId: string,
  before?: any,
  after?: any,
  req?: Request
): Promise<void> {
  await auditAction(context, action, "b2b_customer_health_profiles", customerId, before, after, req);
}

export async function auditRBACChange(
  context: AuthContext,
  action: string,
  targetUserId: string,
  before?: any,
  after?: any,
  req?: Request
): Promise<void> {
  await auditAction(context, action, "b2b_user_links", targetUserId, before, after, req);
}

export async function auditBreakGlassAccess(
  context: AuthContext,
  targetEntity: string,
  targetEntityId: string,
  justification: string,
  req?: Request
): Promise<void> {
  await writeAudit({
    tableName: targetEntity,
    recordId: targetEntityId,
    action: "update",
    oldValues: null,
    newValues: { break_glass: true, justification },
    changedBy: context.userId,
    req,
  });
}

export function auditHealthMiddleware(handler: Function) {
  return async (req: Request, context: AuthContext, ...args: any[]) => {
    const customerId = req.params.customerId || req.body.customerId;

    const before = req.method === "PUT" || req.method === "PATCH"
      ? { note: "Previous state should be captured by caller." }
      : null;

    const result = await handler(req, context, ...args);

    const after = req.method === "POST" || req.method === "PUT" || req.method === "PATCH"
      ? { note: "New state should be captured by caller." }
      : null;

    await auditHealthAccess(
      context,
      `${req.method.toLowerCase()}_health_profile`,
      customerId,
      before,
      after,
      req
    );

    return result;
  };
}

export async function getAuditTrail(
  _vendorId?: string,
  entity?: string,
  entityId?: string,
  limit = 100,
  offset = 0
) {
  const conditions: any[] = [];
  if (entity) conditions.push(eq(auditLog.tableName, entity));
  if (entityId && isUuid(entityId)) conditions.push(eq(auditLog.recordId, entityId));

  let query: any = db.select().from(auditLog);
  if (conditions.length) query = query.where(and(...conditions));

  return await query
    .orderBy(desc(auditLog.changedAt))
    .limit(limit)
    .offset(offset);
}
