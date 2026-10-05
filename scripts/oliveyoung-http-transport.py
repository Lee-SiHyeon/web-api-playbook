#!/usr/bin/env python3
"""One-request, cookie-free curl_cffi bridge for allowlisted Olive Young public reads."""

from __future__ import annotations

import base64
import json
import re
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

EXPECTED_CURL_CFFI_VERSION = "0.16.3"
MAX_INPUT_BYTES = 384 * 1024
MAX_REQUEST_BODY_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
SENSITIVE_FIELD_RE = re.compile(
    r"cookie|authorization|password|passwd|secret|credential|csrf|xsrf|token|session|jwt|email|phone|mobile|account",
    re.IGNORECASE,
)
CONTRACT_PATH = Path(__file__).resolve().parents[1] / "references" / "commerce-oliveyoung-http-transport-contracts.json"


class RequestRejected(Exception):
    pass


def _contract() -> dict:
    try:
        value = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
        if value.get("schema") != "commerce-oliveyoung-http-transport-contracts-v1":
            raise ValueError
        return value
    except Exception as exc:
        raise RequestRejected("PROTOCOL_INVALID") from exc


def _fail(code: str) -> None:
    raise RequestRejected(code)


def _route(contract: dict, origin: str, path: str, method: str) -> dict:
    for route in contract["routes"]:
        if route.get("origin") != origin or method not in route.get("methods", []):
            continue
        if route.get("path") == path or route.get("pathPattern") and re.fullmatch(route["pathPattern"], path):
            return route
    _fail("REQUEST_REJECTED")


def _validate_json(value, route: dict, depth: int = 0, budget: list[int] | None = None) -> None:
    if budget is None:
        budget = [0]
    budget[0] += 1
    if budget[0] > 4096 or depth > 8:
        _fail("REQUEST_REJECTED")
    if isinstance(value, str):
        if len(value) > 8192 or CONTROL_RE.search(value):
            _fail("REQUEST_REJECTED")
    elif isinstance(value, list):
        for entry in value:
            _validate_json(entry, route, depth + 1, budget)
    elif isinstance(value, dict):
        for name, entry in value.items():
            if not isinstance(name, str) or SENSITIVE_FIELD_RE.search(name):
                _fail("REQUEST_REJECTED")
            if depth == 0 and name not in route.get("bodyFields", []):
                _fail("REQUEST_REJECTED")
            _validate_json(entry, route, depth + 1, budget)


