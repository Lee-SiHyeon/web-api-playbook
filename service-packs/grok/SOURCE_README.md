# Grok Web XHR client

This private Node 24 project records only first-party Grok Web consumer requests that have evidence. It does not use an xAI developer API. A source callsite is labeled separately from browser capture, and an operation is unavailable until its request shape and security boundary are verified.

## Evidence and readiness

| Operation | Browser capture | Client | Direct read evidence | Current auth/live state |
| --- | --- | --- | --- | --- |
| Public model list | No; source-derived | Yes | Yes, a cookie-free exact source-method replay returned HTTP 200 JSON on 2026-10-03 | No credentials used; run `node src/cli.mjs models` for a fresh replay |
| Text generation | Guarded native SDK/WSS capture; browser business frame blocked | Yes, direct WSS | One response frame bound after the server `session.created` acknowledgement; independent history readback verified the exact task and added assistant | The captured replay is recorded, but the receipt needs re-verification after later conversation-client edits; the earlier unknown text intent remains held |
| Conversation history | Source-derived read contracts | Yes | Current-source direct reads verified owner, list first/next/search, detail, response nodes, and loaded history; each returned HTTP 200 | Stored receipts are consistent with the current read handlers; the verifier did not create a conversation |
| Conversation deletion | Guarded native header-menu request; browser DELETE aborted | Yes, owner-bound main CLI | One source-permitted soft-delete returned HTTP 200; a separate complete-list read showed the task absent and the other conversation-ID set unchanged | Live result is recorded for the private neutral test conversation; it now needs re-verification after a later CLI source edit |
| Image generation | Current Imagine WSS capture | Yes | The historical Quality 2.0 ×4 task is linked to four private JPEGs and exact prompt/history evidence | Task output is verified; the original writer receipt still needs current-source verification, and its writer-response ID comparator is unavailable |
| Text-to-video | Current Imagine XHR capture | Yes | One direct POST returned HTTP 200 JSON; task history linked one private MP4, then an owner-bound GET returned HTTP 200 for 390,210 bytes with matching MP4 magic and SHA-256 | Business result verified; the original writer source snapshot needs re-verification after later source edits; no retry |
| Image-reference-to-video | Normal SDK capture; browser business request blocked | Yes | A separate image03 task returned direct HTTP 200, exact source-image/history linkage and a downloaded 227,600-byte MP4 | Business outcome verified for that task; older uncertain intents remain held and its writer receipt is not current-source canonical evidence |
| Private media download | Current same-URL asset GET captured | Yes | A task-linked JPEG was freshly downloaded with HTTP 200 (184,352 bytes) and matched its historical hash; the text-to-video MP4 was freshly read with HTTP 200 (390,210 bytes) and matched its task artifact | The image download receipt is current; the video download receipt and media writer snapshots retain their specific source-drift status |
| Small private attachment upload | Current paperclip request captured and blocked; SDK source mapped | Yes | One neutral 14-byte file used the observed `POST /http/upload-file-v2/direct`; metadata readback, independent CFFI byte/hash readback, exact task-asset deletion and a post-delete exact-name search all verified | Completed; the in-process response-size audit field was not retained |

The public models operation comes from `modelsGetModelsRaw` in `https://cdn.grok.com/_next/static/chunks/35ntlely29ab3.js` (SHA-256 `da50d0a6eedb65fa5f5ba402e96b3d9349e586855f07de34a3a21bf9b1b0f316`). The observed call is `POST https://grok.com/rest/models` with `Content-Type: application/json` and body `{"locale":"en"}`. A cookie-free direct replay returned HTTP 200 `application/json`, 898 bytes, SHA-256 `7b751e71ddb6a5e035763763736374683fae683abe45d519fda6d6ec69ad37ce`, with model arrays and anon/free/pro/heavy defaults. The browser-capture flag remains false. `models` calls that exact public reader and reports the hash of its own response.

