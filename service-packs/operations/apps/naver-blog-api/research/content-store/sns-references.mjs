// SNS writing references: accounts people cite for AI and trend content, with audience size where it is public.
// Usage: node sns-references.mjs --discovery=<a.json>[,<b.json>] [--min-followers=1000] --out=<sns-references.json>
//
// Discovery files are research results ({accounts:[{platform, handle, profile_url, display_name, field, why_referenced,
// evidence_urls, follower_hint, language}]}), for example from a Codex research job. This script measures what can be read
// anonymously and records the rest as reported by the cited source (observed 2026-09-25):
//   YouTube   channel page shows "구독자 N만명"                  → measured
//   Instagram / Threads  follower count needs a login           → reported only
//   TikTok    profile returns a WAF challenge page               → reported only (no bypass)
//   X         needs a login                                      → reported only
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UNITS = { 천: 1e3, 만: 1e4, 억: 1e8, k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 };

// "74.8만명", "1.2M followers", "12,345" → number; the first count in the text wins.
export function parseCount(s) {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(천|만|억|[kKmMbB](?![a-z]))?/.exec(String(s ?? ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '')) * (UNITS[m[2]] ?? 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Only the channel header counts: the page also lists featured channels whose "구독자 N명" can come first.
export function parseYoutubeSubscribers(html) {
  // The key also appears in a script config earlier in the page; take the first occurrence followed closely by a count.
  const src = String(html);
  for (let at = src.indexOf('"pageHeaderViewModel"'); at >= 0; at = src.indexOf('"pageHeaderViewModel"', at + 1)) {
    const m = /구독자\s*([\d.,]+\s*[천만억]?)\s*명/.exec(src.slice(at, at + 8000));
    if (m) return parseCount(m[1]);
  }
  return null;
}

const key = a => `${a.platform}:${String(a.handle).replace(/^@/, '').toLowerCase()}`;

export function mergeDiscovery(files) {
  const by = new Map();
  for (const f of files) for (const a of f?.accounts || []) {
    if (!a?.platform || !a?.handle || !a?.profile_url) continue;
    const k = key(a), prev = by.get(k);
    const evidence = [...new Set([...(prev?.evidenceUrls || []), ...(a.evidence_urls || [])])];
    by.set(k, { platform: a.platform, handle: String(a.handle).replace(/^@/, ''), url: a.profile_url, displayName: a.display_name ?? prev?.displayName ?? null,
      field: prev?.field ?? a.field, language: a.language ?? null, whyReferenced: prev?.whyReferenced ?? a.why_referenced ?? null,
      followerHint: prev?.followerHint ?? a.follower_hint ?? null, evidenceUrls: evidence });
  }
  return [...by.values()];
}

// minFollowers drops accounts whose follower count is known (measured or reported) and smaller; unknown counts stay.
export async function measure(accounts, { fetchImpl = globalThis.fetch, delayMs = 800, minFollowers = 0, now = () => new Date() } = {}) {
  const checkedAt = now().toISOString(), out = [];
  let youtubeBlocked = false;
  for (const a of accounts) {
    const reported = parseCount(a.followerHint);
    const row = { ...a, followersReported: reported, followers: reported, followersSource: reported == null ? null : 'reported', measureStatus: 'not_public' };
    if (a.platform === 'youtube' && !youtubeBlocked) {
      try {
        const r = await fetchImpl(a.url, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(20000) });
        if (r.status === 403 || r.status === 429) { youtubeBlocked = true; row.measureStatus = 'blocked'; }
        else if (r.status !== 200) row.measureStatus = `http_${r.status}`;
        else {
          const n = parseYoutubeSubscribers(await r.text());
          if (n != null) Object.assign(row, { followers: n, followersSource: 'measured', measureStatus: 'measured' });
          else row.measureStatus = 'not_found';
        }
      } catch { row.measureStatus = 'transport'; }
      await sleep(delayMs);
    }
    out.push(row);
  }
  out.sort((x, y) => (y.followers ?? -1) - (x.followers ?? -1));
  const kept = out.filter(a => !(minFollowers && a.followers != null && a.followers < minFollowers));
  return { schemaVersion: 1, kind: 'sns-references', checkedAt, minFollowers, accounts: kept,
    droppedSmall: out.filter(a => !kept.includes(a)).map(a => ({ platform: a.platform, handle: a.handle, followers: a.followers })),
    coverage: { accounts: kept.length, droppedSmall: out.length - kept.length, measured: kept.filter(a => a.followersSource === 'measured').length, reported: kept.filter(a => a.followersSource === 'reported').length },
    limits: 'Only YouTube subscriber counts are read directly. Instagram, Threads and X need a login and TikTok returns a WAF challenge, so their counts are as reported by the cited source.' };
}

async function main() {
  const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const files = (arg('discovery') || '').split(',').filter(Boolean).map(f => JSON.parse(readFileSync(f, 'utf8')));
  const out = arg('out');
  if (!files.length || !out) throw new Error('usage: --discovery=<a.json>[,<b.json>] --out=<file>');
  const result = await measure(mergeDiscovery(files), { minFollowers: Number(arg('min-followers') || 0) });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ out, ...result.coverage }));
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
