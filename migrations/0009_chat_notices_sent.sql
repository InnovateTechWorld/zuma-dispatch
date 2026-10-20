-- 0009: chat notices can now be delivered synchronously as an operator message (take-over → message →
-- hand-back), which reports delivery at once. Adds the 'sent' state; SQLite cannot alter a CHECK in place,
-- so the (small) table is rebuilt.
CREATE TABLE chat_notices_new (
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  kind        TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'sent', 'skipped', 'failed')),
  reason      TEXT,
  thread_id   TEXT,
  task_id     TEXT,                              -- scheduled-task id, or the operator turn id when sent directly
  attempts    INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (job_id, kind)
);
INSERT INTO chat_notices_new SELECT job_id, kind, state, reason, thread_id, task_id, attempts, created_at, updated_at FROM chat_notices;
DROP TABLE chat_notices;
ALTER TABLE chat_notices_new RENAME TO chat_notices;
CREATE INDEX chat_notices_thread ON chat_notices (thread_id, updated_at);
