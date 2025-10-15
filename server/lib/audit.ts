import { db } from "./database.js";
import { auditLog } from "../../shared/schema.js";
import type { InsertAuditLogEntry, AuthContext } from "../../shared/schema.js";
import type { Request } from "express";

export async function auditAction(
  context: AuthContext,
  action: string,
  entity: string,
  entityId?: string,
  before?: any,
  after?: any,
  req?: Request
): Promise<void> {
  try {
    const auditEntry: InsertAuditLogEntry = {
      actorUserId: context.userId,
      actorRole: context.role,
      vendorId: context.vendorId,
      action,
      entity,
      entityId,
      before,
      after,
      ip: req?.ip || req?.socket?.remoteAddress,
      ua: req?.get('User-Agent')
    };

    await db.insert(auditLog).values(auditEntry);
  } catch (error) {
    // Audit logging should not fail the main operation
    console.error('Failed to create audit log:', error);
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
  await auditAction(
    context,
    action,
    'customer_health_profile',
    customerId,
    before,
    after,
    req
  );
}

export async function auditRBACChange(
  context: AuthContext,
  action: string,
  targetUserId: string,
  before?: any,
  after?: any,
  req?: Request
): Promise<void> {
  await auditAction(
    context,
    action,
    'user_links',
    targetUserId,
    before,
    after,
    req
  );
}

export async function auditBreakGlassAccess(
  context: AuthContext,
  targetEntity: string,
  targetEntityId: string,
  justification: string,
  req?: Request
): Promise<void> {
  const auditEntry: InsertAuditLogEntry = {
    actorUserId: context.userId,
    actorRole: context.role,
    vendorId: context.vendorId,
    action: 'break_glass_access',
    entity: targetEntity,
    entityId: targetEntityId,
    justification,
    ip: req?.ip || req?.socket?.remoteAddress,
    ua: req?.get('User-Agent')
  };

  await db.insert(auditLog).values(auditEntry);
}

// Middleware to automatically audit health data access
export function auditHealthMiddleware(handler: Function) {
  return async (req: Request, context: AuthContext, ...args: any[]) => {
    const customerId = req.params.customerId || req.body.customerId;
    
    // Get before state if this is an update operation
    let before: any = null;
    if (req.method === 'PUT' || req.method === 'PATCH') {
      // In a real implementation, this would fetch the current state
      before = { note: 'Previous state would be captured here' };
    }

    const result = await handler(req, context, ...args);

    // Get after state if this was a mutation
    let after: any = null;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      after = { note: 'New state would be captured here' };
    }

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
  vendorId?: string,
  entity?: string,
  entityId?: string,
  limit = 100,
  offset = 0
) {
  let query = db.select().from(auditLog);

  const conditions = [];
  if (vendorId) conditions.push(`vendor_id = '${vendorId}'`);
  if (entity) conditions.push(`entity = '${entity}'`);
  if (entityId) conditions.push(`entity_id = '${entityId}'`);

  if (conditions.length > 0) {
    query = query.where(sql`${sql.raw(conditions.join(' AND '))}`);
  }

  return await query
    .orderBy(desc(auditLog.timestamp))
    .limit(limit)
    .offset(offset);
}
