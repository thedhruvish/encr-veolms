import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth-context';
import { getMeApi, type MeResponse } from '../lib/api';

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

function DashboardPage() {
  const { user, token, isLoading, formattedRemaining, logout } = useAuth();
  const navigate = useNavigate();
  const [apiData, setApiData] = useState<MeResponse | null>(null);
  const [checkingMe, setCheckingMe] = useState(false);
  const [errorMe, setErrorMe] = useState<string | null>(null);

  // Route protection: redirect to /login if unauthenticated
  useEffect(() => {
    if (!isLoading && !user) {
      navigate({ to: '/login' });
    }
  }, [user, isLoading, navigate]);

  // Fetch /me to demonstrate backend verification
  const handleVerifyBackend = async () => {
    setCheckingMe(true);
    setErrorMe(null);
    try {
      const data = await getMeApi(token);
      setApiData(data);
    } catch (err: any) {
      setErrorMe(err.message || 'Failed to verify session with backend');
    } finally {
      setCheckingMe(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-black">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-zinc-700 border-t-white rounded-full animate-spin" />
          <p className="text-xs text-zinc-400 font-mono">Verifying authentication session...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-black p-4 sm:p-8">
      <div className="max-w-5xl mx-auto space-y-8">
        {/* Top Header Card */}
        <div className="p-6 sm:p-8 rounded-2xl bg-zinc-950 border border-zinc-800 shadow-2xl relative overflow-hidden">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-950/50 border border-emerald-800/60 text-emerald-400 text-xs font-medium mb-3">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                Authenticated Session Active
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
                Welcome, {user.email}
              </h1>
              <p className="text-sm text-zinc-400 mt-1">
                You are logged in without a database using a stateless 20-minute JWT.
              </p>
            </div>

            {/* Countdown Badge Card */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 sm:min-w-[200px] text-center sm:text-right">
              <span className="text-xs text-zinc-400 uppercase tracking-wider block font-mono">
                Token Expires In
              </span>
              <span className="text-2xl font-mono font-bold text-emerald-400 block mt-1">
                {formattedRemaining || '0m 00s'}
              </span>
              <span className="text-[11px] text-zinc-500 block mt-0.5">
                Auto-logout at 00:00
              </span>
            </div>
          </div>
        </div>

        {/* Details Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card 1: JWT & Session Information */}
          <div className="p-6 rounded-2xl bg-zinc-950 border border-zinc-800 flex flex-col justify-between">
            <div>
              <h2 className="text-base font-semibold text-white flex items-center gap-2 mb-4">
                <svg className="w-4 h-4 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                JWT Session Details
              </h2>

              <div className="space-y-3 text-xs font-mono">
                <div className="flex justify-between py-2 border-b border-zinc-900">
                  <span className="text-zinc-500">Email:</span>
                  <span className="text-zinc-200 font-semibold">{user.email}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-zinc-900">
                  <span className="text-zinc-500">Token Duration:</span>
                  <span className="text-zinc-200">20 Minutes (1,200s)</span>
                </div>
                <div className="flex justify-between py-2 border-b border-zinc-900">
                  <span className="text-zinc-500">Unix Expiry:</span>
                  <span className="text-zinc-200">{user.exp}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-zinc-900">
                  <span className="text-zinc-500">Expires At:</span>
                  <span className="text-zinc-200">
                    {user.expiresAt || new Date(user.exp * 1000).toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-zinc-500">Algorithm:</span>
                  <span className="text-zinc-200">HS256 (Hono JWT)</span>
                </div>
              </div>
            </div>

            {token && (
              <div className="mt-4 pt-4 border-t border-zinc-900">
                <span className="text-[11px] text-zinc-500 uppercase tracking-wider block mb-1 font-mono">
                  Bearer Token
                </span>
                <p className="text-[11px] font-mono text-zinc-400 bg-zinc-900 p-2.5 rounded-lg break-all select-all border border-zinc-800/80">
                  {token.slice(0, 48)}...{token.slice(-16)}
                </p>
              </div>
            )}
          </div>

          {/* Card 2: Backend Live Verification (/me test) */}
          <div className="p-6 rounded-2xl bg-zinc-950 border border-zinc-800 flex flex-col justify-between">
            <div>
              <h2 className="text-base font-semibold text-white flex items-center gap-2 mb-4">
                <svg className="w-4 h-4 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                Hono Backend /me Route Test
              </h2>
              <p className="text-xs text-zinc-400 mb-4">
                Verify session directly by sending a request to Hono's authenticated <code className="text-zinc-200 bg-zinc-900 px-1 py-0.5 rounded">GET /me</code> endpoint.
              </p>

              {apiData && (
                <div className="bg-zinc-900 p-3 rounded-xl border border-zinc-800 text-xs font-mono space-y-1.5 mb-4">
                  <div className="text-emerald-400 font-semibold">✓ Verified from backend:</div>
                  <div className="text-zinc-300">email: {apiData.email}</div>
                  <div className="text-zinc-300">expiresAt: {apiData.expiresAt}</div>
                  <div className="text-zinc-300">expiresInSeconds: {apiData.expiresInSeconds}s</div>
                </div>
              )}

              {errorMe && (
                <div className="bg-red-950/40 border border-red-800/50 p-3 rounded-xl text-xs text-red-300 mb-4 font-mono">
                  {errorMe}
                </div>
              )}
            </div>

            <div className="flex flex-col sm:flex-row gap-3 pt-4 border-t border-zinc-900">
              <button
                onClick={handleVerifyBackend}
                disabled={checkingMe}
                className="cursor-pointer flex-1 py-2.5 px-4 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white border border-zinc-700 text-xs font-medium transition-colors flex items-center justify-center gap-2"
              >
                {checkingMe ? 'Pinging /me...' : 'Ping GET /me'}
              </button>
              <button
                onClick={async () => {
                  await logout();
                  navigate({ to: '/login' });
                }}
                className="cursor-pointer py-2.5 px-4 rounded-xl bg-red-950/30 hover:bg-red-900/40 text-red-400 border border-red-800/40 text-xs font-medium transition-colors flex items-center justify-center gap-2"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
