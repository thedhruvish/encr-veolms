import React from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, Play } from "lucide-react";

import { DvideoPlayer } from "./dvideo";

export interface VideoPlayerModalProps {
  isOpen: boolean;
  onClose: () => void;
  videoUrl: string;
  title: string;
  hlsUrl?: string | null;
}

export function isYouTubeUrl(url: string): boolean {
  if (!url) return false;
  return (
    url.includes("youtube.com") || url.includes("youtu.be") || url.includes("youtube-nocookie.com")
  );
}

export function getYouTubeEmbedUrl(url: string): string {
  if (!url) return "";
  if (url.includes("/embed/")) {
    return url;
  }
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname.includes("youtube.com")) {
      const videoId = urlObj.searchParams.get("v");
      if (videoId) {
        return `https://www.youtube.com/embed/${videoId}?autoplay=1`;
      }
    }
    if (urlObj.hostname.includes("youtu.be")) {
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

export function VideoPlayerModal({
  isOpen,
  onClose,
  videoUrl,
  title,
  hlsUrl,
}: VideoPlayerModalProps) {
  const [activeUrl, setActiveUrl] = React.useState(hlsUrl || videoUrl);

  React.useEffect(() => {
    setActiveUrl(hlsUrl || videoUrl);
  }, [hlsUrl, videoUrl]);

  const handlePlayerError = () => {
    if (hlsUrl && activeUrl === hlsUrl && videoUrl) {
      console.warn("HLS stream failed to play, falling back to direct videoUrl:", videoUrl);
      setActiveUrl(videoUrl);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/80 backdrop-blur-sm cursor-pointer"
          />

          {/* Dialog container */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="relative w-full max-w-4xl bg-zinc-950 rounded-2xl border border-zinc-800 shadow-2xl overflow-hidden z-10 text-white"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center">
                  <Play className="w-3 h-3 text-white fill-current" />
                </div>
                <h3 className="font-bold text-sm text-white line-clamp-1">{title}</h3>
              </div>
              <button
                onClick={onClose}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition-colors cursor-pointer"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Video wrapper */}
            <div className="relative aspect-video bg-zinc-900 flex items-center justify-center">
              {isYouTubeUrl(videoUrl) ? (
                <iframe
                  src={getYouTubeEmbedUrl(videoUrl)}
                  title={title}
                  className="w-full h-full border-0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <DvideoPlayer src={activeUrl} onError={handlePlayerError} />
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
