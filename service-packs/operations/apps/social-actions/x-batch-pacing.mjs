const HOUR = 3600000;
export function initializeSlots(state) {
  if (Array.isArray(state.hourlyStarts)) return;
  state.hourlyStarts = Object.entries(state.records || {}).map(([id, record]) => ({ id, handle: record.handle, startedAt: record.bonusStartedAt || record.startedAt, migrated: true })).filter(slot => Number.isFinite(Date.parse(slot.startedAt)));
}
export function quota(state, now = Date.now()) {
  initializeSlots(state);
  const recent = state.hourlyStarts.filter(slot => Date.parse(slot.startedAt) > now - HOUR).sort((a,b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  if (state.processingLimits?.hourlyLimit === null) return { remaining: Infinity, used: recent.length, retryAt: null };
  return { remaining: Math.max(0, 10 - recent.length), used: recent.length, retryAt: recent.length >= 10 ? Date.parse(recent[recent.length - 10].startedAt) + HOUR + 1000 : null };
}
export function reserveSlot(state, user, now = Date.now()) {
  if (quota(state, now).remaining < 1) return false;
  state.hourlyStarts = state.hourlyStarts.filter(slot => Date.parse(slot.startedAt) > now - 86400000);
  state.hourlyStarts.push({ id: user.id, handle: user.handle, stage: user.stage, startedAt: new Date(now).toISOString() });
  return true;
}
export const betweenAccountsMilliseconds = 20000;