Media contracts and dated evidence are in `contracts/grok-media-contract-fragment-2026-10-06.json` and `verification/`. The image operation uses the captured one-batch Quality 2.0 WebSocket frames; its historical four private JPEGs are linked to the prompt and loaded history. The current API freshly reread one of those images with HTTP 200, 184,352 bytes, JPEG magic, disk readback, and a SHA-256 matching the old task artifact. `verification/one-shot/grok-media-image-readback-duplicate-note-9901151c1dd4c5b3-bfabb738.json` records that two read-only downloads of the same image occurred while closing the workflow; neither created another image. The earlier raw writer frames were discarded, so the writer-response comparator remains unavailable. Text-to-video uses the captured `--mode=custom` body and the observed six-second, 480p, no-audio profile. Its one direct request is linked to an HTTP 200 operation-journal entry, exact task history, and one private generated MP4. A fresh asset-host GET verified the same 390,210-byte MP4 with HTTP 200, magic, disk readback, and a matching SHA-256. The video download receipt needs re-verification after later source and contract edits; the original text writer source snapshot remains unchanged. No generation retry was sent.

Image-reference-to-video uses the captured normal SDK `mediaGenInput.imageToVideo` body and the exact private image task. The one direct attempt's CLI error was `JOURNAL_TRANSITION_INVALID`; that journal-state error masked the helper stage and request-start flags. A fresh owner-bound snapshot read all 15 pages (340 assets) and found no qualifying private generated MP4 after the operation began, so there was no output conversation to inspect and no MP4 bytes to download. This does not prove the server accepted or rejected the request. The intent remains held as `outcome_unknown`; it was not retried, and the direct request count is recorded as unknown. The revised CFFI helper emits a distinct safe setup code/class for session creation and cookie binding. Future `sending` to prepared recovery requires an atomic typed journal proof bound to the exact actor, intent, request digest, prompt hash and profile, with `requestStarted:false` and `responseReceived:false`; older unknown entries without that proof remain held. `video-reconcile` supports both text and image-reference tasks and remains read-only until a unique prompt/history/source-image link is found, then verifies downloaded MP4 bytes and duration. No billing, subscription, public sharing, account-security or payment operation is present.

The later, separate image03-reference task is verified in [its direct/readback receipt](verification/grok-media-video-image03-readback-attempt08-2026-10-06.json): one direct generation HTTP 200, the exact input image linked to task history, and a 227,600-byte private MP4 with matching disk hash and format. This does not resolve or resend either older uncertain intent. The receipt lacks a complete execution-time writer closure for current canonical acceptance, so the business outcome and current-source verification remain separate.

The attachment route is documented in `contracts/grok-attachment-contract-fragment-2026-10-06.json` and `verification/grok-attachment-upload-live-2026-10-06.json`. The API submits the captured single-file multipart shape once, reads matching metadata, and downloads bytes with the current asset-host scope. Normal uploads retain the asset and return an `attachmentRef`; explicit `cleanupTaskAsset:true` deletes only the returned task asset. The current direct-file policy supports the observed 16 MiB threshold, and [the 1 MiB plus one byte exercise](verification/grok-attachment-direct-1mibplus1-live-2026-10-06.json) verified native capture, streamed multipart bytes/hash, HTTP 200, independent byte download and task-only deletion. The 16,777,217-byte single-PUT task separately verified init, storage PUT, complete and [exact downloaded bytes](verification/grok-attachment-presigned-v4-final-file-readback-2026-10-06.json). Multipart/PATCH branches and attachment-to-chat remain separate unfinished requirements.

## Separate Grok Build CLI image trial

On 2026-10-04, Grok Build CLI 1.0.46 produced one generic botanical spa JPEG with a single normal `Yes, send once` approval. The 720×1280 image passed file-signature, ffprobe, and visual checks; safe metadata is in [the CLI receipt](discovery/grok-cli-image-smoke-2026-10-04.json). Use such assets as declared AI backgrounds and show `AI 생성 장면 포함` in the video.

This was an interactive CLI trial, not this repository's consumer-web HTTP client. Its image and video readiness flags remain false. On the tested Windows host, `%USERPROFILE%\\.grok\\bin\\grok.exe` was the updated executable while the earlier PATH entry still resolved to 1.0.4. The CLI trial does not establish unattended batch generation or a Grok Web request contract.

## CLI

