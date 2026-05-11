"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { apiUrl } from "../lib/api";

export interface AuthUser {
  userId: string;
  companyId: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string, displayName?: string): Promise<void>;
  logout(): void;
}

const TOKEN_KEY = "arceus-token";

function decodeToken(token: string): AuthUser | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(json) as { userId?: string; companyId?: string; exp?: number };
    if (!parsed.userId || !parsed.exp || Math.floor(Date.now() / 1000) > parsed.exp) return null;
    return { userId: parsed.userId, companyId: parsed.companyId ?? null };
  } catch {
    return null;
  }
}

function setSessionCookie(token: string) {
  document.cookie = `arceus_session=${token}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`;
}

function clearSessionCookie() {
  document.cookie = "arceus_session=; path=/; max-age=0; SameSite=Lax";
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) {
      const decoded = decodeToken(stored);
      if (decoded) {
        setToken(stored);
        setUser(decoded);
      } else {
        localStorage.removeItem(TOKEN_KEY);
      }
    }
  }, []);

  const storeAuth = useCallback((newToken: string) => {
    const decoded = decodeToken(newToken);
    if (!decoded) throw new Error("Invalid token received from server.");
    localStorage.setItem(TOKEN_KEY, newToken);
    setSessionCookie(newToken);
    setToken(newToken);
    setUser(decoded);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch(apiUrl("/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error ?? "Invalid email or password.");
    }
    const data = await res.json() as { token: string };
    storeAuth(data.token);
  }, [storeAuth]);

  const register = useCallback(async (email: string, password: string, displayName?: string) => {
    const res = await fetch(apiUrl("/auth/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, displayName }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error ?? "Registration failed.");
    }
    const data = await res.json() as { token: string };
    storeAuth(data.token);
  }, [storeAuth]);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    clearSessionCookie();
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
