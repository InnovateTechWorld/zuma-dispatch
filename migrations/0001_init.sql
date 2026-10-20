-- Zuma Dispatch: initial schema.
-- All timestamps are epoch milliseconds (UTC). All money is integer kobo (NGN x 100).
-- The model never supplies coordinates or prices directly: it passes ids of rows
-- this server created (places -> quotes -> jobs -> payments).

-- A location this server resolved from customer text. Quotes reference places by id
-- so the model cannot invent or alter coordinates.
CREATE TABLE places (
  id             TEXT PRIMARY KEY,               -- 'P-XXXXXXXX'
  query_text     TEXT NOT NULL,                  -- what the customer typed
  label          TEXT NOT NULL,                  -- human-readable resolved address
  lat            REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng            REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
  precision      TEXT NOT NULL CHECK (precision IN ('exact', 'street', 'area', 'lga')),
  postcode       TEXT,                           -- NIPOST code if the customer gave one
  postcode_status TEXT,                          -- NIPOST L1 result: valid / not_found / invalid_format
  provider       TEXT NOT NULL,                  -- which geocoder answered
  confidence     TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  in_service_area INTEGER NOT NULL CHECK (in_service_area IN (0, 1)),
  created_at     INTEGER NOT NULL
);

-- A priced offer, frozen at creation. Jobs copy the amount from here, never from input.
CREATE TABLE quotes (
  id                TEXT PRIMARY KEY,            -- 'Q-XXXXXXXX'
  pickup_place_id   TEXT NOT NULL REFERENCES places(id),
  dropoff_place_id  TEXT NOT NULL REFERENCES places(id),
  package_size      TEXT NOT NULL CHECK (package_size IN ('small', 'medium', 'large')),
  distance_m        INTEGER NOT NULL CHECK (distance_m >= 0),
  duration_s        INTEGER,
  distance_source   TEXT NOT NULL,               -- osrm / ors / straight_line
  approximate       INTEGER NOT NULL CHECK (approximate IN (0, 1)),
  amount_kobo       INTEGER NOT NULL CHECK (amount_kobo > 0),
  currency          TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  breakdown_json    TEXT NOT NULL,               -- line items shown to the customer
  rate_card_version TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);

CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,             -- 'ZD-XXXXX', short enough to read on WhatsApp
  quote_id         TEXT NOT NULL UNIQUE REFERENCES quotes(id),  -- one job per quote (idempotency)
  sender_name      TEXT NOT NULL,
  sender_phone     TEXT,
  recipient_name   TEXT NOT NULL,
  recipient_phone  TEXT NOT NULL,
  package_note     TEXT,
  amount_kobo      INTEGER NOT NULL CHECK (amount_kobo > 0),
  currency         TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status           TEXT NOT NULL CHECK (status IN (
                     'awaiting_payment', 'paid', 'dispatched', 'delivered',
                     'cancelled', 'payment_failed', 'amount_mismatch')),
  handover_code    TEXT NOT NULL,                -- given to the sender; not verified in this build
  version          INTEGER NOT NULL DEFAULT 1,   -- optimistic concurrency for status changes
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  paid_at          INTEGER
);
CREATE INDEX jobs_status_created ON jobs (status, created_at DESC);

-- One row per Paystack transaction we initialized. A job can have several attempts
-- (e.g. after an abandoned checkout) but at most one open attempt at a time.
CREATE TABLE payments (
  reference         TEXT PRIMARY KEY,            -- 'ZD-XXXXX-1' (Paystack allows only - . = and alphanumerics)
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  attempt           INTEGER NOT NULL CHECK (attempt >= 1),
  amount_kobo       INTEGER NOT NULL CHECK (amount_kobo > 0),
  currency          TEXT NOT NULL DEFAULT 'NGN',
  authorization_url TEXT NOT NULL,
  access_code       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN (
                      'initialized', 'success', 'failed', 'abandoned',
                      'ongoing', 'pending', 'reversed', 'mismatch')),
  gateway_response  TEXT,
  paystack_id       INTEGER,
  channel           TEXT,
  created_at        INTEGER NOT NULL,
  last_checked_at   INTEGER,
  paid_at           INTEGER,
  UNIQUE (job_id, attempt)
);
CREATE INDEX payments_job ON payments (job_id, attempt DESC);

-- Append-only audit trail; the dispatcher board renders it.
CREATE TABLE job_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  type        TEXT NOT NULL,                     -- created / status_changed / payment_link / payment_checked ...
  from_status TEXT,
  to_status   TEXT,
  actor       TEXT NOT NULL CHECK (actor IN ('agent', 'dispatcher', 'system', 'customer')),
  detail_json TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX job_events_job ON job_events (job_id, id);

-- Geocoder cache. Required by the Nominatim usage policy and keeps us inside free quotas.
CREATE TABLE geocode_cache (
  cache_key   TEXT PRIMARY KEY,                  -- provider + normalised query
  provider    TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Lightweight tool-call log for debugging and the field notes. No customer PII stored here.
CREATE TABLE tool_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  TEXT,
  tool        TEXT NOT NULL,
  ok          INTEGER NOT NULL CHECK (ok IN (0, 1)),
  error_code  TEXT,
  latency_ms  INTEGER NOT NULL,
  detail      TEXT,                              -- provider path, e.g. "nominatim:timeout>photon:ok"
  created_at  INTEGER NOT NULL
);
CREATE INDEX tool_calls_created ON tool_calls (created_at DESC);
