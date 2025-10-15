// client/src/components/auth/RequireAuth.tsx
import React from "react";
import { useAuth } from "@/context/AuthContext";
import { VerifyEmailNotice } from "./VerifyEmailNotice";
import { OnboardGate } from "./OnboardGate";

/**
 * Wrap protected screens with this.
 * - anon  → renders loginSlot
 * - needs-verify → shows verify banner
 * - authed → runs OnboardGate once, then renders children
 */
export const RequireAuth: React.FC<{
  children: React.ReactNode;
  loginSlot?: React.ReactNode;
}> = ({ children, loginSlot }) => {
  const { status } = useAuth();

  if (status === "loading") return null;
  if (status === "anon") return <>{loginSlot ?? null}</>;
  if (status === "needs-verify") return <VerifyEmailNotice />;

  return <OnboardGate>{children}</OnboardGate>;
};
