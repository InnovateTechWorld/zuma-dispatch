#!/usr/bin/env python3
"""
End-to-end run of the booking flow against a live server, calling the MCP tools exactly
as Chord does (JSON-RPC over POST, bearer auth). Uses real geocoders and Paystack TEST mode.
Costs no Chord credits.

Usage:  python3 scripts/e2e.py [base_url]        (default http://127.0.0.1:8787)
Reads MCP_BEARER_TOKEN from the environment or .env. Never prints it.
"""
import json, os, sys, time, urllib.request, urllib.error

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787").rstrip("/")
TOKEN = os.environ.get("MCP_BEARER_TOKEN")
if not TOKEN and os.path.exists(".env"):
    for line in open(".env", encoding="utf-8"):
        if line.startswith("MCP_BEARER_TOKEN="):
            TOKEN = line.split("=", 1)[1].strip()
assert TOKEN, "MCP_BEARER_TOKEN not set"

results = []
_id = 0


def call(tool, **args):
    global _id
    _id += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _id, "method": "tools/call", "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request(f"{BASE}/mcp", data=body, method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": f"Bearer {TOKEN}",
        # Cloudflare answers the default Python-urllib UA with error 1010 before the Worker runs.
        "User-Agent": "zuma-dispatch-e2e/1.0"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.load(r)["result"]
    ms = int((time.time() - t) * 1000)
    data = res.get("structuredContent") or json.loads(res["content"][0]["text"])
    return data, bool(res.get("isError")), ms


def check(name, cond, data, ms):
    results.append(cond)
    mark = "PASS" if cond else "FAIL"
    print(f"  {mark}  {name}  ({ms} ms)")
    if not cond:
        print("        " + json.dumps(data)[:600])


def section(t):
    print(f"\n== {t}")


section("Address resolution")
p, err, ms = call("resolve_address", text="Jabi Lake Mall", role="pickup")
check("landmark resolves (confirmed or ambiguous)", not err and p["status"] in ("confirmed", "ambiguous"), p, ms)
pickup = p.get("place", {}).get("place_id") or p["candidates"][0]["place_id"]

d, err, ms = call("resolve_address", text="Wuse Market, Abuja", role="dropoff")
check("second landmark resolves", not err and d["status"] in ("confirmed", "ambiguous"), d, ms)
dropoff = d.get("place", {}).get("place_id") or d["candidates"][0]["place_id"]

d2, err, ms = call("resolve_address", text="Wuse Market, Abuja", role="dropoff")
check("repeat lookup served from cache (fast)", not err and ms < 3000, d2, ms)

x, err, ms = call("resolve_address", text="Ikeja City Mall, Lagos", role="dropoff")
check("Lagos address -> out_of_area", not err and x["status"] == "out_of_area", x, ms)

x, err, ms = call("resolve_address", text="Abuja", role="pickup")
check("just 'Abuja' -> needs_detail", not err and x["status"] == "needs_detail", x, ms)

x, err, ms = call("resolve_address", text="FC-02-A09-DB-09", role="pickup")
check("NIPOST postcode alone -> needs_detail with NIPOST area", not err and x["status"] in ("needs_detail", "out_of_area") and x.get("postcode", {}).get("code") == "FC-02-A09-DB-09", x, ms)
print("        NIPOST:", json.dumps(x.get("postcode")))

x, err, ms = call("resolve_address", text="Shoprite", role="pickup")
check("bare 'Shoprite' (many branches) -> ambiguous or confirmed, never an error", not err and x["status"] in ("ambiguous", "confirmed", "not_found"), x, ms)
print("        status:", x["status"], [c["label"] for c in x.get("candidates", [])][:3] or x.get("place", {}).get("label"))

x, err, ms = call("resolve_address", text="qwxzv plmkq nonsense place", role="pickup")
check("nonsense -> not_found with guidance", not err and x["status"] == "not_found" and "landmark" in x["what_to_do"], x, ms)

section("Quote")
q, err, ms = call("quote_delivery", pickup_place_id=pickup, dropoff_place_id=dropoff, package_size="small")
check("quote has server price", not err and q["total_kobo"] > 0 and q["total"].startswith("₦"), q, ms)
print(f"        {q.get('total')} for {q.get('distance_km')} km (approx={q.get('approximate_distance')})")
q2, err, ms = call("quote_delivery", pickup_place_id=pickup, dropoff_place_id=dropoff, package_size="small")
check("same request reuses the quote (stable price)", not err and q2["quote_id"] == q["quote_id"] and q2["reused_existing_quote"], q2, ms)
x, err, ms = call("quote_delivery", pickup_place_id=pickup, dropoff_place_id=pickup, package_size="small")
check("same pickup and drop-off -> SAME_LOCATION", err and x["error"]["code"] == "SAME_LOCATION", x, ms)
x, err, ms = call("quote_delivery", pickup_place_id="P-NOTREAL1", dropoff_place_id=dropoff, package_size="small")
check("invented place id -> PLACE_NOT_FOUND", err and x["error"]["code"] == "PLACE_NOT_FOUND", x, ms)
x, err, ms = call("quote_delivery", pickup_place_id=pickup, dropoff_place_id=dropoff, package_size="small", price=500)
check("model tries to pass a price -> rejected", err and x["error"]["code"] == "INVALID_ARGUMENTS", x, ms)

