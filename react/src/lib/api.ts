// API client for Hono backend

export const API_BASE_URL =
  (typeof window !== 'undefined' && (window as any).__API_BASE_URL__) ||
  import.meta.env.VITE_API_URL ||
  'http://localhost:8787';

export interface UserSession {
  email: string;
  exp: number;
  expiresAt?: string;
  expiresInSeconds?: number;
}

export interface LoginResponse {
  success: boolean;
  message: string;
  token: string;
  user: UserSession;
}

export interface MeResponse {
  authenticated: boolean;
  email: string;
  exp: number;
  expiresAt: string;
  expiresInSeconds: number;
  error?: string;
}

export async function loginApi(email: string): Promise<LoginResponse> {
  const url = `${API_BASE_URL}/login`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ email }),
  });

  const data: any = await res.json();

  if (!res.ok) {
    throw new Error(data?.error || 'Failed to log in');
  }

  return data as LoginResponse;
}

export async function logoutApi(): Promise<{ success: boolean; message: string }> {
  try {
    const url = `${API_BASE_URL}/logout`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
    });
    return (await res.json()) as { success: boolean; message: string };
  } catch {
    return { success: true, message: 'Logged out locally' };
  }
}

export async function getMeApi(token?: string | null): Promise<MeResponse> {
  const url = `${API_BASE_URL}/me`;
  const headers: Record<string, string> = {};

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: 'GET',
    headers,
    credentials: 'include',
  });

  const data: any = await res.json();

  if (!res.ok || !data?.authenticated) {
    throw new Error(data?.error || 'Session expired or invalid');
  }

  return data as MeResponse;
}

export interface VideoResponse {
  authenticated: boolean;
  video: {
    id: string;
    title: string;
    src: string;
    type: string;
    user: string;
  };
  error?: string;
}

export async function getVideoApi(token?: string | null): Promise<VideoResponse> {
  const url = `${API_BASE_URL}/video`;
  const headers: Record<string, string> = {};

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: 'GET',
    headers,
    credentials: 'include',
  });

  const data: any = await res.json();

  if (!res.ok || !data?.authenticated) {
    throw new Error(data?.error || 'Failed to retrieve video stream');
  }

  return data as VideoResponse;
}

