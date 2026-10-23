#!/usr/bin/env python3
"""Bounded, anonymous Chrome 150 compatible public Gemini document GET."""

import json
import sys

URL = "https://gemini.google.com/"
MAX_HEADER_BYTES = 262144
MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
HTTP_VERSIONS = {1: "http/1.0", 2: "http/1.1", 3: "h2", 4: "h2", 5: "h2", 30: "h3", 31: "h3"}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "sec-ch-ua": '"Google Chrome";v="150", "Chromium";v="150", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
}


def write_frame(value, body=b""):
    sys.stdout.buffer.write(json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n")
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def main():
    try:
        from curl_cffi import __version__ as curl_cffi_version
        from curl_cffi import requests

        if curl_cffi_version != "0.16.3":
            write_frame({"error": "PUBLIC_DOCUMENT_TRANSPORT_FAILED"})
            return 0
        with requests.Session(
            impersonate="chrome150",
            verify=True,
            trust_env=False,
            retry=0,
            default_headers=False,
            discard_cookies=True,
        ) as session:
            response = session.get(
                URL,
                headers=HEADERS,
                cookies={},
                timeout=(8, 20),
                allow_redirects=False,
                verify=True,
                impersonate="chrome150",
                stream=True,
            )
            try:
                # Enforce the actual response-header byte count reported by libcurl.
                header_bytes = int(getattr(response, "header_size", 0) or 0)
                if header_bytes < 1:
                    write_frame({"error": "PUBLIC_DOCUMENT_TRANSPORT_FAILED"})
                    return 0
                if header_bytes > MAX_HEADER_BYTES:
                    write_frame({"error": "PUBLIC_DOCUMENT_HEADER_TOO_LARGE"})
                    return 0
                content_type = str(response.headers.get("content-type", ""))
                try:
                    encoded_content_type = content_type.encode("ascii")
                except UnicodeEncodeError:
                    write_frame({"error": "PUBLIC_DOCUMENT_TRANSPORT_FAILED"})
                    return 0
                if len(encoded_content_type) > 256:
                    write_frame({"error": "PUBLIC_DOCUMENT_TRANSPORT_FAILED"})
                    return 0
                http_version = HTTP_VERSIONS.get(int(getattr(response, "http_version", 0) or 0))
                chunks = []
                size = 0
                for chunk in response.iter_content(chunk_size=65536):
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > MAX_DOCUMENT_BYTES:
                        write_frame({"error": "PUBLIC_DOCUMENT_TOO_LARGE"})
                        return 0
                    chunks.append(bytes(chunk))
                write_frame({
                    "status": int(response.status_code), "contentType": content_type,
                    "headerBytes": header_bytes, "httpVersion": http_version,
                }, b"".join(chunks))
            finally:
                response.close()
    except BaseException:
        # Diagnostics can contain URLs, proxy details, or response fragments. Keep only a safe code.
        write_frame({"error": "PUBLIC_DOCUMENT_TRANSPORT_FAILED"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
