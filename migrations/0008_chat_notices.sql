-- 0008: messages our server pushes into the customer's Chord conversation without them writing first
-- (today: "payment received" after Paystack's webhook). One row per job and kind, so a notice is sent
-- at most once even when Paystack retries or two paths confirm the payment at the same moment.
CREATE TABLE chat_notices (
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  kind        TEXT NOT NULL,                     -- 'payment_received'
  state       TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'skipped', 'failed')),
  reason      TEXT,                              -- why skipped / failed (machine code + short detail)
  thread_id   TEXT,                              -- the Chord conversation it went to
  task_id     TEXT,                              -- Chord scheduled-task id of the MESSAGE
  attempts    INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (job_id, kind)
);
