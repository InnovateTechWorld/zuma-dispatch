/**
 * Minimal stand-in for D1, just enough for code that reads and writes one keyed row at a time
 * (the geocode cache and the webhook log). It records every statement so tests can assert on them.
 */
export function fakeD1(rows: Record<string, unknown> = {}) {
  const statements: { sql: string; args: unknown[] }[] = [];
  const db = {
    statements,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              statements.push({ sql, args });
              return (rows[String(args[0])] as unknown) ?? null;
            },
            async run() {
              statements.push({ sql, args });
              const key = String(args[0]);
              const existed = key in rows;
              if (/^INSERT/i.test(sql) && !/DO UPDATE/i.test(sql) && existed) return { meta: { changes: 0 } };
              rows[key] = { result_json: args[2], created_at: args[3] };
              return { meta: { changes: 1 } };
            },
            async all() {
              statements.push({ sql, args });
              return { results: [] };
            },
          };
        },
      };
    },
  };
  return db as unknown as D1Database & { statements: typeof statements };
}
