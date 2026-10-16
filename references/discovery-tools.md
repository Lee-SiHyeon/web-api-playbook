# Portable discovery tools

These utilities turn local evidence into sanitized candidates and resumable state. They do not log in, open a browser, send HTTP requests, run page scripts, or replay a contract. A HAR entry is evidence that a request appeared in that capture; it does not prove the request is read-only, authenticated, reusable, or live now.

The tools use Node.js 24 ESM and `parse5` 8.0.1 for inert parsing of saved HTML. Paths are resolved from the current working directory unless absolute. All `--output` files are created with exclusive-new semantics; an existing path is an error and is never overwritten. Create the output directory first, for example `node -e "require('node:fs').mkdirSync('work', { recursive: true })"` from the repository root.

## Safety and output boundary

HAR and HTML inputs are parsed in memory. The tools never print or persist raw URLs, query values, cookies, authorization headers, token/CSRF values, account-selector values, request/response body samples, DOM text, or HTML attribute values. Output keeps only:

- HTTP method, origin, normalized path, query/body field names, encoding, and operation-selector field names
- observed status and MIME type
- body byte counts and response SHA-256 when the HAR contains a body
- JSON response shape with keys and value types only
- sanitized source-entry indexes, timestamps, candidate state, and frontier metadata

Query strings are not retained. Dynamic-looking path segments such as numeric IDs, UUIDs, long opaque strings, and encoded segments become `:id`. This is a heuristic: inspect the normalized path and evidence before implementing an adapter. Values for selector fields are intentionally omitted, so two operations distinguished only by selector values may share one contract identity; each source observation remains separately listed with its entry index and selector field names.

The `examples/sanitized.har.json` file uses `example.invalid` and synthetic redacted values. It is safe sample input, not captured production traffic.

## HAR to contract inventory

Include Document, Fetch, XHR and other relevant HTTP resource types in the source
capture; do not export only the browser's XHR filter. An initial HTML response can
carry the usable catalog in embedded JSON even when a later UI click makes no
request. Capture before navigation, drain bounded CDP buffers while it runs, and
pair requests and responses before reducing them to this inventory. Missing or
truncated events remain gaps; DOM text alone does not reconstruct a lost response.

The [Modetour Document reader](../service-packs/ontology/README.md) provides a live
example: the observed HTML GET contains ten recommendations in `__NEXT_DATA__`,
independently parsed without running JavaScript or loading a browser session.

The capability checklist accepts `browser_http_observed` provenance with the
actual `resourceType`, paired request/response, non-truncated capture, observation
time, sanitized evidence hash and exact source route. This includes Document and
Fetch without mislabeling them as XHR. The independent replay still has to pass
the configured status, MIME, response/schema checks and current-code hash check;
a bare `ssr_document` label or DOM-only observation is insufficient.

Read a local HAR and print the sanitized inventory:

```powershell
node scripts/har-to-contracts.mjs --input=.\examples\sanitized.har.json
```

Or pipe JSON on standard input:

```powershell
Get-Content .\examples\sanitized.har.json -Raw | node scripts/har-to-contracts.mjs
```

To keep a new inventory file, choose a path that does not exist:

```powershell
node scripts/har-to-contracts.mjs --input=.\examples\sanitized.har.json --output=.\work\contracts-001.json
```

`--input` accepts one local file; if omitted, the CLI reads standard input. A UTF-8 BOM is accepted and removed before parsing. The input limit is 64 MiB. `--output` is optional; without it, sanitized JSON goes to standard output. A stored inventory has schema `xhr-contract-inventory-v1` and contains `contracts[]`; each contract has an identity over method, origin, normalized path, query/body field names, content encoding, and operation field names. Each `observations[]` entry records its HAR entry number, time, request/response MIME, response status, response bytes/hash, and response schema. Request bytes may be counted, but request-body hashes and values are not saved. JSON schemas omit values and redact dynamic object-map keys.

`mutationCandidate` is a review hint for write-like HTTP methods. It is not proof of a mutation, and a POST may be a read. Conversely, a GET can still mutate. Do not replay a candidate until its semantics, actor scope, parameters, response behavior, and required authentication are independently established.

