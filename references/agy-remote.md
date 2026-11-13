# Antigravity Remote Control

Owner-bound remote instance, project and conversation operations through the
first-party web Remote Control service. Discovery used a signed-in, visible
Chrome profile. Business requests and readback use independent Node HTTP.
The implementation does not use the AGY staff companion or a local CLI
conversation as a substitute for a conversation on the selected remote.

## Set up an existing signed-in browser

Use Node 24 or newer. Start the owner's Chrome with a dedicated persistent
profile and a loopback debugging port, sign in to
`https://antigravity.google.com/`, and complete any Google verification.
This project does not automate a Google password, solve challenges, disable
device-bound sessions, or change Chrome's security features.

```sh
node scripts/agy-remote-bootstrap.mjs \
  --cdp=http://127.0.0.1:9341 \
  --expected-email=you@example.com \
  --remote=my-linux-worker \
  --auto-sync
```

If several Antigravity tabs are open, supply the intended `--tab=<CDP-page-id>`.
The helper accepts only loopback HTTP/CDP and exact first-party tabs. It checks
the browser's visible account, captures one read-only `ListInstances` request,
and independently verifies `GetUserStatus` on the specified remote before
storing credentials. It never prints cookies, authorization values or keys.
`--store-dir=<private-directory>` selects a separate protected store.
Windows uses DPAPI CurrentUser; Linux/macOS explicitly select the existing
AES-256-GCM file provider, whose key and sealed files remain outside Git.

### Authentication has two distinct maintenance layers

* The first-party `SAPISID*HASH` request signature is timestamped. Only when the
  captured signature exactly matches the scoped cookie/origin signing format
  does the client regenerate that format for subsequent HTTP requests.
* Chrome also rotates device-bound `__Secure-1PSIDTS`/`__Secure-3PSIDTS`
  cookies. A copied cookie bundle can be rejected even while the browser stays
  signed in. Re-signing a request does not renew these cookies.

`--auto-sync` explicitly opts this **local protected store** into browser cookie
maintenance. When a bundle is at least five minutes old, the next invocation copies
fresh, current-origin cookies from the same owner-bound tab without navigation.
Five minutes is a conservative client policy, not a measured Google expiry.
The CDP connection closes before independent HTTP owner verification and
business work. A rejected safe read can refresh and retry once. Writers run an
authenticated read preflight; an uncertain mutation is never retried.

Keep the signed-in Chrome running for this maintenance. A stopped CDP runtime
is a runtime error; a missing/wrong account is an authentication error. Native
browser cookie maintenance was verified; automatic Google re-login after the
Google session itself expires is not implemented. The forced-age live test
advanced the client's scheduling clock; it did not simulate server expiry.
See [the earlier device-bound-session observations](google-bound-session-multislot-2026-10-24.md)
for background; that historical service's lifetime is not this service's lifetime.

Without `--auto-sync`, bootstrap remains explicit. The business client never
opens a browser on its own. Caller-supplied `credentialProvider`/stdin envelopes
cannot opt a common-registry request into the operator's browser.

## Select the remote explicitly

```sh
node scripts/agy-remote.mjs status
node scripts/agy-remote.mjs remotes
node scripts/agy-remote.mjs owner --remote=my-linux-worker
node scripts/agy-remote.mjs projects --remote=my-linux-worker
node scripts/agy-remote.mjs models --remote=my-linux-worker
node scripts/agy-remote.mjs sessions --remote=my-linux-worker --limit=50
node scripts/agy-remote.mjs sessions --remote=my-windows-desktop --query=project
```

Names must match exactly and uniquely. The server instance ID also works.
Unknown, ambiguous and offline selections fail before dispatching a remote
operation. A conversation ID is checked against the selected remote's own
persisted/loaded summaries. There is no implicit first-remote fallback.

### History coverage and pagination

`GetAllCascadeTrajectories` contains loaded trajectories, not all saved history.
The client also reads `JetboxSubscribeToSummaries` through `StreamProxyCommand`,
decodes Google RPC JSON streaming and native Connect frames, merges every
initial batch received, and cancels the read-only subscription after a bounded
quiescence interval. It does not stop after the first 100-entry batch.

The native subscription has no initial-snapshot-complete field. Results therefore
retain `complete:false`, `observation.kind:"quiescent_subscription"` and the
observed batch/count information. `pageComplete` means all entries in that
observed snapshot have been emitted, not that no other server history exists.
`nextCursor` paginates that snapshot; changed snapshots or a different remote
produce `AGY_CURSOR_STALE_OR_WRONG_REMOTE`. `--project=<id>` and `--query=<title>`
filter within the snapshot. The default scope is the selected machine's local
history; shared cloud-backend history is not merged into every machine.

## Create and continue a conversation

Use an existing project ID from `projects` and an available enum from `models`.
Model availability and labels belong to the remote and are not hard-coded here.
Each write needs `--confirm=CONFIRM` and a stable caller intent. These flags
record the caller's existing authorization; an agent need not ask the user again
when the task already authorizes the exact target and payload.

```sh
node scripts/agy-remote.mjs create --remote=my-linux-worker \
  --intent=my-task-create-001 --confirm=CONFIRM <<'JSON'
{"projectId":"outside-of-project","model":"MODEL_FROM_MODELS_OUTPUT","title":"My remote task"}
JSON
```

Use the returned `id` in subsequent operations. Prompt text travels on stdin,
not in command arguments or the write journal.

