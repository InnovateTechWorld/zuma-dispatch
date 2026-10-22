-- Deliveries list: filter and sort by booking date or payment date without scanning every job.
CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_paid ON jobs (paid_at DESC) WHERE paid_at IS NOT NULL;
-- "Delivered on" looks up the delivered event per job.
CREATE INDEX IF NOT EXISTS job_events_to_status ON job_events (job_id, to_status);
