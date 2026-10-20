import { defineConfig } from 'vitest/config';

// Unit tests cover the pure decision logic (pricing, payment verdicts, geocoder judgement,
// parsing). They run in plain Node: no Workers runtime, network or database needed.
// End-to-end behaviour is covered by scripts/mcp-smoke.sh and scripts/e2e-flow.sh.
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
