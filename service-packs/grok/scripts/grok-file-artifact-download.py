#!/usr/bin/env python3
"""Credential-free, source-scoped fetch of a server-issued file artifact URL."""

import json
import re
import sys
from urllib.parse import urlsplit


MAX_PACKET_BYTES = 16 * 1024
MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024
COOKIE_OR_AUTH = re.compile(r"^(?:cookie|authorization|proxy-authorization)$", re.I)


def fail(code, stage, error_class=None, after_headers=False):
    if after_headers:
        sys.stderr.write(f"{code}:{stage}\n")
        raise SystemExit(2)
    payload = {"error": code, "stage": stage}
    if error_class and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", error_class):
        payload["errorClass"] = error_class
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    raise SystemExit(2)


def emit_headers(response):
    try:
        names = sorted({str(name).lower() for name in response.request.headers.keys()})
        if any(COOKIE_OR_AUTH.fullmatch(name) for name in names):
            fail("FILE_ARTIFACT_REQUEST_CREDENTIALS_PRESENT", "request_headers")
        version = {1: "http/1.0", 2: "http/1.1", 3: "h2", 30: "h3"}.get(response.http_version, "other")
        content_type = response.headers.get("content-type", "")[:256]
        redirect_location = response.headers.get("location")
        if redirect_location is not None and (len(redirect_location) > 8192 or "\r" in redirect_location or "\n" in redirect_location):
            fail("FILE_ARTIFACT_REDIRECT_HEADER_INVALID", "response_headers")
        content_length = response.headers.get("content-length")
        if content_length is not None:
            try:
                content_length = int(content_length)
            except ValueError:
                content_length = None
        payload = {
            "status": int(response.status_code),
            "contentType": content_type,
            "redirectLocation": redirect_location,
            "contentLength": content_length,
            "httpVersion": version,
            "requestHeaderNames": names,
            "tlsVerified": True,
            "trustEnv": False,
            "redirectsFollowed": False,
            "explicitRetries": 0,
        }
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except SystemExit:
        raise
    except Exception as exc:
        fail("FILE_ARTIFACT_HEADER_READ_FAILED", "response_headers", type(exc).__name__)


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_PACKET_BYTES + 1)
        if len(raw) > MAX_PACKET_BYTES:
            fail("FILE_ARTIFACT_PACKET_INVALID", "packet_size")
        packet = json.loads(raw.decode("utf-8"))
        if not isinstance(packet, dict) or set(packet) != {"url", "allowedOrigins", "timeoutMs", "maxBytes"}:
            fail("FILE_ARTIFACT_PACKET_INVALID", "packet_shape")
        url_value = packet.get("url")
        allowed = packet.get("allowedOrigins")
        timeout_ms = packet.get("timeoutMs")
        max_bytes = packet.get("maxBytes")
        if (not isinstance(url_value, str) or len(url_value) > 8192 or "\0" in url_value
                or not isinstance(allowed, list) or not allowed or any(not isinstance(item, str) for item in allowed)
                or not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or not 100 <= timeout_ms <= 600_000
                or not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or not 1 <= max_bytes <= MAX_ARTIFACT_BYTES):
            fail("FILE_ARTIFACT_PACKET_INVALID", "packet_fields")
        parsed = urlsplit(url_value)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.fragment or origin not in allowed):
            fail("FILE_ARTIFACT_URL_SCOPE", "url_scope")

        try:
            import curl_cffi
            from curl_cffi import requests
        except Exception as exc:
            fail("FILE_ARTIFACT_DEPENDENCY_MISSING", "session_setup", type(exc).__name__)
        if getattr(curl_cffi, "__version__", None) != "0.16.3":
            fail("FILE_ARTIFACT_DEPENDENCY_VERSION_MISMATCH", "session_setup")

        try:
            session = requests.Session(impersonate="chrome150", verify=True, trust_env=False, retry=0)
            response = session.get(url_value, headers={"accept": "*/*"}, timeout=timeout_ms / 1000,
                                   allow_redirects=False, stream=True)
        except Exception as exc:
            fail("FILE_ARTIFACT_TRANSPORT_FAILED", "request", type(exc).__name__)
        emit_headers(response)
        total = 0
        try:
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > max_bytes:
                    fail("FILE_ARTIFACT_SIZE_LIMIT", "response_body", after_headers=True)
                sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        except SystemExit:
            raise
        except Exception as exc:
            fail("FILE_ARTIFACT_BODY_FAILED", "response_body", type(exc).__name__, after_headers=True)
        finally:
            response.close()
            session.close()

    except SystemExit:
        raise
    except Exception as exc:
        fail("FILE_ARTIFACT_HELPER_FAILED", "validation", type(exc).__name__)


if __name__ == "__main__":
    main()
