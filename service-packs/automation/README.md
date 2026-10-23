# Automation API pack

Reusable HTTP clients and offline-tested workflows migrated from `affiliate-content-automation`. The pack currently covers Coupang category navigation, Coupang Partners search/dashboard/link/report endpoints, bounded product-review sampling, aggregate measurement snapshots, and exact-option price observations.

The pack uses only Node.js built-ins and requires Node 24 or later. It has no install-time dependencies. Run the offline suite from this directory with:

```sh
node --test
```

All authenticated commands read credentials from environment variables. Never put cookies or tokens in JSON input, command arguments, receipts, or logs.

List commands with `node scripts/help.mjs`; use `<command> --help` for one entrypoint. Both read only static usage text and exit before reading stdin, credentials, or making a network request. A catalog/runner can also list this pack from `package.json`, this README, and `docs/api-contracts.md` without importing or executing any client code.

## Commands

| Command | Input | Required environment |
| --- | --- | --- |
| `node scripts/category-tree.mjs <frontier-file>` | output path argument | `COUPANG_REVIEW_COOKIE` |
| `node scripts/category-branch.mjs` | stdin JSON: `{ "file", "seed": { "linkcodes", "component" }, "budget?", "intervalMs?" }` | `COUPANG_REVIEW_COOKIE` |
| `node scripts/partners.mjs` | stdin JSON: `{ "operation", "payload?", "evidenceOnly?" }` | `COUPANG_COOKIE`, `COUPANG_X_TOKEN` |
| `node scripts/daily-report.mjs` | stdin JSON: `{ "startDate", "endDate", "directory" }` | `COUPANG_COOKIE`, `COUPANG_X_TOKEN` |
| `node scripts/reviews.mjs` | stdin JSON: `{ "productId", "sample?", "page?", "mode?" }` | `COUPANG_REVIEW_COOKIE` |
| `node scripts/measurements.mjs <directory> [post-id ...]` | output path and optional post IDs | `COUPANG_COOKIE`, `COUPANG_X_TOKEN`, `TISTORY_BLOG_ORIGIN`, `TISTORY_COOKIE` |
| `node scripts/intake-poll.mjs <directory> <post-id> [...]` | output path and one or more published post IDs | `TISTORY_BLOG_ORIGIN`, `TISTORY_COOKIE` |
| `node scripts/publication-health.mjs` | stdin JSON: `{ "expected", "directory" }` | `TISTORY_BLOG_ORIGIN` |
| `node scripts/price-check.mjs` | stdin JSON: `{ "expected", "directory" }` | `COUPANG_COOKIE`, `COUPANG_X_TOKEN` |
| `node scripts/affiliate-link.mjs <workspace-root>` | stdin JSON: `{ "product": { "productId", "itemId", "vendorItemId", ... } }` | `COUPANG_COOKIE`, `COUPANG_X_TOKEN` |

`partners.mjs` accepts `dashboard` and `search`. Its default output is metadata only; set `evidenceOnly:false` only when the caller needs the service response data in memory. Use `affiliate-link.mjs` for `productLink` so issuance is journalled before its single POST. `reviews.mjs` defaults to hashes and review metadata. `mode:"synthesis-input"` includes review text in stdout; treat that text as untrusted user content and keep it out of logs and persistent artifacts.

`affiliate-link.mjs` writes a durable `intent` record before issuing the single link request. A generated record is reused on the next invocation. An interrupted or failed intent blocks another automatic request and requires reconciliation. The response records `destinationVerified:false`; it does not prove that the affiliate destination works.

Price checks persist a local receipt and do not update published content. A missing exact product option is not evidence that it was delisted or sold out. The daily report and measurement snapshot are account-level observations; neither establishes article attribution, organic traffic, net settlement, or conversion.

See [API contracts and limits](docs/api-contracts.md) for paths, headers, selectors, response checks, coverage boundaries, and Tistory overlap.

## Root CLI

저장소 루트의 npm run --silent client -- --service=automation -- partners --help로 개별 명령에 연결할 수 있습니다.
