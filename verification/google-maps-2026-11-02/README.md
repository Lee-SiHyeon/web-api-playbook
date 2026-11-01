# Google Maps saved-list verification — 2026-11-02 KST

The requesting owner's existing normal Chrome session was reached over its
established SSH/loopback CDP route. The active Maps account matched the expected
owner. A newly created **private** trip list was independently read through the
HTTP client, and its backend contributor ID matched the pinned owner ID.
No other saved list was edited and no public-sharing action was performed.

The final independent read returned **57 items and 57 notes**, with a matching
reported count: 56 exact business/landmark/station features and one coordinate
anchor for a shopping street. The street-only autocomplete prediction could not
be saved by the normal Add-a-place UI; the owner-authorized street anchor was
saved through the coordinate UI and clearly described in its note. That is not
an invented business identity or a new public place submission.

## Live observations

- Normal first-party UI requests established the private `getlist`, feature
  `createitem` and `updateitem` contracts. The first independent HTTP feature
  replay cancelled the corresponding browser write before transmission.
- The same protected state supported fresh CLI processes, owner-bound list
  reads, place predictions and feature saves. CLI sessions used the existing
  Linux AES-256-GCM credential provider; no cleartext session bundle was saved.
- Feature notes and the coordinate pin's note were independently updated and
  read back over HTTP. The two write operations require different observed
  action-token slots. Note edits use the current saved identity and compare the
  old note before changing it.
- Google returns signed decimal int64 identities in saved lists, while search
  uses hexadecimal identities. `BigInt` normalization and signed wire encoding
  preserve the same feature without floating-point truncation.
- Mutation ACKs can precede replicated list reads. Bounded polling repeats only
  `getlist`; it never resends a mutation. Unclear initial outcomes were checked
  against complete reads, preserving their original journals and linking any
  consciously requested note repair attempt to the original intent.
- List count, note text and feature identity were independently checked again
  after the batch. A final fresh-process read/search used the implementation
  fingerprints in `live-summary.json`.

`live-summary.json` contains only sanitized metadata, per-operation scope and
implementation hashes. Private itinerary rows, list IDs/URLs, account addresses,
cookies, page/action tokens, raw responses and screenshots remain outside Git.
The summary records observations; validating that JSON alone is not a fresh
authentication test.

## Explicit remaining boundaries

New-list creation and coordinate-pin creation used the first-party browser UI;
their HTTP writers are not implemented. List rename was observed in UI traffic
but is not exposed as a writer. Delete, sharing, global list enumeration,
pagination beyond the observed 500-row detail request, and expired-login renewal
remain unimplemented or unverified. HTTP feature and note operations do not
establish browser-free initial login or automatic session renewal.

Offline regression: `node --test tests/google-maps.test.mjs`. The repository's
ordinary `npm test` also discovers that file. Full validation results are reported
with the delivery commit and CI, separately from the live account observations.
