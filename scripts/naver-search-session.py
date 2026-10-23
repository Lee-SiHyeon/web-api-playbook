#!/usr/bin/env python3
"""Persistent anonymous Naver search session (web-api-playbook pattern).

- curl_cffi==0.16.3 Chrome TLS/HTTP2 profile (browser-compatible transport)
- one in-memory cookie jar per process, warmed up by visiting www.naver.com first
  (server issues NNB etc.), >=5s gap before the first search
- navigation-style headers with a referer chain (home -> search -> search)
- allowlisted hosts only, redirects not followed, no retries, no captcha handling
- cookie VALUES never leave this process; only cookie names are reported
Protocol: JSON lines on stdin {"id","url"} -> stdout {"id","status","headers","body"|"error"}
"""
import json, sys, time
from urllib.parse import urlsplit, urlencode, parse_qsl, urlunsplit
from curl_cffi import requests as cr

PROFILE = "chrome150"
ALLOWED = {"search.naver.com", "www.naver.com"}
s = cr.Session(impersonate=PROFILE, trust_env=False, allow_redirects=False, timeout=25)
last_url = None

def out(o):
    sys.stdout.write(json.dumps(o, ensure_ascii=False) + "\n"); sys.stdout.flush()

def nav_headers(referer, site):
    return {"accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
            "sec-fetch-dest": "document", "sec-fetch-mode": "navigate",
            "sec-fetch-site": site, "sec-fetch-user": "?1", "upgrade-insecure-requests": "1",
            **({"referer": referer} if referer else {})}

def warmup():
    global last_url
    r = s.get("https://www.naver.com/", headers=nav_headers(None, "none"))
    # playbook bootstrapAnonymousNaverSession: the lcs beacon issues the anonymous NNB cookie
    time.sleep(1.5)
    b = s.get("https://lcs.naver.com/m?u=https%3A%2F%2Fwww.naver.com%2F&e=", headers={
        "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7", "referer": "https://www.naver.com/",
        "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors", "sec-fetch-site": "same-site"})
    names = sorted({c.name for c in s.cookies.jar})
    last_url = "https://www.naver.com/"
    return {"status": r.status_code, "beaconStatus": b.status_code, "cookieNames": names}

def browserlike(url):
    p = urlsplit(url)
    if p.hostname == "search.naver.com" and p.path == "/search.naver":
        q = dict(parse_qsl(p.query))
        q2 = {"where": q.get("where", "nexearch"), "sm": "top_hty", "fbm": "0", "ie": "utf8", "query": q["query"]}
        return urlunsplit((p.scheme, p.netloc, p.path, urlencode(q2), ""))
    return url

def main():
    global last_url
    w = warmup(); out({"id": "warmup", **w})
    time.sleep(5)
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        req = json.loads(line); rid = req.get("id")
        if req.get("op") == "cookies":
            out({"id": rid, "cookieNames": sorted({c.name for c in s.cookies.jar})}); continue
        try:
            url = req["url"]
            if urlsplit(url).hostname not in ALLOWED: raise ValueError("host not allowed")
            url = browserlike(url)
            site = "same-site" if last_url and urlsplit(last_url).hostname != "search.naver.com" else "same-origin"
            r = s.get(url, headers=nav_headers(last_url, site))
            if 200 <= r.status_code < 300: last_url = url
            h = {k: r.headers.get(k) for k in ("content-type", "location", "date", "content-length") if r.headers.get(k)}
            h.pop("content-length", None)  # body is decoded; length differs
            out({"id": rid, "status": r.status_code, "url": url, "headers": h, "body": r.text})
        except Exception as e:
            out({"id": rid, "error": type(e).__name__ + ": " + str(e)[:200]})

if __name__ == "__main__":
    main()