def _validate_request(value: dict, contract: dict) -> tuple[dict, bytes, dict[str, str]]:
    expected = {"protocolVersion", "url", "method", "headers", "bodyBase64", "timeoutMs", "maxResponseBytes"}
    if not isinstance(value, dict) or set(value) != expected or value.get("protocolVersion") != 1:
        _fail("PROTOCOL_INVALID")
    url_text = value.get("url")
    method = value.get("method")
    if not isinstance(url_text, str) or len(url_text) > 8192 or CONTROL_RE.search(url_text):
        _fail("REQUEST_REJECTED")
    parsed = urlsplit(url_text)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.fragment:
        _fail("REQUEST_REJECTED")
    try:
        port = parsed.port
    except ValueError:
        _fail("REQUEST_REJECTED")
    if port not in (None, 443):
        _fail("REQUEST_REJECTED")
    origin = f"https://{parsed.hostname or ''}"
    if origin not in contract["origins"]:
        _fail("REQUEST_REJECTED")
    if method not in ("GET", "POST"):
        _fail("REQUEST_REJECTED")
    route = _route(contract, origin, parsed.path, method)

    query_pairs = parse_qsl(parsed.query, keep_blank_values=True, max_num_fields=24)
    if len(parsed.query) > 4096:
        _fail("REQUEST_REJECTED")
    query_names = set()
    for key, entry in query_pairs:
        if key in query_names or key not in route.get("queryFields", []) or len(entry) > 2048 or CONTROL_RE.search(entry):
            _fail("REQUEST_REJECTED")
        query_names.add(key)
        if key == "referer":
            ref = urlsplit(entry)
            ref_origin = f"{ref.scheme}://{ref.hostname or ''}"
            if ref_origin not in contract["origins"] or ref.port not in (None, 443) or ref.path not in contract["refererPaths"] or ref.username or ref.password or ref.fragment:
                _fail("REQUEST_REJECTED")
            for ref_key, ref_value in parse_qsl(ref.query, keep_blank_values=True, max_num_fields=4):
                if ref_key != "goodsNo" or len(ref_value) > 64 or CONTROL_RE.search(ref_value):
                    _fail("REQUEST_REJECTED")

    raw_headers = value.get("headers")
    if not isinstance(raw_headers, dict) or len(raw_headers) > 12:
        _fail("REQUEST_REJECTED")
    allowed_headers = set(contract["requestHeaders"])
    headers: dict[str, str] = {}
    for name, entry in raw_headers.items():
        if not isinstance(name, str) or not isinstance(entry, str):
            _fail("REQUEST_REJECTED")
        normalized = name.lower()
        if normalized not in allowed_headers or normalized == "cookie" or len(entry) > 8192 or CONTROL_RE.search(entry):
            _fail("REQUEST_REJECTED")
        if normalized == "origin" and entry not in contract["origins"]:
            _fail("REQUEST_REJECTED")
        if normalized == "referer":
            ref = urlsplit(entry)
            ref_origin = f"{ref.scheme}://{ref.hostname or ''}"
            if ref_origin not in contract["origins"] or ref.port not in (None, 443) or ref.path not in contract["refererPaths"] or ref.username or ref.password or ref.fragment:
                _fail("REQUEST_REJECTED")
            for ref_key, ref_value in parse_qsl(ref.query, keep_blank_values=True, max_num_fields=4):
                if ref_key != "goodsNo" or len(ref_value) > 64 or CONTROL_RE.search(ref_value):
                    _fail("REQUEST_REJECTED")
        if normalized == "x-requested-with" and entry != "XMLHttpRequest":
            _fail("REQUEST_REJECTED")
        if normalized == "content-type":
            content_type = entry.split(";", 1)[0].strip().lower()
            if content_type not in route.get("allowedContentTypes", []):
                _fail("REQUEST_REJECTED")
        if normalized == "accept" and (len(entry) > 256 or not re.fullmatch(r"[A-Za-z0-9!#$&^_.+*/;= ,_-]{1,256}", entry)):
            _fail("REQUEST_REJECTED")
        if normalized == "accept-language" and (len(entry) > 128 or not re.fullmatch(r"[A-Za-z0-9,*;= ._-]{1,128}", entry)):
            _fail("REQUEST_REJECTED")
        headers[normalized] = entry

    try:
        timeout_ms = value["timeoutMs"]
        max_response = value["maxResponseBytes"]
        if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or not 250 <= timeout_ms <= 120_000:
            _fail("REQUEST_REJECTED")
        if isinstance(max_response, bool) or not isinstance(max_response, int) or not 1024 <= max_response <= MAX_RESPONSE_BYTES:
            _fail("REQUEST_REJECTED")
        body_encoded = value.get("bodyBase64")
        if not isinstance(body_encoded, str) or len(body_encoded) > ((MAX_REQUEST_BODY_BYTES + 2) // 3) * 4:
            _fail("REQUEST_REJECTED")
        body = base64.b64decode(body_encoded, validate=True)
    except (ValueError, TypeError):
        _fail("REQUEST_REJECTED")
    if len(body) > MAX_REQUEST_BODY_BYTES:
        _fail("REQUEST_REJECTED")

    if method == "GET":
        if body or "content-type" in headers:
            _fail("REQUEST_REJECTED")
    else:
        content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if not body or route.get("bodyFormat") is None or content_type not in route.get("allowedContentTypes", []):
            _fail("REQUEST_REJECTED")
        if content_type == "application/json":
            try:
                parsed_body = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                _fail("REQUEST_REJECTED")
            if not isinstance(parsed_body, dict):
                _fail("REQUEST_REJECTED")
            _validate_json(parsed_body, route)
        else:
            try:
                body_pairs = parse_qsl(body.decode("utf-8"), keep_blank_values=True, max_num_fields=64)
            except (UnicodeDecodeError, ValueError):
                _fail("REQUEST_REJECTED")
            body_names = set()
            for key, entry in body_pairs:
                if key in body_names or key not in route.get("bodyFields", []) or SENSITIVE_FIELD_RE.search(key) or len(entry) > 8192 or CONTROL_RE.search(entry):
                    _fail("REQUEST_REJECTED")
                body_names.add(key)
    return route, body, headers


def _write(value: dict) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")))
    sys.stdout.flush()


def main() -> int:
    try:
        incoming = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(incoming) > MAX_INPUT_BYTES:
            _fail("PROTOCOL_INVALID")
        value = json.loads(incoming.decode("utf-8"))
        contract = _contract()
        route, body, headers = _validate_request(value, contract)
    except RequestRejected as exc:
        _write({"ok": False, "error": str(exc)})
        return 0
    except Exception:
        _write({"ok": False, "error": "PROTOCOL_INVALID"})
        return 0

    try:
        installed_version = version("curl_cffi")
    except PackageNotFoundError:
        _write({"ok": False, "error": "DEPENDENCY_UNAVAILABLE"})
        return 0
    if installed_version != EXPECTED_CURL_CFFI_VERSION:
        _write({"ok": False, "error": "DEPENDENCY_VERSION_MISMATCH"})
        return 0

    try:
        from curl_cffi import Session

        with Session(
            impersonate="chrome",
            discard_cookies=True,
            verify=True,
            trust_env=False,
        ) as session:
            response = session.request(
                value["method"],
                value["url"],
                headers=headers,
                data=body if body else None,
                timeout=value["timeoutMs"] / 1000,
                allow_redirects=False,
                stream=True,
            )
            response_body = bytearray()
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                if len(response_body) + len(chunk) > value["maxResponseBytes"]:
                    response.close()
                    _write({"ok": False, "error": "RESPONSE_TOO_LARGE"})
                    return 0
                response_body.extend(chunk)
            request_headers = getattr(getattr(response, "request", None), "headers", {})
            cookie_absent = not any(str(name).lower() == "cookie" for name in request_headers)
            if not cookie_absent:
                response.close()
                _write({"ok": False, "error": "COOKIE_HEADER_PRESENT"})
                return 0
            mime = response.headers.get("content-type", "")
            if not isinstance(mime, str) or len(mime) > 256 or CONTROL_RE.search(mime):
                mime = ""
            status = int(response.status_code)
            response.close()
        _write({
            "ok": True,
            "status": status,
            "headers": {"content-type": mime} if mime else {},
            "bodyBase64": base64.b64encode(bytes(response_body)).decode("ascii"),
            "outgoingCookieAbsent": True,
            "transport": {"library": "curl_cffi", "version": EXPECTED_CURL_CFFI_VERSION, "profile": "chrome"},
        })
        return 0
    except Exception as exc:
        # Only fixed error classes cross the pipe; URLs, headers, cookies and exception text stay private.
        try:
            from curl_cffi.requests.exceptions import SSLError
            error = "TLS_FAILED" if isinstance(exc, SSLError) else "NETWORK_FAILED"
        except Exception:
            error = "NETWORK_FAILED"
        _write({"ok": False, "error": error})
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
