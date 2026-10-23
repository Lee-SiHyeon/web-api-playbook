import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGrokConversationRestoreClient,
  GROK_CONVERSATION_RESTORE_OPERATION_IDS as IDS,
  GROK_CONVERSATION_RESTORE_SOURCE_PERMITS as PERMITS,
} from '../src/grok-conversation-restore.mjs';

const targetId = 'conversation_soft_deleted_0123456789';
const unrelatedId = 'conversation_unrelated_0123456789';
const anotherDeletedId = 'conversation_deleted_other_0123456789';
const target = { conversationId: targetId, title: 'Neutral archived test', viewerIsOwner: true, isReadonly: false };
const intent = { confirm: true, intentId: 'restore-neutral-test-20261007', sourceDiscoveryPermit: PERMITS.restore };

function fakeRuntime({ deleted = [target, { conversationId: anotherDeletedId, title: 'Other deleted' }],
  active = [{ conversationId: unrelatedId, title: 'Unrelated active', viewerIsOwner: true }],
  restoreOwner = true, deletedPageTokens = false } = {}) {
  const state = { deleted: structuredClone(deleted), active: structuredClone(active), calls: [], entries: new Map(), nextId: 0 };
  const client = {
    async status() { return { session: { ownerVerified: true } }; },
    async read(operationId, input = {}, options = {}) {
      state.calls.push({ kind: 'read', operationId, input: structuredClone(input), options: { ...options } });
      if (operationId === IDS.deletedList) {
        const rows = deletedPageTokens && !input.pageToken ? state.deleted.slice(0, 1)
          : deletedPageTokens && input.pageToken ? state.deleted.slice(1) : state.deleted;
        return { status: 200, data: { conversations: rows.map(item => ({ ...item })),
          nextPageToken: deletedPageTokens && !input.pageToken ? 'next' : '' } };
      }
      if (operationId === IDS.activeList) return {
        status: 200,
        data: { conversations: state.active.map(item => ({ ...item })), nextPageToken: '' },
      };
      if (operationId === IDS.detail) {
        const conversation = state.active.find(item => item.conversationId === input.conversationId);
        if (!conversation) return { status: 404, data: { error: 'not-found' } };
        return { status: 200, data: { conversation: { ...conversation, viewerIsOwner: restoreOwner } } };
      }
      throw new Error(`unexpected read ${operationId}`);
    },
    async submit(operationId, input, options) {
      state.calls.push({ kind: 'submit', operationId, input: structuredClone(input), options: { ...options } });
      const localOperationId = `00000000-0000-4000-8000-${String(++state.nextId).padStart(12, '0')}`;
      state.entries.set(localOperationId, { localOperationId, state: 'accepted' });
      if (operationId === IDS.restore) {
        const id = input.body.conversationId;
        const match = state.deleted.find(item => item.conversationId === id);
        state.deleted = state.deleted.filter(item => item.conversationId !== id);
        if (match) state.active.push({ ...match, viewerIsOwner: true, isReadonly: false });
      }
      return { localOperationId, state: 'needs_review', httpStatus: 200 };
    },
  };
  const journal = {
    async get(id) { return state.entries.get(id) ?? null; },
    async transition(id, nextState, details = {}) {
      const entry = state.entries.get(id);
      if (!entry) throw new Error('missing operation entry');
      Object.assign(entry, { state: nextState, ...details });
      return { ...entry };
    },
  };
  return { state, client, journal, restore: createGrokConversationRestoreClient({ client, journal }) };
}

test('restore requires the exact confirmed target and verifies owner detail plus complete active/deleted lists', async () => {
  const runtime = fakeRuntime({ deletedPageTokens: true });
  const result = await runtime.restore.restore(targetId, intent);
  assert.equal(result.state, 'completed');
  assert.equal(result.verified, true);
  assert.equal(result.conversationPresent, true);
  assert.equal(result.deletedEntryAbsent, true);
  assert.equal(result.otherActiveConversationsUnchanged, true);
  assert.equal(result.otherDeletedConversationsUnchanged, true);
  assert.equal(result.viewerIsOwner, true);
  assert.equal(runtime.state.active.filter(item => item.conversationId === targetId).length, 1);
  assert.equal(runtime.state.deleted.some(item => item.conversationId === targetId), false);
  const deletedReads = runtime.state.calls.filter(item => item.kind === 'read' && item.operationId === IDS.deletedList);
  assert.equal(deletedReads.length, 4);
  assert.ok(deletedReads.every(item => item.options.sourceDiscoveryPermit === PERMITS.deletedList));
  const submit = runtime.state.calls.find(item => item.kind === 'submit');
  assert.equal(submit.operationId, IDS.restore);
  assert.deepEqual(submit.input, { body: { conversationId: targetId } });
  assert.deepEqual(submit.options, intent);
});

test('restore stops before dispatch for an unlisted or already active target', async () => {
  const absent = fakeRuntime({ deleted: [{ conversationId: anotherDeletedId }] });
  await assert.rejects(absent.restore.restore(targetId, intent), { code: 'CONVERSATION_RESTORE_TARGET_NOT_UNIQUE_SOFT_DELETED' });
  assert.equal(absent.state.calls.some(item => item.kind === 'submit'), false);

  const active = fakeRuntime({ active: [{ ...target, viewerIsOwner: true }] });
  await assert.rejects(active.restore.restore(targetId, intent), { code: 'CONVERSATION_RESTORE_TARGET_ALREADY_ACTIVE' });
  assert.equal(active.state.calls.some(item => item.kind === 'submit'), false);
});

test('restore leaves a dispatched result in review when owner detail readback fails', async () => {
  const runtime = fakeRuntime({ restoreOwner: false });
  const result = await runtime.restore.restore(targetId, intent);
  assert.equal(result.state, 'needs_review');
  assert.equal(result.verified, false);
  assert.equal(runtime.state.calls.filter(item => item.kind === 'submit').length, 1);
  const entry = [...runtime.state.entries.values()][0];
  assert.equal(entry.state, 'needs_review');
  assert.equal(entry.reasonCode, 'CONVERSATION_RESTORE_READBACK_FAILED');
});

test('restore does not dispatch with an invalid source permit or missing confirmation', async () => {
  const runtime = fakeRuntime();
  await assert.rejects(runtime.restore.restore(targetId, { ...intent, sourceDiscoveryPermit: 'first-live:conversation.delete' }),
    { code: 'CONVERSATION_RESTORE_SOURCE_PERMIT_INVALID' });
  await assert.rejects(runtime.restore.restore(targetId, { ...intent, confirm: false }),
    { code: 'CONVERSATION_RESTORE_CONFIRM_REQUIRED' });
  assert.equal(runtime.state.calls.some(item => item.kind === 'submit'), false);
});
