import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from '../lib/auth-context';
import { getVideoApi, API_BASE_URL, type VideoResponse } from '../lib/api';
import {
  ShieldCheck,
  Play,
  RefreshCw,
  AlertCircle,
  Sparkles,
  KeyRound,
  Lock,
  Layers,
  Fingerprint,
} from 'lucide-react';

import { DvideoPlayer } from '../components/dvideo';

export const Route = createFileRoute('/video')({
  component: VideoPage,
});

function isYouTubeUrl(url: string): boolean {
  if (!url) return false;
  return (
    url.includes('youtube.com') || url.includes('youtu.be') || url.includes('youtube-nocookie.com')
  );
}

function getYouTubeEmbedUrl(url: string): string {
  if (!url) return '';
  if (url.includes('/embed/')) {
    return url;
  }
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname.includes('youtube.com')) {
      const videoId = urlObj.searchParams.get('v');
      if (videoId) {
        return `https://www.youtube.com/embed/${videoId}?autoplay=1`;
      }
    }
    if (urlObj.hostname.includes('youtu.be')) {
      const videoId = urlObj.pathname.slice(1);
      if (videoId) {
        return `https://www.youtube.com/embed/${videoId}?autoplay=1`;
      }
    }
  } catch {
    // Ignore parsing issues
  }
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\\&v=)([^#\\&\\?]*).*/;
  const match = url.match(regExp);
  if (match && match[2].length === 11) {
    return `https://www.youtube.com/embed/${match[2]}?autoplay=1`;
  }
  return url;
}

function VideoPage() {
  const { user, token, isLoading: isAuthLoading } = useAuth();
  const navigate = useNavigate();

  const [videoData, setVideoData] = useState<VideoResponse['video'] | null>(null);
  const [activeUrl, setActiveUrl] = useState<string>('');
  const [activeSt, setActiveSt] = useState<string>('');
  const [loadingVideo, setLoadingVideo] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tokenRenewalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Route protection: redirect to /login if unauthenticated
  useEffect(() => {
    if (!isAuthLoading && !user) {
      navigate({ to: '/login' });
    }
  }, [user, isAuthLoading, navigate]);

  // Silent automatic playback token renewal
  const scheduleTokenRenewal = useCallback(
    (expiresInSeconds?: number) => {
      if (tokenRenewalTimerRef.current) {
        clearTimeout(tokenRenewalTimerRef.current);
        tokenRenewalTimerRef.current = null;
      }

      if (!expiresInSeconds || expiresInSeconds <= 60) return;

      // Refresh ~5 minutes (300s) before expiry, or at 80% if short
      const refreshBeforeSeconds = Math.min(300, Math.floor(expiresInSeconds * 0.2));
      const delayMs = Math.max((expiresInSeconds - refreshBeforeSeconds) * 1000, 10000);

      tokenRenewalTimerRef.current = setTimeout(async () => {
        if (!token) return;
        try {
          console.log('[TokenRenewal] Silently renewing playback token before expiry...');
          const response = await getVideoApi(token);
          if (response.video?.st) {
            setActiveSt(response.video.st);
            setVideoData((prev) =>
              prev
                ? {
                    ...prev,
                    st: response.video.st,
                    expiresAt: response.video.expiresAt,
                    expiresInSeconds: response.video.expiresInSeconds,
                  }
                : response.video
            );
            scheduleTokenRenewal(response.video.expiresInSeconds);
          }
        } catch (err) {
          console.warn('[TokenRenewal] Silent token renewal failed:', err);
        }
      }, delayMs);
    },
    [token]
  );

  const fetchVideoStream = async () => {
    if (!token && !user) return;
    setLoadingVideo(true);
    setError(null);

    try {
      const response = await getVideoApi(token);
      if (!response.video?.src) {
        throw new Error('Backend did not return a valid video stream URL.');
      }
      setVideoData(response.video);
      setActiveUrl(response.video.src);
      setActiveSt(response.video.st || '');
      scheduleTokenRenewal(response.video.expiresInSeconds);
    } catch (err: any) {
      console.error('Failed to fetch video stream:', err);
      setError(err?.message || 'Failed to authenticate and retrieve video stream from backend');
    } finally {
      setLoadingVideo(false);
    }
  };

  // Immediate renewal upon 401 token expiry notice
  const renewTokenSilently = useCallback(async () => {
    if (!token) return;
    try {
      console.log('[TokenRenewal] Immediate renewal requested by player...');
      const response = await getVideoApi(token);
      if (response.video?.st) {
        setActiveSt(response.video.st);
        setVideoData((prev) =>
          prev
            ? {
                ...prev,
                st: response.video.st,
                expiresAt: response.video.expiresAt,
                expiresInSeconds: response.video.expiresInSeconds,
              }
            : response.video
        );
        scheduleTokenRenewal(response.video.expiresInSeconds);
      }
    } catch (err) {
      console.warn('[TokenRenewal] Immediate renewal failed:', err);
    }
  }, [token, scheduleTokenRenewal]);

  // Reclaim active session when superseded
  const handleReclaimSession = useCallback(async () => {
    console.log('[Session] Reclaiming active playback session...');
    await fetchVideoStream();
  }, [fetchVideoStream]);

  useEffect(() => {
    if (user && token) {
      fetchVideoStream();
    }
    return () => {
      if (tokenRenewalTimerRef.current) {
        clearTimeout(tokenRenewalTimerRef.current);
      }
    };
  }, [user, token]);

  const handlePlayerError = (err?: unknown) => {
    console.warn('Player error caught in video route:', err);
    if (videoData?.src && activeUrl !== videoData.src) {
      console.warn('Stream failed, falling back to original videoUrl:', videoData.src);
      setActiveUrl(videoData.src);
    }
  };

  const isEncrypted = Boolean(videoData?.encryption);

  // Normalize absolute URLs for player
  const fullSrc = activeUrl
    ? activeUrl.startsWith('http')
      ? activeUrl
      : `${API_BASE_URL}${activeUrl}`
    : '';

  const playerEncryption = videoData?.encryption
    ? {
        ...videoData.encryption,
        licenseUrl: (() => {
          const licenseUrl = new URL(
            videoData.encryption.licenseUrl,
            `${API_BASE_URL.replace(/\/+$/, '')}/`,
          );
          if (activeSt) licenseUrl.searchParams.set('st', activeSt);
          return licenseUrl.toString();
        })(),
      }
    : undefined;

  if (isAuthLoading) {
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
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header Title Section */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-zinc-800">
          <div>
            {isEncrypted ? (
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-950/60 border border-emerald-800/60 text-emerald-400 text-xs font-medium mb-2">
                <Lock className="w-3.5 h-3.5" />
                CENC-AES-CTR (EME Clear Key)
              </div>
            ) : (
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-blue-950/60 border border-blue-800/60 text-blue-400 text-xs font-medium mb-2">
                <ShieldCheck className="w-3.5 h-3.5" />
                JWT Authenticated Stream
              </div>
            )}
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white flex items-center gap-3">
              <span>{videoData?.title || 'Video Player'}</span>
            </h1>
            <p className="text-xs sm:text-sm text-zinc-400 mt-1">
              {isEncrypted
                ? 'Hardened EME Clear Key DASH pipeline with per-period key rotation, signed access, origin locking & session watermark.'
                : 'Powered by Video.js latest engine with custom dvideo controls & HLS adaptive bitrate streaming.'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={fetchVideoStream}
              disabled={loadingVideo}
              className="cursor-pointer inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 text-xs font-medium transition-all"
              title="Refresh Stream Token"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingVideo ? 'animate-spin text-blue-400' : ''}`} />
              <span>Refresh URL</span>
            </button>
          </div>
        </div>

        {/* Video Player Card */}
        <div className="w-full bg-zinc-950 rounded-2xl border border-zinc-800/80 shadow-2xl overflow-hidden">
          {/* Card Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/80">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center">
                <Play className="w-3.5 h-3.5 text-white fill-current" />
              </div>
              <h3 className="font-bold text-sm text-white line-clamp-1">
                {videoData?.title || 'Loading Video Stream...'}
              </h3>
            </div>
            {isEncrypted ? (
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-800/50 text-emerald-400 flex items-center gap-1.5">
                <Lock className="w-3 h-3" />
                DASH .mpd (Encrypted)
              </span>
            ) : (
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-blue-950/60 border border-blue-800/50 text-blue-400">
                HLS .m3u8
              </span>
            )}
          </div>

          {/* Video Player Wrapper */}
          <div className="relative aspect-video bg-zinc-950 flex items-center justify-center">
            {loadingVideo ? (
              <div className="w-full h-full flex flex-col items-center justify-center gap-3">
                <div className="relative w-12 h-12 flex items-center justify-center">
                  <div className="absolute inset-0 border-4 border-white/5 border-t-blue-500 rounded-full animate-spin" />
                </div>
                <p className="text-xs font-mono text-zinc-400">
                  Calling backend with JWT token to retrieve authenticated stream URL...
                </p>
              </div>
            ) : error ? (
              <div className="w-full h-full p-8 flex flex-col items-center justify-center text-center gap-4 bg-red-950/20">
                <AlertCircle className="w-12 h-12 text-red-400" />
                <div className="space-y-1">
                  <h3 className="text-lg font-semibold text-white">Stream Authorization Error</h3>
                  <p className="text-xs text-red-300/80 max-w-md font-mono">{error}</p>
                </div>
                <button
                  onClick={fetchVideoStream}
                  className="cursor-pointer px-4 py-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-white rounded-lg text-xs font-medium transition-colors"
                >
                  Retry API Call
                </button>
              </div>
            ) : fullSrc ? (
              isYouTubeUrl(fullSrc) ? (
                <iframe
                  src={getYouTubeEmbedUrl(fullSrc)}
                  title={videoData?.title || 'Video'}
                  className="w-full h-full border-0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <DvideoPlayer
                    src={fullSrc}
                    type={videoData?.type}
                    encryption={playerEncryption}
                    st={activeSt}
                    userEmail={user.email}
                    onReclaimSession={handleReclaimSession}
                    onTokenRefreshNeeded={renewTokenSilently}
                    isEnableCinemaMode={true}
                    className="w-full h-full"
                    onError={handlePlayerError}
                  />
                </div>
              )
            ) : null}
          </div>
        </div>

        {/* Video & Stream Information Card */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 p-5 rounded-2xl bg-zinc-950 border border-zinc-800 space-y-3">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-blue-400" />
              Stream Details &amp; Backend API
            </h2>
            <div className="space-y-2 text-xs font-mono">
              <div className="flex flex-col sm:flex-row sm:justify-between py-1.5 border-b border-zinc-900 gap-1">
                <span className="text-zinc-500">
                  Source Stream ({isEncrypted ? 'DASH .mpd' : 'HLS .m3u8'}):
                </span>
                <span className="text-blue-400 truncate max-w-md" title={fullSrc}>
                  {fullSrc || 'Fetching...'}
                </span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-zinc-900">
                <span className="text-zinc-500">Stream Type:</span>
                <span className={isEncrypted ? 'text-emerald-400 font-semibold' : 'text-zinc-200'}>
                  {isEncrypted
                    ? 'DASH Dynamic Key Rotation (CENC-AES-CTR • EME Clear Key)'
                    : 'HLS Adaptive Master Playlist (HlsJsVideo)'}
                </span>
              </div>
              {isEncrypted && (
                <>
                  <div className="flex justify-between py-1.5 border-b border-zinc-900">
                    <span className="text-zinc-500">DRM Key System:</span>
                    <span className="text-zinc-200">org.w3.clearkey (W3C EME Clear Key)</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-zinc-900">
                    <span className="text-zinc-500">Active Key Periods:</span>
                    <span className="text-emerald-400 flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5" />
                      {videoData?.periodCount || 3} Periods (60s rotation)
                    </span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-zinc-900">
                    <span className="text-zinc-500">Session Protection:</span>
                    <span className="text-blue-400 flex items-center gap-1.5">
                      <Fingerprint className="w-3.5 h-3.5" />
                      Single Active Session Enforced (UUID sid)
                    </span>
                  </div>
                </>
              )}
              <div className="flex justify-between py-1.5 border-b border-zinc-900">
                <span className="text-zinc-500">Authorized User:</span>
                <span className="text-zinc-200">{user.email}</span>
              </div>
              <div className="flex justify-between py-1.5">
                <span className="text-zinc-500">Backend API Route:</span>
                <span className="text-emerald-400">GET /video (JWT Bearer Verified)</span>
              </div>
            </div>
          </div>

          {/* Quick Shortcuts & Features Card */}
          <div className="p-5 rounded-2xl bg-zinc-950 border border-zinc-800 space-y-3 flex flex-col justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                Player Features
              </h2>
              <ul className="text-xs text-zinc-400 space-y-1.5 list-disc list-inside">
                <li>Video.js + Shaka Player EME engine</li>
                <li>CENC-AES-CTR Clear Key hardware decrypt</li>
                <li>Per-period dynamic key rotation</li>
                <li>Intermittent live session watermark</li>
                <li>Single active session enforcement</li>
                <li>Auto-token renewal &amp; context-menu lock</li>
              </ul>
            </div>

            <div className="pt-3 border-t border-zinc-900">
              <span className="text-[11px] text-zinc-500 font-mono">
                Press <kbd className="bg-zinc-800 text-zinc-300 px-1 rounded">Shift + ?</kbd> in player for shortcuts
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