For JSON/JavaScript responses with an observed `callback` query parameter, the
inventory also supports a single JSONP wrapper whose simple identifier exactly
matches that request parameter. It parses only the JSON argument with
`JSON.parse`; it never evaluates scripts. Duplicate/mismatched callbacks,
expressions, additional arguments and executable suffixes are rejected. Output
records `responseFormat: json` or `jsonp`, never the callback value. Structured
bodies over 4 MiB retain the size-limit gap. A parseable error envelope is still
only a schema observation, not usable business data or a direct replay. Existing
inventories containing `invalid_json` cannot be recovered without the original
authorized body; do not relabel them as successfully parsed JSONP.

## Discover candidates from saved HTML

The HTML tool parses one saved local document. It extracts anchors/areas, frames, scripts with `src`, and links with `href`. It does not fetch those destinations or script imports, inspect inline script source, or claim XHR capture.

```powershell
node scripts/discover-html.mjs --input=.\work\saved-page.html --base=https://example.invalid/catalog/ --output=.\work\html-candidates-001.json
```

`--input` and `--base` are required. `--base` is the observed page URL used to resolve relative links. A document `<base href>` is honored for resolution, but only its sanitized origin/path and query field names can appear in output. The parser has a 16 MiB local input limit. Output schema is `xhr-html-candidates-v1`; it labels the evidence `local_saved_html`, sets `liveNetworkUsed=false` and `xhrContractsObserved=0`, and leaves every item in `candidate` state. Different query values collapse to the same normalized target because values are not retained.

The result is a navigation/resource candidate list. It is not a crawler queue until a caller intentionally adds reviewed candidates to a frontier. Script and link resources are not XHR contracts.

## Resumable frontier

The frontier keeps the requested root, allowed origins, requested stages, parent edges, node states, attempts, pagination summaries, and a report with an explicitly unknown denominator. It stores normalized origin/path plus field names; it never stores complete URLs or raw query/cursor values. A cursor is represented only by `cursorPresent` and an optional ordinal `sequence`.

The snapshot is an evidence checkpoint, not an executable queue or a complete automatic-resume mechanism. Since source URLs, selector values, parameters, and cursor values are deliberately omitted, a runner cannot reconstruct requests from a frontier snapshot alone. If a separately authorized runner needs to resume a specific dynamic resource, the caller may add a fresh UUID v4 `instanceKey` to distinguish otherwise-colliding normalized nodes. Generate it independently (for example, with a cryptographic UUID generator); never derive it from a service/account identifier, URL, selector, cursor, credential, or a hash of any of those values. Store any mapping from that UUID to raw URLs, parameters, and cursor state only in the service's separate authorized ProtectedStore or user-provided protected provider. The frontier itself must contain no such mapping.

### Initialize

```powershell
@'
{
  "root": "https://example.invalid/",
  "stages": ["navigation", "listing", "details"],
  "allowedOrigins": ["https://api.example.invalid"]
}
'@ | node scripts/frontier.mjs init --output=.\work\frontier-001.json
```

The root origin is always allowed. Other origins must be listed explicitly. Root query values, if supplied, are discarded; only query field names remain. The initial root stage is the first stage in the supplied list.

### Add observed nodes and preserve parent edges

Use a new output snapshot for every change. `parentId` refers to the safe hashed node ID from the prior snapshot or `frontier next` output.

```powershell
@'
{
  "parentId": "<parent-node-id>",
  "edgeType": "menu",
  "observedAt": "2026-09-24T00:00:00Z",
  "nodes": [
    {
      "origin": "https://example.invalid",
      "path": "/catalog/:id",
      "stage": "navigation",
      "queryFields": ["categoryId"],
      "method": "GET",
      "readOnly": true,
      "depth": 1,
      "evidenceSource": "DOM"
    }
  ]
}
'@ | node scripts/frontier.mjs add --snapshot=.\work\frontier-001.json --output=.\work\frontier-002.json
```

