# Gemini and Grok work stopped on 2026-10-07

The user stopped provider/API work and requested delivery of the existing changes.
No new provider operation is authorized by this status note. The active goal is paused.

## Verified outcomes retained

- Gemini v9 used a new 12-byte file and distinct intents. Direct upload start,
  transfer and final-status read were HTTP 200. A direct text request was HTTP 200;
  independent hNv readback contained exactly the file's structured rendered text.
  The direct response ID value matched the hNv turn ID, separately from the draft ID.
  Three mutation journals each reconciled one dispatch. The 21-byte plain candidate
  was not used as the exact-answer proof. The receipt was sanitized before delivery;
  full URL query values were removed and the hash transition is recorded.
- Grok owner, first/next list pages, search, detail, response nodes and loaded
  responses were independently read through the normal CLI. The exact neutral
  task's prompt and assistant hashes matched; opaque cursors remained in memory.
- Grok's normal `imagine-overrides` CLI now has a source-derived contract and a
  successful HTTP 200 read of an empty override array. This is separate from
  selecting a private chat mode.
- A 149 MiB upload init returned HTTP 200 and selected `single_put`. A multipart-only
  assertion stopped before any PUT or complete; the exact issued reservation was
  aborted once and read back as ABORTED. Multipart execution was not proven.
- Real isolated Chromium/localhost tests reproduced delayed WebSocket delivery
  after premature guard removal and zero delivery with guard-held blank/quiet
  finalization. The shared user browser/context was preserved.

## Outstanding at the stop

| Capability | Remaining evidence or implementation |
| --- | --- |
| Gemini continue/edit/regenerate | Native captures were blocked; no direct action was sent. Current request target mapping and spoof rejection were corrected locally and tested. |
| Gemini rename/share/revoke/delete | New lifecycle fixture is owner-bound, but no new lifecycle mutation was sent. Historical rename/delete outcomes do not prove the current expanded adapters. |
| Grok attachment-to-chat | Upload exists, but no direct attachment message was sent; prior browser-only/unknown intent is held. |
| Grok restore | Source/adapter/CLI and offline tests exist; the archived neutral tombstone was identified read-only. No restore POST was sent. |
| Grok current Fast mode | Current native selector/preflight attempts stopped before CLI dispatch. Historical direct text outcome is retained separately. |
| Cold Google login / expired-provider recovery | Current Google-linked owner sessions are usable; fresh OAuth callback/password acquisition and expired server-session recovery are not verified. |
| Multipart / PATCH | Multipart is implemented/tested but not selected by the live 149 MiB probe. PATCH has no current uploader callsite/usable captured contract. |
| File/ZIP canonical integration | CSV and FilesService ZIP bytes are verified, but higher-level feature-checklist integration is unfinished. Workspace ZIP is separate and did not contain the CSV. |
| Current-source media and remaining canonical receipts | Image/video generation/download outcomes exist; several execution-time source closures and canonical receipts need current verification. No old hashes were restamped. |

Existing uncertain intents must remain held. Resume only when the user requests it;
inspect live processes and their own journals before deciding to retry anything.
