const validActorId = value => typeof value === 'string' && /^\d{1,25}$/.test(value);
const retroactiveStages = new Set(['base', 'bonus']);
const burstParticipantLimit = 67;

export function retroactiveGrant(state, user) {
  const members = state?.retroactiveCohort?.members;
  const member = validActorId(user?.id) && members && typeof members === 'object' && !Array.isArray(members)
    && Object.prototype.hasOwnProperty.call(members, user.id) ? members[user.id] : null;
  if (!validActorId(user?.id) || user.followsMe !== true || !members || typeof members !== 'object' || Array.isArray(members)
    || !member) return null;
  return { type: 'existing_follower_waiver', cohortId: state.retroactiveCohort.id,
    authorizedAt: state.retroactiveCohort.authorizedAt };
}

export function hasBonusQualification(user, state) {
  return Boolean(user.followsMe === true && ((user.qualifyingPostId && user.blueVerified) || retroactiveGrant(state, user)));
}

export function burstActive(state, now = Date.now()) {
  const cohortId = state?.retroactiveCohort?.id;
  const expiresAt = Date.parse(state?.retroactiveBurst?.expiresAt);
  return typeof cohortId === 'string' && cohortId.length > 0 && state?.retroactiveBurst?.cohortId === cohortId
    && Number.isFinite(now) && Number.isFinite(expiresAt) && now < expiresAt;
}

// starts remains an append-only reservation history. Count unique, valid actor
// IDs for the 67-person limit so base + bonus reservations share one person slot.
// Each malformed/anonymous legacy entry consumes a conservative slot, and this
// helper never rewrites or drops historical rows.
export function retroactiveBurstUniqueActorCount(state) {
  const starts = state?.retroactiveBurst?.starts;
  if (starts == null) return 0;
  if (!Array.isArray(starts)) return burstParticipantLimit;
  const actorIds = new Set();
  let anonymousReservations = 0;
  for (const start of starts) {
    if (validActorId(start?.id)) actorIds.add(start.id);
    else anonymousReservations++;
  }
  return actorIds.size + anonymousReservations;
}

export function reserveRetroactiveBurst(state, user, now = Date.now()) {
  if (!state || !burstActive(state, now) || !retroactiveGrant(state, user)
    || !retroactiveStages.has(user.stage)) return false;
  const starts = state.retroactiveBurst.starts;
  if (starts != null && !Array.isArray(starts)) return false;
  const hourlyStarts = state.hourlyStarts;
  if (hourlyStarts != null && !Array.isArray(hourlyStarts)) return false;
  const actorAlreadyReserved = (starts || []).some(start => start?.id === user.id);
  if (!actorAlreadyReserved && retroactiveBurstUniqueActorCount(state) >= burstParticipantLimit) return false;

  state.retroactiveBurst.starts ||= [];
  const startedAt = new Date(now).toISOString();
  state.retroactiveBurst.starts.push({ id: user.id, stage: user.stage, startedAt });
  state.hourlyStarts ||= [];
  state.hourlyStarts.push({ id: user.id, handle: user.handle, stage: user.stage, startedAt,
    authorization: 'existing_follower_ten_minute_burst' });
  return true;
}
