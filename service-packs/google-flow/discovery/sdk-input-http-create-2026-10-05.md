# Fresh SDK input, ordinary Node HTTP create — 2026-10-05

The generation request, completion reads, and download succeeded over ordinary Node HTTP. A normal Flow page SDK produced the fresh input, so the whole operation is still browser dependent. This experiment verifies the consumer POST with a valid newly produced input; it does not implement a pure-HTTP issuer.

## Actual bounded experiment

The normal UI used the previously observed Omni 1.1 Flash contract: `abra_t2v_8s`, 16:9, 720p, eight seconds, one output. A request-stage `Fetch` guard intercepted only `YhhmEf`. The browser request was canceled before send; matching `Network.loadingFailed` reported cancellation and no create response was observed. The task-owned tab was closed before the encrypted handoff triggered Node's single create. Blocking every Flow batch RPC during an earlier diagnostic setup also blocked normal preflight processing; that setup was abandoned with zero Node creates. Keep the guard scoped to the actual consumer operation.

The scoped captured Cookie header and the cookies used for protected owner reads were compared as an unordered multiset in memory. They matched: 21 cookies. Scope, expiry, path and host-only metadata were validated. Preflight reads rotated cookies, so the diagnostic restored the captured scoped bundle for the actual captured POST and its readback. It did not copy or fabricate User-Agent or client-hint headers. The original first-party query/form and business payload were used once. The one-time input and raw request remained in memory or a one-use encrypted handoff, and were cleared after use; they are absent from the receipt.

At `2026-10-05T12:23:39.546Z`, Node sent one `YhhmEf` POST with an input age of 8,419 milliseconds. HTTP 200 returned JSON, 1,462 bytes, one matching RPC frame, an acknowledgement and a new media ID. No public error literal appeared. At `12:23:55.334Z`, protected owner readback matched the exact new request UUID and showed project media increasing from 36 to 37.

The maintained client waited for that media's `jwpduf` state `3` with a positive byte count, observed at `12:24:30.064Z`, then obtained the media link and completed the direct HTTP download. The journal reached `downloaded` at `12:24:32.884Z`. There was no resend. The accepted native MP4 was 4,172,459 bytes; full decoding passed, and `ffprobe` verified H.264/AAC, 1280×720, 8.000 seconds.

The new native clip was converted locally to 854×480, 8.000 seconds, 24 fps, H.264/AAC, 1,598,075 bytes. This derivative was fully decoded (192 frames). `blackdetect` with 0.5-second minimum and pixel threshold 0.10 found no spans; `freezedetect` with -50 dB and one-second minimum found no spans. These checks apply to this new HTTP-created clip, not the earlier UI-created file. The [sanitized receipt](sdk-input-http-create-2026-10-05.json) contains both artifact hashes; actual video files remain outside Git.

## What the result isolates

Ordinary Node HTTP can submit a captured consumer request with a fresh normal SDK input and complete the job. Node transport, omitted browser identity headers, and closing the task-owned producer tab therefore did not prevent acceptance in this observed configuration. Other existing Chrome tabs and the browser process were not closed; this experiment does not establish that every browser runtime was absent.

The earlier input-omitted requests received a broad unusual-activity error. Omission also shortened the context from 11 to 10 elements. This comparison does not isolate the token value as the sole cause, identify a private server rule, or establish that every backend or model behaves alike. The bounded public source inspection found `enterprise.execute(..., {action: "VIDEO_GENERATION"})` as the input producer; the maintained app still has no verified ordinary HTTP input issuer. Its normal pure-HTTP generation mode correctly stops before intent/POST with `FLOW_HTTP_CAPTCHA_ISSUER_UNAVAILABLE`. Do not label this diagnostic as `pure_http`, wire browser capture into that mode, or treat a REST assessment consumer as an issuer.

## Earlier held probe and authentication recovery

The 09:08 input-omitted probe was manually reconciled at `11:51:13.553Z`: an exact-request negative owner read about 9,792 seconds later was combined with the original explicit error, absent acknowledgement and absent media ID. The same journal was marked `rejected` and its fence released. The displayed credit value had changed from 1,038 to 1,050, so it was explicitly excluded as evidence of non-creation. No earlier request was resent, and this manual decision is not an automatic RPC-error release rule.

Before this experiment, the stored session returned HTTP 200 HTML without `SNlM0e` and without a usable protected-read context. A fresh service-scoped first-party cookie handoff into Windows DPAPI restored all required document fields and a protected project read. A 200 page is insufficient auth evidence, and missing `SNlM0e` alone does not prove logout. Credentials and SDK inputs were not printed, placed in command arguments, or committed.

## Post-download journal reliability fix

The final scan exposed a local schema defect: the diagnostic wrote `inputMode: browser_sdk_diagnostic`, but the loader accepted only the production and absent-probe modes. Even this completed diagnostic therefore made the next unresolved-job scan throw. The journal now recognizes that explicit provenance, and unknown modes are rejected before creating an intent or fence. A completed diagnostic does not block the next scan; an uncertain diagnostic still blocks another create. The production HTTP writer/provider guards still reject SDK diagnostic mode and no input issuer was added. All 93 regression tests passed. A read-only check of the actual runtime journal at `12:45:32.863Z` verified `downloaded`, original diagnostic provenance, no unresolved project job, and no remaining generation fence, with zero new creates/downloads.
