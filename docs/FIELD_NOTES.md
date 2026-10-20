# Deployment field notes

Each note covers what happened, how the cause was found, the fix or workaround, and
what would help the next builder. Times are Africa/Lagos (WAT).

> Working draft. Notes are added as they happen during the build and trimmed to the
> strongest two or three for the final submission.

---

## 1. NIPOST sandbox postcodes do not resolve under a test key

**What happened.** The NIPOST docs (Authentication → Test mode) list five sandbox postcodes that
"always resolve under a test key", for example `FC-01-A01-KP-27`. With our test key
(`nipost_test_…`, org level L1, scopes `search, lookup`), every one of them returned:

```json
{"data":{"postcode":"FC-01-A01-KP-27","valid":false,"status":"not_found","verified":false}}
```

Autocomplete returned `{"segment":"state","suggestions":[]}` for every prefix (`F`, `FC`,
`FC01A01`, `FC01A01KP`, `LA`). Reverse geocoding and nearby search returned nothing around central Abuja.

**How we found the cause.** We ruled out formatting first: the API rejects nothing, and the dashed,
spaced, compact and lower-case forms all return `not_found`. We ruled out auth: `level=2`
correctly returns `403 level_not_granted`, so the key is recognised. The free reference
endpoints (`/v1/reference/states`, `/lgas?state=FC`) and `/v1/assembly/disassemble` work.
So the key and gateway are fine, and the sandbox dataset behind this key appears empty.

**Workaround.** NIPOST is used for what works: structural validation, splitting the code into
segments, and naming the state and LGA from the reference endpoints (FC 02 → "Abuja Municipal").
That gives an area-level location. The agent then asks for a landmark to pin the exact pickup.
L1 lookups never return coordinates anyway (those need L5), so a postcode alone could never
place a pickup.

**What would help.** A sandbox health check in the NIPOST dashboard, or one documented
sandbox code that the docs' own CI verifies resolves. Also, the docs say a postcode is
"12 characters across 5 segments", but the compact form `EK01A03FK01` is 11.

---

## 2. CPU time on the Cloudflare Workers free plan (10 ms per request)

**What happened.** The first deploy worked end to end, but `wrangler tail` showed each MCP
request using **28–48 ms of CPU**. The free-plan limit is 10 ms. Requests were not rejected
yet, but sustained overage risks `Error 1102` in front of a reviewer.

**How we found the cause.** We measured `cpuTime` per request from `wrangler tail --format json`
and read the MCP TypeScript SDK source. Two costs ran on every request:
1. `new Server()` constructs an `AjvJsonSchemaValidator` by default, and Ajv is expensive to set up.
2. `McpServer` converts every zod input schema to JSON Schema on every `tools/list`.

**Fix.** We used the SDK's low-level `Server` with `CfWorkerJsonSchemaValidator`. Tool schemas
are compiled once at module load, and the SDK's message schemas are warmed at load, so the
cost lands in startup time (41 ms, separately limited) instead of request CPU.

| Version | CPU per request (ms) |
|---|---|
| McpServer, defaults | 28, 47, 48 |
| Low-level Server + cfworker validator | 13–29 cold, 1–3 warm |
| + module-scope compile and warm-up | median 4, max 13 (2 of 14 cold requests over 10) |

**What would help (Chord).** Nothing here was Chord's fault. A "hosting notes" section in the
MCP connections guide (latency budget per tool call, expected request pattern, whether Chord
calls `initialize` before every `tools/call`) would let builders size their server.

---

## 3. Registering the MCP server in the Chord app: browser autofill and a failed save

**What happened (2026-10-20, ~13:50 WAT).**
1. On opening **Admin → Channels & Tools → Tools → Custom tools (MCP) → Add server**, Chrome's
   password manager autofilled the form with the Chord *login*: the **URL** field held the
   account email (`<Chord account email>`) and the **Auth token** field held the saved Chord
   password. This reproduced on a second attempt. Submitted as-is, the builder's Chord password
   would be stored as the bearer token and sent to a third-party server on every tool call.
2. After the first submit (name "Zuma Dispatch tools", URL `https://zuma-dispatch.obimz123.workers.dev/mcp`,
   auth `bearer`), the server was **not** saved, and the Tools tab showed three red banners:
   "Could not load catalogs for this workspace.", "Could not load MCP servers for this
   workspace.", "Could not load API connections for this workspace." No error was shown on the
   form itself.

**How we found the cause.**
- Autofill: the token input is `type="password"`, and both fields sit in a form next to an email-like field
  with no `autocomplete` hints, so Chrome treats it as a login form.
