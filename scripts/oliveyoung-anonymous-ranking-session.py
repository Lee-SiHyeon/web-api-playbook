#!/usr/bin/env python3
"""Persistent, narrowly scoped anonymous-session transport for Olive Young ranking reads."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sys
import time
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from urllib.parse import parse_qsl, urlsplit

EXPECTED_CURL_CFFI_VERSION = "0.16.3"
ORIGIN = "https://www.oliveyoung.co.kr"
HOME_PATH = "/store/main/main.do"
RANKING_PATH = "/store/main/getBestList.do"
RANKING_QUERY_FIELDS = {"dispCatNo", "fltDispCatNo", "pageIdx", "rowsPerPage"}
ALLOWED_CF_COOKIES = {"__cf_bm", "_cfuvid", "cf_clearance"}
ALLOWED_COOKIE_DOMAINS = {"www.oliveyoung.co.kr", "oliveyoung.co.kr"}
FIXED_HEADERS = {"accept": "text/html,application/xhtml+xml"}
MAX_INPUT_BYTES = 16 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
UA_PROFILE = "chrome150"


class ProtocolError(Exception):
    def __init__(self, code: str, receipt: dict | None = None):
        super().__init__(code)
        self.code = code
        self.receipt = receipt


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _safe_retry_after(value) -> str | None:
    if not isinstance(value, str) or len(value) > 128 or CONTROL_RE.search(value):
        return None
    value = value.strip()
    return value or None


def _validate_url(url_text: object) -> tuple[str, str]:
    if not isinstance(url_text, str) or len(url_text) > 8192 or CONTROL_RE.search(url_text):
        raise ProtocolError("REQUEST_REJECTED")
    try:
        url = urlsplit(url_text)
        port = url.port
    except ValueError as exc:
        raise ProtocolError("REQUEST_REJECTED") from exc
    if (url.scheme != "https" or url.hostname != "www.oliveyoung.co.kr" or
            url.username or url.password or url.fragment or port not in (None, 443)):
        raise ProtocolError("REQUEST_REJECTED")
    origin = f"{url.scheme}://{url.hostname}"
    if origin != ORIGIN:
        raise ProtocolError("REQUEST_REJECTED")
    if url.path == RANKING_PATH:
        try:
            pairs = parse_qsl(url.query, keep_blank_values=True, max_num_fields=8)
        except ValueError as exc:
            raise ProtocolError("REQUEST_REJECTED") from exc
        names: set[str] = set()
        if len(url.query) > 1024:
            raise ProtocolError("REQUEST_REJECTED")
        for name, value in pairs:
            if name not in RANKING_QUERY_FIELDS or name in names or len(value) > 64 or CONTROL_RE.search(value):
                raise ProtocolError("REQUEST_REJECTED")
            names.add(name)
        if names and names != RANKING_QUERY_FIELDS:
            raise ProtocolError("REQUEST_REJECTED")
        if names:
            values = dict(pairs)
            if (not re.fullmatch(r"[0-9]{1,18}", values["dispCatNo"]) or
                    values["fltDispCatNo"] and not re.fullmatch(r"[0-9]{1,18}", values["fltDispCatNo"]) or
                    not re.fullmatch(r"[0-9]{1,6}", values["pageIdx"]) or
                    not re.fullmatch(r"[0-9]{1,4}", values["rowsPerPage"])):
                raise ProtocolError("REQUEST_REJECTED")
        return url.path, url_text
    if url.path == HOME_PATH and not url.query:
        return url.path, url_text
    raise ProtocolError("REQUEST_REJECTED")


def _header_values(headers, name: str) -> list[str]:
    try:
        if hasattr(headers, "get_list"):
            values = headers.get_list(name)
            if values:
                return list(values)
    except Exception:
        pass
    value = headers.get(name) if hasattr(headers, "get") else None
    return [value] if isinstance(value, str) and value else []


def _set_cookie_names(response) -> list[str]:
    names: set[str] = set()
    for header in _header_values(response.headers, "set-cookie"):
        # Only the cookie name survives this function; the value is never returned or logged.
        pair = header.split(";", 1)[0]
        name, sep, _value = pair.partition("=")
        if sep and re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}", name.strip()):
            names.add(name.strip())
    return sorted(names)


def _cookie_domain_allowed(cookie) -> bool:
    domain = str(getattr(cookie, "domain", "")).lstrip(".").lower()
    return domain in ALLOWED_COOKIE_DOMAINS


def _jar_cookie_names(session, issued_names: set[str] | None = None) -> list[str]:
    names: set[str] = set()
    for cookie in list(session.cookies.jar):
        if (cookie.name in ALLOWED_CF_COOKIES and _cookie_domain_allowed(cookie) and
                (issued_names is None or cookie.name in issued_names)):
            names.add(cookie.name)
    return sorted(names)


def _prune_cookie_jar(session, issued_names: set[str] | None = None) -> None:
    jar = session.cookies.jar
    for cookie in list(jar):
        if (cookie.name not in ALLOWED_CF_COOKIES or not _cookie_domain_allowed(cookie) or
                issued_names is not None and cookie.name not in issued_names):
            try:
                jar.clear(cookie.domain, cookie.path, cookie.name)
            except KeyError:
                pass


class OutboundCookieObserver:
    """Keep only Cookie header names from libcurl's actual HEADER_OUT callbacks."""

    HEADER_OUT = 2  # CURLINFO_HEADER_OUT
    MAX_HEADER_BYTES = 32 * 1024

    def __init__(self):
        self._partial = bytearray()
        self.names: set[str] = set()
        self.cookie_header_seen = False
        self.failed = False

    def reset(self) -> None:
        self._partial.clear()
        self.names.clear()
        self.cookie_header_seen = False
        self.failed = False

    def __call__(self, debug_type: int, data: bytes) -> None:
        if debug_type != self.HEADER_OUT:
            return
        try:
            if not isinstance(data, (bytes, bytearray)) or len(self._partial) + len(data) > self.MAX_HEADER_BYTES:
                self.failed = True
                self._partial.clear()
                return
            self._partial.extend(data)
            while b"\n" in self._partial:
                line, _, remainder = self._partial.partition(b"\n")
                self._partial = bytearray(remainder)
                self._inspect_line(line.rstrip(b"\r"))
        except Exception:
            self.failed = True
            self._partial.clear()

    def _inspect_line(self, line: bytes) -> None:
        name, separator, value = line.partition(b":")
        if not separator or name.strip().lower() != b"cookie":
            return
        self.cookie_header_seen = True
        for pair in value.split(b";"):
            raw_name, equals, _raw_value = pair.strip().partition(b"=")
            if not equals:
                self.failed = True
                continue
            try:
                decoded_name = raw_name.decode("ascii")
            except UnicodeDecodeError:
                self.failed = True
                continue
            if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}", decoded_name):
                self.failed = True
                continue
            self.names.add(decoded_name)

    def finish(self) -> list[str]:
        if self._partial:
            self._inspect_line(bytes(self._partial).rstrip(b"\r"))
            self._partial.clear()
        return sorted(self.names)