Library callers can create `createInMemoryGrokAttachmentRuntime` from `src/runtime.mjs`, import a normally acquired session and verify its owner through `runtime.client`, then call `runtime.attachments.uploadDirect`. The CLI uses this same facade and durable journal. It keeps authentication in process memory and starts no request or browser while constructing the runtime.

```text
node src/cli.mjs models
node src/cli.mjs models --transport chrome --python /path/to/python
node src/cli.mjs status
node src/cli.mjs operations
node src/cli.mjs auth status
node src/cli.mjs auth bootstrap
node src/cli.mjs auth clear
node src/cli.mjs read <operation-id>
node src/cli.mjs submit <operation-id>
node src/cli.mjs model-selection modes --session-stdin
node src/cli.mjs model-selection select --session-stdin
node src/cli.mjs conversation list --session-stdin
node src/cli.mjs conversation delete <conversation-id> --session-stdin --confirm --intent-id <stable-id> --python /path/to/curl-cffi-python
node src/cli.mjs conversation-files list --session-stdin --output json --python /path/to/curl-cffi-python
node src/cli.mjs conversation-files content --session-stdin --python /path/to/curl-cffi-python
node src/cli.mjs conversation-files zip --session-stdin --python /path/to/curl-cffi-python
node src/cli.mjs conversation-files workspace-zip --session-stdin --python /path/to/curl-cffi-python
node src/cli.mjs media intent-prepare --session-stdin --python /path/to/python
node src/cli.mjs media image-submit --session-stdin --confirm --intent-id <uuid> --python /path/to/python
node src/cli.mjs media video-submit --session-stdin --confirm --intent-id <uuid> --python /path/to/python
node src/cli.mjs media video-reconcile --session-stdin --intent-id <uuid> --python /path/to/python
node src/cli.mjs attachment upload --session-stdin --confirm --intent-id <uuid> --python /path/to/curl-cffi-python
node src/cli.mjs attachment upload-presigned --session-stdin --confirm --intent-id <stable-id> --python /path/to/curl-cffi-python
node src/cli.mjs attachment status --session-stdin --reference-key <local-reference-key> --python /path/to/curl-cffi-python
node src/cli.mjs attachment abort --session-stdin --reference-key <local-reference-key> --confirm --intent-id <stable-id> --python /path/to/curl-cffi-python
node src/cli.mjs reconcile <local-operation-id>
node src/cli.mjs journal
```

Media packets are supplied through standard input. `intent-prepare` verifies the current owner and binds only the prompt SHA-256, operation profile and owner digest; it does not persist prompt or credential values. `video-reconcile` is read-only apart from a local verified media artifact and journal reconciliation. For image-reference tasks, the packet supplies the source image ID hash and source prompt hash. The command never resubmits a video generation. A no-wire retry is available only after the typed helper proof is atomically recorded in both journals; unknown or legacy entries remain held.

`attachment upload` accepts a file packet through standard input and uses the current account session. It requires an owner match, an explicit one-shot intent, an absent exact filename marker, and a same-owner `.grok.com` `sso` scope for the asset host. It never sends a chat message. On the live 14-byte test, the raw response audit callback failed after upload, byte readback, and cleanup had completed; the safe receipt records that the response byte count was omitted and was not reconstructed.

The CLI retains normal uploads by default; `--cleanup-task-asset` explicitly enables the verification cleanup. `--output=json` includes the owned business reference, while default summary/audit output excludes IDs and URLs. Output artifacts and audit receipts use an intent-digest suffix rather than overwriting the original test files. If an audit sink fails after business completion, the API returns the observed business state with `auditPersistence.state: "failed"` and `businessRetryAllowed:false`; it does not report a fresh transport failure or repeat the upload.

`verification/grok-attachment-default-retention-live-2026-10-07.json` records a distinct installed-CLI validation of these defaults: a neutral 20-byte file uploaded with HTTP 200, matching metadata and downloaded bytes, a reusable reference returned in memory, and no asset deletion requested. The audit callback stored its receipt successfully. The source snapshot stayed unchanged during execution, and the guarded browser delivered zero writes. This verifies upload and asset retention; attaching the file to a conversation and the larger resumable path still require their own proof. The callback-failure branch has regression coverage only.

