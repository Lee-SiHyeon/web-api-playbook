# Recursive API and wiki discovery

Start from the requested portal/menu subtree or project. A map request does not authorize transactions or bulk collection of employee records. Existing catalog operations are seeds, not proof of current authentication.

Before browser discovery, resolve the current provider and protected HTTP probe
with [browserless-login-flow.md](browserless-login-flow.md). Reuse a verified
session and adapters across the restored frontier. A tool/attachment failure is
a runtime checkpoint, not proof that login expired or permission was lost.

## Root selection and scope fidelity

For “from home”, “whole site”, or “all categories”, establish the homepage as the root and inspect the global category/menu entry, including hover, expand, or lazy-loaded navigation. A page's initially visible anchors may omit its menu tree. For an explicitly scoped subtree, retain that subtree as the root instead; do not expand unrelated scope.

Breadcrumbs reveal one ancestry chain. They do not establish the root's siblings, all descendants, or the whole site's taxonomy. Preserve them as observed edges, then discover the requested root's remaining branches. Cross-links, promotional collections, and global navigation must not all be labeled as child categories.

Keep identifier namespaces separate: a UI component ID, category URL ID, and request context selector can all differ. Capture their actual mapping from the control, request and response; never substitute a URL ID for a component selector. Merge verified lazy-loaded branches with the global frontier using observed parent URLs. If their ancestors are absent from the global menu response, retain the observed breadcrumb provenance instead of dropping the branch or inventing its ancestry. An earlier successful replay remains historical when the same contract later fails.

Traverse structural menu containers even when their own URL is absent, external, or outside the category URL pattern: inspect their observed children before deciding which destinations belong in scope. Record excluded destinations and reasons. A URL filter must not silently discard an entire descendant branch. A menu node with no visible children is only a navigation leaf; inspect its listing before treating it as a terminal catalog category.

For catalog discovery, track home → root categories → subcategories → leaf listings → listing pagination → exact product options → details/review pagination as distinct edge types. These are stages to inspect, not assumed routes or guaranteed page structures. Exclude cart, checkout, review submission and other mutations from read-only traversal.

Once a listing/detail/review contract is observed and independently replayed, build a parameterized direct HTTP adapter and queue its observed identifiers. Do not keep manually browsing one product at a time when the shared adapter can do the work. Inspect a new representative page only for a genuinely new contract, schema, or failed assumption. HTML document responses may be traversable HTTP contracts, but label them HTML; do not call them captured XHR/JSON APIs or silently substitute them when the user requires JSON-only.

Reuse the live discovery connection across pages. Do not create a new debugging connection for each operation. Check transport, target attachment and application authentication separately; a stale browser inventory or successful socket is not proof of current account state.

If independent replay returns 403 while normal browsing works, retain the observed status and mark the cause unknown unless evidence identifies it. Do not label it an authentication failure merely from the status, repeatedly retry the unchanged request, or work around access controls. Keep successful contracts usable and blocked branches resumable; browser success does not verify an API-only adapter.

Maintain a resumable queue with canonical URL or contract key, parent, edge type, depth, state, attempt count, and stop reason. Useful states: pending, inspected, candidate, request_observed, replay_verified, blocked_auth, blocked_runtime, out_of_scope, budget_deferred, mutation_excluded.

Before resuming, inspect persisted state and collector health. Deduplicate shared shell/iframe routes while preserving incoming parent edges and meaningful nonsecret selectors. Report unique pages, navigation edges and unique contracts independently. A pending queue containing duplicate iframe links is not a count of distinct unexplored features. Persist last_attempt_at and evidence_source (DOM, network, source or direct replay); a DOM visit must not upgrade a network contract to captured.

Use breadth-first traversal and deduplicate URLs without fragments. Contract identity includes method, host, normalized path, query/body field names, encoding, and nonsecret operation selectors. Keep distinct selectors on one endpoint distinguishable. Bind account-dependent exploration to its authorized actor.

Record edges such as menu→page, page→script, script→script, page→request, request→schema, and operation→adapter. A shared hostname does not prove a data dependency.

Set a task-appropriate per-run request, time, response-size and concurrency budget. A depth limit is a run boundary, not evidence that deeper descendants do not exist. Persist deferred work with its reason and resume it in subsequent authorized runs. Do not quietly replace whole-site scope with a fixed-depth sample. Distinguish frontier exhaustion from budget exhaustion. Resume pending branches rather than restarting.

## Execution and completion criteria

### Scope acceptance checks

Apply these checks to the actual saved frontier and receipts, not just the proposed algorithm:

- Given a home-wide request and an open leaf product, the saved root remains the homepage; root discovery records all observed top-level siblings. An ancestry chain alone fails this check.
- Given several categories served by one verified endpoint, queue each observed category identifier and record its own replay result. One endpoint contract does not mark the other categories processed.
- Given a listing with another page, retain that page as pending even when the current run stops. A navigation leaf or first-page sample is not a completed product inventory.
- Given an interruption or local branch failure, resume the checkpoint with unresolved siblings intact. Record a shared failure boundary when applicable; do not discard branches or restart from a convenient product search.
- Given exhausted navigation but pending listings, options, or requested reviews, report navigation completion and overall partial coverage separately. Never report a percentage of the whole catalog from an unknown denominator.

If a previous run narrowed the scope accidentally, repair it by retaining valid branch evidence, restoring the requested root, enumerating missing root branches, and queuing the unvisited work. Report that correction explicitly and execute the next available queued read; do not substitute another plan or skill update for traversal.

### Home-rooted execution loop

For a request such as “홈에서부터 재귀탐색”, execute this loop within the authorized scope:

