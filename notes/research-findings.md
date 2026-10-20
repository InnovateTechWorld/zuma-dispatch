# Research findings (2026-10-20)

Everything below was read in the docs or reproduced with a live call on 2026-10-20. Items marked **FIELD NOTE** are candidates for the deployment field notes.

## Accounts in Browser 1 (Chrome)
- Chord app and WhatsApp simulator: <Chord account email> ("Joshua Workspace")
- NIPOST dashboard: <NIPOST account email> (500 credits, org access level L1, one test key, scopes `search` and `lookup`)

## Chord
- **Credits: 10, not 50.** Billing reads "10 credits remaining", which matches the free Starter allowance, so the TSG top-up has probably not landed yet. **FIELD NOTE / ask Emmanuel.**
- The WhatsApp Simulator is already approved under Admin → Connected apps. It was granted Oct 20 with "Read app conversations, Send chat messages, Teammates, Email, Name".
- To use the simulator, open chat.tsglabs.dev → "Create chat link" for a teammate → enter a business name. Testers see the business name first, with the teammate underneath. Right now only "Chord Assistant" is listed.
- The simulator uses the Partner OAuth chat API. Replies are synchronous. `message_id` is the idempotency key. A paused, taken-over or duplicate turn returns `status:"accepted", reply:null`.
- Tools can be added in the UI at Admin → Channels & Tools → Tools:
  - **Custom tools (MCP)** → "Add server"
  - **Custom tools (API)** → plain REST endpoints, including "Import OpenAPI". The public docs cover only MCP; REST custom tools are undocumented. **FIELD NOTE.**
- Chord has a built-in **Paystack** connector (Not connected). We still write our own tool, because the brief requires a custom tool and we want server-owned amounts.
- Workspace opt-ins: Paystack, WhatsApp, Telegram and others show as Disabled.
- An API key exists: "Default Key" `chord_live_…`, full access, 60 rpm. The secret was shown only once, so to use the API the user must create a new key and put it in `.env` themselves.
- MCP requirements:
  - The server must use Streamable HTTP at a **public HTTPS** URL.
  - Supported auth is bearer, api_key or oauth.
  - Private and loopback URLs are blocked.
  - Registering a server does not prove it is reachable.
- **The health probe returns HTTP 200 even when it fails.** Read `status` (`ok`, `error` or `timeout`). **FIELD NOTE.**
- An empty `mcp_server_ids` on a teammate means "all enabled servers", not "none". `set_mcp_server_ids: []` does not clear the assignment.
- Skills:
  - Entrypoint is .md or .txt. References can be .md, .txt, .json, .yaml or .csv.
  - Limits: 64 files and 256 KiB per package, 64k chars of entrypoint per teammate.
  - Scripts never execute.
  - Only **published + included** skills affect replies. A draft is not live.
  - Creating a teammate from files publishes v1, but the teammate stays **paused** until activated.
- Turn budget:
  - Sync chat gives up after about 60 s and returns 502 ORCHESTRATOR_ERROR.
  - Streaming has a 120 s ceiling.
  - No MCP tool timeout is documented. Tools must therefore be fast, which makes the slow ORS calls a risk.
- Escalation:
  - The teammate calls a built-in `handover_to_human` tool, which moves the thread to `human_active`.
  - Stored escalation rules are off by default; the API returns 400 ESCALATION_RULES_DEPRECATED.
  - The docs never say how a SKILL.md should trigger escalation. Test it. **FIELD NOTE.**
  - Notification options: `PUT /v1/teammates/{id}/escalation-notifications {notify_to}`, or the `conversation.escalated` webhook.
- Doc inconsistency: chat.txt says an escalation rule "suppressed the reply". escalation-rules.txt says FORCE_TAKEOVER "does not stop the teammate answering".
- Builds seen: frontend 0.15.22 (c71c07e4adc8), required Core 0.16.0.0.

## NIPOST Postcode API (docs.postcode.gov.ng, api.postcode.gov.ng)
- Auth is the `X-API-Key` header. The test key is free and unmetered, and the rate limit is 600 per key.
- The docs say test keys resolve "a small, curated sample of public places only", and that five sandbox codes "always resolve under a test key": FC-01-A01-KP-27, -LR-01, -MH-01, -MV-01, -MW-01.
- **Reproduced:**
  - All 5 sandbox codes return `{"valid":false,"status":"not_found","verified":false}` with our test key, in every input format.
  - Autocomplete returns `suggestions: []` for every prefix (`F`, `FC`, `FC01A01`, `FC01A01KP`, `LA`).
  - `search/reverse` and `search/nearby` return nothing around central Abuja.
  - **The sandbox dataset is effectively empty for this key. FIELD NOTE.**
