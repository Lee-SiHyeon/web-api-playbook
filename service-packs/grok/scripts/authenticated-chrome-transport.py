#!/usr/bin/env python3
"""One request through curl-cffi's Chrome 150 TLS/HTTP2 profile."""

import base64
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path
from urllib.parse import urlsplit, parse_qsl

MAX_PACKET_BYTES = 1024 * 1024
MAX_ERROR_BYTES = 16 * 1024
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_DIRECT_MULTIPART_BODY_BYTES = 16 * 1024 * 1024 + 443
COOKIE_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$")
CHALLENGE_COOKIE = re.compile(r"(?:^|[_-])(?:cf[_-]?clearance|cf[_-]?chl|__?cf[_-]?bm|captcha|challenge|turnstile)(?:$|[_-])", re.I)
ALLOWED_BASIC_HEADERS = {"accept", "accept-language", "content-type", "origin", "referer"}


def emit(value, exit_code=0):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    raise SystemExit(exit_code)


def reject(stage):
    emit({"error": "AUTH_CHROME_REQUEST_REJECTED", "stage": stage}, 2)


def open_direct_upload_body(packet, parsed, method):
    """Return (inline bytes, file handle, byte count, sha256, mode) for the request body."""
    has_path = "bodyFilePath" in packet
    has_count = "bodyBytes" in packet
    if not has_path and not has_count:
        body = base64.b64decode(packet.get("bodyBase64", ""), validate=True)
        if len(body) > MAX_PACKET_BYTES or (method == "GET" and body):
            reject("body_shape")
        return body, None, len(body), hashlib.sha256(body).hexdigest(), "inline_base64"

    if (not has_path or not has_count or packet.get("operationId") != "attachment.upload.direct"
            or method != "POST" or parsed.hostname != "grok.com"
            or parsed.path != "/http/upload-file-v2/direct" or parsed.query
            or packet.get("bodyBase64") != ""
            or not isinstance(packet.get("bodySha256"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", packet["bodySha256"])
            or not isinstance(packet.get("bodyBytes"), int) or isinstance(packet.get("bodyBytes"), bool)
            or not 1 <= packet["bodyBytes"] <= MAX_DIRECT_MULTIPART_BODY_BYTES):
        reject("streamed_body_scope")

    body_path_value = packet.get("bodyFilePath")
    if not isinstance(body_path_value, str) or not body_path_value or len(body_path_value) > 4096 \
            or "\0" in body_path_value or "\n" in body_path_value or "\r" in body_path_value:
        reject("streamed_body_path")
    scratch_value = os.environ.get("TMPDIR") or str(Path.home() / ".nad-scratch" / "tmp")
    try:
        scratch_raw = Path(scratch_value)
        scratch_info = os.lstat(scratch_raw)
        scratch_root = scratch_raw.resolve(strict=True)
        home_root = Path.home().resolve(strict=True)
        scratch_root.relative_to(home_root)
        body_path = Path(body_path_value)
        if (scratch_root == home_root or stat.S_ISLNK(scratch_info.st_mode)
                or not stat.S_ISDIR(scratch_info.st_mode) or scratch_info.st_uid != os.getuid()
                or stat.S_IMODE(scratch_info.st_mode) != 0o700
                or not body_path.is_absolute()
                or not re.fullmatch(r"grok-http-body-[A-Za-z0-9]{6}", body_path.parent.name) \
                or body_path.name != "request-body.bin" or body_path.parent.parent != scratch_root \
                or body_path.resolve(strict=True) != body_path):
            reject("streamed_body_path")
        parent_info = os.lstat(body_path.parent)
        file_info = os.lstat(body_path)
        if (stat.S_ISLNK(parent_info.st_mode) or not stat.S_ISDIR(parent_info.st_mode)
                or parent_info.st_uid != os.getuid() or stat.S_IMODE(parent_info.st_mode) != 0o700
                or stat.S_ISLNK(file_info.st_mode) or not stat.S_ISREG(file_info.st_mode)
                or file_info.st_uid != os.getuid() or stat.S_IMODE(file_info.st_mode) != 0o600
                or file_info.st_nlink != 1 or file_info.st_size != packet["bodyBytes"]):
            reject("streamed_body_metadata")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(body_path, flags)
        opened = os.fstat(descriptor)
        if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.getuid()
                or stat.S_IMODE(opened.st_mode) != 0o600 or opened.st_nlink != 1
                or opened.st_size != packet["bodyBytes"]
                or (opened.st_dev, opened.st_ino) != (file_info.st_dev, file_info.st_ino)):
            os.close(descriptor)
            reject("streamed_body_identity")
        body_file = os.fdopen(descriptor, "rb")
        digest = hashlib.sha256()
        total = 0
        for chunk in iter(lambda: body_file.read(64 * 1024), b""):
            total += len(chunk)
            if total > MAX_DIRECT_MULTIPART_BODY_BYTES:
                body_file.close()
                reject("streamed_body_size")
            digest.update(chunk)
        actual_sha256 = digest.hexdigest()
        if total != opened.st_size or actual_sha256 != packet["bodySha256"]:
            body_file.close()
            reject("streamed_body_digest")
        body_file.seek(0)
        return b"", body_file, total, actual_sha256, "private_file_stream"
    except SystemExit:
        raise
    except Exception:
        reject("streamed_body_validation")


def main():
    stage = "packet_read"
    body_file = None
    try:
        packet_bytes = sys.stdin.buffer.read(MAX_PACKET_BYTES + 1)
        if len(packet_bytes) > MAX_PACKET_BYTES:
            reject("packet_size")
        packet = json.loads(packet_bytes.decode("utf-8"))
        if not isinstance(packet, dict):
            reject("packet_type")

        parsed = urlsplit(packet.get("url", ""))
        method = packet.get("method")
        if parsed.scheme != "https" or parsed.hostname != "grok.com" or parsed.username or parsed.password or parsed.fragment:
            reject("url_scope")
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            reject("method")

        timeout_ms = packet.get("timeoutMs")
        response_cap = packet.get("maxResponseBytes")
        accepted_statuses = packet.get("acceptedStatuses")
        if not isinstance(timeout_ms, int) or not 100 <= timeout_ms <= 600_000:
            reject("timeout")
        if not isinstance(response_cap, int) or not 1 <= response_cap <= MAX_RESPONSE_BYTES:
            reject("response_limit")
        if not isinstance(accepted_statuses, list) or not accepted_statuses or any(not isinstance(x, int) or not 200 <= x <= 299 for x in accepted_statuses):
            reject("accepted_statuses")

        headers = packet.get("headers")
        allowed_cookie_names = packet.get("allowedCookieNames")
        allowed_credential_headers = packet.get("allowedCredentialHeaderNames")
        credential_headers = packet.get("credentialHeaders")
        set_cookie_names = packet.get("setCookieNames")
        if not isinstance(headers, dict) or not isinstance(allowed_cookie_names, list) or not allowed_cookie_names:
            reject("base_fields")
        if not isinstance(allowed_credential_headers, list) or not isinstance(credential_headers, dict) or not isinstance(set_cookie_names, list):
            reject("credential_header_fields")
        if any(not isinstance(name, str) or not COOKIE_NAME.fullmatch(name) or CHALLENGE_COOKIE.search(name) for name in allowed_cookie_names):
            reject("cookie_binding_names")
        if any(not isinstance(name, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}", name) for name in allowed_credential_headers):
            reject("credential_header_names")
        if set(name.lower() for name in credential_headers) != set(allowed_credential_headers):
            reject("credential_header_set")

        for name, value in headers.items():
            if not isinstance(name, str) or not isinstance(value, str) or "\r" in value or "\n" in value:
                reject("header_shape")
            lowered = name.lower()
            if lowered not in ALLOWED_BASIC_HEADERS:
                reject("header_allowlist")
            if lowered == "origin" and value != "https://grok.com":
                reject("origin_header")
            if lowered == "referer":
                ref = urlsplit(value)
                if ref.scheme != "https" or ref.hostname != "grok.com" or ref.username or ref.password or ref.query or ref.fragment:
                    reject("referer_header")

        body, body_file, body_bytes, body_sha256, body_mode = open_direct_upload_body(packet, parsed, method)

        cookies = packet.get("cookies")
        if not isinstance(cookies, list) or not cookies:
            reject("cookie_list")
        allowed_names = set(allowed_cookie_names)
        seen_names = set()
        for cookie in cookies:
            if not isinstance(cookie, dict) or set(cookie) != {"name", "value"}:
                reject("cookie_shape")
            name, value = cookie.get("name"), cookie.get("value")
            if (not isinstance(name, str) or not COOKIE_NAME.fullmatch(name) or CHALLENGE_COOKIE.search(name)
                    or name not in allowed_names or name in seen_names or not isinstance(value, str)
                    or not value or len(value) > 16_384 or any(ch in value for ch in "\r\n\0;")):
                reject("cookie_value")
            seen_names.add(name)
        if seen_names != allowed_names:
            reject("cookie_name_set")

        try:
            import curl_cffi
            from curl_cffi import requests
        except Exception:
            emit({"error": "AUTH_CHROME_DEPENDENCY_MISSING"}, 2)
        if getattr(curl_cffi, "__version__", None) != "0.16.3":
            emit({"error": "AUTH_CHROME_DEPENDENCY_VERSION_MISMATCH"}, 2)

        stage = "session_open"
        with requests.Session(impersonate="chrome150", verify=True, trust_env=False, retry=0) as session:
            session.cookies.clear()
            for cookie in cookies:
                session.cookies.set(cookie["name"], cookie["value"], domain="grok.com", path="/")
            if {cookie.name for cookie in session.cookies.jar} != allowed_names:
                reject("cookie_jar")

            request_headers = dict(headers)
            request_headers.update(credential_headers)
            request_meta = {
                "method": method,
                "queryKeyNames": sorted({key for key, _ in parse_qsl(parsed.query, keep_blank_values=True)}),
                "headerNames": sorted(set(request_headers) | ({"cookie"} if cookies else set())),
                "cookieNames": sorted(cookie["name"] for cookie in cookies),
                "cookieValueLengths": {cookie["name"]: len(cookie["value"]) for cookie in cookies},
                "bodyBytes": body_bytes,
                "bodySha256": body_sha256,
                "bodyMode": body_mode,
            }
            stage = "request_send"
            request_args = {
                "headers": request_headers,
                "timeout": timeout_ms / 1000,
                "allow_redirects": False,
            }
            if response_cap > 65_536 or method != "GET":
                request_args["stream"] = True
            if body_file is not None:
                request_meta["headerNames"] = sorted(set(request_meta["headerNames"]) | {"content-length"})
            if method == "GET":
                response = session.get(packet["url"], **request_args)
            elif method == "POST":
                if body_file is not None:
                    response = session.post(packet["url"], content=body_file, **request_args)
                else:
                    response = session.post(packet["url"], data=body or None, **request_args)
            else:
                response = session.request(method, packet["url"], data=body or None, **request_args)
            stage = "response_headers"
            cap = response_cap if response.status_code in accepted_statuses else MAX_ERROR_BYTES
            declared = response.headers.get("content-length")
            if declared is not None:
                try:
                    if int(declared) > cap:
                        emit({"error": "AUTH_CHROME_RESPONSE_TOO_LARGE"}, 2)
                except ValueError:
                    reject("content_length")

            stage = "response_body"
            chunks = []
            size = 0
            if request_args.get("stream"):
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > cap:
                        emit({"error": "AUTH_CHROME_RESPONSE_TOO_LARGE"}, 2)
                    chunks.append(chunk)
            else:
                body_bytes = response.content
                if len(body_bytes) > cap:
                    emit({"error": "AUTH_CHROME_RESPONSE_TOO_LARGE"}, 2)
                chunks.append(body_bytes)
            payload = b"".join(chunks)
            returned_cookies = []
            permitted_set_cookies = set(set_cookie_names)
            if permitted_set_cookies:
                for line in response.headers.get_list("set-cookie"):
                    first = line.split(";", 1)[0]
                    name = first.split("=", 1)[0].strip()
                    if name in permitted_set_cookies:
                        returned_cookies.append(line)
            http_version = {1: "http/1.0", 2: "http/1.1", 3: "h2", 30: "h3"}.get(response.http_version, "other")
            session.cookies.clear()
            emit({
                "status": response.status_code,
                "contentType": response.headers.get("content-type", "")[:256],
                "httpVersion": http_version,
                "requestHeaderNames": sorted(set(request_headers) | {"cookie"} | ({"content-length"} if body_file is not None else set())),
                "requestMeta": request_meta,
                "bodyBase64": base64.b64encode(payload).decode("ascii"),
                "setCookies": returned_cookies,
            })
    except SystemExit:
        raise
    except Exception as exc:
        emit({"error": "AUTH_CHROME_FAILED", "stage": stage, "errorClass": type(exc).__name__}, 2)
    finally:
        if body_file is not None:
            body_file.close()


if __name__ == "__main__":
    main()
