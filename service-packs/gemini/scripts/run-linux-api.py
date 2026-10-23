#!/usr/bin/env python3
"""Use the registered Linux Chrome session once, then run a direct HTTP command."""

import argparse
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import urllib.parse
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
SERVICE_ORIGIN = "https://gemini.google.com"
HISTORY_RPC = "MaZiqc"
HISTORY_HEADERS = {
    "content-type",
    "referer",
    "x-goog-ext-525001261-jspb",
    "x-goog-ext-73010989-jspb",
    "x-same-domain",
}


class SafeFailure(Exception):
    pass


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("identity", "history"))
    parser.add_argument("--expect-owner", required=True)
    parser.add_argument(
        "--runtime-owner",
        default=str(pathlib.Path.home() / ".nad-scratch/provider-runtime-20261005/runtime-owner.json"),
    )
    parser.add_argument("--role-registry", default=str(pathlib.Path.home() / ".nad-scratch/provider-runtime-20261005/page-role-registry.json"))
    parser.add_argument("--page-marker", required=True, help="Select the exact registered task page by its window.name marker.")
    parser.add_argument("--contract", default=str(REPO / "discovery/observed-contract.json"))
    return parser.parse_args()


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except Exception as exc:
        raise SafeFailure from exc


def verify_owned_runtime(owner):
    if owner.get("taskOwned") is not True or owner.get("mode") != "cdp_discovery_after_native_bootstrap":
        raise SafeFailure
    profile = pathlib.Path(owner.get("profile", ""))
    scratch = pathlib.Path.home() / ".nad-scratch"
    try:
        profile.relative_to(scratch)
    except Exception as exc:
        raise SafeFailure from exc
    pid = owner.get("chromePid")
    port = owner.get("cdpPort")
    if not isinstance(pid, int) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise SafeFailure
    try:
        os.kill(pid, 0)
        command_line = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().decode("utf-8", "replace")
        if f"--user-data-dir={profile}" not in command_line:
            raise SafeFailure
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass
    except Exception as exc:
        raise SafeFailure from exc
    return port


def header_subset(headers, allowed):
    normalized = {str(name).lower(): str(value) for name, value in headers.items()}
    return {name: normalized[name] for name in allowed if name in normalized}


