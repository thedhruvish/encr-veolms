import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";

const app = new Hono<{ Bindings: CloudflareBindings }>();

const JWT_SECRET = "veolms-secure-jwt-token-secret-key-2026";
const TOKEN_EXPIRY_SECONDS = 20 * 60; // 20 minutes (1200 seconds)
const ALLOWED_EMAIL = "dhruvish@gmail.com";

// Enable CORS for frontend clients (port 3000, 5173, or any local origin)
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Set-Cookie"],
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
    // If request body is not JSON or empty
    return c.json({ error: "Invalid request. Email is required in JSON body." }, 400);
  }

  if (!email || typeof email !== "string" || !email.trim()) {
    return c.json({ error: "Email is required to log in." }, 400);
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Validate allowed email for mock auth without DB
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
    httpOnly: false, // accessible to client and requests
    secure: false, // allowed on localhost
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

// Route: /login and /api/login
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

// Route: /logout and /api/logout
app.post("/logout", handleLogout);
app.get("/logout", handleLogout);
app.post("/api/logout", handleLogout);
app.get("/api/logout", handleLogout);

// Helper for getting and verifying JWT from request
const getAuthenticatedPayload = async (c: any) => {
  let token: string | undefined;

  // Check Authorization header first
  const authHeader = c.req.header("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  }

  // Fallback to cookie
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
      return null; // Expired
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

// Helper for handling authenticated video stream details
const TEST_VIDEO_URL =
  "https://protech-assets.dhruvish.in/videos/58fce6ff-a200-4f81-8d3c-79e1b521acbb/master.m3u8";

const handleVideo = async (c: any) => {
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

  return c.json({
    authenticated: true,
    video: {
      id: "58fce6ff-a200-4f81-8d3c-79e1b521acbb",
      title: "Protected Stream (master.m3u8)",
      src: TEST_VIDEO_URL,
      type: "application/x-mpegURL",
      user: payload.email,
    },
  });
};

// Route: /video and /api/video
app.get("/video", handleVideo);
app.get("/api/video", handleVideo);

export default app;

