# AliExpress reassessment — 2026-10-16

The user resumed AliExpress consumer HTTP work. Canary's Google organic result
click changed the tab URL/title to the AliExpress search page. The next page
observation was rejected by Browser Use site-safety policy before a user prompt
or automatic review. This is not an observed AliExpress HTTP 403. No alternate
browser/CDP/HTTP route was attempted. Current direct HTTP calls: **0**; current
business-data replay: **unverified**; screenshot: **not captured**.

The subsequent chat approval was acknowledged but did not grant tool authority.
No email approval flow was created. The exact tool response is in
[browser-attempt.json](browser-attempt.json).

Local review corrected the older “reviews not observed” claim: the October 14
sanitized inventory has **3 PDP and 6 review response observations**, all HTTP
200. Their recorded schema remains `invalid_json`; the original bodies are not
available in this checkout. The inventory alone does not establish JSONP syntax,
usable review fields, six distinct pages, prices, options, session propagation,
or direct replay. [Historical evidence and hashes](historical-contracts.json).

The HAR converter now accepts narrowly request-bound, data-only JSONP wrappers
without executing JavaScript. Synthetic tests cover exact callback binding,
malformed/multiple wrappers, data redaction, error envelopes, MIME, body limits,
strict base64 and JSON/JSONP distinction. Shape comparisons retain unclassified
business outcomes and reject decode/size gaps. This is a collector parser fix;
it does not implement the AliExpress detail/review client or reparse old bodies.

See [offline validation](offline-validation.json) and the current
[capability checklist](checklist.json). The SEO/sitemap clients remain available
as existing code; their current live behavior was not tested in this attempt.

During delivery, upstream main advanced to `de5533033911886c63f79a5213c56f0fef087c03`.
That change was integrated without overwriting it. The upstream
[October 16 report](../../references/overseas-keyless-probe-2026-10-14.md)
reports 604 sitemap shards, 31,999 identities in shard 0, and an SEO response
with description but a placeholder title. Its reader fix now returns `title:null`
for that placeholder. These are separately authored reported results, not fresh
replays performed by this blocked browser task or new structured live receipts.
The upstream report also distinguishes historical browser-assisted PDP payloads
from failed pure-HTTP MTop validation; this local inventory analysis does not
invalidate that separate report.

Official product documentation provides user-facing permission diagnostics:
[Settings > Computer Use > Chrome > Manage](https://learn.chatgpt.com/docs/chrome-extension#manage-allowed-and-blocked-websites)
manages website allow/block lists. The current error does not identify which
policy source denied access; the user's actual setting is not known.
[Settings > Browser > Developer mode > Enable full CDP access](https://learn.chatgpt.com/docs/browser#developer-mode)
is a separate network/debugging permission, not proof that site access is allowed.
No browser, security or permission settings were changed by this work.
