#!/usr/bin/env python3
"""One-request Chrome 150 compatible transport for Grok's public model list."""

import base64
import json
import sys

URL = "https://grok.com/rest/models"
MAX_REQUEST_BYTES = 8 * 1024
MAX_RESPONSE_BYTES = 128 * 1024
ALLOWED_HEADERS = {"content-type": "application/json"}
CHROME_HEADERS = {
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    "origin": "https://grok.com",
    "referer": "https://grok.com/",
    "sec-ch-ua": '"Google Chrome";v="150", "Chromium";v="150", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
}


def emit(value, exit_code=0):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    raise SystemExit(exit_code)


def main():
    try:
        packet_bytes = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(packet_bytes) > MAX_REQUEST_BYTES:
            emit({"error": "CHROME_HTTP_REQUEST_REJECTED"}, 2)
        packet = json.loads(packet_bytes.decode("utf-8"))
        if (not isinstance(packet, dict)
                or packet.get("url") != URL
                or packet.get("method") != "POST"
                or packet.get("credentials") != "omit"
                or packet.get("headers") != ALLOWED_HEADERS
                or packet.get("maxResponseBytes") != MAX_RESPONSE_BYTES):
            emit({"error": "CHROME_HTTP_REQUEST_REJECTED"}, 2)

        timeout_ms = packet.get("timeoutMs")
        if not isinstance(timeout_ms, int) or not 100 <= timeout_ms <= 120_000:
            emit({"error": "CHROME_HTTP_REQUEST_REJECTED"}, 2)

        body = base64.b64decode(packet.get("bodyBase64", ""), validate=True)
        if len(body) > MAX_REQUEST_BYTES or json.loads(body.decode("utf-8")) != {"locale": "en"}:
            emit({"error": "CHROME_HTTP_REQUEST_REJECTED"}, 2)

        try:
            import curl_cffi
            from curl_cffi import requests
            from curl_cffi.const import CurlHttpVersion
        except Exception:
            emit({"error": "CHROME_HTTP_DEPENDENCY_MISSING"}, 2)
        if getattr(curl_cffi, "__version__", None) != "0.16.3":
            emit({"error": "CHROME_HTTP_DEPENDENCY_VERSION_MISMATCH"}, 2)

        with requests.Session(
                impersonate="chrome150", verify=True, trust_env=False, retry=0,
                default_headers=False) as session:
            session.cookies.clear()
            if len(session.cookies.jar) != 0 or "cookie" in CHROME_HEADERS:
                emit({"error": "CHROME_HTTP_REQUEST_REJECTED"}, 2)
            response = session.post(
                URL,
                data=body,
                headers=CHROME_HEADERS,
                timeout=(timeout_ms / 1000, timeout_ms / 1000),
                allow_redirects=False,
                stream=True,
                discard_cookies=True,
                http_version=CurlHttpVersion.V2TLS,
            )
            if response.status_code < 200 or response.status_code > 599:
                emit({"error": "CHROME_HTTP_REQUEST_REJECTED"}, 2)
            declared = response.headers.get("content-length")
            if declared is not None:
                try:
                    if int(declared) > MAX_RESPONSE_BYTES:
                        emit({"error": "CHROME_HTTP_RESPONSE_TOO_LARGE"}, 2)
                except ValueError:
                    emit({"error": "CHROME_HTTP_REQUEST_REJECTED"}, 2)

            chunks = []
            size = 0
            for chunk in response.iter_content(chunk_size=16 * 1024):
                if not chunk:
                    continue
                size += len(chunk)
                if size > MAX_RESPONSE_BYTES:
                    emit({"error": "CHROME_HTTP_RESPONSE_TOO_LARGE"}, 2)
                chunks.append(chunk)
            payload = b"".join(chunks)
            http_version = {1: "http/1.0", 2: "http/1.1", 3: "h2"}.get(response.http_version, "other")
            if len(session.cookies.jar) != 0:
                session.cookies.clear()
                emit({"error": "CHROME_HTTP_REQUEST_REJECTED"}, 2)
            session.cookies.clear()
            emit({
                "status": response.status_code,
                "contentType": response.headers.get("content-type", "")[:256],
                "httpVersion": http_version,
                "bodyBase64": base64.b64encode(payload).decode("ascii"),
            })
    except SystemExit:
        raise
    except Exception:
        emit({"error": "CHROME_HTTP_FAILED"}, 2)


if __name__ == "__main__":
    main()
