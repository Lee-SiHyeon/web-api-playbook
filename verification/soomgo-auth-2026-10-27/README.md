# Soomgo authenticated reads — 2026-10-27

The production CLI ran on Windows host `140.228` with Node 24.22.1. Naver sign-in used the normal browser flow and only the required consent approved by the account owner. The subsequent CLI reads used direct HTTP.

- One hidden-stdin session import verified the account and persisted the Soomgo token with Windows DPAPI CurrentUser.
- Two distinct fresh CLI processes verified the same pinned owner using that encrypted store, without browser access or another import.
- Opened requests and closed/expired requests each returned HTTP 200 and zero rows. Each read first verified the owner. Customer chats also returned HTTP 200 and zero rows; chat coverage remains first-page-only.
- The separate anonymous owner control returned 401; the authenticated control returned 200. Marketing, optional-information, and newsletter consent readbacks were false. Name certification was not established.

`source/` contains sanitized CLI result records, process metadata, and before/after runtime hashes. The opaque store scope is derived from harness invocation metadata; it is not an independent cryptographic identity proof. No account identifier, email, password, token, cookie, or raw owner response is included.

Run `node scripts/verify-soomgo-auth.mjs` to check the recorded artifacts offline. The five generic proofs bind to their CLI source records. `--prepare` derives those proofs from existing records; it does not perform live verification. The manifest pins the nine files used by the authenticated runtime.

Automatic OAuth/refresh, nonempty account rows, individual quote/chat/message detail, real request submission, messages, and payments remain unverified or unimplemented. No business action was submitted during this run.
