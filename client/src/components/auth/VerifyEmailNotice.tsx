// client/src/components/auth/VerifyEmailNotice.tsx
import React from "react";
import { useAuth } from "@/context/AuthContext";

export const VerifyEmailNotice: React.FC = () => {
  const { user } = useAuth();
  return (
    <div className="max-w-md mx-auto text-center space-y-2">
      <h2 className="text-xl font-semibold">Verify your email</h2>
      <p>
        We sent a verification link to <strong>{user?.email}</strong>. Click the link, then refresh this page.
      </p>
    </div>
  );
};