The presigned uploader is wired through `runtime.presignedAttachments` when the runtime receives a `signedUrlPolicy` callback. It uses the SDK-described init, single PUT or multipart, complete, status and explicit abort stages. The live account's upload policy must supply `directUploadMaxSizeBytes`, `maxUploadFileSizeBytes`, `multipartSupported`, `multipartConcurrency`, `maxStatusReads` and `statusPollIntervalMs`; source parser defaults do not establish the live account limits. Unknown part writes are held without automatic retry. The current SDK uploader rejects its resumable enum and has no PATCH callsite; those candidates are recorded separately.

`attachment upload-presigned` accepts `sessionBundle`, `expectedIdentity`, `fileName`, `fileMimeType`, exactly one of `fileBytesBase64` or an absolute `filePath` under the user's home, the explicit `policy`, and `allowedSignedUploadOrigins` taken from the observed storage contract. Optional `fileSource` and `sourceConversationId` follow the SDK callsite. Local file input has a 256 MiB CLI resource limit, separate from the supplied provider limit. Signed storage receives only the server-issued URL and required headers, with credentials omitted and redirects rejected. Safe response checkpoints are saved atomically under `~/.nad-scratch/grok-attachment-stage-audits` before journal state changes; IDs, signed URLs and ETags stay in memory. A completed upload returns its reference only with explicit business JSON output. This branch has fixture and runtime coverage; it has not yet passed a live presigned upload and conversation attachment readback.

`model-selection modes` reads the authenticated mode catalog. `model-selection select` accepts a `modeId` in the stdin packet and updates the current process-memory SDK-state adapter. It does not change the browser's selection or an account preference.

Incomplete CLI uploads may retain server-issued upload/asset IDs in the separate private business-reference store `~/.nad-scratch/grok-upload-references`. Its mode-0600 records contain no credentials, signed URLs or ETags; an immutable init checkpoint binds owner scope, intent and issued-ID hashes. Default output exposes a local reference key/path. `attachment status` and `attachment abort` reopen only a validated same-owner reference, and the abort claim is recorded before its one request. Reference-cache failures preserve the observed business result and prohibit repeating the upload. This restart path has regression coverage; live recovery remains to be verified.

`verification/grok-attachment-presigned-upload-live-2026-10-06.json` records one live 16 MiB + 1-byte init: HTTP 200, 1,332 response bytes, no signed PUT and no complete. Its transient SDK bridge stopped, and that pre-recovery runner lost the private handle. Exact filename search found no finalized asset. The presigned run remains incomplete.

`verification/grok-media-video-image03-readback-attempt08-2026-10-06.json` records one successful image-reference video task: direct HTTP 200, exact prompt/input-image history linkage, independent 227,600-byte MP4 download and 6.042-second duration. Older unknown video intents remain held; writer response-ID comparison is unavailable. The completed operation row predates the status-preservation fix and still has null status; the intent and immutable task receipt retain HTTP 200.
`operations` reads the contract inventory without creating a protected session
store or mutation journal. It works on Linux and does not attempt login or
claim that a stored session is authenticated. Protected account and mutation
commands keep their existing provider and owner-verification requirements.

Conversation file read adapters follow the first-party FilesService V2 DTOs:
`conversation-files list`, `content`, and `zip` use the generated list/content/
ZIP methods; `workspace-zip` uses the generated app-workspace download method.
The normal UI switches to that workspace archive only when its owner/live-sandbox
gate is true. The adapters return URL-presence flags and never print signed URL
values. Their request schemas and source hashes are recorded in
`contracts/grok-conversation-files-source-fragment-2026-10-06.json`; first-live
reads and file/ZIP bytes remain separately gated until owner-bound readback.

## Feature completeness checklist

The operation checklist, current UI/source candidates, and unknown or conditional areas live in [`contracts/grok-feature-checklist.v1.json`](contracts/grok-feature-checklist.v1.json). Run the offline checker on Linux:

```text
node scripts/check-features.mjs
node scripts/check-features.mjs --strict
node scripts/check-features.mjs --strict --json
```

The checker reads only repository contracts, source files, scoped receipts and immutable owner proofs. It never loads credentials, logs in, launches a browser or uses the network. `stored_receipt_consistent` means the recorded evidence matches the current contract and code; it is not a fresh provider check. Report mode exits 0 for valid evidence files even when features remain incomplete. Strict mode exits 2 for missing required proof; invalid schemas exit 1. The checklist preserves 18 groups and now has 48 requirements, including separate direct-asset upload and conversation-attachment cases.

