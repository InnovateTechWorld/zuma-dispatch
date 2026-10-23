-- The cron safety net (src/chord/watchdog.ts): each action recorded once per Zuma reply.
-- kind: 'handover' (a person was promised or asked for, and Zuma did not hand over) or 'foreign_link'.
CREATE TABLE IF NOT EXISTS watchdog_events (
  thread_id  TEXT NOT NULL,
  reply_ts   INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('handover', 'foreign_link')),
  detail     TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, reply_ts, kind)
);
CREATE INDEX IF NOT EXISTS watchdog_events_created ON watchdog_events (created_at DESC);
