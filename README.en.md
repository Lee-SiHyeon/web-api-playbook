# Web API Playbook

[한국어](README.md) | **English**

[![GitHub stars](https://img.shields.io/github/stars/Lee-SiHyeon/web-api-playbook?style=social)](https://github.com/Lee-SiHyeon/web-api-playbook/stargazers)
[![Offline Node checks](https://github.com/Lee-SiHyeon/web-api-playbook/actions/workflows/offline-checks.yml/badge.svg?branch=main)](https://github.com/Lee-SiHyeon/web-api-playbook/actions/workflows/offline-checks.yml)
[![Node.js >=24](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](#requirements)

[PRs](https://github.com/Lee-SiHyeon/web-api-playbook/pulls) for new features and improvements, and [Discussions](https://github.com/Lee-SiHyeon/web-api-playbook/discussions), are always welcome.
Including the expected behavior and reproduction steps or examples helps us review your contribution.

**Turn observed browser requests into repeatable, independently verified HTTP operations.**

Web API Playbook combines request-discovery tools, scoped sessions, service adapters, and evidence-driven workflows. Observe a request, record its contract, reproduce it outside the browser, and verify what actually happened—not just whether the server returned HTTP 200.

```text
Browser observation / saved HAR
  → request contract and explicit scope
  → independent HTTP operation
  → response validation and read-back evidence
```

This is a toolkit and collection of service-specific playbooks, not a universal browser replacement. Some workflows still require an initial browser login, a browser-assisted step, or a service-specific runtime. Credentials and authenticated sessions are not supplied by cloning the repository.

## What is included

- **Offline discovery:** inspect HAR, saved HTML, and JavaScript bundles; inventory request contracts and track discovery frontiers.
- **Scoped HTTP sessions:** restrict origins and cookie scope, verify account ownership, handle cookie rotation, and use protected local storage.
- **A shared operation interface:** typed profiles drive CLI commands and an MCP stdio server; read-only flows and collections support checkpoints and resume.
- **Service-specific implementations:** selected publishing, retail, travel, affiliate, and social workflows, with their own authentication requirements and documented limits.
- **Verification records:** distinguish implemented code, synthetic tests, historical live observations, current reads, and unresolved work. Writes use journals and independent read-back rather than treating an acknowledgement as completion.

## Requirements

- **Node.js 24 or newer**, npm, and Git.
- Repository read access while the repository is private.
- No browser, account, or credentials for the offline examples below.
- Windows DPAPI storage requires Windows PowerShell 5.1 or newer and the current Windows user profile. Service packs may require additional dependencies or a browser runtime.

## Quick start

Run from a fresh checkout:

```sh
git clone https://github.com/Lee-SiHyeon/web-api-playbook.git
cd web-api-playbook
npm ci --ignore-scripts
npm run doctor
```

`doctor` checks the runtime, required files, and dependencies. It does **not** log in or validate a service session.

### Try the synthetic examples—no network or login

After installation, these commands only inspect files included in the repository:

```sh
node scripts/har-to-contracts.mjs --input=examples/sanitized.har.json
node scripts/discover-html.mjs --input=examples/navigation.html --base=https://example.invalid/
node scripts/playbook.mjs describe --profile=templates/profile-v2.example.json
node scripts/playbook.mjs tools --profile=templates/profile-v2.example.json
```

Expected results:

| Command | What it produces |
|---|---|
| `har-to-contracts` | An `xhr-contract-inventory-v1` inventory of request fields, response types, and status codes—not token or body values. |
| `discover-html` | An `xhr-html-candidates-v1` list of candidates with `liveNetworkUsed: false`; discovery is not a successful live request. |
| `playbook describe` | Operation definitions and typed inputs from the synthetic profile. |
| `playbook tools` | Tool definitions derived from the same profile. |

The `example.invalid` profile demonstrates structure only. Replace it with an observed, validated service contract before trying `run`, `check`, `flow`, or `collect`.

## Choose your next step

| Goal | Start here |
|---|---|
| Use an existing service | `node scripts/playbook.mjs list --all`, then the [service CLI guide](references/service-cli.md). Listing does not log in or send network requests. |
| Add a new HTTP workflow | [Discovery tools](references/discovery-tools.md), [operation runtime](references/operation-runtime.md), and [profile template](templates/profile-v2.example.json). |
| Connect an MCP client | Use `node` with absolute paths to `scripts/playbook.mjs`, `mcp`, and `--profile=...`; see the [MCP section](references/operation-runtime.md#mcp). The server implements a documented stdio subset, not automatic client registration. |
| Use the playbook with an agent | Read [SKILL.md](SKILL.md). `npm run install:skill` installs a local copy; see the [Korean installation guide](README.md#codex-스킬로-설치) for destinations and update behavior. |
| Understand a failure or verify a write | [Write and reconciliation](references/write-and-reconcile.md), [case studies](case-studies/README.md), and [verification records](verification/README.md). |

The detailed guides are currently primarily in Korean. The [Korean README](README.md) is the full navigation index.

## Service scope and experimental boundaries

Start with the [service-pack index](service-packs/README.md). Packs include fixed snapshots of implementations for [Naver](service-packs/naver/README.md), [Tistory](service-packs/tistory/README.md), [affiliate services](service-packs/affiliate/README.md), [X / Reddit](service-packs/social-x/README.md), and [Threads](service-packs/threads/README.md). Root-level adapters cover additional selected services; the [service CLI guide](references/service-cli.md) explains connected, unconnected, and scope-only entries.

- A connected adapter is **not** a promise that every feature of a website works.
- Authentication, publication, upload, and recovery are separate capabilities. Follow each pack's README; root installation does not install all pack dependencies.
- Some standalone scripts are optional external integrations. The Meta session helper requires a separate `affiliate-content-operations` checkout via `ACO_ROOT` or a sibling directory; see [portability](references/portability.md#선택형-외부-연동). This is not required by the core offline tools.
- The v2 operation runtime is an additional layer, not a replacement for every existing adapter. Unbound authentication or write operations fail explicitly rather than silently falling back to arbitrary requests.
- Templates and local regression tests are synthetic. Historical live evidence does not guarantee current service availability. Partially implemented and experimental workflows retain their documented limits.
- HTTP-only operations and browser-assisted workflows are labeled separately. This repository does not claim universal login, CAPTCHA handling, or support for all sites.

## Session storage

Authentication is separate from source installation. Keep credentials, captured sessions, raw HAR files, encryption keys, and runtime outputs outside the source checkout.

| Mode | Boundary |
|---|---|
| **Windows DPAPI** | Default core persistent backend on Windows, bound to the current Windows user context. Copying the repository does not transfer that authentication. |
| **Opt-in encrypted files** | On macOS/Linux, select `PROTECTED_STORE_PROVIDER=file` for the core AES-256-GCM backend. This is file encryption, **not** integration with Keychain or Secret Service. |
| **stdin / process memory** | `--session-stdin` accepts a session for that process. Rotated values do not persist automatically across restarts. |

The file backend accepts `PROTECTED_STORE_KEY` (a base64-encoded 32-byte key) or `PROTECTED_STORE_KEY_FILE`. Otherwise, it creates `~/.config/xhr-to-api-only/protected-store.key`. Protect both the key and the sealed files; a locally stored key is not equivalent to OS-bound storage. Service packs retain their own provider formats and are not automatically interchangeable. See the [Korean session guide](README.md#4-3-쿠키토큰-보호-저장-및-재사용) and [storage implementation](lib/protected-store.mjs).

## Tests and evidence

The offline Quick Start above only needs Node.js. The **full root regression suite (`npm test`) also requires a Python 3 interpreter** for the Olive Young worker tests. Those offline tests use the Python standard library and mock sessions; the live HTTP dependency `curl_cffi` is not required for these tests.

```sh
npm run test:operations
npm run test:services
npm test
```

The tests select Python from `WEB_API_OLIVEYOUNG_PYTHON`, then the checkout's `.venv-oliveyoung`, then `python3` on PATH. A fresh Windows checkout does not include that virtual environment, and a Microsoft Store execution alias is not a working interpreter. In PowerShell, point to an installed Python executable:

```powershell
$env:WEB_API_OLIVEYOUNG_PYTHON = 'C:/path/to/python.exe'
& $env:WEB_API_OLIVEYOUNG_PYTHON --version
npm test
```

Replace the placeholder path with your installed interpreter. On macOS/Linux, a working `python3` on PATH needs no override. Service-pack tests and browser runtimes have their own prerequisites; follow each pack's guide separately.

The [offline CI workflow](.github/workflows/offline-checks.yml) runs installation, `doctor`, root regression tests, and the MyRealTrip pack compatibility test on Ubuntu with Node.js 24. Its badge reports the workflow's actual status; it is not a live-service health indicator. Windows-native storage and account-authenticated operations require separate verification.

See [checklists](checklists/README.md) for capability coverage and [verification](verification/README.md) for evidence and its scope. A passing local test is not evidence of a successful login, public publication, or production deployment.

## Ownership and license status

`package.json` currently declares `private: true` and `license: "UNLICENSED"`. [NOTICE.md](NOTICE.md) describes private reuse and does not grant a new open-source license for redistribution or relicensing. Repository visibility and license permissions are separate; this README does not change either.

Original sources and adaptation records are documented in [provenance](provenance/README.md). Third-party dependencies retain their own licenses.
