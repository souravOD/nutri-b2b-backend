import React from "react";
import { AuthProvider } from "@/context/AuthContext";
import { LoginForm } from "@/components/auth/LoginForm";

export default function LoginPage() {
  return (
    <AuthProvider>
      <div className="min-h-screen grid place-items-center p-6">
        <LoginForm />
      </div>
    </AuthProvider>
  );
}
