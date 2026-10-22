#!/usr/bin/env python3
"""
End-to-end run of the booking flow against a live server, calling the MCP tools exactly
as Chord does (JSON-RPC over POST, bearer auth). Uses real geocoders and Paystack TEST mode.
Costs no Chord credits.

Usage:  python3 scripts/e2e.py [base_url] [--keep]   (default http://127.0.0.1:8787)
Reads MCP_BEARER_TOKEN from the environment or .env. Never prints it.

Cleans up after itself: on exit (pass, fail, error or Ctrl-C) it asks the server to delete this run's
jobs, payments, events, webhook log entries and tool calls (POST /mcp/test-cleanup), so the board, the
owner's sheet and the tool-call stats show no trace of it. --keep leaves the data for debugging; clean
it up later with:  python3 scripts/e2e.py <base_url> --cleanup <run>
"""
import atexit, hashlib, hmac, json, os, sys, time, urllib.request, urllib.error

_argv = sys.argv[1:]
if "--cleanup" in _argv:  # the run id after --cleanup is not the base URL
    del _argv[_argv.index("--cleanup") + 1 : _argv.index("--cleanup") + 2]
ARGS = [a for a in _argv if not a.startswith("--")]
KEEP = "--keep" in sys.argv
BASE = (ARGS[0] if ARGS else "http://127.0.0.1:8787").rstrip("/")
TOKEN = os.environ.get("MCP_BEARER_TOKEN")
if not TOKEN and os.path.exists(".env"):
    for line in open(".env", encoding="utf-8"):
        if line.startswith("MCP_BEARER_TOKEN="):
            TOKEN = line.split("=", 1)[1].strip()
assert TOKEN, "MCP_BEARER_TOKEN not set"
PAYSTACK_KEY = os.environ.get("PAYSTACK_TEST_SECRET_KEY")
if not PAYSTACK_KEY and os.path.exists(".env"):
    for line in open(".env", encoding="utf-8"):
        if line.startswith("PAYSTACK_TEST_SECRET_KEY="):
            PAYSTACK_KEY = line.split("=", 1)[1].strip()


