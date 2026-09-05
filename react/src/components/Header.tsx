import { Link, useNavigate } from '@tanstack/react-router';
import { useAuth } from '../lib/auth-context';

export function Header() {
  const { user, formattedRemaining, logout, isLoading } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/login' });
  };

  return (
    <header className="sticky top-0 z-50 w-full bg-black/90 backdrop-blur-md border-b border-zinc-800 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Logo / Brand */}
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="flex items-center gap-2 font-bold text-lg tracking-tight hover:text-zinc-300 transition-colors"
          >
            <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-700 flex items-center justify-center text-white font-mono text-base font-black shadow-inner">
              V
            </div>
            <span>VeoLMS</span>
          </Link>
          <span className="hidden sm:inline-block text-[11px] font-mono uppercase tracking-wider text-zinc-400 bg-zinc-900/80 px-2 py-0.5 rounded border border-zinc-800">
            JWT Auth 20m
          </span>
        </div>

        {/* Navigation links */}
        <nav className="flex items-center gap-3 sm:gap-5 text-xs sm:text-sm font-medium text-zinc-400">
          <Link
            to="/"
            className="hover:text-white transition-colors"
            activeProps={{ className: "!text-white font-semibold" }}
          >
            Dashboard
          </Link>
          <Link
            to="/video"
            className="hover:text-white transition-colors flex items-center gap-1.5"
            activeProps={{ className: "!text-white font-semibold" }}
          >
            <span>Video</span>
            <span className="px-1.5 py-0.5 bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded text-[10px] font-mono">
              HLS
            </span>
          </Link>
        </nav>

        {/* Right side: Auth status */}
        <div className="flex items-center gap-3">
          {isLoading ? (
            <div className="h-8 w-28 bg-zinc-900 animate-pulse rounded-lg border border-zinc-800" />
          ) : user ? (
            <div className="flex items-center gap-3">
              {/* User Email Display */}
              <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-xs font-mono text-zinc-300">
                <svg
                  className="w-3.5 h-3.5 text-zinc-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9m4.5-1.206a8.959 8.959 0 01-4.5 1.207"
                  />
                </svg>
                <span className="truncate max-w-[180px] sm:max-w-none">{user.email}</span>
              </div>

              {/* Token Expiry Timer */}
              <div
                className="flex items-center gap-2 px-3 py-1.5 bg-emerald-950/30 border border-emerald-800/40 rounded-lg text-xs font-mono text-emerald-400"
                title={`Token expires at: ${user.expiresAt || new Date(user.exp * 1000).toLocaleTimeString()}`}
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span className="hidden xs:inline text-zinc-400">Exp:</span>
                <span className="font-semibold">{formattedRemaining || '0m 00s'}</span>
              </div>

              {/* Logout Button */}
              <button
                onClick={handleLogout}
                className="cursor-pointer text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700 hover:border-zinc-500 px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5"
                title="Logout and clear token"
              >
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                  />
                </svg>
                <span>Logout</span>
              </button>
            </div>
          ) : (
            <Link
              to="/login"
              className="text-xs sm:text-sm font-semibold bg-white text-black hover:bg-zinc-200 px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5"
            >
              <span>Login</span>
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M14 5l7 7m0 0l-7 7m7-7H3"
                />
              </svg>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
