// Deprecated shim.
// Use server/lib/auth.ts as the single source of truth.

export { requireAuth, extractJWT as extractJwt } from "../lib/auth.js";