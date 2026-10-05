# Google Flow: session propagation and the generation boundary

Checked 2026-10-05 on the owner's Windows runner. The maintained consumer client is in affiliate-content-operations/apps/google-flow-api. These observations use the Flow web project and existing web credits; they are not Gemini Developer API or Vertex AI evidence.

## Login visible in Chrome, HTTP redirected to Google sign-in

A narrow 16-name Google cookie capture omitted the host-only Flow cookies OSID and __Secure-OSID. A direct GET of the observed /project/{projectId} returned HTTP 302 to accounts.google.com/ServiceLogin. The normal browser document returned 200 and contained SNlM0e, FdrFJe and cfb2h.

The browser actually sent 21 scoped cookies, including those two Flow host cookies. After an encrypted first-party handoff into Windows DPAPI, a separate Node process parsed all three document fields and replayed protected project RPC Zzl0ze, returning 35 media records. This establishes current session propagation and that read operation. It does not establish independent password login or expired-session recovery.

Preserve the cookie array's domain, hostOnly, path, secure, session and expiry metadata. Do not use a fixed Google authentication-name allowlist that drops service-host cookies. Reject out-of-scope cookies and identical scope duplicates; keep the same name at distinct valid scopes. Chrome CDP's expires:-1 with session:true is a session-cookie sentinel, not an expired persistent cookie. Never send the Flow bundle to accounts.google.com or a media CDN by following a redirect.

Record 302 as a redacted redirect class, status and MIME. Distinguish account sign-in, same-origin routing and unknown redirects; omit query values, cookies and document tokens. A 200 document missing SNlM0e is a separate parser/input failure and does not by itself establish logout.

## Current eight-second consumer generation contract

A normal Omni 1.1 Flash setup selected one 720p, eight-second, 16:9 clip. With all Flow business requests blocked before clicking the button, the browser attempted:

- POST https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute
- rpcids: YhhmEf; URL-encoded form keys f.req and at
- Model key abra_t2v_8s; aspect value 2; project context and per-job client identifiers
- A fresh first-party reCAPTCHA Enterprise input in the generation context

The generation request failed with inspector block before reaching Flow, and no create response was received. The independent existing-media state read returned state 3 and credit balance 1,050. Service create count was zero. The observed consumer setup offers 360p or 720p; a requested 480p artifact requires a separately verified local conversion of a new completed native clip.

Google documents the normal website execute() token flow and one-use, two-minute tokens in [Create assessments for websites](https://docs.cloud.google.com/recaptcha/docs/create-assessment-website). An assessment endpoint consumes that token; it is not a replacement issuer. No verified pure-HTTP issuer was found for Flow. Do not replay internal challenge requests, fabricate a token, substitute another service's key, or treat the SDK capture as engine-free generation.

An HTTP generation writer with a memory-only provider interface may be implemented and tested against the captured contract while live generation remains blocked. Report captured/client_exists separately from live_replay, and preserve zero create requests when the verified provider is absent. A browser SDK input provider would make the complete recurring generation operation hybrid, even if the business POST is sent by Node.

## Safe action capture

Before observing a submission, install a fail-closed block for the exact write and associated save paths. Pair the attempted request with its loadingFailed event or response by requestId. Clear unused inputs and restore/close the task-owned debugger afterward. A failed UI tile caused by the intentional block is not a server rejection.

Decode field names only after verifying the operation and content type. In particular, reCAPTCHA reload/clear requests can carry binary/protobuf data. Applying URLSearchParams to such a body can expose an opaque credential as a supposed field name. Record only method, normalized path, MIME and status for those requests; never persist or output the body, token value or token fingerprint.

## Evidence and limits

The sanitized receipt is affiliate-content-operations/apps/google-flow-api/discovery/http-generation-path-2026-10-05.json. The session fix and document/project/state reads were live-verified. The new eight-second generation contract was captured under a verified block; no direct create replay, new media or requested 480p artifact was produced.