section("Booking")
base = dict(quote_id=q["quote_id"], sender_name="Ada Obi", recipient_name="Bola Musa", recipient_phone="0803 123 4567")
x, err, ms = call("create_dispatch_job", **base, customer_confirmed=False)
check("no explicit yes -> refused with read-back hint", err and "Read back" in json.dumps(x), x, ms)
x, err, ms = call("create_dispatch_job", **{**base, "recipient_phone": "12345"}, customer_confirmed=True)
check("bad phone -> INVALID_DETAILS", err and x["error"]["code"] == "INVALID_DETAILS", x, ms)
j, err, ms = call("create_dispatch_job", **base, customer_confirmed=True)
check("job created from quote amount", not err and j["status"] == "awaiting_payment" and j["amount_due"] == q["total"], j, ms)
job = j["job_id"]
j2, err, ms = call("create_dispatch_job", **base, customer_confirmed=True)
check("double 'yes' -> same job, not a duplicate", not err and j2["job_id"] == job and j2["already_booked"], j2, ms)

section("Payment")
l1, err, ms = call("create_payment_link", job_id=job)
check("Paystack test link created", not err and str(l1.get("payment_url", "")).startswith("https://checkout.paystack.com/"), l1, ms)
l2, err, ms = call("create_payment_link", job_id=job.lower().replace("-", ""))
check("second request (typed 'zd...' lower case) reuses the same link", not err and l2["reference"] == l1["reference"] and l2["reused_existing_link"], l2, ms)
v, err, ms = call("verify_payment", job_id=job)
check("unpaid -> not_paid_yet (never 'paid')", not err and v["payment_status"] == "not_paid_yet", v, ms)
s, err, ms = call("get_job_status", job_id=job)
check("status readable", not err and s["status"] == "awaiting_payment", s, ms)
x, err, ms = call("get_job_status", job_id="ZD-ZZZZZ")
check("unknown job -> JOB_NOT_FOUND", err and x["error"]["code"] == "JOB_NOT_FOUND", x, ms)

section("Cancel")
c, err, ms = call("cancel_job", job_id=job, reason="changed my mind")
check("unpaid job cancels", not err and c["status"] == "cancelled", c, ms)
c2, err, ms = call("cancel_job", job_id=job, reason="again")
check("cancel is idempotent", not err and c2.get("already_cancelled"), c2, ms)
x, err, ms = call("create_payment_link", job_id=job)
check("no link for a cancelled job", err and x["error"]["code"] == "JOB_CANCELLED", x, ms)

section("Bank transfer (Paystack Pay with Transfer)")
q3, err, ms = call("quote_delivery", pickup_place_id=pickup, dropoff_place_id=dropoff, package_size="medium")
j3, err, ms = call("create_dispatch_job", quote_id=q3["quote_id"], sender_name="Chidi Eze", recipient_name="Fatima Bello", recipient_phone="+234 809 555 0101", customer_confirmed=True)
check("second job booked", not err and j3["status"] == "awaiting_payment", j3, ms)
job3 = j3["job_id"]
t1, err, ms = call("create_payment_link", job_id=job3, method="bank_transfer")
check("transfer details: bank, account number, exact amount, expiry", not err and t1.get("account_number") and t1.get("bank") and t1["amount_exact"] == q3["total"] and t1["minutes_left"] >= 25, t1, ms)
print(f"        {t1.get('bank')} {t1.get('account_number')} ({t1.get('account_name')}) {t1.get('amount_exact')} until {t1.get('expires_at_wat')} WAT")
t2, err, ms = call("create_payment_link", job_id=job3, method="bank_transfer")
check("asking again returns the same account (no second account)", not err and t2["account_number"] == t1["account_number"] and t2["reused_existing_details"], t2, ms)
time.sleep(11)  # past the 10 s re-check throttle, so Paystack is really asked
v3, err, ms = call("verify_payment", job_id=job3)
check("nothing sent yet -> awaiting_transfer with the details", not err and v3["payment_status"] == "awaiting_transfer" and v3["account_number"] == t1["account_number"], v3, ms)
l3, err, ms = call("create_payment_link", job_id=job3)
check("customer switches to a card link -> warned to pay only one way", not err and l3["method"] == "link" and "only ONE way" in l3["what_to_do"], l3, ms)
c3, err, ms = call("cancel_job", job_id=job3, reason="will pay later")
check("cancel allowed while the transfer account is unpaid, with a 'don't transfer' warning", not err and c3["status"] == "cancelled" and "transfer account" in c3["what_to_do"], c3, ms)

print(f"\nPAYMENT LINK (pay with test card 4084 0840 8408 4081 / CVV 408 to test 'paid' manually; job is cancelled so it will flag needs_review):\n  {l1.get('payment_url')}")
print(f"\n{sum(results)} passed, {len(results) - sum(results)} failed")
sys.exit(0 if all(results) else 1)
