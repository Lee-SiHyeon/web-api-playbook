# Claude community assistant

Feature requests and improvement PRs or Discussions are welcome in
[`Lee-SiHyeon/web-api-playbook`](https://github.com/Lee-SiHyeon/web-api-playbook).

## Two complementary cloud routines

| Routine | Intake | Intended behavior |
| --- | --- | --- |
| `web-api-playbook-pr-assistant` | Native GitHub PR events, owner-authored non-draft PRs targeting `main` only | Review the exact head, run offline tests, and propose narrow regression fixes in separate draft PRs. |
| `web-api-playbook-community-assistant` | Hourly scan of open PRs and Discussions | Read community proposals as data, review external PRs without executing their code, and propose small, well-defined improvements from trusted `main` in separate draft PRs. |

**Community routine status: configuration and end-to-end verification pending.**
This document is not proof that a remote routine is installed or enabled.

GitHub Discussions are enabled. The native Claude GitHub trigger currently supports
PR and release events, not Discussion events, so community intake uses an hourly
cloud schedule rather than an immediate Discussion webhook. Scheduled execution is
subject to Claude account usage and concurrency limits; this is not a response-time
guarantee. It does not need a running personal computer or a GitHub Actions runner.

## What contributors can expect

- Share expected behavior, the current problem, and a minimal sanitized example.
- Automated replies identify themselves as Claude automation even though they use
  the maintainer's connected GitHub identity.
- Small, actionable suggestions may become **draft** pull requests linked to the
  source Discussion or PR. Ambiguous or large proposals receive questions or a
  plan instead; every suggestion is not automatically implemented.
- Existing PR implementations are reviewed rather than duplicated in competing PRs.
- **No automatic merge, approval, close, or push to a contributor's branch or `main`.**
- No live login, publishing, purchases, or other real-account operations are run.

## Isolation and deduplication

The community routine has a schedule only, not a PR-head GitHub trigger. Cloud
scheduled runs start from the repository's default branch, currently `main`. This
matters because repository startup hooks may execute before the saved prompt.
Changing the default branch or adding startup hooks requires reviewing this setup.

External PR heads, forks, attachments, and their agent configuration are never
checked out or executed by community intake. Their metadata and diffs are fetched
through GitHub and treated as untrusted data, not instructions. Any independently
implemented improvement starts from the verified `origin/main` SHA. This preserves
the owner filter on the existing event-driven routine instead of widening it to
untrusted PR heads.

The intended configuration for both routines uses the dedicated `web-api-playbook-pr-offline` environment, with
restricted network access, no configured environment secrets, and no MCP connectors.
The environment has no setup script. PR-comment publication has been verified for
the existing routine; Discussion read/reply and community draft publication require
separate first-use checks. Missing permissions are reported as blocked, not fixed
by expanding credentials or repository permissions automatically. Task-level
restrictions are behavioral rules, not a claim that
GitHub grants a read-only credential; repository rulesets remain separate controls.

Community work is bounded per run and deduplicated using source identity/content
and trusted automation records, not just `updatedAt` (the bot's own comments update
that timestamp). The saved prompt defines exact eligibility, pagination, unchanged
item handling, concurrency claims, stale-source checks, and reporting requirements.

## Offline validation

New code uses Node 24+ and Python 3, installs root **and Tistory** dependencies before
root tests, and runs the doctor, root suite, MyRealTrip compatibility test, and
affected pack suites. Test commands must record exit codes and pass/fail/skip counts.
Infrastructure errors and unrun checks are reported, never described as passes.
An informational Discussion reply does not require or imply a code-test run.

## Configuration and disabling

The exact task policy is stored in
[`claude-community-assistant-prompt.txt`](claude-community-assistant-prompt.txt).
The routine, schedule, environment, and GitHub connection are remote account
configuration; cloning this repository does not enable them.

Open [Claude cloud routines](https://claude.ai/code/routines), select the relevant
routine, and turn it off to stop future automatic starts. Check already-running
sessions separately. The two routines must be disabled independently.

## Sources

- [Claude scheduled tasks: supported events, schedules, startup branch, and limits](https://code.claude.com/docs/en/routines)
- [Community welcome discussion](https://github.com/Lee-SiHyeon/web-api-playbook/discussions/6)
