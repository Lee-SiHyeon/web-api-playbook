# Amazon expansion validation

Recorded 2026-10-15. This is a bounded public shopping extension, not full catalog or account-auth completion.

- Actual native HTTP executions: two menu requests; search pages 1–3 and a separate checkpoint resume at page 4; three distinct ASIN documents and a later fresh-process lotion read. All successful product receipts record a real Undici Cookie-header equality check and protected-store persistence.
- Independent `node scripts/verify-amazon-expansion.mjs`: passed. Source and artifact hashes matched; saved ontology inputs were rehashed and projected again; graph, frontier, ASIN, option and coverage checks passed. The independent verifier performs no network or protected-store read.
- 110/110 tests passed across 14 affected suites: Amazon expansion/ontology/product-session/session-checklist/search, scoped-cookie evidence, generic/public/credentialed/anonymous-session checklists, Coupang retail/attested/access-denied sessions and Linkprice auth. This is not a full repository test run.
- After replacing the quoted-cookie test value with a synthetic value, all seven scoped-cookie tests passed again. After trimming fixture whitespace, all nine product/session tests passed again.
- The Amazon checklist records eight bounded capabilities as live at their receipt timestamps. Seven required gaps remain: category product lists, last-page termination, full price/availability semantics, complete gallery, review bodies, review pagination and all variant offers. Strict completeness must fail.
- Staged content was compared in memory against 11 opaque runtime values from the two service-scoped protected bundles. The initial synthetic-fixture issue was removed before commit, including its temporary unreferenced staging blob. The subsequent comparison had zero findings; values were never printed by the audit.
- Menu fixtures and the later live menu are separate observations. Catalog destinations agree; the later read adds an Artist Merch incoming edge while the earlier fixture has a Product Support edge. The verifier explicitly checks that difference instead of claiming byte-identical menus.

Current projection: 60 unique search ASINs, 62 total offerings, 47 displayed-price observations and 47 dimension/child-ASIN relationships. Frontier: 206 category/listing destinations, 114 unread ASINs and search page 5 pending. Session expiration recovery, complete gallery and every option's own offer remain unverified. Reviews return a sign-in redirect. Account writes and database writes: zero.
