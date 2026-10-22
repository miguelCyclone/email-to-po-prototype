"""
Mock ERP endpoint for creating purchase orders.

Stands in for the customer's ERP. Post a requisition here once it has cleared its
approval chain and the ERP books it as a purchase order. Nothing is sent onward to
any supplier: orders are held in memory and, optionally, written to a JSON file.

Requires Python 3.9 or newer. No third-party packages.

    python3 mock_po_api.py                   # listens on 127.0.0.1:8080
    python3 mock_po_api.py 9000              # different port
    python3 mock_po_api.py 8080 orders.json  # also persist to a file

The ERP assigns the purchase order number. You never supply one, and a po_number
in the request body is ignored.

    POST /purchase-orders
      send:     supplier_id, currency, total, line_items[], plus any of the
                optional fields below
      returns:  201 and the booked order, including its po_number

    GET  /health                    -> 200 {"status": "ok", "orders": 0}
    GET  /purchase-orders           -> 200 [ every order booked so far ]
    GET  /purchase-orders/PO-...    -> 200 { one order } | 404

Send an Idempotency-Key header on the POST and a repeat of the same requisition
returns the order already booked, with 200, instead of booking a second one.

Required, or the order is rejected with 422:

    supplier_id
    currency                  CHF, EUR, USD or GBP
    total
    requested_delivery_date   YYYY-MM-DD
    line_items[]              every line needs item_name, quantity, unit_price
                              and unit

Optional. Absent or unrecognised values come back as `warnings` on the 201:

    cost_centre               may also be an asset, a project, or nothing at all
    gl_account
    tax_amount
    requisition_reference
    line_items[].item_code    a line may be free text instead

A 422 lists every problem it found, not just the first. The total is not required
to equal the sum of the line items; a difference is reported as a warning, and
`tax_amount` is taken into account when present.

Add ?strict=1 to the POST to have every warning rejected as an error instead.
"""
import argparse
import json
import math
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

CURRENCIES = ("CHF", "EUR", "USD", "GBP")
MAX_BODY = 5 * 1024 * 1024

# Without these the ERP has nothing to book. A purchase order is a commitment to
# a named vendor, for a priced quantity, to arrive on a date — a delivery date is
# as load-bearing as the price, and the ERP will not save a line without one.
PO_REQUIRED = ("supplier_id", "currency", "total", "requested_delivery_date")
LINE_REQUIRED = ("item_name", "quantity", "unit_price", "unit")

# Not required to book.
#   cost_centre  - account assignment may be a cost centre, an asset, a project,
#                  or nothing at all when the goods go to stock.
#   gl_account   - derived by account determination, not entered by the buyer.
#   item_code    - a line is either a material-number line or a free-text line,
#                  and free text is normal for one-off purchases.
PO_ADVISORY = ("cost_centre", "gl_account")
LINE_ADVISORY = ("item_code",)

# Fields that must be text when present. Checked before anything reads them: an
# id that arrives as an object or a list is not merely invalid, it would be
# looked up in a set and raise on an unhashable value.
PO_TEXT = ("supplier_id", "currency", "requested_delivery_date", "cost_centre",
           "gl_account", "requisition_reference")
LINE_TEXT = ("item_name", "unit", "item_code")

ORDERS = {}
BY_IDEMPOTENCY = {}
STORE_PATH = None
STORE_WRITABLE = True
LOCK = threading.Lock()
_next_number = 1


def say(*args):
    # A closed stdout must never cost a caller their response.
    try:
        print(*args)
        sys.stdout.flush()
    except (BrokenPipeError, ValueError, OSError):
        pass


def persist():
    """Best effort. A broken store must not cost the caller their response."""
    global STORE_WRITABLE
    if not STORE_PATH or not STORE_WRITABLE:
        return
    try:
        tmp = STORE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(list(ORDERS.values()), fh, indent=2, ensure_ascii=False)
        os.replace(tmp, STORE_PATH)
    except OSError as err:
        STORE_WRITABLE = False
        say(f"WARNING  cannot write {STORE_PATH} ({err}). Continuing in memory only.")


