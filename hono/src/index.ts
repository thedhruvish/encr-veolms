import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import {
  GENERATED_DEFAULT_VIDEO_ID,
  GENERATED_KEY_STORE,
  GENERATED_VIDEOS,
} from "./registry.generated";
export interface VideoRecord {
  id: string;
  title: string;
  manifestPath: string;
  periods: { index: number; keyId: string /* hex */ }[];
}

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Auth and Session Secrets
const JWT_SECRET = "veolms-secure-jwt-token-secret-key-2026";
const TOKEN_EXPIRY_SECONDS = 20 * 60; // 20 minutes (1200 seconds)
const ALLOWED_EMAIL = "dhruvish@gmail.com";

// Playback Token & EME Configuration
const PLAYBACK_JWT_SECRET = "veolms-playback-clearkey-secret-2026";
const PLAYBACK_TOKEN_EXPIRY_SECONDS = 30 * 60; // 30 minutes playback session token
const ALLOWED_ORIGIN = "https://encr-veolms.dhruvish.in";
const LOCAL_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
]);
const VIDEO_PUBLIC_BASE_URL = "https://protech-assets.dhruvish.in";

const VIDEOS: Record<string, VideoRecord> = {
  ...GENERATED_VIDEOS,
};

const KEY_STORE: Record<string, string> = {
  ...GENERATED_KEY_STORE,
};

const DEFAULT_VIDEO_ID =
  GENERATED_DEFAULT_VIDEO_ID || Object.keys(VIDEOS)[0] || "";

/**
 * Single Active Session Tracker:
 * Maps user email -> active sessionId (UUID).
 *
 * NOTE ON MULTI-REGION DEPLOYMENTS (Phase 2h caveat):
 * ACTIVE_SESSION is stored in memory for zero-dependency local development and single-isolate
 * execution. In a production multi-region Cloudflare Workers deployment where worker isolates
 * do not share RAM across edge datacenters, this store should be migrated to Cloudflare KV,
 * Hyperdrive, or a Durable Object to maintain global single-session consistency.
 */
const ACTIVE_SESSION: Record<string, string> = {};

/**
 * Single-use license lock: `${sessionId}:${kidHex}` entries already issued to a session.
 * Same in-memory/single-isolate caveat as ACTIVE_SESSION above - fine for local dev,
 * would need KV/a Durable Object to hold across a real multi-region deployment.
 */
const ISSUED_LICENSE_KEYS = new Set<string>();

// Helper: Origin and Referer validation
function isOriginAllowed(originOrReferer: string | undefined): boolean {
  if (!originOrReferer) return false;
  try {
    const url = new URL(originOrReferer);
    const origin = url.origin;
    return origin === ALLOWED_ORIGIN || LOCAL_ORIGINS.has(origin);
  } catch {
    return false;
  }
}

// Enable tightened CORS strictly reflecting allowed origins
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return ALLOWED_ORIGIN;
      return isOriginAllowed(origin) ? origin : ALLOWED_ORIGIN;
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Range"],
    exposeHeaders: [
      "Set-Cookie",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "ETag",
    ],
    credentials: true,
  })
);

app.get("/message", (c) => {
  return c.text("Hello Hono!");
});

