import type { User, UserManager } from "oidc-client-ts";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { getUserManager, listenForNativeCallback, login, logout } from "./oidc";

export interface AuthState {
  user: User | null;
  loading: boolean;
  login: (returnTo?: string) => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const u = await (await getUserManager()).getUser();
    setUser(u && !u.expired ? u : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    // The manager builds after /api/config resolves — subscribe once it's ready.
    let manager: UserManager | undefined;
    void getUserManager().then((m) => {
      manager = m;
      m.events.addUserLoaded(refresh);
      m.events.addUserUnloaded(refresh);
      m.events.addAccessTokenExpired(refresh);
    });
    const stopNative = listenForNativeCallback(refresh);
    return () => {
      manager?.events.removeUserLoaded(refresh);
      manager?.events.removeUserUnloaded(refresh);
      manager?.events.removeAccessTokenExpired(refresh);
      stopNative();
    };
  }, [refresh]);

  const getAccessToken = useCallback(async () => {
    const u = await (await getUserManager()).getUser();
    if (!u || u.expired) return null;
    return u.access_token;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, getAccessToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
