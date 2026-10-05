# Google Flow: session propagation and the generation boundary

Checked 2026-10-05 on the owner's Windows runner. The maintained consumer client is in affiliate-content-operations/apps/google-flow-api. These observations use the Flow web project and existing web credits; they are not Gemini Developer API or Vertex AI evidence.

## Login visible in Chrome, HTTP redirected to Google sign-in

A narrow 16-name Google cookie capture omitted the host-only Flow cookies OSID and __Secure-OSID. A direct GET of the observed /project/{projectId} returned HTTP 302 to accounts.google.com/ServiceLogin. The normal browser document returned 200 and contained SNlM0e, FdrFJe and cfb2h.

The browser actually sent 21 scoped cookies, including those two Flow host cookies. After an encrypted first-party handoff into Windows DPAPI, a separate Node process parsed all three document fields and replayed protected project RPC Zzl0ze, returning 35 media records. This establishes current session propagation and that read operation. It does not establish independent password login or expired-session recovery.

Preserve the cookie array's domain, hostOnly, path, secure, session and expiry metadata. Do not use a fixed Google authentication-name allowlist that drops service-host cookies. Reject out-of-scope cookies and identical scope duplicates; keep the same name at distinct valid scopes. Chrome CDP's expires:-1 with session:true is a session-cookie sentinel, not an expired persistent cookie. Never send the Flow bundle to accounts.google.com or a media CDN by following a redirect.

Record 302 as a redacted redirect class, status and MIME. Distinguish account sign-in, same-origin routing and unknown redirects; omit query values, cookies and document tokens. A 200 document missing SNlM0e is a separate parser/input failure and does not by itself establish logout.

## Current eight-second consumer generation contract

A normal Omni 1.1 Flash setup selected one 720p, eight-second, 16:9 clip. The observed create operation is:

- POST https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute
- rpcids: YhhmEf; URL-encoded form keys f.req and at
- Model key abra_t2v_8s; aspect value 2; project context and per-job client identifiers
- A fresh first-party reCAPTCHA Enterprise SDK input in the generation context

The observed consumer setup offers 360p or 720p. A 480p artifact requires a separately verified local conversion of a completed native clip.

