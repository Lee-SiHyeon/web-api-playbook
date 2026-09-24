# Unified Naver republication

> For the current standalone repository, use [the step-by-step publishing guide](publishing-usage.md#4-기존-글-수정). The root `npm run republish` command now loads DPAPI authentication; the one-use handoff below is an optional historical route, not the normal setup requirement.

Run from the repository root. All reusable republication orchestration lives in
`apps/naver-blog-api/workflows/republish/`; the maintained editor client and full
publication gates remain the only writer.

```powershell
npm run republish -- help
npm run republish -- status --manifest=C:/path/to/republish-manifest.json
npm run republish -- jev-quality --manifest=C:/path/to/republish-manifest.json --post=224417064414
npm run republish -- handoff --manifest=C:/path/to/republish-manifest.json --post=224417064414
```

The one-use localhost form selects baseline, upload, preview, prepare, publish or
readback and accepts an in-memory `{cookieHeader}` envelope. It checks Host,
Origin, a random nonce, request size and a three-minute lifetime. Credentials are
passed to the child through stdin, never a command argument or persistent file.
The `publish` choice cannot bypass the full publisher gate or write journal.

## Data manifest

```json
{
  "schemaVersion": 1,
  "blogId": "your_blog",
  "posts": {
    "224417064414": {
      "directory": "224417064414",
      "journal": "../original-journal"
    }
  }
}
```

Paths resolve relative to the manifest, independent of the calling directory.
Always retain the original journal when revising an existing article or reusing
uploaded media. Never make an empty replacement journal to retry a failed write.

## Revision lifecycle

| Command | Work |
|---|---|
| `baseline` | Protected owner and public backup; refuses to overwrite an existing baseline |
| `upload` | Upload missing local PNGs through the maintained media contract, hash-check, bind real receipts |
| `preview` | Exact document in native desktop/mobile editor |
| `jev-quality` | Run the active Jev editorial gate against the exact document and claim ledger; writes `jev-quality.json` |
| `assemble` | Bind document, ledger, Jev evidence and actual revision-matching independent/native reviews into the existing format-specific job |
| `prepare` | Fresh protected-state preflight |
| `authorize --approved-by=user` | Record already-obtained consent through the maintained authorizer; refuses overwriting an authorized job |
| `publish` | Full-gate HTTP update with the original journal |
| `readback` | Fresh protected owner and independent public content |
| `refresh-public` | Anonymous public refresh without a session |
| `verify` | Ordered content, images, tables, tags, title and preserved metadata; fails if public observation is stale |
| `status` | Saved verification status and its timestamp, not a fresh live verification |

Every command except status/help requires `--post` and `--manifest`. Local
Jev quality/assemble/authorize/verify and anonymous refresh-public need no session. Other
commands also accept the envelope directly on stdin when using an authorized
session provider instead of the form.

Jev is a hard quality gate for every new unified republication revision. The
gate requires a recent active remote Jev result, high-confidence answers for
evidence sufficiency, editorial quality, next action, AI-slop removal, table
use, table takeaway prose and unsupported-claim absence. Shadow mode,
deterministic fallback, provider errors, stale receipts and document or claim
ledger changes fail before assembly, authorization or HTTP publication. Jev
does not replace deterministic fact, commercial, attribution, native render,
authorization or public readback gates.

On this Windows host, the default provider is the Vercel AI Gateway Jev route
(`https://ai-gateway.vercel.sh/typesafe/v1/systemone`, model
`typesafe-ai/jev`). Its key is read from the user DPAPI store at runtime and is
never written to the repository, a command argument or a receipt.

Authoring and fact collection supply a full `job.json`, `document.json`,
`claim-ledger.json`, sources and images in the revision data directory. The
assembler does not invent reviews or regenerate factual content. A new revision
uses a new data directory and manifest entry while sharing the original journal;
retain completed revision artifacts. Do not overwrite historical authorization
or publication receipts to make a new run fit an old directory.

Current completed twelve-post data set:
`C:/Users/User/Documents/Codex/2026-09-22/all-posts-improvement/republish-manifest.json`.
Its content, sources, reviews and receipts stay in place. Superseded one-off
scripts are inventoried with hashes in the repository's ignored
`runs/republish-legacy/`; they are archival `.txt` files, not another supported
execution path. Do not create new per-post runtime/handoff/authorize/verify scripts.
