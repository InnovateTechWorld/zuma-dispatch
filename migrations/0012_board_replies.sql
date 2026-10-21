-- 0012: replies and control actions a dispatcher sends from the board into a Chord conversation.
-- The nonce comes from the form, so a double click or a refresh can never send the same reply twice.
CREATE TABLE board_replies (
  nonce       TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  action      TEXT NOT NULL,          -- reply | reply_handback | handback | takeover | resume
  outcome     TEXT,                   -- ok | the reason it did not go through
  turn_id     TEXT,                   -- Chord turn id of a sent reply
  created_at  INTEGER NOT NULL
);
CREATE INDEX board_replies_thread ON board_replies (thread_id, created_at);
