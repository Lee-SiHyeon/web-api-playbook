import {rewardStage} from './x-rewards.mjs';
export function queuePriority(user, state) {
  const stage = user.stage === 'base' ? 0 : 10;
  if (state.priorityAccount?.id === user.id) return stage - 1;
  const existing = Boolean(state.retroactiveCohort?.members?.[user.id]);
  return stage + (state.processingLimits?.retroactiveFirst ? (existing ? 0 : 1) : (existing ? 1 : 0));
}
export function prioritizeTargets(targets, state) {
  return [...targets].sort((a, b) => queuePriority(a, state) - queuePriority(b, state));
}
export function hasUnservedNewcomer(followers, state) {
  return followers.some(u => u.blueVerified && u.followsMe === true && !state.records[u.id] && !state.retroactiveCohort?.members?.[u.id]);
}
export function hasUnservedBase(followers, state) {
  return followers.some(u => u.followsMe === true && (u.blueVerified || state.retroactiveCohort?.members?.[u.id]) && rewardStage(state.records[u.id], false) === 'base');
}
