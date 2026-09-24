# Authentication propagation in the actual runtime

Portable package note: authorized persistent cookie/token reuse is supported through the bundled protected store. Keep encrypted local credentials separate from evidence and Git. See [runtime modules](runtime-modules.md) and [portability](portability.md); the older deployment examples below do not require a particular broker to be installed.

Use for API-only clients backed by an existing authenticated integration. This local version does not require the Hermes web broker or 9122/9123.

Trace the current deployment's real path:

```text
authorized user → configured credential/session provider → runtime boundary
→ selected client process → non-interactive authenticated request
```

Resolve acquisition and renewal using [browserless-login-flow.md](browserless-login-flow.md).
If required SDK input preparation uses a headless provider, trace that separate
branch through a fresh in-memory envelope into the HTTP child. Record its engine
dependency and cancellation/closure independently from login propagation.

Check each boundary independently:

- The execution identity matches the intended user/account.
- The host and service origins match the authorized provider and consumer; an
  existing session on another machine is not local readiness.
- The provider reports required credential or session readiness.
- Provider names and the client's consumed names match exactly.
- The actual runner passes or brokers only what the selected client needs.
- Filtering, subprocess creation, retries, and helper processes preserve required access without exposing unrelated credentials.
- The response contains a protected application result, not login HTML or a public fallback.

For diagnostics, inspect key names and booleans only. Never print credential values or archive them in evidence, Git, environment dumps or plaintext files. Authorized cookie/token persistence belongs in the existing protected credential store; retain that capability when moving the client. Use only the current authorized actor's session.

A prompt or EOFError during non-interactive execution can indicate propagation failure. Before requesting reconnection, distinguish stored readiness, caller authorization, process visibility, and client loading. A ready provider with missing client credentials is a deployment defect; fix the first broken boundary.

Do not respond to an attachment/focus timeout or filtered result by declaring
the website session expired. Record the tool boundary, inspect only safe
metadata, and use supported recovery. Do not switch to a guessed debugging port
or repeatedly ask the user to log in while that boundary remains broken.

Use sentinel credentials for meaningful regression checks of the real runner/provider interface. Verify required values reach their intended consumer, unrelated secrets remain excluded, and missing/expired authentication fails clearly. If the actual deployment uses process-bound authorization, preserve and test its lifecycle and identity checks; do not invent such a system solely to use this skill locally.

Validate through the production runner after deployment. Report storage readiness, provider readiness, runtime propagation, authenticated read-back, and deployment verification separately. Do not collapse these into `connected=true`.

Completion remains five independent states: captured, client_exists, remnant_free, credential_propagated, live_replay.