def is_number(v):
    # bool is a subclass of int in Python, and `"total": true` is not a total.
    # NaN and inf survive json.loads and must not reach an amount field.
    return (isinstance(v, (int, float)) and not isinstance(v, bool)
            and math.isfinite(v))


# When master_data.json sits beside this script, ids are checked against it and
# an unknown one is reported as a warning. Absent file, no checks.
MASTER = {"suppliers": set(), "cost_centres": set(), "gl_accounts": set()}


def load_master_data():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "master_data.json")
    try:
        with open(path, encoding="utf-8") as fh:
            md = json.load(fh)
        MASTER["suppliers"] = {s["id"] for s in md.get("suppliers", [])}
        MASTER["cost_centres"] = {c["code"] for c in md.get("cost_centers", [])}
        MASTER["gl_accounts"] = {g["code"] for g in md.get("gl_accounts", [])}
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False


def is_blank(v):
    return v is None or (isinstance(v, str) and not v.strip())


def validate(body, strict=False):
    """
    Return (errors, warnings). A non-empty `errors` means 422.

    Every problem is collected rather than returning on the first, so one round
    trip tells the caller everything that is wrong.
    """
    if not isinstance(body, dict):
        return ["body must be a JSON object"], []

    errors, warnings = [], []

    for field in PO_TEXT:
        value = body.get(field)
        if value is not None and not isinstance(value, str):
            errors.append(f"{field} must be a string, got "
                          f"{type(value).__name__} {value!r}")

    for field in PO_REQUIRED:
        if is_blank(body.get(field)):
            errors.append(f"{field} is required")
    for field in PO_ADVISORY:
        if is_blank(body.get(field)):
            warnings.append(f"{field} is missing; a complete purchase order carries one")

    currency = body.get("currency")
    if not is_blank(currency) and currency not in CURRENCIES:
        errors.append(f"currency {currency!r} is not one of {', '.join(CURRENCIES)}")

    total = body.get("total")
    if total is not None and not is_number(total):
        errors.append(
            f"total must be a number, got {type(total).__name__} {total!r}. "
            "Use a JSON number with a dot as the decimal separator, e.g. 1751.40")

    tax = body.get("tax_amount")
    if tax is not None and not is_number(tax):
        errors.append("tax_amount must be a number when present")

    delivery = body.get("requested_delivery_date")
    if not is_blank(delivery) and not (
            isinstance(delivery, str) and ISO_DATE.match(delivery)):
        warnings.append(f"requested_delivery_date {delivery!r} is not an "
                        "ISO 8601 date (YYYY-MM-DD)")

    for field, bucket, label in (("supplier_id", "suppliers", "supplier"),
                                 ("cost_centre", "cost_centres", "cost centre"),
                                 ("gl_account", "gl_accounts", "GL account")):
        value = body.get(field)
        if isinstance(value, str) and value.strip() and MASTER[bucket] \
                and value not in MASTER[bucket]:
            warnings.append(f"{label} {value!r} is not in the master data")

    lines = body.get("line_items")
    if not isinstance(lines, list) or not lines:
        errors.append("line_items must be a non-empty array")
        return errors, warnings

    reconcilable = True
    computed = 0.0
    for i, line in enumerate(lines, 1):
        if not isinstance(line, dict):
            errors.append(f"line {i} must be an object, got {type(line).__name__}")
            reconcilable = False
            continue
        for field in LINE_TEXT:
            value = line.get(field)
            if value is not None and not isinstance(value, str):
                errors.append(f"line {i}: {field} must be a string, got "
                              f"{type(value).__name__} {value!r}")
        for field in LINE_REQUIRED:
            if is_blank(line.get(field)):
                errors.append(f"line {i}: {field} is required")
        for field in LINE_ADVISORY:
            if is_blank(line.get(field)):
                warnings.append(f"line {i}: {field} is missing")

        q, p = line.get("quantity"), line.get("unit_price")
        for field, value in (("quantity", q), ("unit_price", p)):
            if value is not None and not is_number(value):
                errors.append(f"line {i}: {field} must be a number, "
                              f"got {type(value).__name__} {value!r}")
        if is_number(q) and is_number(p):
            computed += q * p
        else:
            reconcilable = False

    # Reported, not rejected: a header total may legitimately differ from the
    # sum of the lines. `tax_amount` accounts for the difference when sent.
    if is_number(total) and reconcilable:
        expected = computed + (tax if is_number(tax) else 0.0)
        if abs(expected - total) > 0.01:
            warnings.append(
                f"total {total:.2f} does not equal the sum of the line items "
                f"({computed:.2f})"
                + (f" plus tax_amount {tax:.2f}" if is_number(tax) else "")
                + ". If the difference is tax, send it as `tax_amount`.")

    if strict:
        errors.extend(warnings)
        warnings = []
    return errors, warnings


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MockERP/1.0"
    # Bounds a truncated body and reclaims idle keep-alive connections.
    timeout = 30

    def log_message(self, fmt, *args):
        # send_response() logs, so a closed stderr must not break a response.
        try:
            sys.stderr.write("  %s %s\n" % (self.command, self.path))
        except (BrokenPipeError, ValueError, OSError):
            pass

    # -- plumbing ---------------------------------------------------------

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, Idempotency-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, code, payload, extra_headers=()):
        raw = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        for k, v in extra_headers:
            self.send_header(k, v)
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def _send_no_content(self):
        """204 carries no body, and therefore no Content-Length."""
        self.send_response(204)
        self._cors()
        self.end_headers()

    def read_body(self):
        """
        Return the request body, or raise ValueError with a reportable message.

        Accepts either a Content-Length body or chunked transfer encoding; some
        HTTP clients chunk by default when Content-Length is not set explicitly.
        """
        encoding = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in encoding:
            chunks, total = [], 0
            while True:
                line = self.rfile.readline(65536).strip()
                if b";" in line:
                    line = line.split(b";", 1)[0]
                try:
                    size = int(line, 16)
                except ValueError:
                    raise ValueError(f"malformed chunk size {line!r}")
                if size == 0:
                    while True:                      # consume trailers
                        if self.rfile.readline(65536) in (b"\r\n", b"\n", b""):
                            break
                    break
                total += size
                if total > MAX_BODY:
                    raise ValueError("body larger than 5 MiB")
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)                   # trailing CRLF
            return b"".join(chunks)

        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return b""
        try:
            length = int(raw_length)
        except ValueError:
            raise ValueError(f"Content-Length {raw_length!r} is not an integer")
        if length < 0:
            raise ValueError("Content-Length must not be negative")
        if length > MAX_BODY:
            raise ValueError("body larger than 5 MiB")
        return self.rfile.read(length)

    # -- routes -----------------------------------------------------------

    def do_OPTIONS(self):
        self._send_no_content()

    def do_HEAD(self):
        self.do_GET()

    def _guard(self, fn):
        """Any unhandled error still answers, rather than dropping the socket."""
        try:
            fn()
        except Exception as err:                       # noqa: BLE001
            try:
                self._send(500, {"error": "internal error",
                                 "detail": f"{type(err).__name__}: {err}"})
            except Exception:
                pass

    def do_GET(self):
        self._guard(self._get)

    def _get(self):
        path = urlsplit(self.path).path.rstrip("/") or "/"
        if path == "/health":
            return self._send(200, {"status": "ok", "orders": len(ORDERS)})
        if path == "/purchase-orders":
            return self._send(200, list(ORDERS.values()))
        if path.startswith("/purchase-orders/"):
            po = ORDERS.get(path.rsplit("/", 1)[-1])
            return self._send(200, po) if po else self._send(
                404, {"error": "no such purchase order"})
        self._send(404, {"error": "not found",
                         "hint": "try /health or /purchase-orders"})

    def do_POST(self):
        self._guard(self._post)

    def _post(self):
        split = urlsplit(self.path)
        if split.path.rstrip("/") != "/purchase-orders":
            return self._send(404, {"error": "not found",
                                    "hint": "POST /purchase-orders"})

        try:
            raw = self.read_body()
        except ValueError as err:
            self.close_connection = True
            return self._send(400, {"error": str(err)})
        if not raw.strip():
            return self._send(400, {"error": "request body is empty"})
        try:
            body = json.loads(raw.decode("utf-8"))
        except UnicodeDecodeError:
            return self._send(400, {"error": "body is not valid UTF-8"})
        except json.JSONDecodeError as err:
            return self._send(400, {"error": f"invalid JSON: {err}"})

        key = (self.headers.get("Idempotency-Key") or "").strip()
        query = parse_qs(split.query)
        strict = query.get("strict", [""])[0].lower() in ("1", "true", "yes")

        with LOCK:
            if key and key in BY_IDEMPOTENCY:
                return self._send(200, ORDERS[BY_IDEMPOTENCY[key]])

            errors, warnings = validate(body, strict=strict)
            if errors:
                return self._send(422, {
                    "error": "purchase order rejected",
                    "problems": errors,
                    **({"warnings": warnings} if warnings else {}),
                })

            global _next_number
            number = f"PO-2026-{_next_number:04d}"
            _next_number += 1
            order = {
                "po_number": number,
                "status": "created",
                "supplier_id": body["supplier_id"],
                "currency": body["currency"],
                "total": body["total"],
                "tax_amount": body.get("tax_amount"),
                "requested_delivery_date": body.get("requested_delivery_date"),
                "cost_centre": body.get("cost_centre"),
                "gl_account": body.get("gl_account"),
                "line_items": body["line_items"],
                "requisition_reference": body.get("requisition_reference") or key or None,
                "idempotency_key": key or None,
            }
            if warnings:
                order["warnings"] = warnings
            ORDERS[number] = order
            if key:
                BY_IDEMPOTENCY[key] = number
            persist()

        self._send(201, order)

    def _method_not_allowed(self):
        self._send(405, {"error": f"{self.command} is not supported",
                         "hint": "GET /purchase-orders or POST /purchase-orders"},
                   extra_headers=[("Allow", "GET, HEAD, POST, OPTIONS")])

    do_PUT = do_DELETE = do_PATCH = _method_not_allowed


