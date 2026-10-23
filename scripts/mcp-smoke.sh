#!/usr/bin/env bash
# Smoke-tests the MCP endpoint the same way Chord calls it (JSON-RPC over POST, bearer auth).
# Usage: scripts/mcp-smoke.sh [base_url]   (default http://127.0.0.1:8787)
# Reads MCP_BEARER_TOKEN from the environment or from .env. Never prints the token.
# Its tool calls are tagged "test-<run>-…" and removed on exit (POST /mcp/test-cleanup), so the
# board's tool-call stats never count a smoke run.
set -euo pipefail

BASE="${1:-http://127.0.0.1:8787}"
if [[ -z "${MCP_BEARER_TOKEN:-}" && -f .env ]]; then
  MCP_BEARER_TOKEN="$(grep -E '^MCP_BEARER_TOKEN=' .env | head -1 | cut -d= -f2-)"
fi
: "${MCP_BEARER_TOKEN:?MCP_BEARER_TOKEN not set}"

RUN="$(printf '%05d' $(( $(date +%s) % 100000 )))"
cleanup() {
  curl -sS -m 30 -o /dev/null -X POST "$BASE/mcp/test-cleanup" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $MCP_BEARER_TOKEN" -H 'User-Agent: zuma-dispatch-smoke/1.0' -d "{\"run\":\"$RUN\"}" || echo "  (cleanup of run $RUN failed)"
}
trap cleanup EXIT

pass=0; fail=0
check() { # name expected_substring actual
  if [[ "$3" == *"$2"* ]]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        expected: $2"; echo "        got: ${3:0:400}"; fail=$((fail+1)); fi
}
rpc() { # body [auth_header]
  curl -sS -m 30 -X POST "$BASE/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H "X-Request-ID: test-$RUN-$RANDOM" -H 'User-Agent: zuma-dispatch-smoke/1.0' \
    -H "${2:-Authorization: Bearer $MCP_BEARER_TOKEN}" -d "$1" -w '\nHTTP %{http_code}'
}

echo "MCP smoke test against $BASE"
check "health is ok"              '"status": "ok"'   "$(curl -sS -m 15 "$BASE/health")"
check "no token -> 401"           'HTTP 401'         "$(rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 'X-None: 1')"
check "wrong token -> 401"        'HTTP 401'         "$(rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 'Authorization: Bearer wrong')"
check "browser Origin -> 403"     'HTTP 403'         "$(curl -sS -m 15 -X POST "$BASE/mcp" -H 'Origin: https://evil.example' -H "Authorization: Bearer $MCP_BEARER_TOKEN" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' -w '\nHTTP %{http_code}')"
check "GET -> 405"               'HTTP 405'         "$(curl -sS -m 15 "$BASE/mcp" -H "Authorization: Bearer $MCP_BEARER_TOKEN" -w '\nHTTP %{http_code}')"
check "test cleanup needs the token"      'HTTP 401' "$(curl -sS -m 15 -o /dev/null -X POST "$BASE/mcp/test-cleanup" -H 'Content-Type: application/json' -H 'User-Agent: zuma-dispatch-smoke/1.0' -d '{"run":"00000"}' -w 'HTTP %{http_code}')"
check "initialize"                '"serverInfo"'     "$(rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}')"
LIST="$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
for t in resolve_address quote_delivery create_dispatch_job create_payment_link verify_payment get_job_status cancel_job hand_to_team; do
  check "tools/list has $t" "\"$t\"" "$LIST"
done
check "schema rejects unconfirmed booking" 'isError' \
  "$(rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_dispatch_job","arguments":{"quote_id":"Q-X","sender_name":"Ada","recipient_name":"Bola","recipient_phone":"08031234567","customer_confirmed":false}}}')"
if [[ -z "${BOARD_TOKEN:-}" && -f .env ]]; then BOARD_TOKEN="$(grep -E '^BOARD_TOKEN=' .env | head -1 | cut -d= -f2-)"; fi
check "board sends browsers to sign-in"   '303 '"$BASE"'/board/login?next=' "$(curl -sS -m 15 -o /dev/null "$BASE/board?status=paid" -w '%{http_code} %{redirect_url}')"
check "sign-in page loads"                'Sign in to the board' "$(curl -sS -m 15 "$BASE/board/login")"
check "wrong board password -> 401"       'HTTP 401'  "$(curl -sS -m 15 -o /dev/null -X POST "$BASE/board/login" -H "Origin: $BASE" -d 'password=wrong&next=/board' -w 'HTTP %{http_code}')"
check "sign-in blocks cross-site POST"    'HTTP 403'  "$(curl -sS -m 15 -o /dev/null -X POST "$BASE/board/login" -H 'Origin: https://evil.example' -d 'password=x' -w 'HTTP %{http_code}')"
check "browsers never get a password popup" 'no-challenge' "$(curl -sS -m 15 -D - -o /dev/null -u x:wrong "$BASE/board" | grep -qi '^www-authenticate' && echo challenge || echo no-challenge)"
check "scripts can use Basic auth"        'HTTP 200'  "$(curl -sS -m 15 -o /dev/null -u "dispatcher:${BOARD_TOKEN:-x}" "$BASE/board" -w 'HTTP %{http_code}')"
check "board blocks cross-site POST (CSRF)" 'HTTP 403'      "$(curl -sS -m 15 -u "dispatcher:${BOARD_TOKEN:-x}" -X POST "$BASE/board/jobs/ZD-00000" -H 'Origin: https://evil.example' -d 'action=dispatch&version=1' -w '\nHTTP %{http_code}')"
check "made-up tracking link -> 404"     'HTTP 404'  "$(curl -sS -m 15 -o /dev/null "$BASE/t/ZD-AAAAA-0123456789" -w 'HTTP %{http_code}')"
check "pay/return with unknown reference -> 404" 'HTTP 404' "$(curl -sS -m 15 "$BASE/pay/return?reference=ZD-NOPE0-1" -w '\nHTTP %{http_code}')"
WH="$(curl -sS -m 15 -X POST "$BASE/hooks/chord" -H 'Content-Type: application/json' -H 'X-Chord-Signature: sha256=00' -d '{}' -w '\nHTTP %{http_code}')"
if [[ "$WH" == *"HTTP 503"* ]]; then echo "  SKIP  chord webhook (CHORD_WEBHOOK_SECRET not set)"; else check "chord webhook rejects a bad signature" 'HTTP 401' "$WH"; fi

echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
