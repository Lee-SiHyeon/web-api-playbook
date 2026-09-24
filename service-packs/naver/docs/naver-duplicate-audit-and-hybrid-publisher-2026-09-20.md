# Published-content duplication and headless HTTP publisher

Verified on home Windows `DESKTOP-TO2H6OD`, 2026-09-20. This is a hybrid input
path: Chromium prepares the normal SDK token and new-document metadata, closes,
then a separate Node CLI performs HTTP publication. It does not remove the
browser engine or provide unattended password login.

## Published article audit

Target: <https://blog.naver.com/PostView.naver?blogId=aicandoanything&logNo=224417664446>.
The independent HTTP audit at 13:41:12 UTC found 96 ordered body units. There are
22 fragment units before the affiliate disclosure, followed by the full article.
There are no duplicated long prose paragraphs or duplicated consecutive prose
sections. There are repeated headings and five pairs of duplicate images:

| Original body positions, one-based | File |
|---|---|
| 1, 60 | 03-width-price-comparison.png |
| 4, 66 | 05-use-cases.png |
| 7, 73 | 06-decision-tree.png |
| 13, 83 | 07-community-questions.png |
| 15, 87 | 08-evidence-boundary.png |

All five pairs have identical downloaded bytes and decoded PNG pixels at the
observed `type=w773` display transformation. There are 18 images but 13 distinct
contents. The parser retains the observed image URL separately from its identity;
stripping the query returns an 80px placeholder and is inadequate for a displayed
asset audit. Filename equality alone is never used as proof. This does not assert
byte identity of an unrequested original-resolution upload.

The old extension has append, component clearing and text-only replacement
branches. The observed fragment prefix is consistent with incomplete replacement
or mixed partial writes. The exact historical job that produced this revision has
not been recovered, so that causal explanation is not confirmed.

The review-only local cleanup plan orders the 96 original units into 86 units,
removes five duplicated images and five redundant headings, keeps the five unique
prefix images in their relevant sections, and puts the disclosure first. It
preserves the existing factual wording. No public update was sent. Current
product evidence and actual desktop/mobile review still have to pass before a
commercial rewrite; a structural cleanup is not a quality-gate exemption.

The [machine-readable audit](../apps/naver-blog-api/references/published-post-duplication-2026-09-20.json)
contains per-image hashes and positions. Runtime files stay untracked.

## Implemented controls

- Before publication, reject duplicated long prose and repeated consecutive text
  sections across paragraph/quotation formatting. Short CTA labels and headings
  remain advisory so that ordinary tables of contents are not automatically rejected.
- After update/create, perform whole-document HTTP comparison and a bounded
  image-byte audit. Fetch only approved HTTPS image hosts, preserve observed query
  strings, follow no redirects, send no login cookies, and fail on missing images.
- The existing complete-document compiler replaces the body instead of appending
  fragments. Image identities and evidence hashes remain bound to the final job.
- The runtime cookie provider accepts server `Set-Cookie` rotation, respects expiry
  and deletion, restricts outgoing credentials to Blog HTTPS, and records owner
  verification. A login redirect or expired session stops execution. No credential
  file, password login, fabricated refresh token, or write retry is introduced.
- Generic new private publication now accepts a fresh headless envelope through
  stdin. It verifies business gates before launching Chrome and again before POST,
  validates the exact seed content, closes Chrome before the HTTP child, preserves
  observed opaque metadata, and binds final content to preflight and authorization.
- Journal keys exclude job IDs and SDK tokens. The returned new-post ID is saved
  before readback. Reconciliation reads that identity without reposting; a lost
  create response with no identity requires investigation and cannot auto-retry.

## Actual verification and limits

At 13:42:25 UTC the shared general headless input provider and complete-document
compiler produced one HTTP-created private technical post, `224418067386`, with
the expected title and all four paragraphs in order. Chrome was closed, its sole
Blog write was aborted, and the HTTP response, protected owner and private
visibility passed. An initial whole-cookie-header change signal was too broad:
the follow-up at 13:52:35 UTC received only `JSESSIONID`, while `NID_AUT` and
`NID_SES` rotation was not observed. The runtime status now compares only those
two authentication cookies; unrelated server cookies cannot imply login renewal.
The fresh editor uses `documentId:""`; the code preserves that observed value
instead of inventing an ID. Earlier failed attempts sent no HTTP create request.

This live probe uses a fixed noncommercial fixture and the diagnostic HTTP
transport. It does **not** claim that a real commercial job passed the general
business gates. The generic authorized create/reconciliation path is covered by
mock transport regression tests, including response loss, wrong identity,
visibility mismatch, expiry, malformed envelopes, duplicated calls and stale gates.
Its public-new-post mode remains blocked until that variant is verified. Existing
same-visibility HTTP updates remain available under their full publication gates.

See [sanitized live evidence](../apps/naver-blog-api/references/compiled-headless-verification-2026-09-20.json).
Automatic login renewal after expiry, engine-free SDK issuance, public new-post
publication and a fully reviewed real commercial publication remain unverified.

Local validation: 274 passing tests (contracts 5, affiliate 28, Naver 241),
repository hygiene for 276 tracked files, skill-bundle validation, and clean
diff whitespace. Naver tests ran serially after host memory pressure. The final
suite passes with the stricter authentication-cookie measurement and journal
check that prevents relaunching Chrome for an already attempted create.

## Commands

Run from `apps/naver-blog-api`. Supply current authorized credentials through the
runtime environment, never in command arguments or credential files.

```powershell
node scripts/api/publisher-cli.mjs --command=session-status --blog-id=aicandoanything
node scripts/api/publisher-cli.mjs --command=audit-post --blog-id=aicandoanything --log-no=224417664446 --output=.runtime/audit.json
node scripts/hybrid/publisher-cli.mjs --command=prepare-create --job=.runtime/private-dry-job.json --journal=.runtime/publisher-journal --output=.runtime/create-preflight.json
node scripts/gates/authorize-api-update.mjs --job=.runtime/private-dry-job.json --preflight=.runtime/create-preflight.json --approved-by=user --output=.runtime/authorized-create.json
node scripts/hybrid/publisher-cli.mjs --command=create --job=.runtime/authorized-create.json --journal=.runtime/publisher-journal --output=.runtime/create-result.json
node scripts/api/publisher-cli.mjs --command=reconcile-create --job=.runtime/authorized-create.json --journal=.runtime/publisher-journal --output=.runtime/reconciled-create.json
```

Create jobs use `target.type=create`, no `logNo`, `inputProvider=headless_sdk`,
`executionMode=independent_http`, `visibility=private`, and `timing=current`.
The authorization command records consent already obtained for the exact job;
it does not create consent or real review evidence. Each output must be a new path.
