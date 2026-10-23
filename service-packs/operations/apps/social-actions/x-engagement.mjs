import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { withXReadContext, XSocialActionError } from './providers/x.mjs';
import { decodeFollowers,readFollowers } from './x-followers.mjs';
import { classifyParticipation } from './x-relationship-state.mjs';

const routes = { likes: '/i/api/graphql/HaFAhly6sDpoeqGEbFb2Ig/Favoriters', reposts: '/i/api/graphql/UBCF0EF800cPqREAeu1uuA/Retweeters' };
export function decodeEngagement(payload) {
  const instructions = payload?.data?.favoriters_timeline?.timeline?.instructions ?? payload?.data?.retweeters_timeline?.timeline?.instructions;
  if (!Array.isArray(instructions) || payload.errors?.length) throw new XSocialActionError('X_ENGAGEMENT_SCHEMA', { dataKeys: Object.keys(payload?.data || {}), childKeys: Object.fromEntries(Object.entries(payload?.data || {}).map(([k,v]) => [k, Object.keys(v || {})])), errorCodes: (payload?.errors || []).map(e => e.code) });
  return decodeFollowers({ data: { user: { result: { timeline: { timeline: { instructions } } } } } });
}
export async function readEngagement(tweetId, kind, { maxPages = 10, withContext = withXReadContext } = {}) {
  if (!/^\d{1,25}$/.test(tweetId || '') || !routes[kind] || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) throw new XSocialActionError('X_ENGAGEMENT_INPUT');
  const { features } = JSON.parse(await readFile(new URL('./contracts/x-followers.json', import.meta.url), 'utf8'));
  return withContext(async context => {
    const users = new Map(), seen = new Set(), receipts = []; let cursor; let stopReason = 'page_limit';
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(routes[kind], 'https://x.com');
      url.searchParams.set('variables', JSON.stringify({ tweetId, count: 20, enableRanking: true, includePromotedContent: true, ...(cursor ? { cursor } : {}) }));
      url.searchParams.set('features', JSON.stringify(features));
      const response = await context.request('GET', url.pathname, url.href);
      const receipt = { httpStatus: response.status, executionMode: 'pure_http', browserUsed: false }; receipts.push(receipt);
      if (response.status !== 200 || !response.headers['content-type']?.includes('json')) throw new XSocialActionError('X_ENGAGEMENT_REJECTED', receipt);
      let payload; try { payload = JSON.parse(response.raw); } catch { throw new XSocialActionError('X_ENGAGEMENT_SCHEMA'); }
      const decoded = decodeEngagement(payload); receipt.items = decoded.items.length;
      for (const user of decoded.items) users.set(user.id, user);
      const next = decoded.cursor;
      if (decoded.terminatedBottom || !next || next === '0') { cursor = null; stopReason = 'exhausted'; break; }
      if (seen.has(next)) { cursor = next; stopReason = 'repeated_cursor'; break; }
      seen.add(next); cursor = next;
    }
    return { ownerHandle: context.ownerHandle, tweetId, kind, items: [...users.values()], count: users.size, serverListExhausted: stopReason === 'exhausted', stopReason, pages: receipts.length, receipts, writes: 0, checkedAt: new Date().toISOString() };
  });
}
export async function readParticipation(tweetId) {
  return withXReadContext(async context => {
    const withContext = work => work(context);
    const likes = await readEngagement(tweetId, 'likes', { withContext });
    const reposts = await readEngagement(tweetId, 'reposts', { withContext });
    const followers = await readFollowers({}, { withContext });
    const people = new Map();
    for (const [source, items] of [['liked', likes.items], ['reposted', reposts.items], ['follower', followers.items]]) {
      for (const user of items) {
        const row = people.get(user.id) || { ...user, liked: null, reposted: null };
        row[source] = true;
        if (source === 'follower') row.followsMe = user.followsMe;
        people.set(user.id, row);
      }
    }
    for (const row of people.values()) {
      // Exhaustion proves only absence from the visible server list, not a hidden or removed reaction.
      row.visibleLike = row.liked === true; row.visibleRepost = row.reposted === true;
      row.participation = classifyParticipation(row);
    }
    return { tweetId, items: [...people.values()], likesRead: likes.count, repostsRead: reposts.count,
      listsExhausted: likes.serverListExhausted && reposts.serverListExhausted && followers.complete,
      hiddenAccountsMayBeOmitted: true, writes: 0, checkedAt: new Date().toISOString() };
  });
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { console.log(JSON.stringify(process.argv[2] === 'participation' ? await readParticipation(process.argv[3]) : await readEngagement(process.argv[3], process.argv[2]))); }
  catch (e) { console.log(JSON.stringify({ ok: false, code: /^[A-Z0-9_]+$/.test(e.code || '') ? e.code : 'X_ENGAGEMENT_FAILED', receipt: e.receipt })); process.exitCode = 1; }
}
