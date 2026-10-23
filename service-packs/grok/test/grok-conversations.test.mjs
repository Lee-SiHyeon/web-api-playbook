import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGrokConversationClient,
  GROK_CONVERSATION_OPERATION_IDS as IDS,
  GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS as SOURCE_PERMITS,
} from '../src/grok-conversations.mjs';

const conversationId = 'conversation_test_0123456789';
const responseId = 'response_test_0123456789';
const createdConversationId = 'conversation_created_0123456789';
const intent = suffix => ({ confirm: true, intentId: `conversation-test-${suffix}` });

function fakeRuntime({ ownerVerified = true, conversations = [{
  conversationId, title: 'Owned task chat', starred: false, temporary: true, isReadonly: false, viewerIsOwner: true,
}], settings = {
  allowXPersonalization: false,
  enableMemory: false,
  preferences: { hideArtifacts: false, requireCmdEnterToSubmit: false },
  mutedBotPushAgentIds: ['retained-only-in-read'],
}, sharing = { scope: 'SHARING_SCOPE_NONE', users: [], teams: [] }, shareLinkData = null,
  issuedShareLinkId = 'share_link_fixture_0123456789', scopedShareLinkId = 'share_link_fixture_0123456789',
  scopedPublicId = 'public_fixture_0123456789' } = {}) {
  const state = {
    conversations: new Map(conversations.map(item => [item.conversationId, { ...item }])),
    settings: structuredClone(settings),
    sharing: structuredClone(sharing),
    shareLinkData: structuredClone(shareLinkData),
    calls: [],
    entries: new Map(),
    nextId: 0,
    pageToken: '',
    serviceJobIds: new Map(),
    privateResponses: new Map(),
  };
  const client = {
    async status() { return { session: { ownerVerified } }; },
    async read(operationId, input = {}) {
      state.calls.push({ type: 'read', operationId, input: structuredClone(input) });
      if (operationId === IDS.list) {
        return { status: 200, data: {
          conversations: [...state.conversations.values()].map(item => ({ ...item })),
          nextPageToken: state.pageToken,
          textSearchMatches: [],
        } };
      }
      if (operationId === IDS.read) {
        const conversation = state.conversations.get(input.conversationId);
        return conversation
          ? { status: 200, data: { conversation: { ...conversation } } }
          : { status: 404, data: { error: 'not-found' } };
      }
      if (operationId === IDS.responseNodes) return { status: 200, data: { responseNodes: [{ responseId, sender: 'user' }], inflightResponses: [] } };
      if (operationId === IDS.loadResponses) return { status: 200, data: { responses: [{ responseId, message: 'fixture only', sender: 'user' }] } };
      if (operationId === IDS.taskResponses) return { status: 200, data: { taskIdWithResponseIds: [] } };
      if (operationId === IDS.sharingRead) return { status: 200, data: { sharing: structuredClone(state.sharing), workspaceSeedEligible: false } };
      if (operationId === IDS.sharingLinkRead) return state.shareLinkData
        ? { status: 200, data: structuredClone(state.shareLinkData) }
        : { status: 404, data: { error: 'not-found' } };
      if (operationId === IDS.settingsRead) return { status: 200, data: structuredClone(state.settings) };
      if (operationId === IDS.imagineModelOverrides) return { status: 200, data: { modelMapOverrides: [] } };
      if (operationId === IDS.modes) return { status: 200, data: { modes: [] } };
      if (operationId === IDS.uploadStatus) return { status: 200, data: { status: 'UPLOAD_STATUS_UNSPECIFIED' } };
      throw new Error(`unexpected read ${operationId}`);
    },
    async submit(operationId, input, options) {
      state.calls.push({ type: 'submit', operationId, input: structuredClone(input), options: { ...options } });
      const localOperationId = `00000000-0000-4000-8000-${String(++state.nextId).padStart(12, '0')}`;
      state.entries.set(localOperationId, { localOperationId, state: 'accepted' });
      if (operationId === IDS.create) {
        state.conversations.set(createdConversationId, { conversationId: createdConversationId, title: 'Created', temporary: true, viewerIsOwner: true });
        state.serviceJobIds.set(localOperationId, createdConversationId);
      }
      if (operationId === IDS.update) Object.assign(state.conversations.get(input.conversationId), input.body);
      if (operationId === IDS.delete) state.conversations.delete(input.conversationId);
      if (operationId === IDS.settingsUpdate) state.settings = structuredClone(input.body);
      if (operationId === IDS.sharingSet) {
        state.sharing = { scope: 'SHARING_SCOPE_PUBLIC', users: [], teams: [],
          shareLinkId: scopedShareLinkId, publicId: scopedPublicId };
        if (options.retainResponseInMemory) state.privateResponses.set(localOperationId, { shareLinkId: issuedShareLinkId });
      }
      if (operationId === IDS.sharingRevoke) state.sharing = { scope: 'SHARING_SCOPE_NONE', users: [], teams: [] };
      return { localOperationId, state: 'accepted', httpStatus: 200 };
    },
    async getInMemoryServiceJobId(localOperationId) { return state.serviceJobIds.get(localOperationId) ?? null; },
    async getInMemoryPrivateResponse(localOperationId) { return state.privateResponses.get(localOperationId) ?? null; },
    async clearInMemoryPrivateResponse(localOperationId) { return state.privateResponses.delete(localOperationId); },
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
  return { client, journal, state, api: createGrokConversationClient({ client, journal }) };
}

test('list and search pass source-derived pagination and search fields through the named read handler', async () => {
  const runtime = fakeRuntime();
  await runtime.api.list({ pageSize: 24, pageToken: 'fixture-cursor', excludeProjects: true, filterIsStarred: false });
  await runtime.api.search('fixture title', { pageSize: 12, forceElastic: true });
  const calls = runtime.state.calls.filter(call => call.operationId === IDS.list);
  assert.deepEqual(calls[0].input, { pageSize: 24, pageToken: 'fixture-cursor', excludeProjects: true, filterIsStarred: false });
  assert.deepEqual(calls[1].input, { pageSize: 12, forceElastic: true, searchQuery: 'fixture title' });
});

test('history, sharing, settings, model, and upload metadata methods validate observed response containers', async () => {
  const runtime = fakeRuntime();
  await runtime.api.read(conversationId);
  await runtime.api.responseNodes(conversationId, { includeThreads: true });
  await runtime.api.loadResponses(conversationId, [responseId]);
  await runtime.api.taskResponses(conversationId);
  await runtime.api.sharing(conversationId, responseId);
  await runtime.api.settings();
  await runtime.api.imagineModelOverrides({});
  await runtime.api.modes('en');
  await runtime.api.uploadStatus('upload_test_0123456789');
  assert.deepEqual(runtime.state.calls.map(call => call.operationId), [
    IDS.read, IDS.responseNodes, IDS.loadResponses, IDS.taskResponses, IDS.sharingRead,
    IDS.settingsRead, IDS.imagineModelOverrides, IDS.modes, IDS.uploadStatus,
  ]);
  assert.deepEqual(runtime.state.calls.find(call => call.operationId === IDS.loadResponses).input.responseIds, [responseId]);
});

test('invalid IDs, duplicate history IDs, and unknown list fields stop before dispatch', async () => {
  const runtime = fakeRuntime();
  await assert.rejects(runtime.api.read('bad'), { code: 'CONVERSATION_ID_INVALID' });
  await assert.rejects(runtime.api.loadResponses(conversationId, [responseId, responseId]), { code: 'HISTORY_RESPONSE_IDS_DUPLICATE' });
  await assert.rejects(runtime.api.list({ pageSize: 5, surprise: true }), { code: 'CONVERSATION_LIST_INPUT_INVALID' });
  assert.equal(runtime.state.calls.length, 0);
});

test('source-backed empty conversation create accepts only its first-live permit and captured empty fields', async () => {
  const runtime = fakeRuntime();
  const body = { systemPromptName: '', temporary: false };
  await assert.rejects(runtime.api.create(body, {
    ...intent('create-invalid-permit'), sourceDiscoveryPermit: 'first-live:conversation.update',
  }), { code: 'CONVERSATION_SOURCE_DISCOVERY_PERMIT_INVALID' });
  assert.equal(runtime.state.calls.some(call => call.type === 'submit'), false);

  const created = await runtime.api.create(body, {
    ...intent('create'), sourceDiscoveryPermit: SOURCE_PERMITS.create,
  });
  assert.equal(created.verified, true);
  assert.equal(created.state, 'completed');
  assert.equal(created.readbackStatus, 200);
  const call = runtime.state.calls.find(item => item.type === 'submit');
  assert.equal(call.operationId, IDS.create);
  assert.deepEqual(call.input, { body });
  assert.deepEqual(call.options, { ...intent('create'), sourceDiscoveryPermit: SOURCE_PERMITS.create });
});

test('update and delete require an exact confirmed intent and verify independent readback for an explicit target', async () => {
  const runtime = fakeRuntime();
  await assert.rejects(runtime.api.update(conversationId, { title: 'Updated title' }, { confirm: false, intentId: 'no' }),
    { code: 'CONVERSATION_UPDATE_CONFIRM_REQUIRED' });
  assert.equal(runtime.state.calls.some(call => call.type === 'submit'), false);

  const updated = await runtime.api.update(conversationId, { title: 'Updated title' }, intent('rename'));
  assert.equal(updated.verified, true);
  assert.equal(runtime.state.conversations.get(conversationId).title, 'Updated title');
  const updateCall = runtime.state.calls.find(call => call.type === 'submit' && call.operationId === IDS.update);
  assert.deepEqual(updateCall.input, { conversationId, body: { title: 'Updated title' } });
  assert.deepEqual(updateCall.options, { ...intent('rename'), sourceDiscoveryPermit: null });

  const deleted = await runtime.api.delete(conversationId, intent('delete'));
  assert.equal(deleted.verified, true);
  assert.equal(deleted.conversationAbsent, true);
  assert.equal(runtime.state.conversations.has(conversationId), false);
  assert.equal(runtime.state.calls.filter(call => call.operationId === IDS.list).length, 1);

  const firstLive = fakeRuntime();
  const firstLiveDeleted = await firstLive.api.delete(conversationId, {
    ...intent('first-live-delete'), sourceDiscoveryPermit: SOURCE_PERMITS.delete,
  });
  assert.equal(firstLiveDeleted.verified, true);
  const firstLiveCall = firstLive.state.calls.find(call => call.type === 'submit');
  assert.equal(firstLiveCall.operationId, 'conversation.soft-delete');
  assert.deepEqual(firstLiveCall.options, {
    ...intent('first-live-delete'), sourceDiscoveryPermit: 'first-live:conversation.soft-delete',
  });
});

test('shared readonly conversations and incomplete deletion readback stop mutation verification', async () => {
  const readonly = fakeRuntime({ conversations: [{ conversationId, title: 'Shared', isReadonly: true }] });
  await assert.rejects(readonly.api.update(conversationId, { title: 'No' }, intent('readonly')), { code: 'CONVERSATION_OWNER_ACCESS_REQUIRED' });
  assert.equal(readonly.state.calls.some(call => call.type === 'submit'), false);

  const paginated = fakeRuntime();
  paginated.state.pageToken = 'next';
  const result = await paginated.api.delete(conversationId, intent('incomplete'));
  assert.equal(result.verified, false);
  assert.equal(result.state, 'needs_review');
  assert.equal(paginated.state.calls.filter(call => call.type === 'read' && call.operationId === IDS.list).length, 2);
});

test('settings are readable while updates stay unexposed until the complete request and restore contract is captured', async () => {
  const runtime = fakeRuntime();
  const settings = await runtime.api.settings();
  assert.equal(settings.data.preferences.hideArtifacts, false);
  assert.equal(typeof runtime.api.updateSettings, 'undefined');
  assert.equal(runtime.state.calls.some(call => call.type === 'submit'), false);
});

test('sharing rejects unsupported caller-controlled public and recipient fields before dispatch', async () => {
  const runtime = fakeRuntime();
  await assert.rejects(runtime.api.setSharing(conversationId,
    { responseId, allowIndexing: false, sharePublicly: true }, intent('public')),
  { code: 'CONVERSATION_SHARING_BODY_INVALID' });
  await assert.rejects(runtime.api.setSharing(conversationId,
    { responseId, allowIndexing: false, sharePublicly: false, shareWithTeamMembers: true }, intent('recipient')),
  { code: 'CONVERSATION_SHARING_BODY_INVALID' });
  assert.equal(runtime.state.calls.some(call => call.type === 'submit'), false);
});

test('sharing create and revoke require source-decoded exact conversation and response binding', async () => {
  const link = {
    isPublic: true,
    allowIndexing: false,
    canonicalShareLinkId: 'canonical_share_fixture_0123456789',
    conversation: { conversationId },
    responses: [{ responseId, sender: 'user' }],
  };
  const runtime = fakeRuntime({ shareLinkData: link });
  const created = await runtime.api.setSharing(conversationId, { responseId, allowIndexing: false }, intent('share'));
  assert.equal(created.verified, true);
  assert.equal(created.sameConversationId, true);
  assert.equal(created.sameResponseId, true);
  assert.equal(created.isPublic, true);
  assert.equal(created.allowIndexing, false);

  const wrongResponse = fakeRuntime({ shareLinkData: { ...link, responses: [{ responseId: 'response_other_0123456789' }] } });
  const held = await wrongResponse.api.setSharing(conversationId, { responseId, allowIndexing: false }, intent('share-wrong-response'));
  assert.equal(held.state, 'needs_review');
  assert.equal(held.verified, false);
  assert.equal(held.sameConversationId, true);
  assert.equal(held.sameResponseId, false);

  const revokeRuntime = fakeRuntime({
    sharing: { scope: 'SHARING_SCOPE_PUBLIC', shareLinkId: 'share_link_fixture_0123456789', publicId: 'public_fixture_0123456789' },
    shareLinkData: link,
  });
  const revoked = await revokeRuntime.api.revokeSharingLink(conversationId, responseId,
    'share_link_fixture_0123456789', intent('revoke'));
  assert.equal(revoked.verified, true);
  assert.equal(revoked.shareLinkAbsent, true);
  assert.equal(revoked.sameConversationId, true);
  assert.equal(revoked.sameResponseId, true);
});

test('owner verification gates all mutation handlers before read or submit', async () => {
  const runtime = fakeRuntime({ ownerVerified: false });
  await assert.rejects(runtime.api.create({ temporary: true }, intent('create')), { code: 'OWNER_VERIFICATION_REQUIRED' });
  await assert.rejects(runtime.api.update(conversationId, { starred: true }, intent('star')), { code: 'OWNER_VERIFICATION_REQUIRED' });
  await assert.rejects(runtime.api.delete(conversationId, intent('delete')), { code: 'OWNER_VERIFICATION_REQUIRED' });
  assert.equal(runtime.state.calls.length, 0);
});

test('sharing reads the server-issued link and never substitutes an unrelated scoped link', async () => {
  const issued = 'issued_share_fixture_0123456789';
  const scoped = 'different_share_fixture_0123456789';
  const runtime = fakeRuntime({ issuedShareLinkId: issued, scopedShareLinkId: scoped,
    shareLinkData: { isPublic: true, allowIndexing: false, conversation: { conversationId },
      responses: [{ responseId, sender: 'assistant' }] },
  });
  const result = await runtime.api.setSharing(conversationId, { responseId, allowIndexing: false }, intent('wrong-link-state'));
  assert.equal(result.verified, false);
  assert.equal(result.state, 'needs_review');
  assert.equal(result.shareLinkId, issued);
  assert.equal(result.issuedLinkMatchedScopedState, false);
  const linkRead = runtime.state.calls.find(item => item.operationId === IDS.sharingLinkRead);
  assert.equal(linkRead.input.shareLinkId, issued);
  assert.equal(runtime.state.privateResponses.size, 0);
  assert.equal(runtime.state.entries.values().next().value.reasonCode, 'CONVERSATION_SHARE_ISSUED_LINK_STATE_MISMATCH');
});

test('a canonical share alias requires its observed link relation and exact conversation/response before revoke', async () => {
  const issued = 'issued_share_fixture_0123456789';
  const canonical = 'canonical_share_fixture_0123456789';
  const runtime = fakeRuntime({ issuedShareLinkId: issued, scopedShareLinkId: canonical, scopedPublicId: canonical,
    shareLinkData: { isPublic: true, allowIndexing: false, canonicalShareLinkId: canonical,
      conversation: { conversationId }, responses: [{ responseId, sender: 'assistant' }] },
  });
  const shared = await runtime.api.setSharing(conversationId, { responseId, allowIndexing: false }, intent('canonical-alias'));
  assert.equal(shared.verified, true);
  assert.equal(shared.shareLinkId, issued);
  assert.equal(shared.issuedLinkMatchedScopedState, true);
  const revoked = await runtime.api.revokeSharingLink(conversationId, responseId, issued, intent('canonical-alias-revoke'));
  assert.equal(revoked.verified, true);
  assert.equal(runtime.state.calls.find(item => item.operationId === IDS.sharingRevoke).input.shareLinkId, canonical);
});

test('sharing uses the public alias for reads and owner share-record ID for deletion', async () => {
  const publicId = 'public_alias_fixture_0123456789';
  const recordId = 'owner_record_fixture_0123456789';
  const runtime = fakeRuntime({ issuedShareLinkId: publicId, scopedShareLinkId: recordId, scopedPublicId: publicId,
    shareLinkData: { isPublic: true, allowIndexing: false, conversation: { conversationId },
      responses: [{ responseId, sender: 'assistant' }] },
  });
  const created = await runtime.api.setSharing(conversationId, { responseId, allowIndexing: false }, intent('public-versus-record'));
  assert.equal(created.verified, true);
  assert.equal(created.shareLinkId, publicId);
  assert.equal(created.shareRecordId, recordId);
  const revoked = await runtime.api.revokeSharingLink(conversationId, responseId, created.shareLinkId, intent('record-delete'));
  assert.equal(revoked.verified, true);
  assert.ok(runtime.state.calls.filter(call => call.operationId === IDS.sharingLinkRead)
    .every(call => call.input.shareLinkId === publicId));
  assert.equal(runtime.state.calls.find(call => call.operationId === IDS.sharingRevoke).input.shareLinkId, recordId);
});

test('create verifies the server returned owner conversation before reporting completion', async () => {
  const runtime = fakeRuntime();
  const created = await runtime.api.create({ temporary: true }, intent('create'));
  assert.equal(created.state, 'completed');
  assert.equal(created.verified, true);
  assert.equal(created.conversationId, createdConversationId);
  assert.deepEqual(runtime.state.calls.find(call => call.type === 'submit').input, { body: { temporary: true } });
});
