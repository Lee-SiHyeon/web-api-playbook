import test from 'node:test';
import assert from 'node:assert/strict';
import { observeFollowers, classifyParticipation } from '../x-relationship-state.mjs';
test('reaction-first and follow-first converge without repeating processed benefits', () => {
  assert.equal(classifyParticipation({ followsMe: false, liked: true, reposted: true }), 'reaction_waiting_for_follow');
  assert.equal(classifyParticipation({ followsMe: true, liked: false, reposted: false }), 'follower_waiting_for_reactions');
  assert.equal(classifyParticipation({ followsMe: true, liked: true, reposted: true }), 'follower_and_both_reactions');
  assert.equal(classifyParticipation({ followsMe: true, liked: true, reposted: true, processed: true }), 'processed_once');
});
test('incomplete lists cannot infer departures; two full observations confirm absence only', () => {
  const state = { records: { '1': { status: 'verified' } } };
  const scan = (items, at, complete = true) => ({ items, complete, checkedAt: at });
  const u = { id: '1', handle: 'someone', followsMe: true, following: true, pending: false, blueVerified: true };
  observeFollowers(state, scan([u], 't1'));
  observeFollowers(state, scan([], 't2', false));
  assert.equal(state.relationships['1'].visibility, 'present');
  observeFollowers(state, scan([], 't3'));
  assert.equal(state.relationships['1'].visibility, 'absence_pending');
  observeFollowers(state, scan([], 't4'));
  assert.equal(state.relationships['1'].visibility, 'absent_confirmed');
  assert.equal(state.relationships['1'].followsMe, true);
  observeFollowers(state, scan([u], 't5'));
  assert.equal(state.relationships['1'].returnedAt, 't5');
  assert.equal(state.records['1'].status, 'verified');
});
