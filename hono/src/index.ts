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

// Cap on how many times one session may re-request the same KID. Shaka can
// legitimately re-fetch a KID within a session (e.g. seeking back reopens a
// closed MediaKeySession), so this rate-limits rather than hard-blocking —
// it's meant to catch key-scraping loops, not normal playback.
const MAX_KEY_REISSUES_PER_SESSION = 5;
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
    if (origin === ALLOWED_ORIGIN || LOCAL_ORIGINS.has(origin)) {
      return true;
    }
    if (url.hostname === "dhruvish.in" || url.hostname.endsWith(".dhruvish.in")) {
      return true;
    }
    return false;
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
  if (/^[0-9a-fA-F]{32}$/.test(b64url)) {
    return b64url.toLowerCase();
  }
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

  // Fires immediately - it only needs the JWT's email, not the resolved video
  // id, so it runs concurrently with video lookup instead of waiting behind
  // it. Neon's HTTP driver pays real latency per round-trip, so overlapping
  // independent queries (rather than a chain of sequential awaits) matters.
  const userPromise = db`
    SELECT id FROM users WHERE LOWER(email) = ${payload.email.toLowerCase()} LIMIT 1
  `;

  if (!requestedVid) {
    const [firstVideo] = await db`SELECT id FROM videos ORDER BY created_at ASC LIMIT 1`;
    requestedVid = firstVideo?.id || DEFAULT_VIDEO_ID;
  }

  // Video row and its key periods are independent of each other too - run together.
  const [dbVideoRows, periodRows, userRows] = await Promise.all([
    db`SELECT id, title, manifest_path FROM videos WHERE id = ${requestedVid} LIMIT 1`,
    db`SELECT period_idx, key_id FROM video_key_periods WHERE video_id = ${requestedVid} ORDER BY period_idx ASC`,
    userPromise,
  ]);
  const dbVideo = dbVideoRows[0];
  const user = userRows[0];

  let videoRecord: VideoRecord | undefined;
  if (dbVideo) {
    videoRecord = {
      id: dbVideo.id,
      title: dbVideo.title,
      manifestPath: dbVideo.manifest_path,
      periods: periodRows.map((p: any) => ({
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

  const now = Math.floor(Date.now() / 1000);
  const exp = now + PLAYBACK_TOKEN_EXPIRY_SECONDS;
  const sessionId = crypto.randomUUID();

  // Only minted once the video is confirmed to exist and the user is confirmed
  // valid - a bad/typo'd ?id= must never supersede a user's real active session.
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

/**
 * Records an issuance of every KID in `kidHexList` to session `sid` in a
 * single round-trip (via unnest), returning each KID's running issuance
 * count (see MAX_KEY_REISSUES_PER_SESSION). Neon's serverless driver pays
 * HTTP latency per query, so batching this instead of awaiting one INSERT
 * per KID matters a lot once a video has more than a handful of periods.
 */
const recordKeyIssuances = async (
  db: ReturnType<typeof createDb>,
  sid: string,
  kidHexList: string[]
): Promise<Map<string, number>> => {
  // Dedupe: a single multi-row INSERT can't ON CONFLICT-update the same row twice.
  const uniqueKids = [...new Set(kidHexList)];
  if (uniqueKids.length === 0) return new Map();
  const rows = await db`
    INSERT INTO issued_license_keys (session_id, key_id)
    SELECT ${sid}, unnest(${uniqueKids}::text[])
    ON CONFLICT (session_id, key_id)
    DO UPDATE SET issue_count = issued_license_keys.issue_count + 1, last_issued_at = NOW()
    RETURNING key_id, issue_count
  `;
  return new Map(rows.map((r: any) => [String(r.key_id), Number(r.issue_count)]));
};

/**
 * Route: POST /license/clearkey and /api/license/clearkey
 * W3C Clear Key License Exchange (CENC-AES-CTR).
 * Validates playback token and returns key set for requested KIDs, rate-limiting reissuance per session in Neon DB.
 */
const handleClearKeyLicense = async (c: any) => {
  const originHeader = c.req.header("Origin") || c.req.header("Referer");
  if (originHeader && !isOriginAllowed(originHeader)) {
    return c.json({ error: "Forbidden. Invalid origin." }, 403);
  }

  const requestedVid = c.req.query("vid");
  const validation = await validatePlaybackToken(c, requestedVid);
  if (!validation.valid) {
    return c.json(
      { error: validation.error, message: validation.message },
      validation.status as any
    );
  }
  const sid = validation.payload!.sid as string;
  const vid = requestedVid || validation.payload?.vid;

  let body: { kids?: string[]; type?: string; all?: boolean } = {};
  if (c.req.method === "POST") {
    let rawText = "";
    try {
      rawText = await c.req.text();
    } catch {
      rawText = "";
    }
    if (rawText && rawText.trim().length > 0) {
      try {
        body = JSON.parse(rawText);
      } catch {
        return c.json({ error: "Invalid license request body. Expected JSON." }, 400);
      }
    }
  }

  const db = createDb(c.env);

  // If client requests all keys (body.all === true, or kids array omitted/empty)
  if (body.all || !body.kids || !Array.isArray(body.kids) || body.kids.length === 0) {
    if (!vid) {
      return c.json({ error: "Missing 'vid' parameter for batch key request." }, 400);
    }

    // Fetch all keys for this video from DB
    const periodRows = await db`
      SELECT vkp.period_idx, vkp.key_id, dk.key_val
      FROM video_key_periods vkp
      LEFT JOIN drm_keys dk ON LOWER(vkp.key_id) = LOWER(dk.key_id)
      WHERE vkp.video_id = ${vid}
      ORDER BY vkp.period_idx ASC
    `;

    let keysData: { kidHex: string; keyHex: string }[] = [];
    if (periodRows.length > 0) {
      for (const row of periodRows) {
        const kidHex = String(row.key_id).toLowerCase();
        const keyHex = (row.key_val || KEY_STORE[kidHex]) as string | undefined;
        if (keyHex) {
          keysData.push({ kidHex, keyHex });
        }
      }
    } else if (VIDEOS[vid]) {
      for (const p of VIDEOS[vid].periods) {
        const kidHex = p.keyId.toLowerCase();
        const keyHex = KEY_STORE[kidHex];
        if (keyHex) {
          keysData.push({ kidHex, keyHex });
        }
      }
    }

    if (keysData.length === 0) {
      return c.json({ error: "no_keys_found", message: `No keys found for video ${vid}.` }, 404);
    }

    // Persist issuance for this session in one round-trip, rate-limiting reissuance per KID
    const issuance = await recordKeyIssuances(db, sid, keysData.map((k) => k.kidHex));
    const allowedKeysData = keysData.filter((entry) => {
      const issueCount = issuance.get(entry.kidHex) ?? 1;
      if (issueCount > MAX_KEY_REISSUES_PER_SESSION) {
        console.warn(`clearkey license: reissue cap hit (session=${sid}, kid=${entry.kidHex}, count=${issueCount})`);
        return false;
      }
      return true;
    });

    if (allowedKeysData.length === 0) {
      return c.json(
        { error: "rate_limited", message: "Key reissue limit exceeded for this session." },
        429
      );
    }

    const keys = allowedKeysData.map(({ kidHex, keyHex }) => ({
      kty: "oct",
      k: hexToBase64Url(keyHex),
      kid: hexToBase64Url(kidHex),
    }));

    return c.json({
      keys,
      type: body.type || "temporary",
    });
  }

  // Handle specific KIDs requested
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

  const kidHexList = body.kids.map((k) => base64UrlToHex(k).toLowerCase());

  // Verify every requested KID belongs to the requested video up front (allowedKids is already in memory - no DB call)
  for (const kidHex of kidHexList) {
    if (allowedKids.size > 0 && !allowedKids.has(kidHex)) {
      return c.json(
        {
          error: "unauthorized_kid",
          message: `Requested KID ${kidHex} does not belong to video ${vid}.`,
        },
        403
      );
    }
  }

  // Batch-fetch all requested key values in one round-trip (fallback to KEY_STORE for any DB misses)
  const keyRows = await db`
    SELECT key_id, key_val FROM drm_keys WHERE LOWER(key_id) = ANY(${kidHexList}::text[])
  `;
  const keyValueByKid = new Map<string, string>(
    keyRows.map((r: any) => [String(r.key_id).toLowerCase(), r.key_val])
  );
  for (const kidHex of kidHexList) {
    if (!keyValueByKid.has(kidHex) && !KEY_STORE[kidHex]) {
      return c.json({ error: "key_not_found", message: `Key not found for KID ${kidHex}` }, 404);
    }
  }

  // Persist issuance for this session in one round-trip, rate-limiting reissuance per KID
  const issuance = await recordKeyIssuances(db, sid, kidHexList);

  const keys: { kty: string; k: string; kid: string }[] = [];
  for (let i = 0; i < body.kids.length; i++) {
    const kidB64Url = body.kids[i];
    const kidHex = kidHexList[i];
    const issueCount = issuance.get(kidHex) ?? 1;
    if (issueCount > MAX_KEY_REISSUES_PER_SESSION) {
      console.warn(`clearkey license: reissue cap hit (session=${sid}, kid=${kidHex}, count=${issueCount})`);
      continue;
    }
    const keyHex = keyValueByKid.get(kidHex) || KEY_STORE[kidHex];
    keys.push({ kty: "oct", k: hexToBase64Url(keyHex), kid: kidB64Url });
  }

  if (keys.length === 0) {
    return c.json(
      { error: "rate_limited", message: "Key reissue limit exceeded for this session." },
      429
    );
  }

  return c.json({
    keys,
    type: body.type || "temporary",
  });
};

app.post("/license/clearkey", handleClearKeyLicense);
app.get("/license/clearkey", handleClearKeyLicense);
app.post("/api/license/clearkey", handleClearKeyLicense);
app.get("/api/license/clearkey", handleClearKeyLicense);
app.post("/clearkey/license", handleClearKeyLicense);
app.get("/clearkey/license", handleClearKeyLicense);
app.post("/api/clearkey/license", handleClearKeyLicense);
app.get("/api/clearkey/license", handleClearKeyLicense);

export default app;
