# Gemini consumer web read client

This package reads the signed-in Gemini consumer website through the observed HTTP/XHR contract. It does not use the Gemini Developer API. Its allowlist contains only conversation-list RPC `MaZiqc` and conversation-read RPC `hNvQHb`; it has no prompt, image, video, or generation operation.

## Current evidence: 2026-10-05

The [protected HTTP verifier](discovery/read-replay-2026-10-05.json) passed: 24 conversation-list rows and the current test conversation were read without recurring browser use. The original prompt and the expected reply were both independently found in the HTTP readback. This is one captured page of the list, not full history coverage. Synthetic contract tests pass 11/11.

A normal browser text canary succeeded through `StreamGenerate` with HTTP 200. The [generation assessment](discovery/generation-canary-2026-10-05.json) keeps that observation separate from the read client: no direct HTTP generation was attempted. Its current caller code binds a BotGuard snapshot attestation to the text, nonce and conversation context in payload slot 3; slot 4 contains a random nonce. A verified browserless attestation issuer is not available. These values are not stored, reused or forged. Image/video generation is unimplemented.

Run every Node process that imports this client with `--max-http-header-size=65536`. The observed Gemini `/app` document response exceeds Node's default incoming-header limit and otherwise fails with `UND_ERR_HEADERS_OVERFLOW` before the client can inspect the response. This applies to importing applications too, not only the package's verifier. The package scripts below include the required flag.

The client uses the protected Windows DPAPI credential `google-gemini-session-v1`, scoped to `https://gemini.google.com`. The one-time bootstrap and live verifier are separate tools. Routine reads fetch `/app` for the current `SNlM0e`, `FdrFJe`, and `cfb2h` values, then keep them in memory while building the request. Only observed Gemini-origin cookie rotations are written back to the protected store.

## Client interface

```js
import { GeminiWebClient } from './src/client.mjs';

const client = new GeminiWebClient();
await client.start();
const conversations = await client.listConversations();
const conversation = await client.readConversation(conversations[0].id);
```

`listConversations()` returns at most the 24 rows requested by the captured `MaZiqc` contract as `{ id, title }` objects. No pagination is implemented. `readConversation(id)` fetches a fresh list first and refuses IDs absent from it, then returns `{ id, title, rows }` from the observed `hNvQHb` response. The message rows remain opaque because only their count and enclosing response shape were captured. Titles and rows are returned in memory; the client does not log or persist them.

`client.evidence` contains only safe request metadata: operation, method, origin/path, query-key names, status, MIME, byte count, and check time. It excludes cookies, document tokens, titles, and response bodies.

## Captured request boundary

The `/app` document supplies `SNlM0e`, `FdrFJe`, and `cfb2h`. Both read RPCs use `POST /_/BardChatUi/data/batchexecute`, the observed query keys `rpcids`, `source-path`, `bl`, `f.sid`, `hl`, `_reqid`, and `rt`, form fields `f.req` and `at`, and the captured origin, root referer, and `X-Same-Domain: 1` headers. Responses must be HTTP 200 `application/json` and contain the expected `wrb.fr` RPC result.

The response parser preserves list titles and opaque conversation rows for the caller. Error messages and evidence never include raw response text. The local synthetic tests use fake cookies and fake responses only; they do not contact Gemini or read the DPAPI store.

Run the local contract tests with:

```powershell
npm test
```

For an external script that imports this client, launch Node with the same option:

```powershell
node --max-http-header-size=65536 .\my-gemini-reader.mjs
```

The live verifier is maintained separately in `src/verify.mjs` and uses the current protected session. A successful test run proves request construction and safeguards only; it does not establish live authentication or current account access.

```powershell
node src/bootstrap-serve.mjs
npm run verify -- --receipt .runtime\read-check.json
```

The bootstrap is a one-use loopback receiver for an RSA-OAEP-SHA256/AES-256-GCM encrypted service-cookie envelope. It writes the scoped bundle to Windows CurrentUser DPAPI and closes; it does not log or save plaintext cookies. Only use the current logged-in first-party session. An explicit `--canary-readback` verifier option additionally checks the known benign October 5 test prompt/reply in the newest conversation and makes no generation request.
