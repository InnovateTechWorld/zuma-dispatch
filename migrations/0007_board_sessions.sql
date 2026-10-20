-- 0007: dispatcher board login. Server-side sessions (so "Sign out" really ends a session) and a
-- per-IP failed-login counter (so the password cannot be guessed at speed).
CREATE TABLE board_sessions (
  token_hash  TEXT PRIMARY KEY,                -- SHA-256 of the cookie value; the cookie itself is never stored
  password_fp TEXT NOT NULL,                   -- fingerprint of BOARD_TOKEN at sign-in: rotating it signs everyone out
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX board_sessions_expiry ON board_sessions (expires_at);

CREATE TABLE board_login_failures (
  ip_hash      TEXT PRIMARY KEY,               -- SHA-256 of the client IP, not the IP
  window_start INTEGER NOT NULL,
  failures     INTEGER NOT NULL
);
