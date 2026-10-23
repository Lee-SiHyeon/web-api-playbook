# Flow HTTP generation cross-review — 2026-10-05

This note consolidates the independent consultations and read-only checks. It records their evidence boundaries; it does not treat a model opinion as server evidence. Raw prompts and complete external conversations remain outside Git.

## Consultation provenance

| Reviewer | Verifiable setup | Scope and limitation |
| --- | --- | --- |
| Claude Code | Configured first-party CLI, `claude-opus-5-5`; initial diagnosis and a narrow static parser review | One intermediate response was reported as safety-clipped and is excluded. The first diagnosis assigned excessive confidence to missing input as the sole cause; later review qualified that claim. No live site calls were made by these reviews. |
| Antigravity | Configured CLI, `gemini-3.8-flash-medium`; jobs `staffer-muv23kty-788477fc` and `staffer-muv2hamj-05ddb2f8` | A companion unexpectedly edited `protocol.mjs` despite a no-edit instruction. The owner reviewed the scoped final diff, found no broader changes, and ran the synthetic/offline suite. Claims that infer a historical ErrorInfo tuple layout from the discarded response are excluded. |
| Grok | Normal web conversation; an answer is retained outside Git | The exact model was not exposed. The answer withdrew the earlier claim that the broad RPC error proves a reCAPTCHA or fingerprint cause. |

None of the consultations establishes that a valid SDK-created input would be sufficient when an ordinary HTTP client sends the create request. Do not carry forward numerical causal probabilities from an early opinion.

A later live experiment now verifies that specific consumer path: one Node HTTP create with a fresh normal UI SDK input succeeded, was matched by exact-request owner readback, completed and downloaded. The browser's consumer request was canceled and its tab closed before Node sent. See [the actual generation receipt](sdk-input-http-create-2026-10-05.json) and [the bounded diagnosis](sdk-input-http-create-2026-10-05.md). This is live server evidence beyond the consultations, with `wholeOperationPureHttp:false` because input production still used the browser SDK.

## Findings supported by checks

The bounded first-party source trace identifies the normal page producer as `enterprise.execute(configuredKey, {action: "VIDEO_GENERATION"})`, called through `An` → `q7a` → `k5a` / `YhhmEf`. This is an observed web-SDK path. No ordinary HTTP issuance contract appeared in the inspected preloads or reviewed public documentation. That leaves a **missing verified pure-HTTP issuer as an implementation blocker**; the bounded search does not prove that no private or unobserved path exists. See the [source trace](http-issuer-source-trace-2026-10-05.json).

A protected document fetch returned HTTP 200. In the final read-only pass at 10:04:26–10:04:45Z, five subsequent read RPCs used the `at` and `f.sid` pair from that same document sequence; all five returned HTTP 200. The existing media list remained at 36 and the credit balance at 1,038. The generation guard returned `FLOW_GENERATION_UNRESOLVED`, so this check made zero create requests and zero downloads. It proves document-pair provenance for those reads only; it says nothing about write acceptance. See the [document-provenance receipt](document-provenance-live-2026-10-05.json).

An offline-only form round trip preserved nested JSON and a synthetic prompt containing Unicode, a newline, and reserved form characters. The two form fields stayed unique. Removing the optional input removed the final context element and changed its length from 11 to 10; the field value was not the only structural difference. The check made zero network requests and does not establish server acceptance. See the [serialization receipt](form-roundtrip-offline-2026-10-05.json).

## Causal and parser limits

The input-omitted probe therefore cannot isolate input *value* as the cause of the denial: the request also had a shorter context array. A later input-omitted probe used the observed Flow-root Referer and received the same broad denial at `2026-10-05T09:08:00Z`; that probe did not test a normal input-bearing HTTP request. Immediate, 15-second, and later owner reads found no scene with that request UUID; media count and credits stayed at 36 and 1,038 in those snapshots. The job was initially held. At `11:51:13.553Z`, an exact-request negative owner read approximately 9,792 seconds after the attempt, combined with the explicit original error and no acknowledgement/media ID, supported manually marking the same journal rejected and releasing its fence. The displayed credits then differed (1,050), so that value was excluded from non-creation evidence. There was no resend. The later fresh-input Node create succeeded without copied browser identity headers. This rejects a categorical Node-transport failure explanation, while the shorter omission context remains a causal confound.

The prior safe diagnostic records HTTP 200, a numeric value `7`, a broad `PUBLIC_ERROR_UNUSUAL_ACTIVITY` label, and a 228-byte response. The raw body was not retained. Therefore the exact error-frame tuple, `ErrorInfo` presence or layout, message, domain, and metadata are **unknown**. In particular, do not infer an `entry[5]` structure from a model response, the later synthetic fixture, or the label alone. The integer has not been shown to occupy a confirmed canonical gRPC status field, and the broad label does not identify CAPTCHA, fingerprinting, or any other private server rule.

The parser review removed untyped “first uppercase string” selection. A candidate `ErrorInfo` reason remains diagnostic only and is not an authoritative server code while its schema is unverified; metadata values are not recorded. Duplicate matching RPC frames are treated as ambiguous. Tests for the candidate shape are synthetic, not a replay of the lost response. The recorded numeric `7` is only an observed number; its position has not been confirmed as a canonical gRPC status field. The generation transport wraps a parsed RPC error as uncertain and holds the affected job pending independent same-request evidence. This describes the earlier probe before manual reconciliation, not its current state. No parser result alone establishes whether a write took effect or authorizes fence release or retry.

The Flow regression suite passed 89/89, but that includes synthetic parser fixtures, not a capture of the lost response. The consultation and same-document review made no create or download. The subsequent SDK-assisted HTTP experiment was a new, separately journaled request: one POST and one successful download, with no retries. It establishes that the HTTP consumer can work; it still does not meet the entire pure-HTTP issuance criterion. The original held probe was manually reconciled as described above; parser errors alone still do not authorize automatic fence release.

The subsequent journal reliability fix recognizes SDK diagnostic provenance without authorizing it in the production writer. Its four added regressions cover completed-job scanning, uncertain-job blocking, pre-intent unknown-mode rejection and production rejection of SDK mode. The suite then passed 93/93. A read-only scan of the actual completed diagnostic found no unresolved project job or generation fence; the [latest receipt](sdk-input-http-create-2026-10-05.json) records that check.

## Receipts

- [Bounded producer and issuer search](http-generation-source-trace-2026-10-05.json)
- [Same-document read provenance](document-provenance-live-2026-10-05.json)
- [Offline form round trip and omission delta](form-roundtrip-offline-2026-10-05.json)
- [Actual fresh-SDK-input Node HTTP create, readback and download](sdk-input-http-create-2026-10-05.json)
- [Playbook consultation and safety summary](https://github.com/Lee-SiHyeon/web-api-playbook/blob/main/verification/google-flow-multi-model-debugging-2026-10-05.json)
