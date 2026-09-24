# Reliable API clients

## Capability and evidence boundaries

Track each operation separately: candidate → request_observed → adapter_implemented → replay_verified. Store evidence time and actor scope; previous success does not prove current authentication. Keep operation coverage separate from page coverage and the five deployment states in SKILL.md.

Use named operations with validated inputs and explicit response decoders over a shared HTTP transport. A generic request helper restricted to a host is not an operation allowlist. Validate service-level error fields as well as HTTP status, MIME and expected schema. Treat login HTML, consent pages, wrong-account results and empty fallback shells as failures.

## Authentication lifecycle

Follow [browserless-login-flow.md](browserless-login-flow.md) before requesting a new login or selecting a headless helper. Separate credential acquisition, optional SDK input preparation, and normal HTTP requests. Prefer an existing supported session provider; do not infer access to browser cookies from an extension connection. Record provider type, last successful protected account check and expiry/re-auth status without recording secret values. Recheck authentication after browser restart or process reset when needed.

When authentication is actually missing or rejected, use a verified refresh path once and retry a safe read; otherwise retain `reauth_required` and request normal login. A provider-to-runner defect or browser/tool failure is not an authentication rejection. Session persistence, server cookie rotation, SDK token reissuance, login renewal, account switching and engine-free login are distinct capabilities. Do not infer one from another or from runtime environment injection.

## Retry and write recovery

Use bounded timeout and backoff for safe reads and service throttling; respect Retry-After where available. Do not retry authentication errors indefinitely. Classify authentication, permission, throttling, transport, schema and service errors separately.

On a write timeout, success is unknown. Read back using a stable identifier or supported idempotency key before considering another write. Never assume POST with an id field is an update. Without reliable reconciliation, mark needs_review rather than replaying a create/publish/payment operation. Persist sanitized task state before externally visible writes when restart recovery is required.

Long operations should retain task identifier, submitted time, polling state and artifact validation result. Restart should resume polling instead of resubmitting generation. Identifiers in durable state must be scoped to the authorized project and not be bearer secrets.

## Discovery process health

Keep collectors separate from production clients. Before claiming capture is active, verify the collector is connected and observes an allowed event. Retain start/stop time, last event time, attached target count and disconnect reason without secrets. Process exit, kernel reset or reboot invalidates the active claim. Having a logger script is not a running service.

Checkpoint traversal after each page or small batch. Preserve blocked and pending branches. DOM-only traversal is page discovery, not XHR capture. Browser URL rejection or missing authentication must be recorded at the actual boundary; do not attribute it to a domain or expired cookies without evidence.

## Operational readiness

For an unattended service, verify restart recovery, credential propagation in the actual runner, duplicate prevention and a visible failure path. Report readiness independently from one successful request. Do not promise continuous order intake based on a CLI or skill alone.

Design references: https://github.com/teng-lin/notebooklm-py/blob/main/docs/architecture.md and https://github.com/jacob-bd/gemini-notebook-mcp-cli . These are design references, not dependencies or proof of this client's implementation.