- What works with the test key:
  - `/healthz`
  - `/v1/assembly/disassemble` (and assemble)
  - `/v1/reference/states`, `/v1/reference/lgas?state=FC` (codes with names: 01 Abaji, 02 Abuja Municipal, 03 Bwari, 04 Gwagwalada, 05 Kuje, 06 Kwali), and `districts` / `areas` (codes only)
- Level 2 and above returns 403 `level_not_granted` ("this key is granted up to lookup level 1").
- **Design consequence:** L1 returns validity only, with no coordinates and no names. Coordinates need L5, which is restricted. NIPOST can therefore *validate* a postcode but cannot *locate* one. Plan:
  1. Disassemble the code.
  2. Use the reference endpoints to get the state and LGA names.
  3. Run an L1 validity check.
  4. Geocode "LGA, State" for an approximate area, then ask for a landmark for the exact pickup.
- The docs say "12 characters across 5 segments", but the compact form `EK01A03FK01` is **11** characters (14 with hyphens). **FIELD NOTE.**
- Note that FC LGA 01 is **Abaji**, not central Abuja. The sandbox "FCT public buildings" are in Abaji LGA.
- The OpenAPI spec lives at `docs.postcode.gov.ng/api-reference/openapi.yaml`. It is not on the API host, and `api.postcode.gov.ng/v1/openapi.json` answers 401 and then 404.

## OpenRouteService (HeiGIT)
- The free Standard plan allows Directions 2000/day (40/min) and Geocoding 3000/day (100/min). The response headers showed `x-ratelimit-limit` of 100 for geocode and 200 for directions.
- **Reliability:**
  - About half of geocode calls returned **HTTP 502** during testing, and retries usually succeeded.
  - One POST directions call timed out after 25 s. A GET directions call took **18 s**, then returned 5.16 km and 310 s for Jabi Lake Mall → Wuse Market.
  - **FIELD NOTE.** Needs a short timeout, one retry, a fallback, and caching.
- Good results: "Wuse Market, Abuja" (conf 1, exact), "Jabi Lake Mall, Abuja" (conf 0.8), "Ikeja City Mall, Lagos" (conf 0.8). "opposite Shoprite Lugbe" returned 0 results.
- **Maintenance window: Oct 23, 07:30–11:30 GMT+1.** Don't record then.
- Nominatim works as a fallback with a User-Agent, but it returned the wrong place for "Garki Area 11" (Area 1 / Area 2). The agent must read back the resolved label and get a "yes".

## Paystack (test mode)
- The secret key is `sk_test_` and the public key is `pk_test_` (prefixes checked; values never printed).
- Initialize: `POST /transaction/initialize` with `{email, amount (kobo, as a string or number), currency, reference, metadata, callback_url}`, which returns `authorization_url`, `access_code` and `reference`. Reference characters are limited to letters, digits, `-`, `.` and `=`.
- **Verify on an unpaid transaction returns `status:true, message:"Verification successful"` with `data.status:"abandoned"`.** Only `data.status == "success"` means paid; the top-level status describes the API call. Statuses are abandoned, failed, ongoing, pending, processing, queued, reversed and success.
- Re-initializing with the same reference returns 400 `duplicate_reference`. Store and reuse the first `authorization_url`.
- Paystack sends webhooks only for successful transactions. We verify on demand instead, since webhooks are out of scope.
- A probe transaction `takehome-probe-1792488665` (₦2,500, abandoned) now exists in the test dashboard.

## Observed Chord MCP client behaviour (from our Worker logs, 2026-10-20 13:00 UTC)
- Registered as server `mcp-4736c797-2bcc-40b9-937f-26c98a53b266` in workspace `ws-6f317367-26a3-4b04-b40e-c3d301b450f5`.
- **Saving the server sends no request to us.** The log stream was live during the save and showed zero requests.
- **Health** sends 3 POSTs in the same second: `initialize` (200), `notifications/initialized` (202) and `tools/list` (200). The UI shows "Health: ok · 386 ms".
- **Tools** discovery sends **one POST with no `initialize` first**. A server that requires sessions would fail here, so stateless was the right call.
- The client is `Java-http-client/23.0.2`. It runs on AWS and reaches Cloudflare's IAD (Virginia) edge.
  - Headers: `Accept: application/json, text/event-stream`. No `MCP-Protocol-Version` header and no `Mcp-Session-Id`.
- Because the Worker runs near the caller (IAD), the D1 database was moved from WEUR to **ENAM** (`zuma_dispatch_v2`) to avoid a transatlantic round trip (about 80–90 ms) on every query.
- CPU for Chord's calls was 1–11 ms.

## Chord teammate (created 2026-10-20 14:00 WAT)
- Name "Zuma", id `668480f8-a26a-43b6-9a32-ea9156f2fb4a`, autonomy autonomous, skill v1 published (3 files), status Active.
- First in-app test: 1 turn, 2 MCP tool calls (113 ms cached + 1,965 ms fresh), 0.08 credits. Balance 9.92.
