-- 0004: events Chord pushes to us (webhooks), e.g. conversation.escalated when the teammate hands
-- a customer to a human. Keyed by X-Chord-Delivery-Id, Chord's documented idempotency key.
CREATE TABLE chord_events (
  delivery_id TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  thread_id   TEXT,
  initiator   TEXT,
  reason      TEXT,
  payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX chord_events_received ON chord_events (received_at DESC);
