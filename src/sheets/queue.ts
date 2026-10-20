import type { Env } from '../env';
import { syncJob } from './mirror';

/** Schedules a background sheet update for a job. Safe to call when the mirror is off (no-op). */
export function queueSheetSync(env: Env, waitUntil: (p: Promise<unknown>) => void, origin: string, jobId: string): void {
  if (!env.GOOGLE_SHEET_ID || !env.GOOGLE_SERVICE_ACCOUNT_JSON) return;
  waitUntil(syncJob(env, jobId, origin));
}
