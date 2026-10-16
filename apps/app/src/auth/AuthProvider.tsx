import type { UserManager } from "oidc-client-ts";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { config } from "@/config";
import { clearSessionToken, getSessionToken, isEmbedded, setSessionToken } from "@/embedded";
import { getUserManager, listenForNativeCallback, logout, login as oidcLogin } from "./oidc";

/** Minimal identity — oidc profile fields for standalone, /api/me fields for embedded. */
export interface AuthUser {
  sub: string;
  name?: string;
  email?: string;
}

export interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  login: (returnTo?: string) => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  /** Embedded mode: stores the BFF-issued session token and resolves the user via /api/me. */
  setSession: (token: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const embedded = isEmbedded();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (embedded) {
      const token = getSessionToken();
      if (!token) {
        setUser(null);
        setLoading(false);
        return;
      }
      try {
        const res = await fetch(`${config.apiUrl}/api/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setUser(res.ok ? ((await res.json()) as AuthUser) : null);
      } catch {
        setUser(null);
      }
      setLoading(false);
      return;
    }
    const u = await (await getUserManager()).getUser();
    setUser(
      u && !u.expired ? { sub: u.profile.sub, name: u.profile.name, email: u.profile.email } : null,
    );
    setLoading(false);
  }, [embedded]);

  useEffect(() => {
    void refresh();
    if (embedded) return; // no OIDC manager needed — embedded signs in via Nextcloud connect
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
  }, [refresh, embedded]);

  const getAccessToken = useCallback(async () => {
    if (embedded) return getSessionToken();
    const u = await (await getUserManager()).getUser();
    if (!u || u.expired) return null;
    return u.access_token;
  }, [embedded]);

  const login = useCallback(
    async (returnTo = "/") => {
      if (embedded) return; // embedded signs in via the "Connect Nextcloud" card
      await oidcLogin(returnTo);
    },
    [embedded],
  );

  const embeddedLogout = useCallback(async () => {
    // Best-effort: drop the credential + session server-side, then clear locally.
    const token = getSessionToken();
    if (token) {
      await fetch(`${config.apiUrl}/api/nextcloud/connection`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    clearSessionToken();
    setUser(null);
  }, []);

  const setSession = useCallback(
    async (token: string) => {
      setSessionToken(token);
      await refresh();
    },
    [refresh],
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        logout: embedded ? embeddedLogout : logout,
        getAccessToken,
        setSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
