// client/src/components/auth/OnboardGate.tsx
import React, { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { getJWT } from "@/lib/jwt"; 

const BACKEND =
  import.meta.env?.VITE_BACKEND_URL ||
  (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_BACKEND_URL : undefined) ||
  (typeof window !== "undefined" ? `${location.protocol}//${location.hostname}:5000` : "http://127.0.0.1:5000");

/**
 * Onboards the current, verified Appwrite user into your backend:
 * POST /onboard/self with Authorization: Bearer <Appwrite JWT>.
 * Runs once and renders children after success.
 */
export const OnboardGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { status, getJWT } = useAuth();
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "authed") return;
    let cancelled = false;
    (async () => {
      try {
        const jwt = await getJWT();
        if (!jwt) throw new Error("No JWT");
        const res = await fetch(`${BACKEND}/onboard/self`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "X-Appwrite-JWT": jwt,
          },
          credentials: "include",
        });
        if (!res.ok) {
          const text = await res.text();
          console.warn("[OnboardGate] onboarding failed:", res.status, text);
        }
      } catch (e: any) {
        console.warn("[OnboardGate] error:", e?.message || e);
      } finally {
        if (!cancelled) setReady(true);   // <-- always allow the app to render
      }
    })();
    return () => { cancelled = true; };
  }, [status, getJWT]);

  if (status === "loading") return null;
  if (status === "needs-verify") return null; // page will show VerifyEmailNotice instead
  if (err) return <div className="text-red-600 text-sm text-center">{err}</div>;
  if (!ready) return null;
  return <>{children}</>;
};
