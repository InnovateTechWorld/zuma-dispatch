-- 0011: a rider is assigned the moment a job is paid (src/business/riders.ts, made-up roster), and the
-- customer is told in the chat when Chord hands them to a human (chord_events.ack).
ALTER TABLE jobs ADD COLUMN rider_id TEXT;
ALTER TABLE jobs ADD COLUMN rider_assigned_at INTEGER;
ALTER TABLE chord_events ADD COLUMN ack TEXT;   -- 'sent' | 'skipped: …' | 'failed: …' | NULL (not attempted)
