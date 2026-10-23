// Follow-status gate (2026-10-21, owner "이런 게이트가 없냐고"): an audit wrongly reported seol_handmade as "not a follower"
// because the follower read was first-page only (20 of 223; she is #185). Every follow-status judgment - bot decisions,
// audits, reports, summaries - goes through here. "not_follower" is only allowed from a COMPLETE paginated read
// (page.fullList===true && hasNextPage===false); a partial read gives "unknown", never "not_follower".
export const isCompleteFollowerRead = r => !!r && Array.isArray(r.followers)
  && r.page?.fullList === true && r.page?.hasNextPage === false;

export function assertCompleteFollowerRead(r) {
  if (!isCompleteFollowerRead(r)) throw Object.assign(new Error('FOLLOW_STATUS_PARTIAL_READ'), { code: 'FOLLOW_STATUS_PARTIAL_READ' });
  return r;
}

// status: mutual | follower_not_followed | not_follower | unknown
export function followStatusFromRead(r, handle) {
  const h = String(handle || '').toLowerCase();
  const f = (r?.followers || []).find(x => String(x.username || '').toLowerCase() === h);
  if (f) {
    if (f.following === true) return { status: 'mutual', followsOwner: true, following: true, source: 'list' };
    if (f.following === false) return { status: 'follower_not_followed', followsOwner: true, following: false, source: 'list' };
    return { status: 'unknown', followsOwner: true, following: null, source: 'list', reason: 'FOLLOWING_FIELD_MISSING' };
  }
  if (isCompleteFollowerRead(r)) return { status: 'not_follower', followsOwner: false, following: null, source: 'list' };
  return { status: 'unknown', followsOwner: null, following: null, source: 'list', reason: 'FOLLOW_STATUS_PARTIAL_READ' };
}

// Full-list audit: refuses to produce a not-followed-back list from a partial read.
export function auditFollowers(r) {
  assertCompleteFollowerRead(r);
  const notFollowedBack = r.followers.filter(f => f.followsOwner !== false && f.following === false && f.outgoingRequest !== true).map(f => f.username);
  const pending = r.followers.filter(f => f.following === false && f.outgoingRequest === true).map(f => f.username);
  return { complete: true, followers: r.followers.length, mutual: r.followers.filter(f => f.following === true).length, notFollowedBack, pending };
}