Private completion needs an observed contract or separately validated first-party SDK replay, a real dispatcher, and a positive direct replay bound to the exact operation and source hashes. New owner references use `ownerProofPath`, canonical `ownerProofSha256`, and separate stable `ownerScopeSha256`. Refreshing a timestamped owner receipt does not invalidate a valid same-owner archived link. Missing historical proof remains unresolved; code hashes are never restamped onto old executions. Downloads require artifact verification, and audit persistence assertions describe the receipt contents only. Credentials and unrecognized evidence fields are rejected.

Text and regeneration use the native WSS protocol at `wss://grok.com/ws/mgw/?uid=…`. The recorded regeneration proof distinguishes the guarded native `session.create` control from the blocked browser `response.create` frame, then records the direct WSS handshake, the `session.created` acknowledgement, one response frame bound to the newly issued server session, and an independent HTTP history readback. That test moved from six responses to seven while the one user response stayed unchanged. Raw frames, prompt text, connector values, and returned identifiers are not stored. The dedicated WSS receipt does not label this as an HTTP generation call. Later lifecycle edits make the receipt `needs_reverification`; no additional regeneration was sent. The earlier `core-text-smoke` intent remains held as `outcome_unknown` and was not retried. Text response continuation and other lifecycle requirements remain incomplete until separately verified.

`src/grok-text-request-builder.mjs` adds a source-shaped, two-phase text request plan and a journaled submit wrapper. It requires injected native session-control and request-metadata providers; the Castle token must come from the first-party outbound event preparer, with no fallback token. Its default dispatcher sends the source-shaped session control over WSS, waits for the new socket's `session.created` acknowledgement, then builds and sends one validated business envelope using that session ID. Install the pinned helper dependency with `python -m pip install -r scripts/requirements-wss-transport.txt`. Fixture tests cover the two-phase IPC and no-send/unknown-outcome boundaries; this implementation has no live-generation proof, and the captured-frame replay path remains separate.

Conversation reads and deletion use separate evidence paths. Read contracts are derived from first-party SDK operations and replayed directly. The delete action was captured from the normal header menu with the browser request aborted, then replayed once through the owner-bound CLI. Its receipt records the soft-delete endpoint, HTTP 200, one attempt, a complete paginated absence read, and an unchanged digest of every non-target conversation ID. No raw conversation or response IDs are persisted. Workspace contracts are identified as `first_party_bundle_contract` from generated workspace repository functions, with browser write capture explicitly recorded as false. The source-backed direct HTTP replay verified private/shared listing, owner detail reads, create, rename, and delete; the empty delete response is supported by the independent complete-list absence check and restored baseline set.

The earlier sharing partial receipt is preserved in `verification/grok-conversation-sharing-lifecycle-partial-2026-10-06.json`. A separate neutral Fast task verified one HTTP 200 share creation, exact conversation/response membership, `allowIndexing:false`, one HTTP 200 deletion and independent absence. [The reconciliation](verification/one-shot/grok-neutral-fast-sharing-reconcile-revoke-2026-10-06.json) confirms the source UI's distinction: creation returns the public URL alias (`sharing.publicId`), while DELETE uses the different owner record ID (`sharing.shareLinkId`). The client now retains the issued public alias and binds it to the owner record before deletion; normal share/create and revoke contracts are enabled from the actual HTTP facts.

The earlier visual settings receipt lacked a raw-response digest. A [current-source roundtrip](verification/one-shot/grok-settings-current-source-canonical-v3-2026-10-06.json) changed only `autoWrapLongLinesCode`, verified its value by an independent HTTP 200 read, restored the baseline with one further POST, then independently read HTTP 200 again. The apply and restore responses were 837 and 838 bytes with raw-body SHA-256s; both journals reconciled with one attempt each. All other settings and preferences stayed unchanged, and the final complete settings object matched the original. Owner verification and source hashes were recorded before the writes; the settings read/update receipts now pass the offline checker against that execution's code and contracts. Earlier receipts are preserved. `scripts/verify-settings-roundtrip-once.mjs` performs this confirmed roundtrip with credentials supplied only through stdin; `scripts/emit-settings-roundtrip-proof.mjs` checks the saved proof and source before recording canonical evidence.

