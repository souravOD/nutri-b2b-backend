import React from "react";
import ReactDOM from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";

import "./index.css";

// Auth
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { LoginForm } from "@/components/auth/LoginForm";
import { RegisterForm } from "@/components/auth/RegisterForm";
import { VerifyEmailNotice } from "@/components/auth/VerifyEmailNotice";
import { OnboardGate } from "@/components/auth/OnboardGate";

// Your application shell (router/pages)
import App from "./App";

/** Redirect wrapper for protected routes:
 *  - anon          → /login?next=<current>
 *  - needs-verify  → Verify banner
 *  - authed        → render children (within OnboardGate)
 */
function Guarded({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") return null;

  if (status === "anon") {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  if (status === "needs-verify") {
    return <VerifyEmailNotice />;
  }

  // authed
  return <OnboardGate>{children}</OnboardGate>;
}

/** Login page that auto-navigates after successful auth. */
function LoginRoute() {
  const { status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Where to go after login
  const params = new URLSearchParams(location.search);
  const next = params.get("next") || "/dashboard";

  // Already authed? Bounce immediately.
  if (status === "authed") {
    return <Navigate to={next} replace />;
  }

  if (status === "needs-verify") {
    return <VerifyEmailNotice />;
  }

  // anon
  return (
    <div className="min-h-screen grid place-items-center p-6">
      <LoginForm onSuccess={() => navigate(next, { replace: true })} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public auth routes */}
          <Route path="/login" element={<LoginRoute />} />
          <Route
            path="/register"
            element={
              <div className="min-h-screen grid place-items-center p-6">
                <RegisterForm />
              </div>
            }
          />

          {/* Everything else is protected */}
          <Route
            path="/*"
            element={
              <Guarded>
                <App />
              </Guarded>
            }
          />

          {/* Default */}
          <Route path="/" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </React.StrictMode>
);
