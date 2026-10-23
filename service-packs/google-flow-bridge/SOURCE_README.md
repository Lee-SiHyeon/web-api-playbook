# Google Flow XHR API client

Node.js CLI for the Google Flow web app at flow.google.com, using its observed batchexecute XHR contract. It does not call the public Gemini API and does not use a Gemini API key. Omni 1.1 Flash generation runs against the signed-in Flow account and consumes the account's Flow credits.

## What runs where

- Node builds Flow's YhhmEf text-to-video request and asks the extension to run YhhmEf, Zzl0ze (project media), and as29s (GetMedia) XHRs in the signed-in page. It then downloads the returned MP4 directly over HTTP, checks its length and signature, and writes it locally.
- The small local Chrome extension is a page bridge for Flow XHRs: every batchexecute call needs the signed-in page's session cookie and page at token, and generation also needs a fresh single-use reCAPTCHA Enterprise token. The extension reads the page's at and f.sid values in memory to issue the XHR but does not export or persist them, session cookies, or CAPTCHA tokens.
- Only the final signed media GET runs directly from Node after generation. The signed media URL exists only in memory and is never printed or written to the job directory.

Execution mode: **browser-assisted XHR**. The recurring create and read RPCs still require an open signed-in Flow page; this is not a browser-engine-free client. The CLI automates the request flow around that boundary and avoids UI clicking for normal operations.

The Flow contract is private and can change without notice. The request builder follows the observed Flow frontend and the [FlowKit batch implementation](https://github.com/crisng95/flowkit/blob/main/agent/services/flow_batch.py). The generation request has **not** passed an independent end-to-end replay in this client. Treat its model keys and response reader as provisional until a new live create returns a media id and an independent project readback finds the same item.

## One-time setup

Requirements: Windows, Node.js 24+, Chrome 116+, a signed-in Google account with access to Flow, and Flow credits.

1. From the repository root, install workspace dependencies if needed:

   ~~~powershell
   npm install
   ~~~

2. In the Chrome profile where Flow is signed in, open chrome://extensions, enable Developer mode, choose Load unpacked, and select:

   ~~~text
   apps/google-flow-api/extension
   ~~~

   The extension requests the scripting capability, access to https://flow.google.com/*, and a local connection to 127.0.0.1. It has no permission to enumerate arbitrary tabs or read browser storage. Chrome will show its normal extension permission screen; review that scope before enabling it.

3. Open the target Flow project editor in that same Chrome profile, make it the active tab, and keep it signed in while the CLI runs. The project id is read from the current project URL in memory; no session credential is copied to disk.

4. Check the bridge:

   ~~~powershell
   cd apps/google-flow-api
   node src/cli.mjs status
   ~~~

   Expected output: {"bridge":"connected","flowProjectOpen":true}. A connection error means the extension is not enabled, the Flow page is not open, or another local process owns port 9417.

## Generate and download

Put the prompt in a UTF-8 text file. From apps/google-flow-api:

~~~powershell
node src/cli.mjs generate --prompt-file .\prompt.txt --aspect 16:9 --duration 4 --resolution 720p --out .\.runtime\my-video.mp4
~~~

Options:

| Option | Values | Default |
|---|---|---|
| --prompt / --prompt-file | Prompt text or UTF-8 prompt file; choose one | Required |
| --aspect | 16:9, 9:16 | 16:9 |
| --duration | 4, 6, 8, 10 seconds | 4 |
| --resolution | 720p, 360p | 720p |
| --out | Output .mp4 path | .runtime\flow-video.mp4 |
| --project-id | Existing Flow project UUID; normally detected from the open editor | Auto-detected |

The generation request is submitted once. Before submitting it, the client writes an intent journal under `.runtime/jobs/` with a prompt hash and two client request IDs; it does not store the prompt. If the response is missing or malformed, the client queries the project media list by those IDs. It never retries the create request automatically. A matching media item is resumed through GetMedia and download. If no match appears, the journal stays unresolved and a repeated command with the same project, prompt, and settings is blocked.

To reconcile an unresolved job or resume a download without consuming generation credits:

~~~powershell
node src/cli.mjs reconcile --job .\.runtime\jobs\YOUR_JOB_ID.json
~~~

An explicit RPC rejection is recorded as rejected. A failed preflight is recorded separately. A lost create response stays `needs_reconciliation` until the project listing yields a matching client ID or you inspect the Flow project manually. The temporary signed download URL, CAPTCHA token, page at value, session cookies, and f.sid are never included in logs or journals. The output file is checked for a video-compatible MIME type, declared length when available, and `ftyp` signature before it is renamed into place.

To download an existing video from the open project without another generation or CAPTCHA:

~~~powershell
node src/cli.mjs list
node src/cli.mjs download --media-id EXISTING_MEDIA_ID --out .\.runtime\existing.mp4
~~~

The media id must appear in the active project's media list. `download` obtains a fresh signed URL with as29s, then writes the MP4. The editor URL's `/edit/` id is a scene id and is not interchangeable with the media id.

The CLI asks for an interactive confirmation immediately before minting the generation CAPTCHA and submitting the billable request. Automated callers must pass --confirm-generation at invocation time.

## Contract and evidence boundary

- Captured: live page traffic exposes the batchexecute envelope, YhhmEf / Zzl0ze / as29s RPC ids, project scene records, GetMedia payloads, and the signed media URL path. The text-video write schema was also cross-checked against FlowKit.
- Client exists: the request builder, local bridge, intent journal, reconciliation path, polling client, and MP4 downloader are implemented here.
- Credential propagation: browser-managed cookies stay in Chrome; page context supplies the current at value to the XHR. A fresh CAPTCHA is needed for create. The unpacked extension has not yet been installed or verified in this environment.
- Live replay: a signed-in Flow page independently returned HTTP 200 and expected payloads for as29s and Zzl0ze on 2026-09-24. YhhmEf through this CLI, extension credential handoff, and Node signed-media download remain unverified. The already generated sample MP4 was downloaded through the Flow UI and is not evidence of CLI generation.

No refresh token, cookie, bearer token, or captured page token is stored by this app. Google may change its private Flow RPC contract or require a visible CAPTCHA challenge; the client stops on those failures instead of trying to bypass them.
