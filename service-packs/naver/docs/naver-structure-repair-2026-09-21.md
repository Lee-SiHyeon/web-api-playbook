# Existing post structure repair

The user requested correction of the duplicated prefix in the existing public
post `aicandoanything/224417664446`. This is an update to that URL, not a new post.

The reviewed operation retains all 64 factual text units, five unique prefix
images, three useful prefix quotations, all dividers, the original title and
affiliate links. It removes five byte/pixel-identical images and five redundant
prefix headings, placing the disclosure first. Ordered units change 96 → 86;
images change 18 → 13. Paragraph styles, text-node hyperlinks, retained image
objects and opaque document metadata are preserved from fresh owner responses.

The maintenance entry point is bound in code to this target and its full source
fingerprint. It cannot accept replacement content, a different order, other
deletions or publication settings. Fresh public/owner source agreement, image
downloads, a second concurrency check, the existing one-write journal, exact
public readback, image audit and owner/settings readback are mandatory. A lost
response is reconciled by reads; it does not trigger another POST.

The observed owner document uses `blogfiles.pstatic.net`, while public HTML uses
`postfiles.pstatic.net` for the same image paths. Both complete source fingerprints
are bound explicitly, and the mapped document must still match the public source.
This does not generally equate CDN hosts or relax image-byte verification.

This is structural maintenance, not a new commercial review. Price/specification
freshness and overall editorial quality remain unverified by this operation.
The ordinary commercial publisher retains its complete publication-bundle gate.

## Operator runner

Run from `apps/naver-blog-api` with the authorized runtime credential provider.
The verified run handed the supported Canary session to this process in memory.
The legacy `--from-chrome=true` helper targets ordinary Chrome's configured port;
it was not the successful provider in this run. Never write cookies to a file or
command argument.

```powershell
node tools/discovery/repair-published-prefix.mjs --mode=preflight --from-chrome=false --journal=../../.runtime/publisher-journal --backup=../../.runtime/reviewed-repair-original.json --output=../../.runtime/reviewed-repair-preflight.json
node tools/discovery/repair-published-prefix.mjs --mode=apply --from-chrome=false --journal=../../.runtime/publisher-journal --backup=../../.runtime/reviewed-repair-original.json --output=../../.runtime/reviewed-repair-result.json
```

The backup stores only the already-public, fingerprint-verified title and units,
not credentials or raw editor/manager responses. A receipt file is exclusively
reserved before mutation. Investigate an existing journal/receipt instead of
changing paths and resubmitting an uncertain operation.

## Current live boundary

**Applied and independently verified on 2026-09-21 KST.** The HTTP write was
accepted at the existing URL, with exact public and protected owner readback
completed by `2026-09-20T16:13:22.023Z`. A subsequent anonymous HTTP image audit
and desktop/mobile headless rendering completed by `2026-09-20T16:16:23.132Z`.
Both views loaded all 13 images; disclosure is the first body text. The full
86-unit content matches and no duplicate image groups or duplicated prose remain.

The correct signed-in profile was Chrome Canary, identified by the previously
used extension instance. Restarting ordinary Chrome alone did not restore it.
After Canary was restarted, the supported current-origin session handoff reached
the independent HTTP runner and its owner probe passed. Credentials stayed in
memory and were cleared after the update. No browser issued the correction POST;
the final headless verification used no login credentials.

The above apply command is a historical operator example. Do not rerun the write:
the corrected source intentionally fails the old-source guard. Use read-only
post/audit commands for follow-up checks. Current price/specification freshness,
automatic login renewal and new public-post creation are outside this receipt.

Sanitized evidence: `apps/naver-blog-api/references/published-post-repair-2026-09-21.json`.
