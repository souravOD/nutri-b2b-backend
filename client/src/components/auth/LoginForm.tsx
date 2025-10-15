// client/src/components/auth/LoginForm.tsx
import React, { useState } from "react";
import { useAuth } from "@/context/AuthContext";

export const LoginForm: React.FC<{ onSuccess?: () => void }> = ({ onSuccess }) => {
  const { login, status } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setLoading(true);
    try {
      await login(email, password);
      onSuccess?.();
    } catch (e: any) {
      setErr(e?.message || "Login failed");
    } finally { setLoading(false); }
  };

  return (
    <form onSubmit={submit} className="max-w-sm mx-auto space-y-3">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <input className="w-full border rounded p-2" type="email" placeholder="work email"
             value={email} onChange={e=>setEmail(e.target.value)} required />
      <input className="w-full border rounded p-2" type="password" placeholder="password"
             value={password} onChange={e=>setPassword(e.target.value)} required />
      {err && <p className="text-red-600 text-sm">{err}</p>}
      <button disabled={loading} className="w-full rounded bg-black text-white py-2">
        {loading ? "Signing in..." : "Sign in"}
      </button>
      {status === "needs-verify" && (
        <p className="text-amber-700 text-sm">Please verify your email to continue.</p>
      )}
    </form>
  );
};
