import type { Request, Response, NextFunction } from "express";

const READ_RPM = Number(process.env.RATE_LIMITS_READ_RPM || 60);
const WRITE_RPM = Number(process.env.RATE_LIMITS_WRITE_RPM || 12);

const buckets = new Map<string, { count: number; reset: number }>();

function take(token: string, limit: number) {
  const now = Date.now();
  const bucket = buckets.get(token) || { count: 0, reset: now + 60_000 };
  if (bucket.reset < now) {
    bucket.count = 0;
    bucket.reset = now + 60_000;
  }
  bucket.count += 1;
  buckets.set(token, bucket);
  return bucket.count <= limit ? { ok: true } : { ok: false, reset: bucket.reset };
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const auth = (req as any).auth;
  if (!auth) return next(); // only throttle authenticated traffic
  const isWrite = ["POST","PUT","PATCH","DELETE"].includes(req.method);
  const limit = isWrite ? WRITE_RPM : READ_RPM;
  const key = `${auth.userId}:${isWrite ? "w" : "r"}`;
  const { ok, reset } = take(key, limit) as any;
  if (ok) return next();
  const retry = Math.max(0, Math.ceil((reset - Date.now())/1000));
  res.setHeader("Retry-After", String(retry));
  return res.status(429).json({
    type: "about:blank",
    title: "Too Many Requests",
    status: 429,
    detail: `Rate limit exceeded (${limit}/min). Try again in ${retry}s.`
  });
}
