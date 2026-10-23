-- Heartbeat for scheduled jobs (the cron safety net), shown on the board's System page.
CREATE TABLE IF NOT EXISTS cron_runs (
  name    TEXT PRIMARY KEY,
  ran_at  INTEGER NOT NULL,
  ok      INTEGER NOT NULL CHECK (ok IN (0, 1)),
  detail  TEXT
);