// Helper for handling login
const handleLogin = async (c: any) => {
  let email: string | undefined;

  try {
    const body = await c.req.json();
    email = body?.email;
  } catch {
    return c.json({ error: "Invalid request. Email is required in JSON body." }, 400);
  }

  if (!email || typeof email !== "string" || !email.trim()) {
    return c.json({ error: "Email is required to log in." }, 400);
  }

  const normalizedEmail = email.trim().toLowerCase();

  if (normalizedEmail !== ALLOWED_EMAIL.toLowerCase()) {
    return c.json(
      {
        error: `Unauthorized email. Without a database, please use '${ALLOWED_EMAIL}' to log in.`,
      },
      401
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_EXPIRY_SECONDS;

  const payload = {
    email: normalizedEmail,
    iat: now,
    exp: exp,
  };

  const token = await sign(payload, JWT_SECRET, "HS256");

  // Set JWT cookie (valid for 20 minutes)
  setCookie(c, "token", token, {
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
    maxAge: TOKEN_EXPIRY_SECONDS,
  });

  return c.json({
    success: true,
    message: "Login successful",
    token,
    user: {
      email: normalizedEmail,
      exp,
      expiresAt: new Date(exp * 1000).toISOString(),
      expiresInSeconds: TOKEN_EXPIRY_SECONDS,
    },
  });
};

app.post("/login", handleLogin);
app.post("/api/login", handleLogin);

// Helper for handling logout
const handleLogout = (c: any) => {
  deleteCookie(c, "token", {
    path: "/",
  });

  return c.json({
    success: true,
    message: "Logged out successfully. JWT cleared.",
  });
};

app.post("/logout", handleLogout);
app.get("/logout", handleLogout);
app.post("/api/logout", handleLogout);
app.get("/api/logout", handleLogout);

// Helper for getting and verifying login JWT from request
const getAuthenticatedPayload = async (c: any) => {
  let token: string | undefined;

  const authHeader = c.req.header("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  }

  if (!token) {
    token = getCookie(c, "token");
  }

  if (!token) {
    return null;
  }

  try {
    const payload = (await verify(token, JWT_SECRET, "HS256")) as {
      email?: string;
      exp?: number;
      iat?: number;
    };

    if (!payload || !payload.exp) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
};

// Helper for handling /me
const handleMe = async (c: any) => {
  const payload = await getAuthenticatedPayload(c);

  if (!payload || !payload.email || !payload.exp) {
    return c.json(
      {
        authenticated: false,
        error: "Unauthorized. Missing, invalid, or expired JWT token.",
      },
      401
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresInSeconds = Math.max(0, payload.exp - now);

  return c.json({
    authenticated: true,
    email: payload.email,
    exp: payload.exp,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    expiresInSeconds,
  });
};

app.get("/me", handleMe);
app.get("/api/me", handleMe);

/**
 * Validate playback session token (?st= or Authorization: Bearer <st>)
 * Validates: signature, expiry, videoId match, and single-active-session consistency.
 */
async function validatePlaybackToken(c: any, expectedVid?: string) {
  let st = c.req.query("st");
  if (!st) {
    const authHeader = c.req.header("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      st = authHeader.slice(7).trim();
    }
  }

  if (!st) {
    return {
      valid: false,
      status: 401,
      error: "missing_token",
      message: "Missing playback authorization token (?st= parameter or Bearer header).",
    };
  }

  try {
    const payload = (await verify(st, PLAYBACK_JWT_SECRET, "HS256")) as {
      email?: string;
      vid?: string;
      sid?: string;
      exp?: number;
      iat?: number;
    };

    if (!payload || !payload.email || !payload.vid || !payload.sid || !payload.exp) {
      return {
        valid: false,
        status: 401,
        error: "invalid_token",
        message: "Malformed playback session token.",
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return {
        valid: false,
        status: 401,
        error: "token_expired",
        message: "Playback session token has expired.",
      };
    }

    if (expectedVid && payload.vid !== expectedVid) {
      return {
        valid: false,
        status: 403,
        error: "video_mismatch",
        message: "Playback token is not authorized for this video ID.",
      };
    }

    // Single active session enforcement:
    // If a subsequent login/stream request occurred for this user, a new sessionId was assigned.
    const activeSid = ACTIVE_SESSION[payload.email];
    if (!activeSid || activeSid !== payload.sid) {
      return {
        valid: false,
        status: 401,
        error: "session_superseded",
        message: "Playback session superseded by another device or browser tab.",
      };
    }

    return { valid: true, payload, st };
  } catch (err: any) {
    if (err?.name === "JwtTokenExpired" || String(err?.message).includes("expired")) {
      return {
        valid: false,
        status: 401,
        error: "token_expired",
        message: "Playback session token has expired.",
      };
    }

    return {
      valid: false,
      status: 401,
      error: "invalid_token",
      message: "Invalid playback token signature.",
    };
  }
}

// Pure Web API base64url helpers (guaranteed portable across Cloudflare Workers and Bun)
function base64UrlToHex(b64url: string): string {
  let base64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) base64 += "=";
  const binary = atob(base64);
  let hex = "";
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex.toLowerCase();
}

function hexToBase64Url(hex: string): string {
  let binary = "";
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Route: GET /video and /api/video
 * Authenticates login JWT, assigns a new single active session, mints playback JWT (st),
 * and returns encrypted DASH stream and Clear Key DRM license endpoint.
 */
const handleVideo = async (c: any) => {
  const originHeader = c.req.header("Origin") || c.req.header("Referer");
  if (originHeader && !isOriginAllowed(originHeader)) {
    return c.json({ error: "Forbidden. Origin not permitted." }, 403);
  }

  const payload = await getAuthenticatedPayload(c);

  if (!payload || !payload.email || !payload.exp) {
    return c.json(
      {
        authenticated: false,
        error: "Unauthorized. Missing, invalid, or expired JWT token to access video.",
      },
      401
    );
  }

  const requestedVid = c.req.query("id") || DEFAULT_VIDEO_ID;
  const videoRecord = VIDEOS[requestedVid];

  if (!videoRecord) {
    return c.json(
      {
        authenticated: true,
        error: "encrypted_video_not_configured",
        message: "No encrypted video is configured for this video ID.",
      },
      404,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + PLAYBACK_TOKEN_EXPIRY_SECONDS;
  const sessionId = crypto.randomUUID();

  // Enforce single active session: supersede any prior session for this account
  ACTIVE_SESSION[payload.email] = sessionId;

  const stPayload = {
    email: payload.email,
    vid: videoRecord.id,
    sid: sessionId,
    iat: now,
    exp: exp,
  };

  const st = await sign(stPayload, PLAYBACK_JWT_SECRET, "HS256");

  // Keep the media URL same-origin so the Worker can authorize the manifest and every
  // segment request. The proxy fetches the encrypted bytes from the public R2 domain;
  // the decryption key is still returned only by the gated Clear Key license endpoint.
  const manifestUrl = `/assets/${videoRecord.manifestPath}?st=${encodeURIComponent(st)}`;

  return c.json({
    authenticated: true,
    video: {
      id: videoRecord.id,
      title: videoRecord.title,
      type: "application/dash+xml",
      user: payload.email,
      src: manifestUrl,
      st,
      periodCount: videoRecord.periods.length,
      expiresAt: new Date(exp * 1000).toISOString(),
      expiresInSeconds: PLAYBACK_TOKEN_EXPIRY_SECONDS,
      encryption: {
        scheme: "cenc-aes-ctr",
        keySystem: "org.w3.clearkey",
        licenseUrl: `/license/clearkey?vid=${encodeURIComponent(videoRecord.id)}&st=${encodeURIComponent(st)}`,
      },
    },
  });
};

app.get("/video", handleVideo);
app.get("/api/video", handleVideo);

// Helper to get environment variables from Cloudflare env or process.env
function getEnv(c: any, key: string): string | undefined {
  return c.env?.[key] || (typeof process !== "undefined" ? (process.env as any)?.[key] : undefined);
}

function getVideoPublicBaseUrl(c: any): string {
  return (getEnv(c, "S3_PUBLIC_URL") || VIDEO_PUBLIC_BASE_URL)
    .replace(/['"]/g, "")
    .trim()
    .replace(/\/+$/, "");
}

function getVideoAssetPath(
  urlString: string,
): { videoId: string; objectKey: string } | null {
  const pathname = new URL(urlString).pathname;
  const prefix = "/assets/";
  if (!pathname.startsWith(prefix)) return null;

  const encodedParts = pathname.slice(prefix.length).split("/");
  if (encodedParts.length < 2 || encodedParts.some((part) => !part))
    return null;

  try {
    const parts = encodedParts.map((part) => decodeURIComponent(part));
    if (
      parts.some(
        (part) => !part || part === "." || part === ".." || /[\/\\]/.test(part),
      )
    ) {
      return null;
    }

    return {
      videoId: parts[0],
      objectKey: parts.join("/"),
    };
  } catch {
    return null;
  }
}

function getVideoAssetContentType(objectKey: string): string {
  if (objectKey.endsWith(".mpd")) return "application/dash+xml";
  if (objectKey.endsWith(".m4s")) return "video/mp4";
  return "application/octet-stream";
}

/**
 * Route: GET/HEAD /assets/:id/*
 * Authenticates the playback session, then proxies encrypted DASH bytes from public R2.
 * The R2 object is never treated as a decryption source by this Worker; only the
 * Clear Key license route returns key material to the browser media subsystem.
 */
const handleVideoAsset = async (c: any) => {
  const originHeader = c.req.header("Origin") || c.req.header("Referer");
  if (originHeader && !isOriginAllowed(originHeader)) {
    return c.json({ error: "Forbidden. Origin not permitted." }, 403);
  }

  const asset = getVideoAssetPath(c.req.url);
  if (!asset) return c.text("Not Found", 404);

  const validation = await validatePlaybackToken(c, asset.videoId);
  if (!validation.valid) {
    return c.json(
      { error: validation.error, message: validation.message },
      validation.status as any,
    );
  }

  if (!VIDEOS[asset.videoId]) return c.text("Not Found", 404);

  const encodedKey = asset.objectKey
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const upstreamUrl = `${getVideoPublicBaseUrl(c)}/${encodedKey}`;
  const upstreamHeaders = new Headers();

  for (const headerName of ["Range", "If-None-Match", "If-Modified-Since"]) {
    const value = c.req.header(headerName);
    if (value) upstreamHeaders.set(headerName, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: c.req.method,
      headers: upstreamHeaders,
    });
  } catch {
    return c.json({ error: "video_storage_unavailable" }, 502);
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!key.toLowerCase().startsWith("access-control-")) {
      responseHeaders.set(key, value);
    }
  });
  if (!responseHeaders.has("Content-Type")) {
    responseHeaders.set(
      "Content-Type",
      getVideoAssetContentType(asset.objectKey),
    );
  }
  responseHeaders.set("Cache-Control", "private, no-store, max-age=0");
  responseHeaders.set("X-Content-Type-Options", "nosniff");

  return new Response(c.req.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
};

app.on(["GET", "HEAD"], "/assets/*", handleVideoAsset);

/**
 * Route: POST /license/clearkey and /api/license/clearkey
 * W3C Clear Key License Exchange (CENC-AES-CTR).
 * Validates playback token and returns key set for requested KIDs.
 */
const handleClearKeyLicense = async (c: any) => {
  const originHeader = c.req.header("Origin") || c.req.header("Referer");
  if (originHeader && !isOriginAllowed(originHeader)) {
    return c.json({ error: "Forbidden. Invalid origin." }, 403);
  }

  const vid = c.req.query("vid");
  const validation = await validatePlaybackToken(c, vid);
  if (!validation.valid) {
    return c.json(
      { error: validation.error, message: validation.message },
      validation.status as any
    );
  }
  const sid = validation.payload!.sid as string;

  let body: { kids?: string[]; type?: string };
  try {
    body = await c.req.json();
  } catch {
    try {
      const rawText = await c.req.text();
      body = JSON.parse(rawText);
    } catch {
      return c.json({ error: "Invalid license request body. Expected JSON." }, 400);
    }
  }

  if (!body.kids || !Array.isArray(body.kids)) {
    return c.json({ error: "Missing or invalid 'kids' array in Clear Key request." }, 400);
  }

  const video = vid ? VIDEOS[vid] : undefined;
  const allowedKids = new Set(video?.periods.map((p) => p.keyId.toLowerCase()) || []);

  const keys: { kty: string; k: string; kid: string }[] = [];

  for (const kidB64Url of body.kids) {
    const kidHex = base64UrlToHex(kidB64Url);

    // Verify KID belongs to requested video if vid was provided
    if (allowedKids.size > 0 && !allowedKids.has(kidHex)) {
      return c.json(
        {
          error: "unauthorized_kid",
          message: `Requested KID ${kidHex} does not belong to video ${vid}.`,
        },
        403
      );
    }

    // Single-use lock: this session already pulled this KID's key once. Rejecting the
    // repeat blocks a copied license-request URL being replayed later by someone who
    // isn't the live session - it does not (and cannot) stop the legitimate session
    // from reading its own already-issued key in DevTools.
    const usageKey = `${sid}:${kidHex}`;
    if (ISSUED_LICENSE_KEYS.has(usageKey)) {
      return c.json(
        {
          error: "key_already_issued",
          message: `KID ${kidHex} was already issued to this session.`,
        },
        403
      );
    }

    const keyHex = KEY_STORE[kidHex];
    if (!keyHex) {
      return c.json(
        { error: "key_not_found", message: `Key not found for KID ${kidHex}` },
        404
      );
    }

    const keyB64Url = hexToBase64Url(keyHex);
    keys.push({
      kty: "oct",
      k: keyB64Url,
      kid: kidB64Url,
    });
  }

  // Only mark KIDs as issued after the whole batch validated successfully, so a
  // partially-invalid request never burns a still-unissued key.
  for (const { kid: kidB64Url } of keys) {
    ISSUED_LICENSE_KEYS.add(`${sid}:${base64UrlToHex(kidB64Url)}`);
  }

  return c.json({
    keys,
    type: body.type || "temporary",
  });
};

app.post("/license/clearkey", handleClearKeyLicense);
app.post("/api/license/clearkey", handleClearKeyLicense);

export default app;
