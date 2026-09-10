-- ============================================================
--  VeoLMS  –  MVP Database Schema  (Neon / PostgreSQL)
--  Run once: psql $DATABASE_URL -f schema.sql
-- ============================================================

-- Users allowed to access the LMS
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'student',   -- 'admin' | 'student'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seeded admin user (matches the hard-coded ALLOWED_EMAIL)
INSERT INTO users (email, name, role)
VALUES ('dhruvish@gmail.com', 'Dhruvish', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Active login sessions  (single-session enforcement – one row per user)
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,          -- matches the JWT `sid` claim
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id)                    -- enforce single active session
);

-- Video catalogue
CREATE TABLE IF NOT EXISTS videos (
  id            TEXT PRIMARY KEY,          -- same as the registry key, e.g. "lecture-01"
  title         TEXT NOT NULL,
  manifest_path TEXT NOT NULL,             -- path inside R2, e.g. "lecture-01/stream.mpd"
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- DRM key periods per video  (one row per CENC period/key pair)
CREATE TABLE IF NOT EXISTS video_key_periods (
  id          SERIAL PRIMARY KEY,
  video_id    TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  period_idx  INT  NOT NULL,
  key_id      TEXT NOT NULL,    -- hex KID
  UNIQUE (video_id, period_idx)
);

-- Encryption key store  (kid -> key, hex strings)
CREATE TABLE IF NOT EXISTS drm_keys (
  key_id  TEXT PRIMARY KEY,   -- hex KID
  key_val TEXT NOT NULL       -- hex key value
);

-- Issued license keys per playback session
-- Prevents replay: a session can only pull each KID once
CREATE TABLE IF NOT EXISTS issued_license_keys (
  session_id  TEXT NOT NULL,
  key_id      TEXT NOT NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, key_id)
);
