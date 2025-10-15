// client/src/lib/jwt.ts
"use client";
import { account } from "@/lib/appwrite";

/**
 * Appwrite JWT cache with circuit breaker:
 *  - caches until ~90s before expiry
 *  - coalesces concurrent refreshes
 *  - shares token + cooldown across tabs (BroadcastChannel + localStorage)
 *  - when /jwts returns 429, enter COOLDOWN (default 5min) and stop hitting /jwts
 *  - API callers get `null` during cooldown (they’ll send unauthenticated requests)
 */

let token: string | null = null;
let expMs: number | null = null;
let inFlight: Promise<string | null> | null = null;

let cooldownUntil = 0; // epoch ms
const COOLDOWN_MS = 5 * 60_000; // 5 minutes. adjust if needed
const SKEW_MS = 90_000; // refresh 90s early

/* ---------------- utils ---------------- */
const now = () => Date.now();
const inCooldown = () => now() < cooldownUntil;
const isFresh = () => !!token && !!expMs && now() + SKEW_MS < (expMs as number);

function decodeExpMs(jwt: string): number | null {
  try {
    const payload = JSON.parse(
      atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))
    );
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/* ------------- cross-tab sync ------------- */
const CH = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("appwrite-jwt") : null;

function publishToken(jwt: string) {
  token = jwt;
  expMs = decodeExpMs(jwt) ?? now() + 15 * 60_000;
  try {
    localStorage.setItem("appwrite_jwt", JSON.stringify({ token: jwt, expMs }));
    CH?.postMessage({ kind: "token", token: jwt, expMs });
  } catch {}
}

function publishCooldown(untilMs: number) {
  cooldownUntil = untilMs;
  try {
    localStorage.setItem("appwrite_jwt_cooldown", String(untilMs));
    CH?.postMessage({ kind: "cooldown", until: untilMs });
  } catch {}
}

// bootstrap from storage
(function boot() {
  try {
    const raw = localStorage.getItem("appwrite_jwt");
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj?.token && obj?.expMs) {
        token = obj.token;
        expMs = obj.expMs;
      }
    }
    const cd = Number(localStorage.getItem("appwrite_jwt_cooldown") || 0);
    if (Number.isFinite(cd)) cooldownUntil = cd;
  } catch {}
})();

CH?.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data || {};
  if (msg.kind === "token" && typeof msg.token === "string" && typeof msg.expMs === "number") {
    token = msg.token; expMs = msg.expMs;
  } else if (msg.kind === "cooldown" && typeof msg.until === "number") {
    cooldownUntil = msg.until;
  }
});

/* ------------- core ------------- */

async function fetchNew(): Promise<string | null> {
  // actual call to Appwrite
  const { jwt } = await account.createJWT();
  if (!jwt) return null;
  publishToken(jwt);
  return jwt;
}

/** Convert any Appwrite SDK error into a boolean "isRateLimited" */
function is429(err: any): boolean {
  const code = (err && (err.code ?? err.status)) as number | undefined;
  if (code === 429) return true;
  const msg = String(err?.message || "");
  return /429|rate limit|too many/i.test(msg) || err?.type === "general_rate_limit_exceeded";
}

export async function getJWT(): Promise<string | null> {
  // If we have a fresh token, use it.
  if (isFresh()) return token;

  // If we're cooling down due to an earlier 429, do NOT hit /jwts.
  if (inCooldown()) return null;

  // If there is already a refresh in progress, just wait for it.
  if (inFlight) return inFlight;

  // Try to refresh (coalesced)
  inFlight = (async () => {
    try {
      return await fetchNew();
    } catch (err) {
      if (is429(err)) {
        // enter cooldown so the whole app (and all tabs) stop hammering /jwts
        publishCooldown(now() + COOLDOWN_MS);
        return null; // resolve null so callers don't throw & retry loops
      }
      // For other errors: small soft cooldown (30s) to avoid flapping
      publishCooldown(now() + 30_000);
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export async function refreshJWT(): Promise<string | null> {
  // Force a refresh unless we’re cooling down
  if (inCooldown()) return null;
  token = null; expMs = null;
  return getJWT();
}

export function clearJWT() {
  token = null; expMs = null; inFlight = null; cooldownUntil = 0;
  try {
    localStorage.removeItem("appwrite_jwt");
    localStorage.removeItem("appwrite_jwt_cooldown");
  } catch {}
  CH?.postMessage({ kind: "token", token: null, expMs: null });
  CH?.postMessage({ kind: "cooldown", until: 0 });
}
