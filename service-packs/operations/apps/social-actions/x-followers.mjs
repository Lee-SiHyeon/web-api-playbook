import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { withXReadContext, XSocialActionError } from './providers/x.mjs';

const fail = code => { throw new XSocialActionError(code); };
export function decodeFollowers(data) {
  const instructions = data?.data?.user?.result?.timeline?.timeline?.instructions;
  if (!Array.isArray(instructions) || data.errors?.length) fail('X_FOLLOWERS_SCHEMA');
  const users = new Map(); let cursor = null;
  const visit = content => {
    if (content?.cursorType === 'Bottom') cursor = typeof content.value === 'string' ? content.value : null;
    const item = content?.itemContent || content;
    const u = item?.user_results?.result;
    if (item?.promotedMetadata || content?.promotedMetadata || u?.__typename !== 'User') return;
    const handle = u.core?.screen_name ?? u.legacy?.screen_name;
    if (!/^\w{1,15}$/.test(handle || '') || !/^\d{1,25}$/.test(u.rest_id || '')) fail('X_FOLLOWERS_IDENTITY_INVALID');
    const relation = u.relationship_perspectives || {};
    const bool = value => typeof value === 'boolean' ? value : null;
    const following = bool(relation.following);
    const followsMe = bool(relation.followed_by);
    const pending = bool(u.follow_request_sent);
    users.set(u.rest_id, { id: u.rest_id, handle, name: u.core?.name ?? u.legacy?.name ?? null,
      blueVerified: u.is_blue_verified === true, protected: u.privacy?.protected === true,
      url: `https://x.com/${handle}`, following, followsMe, pending,
      notFollowingBack: followsMe === true && following === false && pending === false,
      relationshipKnown: [following, followsMe, pending].every(value => value !== null) });
  };
  for (const instruction of instructions) {
    for (const entry of instruction.entries || (instruction.entry ? [instruction.entry] : [])) {
      visit(entry.content); for (const child of entry.content?.items || []) visit(child.item);
    }
    for (const child of instruction.moduleItems || []) visit(child.item);
  }
  return { items: [...users.values()], cursor, terminatedBottom: instructions.some(i => i.type === 'TimelineTerminateTimeline' && i.direction === 'Bottom') };
}

export async function readFollowers({ maxPages = 10, onlyNotFollowingBack = false, blueOnly = false } = {}, { withContext = withXReadContext, contract } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50 || typeof onlyNotFollowingBack !== 'boolean' || typeof blueOnly !== 'boolean') fail('X_FOLLOWERS_INPUT');
  contract ||= JSON.parse(await readFile(new URL('./contracts/x-followers.json', import.meta.url), 'utf8'));
  if (contract.origin !== 'https://x.com' || !/^\/i\/api\/graphql\/[\w-]+\/Followers$/.test(contract.path)) fail('X_FOLLOWERS_CONTRACT_INVALID');
  return withContext(async context => {
    if(context.followersContract&&(context.followersContract.missing?.length||!/^[A-Za-z0-9_-]+$/.test(context.followersContract.queryId||'')))fail('X_FOLLOWERS_CONTRACT_INVALID');
    const activeContract=context.followersContract&&!context.followersContract.missing?.length
      ? {...contract,path:`/i/api/graphql/${context.followersContract.queryId}/Followers`,features:context.followersContract.features}:contract;
    const owner = await context.lookupUser(context.ownerHandle);
    const users = new Map(); const seen = new Set(); const receipts = []; let cursor; let stopReason = 'page_limit';
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(activeContract.path, activeContract.origin);
      url.searchParams.set('variables', JSON.stringify({ ...activeContract.variables, userId: owner.userId, ...(cursor ? { cursor } : {}) }));
      url.searchParams.set('features', JSON.stringify(activeContract.features));
      const r = await context.request('GET', url.pathname, url.href);
      const receipt = { operation: 'Followers', httpStatus: r.status, origin:url.origin,path:url.pathname,page:page+1,hasCursor:Boolean(cursor),mime:(r.headers['content-type']||'').split(';')[0],browserUsed: false, executionMode: 'pure_http' };
      receipt.bodyBytes=Buffer.byteLength(r.raw||'');receipt.rateLimitReset=/^\d+$/.test(r.headers['x-rate-limit-reset']||'')?Number(r.headers['x-rate-limit-reset']):null;
      if(r.status!==200)try{receipt.errorCodes=(JSON.parse(r.raw).errors||[]).map(e=>e.code).filter(Number.isInteger);}catch{}
      receipts.push(receipt);
      if (r.status !== 200 || !r.headers['content-type']?.includes('json')) throw new XSocialActionError('X_FOLLOWERS_READ_REJECTED', receipt);
      let payload; try { payload = JSON.parse(r.raw); } catch { fail('X_FOLLOWERS_SCHEMA'); }
      const decoded = decodeFollowers(payload);
      receipt.items = decoded.items.length;
      receipt.terminatedBottom = decoded.terminatedBottom;
      for (const user of decoded.items) users.set(user.id, user);
      const next = decoded.cursor;
      if (decoded.terminatedBottom || !next || next === '0') { cursor = null; stopReason = 'exhausted'; break; }
      if (seen.has(next)) { cursor = next; stopReason = 'repeated_cursor'; break; }
      seen.add(next); cursor = next;
    }
    const all = [...users.values()];
    return { ownerHandle: context.ownerHandle, items: all.filter(u => (!onlyNotFollowingBack || u.notFollowingBack) && (!blueOnly || u.blueVerified)),
      blueNotFollowingBackCount: all.filter(u => u.notFollowingBack && u.blueVerified).length,
      followerCountRead: all.length, notFollowingBackCount: all.filter(u => u.notFollowingBack).length,
      mutualCount: all.filter(u => u.following === true && u.followsMe === true).length,
      pendingCount: all.filter(u => u.pending === true).length, unknownRelationshipCount: all.filter(u => !u.relationshipKnown).length,
      complete: stopReason === 'exhausted', hasMore: Boolean(cursor), stopReason, pages: receipts.length, receipts,
      checkedAt: new Date().toISOString(), writes: 0 };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ ok: true, ...await readFollowers({ onlyNotFollowingBack: process.argv.includes('--not-following-back'), blueOnly: process.argv.includes('--blue-only') }) }, null, 2)); }
  catch (e) { console.log(JSON.stringify({ ok: false, code: /^[A-Z0-9_]+$/.test(e.code || '') ? e.code : 'X_FOLLOWERS_FAILED', ...(e.receipt ? { receipt: e.receipt } : {}) })); process.exitCode = 1; }
}
