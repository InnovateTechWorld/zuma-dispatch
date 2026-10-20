-- 0002: payment attempts are recorded *before* calling Paystack (status 'initializing'),
-- so a timed-out initialize can be recovered by reference. That needs nullable
-- authorization_url/access_code and a wider status set. SQLite cannot relax NOT NULL in
-- place, so the (empty, pre-launch) table is rebuilt. Also adds job cancellation reason.

DROP TABLE IF EXISTS payments;

CREATE TABLE payments (
  reference         TEXT PRIMARY KEY,            -- 'ZD-XXXXX-1' (Paystack allows only - . = and alphanumerics)
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  attempt           INTEGER NOT NULL CHECK (attempt >= 1),
  amount_kobo       INTEGER NOT NULL CHECK (amount_kobo > 0),
  currency          TEXT NOT NULL DEFAULT 'NGN',
  authorization_url TEXT,                        -- null until Paystack answers
  access_code       TEXT,
  status            TEXT NOT NULL CHECK (status IN (
                      'initializing', 'initialized', 'success', 'failed', 'abandoned',
                      'ongoing', 'pending', 'processing', 'queued', 'reversed', 'mismatch', 'not_found')),
  gateway_response  TEXT,
  paystack_id       INTEGER,
  channel           TEXT,
  created_at        INTEGER NOT NULL,
  last_checked_at   INTEGER,
  paid_at           INTEGER,
  UNIQUE (job_id, attempt)
);
CREATE INDEX payments_job ON payments (job_id, attempt DESC);

ALTER TABLE jobs ADD COLUMN cancel_reason TEXT;