- Failed save: a reload made all three list calls return `200` again
  (`GET /api/proxy/v1/workspaces/{ws}/mcp-servers` → `[]`, request id
  `ece22cd1-feb6-4b00-8cae-0c9f3ad71428`), so the banners were transient, and the server list was
  empty, so the save did not land. Network capture wasn't running during the first submit, so its
  status code is unknown. It was turned on for the retry.
- The MCP connections guide says registration only stores configuration and does not probe
  the server, so the failure was on Chord's side of the save, not a reachability check against our Worker.
  (Not yet confirmed from our Worker logs; to check on the retry.)

**Workaround.** Clear both autofilled fields by hand, re-enter the URL, paste the token from
`.env`, and resubmit with network capture on.

**What we'd change in Chord.**
- Mark the token input `autocomplete="new-password"` (or `off`) and the URL field `autocomplete="url"`,
  and validate that the URL starts with `https://` before submit. An email in the URL field
  should never pass client-side validation.
- When a save fails, show the error and request id on the form rather than failing silently
  and leaving list-level "Could not load …" banners with no request id.

---

## 4. Cloudflare blocks Python's default User-Agent (error 1010) before the Worker runs

**What happened.** The end-to-end script worked against `wrangler dev` but got `HTTP 403` against
production, while `curl` with the same token got 200. The body was just `error code: 1010`, and the
response had no `X-Request-ID`, so our Worker never ran.

**How we found the cause.** We sent the same request with three User-Agents:
`Python-urllib/3.14` → 403 (1010), `Java-http-client/23.0.2` (Chord's client, from our logs) → 200,
`curl/8.7.1` → 200. Error 1010 is Cloudflare's browser-signature block.

**Fix.** Scripts send their own User-Agent. Chord itself is unaffected, but this is fragile: if Chord's
client UA ever changed to something Cloudflare dislikes, tool calls would fail with no trace in our logs.

**What would help (Chord).** Document the User-Agent and egress IP ranges Chord uses for MCP calls, so
builders can allowlist them in a WAF instead of discovering blocks after the fact.

---

## 5. Free geocoders: latency, not just correctness, decides the design

**What happened.** The first cross-check version waited for both providers. Traces from our
`tool_calls` table showed Nominatim answering in 0.3–1.1 s, Photon in ~3.9 s or timing out at 4 s, and
ORS geocoding timing out at 4 s every time. A lookup could take **8 s**, and in Chord the customer waits
for the whole reply.

**How we found the cause.** Every tool call records its provider path, e.g.
`nominatim:ok:2:897ms>photon:timeout:4007ms>ors:timeout:4002ms`, which made the slow hop obvious.

**Fix.** The second opinion is time-boxed: when the first provider answers, the second gets 1.5 s more.
If it's late, we answer from one source (confidence `medium`) and let the late call finish in the background
(`ctx.waitUntil`), so its result lands in the D1 cache for next time. Cold lookups went from 8 s to ~1.5 s,
and cached ones to ~10 ms. The chain also stops starting new providers after 6 s.

**What would help (Chord).** State the per-tool-call timeout and whether Chord shows a "typing" state
while tools run. We could not find either in the docs, so we budgeted conservatively.

---

## 6. End-to-end testing caught a wrong answer that unit tests could not

**What happened.** A postcode-only message (`FC-02-A09-DB-09`) came back `ambiguous` with three
unrelated Abuja landmarks. The LGA query ("Abuja Municipal Area Council") matched several places, and
the ambiguity check ran before the "we only know the LGA" check.

**How we found it.** The first run of `scripts/e2e.py` (25 checks against real providers). Unit tests
had covered the decision functions in isolation, but not their order.

**Fix.** With only a postcode we keep a single point, label it honestly ("Abuja Municipal, Federal
Capital Territory (area of postcode FC-02-A09-DB-09)") and return `needs_detail`, which asks for a landmark.

---

## 7. Bank transfer: test mode can simulate the checkout transfer, not the API one

**What happened.** We added "pay by bank transfer" with the account details sent straight into the
WhatsApp chat (Paystack Charge API, `bank_transfer`). Test mode returns a realistic account
(`Test Bank`, a 10-digit number, `PAYSTACK CHECKOUT`, exact amount, 30-minute expiry) and verify
reports `ongoing` with "Please make a transfer to the account specified". Ten minutes later it was still
`ongoing`: there is no way to make money "arrive" at an API-issued test account.

**How we found it.** The checkout page's **Transfer** tab issues the same kind of account but has an
"I've sent the money" button. Clicking it in test mode made `verify_payment` return `paid` about 30 s
later (job ZD-YMK4G). So the verification path for transfers is proven through checkout.
The in-chat path is proven up to "awaiting transfer", plus the unit-tested decision logic.

**What would help (Paystack).** A test-mode endpoint, or a dashboard button, to simulate a credit to a
Charge-API transfer account, the way checkout already does.
