import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildThreadsPinRequest,
  decodeThreadsPinMutation,
  pinThreadsPost,
  THREADS_PIN_CONTRACTS,
  verifyThreadsPinSource,
} from '../threads-pin.mjs';

const OWNER = 'lifehack__ailab';
const OWNER_ID = '17824859444';
const ORIGIN = 'https://www.threads.com';
const OLD_PIN = '3996994421430736442';
const NEW_POST = '4012345678901234567';
const sessionLock = async (_service, operation) => operation();
const sourceEvidence = async () => ({
  operation: 'ThreadsOwnerProfilePinMenu',
  assetPath: 'https://static.cdninstagram.com/rsrc.php/v4i9eD4/yU/l/ko_KR-j/7BowlCT8jgp.js',
  assetSha256: 'b'.repeat(64),
  sourceFingerprint: 'a'.repeat(64),
  captured: false,
  captureSource: 'current_first_party_dynamic_menu_source; mutation_request_not_action_captured',
});

function context() {
  return {
    service: 'threads',
    handle: OWNER,
    createdAt: Date.now(),
    requestCount: 0,
    url: `${ORIGIN}/@${OWNER}/`,
    documentReceipt: { ownerVerified: true },
    bundle: {
      service: 'threads', owner: OWNER, ownerId: OWNER_ID, origin: ORIGIN,
      cookies: [{ name: 'csrftoken', value: 'fake-csrf', domain: 'threads.com', path: '/', secure: true }],
    },
    sources: new Map([['DTSGUtils', { source: 'SprinkleConfig .charCodeAt(' }]]),
    document: { route: { canonicalRouteName: 'comet.threads.BarcelonaProfileThreadsColumnRoute' }, modules: new Map([
      ['DTSGInitialData', { token: 'fake-dtsg' }],
      ['LSD', { token: 'fake-lsd' }],
      ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
      ['SiteData', { haste_session: 'h', pr: 1, client_revision: 2, hsi: 3, comet_env: 1,
        __spin_r: 4, __spin_b: 'trunk', __spin_t: 4 }],
      ['RelayAPIConfigDefaults', { actorID: OWNER_ID, graphURI: '/api/graphql', customHeaders: { 'x-ig-app-id': 'test-app' } }],
      ['CurrentUserInitialData', { USER_ID: '0' }],
    ]) },
  };
}

function makeReaders(states) {
  return {
    postReader: async ({ postId, expectedAuthor }) => ({
      id: postId, author: expectedAuthor, code: 'Dd4LT_SmNY6', isPinnedToProfile: states.get(postId) === true,
      receipt: { ownerVerified: true },
    }),
    profileReader: async ({ handle, limit }) => {
      assert.equal(handle, OWNER);
      assert.equal(limit, 30);
      const pinnedPostIds = [...states.entries()].filter(([, pinned]) => pinned).map(([id]) => id).sort();
      return {
        handle: OWNER,
        pinnedPostIds,
        pinnedPosts: pinnedPostIds.map(id => ({ id, author: OWNER, isPinnedToProfile: true })),
        receipt: { owner: OWNER, ownerVerified: true, credential_propagated: true },
      };
    },
  };
}

function sourceFixture() {
  const module = (name, body) => `__d("${name}",[],function(){${body}}),\n`;
  return [
    module('BarcelonaOverflowMenuPinPostOption.react', 'useBarcelonaPinPostToProfileMutation g(f.pk,!0) g(f.pk,!1) PIN_TO_PROFILE_OPTION UNPIN_OPTION can_viewer_pin_to_profile can_viewer_unpin_from_profile'),
    module('useTHPinPostToProfileMutation', 'variables:{post_id:t} useTHPinPostToProfileMutationPinMutation.graphql useTHPinPostToProfileMutationUnpinMutation.graphql'),
    module('useBarcelonaPinPostToProfileMutation', 'useTHPinPostToProfileMutation'),
    module('BarcelonaOverflowMenuPinPostOption_media.threads.graphql', 'name:"can_viewer_pin_to_profile" name:"can_viewer_unpin_from_profile" name:"is_pinned_to_profile"'),
    module('useTHPinPostToProfileMutationPinMutation.threads.graphql', 'id:"26917686924509763" name:"xdt_api__v1__text_feed__pin_post_to_profile" name:"post_id",variableName:"post_id" name:"is_pinned_to_profile"'),
    module('useTHPinPostToProfileMutationUnpinMutation.threads.graphql', 'id:"26782015404752924" name:"xdt_api__v1__text_feed__unpin_post_from_profile" name:"post_id",variableName:"post_id" name:"is_pinned_to_profile"'),
  ].join('');
}

test('current lazy-menu source verifier binds both owner-profile mutations and response state', () => {
  const evidence = verifyThreadsPinSource(sourceFixture());
  assert.equal(evidence.operation, 'ThreadsOwnerProfilePinMenu');
  assert.equal(evidence.captured, false);
  assert.match(evidence.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.throws(() => verifyThreadsPinSource(sourceFixture().replace('26782015404752924', '26782015404752925')),
    /THREADS_PIN_SOURCE_CONTRACT_CHANGED/);
  assert.throws(() => verifyThreadsPinSource(sourceFixture(), 'https://evil.example/rsrc.php/fake.js'),
    /THREADS_PIN_SOURCE_SCOPE/);
});

test('builds the exact persisted Relay mutation request and validates its response state', () => {
  for (const operation of ['pin', 'unpin']) {
    const request = buildThreadsPinRequest(context(), operation, OLD_PIN);
    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url).origin, ORIGIN);
    assert.equal(new URL(request.url).pathname, '/api/graphql');
    assert.equal(request.body.get('fb_api_req_friendly_name'), THREADS_PIN_CONTRACTS[operation].operation);
    assert.equal(request.body.get('doc_id'), THREADS_PIN_CONTRACTS[operation].docId);
    assert.deepEqual(JSON.parse(request.body.get('variables')), { post_id: OLD_PIN });
    assert.equal(decodeThreadsPinMutation({ data: { data: { pinned_post_info: {
      is_pinned_to_profile: THREADS_PIN_CONTRACTS[operation].desiredPinned,
    } } } }, operation).matchesRequestedState, true);
  }
  assert.throws(() => buildThreadsPinRequest(context(), 'archive', OLD_PIN), /THREADS_PIN_INPUT_INVALID/);
  assert.throws(() => decodeThreadsPinMutation({ data: { data: { success: true } } }, 'unpin'),
    /THREADS_PIN_MUTATION_RESPONSE_INVALID/);
});

