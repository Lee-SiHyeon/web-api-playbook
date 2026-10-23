// A complete list observation is separate from once-only action receipts.
// Absence does not prove whether an account unfollowed, blocked, or deactivated.
export function observeFollowers(state, scan) {
  if (!scan.complete) return { applied: false, reason: 'incomplete_scan' };
  state.relationships ||= {};
  const present = new Set(scan.items.map(u => u.id));
  const at = scan.checkedAt;
  for (const user of scan.items) {
    const previous = state.relationships[user.id];
    state.relationships[user.id] = { ...previous, handle: user.handle, blueVerified: user.blueVerified,
      followsMe: user.followsMe, following: user.following, pending: user.pending,
      firstSeenAt: previous?.firstSeenAt || at, lastSeenAt: at, checkedAt: at,
      missingScans: 0, visibility: 'present',
      returnedAt: previous?.visibility === 'absent_confirmed' ? at : previous?.returnedAt };
  }
  for (const [id, relation] of Object.entries(state.relationships)) {
    if (present.has(id)) continue;
    if (relation.checkedAt === at) continue;
    relation.missingScans = (relation.missingScans || 0) + 1;
    relation.checkedAt = at;
    relation.visibility = relation.missingScans >= 2 ? 'absent_confirmed' : 'absence_pending';
    relation.firstMissingAt ||= at;
    // Do not overwrite a known relationship with an inferred unfollow.
  }
  return { applied: true, absentConfirmed: Object.values(state.relationships).filter(r => r.visibility === 'absent_confirmed').length };
}
export function classifyParticipation({ followsMe, liked, reposted, processed = false, pending = false }) {
  if (processed) return 'processed_once';
  if (pending) return 'follow_request_pending';
  if (followsMe === true) return liked === true && reposted === true ? 'follower_and_both_reactions' : 'follower_waiting_for_reactions';
  if (liked === true || reposted === true) return 'reaction_waiting_for_follow';
  return 'not_participating';
}
