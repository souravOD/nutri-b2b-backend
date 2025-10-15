// client/src/context/AuthContext.tsx
import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
  } from "react";
  import { account } from "@/lib/appwrite";
  import { getJWT as getCachedJWT, clearJWT } from "@/lib/jwt";
  
  type AuthUser = {
    id: string;
    email: string;
    name?: string;
    emailVerified: boolean;
  };
  
  type AuthState = {
    status: "loading" | "anon" | "needs-verify" | "authed";
    user: AuthUser | null;
  };
  
  type AuthCtx = AuthState & {
    login(email: string, password: string): Promise<void>;
    register(name: string, email: string, password: string): Promise<void>;
    logout(): Promise<void>;
    refresh(): Promise<void>;
    getJWT(): Promise<string | null>;
  };
  
  const Ctx = createContext<AuthCtx | null>(null);
  
  function toUser(me: any): AuthUser {
    return {
      id: me.$id,
      email: me.email,
      name: me.name,
      emailVerified: !!me.emailVerification,
    };
  }
  
  export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [state, setState] = useState<AuthState>({ status: "loading", user: null });
  
    const refresh = useCallback(async () => {
      try {
        const me = await account.get();
        setState({
          status: me.emailVerification ? "authed" : "needs-verify",
          user: toUser(me),
        });
      } catch {
        setState({ status: "anon", user: null });
      }
    }, []);
  
    useEffect(() => {
      refresh();
    }, [refresh]);
  
    const login = useCallback(
      async (email: string, password: string) => {
        await account.createEmailPasswordSession(email, password);
        await refresh();
      },
      [refresh]
    );
  
    const register = useCallback(
      async (name: string, email: string, password: string) => {
        await account.create("unique()", email, password, name);
        await refresh();
      },
      [refresh]
    );
  
    const logout = useCallback(async () => {
      try {
        await account.deleteSession("current");
      } finally {
        clearJWT(); // IMPORTANT: drop cached token on logout
        setState({ status: "anon", user: null });
      }
    }, []);
  
    // IMPORTANT: use the cached JWT helper (no direct account.createJWT here)
    const getJWT = useCallback(async () => {
      return await getCachedJWT();
    }, []);
  
    const value = useMemo<AuthCtx>(
      () => ({ ...state, login, register, logout, refresh, getJWT }),
      [state, login, register, logout, refresh, getJWT]
    );
  
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  };
  
  export function useAuth() {
    const ctx = useContext(Ctx);
    if (!ctx) throw new Error("useAuth must be used within AuthProvider");
    return ctx;
  }
  