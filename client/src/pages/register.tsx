import React from "react";
import { AuthProvider } from "@/context/AuthContext";
import { RegisterForm } from "@/components/auth/RegisterForm";

export default function RegisterPage() {
  return (
    <AuthProvider>
      <div className="min-h-screen grid place-items-center p-6">
        <RegisterForm />
      </div>
    </AuthProvider>
  );
}
