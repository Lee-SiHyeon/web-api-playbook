# ChatGPT web XHR client

This is a contract-driven Node client for the ChatGPT website. It does not substitute the OpenAI API. The protected session, transport, journal, streaming parser, and media validators are generic infrastructure. **No ChatGPT text, history, image, or video endpoint has been observed or implemented yet.** The contract registry is intentionally empty, so each service operation returns `CONTRACT_NOT_CAPTURED` until a first-party browser request and its response are captured and reviewed.

The public unauthenticated document probe is recorded in [`discovery/public-document-probe-2026-10-03.json`](discovery/public-document-probe-2026-10-03.json). It returned HTTP 403 Cloudflare HTML. This establishes neither a protected session result nor an XHR contract. No challenge, CAPTCHA, or token-solving flow is implemented.

## Current evidence

| Capability | Captured | Operation-specific client | Credential propagated | Live replay |
| --- | --- | --- | --- | --- |
| Text send/stream | false | false | false | false |
| Conversation/history read | false | false | false | false |
| Image upload/read | false | false | false | false |
| Video upload/read | false | false | false | false |

`genericInfrastructureReady` means only that the reusable contract validator, HTTP transport, DPAPI handoff, mutation journal, SSE parser, and media checks exist. It does not mean any ChatGPT operation is available. Offline tests use synthetic contracts and establish request-safety behavior only.

## Requirements and commands

Node.js 24 or later is required. There are no third-party npm dependencies.

```powershell
npm run lint
npm test
npm run status
npm run contracts
npm run bootstrap
```

`status` reports whether the Windows DPAPI provider and stored bundle exist. It deliberately reports `authenticated: false` until a protected HTTP operation has verified the session. The bootstrap command accepts one fresh encrypted session bundle and writes it to Windows DPAPI CurrentUser storage. It never accepts a plaintext-cookie command argument or prints the decrypted bundle.

The earlier native store self-test in `discovery/native-store-selftest-2026-10-04.json` verified a disposable synthetic DPAPI write, exact readback, and deletion. Later Node-launched status checks intermittently exceeded the previous 60-second helper timeout. Native helper calls now use a 20-second bound and distinguish timeouts, nonzero helper exits, and process launch failures. Four process regressions verify unused-stdin EOF, input-pipe EOF, nonzero exit handling, and bounded termination. The PowerShell ACL enforcement is unchanged.

The latest disposable Windows integration check timed out on its first status call at 20 seconds, before a DPAPI write. Its safe receipt is [`discovery/native-helper-probe-2026-10-04.json`](discovery/native-helper-probe-2026-10-04.json); current native integration remains unverified. The Windows disposable DPAPI/ACL test is opt-in through `CHATGPT_NATIVE_STORE_INTEGRATION=1`; the default test suite skips it. When status returns `CREDENTIAL_STORE_FAILED` with `providerCause: ETIMEDOUT`, stored credential presence is unknown, not absent. Session-dependent requests remain unavailable until the provider and a protected HTTP read complete successfully.

The bundle accepted by the current receiver is:

```json
{
  "version": 1,
  "service": "chatgpt-web",
  "origin": "https://chatgpt.com",
  "capturedAt": "<fresh ISO timestamp>",
  "cookies": [
    {
      "name": "<observed cookie name>",
      "value": "<in-memory secret>",
      "domain": "chatgpt.com",
      "path": "/",
      "secure": true,
      "httpOnly": true
    }
  ]
}
```

Cookies are restricted to the exact ChatGPT website origin, scoped by their observed domain/path/expiry, and kept in memory during a request. Known challenge and bot-management cookie names are rejected. The client does not replay cookies to upload or media hosts, follow redirects, override browser identity headers, solve challenges, or derive tokens.

## Contract shape

`contracts/registry.json` starts with no operations. A captured operation must record its actual method, origin, path template, request encoding and fields, expected status and MIME, response kind, bounded size, and safe evidence references. Only origins observed for that operation may be added. Cookie authentication is attached only to `https://chatgpt.com`; additional observed hosts receive no ChatGPT cookies.

The contract executor accepts observed JSON/form templates with named business inputs. It rejects browser identity headers, cookies, authorization headers, CAPTCHA/challenge/sentinel fields, unobserved operations, unlisted origins, and automatic redirects. It does not infer endpoints or payloads from a product name.

## Streaming, writes, and media

SSE is parsed only when an observed operation declares `text/event-stream`. The parser supports event, id, retry, comments, multi-line data, UTF-8 chunks, and bounded line/event sizes. It preserves event data without assuming a ChatGPT-specific terminal marker or JSON schema.

Every captured mutation is journaled before network dispatch. The journal stores an operation ID, request/target hashes, timestamps, and safe response metadata; it never stores prompts, response text, cookies, session IDs, or raw media. A timeout, disconnect, malformed response, or ambiguous result leaves the operation held. The client never retries a mutation automatically. The programmatic reconciliation hook uses a separately captured read operation; absence clears a hold only when that contract proves the readback is authoritative.

The exported journal mutators are low-level trusted local maintenance interfaces, and their state changes alone do not verify a remote result. Service workflows must use `ChatGPTWebClient.reconcileMutation()` for captured readback; there are no enabled mutation contracts in this checkpoint.

An exclusive per-target lock contains only a journal ID, operation ID, target hash, PID, and lease timestamp. A lock older than five minutes is removable only when its PID is confirmed exited and the associated journal is absent or still `intent_logged`. Stale-lock inspection is serialized with a separate atomically published recovery sidecar; each process removes only the sidecar with its own journal ID and PID. If a process dies during recovery, that sidecar stays held for manual review rather than being guessed safe to remove. If there is an `intent_logged` record, the next attempt releases the stale operation lock and remains held. After independently confirming that process exited, an operator may call `MutationJournal.reconcilePreDispatchCrash(journalId, { processExited: true })`; this is accepted only for that dead PID and `intent_logged`, which is written before dispatch. A `dispatch_started`, `outcome_unknown`, malformed, recent, or live-PID lock stays held and must use authoritative captured readback reconciliation. No retry is issued by recovery, and the same journaled request remains deduplicated.

Media upload contracts must specify their observed multipart field or binary body, accepted MIME types, and byte limit. The client checks file signatures before upload. Media downloads must use a captured operation and validate status, MIME, declared length, byte limit, and file signature before atomic output. Supported signatures include PNG, JPEG, GIF, WebP, AVIF, PDF, MP4/ISO-BMFF, WebM, Ogg, WAV, and MP3. These validators do not establish that ChatGPT image or video operations exist.

## Execution modes and limits

Routine requests use Node's native `fetch`; no browser engine is imported. Session acquisition is a separate, one-time encrypted handoff from the authorized first-party browser session. This does not make login renewal browserless or claim that session propagation has been live-verified. There is no automatic re-login or retry policy.

The CLI commands `read`, `stream`, `send`, `upload`, and `download` require an operation ID present in an observed contract registry. At this revision those commands stop with `CONTRACT_NOT_CAPTURED`. Live login, text/history reads, message sends, image/video upload/download, and ChatGPT SSE semantics remain unverified.

The CLI emits response metadata only. JSON/text bodies, SSE event data and IDs, remote filenames, and local output paths are not printed or journaled. In-process callers may inspect response bodies in memory. CLI body output remains disabled until a captured operation has an explicit reviewed typed response selector.
