import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import {
  GENERATED_DEFAULT_VIDEO_ID,
  GENERATED_KEY_STORE,
  GENERATED_VIDEOS,
} from "./registry.generated";
import { createDb } from "./db";

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

// Fallback in-memory catalog (synced to DB via scripts/seed-db.ts)
const VIDEOS: Record<string, VideoRecord> = {
  ...GENERATED_VIDEOS,
};

const KEY_STORE: Record<string, string> = {
  ...GENERATED_KEY_STORE,
};

const DEFAULT_VIDEO_ID =
  GENERATED_DEFAULT_VIDEO_ID || Object.keys(VIDEOS)[0] || "";

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

// DB health check – pings Neon and returns table list
app.get("/api/db-health", async (c) => {
  try {
    const db = createDb(c.env);
    const rows = await db`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;
    return c.json({ ok: true, tables: rows.map((r: any) => r.table_name) });
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message ?? String(err) }, 500);
  }
});

// Helper for handling login — queries Neon users table
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

  const db = createDb(c.env);
  const users = await db`
    SELECT id, email, name, role
    FROM users
    WHERE LOWER(email) = ${normalizedEmail}
    LIMIT 1
  `;
  const user = users[0];

  if (!user) {
    return c.json(
      {
        error: `Unauthorized email. User '${normalizedEmail}' not found in database.`,
      },
      401
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_EXPIRY_SECONDS;

  const payload = {
    email: user.email,
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
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      exp,
      expiresAt: new Date(exp * 1000).toISOString(),
      expiresInSeconds: TOKEN_EXPIRY_SECONDS,
    },
  });
};

app.post("/login", handleLogin);
app.post("/api/login", handleLogin);

// Helper for handling logout — clears cookie and active DB session
const handleLogout = async (c: any) => {
  const payload = await getAuthenticatedPayload(c);
  if (payload?.email) {
    try {
      const db = createDb(c.env);
      await db`
        DELETE FROM sessions
        WHERE user_id IN (
          SELECT id FROM users WHERE LOWER(email) = ${payload.email.toLowerCase()}
        )
      `;
    } catch (err) {
      console.warn("Could not delete session from DB on logout:", err);
    }
  }

  deleteCookie(c, "token", {
    path: "/",
  });

  return c.json({
    success: true,
    message: "Logged out successfully. JWT and active session cleared.",
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
 * Validates: signature, expiry, videoId match, and single-active-session consistency via PostgreSQL.
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

    // Single active session enforcement from Neon DB:
    // If a subsequent stream request occurred for this user, a new sessionId was assigned.
    const db = createDb(c.env);
    const [activeSession] = await db`
      SELECT s.session_id, s.expires_at
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE LOWER(u.email) = ${payload.email.toLowerCase()}
      LIMIT 1
    `;

    if (!activeSession || activeSession.session_id !== payload.sid) {
      return {
        valid: false,
        status: 401,
        error: "session_superseded",
        message: "Playback session superseded by another device or browser tab.",
      };
    }

    if (new Date(activeSession.expires_at).getTime() < Date.now()) {
      return {
        valid: false,
        status: 401,
        error: "token_expired",
        message: "Playback session token has expired in database.",
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
 * Authenticates login JWT, assigns a new single active session in Neon DB, mints playback JWT (st),
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

  const db = createDb(c.env);
  let requestedVid = c.req.query("id");

  if (!requestedVid) {
    const [firstVideo] = await db`SELECT id FROM videos ORDER BY created_at ASC LIMIT 1`;
    requestedVid = firstVideo?.id || DEFAULT_VIDEO_ID;
  }

  // Look up video and periods from Neon DB (fallback to GENERATED_VIDEOS)
  const [dbVideo] = await db`
    SELECT id, title, manifest_path
    FROM videos
    WHERE id = ${requestedVid}
    LIMIT 1
  `;

  let videoRecord: VideoRecord | undefined;
  if (dbVideo) {
    const periods = await db`
      SELECT period_idx, key_id
      FROM video_key_periods
      WHERE video_id = ${requestedVid}
      ORDER BY period_idx ASC
    `;
    videoRecord = {
      id: dbVideo.id,
      title: dbVideo.title,
      manifestPath: dbVideo.manifest_path,
      periods: periods.map((p: any) => ({
        index: Number(p.period_idx),
        keyId: String(p.key_id),
      })),
    };
  } else if (VIDEOS[requestedVid]) {
    videoRecord = VIDEOS[requestedVid];
  }

  if (!videoRecord) {
    return c.json(
      {
        authenticated: true,
        error: "encrypted_video_not_configured",
        message: "No encrypted video is configured for this video ID.",
      },
      404
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + PLAYBACK_TOKEN_EXPIRY_SECONDS;
  const sessionId = crypto.randomUUID();

  // Enforce single active session: persist in Neon DB sessions table
  const [user] = await db`
    SELECT id FROM users WHERE LOWER(email) = ${payload.email.toLowerCase()} LIMIT 1
  `;
  if (!user) {
    return c.json(
      {
        authenticated: false,
        error: "unauthorized_user",
        message: "User not found in database.",
      },
      401
    );
  }

  const expiresAtIso = new Date(exp * 1000).toISOString();
  await db`
    INSERT INTO sessions (user_id, session_id, expires_at)
    VALUES (${user.id}, ${sessionId}, ${expiresAtIso})
    ON CONFLICT (user_id) DO UPDATE SET
      session_id = EXCLUDED.session_id,
      expires_at = EXCLUDED.expires_at,
      created_at = NOW()
  `;

  const stPayload = {
    email: payload.email,
    vid: videoRecord.id,
    sid: sessionId,
    iat: now,
    exp: exp,
  };

  const st = await sign(stPayload, PLAYBACK_JWT_SECRET, "HS256");

  // Direct R2 bucket delivery: client downloads manifest and encrypted DASH chunks directly from S3_PUBLIC_URL.
  // The decryption keys remain gated by the Clear Key license endpoint on this Worker via Neon DB.
  const manifestUrl = `${getVideoPublicBaseUrl(c)}/${videoRecord.manifestPath}`;

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

// Redirect any legacy /assets/* requests directly to S3_PUBLIC_URL (R2 bucket)
app.on(["GET", "HEAD"], "/assets/*", (c) => {
  const pathname = new URL(c.req.url).pathname;
  const objectKey = pathname.replace(/^\/assets\//, "");
  return c.redirect(`${getVideoPublicBaseUrl(c)}/${objectKey}`, 301);
});

/**
 * Route: POST /license/clearkey and /api/license/clearkey
 * W3C Clear Key License Exchange (CENC-AES-CTR).
 * Validates playback token and returns key set for requested KIDs, tracking single-use locks in Neon DB.
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

  const db = createDb(c.env);

  let allowedKids = new Set<string>();
  if (vid) {
    const periods = await db`
      SELECT key_id FROM video_key_periods WHERE video_id = ${vid}
    `;
    if (periods.length > 0) {
      allowedKids = new Set(periods.map((p: any) => String(p.key_id).toLowerCase()));
    } else if (VIDEOS[vid]) {
      allowedKids = new Set(VIDEOS[vid].periods.map((p) => p.keyId.toLowerCase()));
    }
  }

  // Check which KIDs have already been issued to this session in the database
  const issuedRows = await db`
    SELECT key_id FROM issued_license_keys WHERE session_id = ${sid}
  `;
  const issuedKidSet = new Set(
    issuedRows.map((r: any) => String(r.key_id).toLowerCase())
  );

  const keys: { kty: string; k: string; kid: string }[] = [];

  for (const kidB64Url of body.kids) {
    const kidHex = base64UrlToHex(kidB64Url).toLowerCase();

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

    // Single-use lock in DB: check if already issued
    if (issuedKidSet.has(kidHex)) {
      return c.json(
        {
          error: "key_already_issued",
          message: `KID ${kidHex} was already issued to this session.`,
        },
        403
      );
    }

    // Look up key from drm_keys table in DB (with fallback to KEY_STORE)
    const [keyRow] = await db`
      SELECT key_val FROM drm_keys WHERE LOWER(key_id) = ${kidHex} LIMIT 1
    `;
    const keyHex = keyRow?.key_val || KEY_STORE[kidHex];
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

  // Persist all issued keys in DB for this session
  for (const { kid: kidB64Url } of keys) {
    const kidHex = base64UrlToHex(kidB64Url).toLowerCase();
    await db`
      INSERT INTO issued_license_keys (session_id, key_id)
      VALUES (${sid}, ${kidHex})
      ON CONFLICT (session_id, key_id) DO NOTHING
    `;
  }

  return c.json({
    keys,
    type: body.type || "temporary",
  });
};

app.post("/license/clearkey", handleClearKeyLicense);
app.post("/api/license/clearkey", handleClearKeyLicense);

export default app;