The offline report remains `incomplete` and sets `currentNetworkVerified: false`. Run `node scripts/check-features.mjs --strict --json` for the current operation counts and source drift. Historical conversation, lifecycle, workspace and media outcomes do not prove later handlers; their receipts retain the specific source or owner-evidence gaps. The checker does not upgrade historical evidence by refreshing hashes alone.

Login is represented as a normal native browser sign-in and session handoff, followed by a protected direct-HTTP owner read. It does not install or claim an HTTP password-login endpoint. The offline login receipt uses `featureId: "auth.login"`, `requirementId: "auth.native-bootstrap"`, `evidenceClass: "native_auth_bootstrap"`, and binds to the exact owner receipt. It records that the provider login and handoff were observed, no challenge bypass was used, and no password was sent to the provider API. Session renewal remains incomplete while its route or applicability is unknown; the checker does not infer “not applicable” from missing source or receipts.

Receipts are local records, not signed attestations. A reviewer should compare them with the original approved live evidence before using them to claim provider behavior. Receipt metadata never includes credentials, cookies, tokens, signed URL values, prompts, or raw request/response bodies.

Each receipt is one JSON file in `verification/grok-feature-live-receipts/`:

```json
{
  "schemaVersion": 1,
  "serviceId": "grok-web",
  "featureId": "<checklist feature id>",
  "requirementId": "<checklist requirement id>",
  "operationId": "<installed contract operation id>",
  "observedAt": "<ISO-8601 timestamp>",
  "recordedAt": "<ISO-8601 timestamp>",
  "execution": "direct_http_client",
  "liveReplay": true,
  "liveReplayRecorded": true,
  "mocked": false,
  "ownerVerified": true,
  "sameAuthenticatedOwner": true,
  "evidenceScope": "same_authenticated_owner",
  "ownerIdentityReceiptSha256": "<canonical current auth.owner.read receipt SHA-256>",
  "httpStatus": 200,
  "responseMime": "application/json",
  "responseBytes": 123,
  "capturedOperationSha256": "<canonical operation JSON SHA-256>",
  "requestDigest": "<request SHA-256>",
  "responseDigest": "<response SHA-256>",
  "handlerId": "client.read",
  "dispatchBinding": {
    "handlerId": "client.read",
    "operationId": "<installed contract operation id>",
    "operationKind": "read",
    "mode": "validated_registry_generic"
  },
  "readinessAssertions": { "handlerDispatchVerified": true, "ownerScopeBound": true },
  "persistenceAssertions": { "credentialValuesPersisted": false, "cookiesPersisted": false, "tokensPersisted": false },
  "codeSha256": {
    "src/client.mjs": "<current SHA-256>",
    "src/transport.mjs": "<current SHA-256>"
  }
}
```

Use the checklist binding's exact `handlerId` and source files; set `dispatchBinding.operationKind` to the installed operation kind. The `auth.owner.read` identity receipt omits `ownerIdentityReceiptSha256` to avoid self-reference; other private receipts name its canonical SHA-256. Add `artifactVerified: true` for downloads. Values in angle brackets are placeholders and must be replaced with measured evidence.

The native login receipt uses `operationId: "auth.native-bootstrap"`, `execution: "native_browser_session_handoff"`, and `evidenceClass: "native_auth_bootstrap"`. It must include `providerLoginObserved: true`, `nativeBrowserProfile: true`, `sessionHandoffVerified: true`, `sameAuthenticatedOwner: true`, `ownerVerified: true`, `challengeBypassUsed: false`, `passwordSubmittedToProviderApi: false`, `receiptContainsCredentialValues: false`, the exact `ownerIdentityReceiptSha256`, `observedAt`, `recordedAt`, and current hashes for `src/bootstrap-receive.mjs`, `src/cli.mjs`, `src/client.mjs`, `src/protected-json-store.mjs`, and `src/session.mjs`. The normal provider password and any login codes stay in the browser interaction; this receipt records only the safe outcome metadata.