Google documents the normal website execute() token flow and one-use, two-minute tokens in [Create assessments for websites](https://docs.cloud.google.com/recaptcha/docs/create-assessment-website). An assessment endpoint consumes that token; it is not a replacement issuer. No verified pure-HTTP issuer was found for Flow. Do not replay internal challenge requests, fabricate a token, substitute another service's key, or treat the SDK capture as engine-free generation.

A direct HTTP trace of the three observed public preloads (`_b`, `wO1vlb`, `XRV0Af`) located the real producer in lazy module `wO1vlb`: `_.JS.An("VIDEO_GENERATION")` waits for `enterprise.execute()`, and `q7a` serializes the result through `k5a/YhhmEf`. No separate ordinary HTTP issuer was found in those assets and the reviewed official references. This bounded trace does not establish that every private internal path is absent. The sanitized source receipt is `discovery/http-issuer-source-trace-2026-10-05.json` in the maintained app.

Further read-only branch tracing found that the execute wrapper flag changes action handling rather than selecting an HTTP issuer. The current owner document has the configured key (boolean only was recorded), so the absent-key branch is inactive. Text, reference, frame, edit, extend and upsample callers share the SDK result. That earlier read-only trace did not itself send an omission probe; the later, separately authorized missing-input diagnostic is recorded below. The observed experimental descriptor IJhj9c is registry evidence without a captured callable request. Google documents [API/IoT Express keys](https://docs.cloud.google.com/recaptcha/docs/keys), but that separate service-owned key type is not evidenced as a substitute for Flow’s web action token.

Two lazy asset URLs in the initial source receipt contained a manually transcribed extra character. Parse the current protected document’s exact public preload hrefs rather than rebuilding or copying minified paths. After correction, all three modules replayed as HTTP 200 JavaScript with SHA-256 recorded. Preserve correction history; a malformed evidence URL is not a frontend build change.

The maintained HTTP generation writer and memory-only provider interface require a pure-HTTP first-party issuer, the `VIDEO_GENERATION` action, a fresh one-time issuance window, and matching project/prompt/options/client identifiers. No such issuer is configured or live-verified, so the normal HTTP CLI exits with `FLOW_HTTP_CAPTCHA_ISSUER_UNAVAILABLE` before intent, POST, or file creation. A provider declaration alone is not evidence that issuance works. Project reservation and intent are atomic; ambiguous responses retain the fence, and independent owner reads must reconcile the same job before another write. An unrelated local MP4 must not unlock an unknown generation.

Pure-HTTP generation remains unverified. Keep `captured`, `client_exists`, and `live_replay` separate. A UI create proves the consumer page can generate, but it does not prove that Node can acquire the page's SDK input or that an HTTP-only generation client works.

## Live create, processing, readback, and download (2026-10-05)

The user explicitly authorized one real generation through the normal Flow UI to inspect option selection, prompt submission, server processing, completion, and the returned media. The page was set to Omni 1.1 Flash, one 720p, eight-second, 16:9 clip, with the red origami boat pond prompt. The page's reCAPTCHA Enterprise SDK inputs were present; observed `reload` and `clr` calls returned HTTP 200. One `YhhmEf` create was sent at `2026-10-05T07:57:51.238Z`; it returned a media record and `CAE` acknowledgement. The displayed cost was 12 credits.

The server lifecycle was observed through `jwpduf`: state `6` → `2` → `3`. State `3` was observed at `07:58:30.863Z`, 39.625 seconds after the create. The media URL became available through `as29s` at `07:58:34.383Z`. Protected project readback matched the exact scene request, showed 36 media records, and showed 1,038 credits remaining (from 1,050 before the create). No further create was sent.

During reconciliation, a request-ID mapping bug was identified: the generation request UUID is at `freq[2][0]`, and the matching scene stores it at `scene[3][5]`. An earlier client mapping read `freq[0][0][4]`, which is a different UUID and can produce a false mismatch. The new UI run's exact scene match was verified with the corrected fields. Older journal entries without a recorded `requestId` remain fail-closed and require owner/readback review; do not infer their match from another UUID.

The completed native MP4 was downloaded with the maintained direct-HTTP client: 4,385,072 bytes. The helper verified a successful response, an accepted video MIME (`video/mp4` or `application/octet-stream`), the MP4 `ftyp` signature, and file length; it did not record the exact HTTP status or which accepted MIME was returned. `ffprobe` verified H.264/AAC, 1280×720, and 8.000 seconds. A local FFmpeg conversion produced `flow-origami-8s-480p.mp4`: H.264/AAC, 854×480, 8.000 seconds, 1,682,551 bytes. The 480p file is a local derivative; Flow generated the 720p source. The artifact is retained outside this repository. The Flow page's own download click was attempted, but a tab identifier change followed by snapshot timeouts prevented verification of that UI download flow; the completed download claim here is based on the independent HTTP helper. The sanitized run receipt is [google-flow-live-generation-2026-10-05.json](../verification/google-flow-live-generation-2026-10-05.json).

### Direct-HTTP generation diagnostic

Before the UI run, one explicit missing-input diagnostic sent one `YhhmEf` HTTP POST. The server returned HTTP 200 JSON (228 bytes) containing RPC status `7` and `PUBLIC_ERROR_UNUSUAL_ACTIVITY` (enum 49), with no media record. A delayed owner project snapshot still showed 35 media records and 1,050 credits. That journal did not persist the top-level request ID, so the snapshot is not an exact-request readback, and the legacy client-ID comparison is not valid correlation evidence. The same intent was manually reconciled as rejected based on the explicit server error and unchanged delayed project snapshot; it was not retried. Enum 49 is a broad unusual-activity error. It is distinct from `PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC` (enum 50), so this result does not establish traffic throttling or prove the omitted SDK input was the sole cause. The later UI run included the normal page SDK input and succeeded, but that comparison alone does not isolate the cause.

Together, these observations verify one browser-driven generation and direct-HTTP media readback/download. They do **not** verify a pure-HTTP generation issuer or an HTTP request carrying a browser-produced token. Classify the current create path as browser-runtime-dependent and the readback/download path as direct HTTP.

## Safe action capture

For an unapproved discovery write, install a fail-closed block for the exact write and associated save paths. For an explicitly authorized, bounded real create, prepare the journal and network cursor first, allow exactly one send, and reconcile that same request before any retry. Pair the attempted request with its response by requestId. Clear unused inputs and restore/close the task-owned debugger afterward. A failed UI tile caused by an intentional block is not a server rejection.

Decode field names only after verifying the operation and content type. In particular, reCAPTCHA reload/clear requests can carry binary/protobuf data. Applying URLSearchParams to such a body can expose an opaque credential as a supposed field name. Record only method, normalized path, MIME and status for those requests; never persist or output the body, token value or token fingerprint.

## Evidence and limits

The HTTP request shape and source trace are recorded in the maintained app's sanitized discovery receipts. This playbook's [live-generation receipt](../verification/google-flow-live-generation-2026-10-05.json) records the current outcome and keeps the direct-HTTP diagnostic separate from the browser UI create. No cookie, SDK token, raw response body, client identifier, signed media URL, or credential value is included.
