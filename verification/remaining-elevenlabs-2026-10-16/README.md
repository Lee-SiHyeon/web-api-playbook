# ElevenLabs remaining blocker — 2026-10-16

The authenticated speech-synthesis UI displayed voice **Adam**, model **Eleven v4**, stability **0.5**, and similarity **0.75**. Those are UI observations only.

The root agent reported repeated `Network.enable` failures on both the existing same-profile tab and a fresh same-profile tab. The reported runtime conditions were a paused document response and an unattached CDP debugger. No usable network request was captured, so there is no observed API origin/path, authentication header or cookie bundle, voice/model/options response, synthesis payload, response MIME, or history readback contract.

The maintained importer was not called. Owner/options reads and TTS generation count are zero; no audio artifact or history result was read back. This record describes a browser instrumentation blocker. It does not claim that ElevenLabs returned an HTTP error or that the account is logged out. Exact attempt timestamps and raw CDP error output were not supplied; no raw bodies, credentials, or audio were saved. Machine-readable value-free details are in [evidence.json](evidence.json).

`auth.session_handoff` remains **local-only**. Its existence or local validation must never be promoted to `recorded_live`. API implementation and live evidence remain blocked until a supported browser capture exposes the real first-party calls.