The CLI accepts either one `node` object or a `nodes` array. A UTF-8 BOM is accepted and removed before parsing JSON input and snapshots. An unreviewed node defaults to `candidate`; `readOnly:true` is an explicit caller assertion that allows it to enter `pending`. The tool does not infer read-only semantics from GET. Nodes outside `allowedOrigins` are preserved as `out_of_scope`. Repeated nodes are deduplicated by origin/path/stage/method/field names/pagination ordinal and `instanceKey`, while each distinct incoming parent edge is retained. Supply `instanceKey` only when preserving separate dynamic work items is necessary:

```json
{
  "origin": "https://example.invalid",
  "path": "/items/:id",
  "stage": "details",
  "instanceKey": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

The UUID must be freshly caller-generated and unrelated to source identifiers or their hashes. A parent directory such as `work` must already exist before writing snapshots.

### Inspect next work and coverage

```powershell
node scripts/frontier.mjs next --snapshot=.\work\frontier-002.json --limit=20
node scripts/frontier.mjs next --snapshot=.\work\frontier-002.json --include-deferred
node scripts/frontier.mjs report --snapshot=.\work\frontier-002.json
```

`next` is read-only and selects pending nodes breadth-first by depth. `budget_deferred` nodes remain saved and appear only with `--include-deferred`. `report` gives per-stage observed counts and states, not a percentage: the expected denominator is always `unknown`. `boundedScopeExhausted` is true only after root discovery is explicitly marked complete, all observed nodes are terminal, and every observed pagination node has explicit termination evidence. It does not claim whole-site coverage.

### Mark attempts and pagination

```powershell
@'
{
  "id": "<node-id>",
  "state": "request_observed",
  "attempted": true,
  "at": "2026-09-24T00:05:00Z",
  "evidenceSource": "network",
  "pagination": {
    "kind": "cursor",
    "sequence": 1,
    "cursorPresent": true,
    "terminal": false,
    "termination": "unknown"
  }
}
'@ | node scripts/frontier.mjs mark --snapshot=.\work\frontier-002.json --output=.\work\frontier-003.json
```

`mark` increments `attempts` only when `attempted:true`; it sets `lastAttemptAt` from `at`. Allowed states are `pending`, `candidate`, `inspected`, `request_observed`, `replay_verified`, `blocked_auth`, `blocked_runtime`, `out_of_scope`, `budget_deferred`, and `mutation_excluded`. `request_observed` is not `replay_verified`. `mutation_excluded` and `budget_deferred` are preserved across snapshots. Never place cursor values in the payload; the CLI drops a supplied cursor string and retains only a boolean that one existed. Keep any raw URL/selector/parameter/cursor resumption mapping in the separate protected provider described above. A saved frontier alone cannot automatically reconstruct or resume the original requests.

To record root-menu enumeration, mark the root node with `rootDiscovery:"complete"` only after all observed root branches are entered. `observed` means the root was inspected but does not certify all branches. Blocked auth/runtime boundaries may be recorded with the same mark payload:

```json
{
  "sharedFailureBoundary": {
    "state": "blocked_runtime",
    "code": "browser_connection_lost",
    "stage": "navigation",
    "observedAt": "2026-09-24T00:05:00Z"
  }
}
```

Only generic allowlisted reason codes are retained. Resolve the boundary before resuming blocked work; do not treat a saved frontier as a background job.

## State and evidence meaning

| State | Meaning |
|---|---|
| `candidate` | A URL or operation needs scope/semantics review. |
| `pending` | An explicitly accepted node is queued for a future authorized read. |
| `inspected` | Page/document was inspected; no XHR conclusion follows by itself. |
| `request_observed` | A request was observed in source/network evidence. |
| `replay_verified` | An independent direct replay passed its own checks. |
| `blocked_auth`, `blocked_runtime` | Work stopped at that observed boundary. |
| `out_of_scope`, `mutation_excluded` | Explicitly retained exclusions and reasons. |
| `budget_deferred` | Work remains queued for a later run; the denominator stays unknown. |

These snapshots are evidence checkpoints, not authentication stores or executable request queues. Keep credentials and runtime cursors in their owning protected client. A recorded endpoint or schema does not make an API client, prove current authentication, or establish browserless execution.
