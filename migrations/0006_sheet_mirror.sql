-- 0006: Google Sheets mirror bookkeeping. Which sheet row holds which job, and the last sync result.
-- The sheet is a read-only copy for the business owner; this database stays the source of truth.
CREATE TABLE sheet_rows (
  job_id      TEXT PRIMARY KEY REFERENCES jobs(id),
  row_number  INTEGER,                         -- null while the first append is in flight (a claim)
  synced_at   INTEGER NOT NULL
);
CREATE TABLE sheet_state (
  key         TEXT PRIMARY KEY,                -- 'last'
  ok          INTEGER NOT NULL CHECK (ok IN (0, 1)),
  detail      TEXT,
  updated_at  INTEGER NOT NULL
);
