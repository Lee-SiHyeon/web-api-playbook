# Google Maps saved lists: observed web contract

The maintained CLI reads the owner's private list, resolves place predictions,
saves exact features, updates item notes and reconciles uncertain writes over
independent HTTP. It uses the existing scoped transport, encrypted credential
store and write-intent journal. These are Google Maps saved lists, not a My Maps
KML import or a Drive folder.

## Execution and authentication boundary

| Phase | Mode and evidence |
|---|---|
| Initial account sign-in | Existing, owner-controlled Chrome session; password sign-in is not implemented |
| Session/context acquisition | Explicit `google-maps-bootstrap.mjs` against a caller-selected loopback CDP tab |
| Saved-list creation | First-party browser UI; creation HTTP contract is not implemented |
| Search, private-list read, feature save, note update | `pure_http`; maintained CLI does not attach a browser |
| Readback/reconciliation | Independent HTTP `getlist`, including bounded read-only consistency polling |
| Expired-login renewal | Unverified; reimport a current owner-verified context |

The bootstrap checks the active account label before reading service cookies.
The independent backend probe also requires the selected list's contributor ID
to match the caller's pinned owner ID. The bootstrap reads only cookies valid for
`https://www.google.com/maps/`, and only the Google Maps target that the caller
selected. It never copies an on-disk Chrome profile or accepts another owner's
browser. A Drive OAuth connection alone does not supply a Maps browser session.

Cookies, page context, per-operation anti-forgery values and the observed search
parameter envelope remain in process memory or the existing encrypted store.
Windows uses DPAPI CurrentUser; Linux/macOS persistence requires
`PROTECTED_STORE_PROVIDER=file`. Nothing secret belongs in argv, fixtures,
receipts or Git. The CLI refuses cross-origin redirects and cookie-scope changes.

The one-hour context age ceiling is a conservative client policy, **not** a
measured Google token lifetime. Google bound-session/expired-cookie renewal is
not established by this implementation.

## Observed request contracts

All business routes below were observed from the normal first-party UI before
replay. Values are deliberately omitted.

| Operation | Wire request | Application semantics |
|---|---|---|
| Place autocomplete | `GET /s`, `tbm=map`, `gs_ri=maps`, `suggest=p`, `q`, observed `pb` envelope | Read; predictions only |
| Private-list detail | `GET /maps/preview/entitylist/getlist`, `authuser`, `hl`, `gl`, `pb` | Read |
| Save a feature | `GET /maps/preview/entitylist/createitem`, same query keys | **Write** |
| Update an item note | `GET /maps/preview/entitylist/updateitem`, same query keys | **Write** |
| Rename/describe a list | `GET /maps/preview/entitylist/update` | UI observed; HTTP adapter unimplemented |

`APP_OPTIONS[11]` supplies the observed request context. The action tokens are
operation-specific: `APP_OPTIONS[28].Ag[28]` for `createitem`, and
`APP_OPTIONS[28].Ag[30]` for `updateitem`. One token must not be reused for both
operations. The optional bootstrap obtains these directly from the live page;
the ordinary HTTP client only consumes the protected import.

The search request preserves the observed first-party envelope and replaces
the query plus its UTF-16 cursor length. A verified `oe=utf-8` output-encoding
parameter prevents Korean text corruption with a non-browser HTTP client.
Autocomplete can return street-only and unlocated predictions alongside real
features. These are counted separately and never silently turned into a shop
or a nearby hotel. Predictions are not an exhaustive place-search catalogue.

Feature IDs contain two 64-bit integers. Their hexadecimal search representation
and signed decimal wire/`getlist` representation are normalized with `BigInt`, never
`Number`. Coordinate-only saved pins are read using their separate observed
coordinate identity; they never receive an invented feature ID. List responses remain incomplete if the reported count differs from
the returned rows. The observed request asks for 500 rows; pagination beyond
that limit is not implemented and blocks mutations requiring complete readback.

## Bootstrap once, then use the HTTP CLI

In the owner's normal Google Maps browser tab, open the intended private list
and perform a place search under **Add a place**. No place needs to be selected
for that read-only search. These two requests provide the current read context.
For a new list, create it in the first-party UI first; this step remains a
declared browser phase.

Use the requesting owner's established loopback CDP endpoint and exact tab ID:

```sh
# Linux/macOS persistence only; Windows defaults to DPAPI.
export PROTECTED_STORE_PROVIDER=file
node scripts/google-maps-bootstrap.mjs --cdp=http://127.0.0.1:9333 \
  --tab=OWNER_MAPS_TAB --expected-email=owner@example.invalid \
  --expected-owner-id=100000000000000000001 --store-dir=/private/maps-store

node scripts/google-maps.mjs list --store-dir=/private/maps-store
node scripts/google-maps.mjs search --store-dir=/private/maps-store \
  '--query=Caller-selected landmark and city'
node scripts/google-maps.mjs add --store-dir=/private/maps-store \
  --input=/private/selected-place.json --confirm=CONFIRM \
  --journal-dir=/private/maps-journal
node scripts/google-maps.mjs note --store-dir=/private/maps-store \
  --input=/private/selected-note.json --confirm=CONFIRM \
  --journal-dir=/private/maps-journal
```

An `add` input is an exact reviewed search candidate:
`{name,address,fid,lat,lng}`. A note input is
`{fid,note,expectedNote}`, or `{coordinate:{lat,lng},note,expectedNote}` for an
existing coordinate pin. Coordinates must equal the observed saved identity;
the client does not substitute a nearby business. Note writes compare `expectedNote` to the fresh
server value so a concurrent manual edit is not overwritten. Notes support
Unicode and newlines up to 400 characters. `CONFIRM` implements the execution
gate; the caller still needs the user's authorization for the actual content.

`status` checks encrypted material only and labels authentication `not_probed`.
`session-import` accepts the same bootstrap material over hidden stdin and
performs the independent owner/list probe before persistence.

## Mutation reliability

Both mutation routes use GET on the wire. Never classify them as safe reads,
prefetch them, or put them through a generic GET retry/cache layer. A stable
intent is exclusively reserved before submission. The empty-array ACK is not
proof of a saved place or note: the client independently reads `getlist` and
compares the exact feature ID or note text.

Observed read replicas can lag the ACK. The client polls **only readback**,
with waits of 250, 500, 1,000 and 2,000 ms. It never resends the mutation during
that polling. Transport failures, malformed replies and absent readbacks leave
an uncertain journal entry. Existing places are recognized before submission.

`reconcile --input=/private/reconciliation.json` performs a fresh owner-bound,
complete read without a write. Input: `{operation:"add-place",fid}` or
`{operation:"update-note",fid,note}`. After independently established absence,
one consciously requested note repair may set `retryAfterVerifiedAbsence:true`
in the note input. It preserves the original intent, links a single new attempt
to it, and refuses another reservation. Ordinary calls never enable this flag.

## Coverage and verification

`node --test tests/google-maps.test.mjs` verifies owner/identity binding,
signed-ID normalization, parser and Unicode behavior, origin isolation,
cookie deletion, confirmation, note concurrency, delayed readback and uncertain
write recovery. These tests use synthetic values and establish offline behavior,
not a live account session.

The dated record in `verification/google-maps-2026-11-02/` separately describes
the observed live operations. Private itinerary rows, list URLs, owner addresses,
cookies, action tokens and raw responses are intentionally excluded from Git.
Create/rename/delete/list-enumeration HTTP APIs, sharing/publication, creation of
arbitrary coordinate/address pins and automatic expired-login recovery remain outside the
implemented HTTP contract. They must not be inferred from feature saves.
