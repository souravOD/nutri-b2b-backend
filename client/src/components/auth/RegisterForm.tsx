// client/src/components/auth/RegisterForm.tsx
import React, { useState } from "react";
import { useAuth } from "@/context/AuthContext";

export const RegisterForm: React.FC<{ onSuccess?: () => void }> = ({ onSuccess }) => {
  const { register } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setLoading(true);
    try {
      await register(name, email, password);
      setSent(true);
      onSuccess?.();
    } catch (e: any) {
      setErr(e?.message || "Registration failed");
    } finally { setLoading(false); }
  };

  return (
    <form onSubmit={submit} className="max-w-sm mx-auto space-y-3">
      <h1 className="text-xl font-semibold">Create your account</h1>
      <input className="w-full border rounded p-2" placeholder="full name"
             value={name} onChange={e=>setName(e.target.value)} required />
      <input className="w-full border rounded p-2" type="email" placeholder="work email"
             value={email} onChange={e=>setEmail(e.target.value)} required />
      <input className="w-full border rounded p-2" type="password" placeholder="password"
             value={password} onChange={e=>setPassword(e.target.value)} required />
      {err && <p className="text-red-600 text-sm">{err}</p>}
      <button disabled={loading} className="w-full rounded bg-black text-white py-2">
        {loading ? "Creating..." : "Create account"}
      </button>
      {sent && (
        <p className="text-green-700 text-sm">
          Verification email sent. Please check your inbox.
        </p>
      )}
    </form>
  );
};
