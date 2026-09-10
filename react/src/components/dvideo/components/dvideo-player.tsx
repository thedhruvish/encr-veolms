import { useState, useRef, useEffect, memo } from "react";
import { useCaptionsOptions } from "@videojs/react";
import { Video } from "@videojs/react/video";
import { HlsJsVideo } from "@videojs/react/media/hlsjs-video";
import { ShakaVideo } from "@videojs/react/media/shaka-video";
import {
  SkipBack,
  SkipForward,
  Keyboard,
  Info,
  Play,
  Pause,
  Subtitles,
  RectangleHorizontal,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { Player } from "../player";
import { PlayPauseButton } from "./play-pause-button";
import { VolumeControl } from "./volume-control";
import { Timeline } from "./timeline";
import { TimeDisplay } from "./time-display";
import { SettingsMenu } from "./settings-menu";
import { PiPFullscreenControls } from "./pip-fullscreen-controls";
import { ResumePlaybackTracker } from "./resume-playback-tracker";
import { PlayerTooltip } from "./player-tooltip";
import { SessionWatermark } from "./session-watermark";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { cn } from "../utils";

interface Props {
  src: string;
  type?: string;
  poster?: string;
  onNext?: () => void;
  onPrev?: () => void;
  isEnableCinemaMode?: boolean;
  className?: string;
  initialTime?: number;
  onProgressUpdate?: (currentTime: number, duration: number) => void;
  initialPlaybackRate?: number;
  onPlaybackRateChange?: (rate: number) => void;
  onError?: (error?: unknown) => void;
  encryption?: {
    scheme: string;
    keySystem: string;
    licenseUrl: string;
  };
  st?: string;
  userEmail?: string;
  onSessionSuperseded?: () => void;
  onReclaimSession?: () => void;
  onTokenRefreshNeeded?: () => void;
}

function base64UrlToHex(str: string): string {
  if (/^[0-9a-fA-F]{32}$/.test(str)) {
    return str.toLowerCase();
  }
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) {
    b64 += "=";
  }
  const bin = atob(b64);
  let hex = "";
  for (let i = 0; i < bin.length; i++) {
    hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex.toLowerCase();
}

function DvideoPlayerInner({
  src,
  type,
  poster,
  onNext,
  onPrev,
  isEnableCinemaMode = false,
  className,
  initialTime,
  onProgressUpdate,
  initialPlaybackRate,
  onPlaybackRateChange,
  onError,
  encryption,
  st,
  userEmail,
  onSessionSuperseded,
  onReclaimSession,
  onTokenRefreshNeeded,
}: Props) {
  const store = Player.usePlayer();
  const media = Player.useMedia();

  const [clearKeys, setClearKeys] = useState<Record<string, string> | null>(null);
  const [isLoadingKeys, setIsLoadingKeys] = useState(false);
  const [isSessionSuperseded, setIsSessionSuperseded] = useState(false);
  const [isCdmUnsupported, setIsCdmUnsupported] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [isHolding2x, setIsHolding2x] = useState(false);
  const [speedHUD, setSpeedHUD] = useState<{ speed: number; key: number } | null>(null);
  const [isCinemaMode, setIsCinemaMode] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "play" | "pause"; key: number } | null>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);

  const state = Player.usePlayer((s) => ({
    paused: s.paused,
    fullscreen: s.fullscreen,
    pip: s.pip,
    currentTime: s.currentTime,
    duration: s.duration,
    volume: s.volume,
    playbackRate: s.playbackRate,
  }));

  const currentPlaybackRate = Player.usePlayer((s) => s.playbackRate);

  const onSessionSupersededRef = useRef(onSessionSuperseded);
  onSessionSupersededRef.current = onSessionSuperseded;

  const onTokenRefreshNeededRef = useRef(onTokenRefreshNeeded);
  onTokenRefreshNeededRef.current = onTokenRefreshNeeded;

  const stateRef = useRef(state);
  stateRef.current = state;

  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setIsSessionSuperseded(false);
    setIsCdmUnsupported(false);
    setIsBuffering(false);
  }, [src, st]);

  // Helper to parse error details from Shaka Error objects (BAD_HTTP_STATUS / LICENSE_REQUEST_FAILED)
  const parseShakaErrorInfo = (err: any) => {
    let isSessionSuperseded = false;
    let isTokenExpired = false;
    let isCdmUnsupported = false;

    const actualErr =
      err?.nativeEvent?.error ||
      err?.target?.error ||
      err?.detail?.error ||
      err?.detail ||
      err?.error ||
      err;

    const checkString = (str: string) => {
      if (!str || typeof str !== "string") return;
      if (str.includes("session_superseded")) isSessionSuperseded = true;
      if (str.includes("token_expired")) isTokenExpired = true;
    };

    const inspect = (val: any) => {
      if (!val) return;
      const code = val?.data?.code || val?.code;
      if (
        code === 6001 ||
        String(val?.message || "").includes("6001") ||
        String(val || "").includes("REQUESTED_KEY_SYSTEM_CONFIG_UNAVAILABLE")
      ) {
        isCdmUnsupported = true;
      }

      if (Array.isArray(val?.data)) {
        for (const item of val.data) {
          if (typeof item === "string") checkString(item);
          else if (typeof item === "object") inspect(item);
        }
      }
      if (typeof val?.message === "string") checkString(val.message);
      if (typeof val === "string") checkString(val);
      try {
        checkString(JSON.stringify(val));
      } catch {}
    };

    inspect(actualErr);
    return { isSessionSuperseded, isTokenExpired, isCdmUnsupported };
  };

  // Shaka Networking Engine Request and Response Filters + Engine Error Listener
  useEffect(() => {
    const engine = (media as any)?.engine;
    if (!engine) return;

    const networkingEngine = engine.getNetworkingEngine?.();
    if (!networkingEngine) return;

    // DASH does not carry the manifest query string onto relative segment URLs. Add
    // the short-lived playback token to every same-origin protected-media request.
    const sourceUrl = new URL(src, window.location.href);
    const requestFilter = (_type: any, request: any) => {
      if (!st) return;

      request.uris = request.uris.map((uri: string) => {
        try {
          const url = new URL(uri, sourceUrl);
          if (
            url.origin === sourceUrl.origin &&
            url.pathname.startsWith("/assets/")
          ) {
            url.searchParams.set("st", st);
            return url.toString();
          }
        } catch {}
        return uri;
      });
    };
    const responseFilter = (_type: any, response: any) => {
      if (response && response.status === 401) {
        setIsBuffering(false);
        try {
          const text = new TextDecoder().decode(response.data);
          const json = JSON.parse(text);
          if (json.error === "session_superseded") {
            store.pause();
            setIsSessionSuperseded(true);
            onSessionSupersededRef.current?.();
          } else if (json.error === "token_expired") {
            onTokenRefreshNeededRef.current?.();
          }
        } catch {}
      }
    };

    const handleEngineError = (event: any) => {
      const error = event?.detail || event;
      const {
        isSessionSuperseded: isSuperseded,
        isTokenExpired: isExpired,
        isCdmUnsupported: isUnsupported,
      } = parseShakaErrorInfo(error);

      setIsBuffering(false);
      if (isSuperseded) {
        store.pause();
        setIsSessionSuperseded(true);
        onSessionSupersededRef.current?.();
      } else if (isExpired) {
        onTokenRefreshNeededRef.current?.();
      }

      if (isUnsupported) {
        setIsCdmUnsupported(true);
      }

      if (!isSuperseded && !isExpired && !isUnsupported) {
        onError?.(error);
      }
    };

    networkingEngine.registerRequestFilter(requestFilter);
    networkingEngine.registerResponseFilter(responseFilter);
    engine.addEventListener?.("error", handleEngineError);

    return () => {
      try {
        networkingEngine.unregisterRequestFilter(requestFilter);
        networkingEngine.unregisterResponseFilter(responseFilter);
        engine.removeEventListener?.("error", handleEngineError);
      } catch {}
    };
  }, [media, src, st, store]);

  const handleCustomError = (err?: unknown) => {
    setIsBuffering(false);
    const {
      isSessionSuperseded: isSuperseded,
      isTokenExpired: isExpired,
      isCdmUnsupported: isUnsupported,
    } = parseShakaErrorInfo(err);

    if (isSuperseded) {
      store.pause();
      setIsSessionSuperseded(true);
      onSessionSupersededRef.current?.();
      return;
    }

    if (isExpired) {
      onTokenRefreshNeededRef.current?.();
      return;
    }

    if (isUnsupported) {
      setIsCdmUnsupported(true);
      return;
    }

    onError?.(err);
  };

  const handleReclaimSession = () => {
    setIsSessionSuperseded(false);
    onReclaimSession?.();
  };

  // Pre-fetch ClearKey licenses in a single batch request to avoid N separate period calls
  useEffect(() => {
    if (
      !encryption ||
      encryption.keySystem !== "org.w3.clearkey" ||
      !encryption.licenseUrl
    ) {
      setClearKeys(null);
      setIsLoadingKeys(false);
      return;
    }

    let isCancelled = false;
    setIsLoadingKeys(true);

    const fetchKeys = async () => {
      try {
        const res = await fetch(encryption.licenseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ type: "temporary", all: true }),
        });

        if (isCancelled) return;

        if (!res.ok) {
          if (res.status === 401) {
            try {
              const errData: any = await res.json();
              if (errData?.error === "session_superseded") {
                store.pause();
                setIsSessionSuperseded(true);
                onSessionSupersededRef.current?.();
                return;
              }
              if (errData?.error === "token_expired") {
                onTokenRefreshNeededRef.current?.();
                return;
              }
            } catch {}
          }
          throw new Error(`License fetch failed with status ${res.status}`);
        }

        const data: any = await res.json();
        if (isCancelled) return;

        if (Array.isArray(data?.keys)) {
          const map: Record<string, string> = {};
          for (const kItem of data.keys) {
            if (kItem?.kid && kItem?.k) {
              const kidHex = base64UrlToHex(kItem.kid);
              const keyHex = base64UrlToHex(kItem.k);
              map[kidHex] = keyHex;
            }
          }
          setClearKeys(map);
        }
      } catch (err) {
        if (!isCancelled) {
          console.error("Failed to prefetch ClearKey license:", err);
          handleCustomError(err);
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingKeys(false);
        }
      }
    };

    fetchKeys();

    return () => {
      isCancelled = true;
    };
  }, [encryption?.licenseUrl, st, src]);

  const resetControlsTimeout = () => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    if (!state.paused) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3500);
    }
  };

  useEffect(() => {
    if (state.paused) {
      setShowControls(true);
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    } else {
      resetControlsTimeout();
    }
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, [state.paused]);

  const lastReportedRateRef = useRef<number | null>(null);
  const isInitialRateAppliedRef = useRef(false);
  const isInitialRateMatchedRef = useRef(false);
  const lastPlaybackRateSrcRef = useRef<string | null>(null);

  // Reset when source changes
  useEffect(() => {
    isInitialRateAppliedRef.current = false;
    isInitialRateMatchedRef.current = false;
    lastPlaybackRateSrcRef.current = null;
  }, [src]);

  // Handle setting initial playback rate on store target load
  useEffect(() => {
    if (!store.target || !src || initialPlaybackRate === undefined) return;
    if (lastPlaybackRateSrcRef.current === src) return;

    store.setPlaybackRate(initialPlaybackRate);
    lastPlaybackRateSrcRef.current = src;
    isInitialRateAppliedRef.current = true;
    lastReportedRateRef.current = initialPlaybackRate;
  }, [src, store.target, initialPlaybackRate, store]);

  // Handle reporting playback rate changes back to the parent
  const onPlaybackRateChangeRef = useRef(onPlaybackRateChange);
  onPlaybackRateChangeRef.current = onPlaybackRateChange;

  useEffect(() => {
    if (!store.target || !src || currentPlaybackRate === undefined) return;

    // Skip/wait if initialPlaybackRate has not loaded/been supplied yet
    if (initialPlaybackRate === undefined) {
      return;
    }

    // Wait until the initial rate is applied
    if (!isInitialRateAppliedRef.current) {
      return;
    }

    // Check if the player has caught up to the initial rate
    if (!isInitialRateMatchedRef.current) {
      if (currentPlaybackRate === initialPlaybackRate) {
        isInitialRateMatchedRef.current = true;
      }
      return;
    }

    // Skip if it matches the initial/last reported rate
    if (lastReportedRateRef.current === currentPlaybackRate) return;

    lastReportedRateRef.current = currentPlaybackRate;
    if (onPlaybackRateChangeRef.current) {
      console.log("[DvideoPlayer] Reporting playback rate change:", currentPlaybackRate);
      onPlaybackRateChangeRef.current(currentPlaybackRate);
    }
  }, [src, currentPlaybackRate, store.target, initialPlaybackRate]);

  const handleMouseMove = () => {
    setShowControls(true);
    resetControlsTimeout();
  };

  const holdTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originalSpeedRef = useRef(1);
  const is2xActiveRef = useRef(false);

  const captions = useCaptionsOptions();
  const hasSubtitles = captions && captions.options && captions.options.length > 1;
  const isSubtitlesActive = captions && captions.value !== "off";

  const handleSubtitleToggle = () => {
    if (!captions || !captions.options) return;
    if (captions.value !== "off") {
      captions.setValue("off");
    } else {
      const activeOption = captions.options.find((o) => o.value !== "off");
      if (activeOption) {
        captions.setValue(activeOption.value);
      }
    }
  };

  // Reset speed HUD feedback banner after 1.5 seconds
  useEffect(() => {
    if (!speedHUD) return;
    const timer = setTimeout(() => setSpeedHUD(null), 1500);
    return () => clearTimeout(timer);
  }, [speedHUD]);

  // Combined click-hold and keyboard shortcuts
  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      if (!target) return false;
      const element = target as HTMLElement;
      return (
        ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) ||
        element.isContentEditable ||
        element.closest("[contenteditable='true']") !== null
      );
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!store.target) {
        return;
      }
      if (isTyping(e.target)) {
        return;
      }

      // Handle Shift + ?
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }

      // Handle Shift + > or . (Speed up)
      if (e.shiftKey && (e.key === ">" || e.key === ".")) {
        e.preventDefault();
        const currentRate = stateRef.current.playbackRate;
        const newRate = Math.min(currentRate + 0.25, 4.0);
        store.setPlaybackRate(newRate);
        setSpeedHUD({ speed: newRate, key: Date.now() });
        return;
      }

      // Handle Shift + < or , (Speed down)
      if (e.shiftKey && (e.key === "<" || e.key === ",")) {
        e.preventDefault();
        const currentRate = stateRef.current.playbackRate;
        const newRate = Math.max(currentRate - 0.25, 0.25);
        store.setPlaybackRate(newRate);
        setSpeedHUD({ speed: newRate, key: Date.now() });
        return;
      }

      // Handle Space long-press hold
      if (e.key === " ") {
        e.preventDefault();
        if (e.repeat) return;

        holdTimeoutRef.current = setTimeout(() => {
          is2xActiveRef.current = true;
          setIsHolding2x(true);
          originalSpeedRef.current = stateRef.current.playbackRate;
          store.setPlaybackRate(2);
        }, 350);
        return;
      }

      const currentState = stateRef.current;

      switch (e.key.toLowerCase()) {
        case "k":
          e.preventDefault();
          if (currentState.paused) {
            store.play();
            setFeedback({ type: "play", key: Date.now() });
          } else {
            store.pause();
            setFeedback({ type: "pause", key: Date.now() });
          }
          break;
        case "f":
          e.preventDefault();
          if (currentState.fullscreen) store.exitFullscreen();
          else store.requestFullscreen();
          break;
        case "m":
          e.preventDefault();
          store.toggleMuted();
          break;
        case "p":
          e.preventDefault();
          if (currentState.pip) store.exitPictureInPicture();
          else store.requestPictureInPicture();
          break;
        case "c":
          e.preventDefault();
          handleSubtitleToggle();
          break;
        case "t":
          e.preventDefault();
          if (isEnableCinemaMode) {
            setIsCinemaMode((prev) => !prev);
          }
          break;
        case "arrowright":
          e.preventDefault();
          store.seek(Math.min(currentState.currentTime + 5, currentState.duration));
          break;
        case "arrowleft":
          e.preventDefault();
          store.seek(Math.max(currentState.currentTime - 5, 0));
          break;
        case "arrowup":
          e.preventDefault();
          store.setVolume(Math.min(currentState.volume + 0.05, 1));
          break;
        case "arrowdown":
          e.preventDefault();
          store.setVolume(Math.max(currentState.volume - 0.05, 0));
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!store.target) {
        return;
      }
      if (isTyping(e.target)) {
        return;
      }

      if (e.key === " ") {
        e.preventDefault();
        if (holdTimeoutRef.current) {
          clearTimeout(holdTimeoutRef.current);
          holdTimeoutRef.current = null;
        }
        if (is2xActiveRef.current) {
          store.setPlaybackRate(originalSpeedRef.current);
          is2xActiveRef.current = false;
          setIsHolding2x(false);
        } else {
          if (stateRef.current.paused) {
            store.play();
            setFeedback({ type: "play", key: Date.now() });
          } else {
            store.pause();
            setFeedback({ type: "pause", key: Date.now() });
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [store, isEnableCinemaMode, hasSubtitles, isSubtitlesActive]);

  // Click hold handling on the player surface
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click

    holdTimeoutRef.current = setTimeout(() => {
      is2xActiveRef.current = true;
      setIsHolding2x(true);
      originalSpeedRef.current = stateRef.current.playbackRate;
      store.setPlaybackRate(2);
    }, 350);
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    // Prevent triggering if clicked on controls or timeline
    if (
      (e.target as HTMLElement).closest("button") ||
      (e.target as HTMLElement).closest("input") ||
      (e.target as HTMLElement).closest("[role='dialog']") ||
      (e.target as HTMLElement).closest(".pointer-events-auto")
    ) {
      if (holdTimeoutRef.current) {
        clearTimeout(holdTimeoutRef.current);
        holdTimeoutRef.current = null;
      }
      return;
    }

    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }

    if (is2xActiveRef.current) {
      store.setPlaybackRate(originalSpeedRef.current);
      is2xActiveRef.current = false;
      setIsHolding2x(false);
    } else {
      // If controls are hidden, first tap/click just shows them
      if (!showControls) {
        setShowControls(true);
        resetControlsTimeout();
      } else {
        if (state.paused) {
          store.play();
          setFeedback({ type: "play", key: Date.now() });
        } else {
          store.pause();
          setFeedback({ type: "pause", key: Date.now() });
        }
        resetControlsTimeout();
      }
    }
  };

  const handleMouseLeave = () => {
    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }
    if (is2xActiveRef.current) {
      store.setPlaybackRate(originalSpeedRef.current);
      is2xActiveRef.current = false;
      setIsHolding2x(false);
    }
    // Hide controls when mouse leaves container (unless paused)
    if (!state.paused) {
      setShowControls(false);
    }
  };

  const containerClasses = cn(
    "relative group w-full aspect-video rounded-2xl overflow-hidden bg-zinc-950 shadow-2xl select-none transition-all duration-300",
    isCinemaMode &&
      "w-screen max-w-none md:left-1/2 md:-translate-x-1/2 md:relative z-40 rounded-none aspect-[21/9]",
    className
  );

  const isDash =
    !!encryption ||
    type === "application/dash+xml" ||
    src.endsWith(".mpd") ||
    src.includes(".mpd?");
  const isHls = !isDash && (src.endsWith(".m3u8") || src.includes(".m3u8"));

  return (
    <Player.Container
      ref={setContainerEl}
      className={containerClasses}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Session Watermark (Intermittent random hop every 8-10s at 15-20% opacity) */}
      {encryption && userEmail && <SessionWatermark email={userEmail} />}

      {/* Dedicated Session Superseded Overlay */}
      {isSessionSuperseded && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/90 backdrop-blur-md p-6 text-center animate-in fade-in duration-300 pointer-events-auto">
          <div className="w-14 h-14 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mb-4 text-amber-400">
            <AlertCircle className="w-7 h-7" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">Session Superseded</h3>
          <p className="text-xs text-zinc-300 max-w-md mb-6 leading-relaxed">
            Playback was paused because your account is active on another device or browser tab. Only one active stream is permitted per account.
          </p>
          <button
            onClick={handleReclaimSession}
            className="cursor-pointer inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-600/20 transition-all hover:scale-105 active:scale-95"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Resume Here</span>
          </button>
        </div>
      )}

      {/* Browser CDM Compatibility Notice */}
      {isCdmUnsupported && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/90 backdrop-blur-md p-6 text-center animate-in fade-in duration-300 pointer-events-auto">
          <div className="w-14 h-14 rounded-2xl bg-red-500/15 border border-red-500/30 flex items-center justify-center mb-4 text-red-400">
            <AlertTriangle className="w-7 h-7" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">Browser Not Supported for Clear Key EME</h3>
          <p className="text-xs text-zinc-300 max-w-md mb-3 leading-relaxed">
            Clear Key Encrypted Media Extensions (EME) requires a Chromium-based browser (Google Chrome, Microsoft Edge, Brave) or Mozilla Firefox. Playback is unsupported on Safari and iOS WebKit.
          </p>
          <div className="text-[11px] text-zinc-400 max-w-md font-mono bg-zinc-900/80 px-3 py-2 rounded-lg border border-zinc-800">
            Shaka Error 6001: Key system 'org.w3.clearkey' is unavailable in this environment.
          </div>
        </div>
      )}

      {/* Click-to-play surface & Hold-to-speedup (z-10) */}
      <div
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onContextMenu={(e) => e.preventDefault()}
        className="absolute inset-0 cursor-pointer z-10"
      />

      {isDash ? (
        isLoadingKeys ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-3">
            <div className="w-8 h-8 border-2 border-zinc-700 border-t-white rounded-full animate-spin" />
            <p className="text-xs text-zinc-400 font-mono">Initializing secure player...</p>
          </div>
        ) : (
          <ShakaVideo
            source={{
              src,
              type: "application/dash+xml",
              drm: encryption
                ? {
                    [encryption.keySystem]: {
                      licenseUrl: encryption.licenseUrl,
                    },
                  }
                : undefined,
              engine: {
                shaka: {
                  drm: {
                    ...(clearKeys ? { clearKeys } : {}),
                    delayLicenseRequestUntilPlayed: true,
                  },
                },
              },
            }}
            poster={poster}
            className="w-full h-full object-contain"
            playsInline
            onWaiting={() => setIsBuffering(true)}
            onPlaying={() => setIsBuffering(false)}
            onSeeking={() => setIsBuffering(true)}
            onSeeked={() => setIsBuffering(false)}
            onCanPlay={() => setIsBuffering(false)}
            onCanPlayThrough={() => setIsBuffering(false)}
            onLoadedData={() => setIsBuffering(false)}
            onPause={() => setIsBuffering(false)}
            onAbort={() => setIsBuffering(false)}
            onEmptied={() => setIsBuffering(false)}
            onError={handleCustomError}
          />
        )
      ) : isHls ? (
        <HlsJsVideo
          src={src}
          poster={poster}
          className="w-full h-full object-contain"
          playsInline
          onWaiting={() => setIsBuffering(true)}
          onPlaying={() => setIsBuffering(false)}
          onSeeking={() => setIsBuffering(true)}
          onSeeked={() => setIsBuffering(false)}
          onCanPlay={() => setIsBuffering(false)}
          onCanPlayThrough={() => setIsBuffering(false)}
          onLoadedData={() => setIsBuffering(false)}
          onPause={() => setIsBuffering(false)}
          onAbort={() => setIsBuffering(false)}
          onEmptied={() => setIsBuffering(false)}
          onError={handleCustomError}
        />
      ) : (
        <Video
          src={src}
          poster={poster}
          className="w-full h-full object-contain"
          playsInline
          onWaiting={() => setIsBuffering(true)}
          onPlaying={() => setIsBuffering(false)}
          onSeeking={() => setIsBuffering(true)}
          onSeeked={() => setIsBuffering(false)}
          onCanPlay={() => setIsBuffering(false)}
          onCanPlayThrough={() => setIsBuffering(false)}
          onLoadedData={() => setIsBuffering(false)}
          onPause={() => setIsBuffering(false)}
          onAbort={() => setIsBuffering(false)}
          onEmptied={() => setIsBuffering(false)}
          onError={handleCustomError}
        />
      )}

      {/* Speed up hold Banner */}
      {isHolding2x && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-md px-4 py-1.5 rounded-full text-white text-xs font-semibold tracking-wider flex items-center gap-1.5 z-40 transition-all duration-200 animate-in fade-in zoom-in-95">
          <div className="w-2 h-2 rounded-full bg-dv-primary animate-pulse" />
          <span>2.0x SPEED</span>
        </div>
      )}

      {/* Speed Change Hotkey HUD Banner */}
      {speedHUD && !isHolding2x && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/80 backdrop-blur-md px-4 py-1.5 rounded-full text-white text-xs font-semibold tracking-wider flex items-center gap-1.5 z-40 transition-all duration-200 animate-in fade-in zoom-in-95">
          <span>SPEED: {speedHUD.speed.toFixed(2).replace(/\.00$/, "")}x</span>
        </div>
      )}

      {/* Premium Buffering Dual-Ring Glass Loader Spinner */}
      {isBuffering && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/25 backdrop-blur-[1px] pointer-events-none z-25 animate-in fade-in duration-300">
          <div className="relative w-16 h-16 flex items-center justify-center">
            {/* Outer spinning ring (clockwise) */}
            <div className="absolute inset-0 border-4 border-white/5 border-t-dv-primary rounded-full animate-spin [animation-duration:1.1s]" />
            {/* Inner counter-rotating ring (counter-clockwise) */}
            <div className="w-10 h-10 border-4 border-dv-primary/10 border-t-white rounded-full animate-spin [animation-duration:0.8s] [animation-direction:reverse]" />
          </div>
        </div>
      )}

      {/* Flashing Center Play/Pause Feedback (restricted to user-interactive clicks & hotkeys) */}
      {feedback && !isBuffering && (
        <div
          key={feedback.key}
          className="absolute inset-0 flex items-center justify-center pointer-events-none z-20"
        >
          <div className="bg-black/60 text-white p-5 rounded-full animate-scale-fade flex items-center justify-center">
            {feedback.type === "play" ? (
              <Play className="w-10 h-10 fill-current text-white" />
            ) : (
              <Pause className="w-10 h-10 fill-current text-white" />
            )}
          </div>
        </div>
      )}

      {/* Custom Controls Overlay */}
      <div
        className={cn(
          "absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/95 via-transparent to-black/40 p-4 transition-opacity duration-300 z-30 pointer-events-none",
          showControls ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        )}
      >
        {/* Top Row: Keyboard Shortcut Info Button */}
        <div className="flex justify-end w-full pointer-events-auto">
          <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
            <PlayerTooltip content="Keyboard Shortcuts" shortcut="Shift+?">
              <DialogTrigger
                render={
                  <button className="p-2 text-white/80 hover:text-dv-primary hover:scale-110 active:scale-95 transition-all duration-200 cursor-pointer">
                    <Keyboard className="w-5 h-5" />
                  </button>
                }
              />
            </PlayerTooltip>

            <DialogContent
              container={containerEl}
              className="bg-zinc-950 border border-white/10 text-white rounded-2xl max-w-sm p-6 shadow-2xl z-50"
            >
              <DialogHeader className="mb-4">
                <DialogTitle className="text-base font-bold flex items-center gap-2">
                  <Info className="w-5 h-5 text-dv-primary" /> Keyboard Shortcuts
                </DialogTitle>
                <DialogDescription className="text-white/60 text-xs">
                  Quickly control your player with these hotkeys:
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2.5 text-xs text-white/90">
                <div className="flex justify-between items-center py-1.5 border-b border-white/5">
                  <span>Play / Pause</span>
                  <kbd className="bg-white/10 px-2 py-0.5 rounded font-mono text-[10px]">
                    Space / K
                  </kbd>
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-white/5">
                  <span>Fullscreen</span>
                  <kbd className="bg-white/10 px-2 py-0.5 rounded font-mono text-[10px]">F</kbd>
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-white/5">
                  <span>Mute / Unmute</span>
                  <kbd className="bg-white/10 px-2 py-0.5 rounded font-mono text-[10px]">M</kbd>
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-white/5">
                  <span>Picture-in-Picture</span>
                  <kbd className="bg-white/10 px-2 py-0.5 rounded font-mono text-[10px]">P</kbd>
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-white/5">
                  <span>Subtitles</span>
                  <kbd className="bg-white/10 px-2 py-0.5 rounded font-mono text-[10px]">C</kbd>
                </div>
                {isEnableCinemaMode && (
                  <div className="flex justify-between items-center py-1.5 border-b border-white/5">
                    <span>Cinema Mode</span>
                    <kbd className="bg-white/10 px-2 py-0.5 rounded font-mono text-[10px]">T</kbd>
                  </div>
                )}
                <div className="flex justify-between items-center py-1.5 border-b border-white/5">
                  <span>Playback Speed Up / Down</span>
                  <kbd className="bg-white/10 px-2 py-0.5 rounded font-mono text-[10px]">
                    Shift + &gt; / &lt;
                  </kbd>
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-white/5">
                  <span>Seek Back / Forward</span>
                  <kbd className="bg-white/10 px-2 py-0.5 rounded font-mono text-[10px]">← / →</kbd>
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-white/5">
                  <span>Volume Up / Down</span>
                  <kbd className="bg-white/10 px-2 py-0.5 rounded font-mono text-[10px]">↑ / ↓</kbd>
                </div>
                <div className="flex justify-between items-center py-1.5">
                  <span>Shortcuts Help Dialog</span>
                  <kbd className="bg-white/10 px-2 py-0.5 rounded font-mono text-[10px]">
                    Shift + ?
                  </kbd>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Bottom Controls */}
        <div className="flex flex-col gap-2 w-full pointer-events-auto">
          {/* Timeline */}
          <Timeline />

          {/* Bottom Row controls */}
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-1">
              {onPrev && (
                <PlayerTooltip content="Previous Video">
                  <button
                    onClick={onPrev}
                    className="p-2 text-white/90 hover:text-dv-primary hover:scale-110 active:scale-95 transition-all duration-200"
                    title="Previous"
                  >
                    <SkipBack className="w-5 h-5 fill-current" />
                  </button>
                </PlayerTooltip>
              )}

              <PlayPauseButton />

              {onNext && (
                <PlayerTooltip content="Next Video">
                  <button
                    onClick={onNext}
                    className="p-2 text-white/90 hover:text-dv-primary hover:scale-110 active:scale-95 transition-all duration-200"
                    title="Next"
                  >
                    <SkipForward className="w-5 h-5 fill-current" />
                  </button>
                </PlayerTooltip>
              )}

              <VolumeControl />
              <TimeDisplay />
            </div>

            {/* Right Controls */}
            <div className="flex items-center gap-1">
              {hasSubtitles && (
                <PlayerTooltip
                  content={isSubtitlesActive ? "Turn off captions" : "Turn on captions"}
                  shortcut="C"
                >
                  <button
                    onClick={handleSubtitleToggle}
                    className={`p-2 transition-all duration-200 hover:scale-110 active:scale-95 ${
                      isSubtitlesActive ? "text-dv-primary" : "text-white/90 hover:text-dv-primary"
                    }`}
                  >
                    <Subtitles className="w-5 h-5" />
                  </button>
                </PlayerTooltip>
              )}

              <SettingsMenu />

              {isEnableCinemaMode && (
                <PlayerTooltip content={isCinemaMode ? "Default view" : "Cinema mode"} shortcut="T">
                  <button
                    onClick={() => setIsCinemaMode((prev) => !prev)}
                    className={`p-2 transition-all duration-200 hover:scale-110 active:scale-95 ${
                      isCinemaMode ? "text-dv-primary" : "text-white/90 hover:text-dv-primary"
                    }`}
                  >
                    <RectangleHorizontal className="w-5 h-5" />
                  </button>
                </PlayerTooltip>
              )}

              <PiPFullscreenControls />
            </div>
          </div>
        </div>
      </div>

      <ResumePlaybackTracker
        src={src}
        initialTime={initialTime}
        onProgressUpdate={onProgressUpdate}
      />
    </Player.Container>
  );
}

export const DvideoPlayer = memo(function DvideoPlayer(props: Props) {
  return (
    <Player.Provider>
      <DvideoPlayerInner {...props} />
    </Player.Provider>
  );
});
