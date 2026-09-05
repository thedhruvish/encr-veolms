import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { getMeApi, loginApi, logoutApi, type UserSession } from './api';

interface AuthContextType {
  user: UserSession | null;
  token: string | null;
  isLoading: boolean;
  secondsRemaining: number | null;
  formattedRemaining: string;
  login: (email: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_STORAGE_KEY = 'veolms_jwt_token';

// Helper to get cookie value
function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

// Helper to set cookie
function setCookie(name: string, value: string, maxAgeSeconds: number) {
  if (typeof document === 'undefined') return;
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
}

// Helper to delete cookie
function deleteCookie(name: string) {
  if (typeof document === 'undefined') return;
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserSession | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  // Logout handler
  const logout = useCallback(async () => {
    try {
      await logoutApi();
    } catch (e) {
      console.error('Error during logout API call:', e);
    } finally {
      if (typeof window !== 'undefined') {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        deleteCookie('token');
      }
      setToken(null);
      setUser(null);
      setSecondsRemaining(null);
    }
  }, []);

  // Login handler
  const login = useCallback(async (email: string) => {
    setIsLoading(true);
    try {
      const response = await loginApi(email);
      const jwtToken = response.token;
      const userSession = response.user;

      if (typeof window !== 'undefined') {
        localStorage.setItem(TOKEN_STORAGE_KEY, jwtToken);
        setCookie('token', jwtToken, 20 * 60);
      }

      setToken(jwtToken);
      setUser(userSession);

      const nowSeconds = Math.floor(Date.now() / 1000);
      setSecondsRemaining(Math.max(0, userSession.exp - nowSeconds));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initialize and verify existing session on mount
  useEffect(() => {
    let isMounted = true;

    async function initializeAuth() {
      if (typeof window === 'undefined') {
        setIsLoading(false);
        return;
      }

      const storedToken = localStorage.getItem(TOKEN_STORAGE_KEY) || getCookie('token');

      if (!storedToken) {
        if (isMounted) {
          setIsLoading(false);
        }
        return;
      }

      try {
        const me = await getMeApi(storedToken);
        if (isMounted) {
          setToken(storedToken);
          setUser({
            email: me.email,
            exp: me.exp,
            expiresAt: me.expiresAt,
            expiresInSeconds: me.expiresInSeconds,
          });
          const nowSeconds = Math.floor(Date.now() / 1000);
          setSecondsRemaining(Math.max(0, me.exp - nowSeconds));
        }
      } catch (err) {
        console.warn('Session verification failed:', err);
        if (isMounted) {
          localStorage.removeItem(TOKEN_STORAGE_KEY);
          deleteCookie('token');
          setToken(null);
          setUser(null);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    initializeAuth();

    return () => {
      isMounted = false;
    };
  }, []);

  // Countdown timer effect
  useEffect(() => {
    if (!user || !user.exp) {
      setSecondsRemaining(null);
      return;
    }

    const updateCountdown = () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const remaining = user.exp - nowSeconds;

      if (remaining <= 0) {
        setSecondsRemaining(0);
        logout();
      } else {
        setSecondsRemaining(remaining);
      }
    };

    updateCountdown();
    const intervalId = setInterval(updateCountdown, 1000);

    return () => clearInterval(intervalId);
  }, [user, logout]);

  // Formatted countdown string (e.g. "19m 45s" or "00:00")
  const formattedRemaining = useMemo(() => {
    if (secondsRemaining === null || secondsRemaining === undefined) {
      return '';
    }
    const minutes = Math.floor(secondsRemaining / 60);
    const seconds = secondsRemaining % 60;
    return `${minutes}m ${seconds < 10 ? '0' : ''}${seconds}s`;
  }, [secondsRemaining]);

  const value = useMemo(
    () => ({
      user,
      token,
      isLoading,
      secondsRemaining,
      formattedRemaining,
      login,
      logout,
    }),
    [user, token, isLoading, secondsRemaining, formattedRemaining, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