def _safe_mime(response) -> str | None:
    mime = response.headers.get("content-type", "")
    if not isinstance(mime, str) or len(mime) > 256 or CONTROL_RE.search(mime):
        return None
    return mime


def _read_response(response, max_response_bytes: int) -> bytes:
    body = bytearray()
    for chunk in response.iter_content(chunk_size=64 * 1024):
        if not chunk:
            continue
        if len(body) + len(chunk) > max_response_bytes:
            raise ProtocolError("RESPONSE_TOO_LARGE")
        body.extend(chunk)
    return bytes(body)


class AnonymousRankingWorker:
    """One caller-owned process/session. Test injection is Python-only, never IPC data."""

    def __init__(self, session_factory=None, sleep=time.sleep, monotonic=time.monotonic, utc_now=_utc_now,
                 min_interval_ms=5000):
        self._session_factory = session_factory
        self._sleep = sleep
        self._monotonic = monotonic
        self._utc_now = utc_now
        self._min_gap_seconds = min_interval_ms / 1000
        self._session = None
        self._observer = OutboundCookieObserver()
        self._ready = False
        self._bootstrap_receipt = None
        self._issued_cookie_names: set[str] = set()
        self._last_request_at = None
        self._blocked_after_429 = False
        self._last_response_phase = None
        self._last_response_request = None
        self._last_retry_after = None
        self._closed = False

    def _create_session(self):
        if self._session_factory is not None:
            self._session = self._session_factory()
            # Tests may observe the same callback without configuring an HTTP library.
            try:
                self._session._anonymous_cookie_observer = self._observer
            except Exception:
                pass
            return
        try:
            installed_version = version("curl_cffi")
        except PackageNotFoundError as exc:
            raise ProtocolError("DEPENDENCY_UNAVAILABLE") from exc
        if installed_version != EXPECTED_CURL_CFFI_VERSION:
            raise ProtocolError("DEPENDENCY_VERSION_MISMATCH")
        try:
            from curl_cffi import CurlOpt, Session
            self._session = Session(
                impersonate=UA_PROFILE,
                discard_cookies=False,
                verify=True,
                trust_env=False,
                retry=0,
                curl_options={CurlOpt.VERBOSE: 1, CurlOpt.DEBUGFUNCTION: self._observer},
            )
        except Exception as exc:
            raise ProtocolError("DEPENDENCY_UNAVAILABLE") from exc

    def _wait_for_gap(self):
        if self._last_request_at is None:
            return
        remaining = self._min_gap_seconds - (self._monotonic() - self._last_request_at)
        if remaining > 0:
            self._sleep(remaining)

    def _request_receipt(self, path: str, *, status=None, mime=None, response_bytes=None,
                         response_sha256=None, cookie_names=None, source_cookie_names=None,
                         checked_at=None) -> dict:
        source_names = sorted(set(source_cookie_names or []))
        sent_names = sorted(set(cookie_names or []))
        receipt = {
            "method": "GET",
            "origin": ORIGIN,
            "path": path,
            "httpStatus": status,
            "mime": mime,
            "responseBytes": response_bytes,
            "responseSha256": response_sha256,
            "checkedAt": checked_at or self._utc_now(),
            "browserUsed": False,
            "anonymous": True,
            "cookieSent": bool(sent_names) if path == RANKING_PATH else False,
            "cookieNames": sent_names if path == RANKING_PATH else _jar_cookie_names(self._session),
            "credentialsUsed": False,
            "inputCookiesAccepted": False,
            "sourceSetCookiePresent": bool(source_names),
            "sourceSetCookieCount": len(source_names),
            "sourceSetCookieNames": source_names,
        }
        if path == HOME_PATH:
            receipt["issuedCookieNames"] = sorted(set(source_names) & ALLOWED_CF_COOKIES)
        else:
            receipt.update({
                "sessionKind": "server_issued_anonymous",
                "cookieSent": bool(sent_names),
                "cookieNames": sent_names,
                "sentCookieNames": sent_names,
            })
        return receipt

    @staticmethod
    def _failure_envelope(phase: str, bootstrap: dict | None, request: dict | None,
                          retry_after: str | None = None) -> dict:
        return {
            "bootstrapRequest": bootstrap,
            "request": request,
            "phase": phase,
            "retryAfter": retry_after,
            "anonymous": True,
            "browserUsed": False,
            "credentialsUsed": False,
            "inputCookiesAccepted": False,
        }

    def _request(self, path: str, url: str, timeout_ms: int, max_response_bytes: int) -> tuple[dict, bytes, str | None]:
        self._wait_for_gap()
        if self._closed or self._session is None:
            raise ProtocolError("WORKER_CLOSED")
        if path == HOME_PATH and self._bootstrap_receipt is None:
            try:
                self._session.cookies.clear()
            except Exception:
                pass
        _prune_cookie_jar(self._session, self._issued_cookie_names if path == RANKING_PATH else None)
        self._last_request_at = self._monotonic()
        response = None
        observer = self._observer
        observer.reset()
        status = None
        mime = None
        retry_after = None
        source_cookie_names = []
        receipt = self._request_receipt(path)
        try:
            response = self._session.get(
                url,
                headers=FIXED_HEADERS,
                timeout=timeout_ms / 1000,
                allow_redirects=False,
                verify=True,
                stream=True,
            )
            status = int(response.status_code)
            mime = _safe_mime(response)
            retry_after = _safe_retry_after(response.headers.get("retry-after"))
            source_cookie_names = _set_cookie_names(response)
            sent_names = observer.finish()
            receipt = self._request_receipt(
                path, status=status, mime=mime, cookie_names=sent_names,
                source_cookie_names=source_cookie_names)
            body = _read_response(response, max_response_bytes)
            request_cookie_names = sent_names
            receipt["responseBytes"] = len(body)
            receipt["responseSha256"] = hashlib.sha256(body).hexdigest()
            receipt["checkedAt"] = self._utc_now()
            if observer.failed:
                raise ProtocolError("COOKIE_POLICY_FAILED", receipt)
            _prune_cookie_jar(self._session, self._issued_cookie_names if path == RANKING_PATH else None)
            allowed_sent_names = request_cookie_names
            if set(request_cookie_names) - ALLOWED_CF_COOKIES:
                raise ProtocolError("COOKIE_POLICY_FAILED", receipt)
            if path == HOME_PATH and observer.cookie_header_seen:
                raise ProtocolError("COOKIE_POLICY_FAILED", receipt)
            if path == RANKING_PATH and (not observer.cookie_header_seen or not allowed_sent_names or
                                         not set(allowed_sent_names).issubset(self._issued_cookie_names)):
                raise ProtocolError("COOKIE_POLICY_FAILED", receipt)
            return receipt, body, retry_after
        except ProtocolError as exc:
            if exc.receipt is None:
                sent_names = observer.finish()
                exc.receipt = self._request_receipt(
                    path, status=status, mime=mime, cookie_names=sent_names,
                    source_cookie_names=source_cookie_names)
            raise
        except Exception:
            sent_names = observer.finish()
            failure_receipt = self._request_receipt(
                path, status=status, mime=mime, cookie_names=sent_names,
                source_cookie_names=source_cookie_names)
            raise ProtocolError("NETWORK_FAILED", failure_receipt) from None
        finally:
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass

    def _response(self, path: str, url: str, timeout_ms: int, max_response_bytes: int) -> dict:
        if self._closed:
            raise ProtocolError("WORKER_CLOSED")
        if self._blocked_after_429:
            raise ProtocolError("RATE_LIMITED_UNTIL_CLOSE", self._failure_envelope(
                self._last_response_phase or "bootstrap", self._bootstrap_receipt,
                self._last_response_request, self._last_retry_after))
        if self._session is None:
            self._create_session()

        if self._bootstrap_receipt is None:
            try:
                bootstrap, bootstrap_body, bootstrap_retry_after = self._request(
                    HOME_PATH, ORIGIN + HOME_PATH, timeout_ms, max_response_bytes)
            except ProtocolError as exc:
                partial = exc.receipt or self._request_receipt(HOME_PATH)
                raise ProtocolError(exc.code, self._failure_envelope(
                    "bootstrap", partial, None)) from None
            self._issued_cookie_names = set(bootstrap["sourceSetCookieNames"]) & ALLOWED_CF_COOKIES
            approved_names = sorted(self._issued_cookie_names)
            _prune_cookie_jar(self._session, self._issued_cookie_names)
            bootstrap["issuedCookieNames"] = approved_names
            bootstrap["cookieNames"] = approved_names
            self._bootstrap_receipt = bootstrap
            if bootstrap["httpStatus"] == 429:
                self._blocked_after_429 = True
                self._last_response_phase = "bootstrap"
                self._last_response_request = None
                self._last_retry_after = bootstrap_retry_after
                return self._encode_response(bootstrap_body, bootstrap["httpStatus"], bootstrap["mime"],
                                             bootstrap_retry_after, bootstrap, None, phase="bootstrap")
            if bootstrap["httpStatus"] < 200 or bootstrap["httpStatus"] >= 300:
                self._last_response_phase = "bootstrap"
                self._last_response_request = None
                self._last_retry_after = bootstrap_retry_after
                return self._encode_response(bootstrap_body, bootstrap["httpStatus"], bootstrap["mime"],
                                             bootstrap_retry_after, bootstrap, None, phase="bootstrap")
            if not approved_names or not _jar_cookie_names(self._session, self._issued_cookie_names):
                raise ProtocolError("ANONYMOUS_COOKIE_UNAVAILABLE", self._failure_envelope(
                    "bootstrap", bootstrap, None))

        try:
            receipt, body, retry_after = self._request(path, url, timeout_ms, max_response_bytes)
        except ProtocolError as exc:
            partial = exc.receipt or self._request_receipt(path)
            raise ProtocolError(exc.code, self._failure_envelope(
                "ranking", self._bootstrap_receipt, partial)) from None
        if receipt["httpStatus"] == 429:
            self._blocked_after_429 = True
        self._last_response_phase = "ranking"
        self._last_response_request = receipt
        self._last_retry_after = retry_after
        return self._encode_response(body, receipt["httpStatus"], receipt["mime"], retry_after,
                                     self._bootstrap_receipt, receipt, phase="ranking")

    @staticmethod
    def _encode_response(body: bytes, status: int, mime: str | None, retry_after: str | None,
                         bootstrap: dict, request: dict | None, phase: str) -> dict:
        receipt = {
            "bootstrapRequest": bootstrap,
            "request": request,
            "phase": phase,
            "retryAfter": retry_after,
            "anonymous": True,
            "browserUsed": False,
            "credentialsUsed": False,
            "inputCookiesAccepted": False,
        }
        headers = {}
        if mime:
            headers["content-type"] = mime
        if retry_after:
            headers["retry-after"] = retry_after
        return {
            "ok": True,
            "status": status,
            "headers": headers,
            "bodyBase64": base64.b64encode(body).decode("ascii"),
            "anonymousSessionReceipt": receipt,
            "transport": {"library": "curl_cffi", "version": EXPECTED_CURL_CFFI_VERSION, "profile": UA_PROFILE},
        }

    def handle(self, message: object) -> dict:
        if not isinstance(message, dict) or not isinstance(message.get("op"), str):
            raise ProtocolError("PROTOCOL_INVALID")
        op = message["op"]
        if op == "hello":
            if set(message) != {"op", "protocolVersion"} or message.get("protocolVersion") != 1:
                raise ProtocolError("PROTOCOL_INVALID")
            if self._session is None:
                self._create_session()
            return {"ok": True, "op": "hello", "transport": {
                "library": "curl_cffi", "version": EXPECTED_CURL_CFFI_VERSION, "profile": UA_PROFILE}}
        if op == "request":
            if set(message) != {"op", "protocolVersion", "url", "timeoutMs", "maxResponseBytes", "minIntervalMs"} or message.get("protocolVersion") != 1:
                raise ProtocolError("PROTOCOL_INVALID")
            timeout_ms = message.get("timeoutMs")
            max_response_bytes = message.get("maxResponseBytes")
            min_interval_ms = message.get("minIntervalMs")
            if (isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or not 250 <= timeout_ms <= 120_000 or
                    isinstance(max_response_bytes, bool) or not isinstance(max_response_bytes, int) or
                    not 1024 <= max_response_bytes <= MAX_RESPONSE_BYTES or
                    isinstance(min_interval_ms, bool) or not isinstance(min_interval_ms, int) or
                    not 5000 <= min_interval_ms <= 120_000):
                raise ProtocolError("REQUEST_REJECTED")
            path, url_text = _validate_url(message.get("url"))
            if path != RANKING_PATH:
                raise ProtocolError("REQUEST_REJECTED")
            self._min_gap_seconds = min_interval_ms / 1000
            return self._response(path, url_text, timeout_ms, max_response_bytes)
        if op == "close":
            if set(message) != {"op", "protocolVersion"} or message.get("protocolVersion") != 1:
                raise ProtocolError("PROTOCOL_INVALID")
            self.close()
            return {"ok": True, "op": "close"}
        raise ProtocolError("PROTOCOL_INVALID")

    def close(self):
        if self._closed:
            return
        self._closed = True
        session, self._session = self._session, None
        if session is not None:
            try:
                session.cookies.clear()
            except Exception:
                pass
            try:
                session.close()
            except Exception:
                pass


def _write(value: dict) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    worker = AnonymousRankingWorker()
    try:
        while True:
            raw = sys.stdin.buffer.readline(MAX_INPUT_BYTES + 1)
            if not raw:
                break
            if len(raw) > MAX_INPUT_BYTES:
                while raw and not raw.endswith(b"\n"):
                    raw = sys.stdin.buffer.readline(MAX_INPUT_BYTES + 1)
                _write({"ok": False, "error": "PROTOCOL_INVALID"})
                continue
            try:
                message = json.loads(raw.decode("utf-8"))
                reply = worker.handle(message)
                _write(reply)
                if isinstance(message, dict) and message.get("op") == "close":
                    return 0
            except ProtocolError as exc:
                error = {"ok": False, "error": exc.code}
                if exc.receipt is not None:
                    error["anonymousSessionReceipt"] = exc.receipt
                _write(error)
            except Exception:
                # Exception text can contain URLs, cookie values, or transport details.
                _write({"ok": False, "error": "NETWORK_FAILED"})
    finally:
        worker.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
