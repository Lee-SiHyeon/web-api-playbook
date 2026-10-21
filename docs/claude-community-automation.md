# Claude community assistant

Feature requests and improvement PRs or Discussions are welcome in
[`Lee-SiHyeon/web-api-playbook`](https://github.com/Lee-SiHyeon/web-api-playbook).

## Two complementary cloud routines

| Routine | Intake | Intended behavior |
| --- | --- | --- |
| `web-api-playbook-pr-assistant` | Native GitHub PR events, owner-authored non-draft PRs targeting `main` only | Review the exact head, run offline tests, and propose narrow regression fixes in separate draft PRs. |
| `web-api-playbook-community-assistant` | Hourly scan of open PRs and Discussions | Read community proposals as data, review external PRs without executing their code, and propose small, well-defined improvements from trusted `main` in separate draft PRs. |

## Verified configuration and rollout status

- **Community routine:** [`web-api-playbook-community-assistant`](https://claude.ai/code/routines/trig_013tXQP5adCLwsNu12EYkxiw).
- **Schedule:** `17 * * * *` UTC (minute 17 of every hour, including KST).
- **Only source repository:** `Lee-SiHyeon/web-api-playbook`, default branch `main`.
- **Environment:** `web-api-playbook-pr-offline` (`env_012DnRENpTcdYrcDYmtnUgkr`).
- **Connectors:** zero, verified after creation; account-default connectors were removed before any run.
- **Saved policy:** full prompt read-back matched the committed text after LF normalization.
- **Activation: disabled pending Discussion connector authorization and verification.**
- **First manual check:** session `session_015cbbEjR6To2aVf1tVRCz3c` launched with `verify_discussion:6` and stopped without posting. The native GitHub proxy rejected `gh api graphql` with HTTP 403. No Discussion was read, no reply was posted, and no tests or draft publication ran. This is a capability blocker, not a successful integration check.
- **Separate MCP connection:** the official GitHub MCP connector setup reached GitHub's `Confirm access` step. Account reauthentication, repository-scoped App installation, routine attachment, and read/reply verification remain unfinished. No PAT was copied into the cloud environment.
- **Not yet demonstrated:** a community-generated implementation, draft publication, an external-contributor PR review, and a timed hourly run.

Local documentation-change regression check on Windows / Node 24.22.0:
doctor exit 0; root tests **1,266 total, 1,263 pass, 0 fail, 3 skip**, exit 0;
MyRealTrip compatibility **14 pass, 0 fail**, exit 0. No service-pack suites or live
operations were rerun for these documentation-only changes.

GitHub Discussions are enabled. The native Claude GitHub trigger currently supports
PR and release events, not Discussion events, so community intake uses an hourly
cloud schedule rather than an immediate Discussion webhook. Scheduled execution is
subject to Claude account usage and concurrency limits; this is not a response-time
guarantee. It does not need a running personal computer or a GitHub Actions runner.

There are two distinct prerequisites: an event/schedule trigger and an API capable
of reading the content. The Claude native GitHub proxy blocks GraphQL, including
the API used by GitHub Discussions. A working PR connection does not imply
Discussion support. The separate official GitHub MCP connector is being configured;
the community timer is **not enabled** until that path is verified.

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

Both routines are configured to use the dedicated `web-api-playbook-pr-offline` environment, with
restricted network access, no configured environment secrets, and no MCP connectors.
The environment has no setup script. PR-comment publication has been verified for
the existing routine; Discussion read/reply and community draft publication require
separate first-use checks. Missing permissions are reported as blocked, not fixed
by expanding credentials or repository permissions automatically. Task-level
restrictions are behavioral rules, not a claim that
GitHub grants a read-only credential; repository rulesets remain separate controls.

Community work is bounded by the task policy (three responses, one draft PR, and
a 40-minute deadline per run). No platform-enforced singleton or hard timeout was
verified; comment publication is not guaranteed exactly once under overlapping runs.
Work is deduplicated using source identity/content
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
- [Claude cloud GitHub proxy: GraphQL restrictions](https://code.claude.com/docs/en/cloud-environments#github-proxy)
- [Official Anthropic GitHub MCP connector app](https://github.com/apps/claude-github-mcp-connector)
- [Community welcome discussion](https://github.com/Lee-SiHyeon/web-api-playbook/discussions/6)