class Server(ThreadingHTTPServer):
    # The stdlib default of 5 drops concurrent connections at the TCP level.
    request_queue_size = 128
    daemon_threads = True
    allow_reuse_address = True


def load_store(path):
    global _next_number
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as fh:
            saved = json.load(fh)
        if not isinstance(saved, list):
            raise ValueError("expected a JSON array of orders")
        for order in saved:
            if not isinstance(order, dict) or "po_number" not in order:
                raise ValueError("every entry needs a po_number")
            ORDERS[order["po_number"]] = order
            if order.get("idempotency_key"):
                BY_IDEMPOTENCY[order["idempotency_key"]] = order["po_number"]
    except (OSError, ValueError) as err:
        sys.exit(f"cannot read {path}: {err}\n"
                 f"Delete it or point at a different file to start fresh.")
    # Continue past the highest number seen, so a restart cannot reuse one.
    highest = 0
    for number in ORDERS:
        try:
            highest = max(highest, int(number.rsplit("-", 1)[-1]))
        except ValueError:
            continue
    _next_number = highest + 1


def main():
    global STORE_PATH
    parser = argparse.ArgumentParser(
        description="Mock ERP endpoint for creating purchase orders.")
    parser.add_argument("port", nargs="?", default=8080, type=int,
                        help="port to listen on (default 8080)")
    parser.add_argument("store", nargs="?",
                        help="optional JSON file to persist orders to")
    args = parser.parse_args()

    have_master = load_master_data()

    if args.store:
        STORE_PATH = args.store
        load_store(STORE_PATH)

    try:
        server = Server(("127.0.0.1", args.port), Handler)
    except OSError as err:
        sys.exit(f"cannot listen on port {args.port}: {err}\n"
                 f"Something is probably already using it — try another port.")

    say(f"Mock PO API on http://127.0.0.1:{args.port}")
    say("  POST /purchase-orders   GET /purchase-orders[/PO-...]   GET /health")
    say("  add ?strict=1 to the POST to treat warnings as hard errors")
    if have_master:
        say(f"  master_data.json found: {len(MASTER['suppliers'])} suppliers, "
            f"{len(MASTER['cost_centres'])} cost centres, "
            f"{len(MASTER['gl_accounts'])} GL accounts (unknown ids get a warning)")
    if STORE_PATH:
        say(f"  persisting to {STORE_PATH} ({len(ORDERS)} order(s) loaded)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        say("\nstopped")


if __name__ == "__main__":
    main()