The existing `public.models` 200 receipt can complete only anonymous public model metadata. It cannot complete identity, chat, history, uploads, settings, image/video generation, polling, or private downloads. Login requires the native browser/handoff receipt linked to a successful protected owner read. Public source fields remain candidates until captured from the current UI and independently replayed.

The default `models` command uses Node's built-in fetch. The optional Chrome
compatible transport is limited to the existing public `POST /rest/models`
operation. It uses pinned `curl-cffi==0.16.3` with the Chrome 150 TLS/HTTP2
profile and explicit Linux Chrome 150 User-Agent/client hints. Install that
dependency with `python -m pip install -r scripts/requirements-chrome-transport.txt`,
then select the interpreter with `--python` or `GROK_CHROME_PYTHON`. The helper
uses TLS verification, disables environment proxy inheritance, follows no
redirects, retries nothing, accepts only the exact public model request, and
starts a fresh empty cookie jar for one request while discarding response
cookies. It never imports Playwright or accesses a browser profile. Its headers
are a declared Linux compatibility profile, not a captured browser request.
The profile does not enable login or private Grok operations; it does not
produce the `castleRequestToken` required by the sign-in page.

JSON inputs for `read` and `submit` are read from standard input. Never put cookies, tokens, passwords, prompts or response bodies in command arguments. `auth bootstrap` accepts exactly one short-lived encrypted handoff. It creates an ephemeral RSA-3072 key pair, receives one bounded line, decrypts the AES-256-GCM envelope in memory, and stores a fresh service-scoped bundle with Windows DPAPI CurrentUser in `%LOCALAPPDATA%\\grok-web-xhr-client`. The authenticated data binds the handoff run ID, service, and `https://grok.com` origin; the receiver expires after five minutes and a failed or consumed envelope cannot be reused in a new run.

Bootstrap derives its cookie/header name allowlist only from ready, browser-captured, session-authenticated operation contracts. It rejects credentials outside those bindings, broad cookie domains, challenge/bot-management cookies, and unresolved security boundaries. The encrypted session handoff is separate from signing in with the provider. Import alone does not verify account ownership; the captured `auth.owner.read` operation must independently match the expected account before private writes, which still require a ready submit contract, caller confirmation, and a one-shot intent ID.

The file-backed DPAPI credential provider is Windows-only. Linux uses process-memory credentials through the main client and runtime factories; it does not require Windows or a remote PC. The Linux journal persists only nonsecret operation state and digests. Journal locks prevent two workers from claiming the same unresolved intent. The authenticated Chrome adapter accepts only installed operation contracts and their observed credential bindings, without importing Playwright or reading a browser profile. Confirmed challenges remain held, redirects are not followed, and mutations are never retried automatically. Conversation/history reads can recover an exact owned task in memory; an unknown write remains held until that recovery proves its result.

`client.renewSession({expectedIdentity, acquireSession})` accepts a fresh normal session from the caller's issuer, verifies that account independently over HTTP, and atomically replaces credentials only for the same previously verified owner. A failed or wrong-account handoff preserves the old session. Concurrent imports cannot be overwritten by an older refresh. The credential issuer remains separate from the data client, and this handoff does not establish server-side authentication-cookie rotation or recovery of an expired server session.

The CLI exposes the same handoff as `session-refresh --session-stdin --python <interpreter>`. Its stdin packet contains `sessionBundle`, `replacementSessionBundle`, and `expectedIdentity`; both bundles use the normal service-scoped session schema. This one-shot command first verifies the initial live account, then verifies the replacement. An already expired client in a reusable process uses `renewSession` with its existing owner binding. Output contains only verification metadata, never credential values. The live CLI handoff receipt is `verification/grok-session-client-handoff-live-2026-10-06.json`; its cookie-rotation and expired-server-recovery flags remain false.

## Checks

```text
npm test
npm run lint
```

Tests cover contract/input validation, encoded path traversal, the public model request shape and response parser, the Chrome-compatible helper's public-origin/cookie boundary, session-owner gating, uncertain mutation holds, stream chunk boundaries, media signatures, source-shaped attachment multipart bytes, unique-marker preflight, task-asset cleanup, and the owner-scoped attachment byte downloader.