```sh
node scripts/agy-remote.mjs send --remote=my-linux-worker --id=<returned-id> \
  --intent=my-task-message-001 --confirm=CONFIRM <<'JSON'
{"prompt":"Your authorized task for this remote."}
JSON
node scripts/agy-remote.mjs wait --remote=my-linux-worker --id=<returned-id> --timeout-ms=120000
node scripts/agy-remote.mjs read --remote=my-linux-worker --id=<returned-id>

# Continue the same conversation with a distinct message intent.
node scripts/agy-remote.mjs send --remote=my-linux-worker --id=<same-id> \
  --intent=my-task-message-002 --confirm=CONFIRM <<'JSON'
{"prompt":"Continue the preceding task using its conversation context."}
JSON
```

`wait` polls the existing conversation; it never submits another message.
An idle trajectory with an error is `succeeded:false`. A wait timeout returns
the same ID and a read/wait resume instruction. Hidden generator metadata and
thinking signatures are omitted. Text-only message submission is implemented;
image/file attachments and automated tool-approval answers are not implemented.
Use the native session for an interactive request for attention.

## Rename, cancel and delete

```sh
node scripts/agy-remote.mjs rename --remote=my-linux-worker --id=<id> \
  --intent=my-task-title-001 --confirm=CONFIRM <<'JSON'
{"title":"Updated task title"}
JSON
node scripts/agy-remote.mjs cancel --remote=my-linux-worker --id=<id> \
  --intent=my-task-cancel-001 --confirm=CONFIRM
node scripts/agy-remote.mjs delete --remote=my-linux-worker --id=<id> \
  --intent=my-task-delete-001 --confirm=CONFIRM
```

Cancellation does not request killing unrelated background tasks. Deletion
targets only the explicit remote/conversation. Both require readback.

### Uncertain writes

The exclusive journal is reserved before dispatch. Conversation creation uses
a stable, intent-derived resource ID; message dispatch records a client message
ID before sending. A lost response or failed readback reports a `journalKey`.
Do not change the intent to resend an uncertain operation.

```sh
node scripts/agy-remote.mjs reconcile --remote=my-linux-worker --journal-key=<key>
```

Reconciliation is read-only against the remote and verifies the recorded
resource/message and content hash. It never reissues the original mutation.
`--journal-dir=<private-directory>` selects another journal root. Conversation
creation and its optional title update are separately journaled; if the title
step fails, reconcile the recorded creation and rename the existing ID.

## Common Playbook interface

The common service registry deliberately admits reads only. Existing native
writers retain the journaled CLI above.

```sh
node scripts/playbook.mjs describe --service=agy-remote
node scripts/playbook.mjs run --service=agy-remote --operation=remotes
node scripts/playbook.mjs run --service=agy-remote --operation=sessions \
  --input=examples/agy-remote/sessions.json
node scripts/playbook.mjs mcp --service=agy-remote
node --test tests/agy-remote.test.mjs tests/agy-remote-evidence.test.mjs
node scripts/verify-agy-remote-evidence.mjs
```

Operations are `remotes`, `owner`, `models`, `projects`, `sessions`,
`conversation`. The same `--store-dir`/`--session` mechanism as other Playbook
services selects the protected provider. Metadata listing does not open it.

## Contract and live proof

Observed web service origin: `https://antigravity.google.com`.

| Web RPC | Native RPC / purpose |
|---|---|
| `ApiService/ListInstances` | Account's named instances and status |
| `ApiService/ProxyCommand` | Owner, models, projects, trajectory pages, writes |
| `ApiService/StreamProxyCommand` | Persisted local summary subscription |

The proxy body is the Google JSON/protobuf array containing the selected
instance ID, exact `LanguageServerService` path, base64 payload, and optional
headers. Unary native operations use protobuf JSON. The history request uses
`application/connect+json` and a five-byte Connect envelope, not an unframed
JSON body. HTTP 200 alone does not establish native RPC success.

The request/response contracts were UI-observed, supplemented by the currently
shipped first-party `cli-1.5.7/main.js` descriptor schemas. These are undocumented
web contracts, not a public compatibility guarantee.

Live checks on 2026-11-13 used this Linux client against two online remotes
(Linux and Windows): owner/project/model reads, creation, custom titles, exact
responses, same-ID follow-ups retaining prior context, running-state
cancellation, and deletion of the temporary lifecycle fixtures. An offline
instance was retained in inventory and was not claimed operational. Existing
user conversations were not modified. Client execution on Windows itself was
not live-tested. See the [sanitized receipt](../sanitizedverification/agy-remote-live-2026-11-13.json)
and [capability checklist](../checklists/services/agy-remote.json).

The agent's command tool also printed a fixed marker on both machines, with
native command-step completion, exit code zero and matched tool output checked
independently. The Windows agent encountered sandbox launch failures before its
native fallback completed successfully; this does not establish that the Windows
sandbox itself works. The adapter did not change remote permission presets.
`models` returns server-advertised configurations, not a guarantee that every
listed model can generate under the current account's quota or entitlement.

The shared checklist records offline implementation gates for this service.
Its older generic GET/write receipt families are not used to relabel POST RPCs.
The dedicated verifier above separately validates the dated RPC write/readback
receipt and implementation hashes; the normal test suite runs this check too.
Recorded proof revalidation performs no network access and does not establish
that a future caller is currently authenticated.

Execution phases: initial Google sign-in is interactive browser authentication;
bootstrap and optional device-bound-cookie maintenance use CDP; business
requests/readback use `pure_http`. The complete maintained workflow depends on
the signed-in browser and is not engine-free.