test('unpin reserves an atomic one-send journal before dispatch and verifies target plus owner profile', async () => {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'threads-pin-test-'));
  const states = new Map([[OLD_PIN, true]]);
  const readers = makeReaders(states);
  let writes = 0;
  const deps = {
    journalRoot, sessionLock, sourceLoader: sourceEvidence, contextLoader: async () => context(), ...readers,
    querySender: async () => { throw new Error('unexpected read request'); },
    mutationSender: async (_ctx, request) => {
      assert.equal(request.body.get('doc_id'), THREADS_PIN_CONTRACTS.unpin.docId);
      const files = await readdir(journalRoot);
      assert.equal(files.length, 1);
      const reserved = JSON.parse(await readFile(path.join(journalRoot, files[0]), 'utf8'));
      assert.equal(reserved.status, 'dispatch_reserved');
      assert.equal(reserved.writes, 1);
      assert.equal(JSON.stringify(reserved).includes('fake-dtsg'), false);
      writes += 1;
      states.set(OLD_PIN, false);
      return { payload: { data: { data: { pinned_post_info: { is_pinned_to_profile: false } } } },
        receipt: { httpStatus: 200 } };
    },
  };
  const result = await pinThreadsPost({ operation: 'unpin', postId: OLD_PIN, execute: true }, deps);
  assert.equal(writes, 1);
  assert.equal(result.success, true);
  assert.equal(result.readbackVerified, true);
  assert.equal(result.currentState.target.isPinnedToProfile, false);
  assert.deepEqual(result.currentState.ownerProfilePinnedPostIds, []);
  assert.equal(result.captured, false);
  assert.equal(result.live_replay, false);
  assert.equal(result.writes, 1);
  const repeated = await pinThreadsPost({ operation: 'unpin', postId: OLD_PIN, execute: true }, deps);
  assert.equal(repeated.noOp, true);
  assert.equal(writes, 1);
});

test('pin plan refuses to replace an existing profile pin and never dispatches', async () => {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'threads-pin-plan-'));
  const states = new Map([[OLD_PIN, true], [NEW_POST, false]]);
  const readers = makeReaders(states);
  let writes = 0;
  const deps = { journalRoot, sessionLock, sourceLoader: sourceEvidence, contextLoader: async () => context(), ...readers,
    mutationSender: async () => { writes += 1; throw new Error('must not send'); } };
  await assert.rejects(pinThreadsPost({ operation: 'pin', postId: NEW_POST, execute: true }, deps),
    /THREADS_PIN_OTHER_PROFILE_PIN_PRESENT/);
  assert.equal(writes, 0);
  assert.deepEqual(await readdir(journalRoot), []);
});

test('pin write is read back from the exact post and owner profile', async () => {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'threads-pin-new-'));
  const states = new Map([[NEW_POST, false]]);
  const readers = makeReaders(states);
  let writes = 0;
  const result = await pinThreadsPost({ operation: 'pin', postId: NEW_POST, execute: true }, {
    journalRoot, sessionLock, sourceLoader: sourceEvidence, contextLoader: async () => context(), ...readers,
    mutationSender: async (_ctx, request) => {
      assert.equal(request.body.get('fb_api_req_friendly_name'), THREADS_PIN_CONTRACTS.pin.operation);
      writes += 1;
      states.set(NEW_POST, true);
      return { payload: { data: { data: { pinned_post_info: { is_pinned_to_profile: true } } } },
        receipt: { httpStatus: 200 } };
    },
  });
  assert.equal(writes, 1);
  assert.equal(result.success, true);
  assert.equal(result.readbackVerified, true);
  assert.equal(result.currentState.target.isPinnedToProfile, true);
  assert.deepEqual(result.currentState.ownerProfilePinnedPostIds, [NEW_POST]);
  assert.equal(result.credential_propagated, false);
  assert.equal(result.live_replay, false);
});

test('ambiguous unpin is reconciled from fresh readback without sending again', async () => {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'threads-pin-reconcile-'));
  const states = new Map([[OLD_PIN, true]]);
  const readers = makeReaders(states);
  let writes = 0;
  const deps = { journalRoot, sessionLock, sourceLoader: sourceEvidence, contextLoader: async () => context(), ...readers,
    mutationSender: async () => { writes += 1; states.set(OLD_PIN, false); throw new Error('timeout'); } };
  const first = await pinThreadsPost({ operation: 'unpin', postId: OLD_PIN, execute: true }, deps);
  assert.equal(first.success, true);
  assert.equal(first.readbackVerified, true);
  assert.equal(first.dispatchConfirmed, false);
  assert.equal(first.live_replay, false);
  const reconciled = await pinThreadsPost({ operation: 'unpin', postId: OLD_PIN, reconcile: true }, deps);
  assert.equal(reconciled.success, true);
  assert.equal(reconciled.writes, 1);
  assert.equal(writes, 1);
});
