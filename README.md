# Zuma Dispatch: a WhatsApp delivery-booking agent on Chord

**Zuma** is a Chord teammate for a made-up same-day courier in Abuja and Lagos. A customer writes on
WhatsApp with a pickup and a drop-off, in landmarks, street names or postcodes. Zuma then:
1. finds both places and checks them with the customer;
2. quotes a price the server calculates;
3. reserves the job;
4. takes payment through Paystack (test mode), by card link or bank transfer;
5. assigns a rider and sends the customer the rider's name, number and a handover code;
6. answers "where is my rider?".

Refunds and complaints go to a person on the dispatcher board.

**Submission:** [SUBMISSION.md](SUBMISSION.md) has the role, problem statement and links to every
deliverable. The most important document is [docs/FIELD_NOTES.md](docs/FIELD_NOTES.md).

| | |
|---|---|
| Talk to it | https://chat.tsglabs.dev/c/i43ZuGQReP8Za95unSjXnHmG ([what to type](docs/TEST_SCRIPT.md)) |
| Tool server (MCP) | `https://zuma-dispatch.obimz123.workers.dev/mcp` (bearer token) · [health](https://zuma-dispatch.obimz123.workers.dev/health) |
| Dispatcher board | https://zuma-dispatch.obimz123.workers.dev/board (password on request) |
| Skill | [`skill/zuma-dispatch/`](skill/zuma-dispatch/SKILL.md) (v19 on Chord) |

Test keys and made-up data only. The server refuses to start with live Paystack or NIPOST keys.

## How it fits together

```
WhatsApp / simulator ── Chord (Zuma: skill + managed model)
                            │  MCP tool calls (bearer)
                            ▼
              Cloudflare Worker "zuma-dispatch" ── D1 (jobs, quotes, payments, cache, tool log)
               │ 8 tools            │ webhooks                     │ board + Google Sheet mirror
               ▼                    ▼                              ▼
   Google Places · Nominatim ·   Paystack (charge.success)     dispatchers / owner
   Photon · ORS · NIPOST · OSRM   Chord (handover)  ── Chord threads API (take over, reply, hand back)
```

The 8 tools are `resolve_address`, `quote_delivery`, `create_dispatch_job`, `create_payment_link`,
`verify_payment`, `get_job_status`, `cancel_job` and `hand_to_team`. What each one does, and how to run,
deploy and connect it, is in [docs/SETUP.md](docs/SETUP.md).

## How to run it

You need Node 20+, a free Cloudflare account, and test keys from Paystack and NIPOST. Google Maps and
OpenRouteService keys are optional: without them the free OpenStreetMap providers answer.

1. **Install and configure:**
   ```bash
   npm install && cp .env.example .env
   ```
   Fill in `.env`:
   - `PAYSTACK_TEST_SECRET_KEY` (must start `sk_test_`);
   - `NIPOST_API_KEY` (must start `nipost_test_`);
   - two random tokens, `MCP_BEARER_TOKEN` and `BOARD_TOKEN` (generate each with `openssl rand -hex 32`).

   The rest are optional.
2. **Run locally:**
   ```bash
   npm run db:migrate:local && npm run dev
   ```
   The tools are then at `http://127.0.0.1:8787/mcp` and the board at `/board`.
3. **Deploy:** run `npx wrangler login`, create the D1 database, apply `npm run db:migrate:remote`, load
   the secrets, then `npm run deploy`. The exact commands are in [SETUP.md](docs/SETUP.md#deploy).
4. **Connect it to Chord:**
   1. Admin → Channels & Tools → Custom tools (MCP) → Add server, with the `/mcp` URL and
      `MCP_BEARER_TOKEN` as the bearer token.
   2. Create a teammate from a ZIP of the *contents* of `skill/zuma-dispatch/`.
   3. Set it to Act independently, and resume it (it starts paused).
   4. Make a chat link at chat.tsglabs.dev.

   The steps, and what goes wrong at each one, are in [SETUP.md](docs/SETUP.md#connect-it-to-chord).

**Tests (no Chord credits):**
- `npm test`: 285 unit tests, no network.
- `scripts/mcp-smoke.sh [url]`: 25 protocol, auth and webhook checks.
- `python3 scripts/e2e.py [url]`: 54 end-to-end checks against the real providers and Paystack test mode.
- Both scripts delete their own test data when they finish.
- What was tested by hand in the simulator: [TESTING.md](docs/TESTING.md).

## Docs

| | |
|---|---|
| [FIELD_NOTES.md](docs/FIELD_NOTES.md) | The three Chord problems that mattered, with screenshots |
| [FIELD_NOTES_FULL.md](docs/FIELD_NOTES_FULL.md) | All 26 problems in the order we hit them |
| [DECISIONS.md](docs/DECISIONS.md) | Why: NIPOST demo postcodes, geocoders, state boundaries, handover, tracking, hosting |
| [GO_LIVE.md](docs/GO_LIVE.md) · [checklist](docs/GO_LIVE_CHECKLIST.md) | The owner's half page, and the technical steps |
| [FEATURES.md](docs/FEATURES.md) · [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [EDGE_CASES.md](docs/EDGE_CASES.md) | Detail |

## How AI tools were used

Built with Claude Code (Claude Opus) as a pair programmer. I chose the problem and directed and reviewed
the work.
- **Research.** It read the Chord, NIPOST, Paystack, Google and OpenRouteService docs and summarised them
  with citations ([notes/](notes/)).
- **Probing real APIs.** It ran curl and scripts against the real APIs. That is how we found:
  - NIPOST's empty sandbox;
  - ORS timeouts;
  - Cloudflare's 1010 block on Python;
  - that Chord sends no conversation id with tool calls.
- **Code, tests and docs.** It wrote these, and each was checked against live behaviour. Numbers such as
  CPU per request, provider latency and credits per turn come from real logs.
- **Debugging the agent.** The model's mistakes in the simulator (phantom corrections, a swallowed
  payment confirmation, a silent handover) were traced through Chord's thread API and our own tool-call
  log. Each was fixed on the server where possible, not only in the prompt.
- **What stayed with me:**
  - choosing the business and its scope;
  - every account action: keys, billing, registering the server in Chord, publishing the skill;
  - entering secrets;
  - testing as a customer would.
