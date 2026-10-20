#!/usr/bin/env bash
# Smoke-tests the MCP endpoint the same way Chord calls it (JSON-RPC over POST, bearer auth).
# Usage: scripts/mcp-smoke.sh [base_url]   (default http://127.0.0.1:8787)
# Reads MCP_BEARER_TOKEN from the environment or from .env. Never prints the token.
set -euo pipefail

BASE="${1:-http://127.0.0.1:8787}"
if [[ -z "${MCP_BEARER_TOKEN:-}" && -f .env ]]; then
  MCP_BEARER_TOKEN="$(grep -E '^MCP_BEARER_TOKEN=' .env | head -1 | cut -d= -f2-)"
fi
: "${MCP_BEARER_TOKEN:?MCP_BEARER_TOKEN not set}"

pass=0; fail=0
check() { # name expected_substring actual
  if [[ "$3" == *"$2"* ]]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        expected: $2"; echo "        got: ${3:0:400}"; fail=$((fail+1)); fi
}
rpc() { # body [auth_header]
  curl -sS -m 30 -X POST "$BASE/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H "${2:-Authorization: Bearer $MCP_BEARER_TOKEN}" -d "$1" -w '\nHTTP %{http_code}'
}

echo "MCP smoke test against $BASE"
check "health is ok"              '"status": "ok"'   "$(curl -sS -m 15 "$BASE/health")"
check "no token -> 401"           'HTTP 401'         "$(rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 'X-None: 1')"
check "wrong token -> 401"        'HTTP 401'         "$(rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 'Authorization: Bearer wrong')"
check "browser Origin -> 403"     'HTTP 403'         "$(curl -sS -m 15 -X POST "$BASE/mcp" -H 'Origin: https://evil.example' -H "Authorization: Bearer $MCP_BEARER_TOKEN" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' -w '\nHTTP %{http_code}')"
check "GET -> 405"               'HTTP 405'         "$(curl -sS -m 15 "$BASE/mcp" -H "Authorization: Bearer $MCP_BEARER_TOKEN" -w '\nHTTP %{http_code}')"
check "initialize"                '"serverInfo"'     "$(rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}')"
LIST="$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
for t in resolve_address quote_delivery create_dispatch_job create_payment_link verify_payment get_job_status cancel_job; do
  check "tools/list has $t" "\"$t\"" "$LIST"
done
check "schema rejects unconfirmed booking" 'isError' \
  "$(rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_dispatch_job","arguments":{"quote_id":"Q-X","sender_name":"Ada","recipient_name":"Bola","recipient_phone":"08031234567","customer_confirmed":false}}}')"
check "board requires login"      'HTTP 401'         "$(curl -sS -m 15 "$BASE/board" -w '\nHTTP %{http_code}')"

echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