def capture_session(runtime_owner, role_registry, contract, page_marker):
    port = verify_owned_runtime(runtime_owner)
    role = role_registry.get("activePageRoles", {}).get(page_marker)
    if (not isinstance(role, dict) or role.get("origin") != SERVICE_ORIGIN
            or role.get("exactMarkerCount") != 1
            or role.get("selection") != "owned_origin_and_exact_marker"):
        raise SafeFailure
    allowed_cookies = set(contract["auth"]["cookieNames"])
    operations = contract["operations"]
    captured = {"document": None, "history": None, "invalidObservation": False}
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
        contexts = browser.contexts
        if len(contexts) != 1:
            raise SafeFailure
        context = contexts[0]
        matches = [page for page in context.pages if page.evaluate("() => window.name") == page_marker]
        if len(matches) != 1:
            raise SafeFailure
        page = matches[0]
        parsed = urllib.parse.urlsplit(page.url)
        if parsed.scheme != "https" or parsed.hostname != "gemini.google.com" or parsed.path != "/app":
            raise SafeFailure
        if not page.evaluate("() => !!document.querySelector('chat-app-orchestrator')"):
            raise SafeFailure

        pending_text_retries = []
        def preflight_guard(route):
            try:
                request = route.request
                parsed_request = urllib.parse.urlsplit(request.url)
                if parsed_request.hostname != 'gemini.google.com' or request.method.upper() in ('GET', 'HEAD', 'OPTIONS'):
                    route.continue_()
                    return
                query_values = urllib.parse.parse_qs(parsed_request.query, keep_blank_values=True)
                rpc_ids = query_values.get('rpcids', [])
                if parsed_request.path.endswith('/StreamGenerate') or 'RxAFq' in rpc_ids:
                    pending_text_retries.append(True)
                    route.abort('aborted')
                    return
                if rpc_ids in (['MaZiqc'], ['otAQ7b']):
                    route.continue_()
                    return
            except Exception:
                captured['invalidObservation'] = True
            try:
                route.abort('aborted')
            except Exception:
                captured['invalidObservation'] = True

        page.route('**/*', preflight_guard)

        def on_request(request):
            parsed = urllib.parse.urlsplit(request.url)
            if parsed.scheme != "https" or parsed.hostname != "gemini.google.com":
                return
            if request.resource_type == "document" and parsed.path == "/app":
                captured["document"] = {
                    "url": request.url,
                    "headers": header_subset(request.headers, set(operations["identity"]["request"]["headerNames"])),
                    "request": request,
                }
                return
            if request.resource_type not in ("xhr", "fetch") or parsed.path != "/_/BardChatUi/data/batchexecute":
                return
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            if query.get("rpcids") != [HISTORY_RPC]:
                return
            form_pairs = urllib.parse.parse_qsl(request.post_data or "", keep_blank_values=True)
            if [name for name, _ in form_pairs] != operations["history_list"]["request"]["bodyFieldNames"]:
                captured["invalidObservation"] = True
                return
            form = urllib.parse.parse_qs(request.post_data or "", keep_blank_values=True)
            if [name for name, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)] != operations["history_list"]["request"]["queryKeys"]:
                captured["invalidObservation"] = True
                return
            try:
                nested = json.loads(form["f.req"][0])
                call = nested[0][0]
                args = json.loads(call[1])
            except Exception:
                captured["invalidObservation"] = True
                return
            if (not isinstance(call, list) or len(call) != 4 or not isinstance(args, list)
                    or call[0] != HISTORY_RPC or len(args) != 3 or not isinstance(args[0], int)
                    or args[1] is not None or not isinstance(args[2], list) or len(args[2]) != 3
                    or not isinstance(args[2][0], int) or args[2][1] is not None or not isinstance(args[2][2], int)
                    or call[2] is not None or call[3] != "generic"):
                captured["invalidObservation"] = True
                return
            if args[2][0] != 0:
                return
            captured["history"] = {
                "url": request.url,
                "headers": header_subset(request.headers, HISTORY_HEADERS),
                "form": form,
                "args": args,
                "requestId": request,
            }

        def on_response(response):
            request = response.request
            if captured["document"] and request is captured["document"].get("request"):
                captured["document"]["status"] = response.status
                captured["document"]["mime"] = response.headers.get("content-type", "").split(";", 1)[0].lower()
            if captured["history"] and request is captured["history"].get("requestId"):
                captured["history"]["status"] = response.status
                captured["history"]["mime"] = response.headers.get("content-type", "").split(";", 1)[0].lower()
                try:
                    body = response.body()
                except Exception:
                    captured["invalidObservation"] = True
                    return
                if len(body) > 8 * 1024 * 1024:
                    captured["invalidObservation"] = True
                    return
                captured["history"]["responseBytes"] = len(body)
                captured["history"]["rpcResponsePresent"] = HISTORY_RPC.encode() in body

        page.on("request", on_request)
        page.on("response", on_response)
        try:
            page.reload(wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(12000)
        finally:
            page.unroute('**/*', preflight_guard)
            page.remove_listener("request", on_request)
            page.remove_listener("response", on_response)
            page.wait_for_timeout(300)

        history = captured["history"]
        document = captured["document"]
        if captured["invalidObservation"] or pending_text_retries:
            raise SafeFailure
        if not history or history.get("status") != 200 or history.get("mime") != "application/json" or not history.get("rpcResponsePresent"):
            raise SafeFailure
        if not document or document.get("status") != 200 or document.get("mime") != "text/html":
            raise SafeFailure

        cookies = context.cookies(SERVICE_ORIGIN)
        cookie_map = {item["name"]: item["value"] for item in cookies if item["name"] in allowed_cookies}
        if set(cookie_map) != allowed_cookies:
            raise SafeFailure
        parsed_url = urllib.parse.urlsplit(history["url"])
        query = urllib.parse.parse_qs(parsed_url.query, keep_blank_values=True)
        form = history["form"]
        session = {
            "version": 1,
            "service": contract["service"],
            "origin": SERVICE_ORIGIN,
            "capturedAt": datetime.now(timezone.utc).isoformat(),
            "cookies": [{"name": name, "value": value} for name, value in cookie_map.items()],
            "headers": {},
            "requestHeaders": {
                "identity": document["headers"],
                "history_list": history["headers"],
            },
            "batchContext": {
                "at": form["at"][0],
                "fSid": query["f.sid"][0],
                "buildLabel": query["bl"][0],
                "locale": query["hl"][0],
                "requestType": query["rt"][0],
                "sourcePath": query["source-path"][0],
                "requestId": query["_reqid"][0],
                "historyListArgs": history["args"],
            },
        }
        return session


def main():
    args = parse_args()
    try:
        runtime_owner = read_json(args.runtime_owner)
        role_registry = read_json(args.role_registry)
        contract = read_json(args.contract)
        session = capture_session(runtime_owner, role_registry, contract, args.page_marker)
        node = shutil.which("node")
        if not node:
            raise SafeFailure
        command = [node, str(REPO / "src/cli.mjs"), args.operation, "--session-stdin", "--expect-owner", args.expect_owner]
        if args.contract != str(REPO / "discovery/observed-contract.json"):
            command.extend([args.contract])
        result = subprocess.run(command, input=json.dumps(session), text=True, capture_output=True, timeout=90, check=False)
        if result.returncode != 0:
            code = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "UNKNOWN"
            safe_code = code if re.fullmatch(r"[A-Z][A-Z0-9_]{2,63}", code) else "UNKNOWN"
            sys.stderr.write(f"GEMINI_DIRECT_HTTP_FAILED:{safe_code}\n")
            return result.returncode
        sys.stdout.write(result.stdout)
        return 0
    except SafeFailure:
        sys.stderr.write("GEMINI_SESSION_CAPTURE_FAILED\n")
        return 1
    except Exception:
        sys.stderr.write("GEMINI_SESSION_CAPTURE_FAILED\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
