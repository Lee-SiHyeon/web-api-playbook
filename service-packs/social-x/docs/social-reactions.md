# Social reactions collection

## X

`{"operation":"conversation","postId":"2102069815225586149"}` through the existing CLI/provider or one-shot `scripts/session-run.mjs` collects the observed TweetDetail first page. The decoder retains each author, canonical URL, parent ID, timestamp and metrics; quoted, promoted and unconnected tweets are excluded. Connected official-author continuation posts are retained and must be distinguished from independent reactions.

This is relevance-ranked and incomplete. Cursors are reported, not automatically replayed. No full-thread or sentiment-representativeness claim. Unknown metrics remain null. No reaction publishing operation was added.

2026-09-21T23:54:20Z: browser session bootstrap followed by independent Node HTTP GET returned 200 (222580 bytes). Receipt SHA256: 981929d77b9754902353600d28bdc8fe8f9a9c74f9c01fd134d3159dc4a8c00f. Sanitized normalized evidence is in the blog research folder, not credentials in Git. Request transaction headers are consumed once.

## Reddit

Documented OAuth reader: `node scripts/collect-reddit.mjs search "Grok 4.7"` or `node scripts/collect-reddit.mjs comments 1wmgudm`. Provide existing authorized `REDDIT_ACCESS_TOKEN` and descriptive `REDDIT_USER_AGENT` in the invoking process environment. No token creation or persistence. Search is post search, not global comment search. Comments retain hierarchy and unresolved `more` counts; removed/deleted bodies are omitted while their visible descendants remain.

API contracts: https://www.reddit.com/dev/api/ . OAuth origin is fixed; redirects, non-JSON, 401/403 and 429 fail closed without retries. Current live status: anonymous JSON reads returned 403 and the normal browser showed a humanity check. No authorized OAuth replay is claimed. Public web-reader excerpts can support attributed reactions but must be stored as `web_public_excerpt`, HTTP status unknown, never as API evidence. No alternate host/proxy/challenge bypass.

## Reuse

Keep official claims, individual use reports, opinions and speculation distinct. Store checked time, canonical URL, source method and sample limits. No automated sentiment percentages from a selected ranked page. Add another platform only after observing or reading its own supported contract and recording a real replay.
