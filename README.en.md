# Web API Playbook

[한국어](README.md) | **English**

[![GitHub stars](https://img.shields.io/github/stars/Lee-SiHyeon/web-api-playbook?style=social)](https://github.com/Lee-SiHyeon/web-api-playbook/stargazers)
[![Offline Node checks](https://github.com/Lee-SiHyeon/web-api-playbook/actions/workflows/offline-checks.yml/badge.svg?branch=main)](https://github.com/Lee-SiHyeon/web-api-playbook/actions/workflows/offline-checks.yml)
[![Node.js >=24](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](#quick-start)

**Tools and know-how for calling websites that have no official API as if they did, so you can automate them.**

> ⭐ If this project is useful to you, please [give it a star](https://github.com/Lee-SiHyeon/web-api-playbook)! It motivates us to add more services and automation examples.

Observe the requests a browser makes behind the page (XHR, Fetch, Document), then turn them into
HTTP operations you can replay without a browser. Sessions are stored and reused safely, and results
are confirmed by reading back the real state, not by trusting an HTTP 200.

```text
Observe requests in the browser (HAR, HTML, bundles)
  → write down the request contract (origins, fields, response shape)
  → run it as an independent HTTP operation with a session (CLI, MCP)
  → validate the response and read back the actual result
```

## What you can automate

Real implementations built this way. Scope and limits differ per service and are documented in the linked guides.

| Area | Examples |
|---|---|
| Blog publishing | [Naver Blog](service-packs/naver/README.md), [Tistory](service-packs/tistory/README.md): login, reads, image/video upload, publish |
| Shopping & prices | Coupang, Amazon, Rakuten and Yahoo! Shopping, AliExpress, Ably, Olive Young: search, details, options, reviews |
| Affiliate links | Coupang Partners, Naver Brand Connect, MyRealTrip, Adpick, LinkPrice: product search and link issuance |
| Travel | Agoda dated rates and promotions, Coupang Travel, MyRealTrip tours and tickets |
| Social & creators | [X / Reddit](service-packs/social-x/README.md), [Threads](service-packs/threads/README.md), Inpock profile and cards, YouTube Studio upload |
| Operations | Gabia domain and DNS reads |
| Jobs | [Public job boards](references/jobs-public-apis.md): Greenhouse, Lever, Ashby, Remotive, caller-key Reed search, TokyoDev document parsing, snapshots and field-level changes |
| Freelance services | [Kmong, Soomgo and Upwork](references/freelance-public-apis.md): public search, detail pricing types, reviews, bounded collection, provider search and approved-token Upwork reads |

For protected account verification and encrypted Windows session reuse after sign-in, see the [Kmong authentication guide](references/kmong-auth.md) and [Soomgo capability and authentication guide](references/soomgo-frontier.md). Soomgo also supports provider profiles, reviews, portfolios, request forms, and the signed-in customer's request and chat lists.

See the full list in the [detailed guide](docs/guide.md#무엇이-들어-있나) (Korean) or run `npm run services`.

## Consolidated clients

Gemini, Grok, ChatGPT, both Flow implementations, Whisk, Adpick, Threads actions and additional shopping/travel/social clients are now bundled. See the [repository consolidation map](references/repository-consolidation.md) for pinned commits and execution boundaries. Run npm run clients for the metadata-only catalog and npm run test:client-packs for their original offline regression tests. This migration performs no account login, generation or publishing.

## Quick start

Requires Node.js 24+, npm and Git. The examples below only read synthetic files in the repository: no browser, network or login.

```sh
git clone https://github.com/Lee-SiHyeon/web-api-playbook.git
cd web-api-playbook
npm ci --ignore-scripts
npm run doctor

node scripts/har-to-contracts.mjs --input=examples/sanitized.har.json
node scripts/discover-html.mjs --input=examples/navigation.html --base=https://example.invalid/
node scripts/playbook.mjs describe --profile=templates/profile-v2.example.json
```

- `har-to-contracts`: a contract inventory of request fields, response types and status codes from a HAR. Token and body values are never printed.
- `discover-html`: link, iframe and script candidates found in saved HTML.
- `playbook describe`: the operations and typed inputs defined in a profile.

## Turning a new site into an API

1. **Observe:** perform the action in a browser with an account you are authorized to use, and save a HAR. Keep raw HARs outside Git.
2. **Write the contract:** inventory requests with `har-to-contracts`, then fill the [profile template](templates/profile-v2.example.json) with allowed origins, operations, inputs and expected responses.
3. **Attach a session:** pass cookies or tokens via stdin into protected storage, then verify the session with a read that proves account ownership.
4. **Run:** use `playbook run` or resumable `collect` from the CLI, or expose the operations to an AI agent with `playbook mcp`.
5. **Confirm:** writes keep a journal, and completion is judged by reading back the real state, not by the server's acknowledgement.

Step-by-step commands are in [chapter 4 of the detailed guide](docs/guide.md#4-새-서비스를-http로-전환할-때) (Korean); operation definitions are in the [operation runtime](references/operation-runtime.md).

## Using the services already built

```sh
npm run services                                       # connected services and operations (no network requests)
node scripts/playbook.mjs run --service=ably --operation=categories
```

For per-service login and commands, see the [service CLI guide](references/service-cli.md) and the [service-pack index](service-packs/README.md).
Kmong collection CLI and common-registry operations are wired in this checkout. The latest 140.228 replay and its bounded scope are recorded in the [2026-10-26 verification](verification/jobs-freelance-2026-10-26/README.md); remote-main merge remains a separate Git readback. See the [freelance guide](references/freelance-public-apis.md) for commands and boundaries.
To use it from an AI agent (Codex and others), have it read [SKILL.md](SKILL.md) or install it with `npm run install:skill`.

## Session storage

Passwords, cookies, tokens and browser profiles are not in the repository. Cloning it does not transfer any authentication.

| Mode | Description |
|---|---|
| Windows DPAPI | Default on Windows, bound to the current Windows user. |
| Encrypted files | `PROTECTED_STORE_PROVIDER=file` on macOS/Linux: AES-256-GCM sealed files, not Keychain or Secret Service. The key comes from `PROTECTED_STORE_KEY`, `PROTECTED_STORE_KEY_FILE`, or `~/.config/xhr-to-api-only/protected-store.key`. |
| stdin / memory | `--session-stdin`. Lives only for that process. |

## Principles

- **HTTP 200 is not success.** Response shape, account ownership and the actual effect are checked separately.
- **Writes are never resent.** If a response is lost, reconcile with the journal and a read-back.
- **Coverage is recorded.** Seeing one category is not counted as crawling the whole site.
- **Limits are stated.** Where a first login or a step still needs a browser, it says so. No claim of universal site or CAPTCHA support.

## Documentation

Detailed guides are mostly in Korean.

| Document | Contents |
|---|---|
| [Detailed guide](docs/guide.md) | Full feature table, per-service usage, conversion steps, error codes, test setup |
| [SKILL.md](SKILL.md) | Conversion procedure and evidence rules for agents |
| [references](references/) | Per-service request contracts; pagination, backoff, bot-detection and session-refresh patterns |
| [Case studies](case-studies/README.md) | What worked, what failed, and lessons for other services |
| [verification](verification/README.md) · [checklists](checklists/README.md) | Live evidence and per-feature coverage |

## Tests

```sh
npm run test:operations
npm run test:services
npm test   # full regression; also needs Python 3
```

`npm test` picks Python from `WEB_API_OLIVEYOUNG_PYTHON`, then `.venv-oliveyoung`, then `python3` on PATH. The [offline CI](.github/workflows/offline-checks.yml) runs install, doctor and the regression suite on Ubuntu with Node 24. It never logs in to a real service.

## Contributing

[PRs](https://github.com/Lee-SiHyeon/web-api-playbook/pulls) for new features and improvements, and [Discussions](https://github.com/Lee-SiHyeon/web-api-playbook/discussions), are always welcome. Please include the expected behavior and reproduction steps or examples.

## License

[MIT](LICENSE): use, modify and redistribute it freely, for personal or commercial work. Keep the copyright notice. You use it at your own risk.

Third-party libraries installed through npm, and outside material whose source is recorded in [provenance](provenance/README.md), stay under their own licenses. Check the terms of service of each site you automate. See [NOTICE](NOTICE.md).
