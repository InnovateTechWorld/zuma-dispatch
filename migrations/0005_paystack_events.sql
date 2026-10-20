-- 0005: Paystack webhook deliveries (charge.success, refunds, disputes). The event row is an audit
-- trail and a dedupe key; payment state itself is always re-checked with Paystack's verify API.
CREATE TABLE paystack_events (
  dedupe_key  TEXT PRIMARY KEY,                -- event + ':' + data.id (or reference)
  event       TEXT NOT NULL,
  reference   TEXT,
  job_id      TEXT,
  outcome     TEXT NOT NULL,                   -- paid / not_paid / needs_review / unknown_reference / ignored / error
  source_ip   TEXT,
  ip_trusted  INTEGER NOT NULL CHECK (ip_trusted IN (0, 1)),
  received_at INTEGER NOT NULL
);
CREATE INDEX paystack_events_received ON paystack_events (received_at DESC);