1. Restore the root scope and existing frontier. On the initial run, observe the home's global navigation and enqueue every discovered in-scope root branch before pursuing the currently open breadcrumb path. If the root menu cannot be enumerated, record root discovery as incomplete.
2. Process queued branches breadth-first. For each response, persist its verified child edges and next-page/cursor work, then advance that node's checkpoint. Reuse a shared adapter across observed identifiers; retain per-node evidence even when the contract is identical.
3. Continue from navigation leaves into the requested resource stages, including listings and their pagination. Product options, details and reviews are separate queues when requested. Neither one successful category nor a keyword search replaces the remaining category inventory.
4. On interruption, budget exhaustion or a blocked contract, save the exact continuation and unresolved siblings. Continue independent usable branches when the failure is local; pause requests sharing the failing boundary when evidence indicates a shared failure. Do not label a saved queue as an executing background job.

Save a coverage receipt alongside the frontier with the requested root, root-discovery status, included stages, checkpoint reference, per-stage discovered/processed/pending/blocked/deferred counts, observed pagination termination evidence, and next work item. State the completion scope and observation time. Unknown totals remain unknown. A home-wide completion claim requires root discovery and all included queues to be exhausted with no unresolved work; counts of contracts, menu nodes or sampled products cannot substitute for that evidence.

Persist the traversal's scope together with its queue: requested root, included resource stages, observation time, and any explicit user exclusions. On restart, restore that scope before selecting work. A browser tab change, a convenient working endpoint, or a failed sibling must not rewrite the scope. For example, home → electronics → laptop accessories supplies one path to resume; it does not replace the home's remaining category branches.

A contract is not a traversal checkpoint. Keep the reusable request/schema definition separate from per-node execution state and pagination. Replaying one category selector verifies that invocation, not every category using the endpoint. Report discovered, successfully processed, pending, blocked, and deferred counts for each requested stage; use an unknown total where the site has not exposed an enumerable boundary.

For each queued node, use its verified adapter when available; otherwise discover the missing contract through the existing authorized browser session. Save newly observed children and pagination tokens before advancing the checkpoint. Keep nonterminal containers and shared categories traversable while deduplicating fetches, preserving all parent edges. Persist failed or deferred nodes as well as successes so interruption cannot silently drop a branch.

For each listing or review collection, record the observed termination condition (for example, an explicit next-page flag or exhausted cursor), visited page/cursor identities, and deduplicated result IDs. Do not invent pagination parameters. A repeated cursor or repeated page is a stalled traversal to investigate, not proof of completion. Totals may change while crawling; retain observation times and reconcile mismatches instead of asserting a permanent complete inventory.

Validate relationship semantics as well as HTTP status. A descendant request can return the root menu or another fallback with HTTP 200; do not attach those nodes as children or keep issuing sibling requests after detecting the fallback. An omitted expansion flag is not universally false: establish its meaning from the observed service/UI contract, and preserve inline children when present. If a mistaken assumption polluted a checkpoint, preserve the original receipts, rebuild from valid edges, and distinguish this evidence repair from new live traversal.

Report separate counts and unresolved work for root-navigation branches, category listings/pages, exact product options/details, and review pages when those are in scope. Menu-tree completeness does not imply listing completeness; listing completeness does not imply detail or review completeness. A single reusable endpoint can cover many nodes, but only actual successful replays advance their coverage.

Mark a run complete only for its stated bounded scope. Whole requested traversal remains partial while any in-scope node or pagination segment is pending, blocked, deferred, or stalled. Exclusions require a reason consistent with the requested scope; a failed request is not an exclusion. Save the next resumable work item and the blocking boundary. Future execution requires a real runner or an authorized schedule; a saved queue alone is not running automation.

1. Confirm the actual authorized execution route. If the current tool or service rejects the caller, record the first failing boundary; do not reuse another actor's credentials or assume the stored session expired.
2. Inspect observed entry pages and scripts/imports. A SPA shell does not prove menus are absent or authentication succeeded.
3. Follow observed nested menus, routes, and lazy modules. Source strings are candidates, not verified endpoints. Check scope and authentication separately for cross-host links.
4. For missing contracts, use one authorized read-only browser discovery lifecycle. Prefer normal navigation and capture requests produced by page loads. Avoid submit/save/approve and unknown controls. Classify semantics, not HTTP method alone: GET can mutate and POST can query.
5. Retain sanitized contract metadata and provenance, not secrets or raw personal records.
6. Independently replay reviewed read contracts with the current authorized client. Validate application responses and schema; reject login HTML or SPA fallbacks.
7. Continue through newly observed menus/modules/contracts. Preserve pending siblings when authentication, runtime, scope, or budget blocks a branch.

Deliver JSON and, when requested or useful, an HTML map with provenance, state, and unresolved frontier. Count fetched assets, source candidates, observed XHR contracts, adapter operations, and verified replays separately. Report all five conversion states. Do not claim recursive coverage while scoped branches remain pending.

Completion must account for the root navigation and every discovered in-scope branch: inspected, replayed, excluded with a reason, or still pending/blocked. Save the frontier before ending a run; report budget exhaustion as partial traversal, never as whole-site coverage. The queue must retain parent edges, canonical identity, depth, pagination cursor, attempt state and evidence references so another run resumes rather than starts over. If the site's searchable inventory cannot be exhaustively enumerated, state that limitation instead of equating search totals or one subtree with the entire catalog.

The original team's `lgep_recursive_inventory.py` was not included in the supplied material and is not installed here. Build a task-specific helper only when requested or needed; never claim that helper has already captured live XHR.