def paystack_hook(event, reference, signature=None):
    """POSTs a Paystack-style webhook signed with our test key (as Paystack would)."""
    body = json.dumps({"event": event, "data": {"id": int(time.time() * 1000), "reference": reference, "amount": 1, "currency": "NGN", "status": "success"}}).encode()
    sig = signature or hmac.new(PAYSTACK_KEY.encode(), body, hashlib.sha512).hexdigest()
    req = urllib.request.Request(f"{BASE}/hooks/paystack", data=body, method="POST", headers={
        "Content-Type": "application/json", "x-paystack-signature": sig, "User-Agent": "zuma-dispatch-e2e/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code

results = []
_id = 0
# Unique per-run test identities: production is shared with real (simulator) conversations, and the
# server's duplicate-booking guard matches on sender + recipient + route. Never reuse fixed names.
RUN = format(int(time.time()) % 100000, "05d")
if "--cleanup" in sys.argv:
    RUN = sys.argv[sys.argv.index("--cleanup") + 1]
SENDER = f"E2E Sender {RUN}"
RECIPIENT = f"E2E Recipient {RUN}"
PHONE_A = f"0809{RUN}11"[:11]
PHONE_B = f"0907{RUN}22"[:11]


def call(tool, **args):
    global _id
    _id += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _id, "method": "tools/call", "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request(f"{BASE}/mcp", data=body, method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": f"Bearer {TOKEN}",
        # Tags the server's tool-call log with this run, so the cleanup can remove exactly these rows.
        "X-Request-ID": f"test-{RUN}-{_id}",
        # Cloudflare answers the default Python-urllib UA with error 1010 before the Worker runs.
        "User-Agent": "zuma-dispatch-e2e/1.0"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.load(r)["result"]
    ms = int((time.time() - t) * 1000)
    data = res.get("structuredContent") or json.loads(res["content"][0]["text"])
    return data, bool(res.get("isError")), ms


def cleanup():
    """Deletes everything this run created. Runs on every exit unless --keep."""
    body = json.dumps({"run": RUN}).encode()
    req = urllib.request.Request(f"{BASE}/mcp/test-cleanup", data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}", "User-Agent": "zuma-dispatch-e2e/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.load(r)
        d = out["deleted"]
        print(f"\nCleaned up run {RUN}: {out['jobs']} job(s), {d['payments']} payment(s), {d['job_events']} event(s), "
              f"{d['paystack_events']} webhook log entr{'y' if d['paystack_events'] == 1 else 'ies'}, {d['tool_calls']} tool call(s); sheet: {out['sheet']}.")
    except urllib.error.HTTPError as e:
        print(f"\nCLEANUP FAILED for run {RUN}: HTTP {e.code} {e.read()[:300]!r}. Retry: python3 scripts/e2e.py {BASE} --cleanup {RUN}")
    except Exception as e:  # network down, server not running
        print(f"\nCLEANUP FAILED for run {RUN}: {e}. Retry: python3 scripts/e2e.py {BASE} --cleanup {RUN}")


if "--cleanup" in sys.argv:
    cleanup()
    sys.exit(0)
print(f"Run {RUN} against {BASE}" + (" (--keep: data stays)" if KEEP else " (cleans up on exit)"))
if not KEEP:
    atexit.register(cleanup)


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

section("Two states: FCT and Lagos, same-state deliveries only")
lp, err, ms = call("resolve_address", text="Ikeja City Mall", role="pickup")
check("Lagos landmark resolves, labelled Lagos", not err and lp["status"] in ("confirmed", "ambiguous") and (lp.get("place") or lp["candidates"][0]).get("state") == "Lagos", lp, ms)
lagos_pickup = (lp.get("place") or lp["candidates"][0])["place_id"]
ld, err, ms = call("resolve_address", text="Lekki Phase 1", role="dropoff", state="lagos")
check("second Lagos address with state hint", not err and ld["status"] in ("confirmed", "ambiguous", "needs_detail"), ld, ms)
lagos_drop = (ld.get("place") or (ld.get("candidates") or [{}])[0]).get("place_id")
if lagos_drop and ld["status"] != "needs_detail":
    lq, err, ms = call("quote_delivery", pickup_place_id=lagos_pickup, dropoff_place_id=lagos_drop, package_size="small")
    check("Lagos -> Lagos quote", not err and lq.get("total", "").startswith("₦"), lq, ms)
    if not err:
        lj, err, ms = call("create_dispatch_job", quote_id=lq["quote_id"], sender_name=f"E2E Lagos {RUN}", recipient_name=f"E2E Lagos Recipient {RUN}", recipient_phone=f"0817{RUN}44"[:11], customer_confirmed=True)
        check("Lagos job booked", not err and lj.get("job_id", "").startswith("ZD-"), lj, ms)
        if not err:
            lc, err, ms = call("cancel_job", job_id=lj["job_id"], reason="e2e Lagos check")
            check("Lagos job cancelled (unpaid)", not err and lc.get("status") == "cancelled", lc, ms)
q, err, ms = call("quote_delivery", pickup_place_id=lagos_pickup, dropoff_place_id=dropoff, package_size="small")
check("Lagos -> Abuja quote refused (INTERSTATE_NOT_SUPPORTED)", err and q.get("error", {}).get("code") == "INTERSTATE_NOT_SUPPORTED", q, ms)
x, err, ms = call("resolve_address", text="Jabi Lake Mall", role="dropoff", state="lagos")
check("Abuja place during a Lagos booking -> interstate note", not err and "We only deliver within one state" in x.get("what_to_do", ""), x, ms)
x, err, ms = call("resolve_address", text="Ota, Ogun State", role="dropoff")
check("Ogun (Lagos's neighbour) -> out_of_area", not err and x["status"] == "out_of_area", x, ms)
x, err, ms = call("resolve_address", text="Suleja", role="dropoff", state="abuja")
check("Suleja (Niger, next to Abuja) -> out_of_area", not err and x["status"] == "out_of_area", x, ms)
x, err, ms = call("resolve_address", text="FC-01-A01-KP-27", role="pickup")
check("NIPOST sandbox code (Abaji, FCT) -> in coverage, ask for a landmark", not err and x["status"] == "needs_detail" and (x.get("place") or {}).get("state") == "Abuja (FCT)", x, ms)
x, err, ms = call("resolve_address", text="la11zdmps01", role="pickup")
check("demo postcode (any format) -> exact place: Paystack office, Lagos", not err and x["status"] == "confirmed" and "Paystack" in x["place"]["label"] and x.get("postcode", {}).get("nipost_status") == "demo", x, ms)
x, err, ms = call("resolve_address", text="Lagos", role="pickup")
check("just 'Lagos' -> needs_detail", not err and x["status"] == "needs_detail", x, ms)

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
base = dict(quote_id=q["quote_id"], sender_name=SENDER, recipient_name=RECIPIENT, recipient_phone=PHONE_A)
x, err, ms = call("create_dispatch_job", **base, customer_confirmed=False)
check("no explicit yes -> refused with read-back hint", err and "Send the quote" in json.dumps(x) and "customer_confirmed" in json.dumps(x), x, ms)
x, err, ms = call("create_dispatch_job", **{**base, "recipient_phone": "12345"}, customer_confirmed=True)
check("bad phone -> INVALID_DETAILS", err and x["error"]["code"] == "INVALID_DETAILS", x, ms)
j, err, ms = call("create_dispatch_job", **base, customer_confirmed=True)
check("booking is reserved without a handover code (code only after payment)", not err and "handover_code" not in j and "Reserved" in j.get("what_to_do", ""), j, ms)
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
section("Paystack webhook (server learns about payment without the customer saying 'paid')")
st = paystack_hook("charge.success", l1["reference"], signature="00" * 64)
check("webhook with a bad signature -> 401", st == 401, {"status": st}, 0)
st = paystack_hook("charge.success", l1["reference"])
v_after, err, ms = call("verify_payment", job_id=job)
check("signed 'charge.success' for an unpaid link -> 200, job stays unpaid (server re-verifies with Paystack)", st == 200 and not err and v_after["payment_status"] == "not_paid_yet", {"status": st, **v_after}, ms)
st = paystack_hook("charge.success", f"E2E-{RUN}-NOT-OURS")
check("event for a reference that isn't ours -> 200 (acknowledged, ignored)", st == 200, {"status": st}, 0)

s, err, ms = call("get_job_status", job_id=job)
check("status readable", not err and s["status"] == "awaiting_payment", s, ms)
x, err, ms = call("get_job_status", job_id="ZD-ZZZZZ")
check("unknown job -> JOB_NOT_FOUND", err and x["error"]["code"] == "JOB_NOT_FOUND", x, ms)

section("Status without a job id (recipient phone + sender name)")
s1, err, ms = call("get_job_status", recipient_phone=PHONE_A.replace("0", "+234", 1), sender_name=SENDER.split()[0])
check("found by recipient phone (any format) + first name", not err and s1.get("job_id") == job, s1, ms)
check("phone lookup never reveals the handover code", "handover_code" not in s1, s1, ms)
x, err, ms = call("get_job_status", recipient_phone=PHONE_A, sender_name="Somebody Else")
check("wrong sender name -> JOB_NOT_FOUND", err and x["error"]["code"] == "JOB_NOT_FOUND", x, ms)
x, err, ms = call("get_job_status")
check("no id and no details -> asks for them (NEED_JOB_REFERENCE)", err and x["error"]["code"] == "NEED_JOB_REFERENCE", x, ms)

section("Cancel")
c, err, ms = call("cancel_job", job_id=job, reason="changed my mind")
check("unpaid job cancels", not err and c["status"] == "cancelled", c, ms)
c2, err, ms = call("cancel_job", job_id=job, reason="again")
check("cancel is idempotent", not err and c2.get("already_cancelled"), c2, ms)
x, err, ms = call("create_payment_link", job_id=job)
check("no link for a cancelled job", err and x["error"]["code"] == "JOB_CANCELLED", x, ms)

section("Lost context between turns (Chord shows the model no earlier tool results)")
d_again, err, ms = call("resolve_address", text="Wuse Market, Abuja", role="dropoff")
check("same text -> same place_id (stable across turns)", not err and d_again.get("place", {}).get("place_id") == dropoff, d_again, ms)
d_alt, err, ms = call("resolve_address", text="Wuse Market Abuja please", role="dropoff")
alt_id = (d_alt.get("place") or (d_alt.get("candidates") or [{}])[0]).get("place_id")
qL, err, ms = call("quote_delivery", pickup_place_id=pickup, dropoff_place_id=dropoff, package_size="large")
qa, err, ms = call("quote_delivery", pickup_place_id=pickup, dropoff_place_id=alt_id, package_size="large")
check("alternative wording -> a different quote id for the same trip", not err and qa["quote_id"] != qL["quote_id"], qa, ms)
jb, err, ms = call("create_dispatch_job", quote_id=qL["quote_id"], sender_name=SENDER, recipient_name=RECIPIENT, recipient_phone=PHONE_B, customer_confirmed=True)
jd, err, ms = call("create_dispatch_job", quote_id=qa["quote_id"], sender_name=SENDER.upper(), recipient_name=RECIPIENT, recipient_phone="+234" + PHONE_B[1:], customer_confirmed=True)
check("same trip re-booked under a different quote id -> the open job is returned, no duplicate", not err and jd.get("already_booked") and jd["job_id"] == jb["job_id"], jd, ms)
qo, err, ms = call("quote_delivery", pickup_place_id=pickup, dropoff_place_id=alt_id, package_size="large")
jo, err, ms = call("create_dispatch_job", quote_id=qo["quote_id"], sender_name=f"Other Sender {RUN}", recipient_name=RECIPIENT, recipient_phone=PHONE_B, customer_confirmed=True)
check("a different sender to the same recipient is NOT merged", not err and not jo.get("already_booked") and jo["job_id"] != jb["job_id"], jo, ms)

section("Bank transfer (Paystack Pay with Transfer)")
q3, err, ms = call("quote_delivery", pickup_place_id=pickup, dropoff_place_id=dropoff, package_size="medium")
j3, err, ms = call("create_dispatch_job", quote_id=q3["quote_id"], sender_name=f"E2E Transfer {RUN}", recipient_name=RECIPIENT, recipient_phone=f"0816{RUN}33"[:11], customer_confirmed=True)
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

if KEEP:
    print(f"\nPAYMENT LINK (pay with test card 4084 0840 8408 4081 / CVV 408 to test 'paid' manually; job is cancelled so it will flag needs_review):\n  {l1.get('payment_url')}")
print(f"\n{sum(results)} passed, {len(results) - sum(results)} failed")
sys.exit(0 if all(results) else 1)
