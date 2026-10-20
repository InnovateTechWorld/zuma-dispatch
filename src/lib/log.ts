/**
 * Structured JSON logs. Workers Observability indexes JSON fields, so every line can be
 * filtered by event, tool or request_id. Never log secrets, phone numbers or names.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function log(level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
