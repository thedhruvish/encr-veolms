import { useState, useEffect } from "react";

interface Props {
  email: string;
}

const POSITIONS = [
  { top: "8%", left: "6%", right: "auto", bottom: "auto" },
  { top: "10%", right: "8%", left: "auto", bottom: "auto" },
  { bottom: "20%", left: "8%", top: "auto", right: "auto" },
  { bottom: "22%", right: "8%", top: "auto", left: "auto" },
  { top: "35%", left: "12%", right: "auto", bottom: "auto" },
  { top: "45%", right: "14%", left: "auto", bottom: "auto" },
  { bottom: "36%", left: "20%", top: "auto", right: "auto" },
  { top: "25%", right: "24%", left: "auto", bottom: "auto" },
];

function formatTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function SessionWatermark({ email }: Props) {
  const [posIdx, setPosIdx] = useState(0);
  const [timeStr, setTimeStr] = useState(formatTimestamp);

  // Live timestamp update
  useEffect(() => {
    const timer = setInterval(() => {
      setTimeStr(formatTimestamp());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Intermittent random hop every 8-10 seconds
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    const scheduleNextHop = () => {
      const delayMs = 8000 + Math.random() * 2000; // 8 to 10 seconds
      timeoutId = setTimeout(() => {
        setPosIdx((prev) => {
          let next = Math.floor(Math.random() * POSITIONS.length);
          if (next === prev) {
            next = (next + 1) % POSITIONS.length;
          }
          return next;
        });
        scheduleNextHop();
      }, delayMs);
    };

    scheduleNextHop();
    return () => clearTimeout(timeoutId);
  }, []);

  const pos = POSITIONS[posIdx];

  return (
    <div
      style={{
        position: "absolute",
        top: pos.top,
        left: pos.left,
        right: pos.right,
        bottom: pos.bottom,
        opacity: 0.18,
      }}
      className="pointer-events-none select-none z-25 font-mono text-[11px] sm:text-xs text-white tracking-wider flex items-center gap-1.5 transition-all duration-700 ease-in-out"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-white/40 inline-block animate-pulse" />
      <span>
        {email} • {timeStr}
      </span>
    </div>
  );
}
