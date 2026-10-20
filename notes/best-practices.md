# Best practices: remote MCP courier server (Cloudflare Workers + D1 + Paystack)

Researched 2026-10-20. Every claim has a source next to it. "Unconfirmed" means I could not verify it from a primary source.
**Fetch notes:** `paystack.com/docs/*` returned **403** to both WebFetch and curl. Paystack facts below come from Paystack's own docs mirrors (`docs-v2.production.paystack.co`, `docs-v2.paystack.com`), the official OpenAPI repo (`github.com/PaystackOSS/openapi`), Paystack's doc snippets repo, and `support.paystack.com`. Each is cited at the point of use.

---

## 1. Serving a stateless Streamable HTTP MCP endpoint on Workers

### Options compared (state as of Oct 2026)

| Option | Import | Status / notes |
|---|---|---|
| **`createMcpHandler`** (Agents SDK) | `import { createMcpHandler } from "agents/mcp/server"` + `McpServer` from `@modelcontextprotocol/server` (SDK v2) | Recommended for new servers. It is stateless: each request builds a new server from your **factory**. GET and DELETE return 405, no session ID is kept, and pushed elicitation, sampling and roots fail. https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/ |
| `McpAgent` (Durable Objects) | `agents/mcp` | "Deprecated and feature-frozen". The docs say "Do not create a new `McpAgent` server". https://developers.cloudflare.com/agents/model-context-protocol/transport/ |
| `createLegacyMcpHandler` | `agents/mcp`, SDK v1 | Only a temporary bridge for sessionful servers. https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/ |
| Raw SDK v1 transport (**what this repo uses**) | `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` (present in 1.32.1, https://unpkg.com/@modelcontextprotocol/sdk@1.32.1/dist/esm/server/webStandardStreamableHttp.d.ts). Run it stateless with `sessionIdGenerator: undefined` (optionally `enableJsonResponse: true`), then `return transport.handleRequest(request)`. | Cloudflare lists "Raw SDK transport" as a valid approach (https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/). In SDK v2 this class moved to `@modelcontextprotocol/server` (https://github.com/modelcontextprotocol/typescript-sdk/blob/main/skills/mcp-typescript-sdk-upgrade-to-v2/references/imports-transports.md). SDK v2 also has its own `createMcpHandler`, whose return value works directly as a Workers `export default` (https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md). |

**Recommendation:** keep the raw SDK v1 transport for the take-home. It works, it is stateless, and it adds no dependency on `agents`. Mention in the README that the go-forward path is the SDK v2 factory with `createMcpHandler`.

### Minimal stateless example (Agents `createMcpHandler`, bearer auth in front)

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const makeFactory = (env: Env) => () => {
  const server = new McpServer({ name: "zuma-dispatch", version: "1.0.0" });
  server.registerTool("get_job_status", {
    title: "Get job status",
    description: "Look up a dispatch job by the job_id returned from create_dispatch_job. ...",
    inputSchema: z.object({ job_id: z.string() }),
    outputSchema: z.object({ job_id: z.string(), status: z.string() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ job_id }) => {
    const row = await env.DB.prepare("SELECT id, status FROM jobs WHERE id = ?")
      .bind(job_id).first<{ id: string; status: string }>();
    if (!row) return { isError: true, content: [{ type: "text",
      text: `No job "${job_id}". Ask the customer for the job ID in their confirmation message.` }] };
    const out = { job_id: row.id, status: row.status };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  });
  return server;
};

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "OPTIONS" && !(await bearerOk(request, env.MCP_BEARER_TOKEN)))
      return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="mcp"' } });
    return createMcpHandler(makeFactory(env))(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

The pattern above (factory function, object default export, `registerTool`) comes from the Agents handler docs (https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/) and from Cloudflare's `mcp-worker` example (https://github.com/cloudflare/agents/blob/main/examples/mcp-worker/src/server.ts). The `outputSchema` and `structuredContent` pattern comes from the SDK v2 tools guide (https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/tools.md). Building a handler on every `fetch()` is fine for ordinary tools. It is only a problem if you need `notify`/`subscriptions/listen` (https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/).

### Bearer auth placement

- **Check the token before the MCP handler runs.** Neither handler verifies tokens: "The handler does not derive it from request headers or verify access tokens." To pass identity through, use `handler.fetch(request, { authInfo })`. https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- **Compare in constant time.** Use `crypto.subtle.timingSafeEqual`. When the lengths differ, do not return early: compare the input against itself and negate the result. https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/
- **Never log or return the token.** "Do not log or return `authInfo.token`." https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- **A static bearer token is outside the MCP OAuth model.** The 2025-06-18 auth spec requires audience-bound tokens and forbids token passthrough. https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
  - Mitigation: use a long random secret set with `wrangler secret put`, rotate it, and never forward it to downstream APIs.
  - Local dev: secrets go in `.dev.vars` or `.env`, never both, and neither is committed. https://developers.cloudflare.com/workers/configuration/secrets/

### CORS and Origin

- **Validate Origin.** Servers "MUST validate the `Origin` header … to prevent DNS rebinding". https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- **Server-to-server callers pass the check.** The Agents wrapper rejects malformed or opaque Origins with 403, but clients that send no Origin "remain valid". That covers Chord. https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- **Custom domain:** set `allowedHostnames` and `allowedOriginHostnames` yourself. CORS "is not authentication." https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- **The raw SDK path does no Host/Origin validation.** Add `hostHeaderValidationResponse` and `originValidationResponse` (v2), or your own check (v1). https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md
- **Browser inspector testing:** let `OPTIONS` preflight through before the bearer check.

### Gotchas

- **nodejs_compat:** with `compatibility_date` ≥ 2026-08-04 it is on by default, and the docs say to leave the flag out of new configs. This repo uses date 2026-10-01, so the flag is redundant but harmless. https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- **No `eval` or `new Function`.** Workers forbid both (https://developers.cloudflare.com/workers/runtime-apis/web-standards/), which breaks Ajv-style schema compilation. SDK v1 ships a "Cloudflare Worker-compatible JSON Schema validator provider" (`@modelcontextprotocol/sdk/validation/cfworker-provider.js`), which this repo already uses (https://unpkg.com/@modelcontextprotocol/sdk@1.32.1/dist/esm/validation/cfworker-provider.d.ts).
- **Free-plan limits:**
  - CPU: **10 ms CPU per HTTP request** on Free, versus 30 s by default (up to 5 min) on Paid. Waiting on `fetch`/D1 does not count. https://developers.cloudflare.com/workers/platform/limits/
  - Watch out: building a server, compiling schemas and serialising JSON on every request costs CPU. I did not measure this. Profile with `wrangler tail`, or use the Paid plan for the demo.
  - Subrequests: **50 per invocation** on Free (10,000 on Paid). Each redirect hop counts. https://developers.cloudflare.com/workers/platform/limits/
  - D1 queries: **50 per invocation on Free** (1,000 on Paid). https://developers.cloudflare.com/d1/platform/limits/
  - Connections: only **6 connections may wait for headers at once**. A fan-out geocoder chain queues at the 7th. https://developers.cloudflare.com/workers/platform/limits/
  - Daily cap: 100,000 requests/day on Free, then error 1027. https://developers.cloudflare.com/workers/platform/limits/
- **Timeouts:** subrequests have "no set time limit", so set your own with `AbortSignal.timeout` (AbortController/AbortSignal are supported). https://developers.cloudflare.com/workers/platform/limits/ , https://developers.cloudflare.com/workers/runtime-apis/web-standards/
- **Caching:** the docs only guarantee a working Cache API "to custom domains". Cache geocodes in D1 instead. https://developers.cloudflare.com/workers/runtime-apis/cache/
- **D1 patterns:**
  - Always `prepare().bind()`. Bound parameters prevent SQL injection. https://developers.cloudflare.com/d1/worker-api/prepared-statements/
  - `batch()` statements are "SQL transactions": they run sequentially, and one failure rolls back the whole batch. Use it for job + payment inserts. https://developers.cloudflare.com/d1/worker-api/d1-database/
  - `run()` returns `meta.changes`. Use it to detect whether a conditional `UPDATE` won a race. https://developers.cloudflare.com/d1/worker-api/prepared-statements/
  - Each database is single-threaded. Limits: 100 bound params per query, 100 KB per statement, 500 MB per database on Free. https://developers.cloudflare.com/d1/platform/limits/
  - D1 auto-retries read-only queries. Retry writes yourself with backoff and jitter. https://developers.cloudflare.com/d1/best-practices/retry-queries/
- **Migrations:**
  - Commands: `wrangler d1 migrations create|list|apply <db> --local|--remote`. Applied versions are tracked in the `d1_migrations` table. https://developers.cloudflare.com/d1/reference/migrations/ , https://developers.cloudflare.com/workers/wrangler/commands/d1/
  - Prefer the database name over the binding name. https://developers.cloudflare.com/d1/reference/migrations/
- **`env` access:** `import { env } from "cloudflare:workers"` works, but I/O at the top level of a module errors. https://developers.cloudflare.com/workers/runtime-apis/bindings/
- **Version pinning:** `agents@0.28.1` peer-pins `@modelcontextprotocol/server` **2.3.1**, but the docs' install line says `@2.0.0`. Match the peer pins (`npm view agents peerDependencies`). The docs themselves say "Use the exact MCP versions required by your installed Agents release." https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- **Protocol era:** the current MCP spec is **2026-07-28**, which replaces `initialize` with `server/discover`. Revisions through 2025-11-25 form the "legacy" era. https://modelcontextprotocol.io/specification/versioning , https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md
  - Chord's era is unknown. Keep legacy (2025-06-18) clients working: Agents `legacy: "stateless"` is the default, and the SDK v1 transport is legacy-only.

---

## 2. Tool design for LLM agents

### Anthropic guidance

Source: "Writing effective tools for agents — with agents", Sep 11 2025, https://www.anthropic.com/engineering/writing-tools-for-agents

- **Fewer, consolidated tools.** Don't just wrap endpoints. Prefer workflow tools such as `schedule_event` over `list_*` plus `create_*`.
- **Namespace when tools span services.** Prefix vs suffix "affects results", so test it.
- **Return high-signal fields.** Use natural-language identifiers over UUIDs. Include IDs only where they're needed to chain the next call.
- **Offer a `response_format` enum** (`concise`/`detailed`). Concise used about ⅓ of the tokens in Anthropic's example.
- **Be token efficient.** Use pagination, filtering and truncation with sensible defaults. Claude Code caps tool responses at 25k tokens.
- **Error messages must be "specific and actionable"** and steer the agent. No opaque codes or tracebacks.
- **Write descriptions like onboarding a new hire.** Use unambiguous parameter names (`user_id`, not `user`) and strict data models.
- **Evaluate** on realistic multi-step tasks and read the transcripts.

Anthropic's API docs on defining tools (https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) add:

- Detailed descriptions are "by far the most important factor". Aim for at least 3–4 sentences covering what the tool does, when to use it and when not, what each parameter means, and its caveats.
- Use `input_examples` for format-sensitive inputs.

### MCP 2025-06-18 features

Source: https://modelcontextprotocol.io/specification/2025-06-18/server/tools and https://modelcontextprotocol.io/specification/2025-06-18/schema

- **Annotations:**
  - `readOnlyHint` (default false). `destructiveHint` (default **true**) and `idempotentHint` (default false) only mean something when `readOnlyHint == false`. `openWorldHint` defaults to **true**.
  - They are hints only. Clients must treat them as untrusted, so **enforce safety on the server**.
- **`outputSchema` + `structuredContent`:**
  - Servers MUST conform to the declared schema.
  - For backward compatibility, also return the serialised JSON in a text block. Do this anyway, because Chord's support for `structuredContent` is unconfirmed.
- **`isError`:**
  - Report tool or business failures inside the result with `isError: true`, "not as an MCP protocol-level error… Otherwise, the LLM would not be able to see that an error occurred and self-correct."
  - Use JSON-RPC errors only for unknown tools, malformed requests and server faults. Put the recovery hint in `text`: "it is the only thing the model has to work with." https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/errors.md
- **Server duties:** servers MUST validate inputs, enforce access control, rate-limit calls and sanitise outputs.

### Recommendations for our six tools

| Tool | Annotations (ro / destr / idem / open) | Input (never money) | Output highlights |
|---|---|---|---|
| `resolve_address` | true / – / – / true | `address_text`, optional `postcode`, `landmark` | Server-issued `address_id`; human label ("Wuse 2, near Banex"); `in_coverage`; `confidence`; ≤3 `candidates` when ambiguous; `provider` |
| `quote_delivery` | false / false / true / true | `pickup_address_id`, `dropoff_address_id`, `package_size` enum, `service_level` enum | `quote_id`, `amount_kobo`, `amount_display` ("₦3,500"), `distance_km`, `eta_min`, `expires_at`, short breakdown |
| `create_dispatch_job` | false / false / true / false | `quote_id`, sender and recipient name/phone, notes | `job_id`, status `awaiting_payment`, amount echoed **from the quote** |
| `create_payment_link` | false / false / true / true | `job_id` (+ optional `email`) | `authorization_url`, `reference`, `amount_display`, `expires_at`; returns the **existing** unpaid link if one is still valid |
| `verify_payment` | false / false / true / true | `job_id` | `payment_status` enum `paid` / `pending` / `failed` / `abandoned` / `amount_mismatch` / `not_found`, plus `next_step` text |
| `get_job_status` | true / – / – / false | `job_id` | status, timestamps, pickup/dropoff labels; concise by default |

- **Pricing comes only from the server.** No tool accepts a price or amount. The amount flows quote → job → Paystack.
  - Every description that touches money says: "Only quote prices returned by `quote_delivery`; never compute or estimate prices."
  - This follows Paystack's rule to verify that amount "matches the value of the service" (https://docs-v2.paystack.com/payments/accept-payments).
- **Names:** keep the snake_case verb_noun names. Add a namespace prefix (e.g. `zuma_`) only if Chord mixes these with other servers' tools (https://www.anthropic.com/engineering/writing-tools-for-agents).
- **Errors steer the next action.** Examples:
  - `"Quote q_… expired at 14:05. Call quote_delivery again with the same address_ids and tell the customer the new price."`
  - `"Address is outside our Abuja coverage (Kubwa, Lugbe…). Ask for a different drop-off."`
- **`response_format`:** worth adding only to `get_job_status` and `resolve_address`. The other outputs are already small.

---

## 3. Paystack integration

- **Verify server-side only.**
  - Call `GET https://api.paystack.co/transaction/verify/:reference` with `Authorization: Bearer <secret>` (https://docs-v2.paystack.com/payments/verify-payments).
  - Never call Paystack from a frontend (https://docs-v2.paystack.com/payments/accept-payments).
- **What to check:** the top-level `status` is "not the status of the transaction". Use `data.status` (https://docs-v2.production.paystack.co/docs/payments/verify-payments/). Grant value only when all of these hold:
  - `data.status === "success"`
  - `data.amount === stored amount_kobo`. "If the amount doesn't match, do not deliver value." (https://docs-v2.paystack.com/payments/accept-payments)
  - `data.currency === "NGN"`
  - `data.reference === stored reference`
  - The currency and reference checks are prudent practice. Paystack's text explicitly names only status and amount.
- **Statuses:** `abandoned`, `failed`, `ongoing` (waiting on OTP or a transfer), `pending`, `processing` (direct debit), `queued` (bulk only), `reversed` (refund or chargeback), `success`. https://docs-v2.production.paystack.co/docs/payments/verify-payments/
  - Treat `ongoing` and `pending` as non-final: tell the customer to finish, then re-verify.
  - Paystack sends webhooks "for just successful transactions" (same source).
- **HTTP behaviour:** 200 comes back even for failed charges, so read `data` (https://docs-v2.paystack.com/api/errors).
- **Amounts:** use the currency subunit. ₦100 is sent as `10000` kobo (https://docs-v2.paystack.com/api). `amount` is an integer and `email` is required (https://github.com/PaystackOSS/openapi/blob/main/dist/paystack.yaml).
  - Edge limits: Pay-with-Transfer needs at least NGN 100. A zero amount is rejected. https://docs-v2.production.paystack.co/docs/api/errors/transaction/
- **Email workaround:** Paystack's tip is to synthesise an email from the phone number, e.g. `0803…@mybusiness.com` (https://docs-v2.paystack.com/payments/accept-payments).
- **References:**
  - Case-sensitive; only `-`, `.`, `=` and alphanumerics. Generate your own per transaction (https://docs-v2.paystack.com/payments/accept-payments).
  - Reuse fails with "Duplicate Transaction Reference" (https://docs-v2.production.paystack.co/docs/api/errors/transaction/). That uniqueness is your idempotency guard: persist the reference before calling initialize.
  - The OpenAPI spec documents an idempotency field only for transfers, not for transaction initialize (https://github.com/PaystackOSS/openapi/blob/main/dist/paystack.yaml).
  - Whether re-initialising a pending reference returns the existing link is **unconfirmed**. Return your stored `authorization_url` instead.
- **Metadata:**
  - Plain keys come back in the API response but not on the dashboard. `custom_fields` (`display_name`, `variable_name`, `value`) show on the dashboard.
  - `cancel_action` sets a redirect URL for when the customer cancels.
  - Source: https://docs-v2.paystack.com/payments/metadata , snippet https://github.com/PaystackOSS/doc-code-snippets/blob/main/dist/doc/payments/metadata/custom-fields.js
  - Put `job_id` and `quote_id` there for reconciliation.
- **`callback_url`:**
  - It overrides the dashboard value. If neither is set, there is no redirect. Paystack appends `?reference=…`.
  - Visiting it "doesn't prove that transaction was successful". https://docs-v2.paystack.com/payments/accept-payments
  - Optional: point it at a Worker route that verifies the payment and shows "Payment received. Return to WhatsApp."
- **Expiry:**
  - Expiry is controlled by the dashboard "Payment Session Timeout". Errors include "Session timeout exceeded". Set it to 0 to disable. https://docs-v2.production.paystack.co/docs/api/errors/transaction/
  - Mirror that with your own `expires_at` on the link and on the quote.
  - Third-party claim: an abandoned transfer can still complete late (https://mctaba.com/learn/paystack/paystack-transaction-status-values-and-what-each-means). This is unconfirmed by Paystack, but it is a reason to re-verify before cancelling a job.
- **Rate limits:**
  - Test mode: 100 req/60 s. Live: 600 req/60 s. Live-only extended limits: verify 3,000/60 s, initialize 1,200/60 s.
  - On a 429, read `x-ratelimit-reset` (seconds). Paystack names polling verify in a loop as the most common cause.
  - Source: https://docs-v2.production.paystack.co/docs/api/rate-limits/
- **Timeouts and retries:** Paystack publishes no client timeout guidance that I could find (**unconfirmed**). Use about 8 s with `AbortSignal.timeout`.
  - Safe to retry: verify (it is a GET).
  - On an initialize timeout, retry with the **same** reference. A duplicate-reference error then means the first attempt succeeded, so call verify or fetch to recover.
- **Test cards** (any future expiry). Source: https://docs-v2.production.paystack.co/docs/payments/test-payments/

  | Scenario | Card | CVV | PIN/OTP |
  |---|---|---|---|
  | Success, no validation | 4084 0840 8408 4081 | 408 | – |
  | PIN | 5078 5078 5078 5078 12 | 081 | PIN 1111 |
  | PIN + OTP | 5060 6666 6666 6666 666 | 123 | PIN 1234, OTP 123456 |
  | PIN + phone + OTP | 5078 5078 5078 5078 04 | 884 | PIN 0000, OTP 123456 |
  | Bank auth simulation | 5192 6027 2058 4796 | 123 | – |
  | Declined | 4084 0800 0000 5408 | 001 | – |
  | Token not generated | 5078 5078 5078 5078 53 | 082 | PIN 0000 |
  | Insufficient funds | 4084 0800 0067 0037 | 787 | – |

  - Bank (charge) test: Zenith 0000000000, birthday 1999-04-20, OTP 123456 (same page).
  - A **Pay-with-Transfer checkout simulation is not documented** there. Test it manually in test checkout before claiming support.
- **Webhooks (go-live):**
  - Validate the `x-paystack-signature` header. It is an HMAC-SHA512 of the raw body keyed with the secret key. On Workers, use WebCrypto HMAC plus a constant-time compare.
  - Source IPs: 52.31.139.75, 52.49.173.169, 52.214.14.220 (same for test and live).
  - Return 200 fast. Live retries run every 3 min ×4, then hourly for 72 h.
  - Source: https://docs-v2.production.paystack.co/docs/payments/webhooks/ , https://github.com/PaystackOSS/doc-code-snippets/blob/main/dist/doc/payments/webhooks/verifying-transaction.js
  - Guard against double fulfilment when both webhook and verify fire (https://docs-v2.production.paystack.co/docs/payments/verify-payments/).
- **Secret-key IP whitelisting:** up to 10 IPv4 addresses per mode (https://support.paystack.com/en/articles/2130946). It is impractical on Workers: fixed egress IPs need the Dedicated CDN Egress IPs product, which goes through your account team (https://developers.cloudflare.com/smart-shield/configuration/dedicated-egress-ips/other-products/).
- **Pricing (Nigeria):** 1.5% + ₦100 on local channels. The ₦100 is waived under ₦2,500, and fees are capped at ₦2,000. https://support.paystack.com/en/articles/2130306

---

## 4. Provider usage policies (README table and go-live)

| Provider | Policy essentials | Source |
|---|---|---|
| Nominatim (public) | ≤1 req/s for the whole application. Identifying User-Agent or Referer (stock UAs rejected). Attribution; ODbL. Cache results; repeated identical queries may get you blocked. No autocomplete. **"package/vehicle tracking applications" must run their own service.** No personal data in queries. Policy can change without notice. | https://operations.osmfoundation.org/policies/nominatim/ |
| Photon (komoot) | "please be fair - extensive usage will be throttled"; no availability guarantee | https://photon.komoot.io/ |
| OSRM demo (`router.project-osrm.org`, FOSSGIS) | "reasonable, non-commercial use"; ≤1 req/s; no uptime guarantee; valid UA; attribution | https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server , https://routing.openstreetmap.de/about.html |
| OSRM API shape | Coordinates are **`lon,lat`**. Distance in metres, duration in seconds. Check `code === "Ok"` (`NoRoute`/`NoSegment` are failures). | http://project-osrm.org/docs/v5.24.0/api/ |
| OpenRouteService | Standard (free): Directions 2,000/day and 40/min; Geocoding 1,000/day. From search snippets; the plans page redirects to a JS app I could not read. | https://openrouteservice.org/plans/ |
| Google Places Text Search (New) | `POST https://places.googleapis.com/v1/places:searchText`. `X-Goog-FieldMask` is **required** ("no default list"). `displayName`, `formattedAddress` and `location` are **Pro**-tier fields. Use `locationBias` (circle ≤50 km), `regionCode` "ng", `pageSize` ≤20. | https://developers.google.com/maps/documentation/places/web-service/text-search |
| Google pricing | Text Search Essentials (IDs only): unlimited free. Pro: 5,000 free/month, then $32/1k. Enterprise: 1,000 free, $35/1k. Geocoding API: 10,000 free, $5/1k. | https://developers.google.com/maps/billing-and-pricing/pricing |
| Google caching | Place IDs may be stored indefinitely; other content may not be cached. Lat/lng may be cached for ≤30 days (Service Specific Terms; checked in archived versions only). | https://developers.google.com/maps/documentation/places/web-service/policies , https://cloud.google.com/maps-platform/terms/maps-service-terms/index-20240522 |
| NIPOST | Legacy 6-digit postcodes (Abuja general 900001; district codes conflict across sites). NIPOST is introducing an **11-character building-level alphanumeric postcode**, e.g. `FC 02 A09 DB 09`, where "FC" is the FCT. Accept both formats. A public API for postcode.gov.ng is **unconfirmed**. | https://nipost.gov.ng/what-is-the-new-alphanumeric-postcode/ , https://nipost.gov.ng/9-things-people-get-wrong-about-the-new-postcode/ |

The Nominatim policy says an LLM may suggest the service only if it points prominently to the policy (same source). This table does that.

---

## 5. Nigeria go-live context

### NDPA 2023 / GAID 2025

- **What applies to us:** names, phone numbers and addresses are personal data.
- **Principles (s.24, via commentary):** lawfulness, data minimisation, purpose limitation, storage limitation, integrity and confidentiality, accountability. https://www.mondaq.com/nigeria/data-protection/1366934/the-nigerias-data-protection-act-2023-a-look-at-key-provisions
- **Lawful bases (s.25):** include contract and legitimate interest (same source).
- **GAID Article 7 duties** (https://ndpc.gov.ng/wp-content/uploads/2025/07/NDP-ACT-GAID-2025-MARCH-20TH.pdf):
  - Publish a privacy policy.
  - Run an NDP Act compliance audit within 15 months of starting, then annually.
  - Notify the NDPC of breaches **within 72 hours**.
  - Notify data subjects of high-risk breaches immediately.
  - Update processor agreements.
  - Make data access, correction and portability easy.
  - Register if designated "of major importance" (Art. 9).
- **GAID effective date:** 19 Sep 2025 per commentary. https://privacymatters.dlapiper.com/2025/06/nigeria-ndpc-issues-gaid-key-compliance-insights/
- **Cross-border transfer:** D1 **does not run in Africa** ("not currently supported for… Africa (`afr`)") (https://developers.cloudflare.com/d1/configuration/data-location/), so customer data leaves Nigeria. Part VIII of the NDPA governs this (GAID Art. 45, same PDF).
- **Action items:** document the transfer basis, minimise and redact phone numbers in logs, and set retention for job records.

### WhatsApp Business Platform

- **24-hour customer service window:** "opens and resets with each user message". Free-form messages are only allowed inside it. Outside it, only templates (marketing / utility / authentication). https://developers.facebook.com/docs/whatsapp/pricing
- **Pricing:** per-message since 1 Jul 2025. Rates updated 1 Oct 2026; 1,000 free service messages per number per month (same source).
- **Consequence for us:** a "payment received" or "rider assigned" message sent hours later needs an approved **utility template**.
- **Messaging policy** (https://whatsappbusiness.com/policy/):
  - Opt-in is required.
  - Automation needs "prompt, clear, and direct escalation paths" to a human.
  - Never request full card numbers. Paystack checkout satisfies this.
- **AI Providers clause:** in force from 15 Jan 2026, it bars general-purpose AI assistants, but customer-service bots remain allowed. Secondary reporting only; I could not read the official terms page. https://tech.yahoo.com/ai/meta-ai/articles/whatssapp-changes-terms-bar-general-141214399.html

---

## 6. Edge-case checklist

1. **Model invents a price.** No tool takes an amount. Descriptions forbid estimating. The payment amount is read from D1 (`quotes.amount_kobo`). Verify compares against D1, never against model input.
2. **Stale quote.** Store `expires_at` (`QUOTE_TTL_MINUTES`). Expired `quote_id` → `isError` with "re-quote". Never silently re-price.
3. **Double-tap on create_payment_link.** One active payment per job, enforced with a `UNIQUE(job_id) WHERE status IN ('pending')`-style rule or a check-then-insert in `batch()`. Return the existing unexpired `authorization_url`.
4. **Reference reuse or collision.** Generate a reference such as `ZD-<job>-<attempt>` (allowed charset only) and persist it **before** initialize. On a duplicate-reference error, look up the original instead of creating a new one.
5. **Amount or currency mismatch on verify.** Return `amount_mismatch`, do not mark paid, and flag for a human (https://docs-v2.paystack.com/payments/accept-payments).
6. **Concurrent verify calls, or verify plus a future webhook.** Use `UPDATE payments SET status='paid' WHERE reference=? AND status<>'paid'`. Only the caller seeing `meta.changes === 1` triggers dispatch.
7. **`ongoing`/`pending` status.** Answer "not yet; complete the OTP/transfer", don't poll in a loop (rate limits), and let the agent re-verify on the customer's next message.
8. **Abandoned or expired link.** Offer a fresh link (new reference, same server amount). Re-verify the old reference once before cancelling.
9. **Out-of-coverage address.** `in_coverage: false` plus the list of served areas. `quote_delivery` refuses addresses outside coverage.
10. **Ambiguous geocode** (e.g. "Wuse" vs "Wuse 2"). Return ≤3 candidates with labels and make the agent confirm with the customer. Cross-check providers and lower confidence when they disagree by more than a configured distance.
11. **Provider timeout, 429 or down.** Per-provider `AbortSignal.timeout` (`PROVIDER_TIMEOUT_MS`), then fall through the chain. Stay within the Free-plan 50-subrequest and 6-pending-connection limits. Report the provider used. For OSRM errors, fall back to straight-line distance with a clearly labelled surcharge factor.
12. **Retries and idempotency of writes.**
    - `create_dispatch_job` is keyed on `quote_id` (one job per quote).
    - `create_payment_link` is keyed on `job_id`.
    - Both return the existing record on retry, which is what `idempotentHint: true` claims.
13. **Customer changes their mind mid-flow** (new drop-off after paying the link). A new quote means a new job, or a job update before payment only. Never change the amount of an initialised Paystack transaction. A paid job needs a human or refund path.
14. **Wrong or unknown IDs passed by the model.** Return `isError` naming the expected source tool. Use server-issued handles, not raw coordinates.
15. **Phone and email formats.** Normalise Nigerian numbers to E.164 (+234…). Synthesise the Paystack email from the phone if none is given.
16. **Logging.** Never log the bearer token, Paystack secret or full phone numbers (NDPA minimisation). Log the reference, job_id and provider latency.
17. **WhatsApp window closed** when payment lands later. A proactive update needs a utility template. Otherwise wait for the customer's next message and then verify.

---

## 7. Applied status (updated 2026-10-20, after the tool-logic build)

Rows 11–30 are now implemented. The evidence for each one (unit, end-to-end or manual test) is in [docs/EDGE_CASES.md](../docs/EDGE_CASES.md).

Legend: ✅ in the code and verified · 🔜 planned for the tool-logic step · 📝 goes in the README or go-live note · ⏭️ decided against (reason given)

| # | Recommendation | Status | Where / evidence |
|---|---|---|---|
| 1 | Raw SDK v1 stateless transport, not `agents`/`McpAgent` | ✅ | `src/mcp/server.ts`. Chord's discovery sends `tools/list` with no `initialize`, which only works because we are stateless |
| 2 | Workers-safe JSON Schema validator (no `eval`) | ✅ | `CfWorkerJsonSchemaValidator`; CPU measured with `wrangler tail` (median 4 ms) |
| 3 | Bearer check before the MCP handler, constant-time, never logged | ✅ | `src/index.ts`, `src/lib/auth.ts` (SHA-256 both sides, then `timingSafeEqual`) |
| 4 | Validate `Origin` (MCP MUST) | ✅ | Added after review: any `Origin` → 403. Chord sends none (verified from 4 captured requests) |
| 5 | Business errors as `isError` results with actionable hints; JSON in text and `structuredContent` | ✅ | `src/mcp/tooling.ts` |
| 6 | No tool accepts a price or amount; server-issued handles instead of coordinates | ✅ | Schemas are `.strict()`; extra keys such as `amount` get a steering error |
| 7 | 3–4 sentence descriptions (what, when, caveats); annotations set | ✅ | `src/tools/index.ts`. `resolve_address` is `readOnlyHint:false` on purpose because it writes a place row |
| 8 | Reference format `ZD-<job>-<attempt>`, allowed charset only | ✅ | `src/lib/ids.ts` |
| 9 | One job per quote (`UNIQUE(quote_id)`); payments `UNIQUE(job_id, attempt)` | ✅ | `migrations/0001_init.sql` |
| 10 | `prepare().bind()` everywhere | ✅ so far | Only statement today: the tool_calls insert |
| 11 | Verify grants "paid" only if status, amount, currency and reference all match | ✅ | verify_payment |
| 12 | Conditional `UPDATE … WHERE status<>'paid'` + `meta.changes` against races | ✅ | verify_payment |
| 13 | `batch()` for multi-row writes (job + event) | ✅ | create_dispatch_job |
| 14 | `AbortSignal.timeout` on every outbound call; Paystack ~8 s | ✅ | `src/lib/http.ts` |
| 15 | Paystack 429 → read `x-ratelimit-reset`, tell the agent to retry shortly; no polling loops | ✅ | Paystack client |
| 16 | On an initialize timeout, retry with the **same** reference; a duplicate means it succeeded, so recover by verifying | ✅ | create_payment_link |
| 17 | Persist the reference before calling initialize; return the stored `authorization_url` on repeat | ✅ | create_payment_link |
| 18 | `metadata.custom_fields` with job_id and quote_id; `callback_url` page that verifies | ✅ | create_payment_link, `/pay/return` |
| 19 | Paystack email synthesised without real PII | ✅ | `<job>@customers.zuma-dispatch.test`-style placeholder (Paystack suggests phone-based; we avoid sending the phone) |
| 20 | `ongoing`/`pending` handled as non-final | ✅ | verify_payment |
| 21 | Abandoned link → new attempt, same server amount; re-verify the old reference first | ✅ | create_payment_link |
| 22 | Quote `expires_at`; expired quote → "re-quote", never silently re-price | ✅ | quote_delivery / create_dispatch_job |
| 23 | Coverage check (`in_service_area`), quote refuses out-of-area | ✅ | resolve_address / quote_delivery |
| 24 | ≤3 candidates on ambiguity; crosscheck lowers confidence on disagreement | ✅ | geocoder chain |
| 25 | Nominatim: identifying UA, ≤1 req/s, D1 cache, no PII in queries | ✅ | geocoder chain (`geocode_cache` table exists) |
| 26 | Respect the 6-pending-connections and 50-subrequest limits | ✅ | crosscheck runs exactly 2 in parallel |
| 27 | OSRM `lon,lat` order and `code === "Ok"` | ✅ | router chain |
| 28 | Accept new 11-char postcodes and legacy 6-digit codes | ✅ | resolve_address |
| 29 | Normalise Nigerian phones to E.164; never log full numbers | ✅ | create_dispatch_job |
| 30 | Unit test for wrong-amount verify; test cards documented | ✅ | `test/` + README |
| 31 | Webhook HMAC-SHA512 + Paystack IPs + double-fulfilment guard | 📝 | Out of scope (on-demand verify); go-live note |
| 32 | Paystack secret-key IP whitelisting impractical on Workers | 📝 | Go-live note |
| 33 | Paystack fees 1.5% + ₦100 (waived < ₦2,500, cap ₦2,000) | 📝 | Go-live note (who absorbs fees) |
| 34 | Nominatim forbids tracking apps on the public instance; OSRM demo is non-commercial | 📝 | README provider table + go-live |
| 35 | NDPA: D1 has no Africa region → cross-border transfer; 72 h breach notice; retention | 📝 | Go-live note |
| 36 | WhatsApp 24 h window; proactive updates need utility templates; human escalation path | 📝 | Go-live note + skill escalation rules |
| 37 | Go-forward path is SDK v2 + `createMcpHandler` | 📝 | README "what we'd do next" |
| 38 | `response_format` concise/detailed | ⏭️ | Every output is already small (< 1 KB); adds a parameter the model must choose without benefit |
| 39 | `input_examples` | ⏭️ | Not part of MCP tool definitions; examples live in parameter descriptions instead |
| 40 | Let OPTIONS preflight through for browser inspectors | ⏭️ | Browser access is refused by design (row 4) |
| 41 | Drop the redundant `nodejs_compat` flag | ⏭️ | Harmless; kept so the config is explicit on older compatibility dates |

**Corrections to the report:**
- **ORS Geocoding quota:** the report gives 1,000/day from search snippets. The plans page, read directly in the browser on 2026-10-20, says **3,000/day, 100/min** (Directions 2,000/40).
- **Findings that weren't in the report:** D1 was moved WEUR → ENAM because Chord calls from AWS IAD.
