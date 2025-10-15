import type { Request, Response } from "express";

export class ValidationError extends Error {
  status = 400;
  constructor(public detail: string, public errors?: { field: string; code: string; message?: string }[]) {
    super(detail);
    this.name = "ValidationError";
  }
}
export class AuthenticationError extends Error { status=401; constructor(public detail="Unauthorized"){ super(detail);} }
export class AuthorizationError extends Error { status=403; constructor(public detail="Forbidden"){ super(detail);} }
export class NotFoundError extends Error { status=404; constructor(public resource: string, public id?: string){ super(`${resource} not found`);} }
export class ConflictError extends Error { status=409; constructor(public detail="Conflict"){ super(detail);} }

export function handleError(err: any, req: Request, res: Response) {
  const send = (status: number, title: string, detail: string) =>
    res.status(status).json({ type:"about:blank", title, status, detail, instance: req.url });

  if (err instanceof ValidationError) return send(400, "Bad Request", err.detail);
  if (err instanceof AuthenticationError) return send(401, "Unauthorized", err.detail);
  if (err instanceof AuthorizationError) return send(403, "Forbidden", err.detail);
  if (err instanceof NotFoundError) return send(404, "Not Found", err.message);
  if (err instanceof ConflictError) return send(409, "Conflict", err.detail);

  if (err?.code === "23505") return send(409, "Conflict", "Duplicate record");
  if (err?.code === "23503") return send(400, "Bad Request", "Referenced resource does not exist");

  console.error("[error]", err);
  return send(500, "Internal Server Error", "Something went wrong");
}

// Optionally used across handlers
export function validatePagination(cursor?: string, limit?: number) {
  const max = 200, def = 50;
  if (limit && (limit < 1 || limit > max)) throw new ValidationError(`Limit must be between 1 and ${max}`);
  return { cursor: cursor || undefined, limit: limit || def };
}
