import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildObservedThreadsReplyRequest, createThreadsReplyContextLoader, parseFreshThreadsReplyHeaders,
  replyToThreadsPost, threadsConfigureRequestShape } from '../threads-reply.mjs';
import { protectThreadsReplyError } from '../lib/threads-reply-error-store.mjs';
import { prepareThreadsReplyLink } from '../threads-reply-link.mjs';
import { readThreadsSharedCooldown } from '../lib/threads-graphql-throttle.mjs';
import { composeThreadsBenefitReply } from '../threads-benefit-reply.mjs';

const OWNER = 'lifehack__ailab';
const PARENT_ID = '3996994421430736442';
const REPLY_ID = '3996994421430736555';
const MESSAGE = '확인했어요. 좋은 정보 감사합니다!';
const REPLY_HEADERS = { 'X-BLOKS-VERSION-ID': 'bloks-version-test', 'X-INSTAGRAM-AJAX': '0' };
const NATIVE_NETWORK_SOURCE = JSON.parse(await readFile(new URL('./fixtures/threads-rest-network-source.json', import.meta.url), 'utf8')).source;
const cli = fileURLToPath(new URL('../threads-reply.mjs', import.meta.url));

function context() {
  return { service: 'threads', handle: OWNER, documentReceipt: { ownerVerified: true }, replyHeaders: { ...REPLY_HEADERS },
    bundle: { service: 'threads', owner: OWNER, ownerId: '17824859444', origin: 'https://www.threads.com',
      cookies: [{ name: 'csrftoken', value: 'fake-csrf', domain: '.threads.com', path: '/', secure: true }],
      ownerRequest: { headers: { 'x-ig-app-id': 'fake-app', 'x-fb-lsd': 'old-lsd', 'x-web-session-id': 'fake:session:id' } } },
    sources: new Map([['BarcelonaNetworkUtils', { source: NATIVE_NETWORK_SOURCE }]]),
    document: { modules: new Map([['InstagramWebPushInfo', { rollout_hash: 'unrelated-rollout' }]]) } };
}

function makeDeps(root, { mismatchParent = false, canReply = true, failSend = false,
  responseStatus = 200, responseBody = { status: 'ok', media: { id: '3996994421430736555_17824859444' } },
  useDefaultPublisher = false,
  selfThreadReadback = false, mismatchSelfThreadParent = false } = {}) {
  let sends = 0;
  const state = { sends, lastRequest: null, replyRecords: [], runKeys: [] };
  const sessionLock = async (_service, operation) => operation();
  const contextLoader = async () => context();
  const postReader = async ({ postId }) => {
    if (postId === PARENT_ID) return { id: mismatchParent ? '3996994421430736000' : PARENT_ID,
      author: 'target_person', url: 'https://www.threads.com/@target_person/post/Dd4LT_SmNY6', text: 'Parent post', canReply,
      ...(selfThreadReadback ? {selfThreadInfo:{id:'17949418365319769',position:1,
        length:state.replyRecords.length?2:1}} : {}) };
    const created = state.replyRecords.find(item => item.id === postId);
    if (created) return { id: created.id, author: OWNER, text: created.text, isReply: true };
    throw new Error('unexpected post id');
  };
  const commentsReader = async postId => ({ postId, postAuthor: 'target_person',
    comments: selfThreadReadback?[]:state.replyRecords.map(item => ({ id: item.id, author: OWNER, text: item.text,
      isReply: true, directParentPostId: PARENT_ID })),
    ...(selfThreadReadback?{rootSelfThreadInfo:{id:'17949418365319769',position:1,length:state.replyRecords.length?2:1},
      selfThreadChildren:state.replyRecords.map(item=>({id:item.id,author:OWNER,text:item.text,isReply:true,
        directParentPostId:mismatchSelfThreadParent?'3996994421430736000':PARENT_ID,
        relationSource:'self_thread_adjacent_position',selfThreadInfo:{id:'17949418365319769',position:2,length:2}})),
      selfThreadPage:{coverage:'observed_self_thread_edges',observedChildren:state.replyRecords.length,fullList:false}}:{}),
    page: { fullList: false, hasNextPage: true, observedReplies: state.replyRecords.length } });
  const publishClient = async (posts, options) => {
    assert.equal(posts.length, 1);
    assert.equal(options.replyId, PARENT_ID);
    assert.equal(options.configureRetryTimeoutMs, 0);
    state.runKeys.push(options.runKey);
    const request = buildObservedThreadsReplyRequest({ postId: options.replyId, message: posts[0],
      uploadId: '1727712000000', selfThreadContextId: '00000000-0000-4000-8000-000000000001',
      requestContext: options.requestContext, session: options.session, replyHeaders: options.replyHeaders, parentUrl: options.parentUrl });
    state.lastRequest = request;
    const response = await options.transport(request);
    const status = Number(response?.status ?? 200);
    if (response?.ok === false || status < 200 || status >= 300) {
      const payload = await response.json().catch(() => ({}));
      throw Object.assign(new Error(`THREADS_HTTP_${status}`), { code: `THREADS_HTTP_${status}`,
        httpStatus: status, detail: [payload?.message, payload?.error_type, payload?.error_title].filter(Boolean).join(' | ') });
    }
    const id = String(BigInt(REPLY_ID) + BigInt(state.replyRecords.length));
    state.replyRecords.push({ id, text: posts[0] });
    return { ids: [id], permalinks: [`https://www.threads.com/@${OWNER}/post/ABCDE`], readbackVerified: false };
  };
  const transport = async request => {
    sends += 1;
    state.sends = sends;
    state.lastRequest = request;
    assert.equal(request.url, 'https://www.threads.com/api/v1/media/configure_text_only_post/');
    if (failSend) throw new Error('socket closed after request began');
    if (useDefaultPublisher && responseStatus >= 200 && responseStatus < 300 && responseBody?.status === 'ok') {
      const rawId = String(responseBody?.media?.pk ?? responseBody?.media?.id ?? '');
      const match = rawId.match(/^(\d{10,25})(?:_(\d{1,25}))?$/);
      if (match && (!match[2] || match[2] === '17824859444')) {
        const quoted = JSON.parse(request.body.get('text_post_app_info')).quoted_post_id;
        state.replyRecords.push({ id: match[1], text: quoted ? request.body.get('caption').trimEnd() : request.body.get('caption') });
      }
    }
    return new Response(JSON.stringify(responseBody), { status: responseStatus, headers: { 'content-type': 'application/json' } });
  };
  return { state, deps: { journalRoot: root, contextLoader, postReader, commentsReader,
    ...(useDefaultPublisher ? {} : { publishClient }),
    transport, sessionLock, requestContextFactory: () => ({ fbDtsg: 'fresh-token', lsd: 'fresh-lsd', jazoest: '2123' }) } };
}

async function tempDir(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'threads-reply-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const baseInput = { postId: PARENT_ID, expectedAuthor: 'target_person', message: MESSAGE };

function htmlWithVersionRows(rows) {
  return `<html><script type="application/json">${JSON.stringify(rows)}</script></html>`;
}

function replyContextLoader(html, rolloutHash = 'unrelated-rollout', networkSource = NATIVE_NETWORK_SOURCE) {
  return createThreadsReplyContextLoader({
    fetchImpl: async input => new Response(String(input).includes('/@') ? html : 'static asset', {
      headers: { 'content-type': String(input).includes('/@') ? 'text/html' : 'application/javascript' },
    }),
    baseContextLoader: async (service, handle, { fetchImpl }) => {
      const ownerResponse = await fetchImpl(`https://www.threads.com/@${handle}/`, { method: 'GET' });
      await ownerResponse.text();
      const assetResponse = await fetchImpl('https://static.cdninstagram.com/rsrc.php/test.js', { method: 'GET' });
      await assetResponse.text();
      return { ...context(), service, handle,
        sources: new Map(networkSource == null ? [] : [['BarcelonaNetworkUtils', { source: networkSource }]]),
        document: { modules: new Map([['InstagramWebPushInfo', { rollout_hash: rolloutHash }]]) } };
    },
  });
}

test('REST reply Ajax header follows the current native network module, independently of profile rollout', async () => {
  const html = htmlWithVersionRows([
    ['WebBloksVersioningID', [], { versioningID: 'bloks-version-from-owner-document' }],
  ]);
  const loader = replyContextLoader(html, 'ajax-rollout-from-owner-document');
  const loaded = await loader('threads', OWNER);
  assert.deepEqual(loaded.replyHeaders, {
    'X-BLOKS-VERSION-ID': 'bloks-version-from-owner-document',
    'X-INSTAGRAM-AJAX': '0',
  });
  assert.equal(parseFreshThreadsReplyHeaders(loaded, html)['X-BLOKS-VERSION-ID'], 'bloks-version-from-owner-document');
});

test('missing or changed native REST header source blocks before reservation or dispatch', async t => {
  const html = htmlWithVersionRows([['WebBloksVersioningID', [], { versioningID: 'current-version' }]]);
  for (const [source, code] of [[null, 'THREADS_REPLY_AJAX_SOURCE_MISSING'],
    [NATIVE_NETWORK_SOURCE.replace('return"0"', 'return"different"'), 'THREADS_REPLY_AJAX_SOURCE_CHANGED'],
    [NATIVE_NETWORK_SOURCE.replace('buildInstagramAPIFetch("POST",', 'buildInstagramAPIFetch("GET",'), 'THREADS_REPLY_AJAX_SOURCE_CHANGED']]) {
    const root = await tempDir(t), { state, deps } = makeDeps(root);
    deps.contextLoader = replyContextLoader(html, 'profile-rollout', source);
    await assert.rejects(replyToThreadsPost({ ...baseInput, execute: true }, deps), { code });
    assert.equal(state.sends, 0);
    assert.deepEqual(await readdir(root), []);
  }
});

test('missing, malformed, and ambiguous fresh app-version metadata fail before journal reservation or send', async t => {
  const invalidCases = [
    { html: htmlWithVersionRows([]), code: 'THREADS_REPLY_APP_VERSION_MISSING' },
    { html: htmlWithVersionRows([['WebBloksVersioningID', [], { versioningID: 'bad version value' }]]),
      code: 'THREADS_REPLY_APP_VERSION_MALFORMED' },
    { html: htmlWithVersionRows([
      ['WebBloksVersioningID', [], { versioningID: 'version-one' }],
      ['WebBloksVersioningID', [], { versioningID: 'version-two' }],
    ]), code: 'THREADS_REPLY_APP_VERSION_AMBIGUOUS' },
  ];
  for (const item of invalidCases) {
    const root = await tempDir(t);
    const { state, deps } = makeDeps(root);
    deps.contextLoader = replyContextLoader(item.html);
    await assert.rejects(replyToThreadsPost({ ...baseInput, execute: true }, deps), { code: item.code });
    assert.equal(state.sends, 0);
    assert.deepEqual(await readdir(root), []);
  }
});

test('prepare validates exact parent identity and reply permission without sending', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root);
  const prepared = await replyToThreadsPost(baseInput, deps);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.ownerVerified, true);
  assert.equal(prepared.canReply, true);
  assert.equal(prepared.captured, true);
  assert.equal(prepared.client_exists, true);
  assert.equal(prepared.live_replay, false);
  assert.equal(state.sends, 0);

  const blocked = makeDeps(root, { mismatchParent: true });
  await assert.rejects(replyToThreadsPost({ ...baseInput, postId: PARENT_ID }, blocked.deps), /THREADS_REPLY_PARENT_MISMATCH/);
  assert.equal(blocked.state.sends, 0);

  const denied = makeDeps(root, { canReply: false });
  await assert.rejects(replyToThreadsPost(baseInput, denied.deps), /THREADS_REPLY_NOT_ALLOWED/);
  assert.equal(denied.state.sends, 0);
});

test('web session body uses the observed header value and missing session fails before reservation', async t => {
  const loaded = context();
  const request = buildObservedThreadsReplyRequest({ postId: PARENT_ID, message: MESSAGE,
    session: loaded.bundle, requestContext: { lsd: 'fresh-lsd' }, replyHeaders: loaded.replyHeaders });
  assert.equal(request.body.get('web_session_id'), request.headers['X-Web-Session-ID']);
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root);
  delete loaded.bundle.ownerRequest.headers['x-web-session-id'];
  deps.contextLoader = async () => loaded;
  await assert.rejects(replyToThreadsPost({ ...baseInput, execute: true }, deps), { code: 'THREADS_REPLY_WEB_SESSION_INVALID' });
  assert.equal(state.sends, 0);
  assert.deepEqual(await readdir(root), []);
});

test('a nonempty cross-share destination is blocked before transport', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root);
  deps.publishClient = async (posts, options) => {
    const request = buildObservedThreadsReplyRequest({ postId: options.replyId, message: posts[0],
      session: options.session, requestContext: options.requestContext, replyHeaders: options.replyHeaders, parentUrl: options.parentUrl });
    request.body.set('cross_share_info', JSON.stringify({ destinations: [{ app: 'instagram' }] }));
    return options.transport(request);
  };
  const result = await replyToThreadsPost({ ...baseInput, execute: true }, deps);
  assert.equal(result.code, 'THREADS_REPLY_CONFIG_REQUEST_MISMATCH');
  assert.equal(state.sends, 0);
});

test('execute sends one exact text-only reply and verifies both post and direct parent relation', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { useDefaultPublisher: true });
  deps.contextLoader = replyContextLoader(htmlWithVersionRows([
    ['WebBloksVersioningID', [], { versioningID: 'bloks-version-from-owner-document' }],
  ]), 'ajax-rollout-from-owner-document');
  const result = await replyToThreadsPost({ ...baseInput, execute: true }, deps);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.success, true);
  assert.equal(result.readbackVerified, true);
  assert.equal(result.writes, 1);
  assert.equal(result.live_replay, false); // injected transport is a contract test, not a live replay
  assert.equal(state.sends, 1);

  const fields = state.lastRequest.body;
  const appInfo = JSON.parse(fields.get('text_post_app_info'));
  assert.equal(fields.get('caption'), MESSAGE);
  assert.equal(fields.get('barcelona_source_reply_id'), PARENT_ID);
  assert.equal(appInfo.reply_id, PARENT_ID);
  assert.equal(appInfo.text_with_entities.text, MESSAGE);
  assert.equal(appInfo.entry_point, 'create_reply');
  assert.equal(Object.hasOwn(appInfo, 'threads_draft_id'), false);
  assert.match(appInfo.composer_session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(state.lastRequest.headers.Referer, 'https://www.threads.com/@target_person/post/Dd4LT_SmNY6');
  assert.equal(appInfo.gif_media_id, undefined);
  assert.match(fields.get('upload_id'), /^\d{10,16}$/);
  assert.equal(fields.get('chain_id'), '');
  assert.equal(fields.get('chain_index'), '');
  assert.equal(fields.get('chain_length'), '');
  assert.equal(fields.get('async_publish'), '');
  assert.equal(fields.get('custom_accessibility_caption'), '');
  assert.equal(fields.get('gen_ai_detection_method'), '');
  assert.equal(fields.get('is_meta_only_post'), '');
  assert.equal(fields.get('is_paid_partnership'), '');
  assert.equal(fields.get('music_params'), '');
  const csrfHeader = Object.entries(state.lastRequest.headers).find(([name]) => name.toLowerCase() === 'x-csrftoken')?.[1];
  const csrfSum = [...csrfHeader].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  assert.equal(fields.get('jazoest'), `2${csrfSum}`);
  assert.notEqual(fields.get('jazoest'), '2123'); // request-context checksum is from a different first-party token lineage
  assert.equal(fields.has('is_threads'), false);
  assert.equal(fields.has('cross_share_info'), false);
  assert.equal(state.lastRequest.headers['X-BLOKS-VERSION-ID'], 'bloks-version-from-owner-document');
  assert.equal(state.lastRequest.headers['X-INSTAGRAM-AJAX'], '0');

  const stored = await readFile(result.journalPath, 'utf8');
  const journal = JSON.parse(stored);
  assert.equal(journal.status, 'succeeded');
  assert.equal(journal.createdPostId, REPLY_ID);
  assert.equal(journal.httpStatus, 200);
  assert.equal(journal.requestDiagnostic.httpStatus, 200);
  assert.equal(journal.requestDiagnostic.writeSent, true);
  assert.equal(journal.requestShape.csrfBodyMatchesHeader, true);
  assert.equal(journal.requestShape.webSessionBodyMatchesHeader, true);
  assert.equal(journal.requestShape.nullDraftPresent, false);
  assert.equal(journal.requestShape.draftOmitted, true);
  assert.equal(journal.requestShape.composerSessionPresent, true);
  assert.equal(stored.includes(appInfo.composer_session_id), false);
  assert.equal(journal.requestShape.crossSharingOmitted, true);
  assert.equal(journal.messageSha256, createHash('sha256').update(MESSAGE).digest('hex'));
  assert.equal(stored.includes('bloks-version-from-owner-document'), false);
  assert.equal(stored.includes('ajax-rollout-from-owner-document'), false);
  assert.equal(stored.includes(MESSAGE), false);
  await assert.rejects(replyToThreadsPost({ ...baseInput, execute: true }, deps), /THREADS_REPLY_RECONCILE_FIRST/);
  assert.equal(state.sends, 1);
});

test('reply create response must be ok and composite IDs must bind the verified owner suffix', async t => {
  const cases = [
    { responseBody: { status: 'fail', media: { id: REPLY_ID } }, code: 'THREADS_REPLY_RESPONSE_STATUS_INVALID' },
    { responseBody: { status: 'ok', media: { id: `${REPLY_ID}_99999999999` } }, code: 'THREADS_REPLY_CREATED_ID_INVALID' },
  ];
  for (const item of cases) {
    const root = await tempDir(t);
    const { state, deps } = makeDeps(root, { useDefaultPublisher: true, responseBody: item.responseBody });
    const result = await replyToThreadsPost({ ...baseInput, execute: true }, deps);
    assert.equal(result.status, 'needs_reconciliation');
    assert.equal(result.code, item.code);
    assert.equal(result.createdPostId, undefined);
    assert.equal(state.sends, 1);
    await assert.rejects(replyToThreadsPost({ ...baseInput, execute: true }, deps), /THREADS_REPLY_RECONCILE_FIRST/);
    assert.equal(state.sends, 1);
  }
});

test('reply publisher accepts a numeric post pk from an ok response', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { useDefaultPublisher: true,
    responseBody: { status: 'ok', media: { pk: REPLY_ID } } });
  const result = await replyToThreadsPost({ ...baseInput, execute: true }, deps);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.createdPostId, REPLY_ID);
  assert.equal(state.sends, 1);
});

test('HTTP 400 retains only safe provider categories and keeps the one-send reservation unresolved', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { responseStatus: 400, responseBody: {
    error_type: 'invalid_reply_parent', error_title: 'reply_not_allowed',
    message: `Rejected caption ${MESSAGE} cookie=secret-session-value`,
  } });
  const result = await replyToThreadsPost({ ...baseInput, execute: true, receiptKey: 'benefit-base-77617471229' }, deps);
  assert.equal(result.status, 'needs_reconciliation');
  assert.equal(result.code, 'THREADS_HTTP_400');
  assert.equal(result.httpStatus, 400);
  assert.equal(result.providerErrorType, 'invalid_reply_parent');
  assert.equal(result.providerErrorTitle, 'reply_not_allowed');
  assert.equal(result.providerRejectionCategory, 'unclassified');
  assert.equal(result.providerContentTypeClass, 'json');
  assert.match(result.providerBodyHash, /^[0-9a-f]{64}$/);
  assert.ok(result.providerBodyBytes > 0); assert.equal(result.providerBodyTruncated, false);
  assert.deepEqual(result.providerTopLevelKeys, ['error_type', 'error_title', 'message']);
  assert.equal(result.writes, 1);
  assert.equal(state.sends, 1);

  const rawJournal = await readFile(result.journalPath, 'utf8');
  const journal = JSON.parse(rawJournal);
  assert.equal(journal.status, 'needs_reconciliation');
  assert.equal(journal.httpStatus, 400);
  assert.equal(journal.providerErrorType, 'invalid_reply_parent');
  assert.equal(journal.providerErrorTitle, 'reply_not_allowed');
  assert.equal(journal.providerRejectionCategory, 'unclassified');
  assert.equal(rawJournal.includes(MESSAGE), false);
  assert.equal(rawJournal.includes('secret-session-value'), false);
  assert.equal(JSON.stringify(result).includes(MESSAGE), false);

  await assert.rejects(replyToThreadsPost({ ...baseInput, execute: true,
    receiptKey: 'benefit-base-77617471229' }, deps), /THREADS_REPLY_RECONCILE_FIRST/);
  assert.equal(state.sends, 1);
});

test('HTTP 400 omits token-like and prose values from provider category fields', async t => {
  const root = await tempDir(t);
  const { deps } = makeDeps(root, { responseStatus: 400, responseBody: {
    error_type: 'a'.repeat(48), error_title: `Rejected caption ${MESSAGE}`,
  } });
  const result = await replyToThreadsPost({ ...baseInput, execute: true }, deps);
  assert.equal(result.status, 'needs_reconciliation');
  assert.equal(result.httpStatus, 400);
  assert.equal(result.providerErrorType, undefined);
  assert.equal(result.providerErrorTitle, undefined);
  assert.equal(JSON.stringify(result).includes(MESSAGE), false);
});

test('HTTP error body goes only to the protected sink; journal and receipts contain a reference and no raw values', async t => {
  const root = await tempDir(t);
  const secret = 'reflected-private-session-value';
  const { state, deps } = makeDeps(root, { responseStatus: 400, responseBody: { message: secret, status: 'fail' } });
  const values = new Map();
  const store = { write(key, value) { values.set(key, value); return { stored: true, persistent: true, provider: 'Windows DPAPI CurrentUser' }; },
    read(key) { return values.get(key); } };
  const result = await replyToThreadsPost({ ...baseInput, execute: true }, { ...deps,
    errorProtector: detail => protectThreadsReplyError(detail, { store }) });
  assert.equal(result.code, 'THREADS_HTTP_400');
  assert.equal(result.providerErrorProtected, true);
  assert.match(result.providerErrorStoreKey, /^threads-reply-error-[a-f0-9]{40}$/);
  const protectedValue = JSON.parse(values.get(result.providerErrorStoreKey));
  assert.equal(JSON.parse(protectedValue.body).message, secret);
  assert.equal(protectedValue.origin, 'https://www.threads.com');
  assert.equal(protectedValue.httpStatus, 400);
  assert.equal(protectedValue.truncated, false);
  const journal = await readFile(result.journalPath, 'utf8');
  assert.equal(journal.includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  await assert.rejects(replyToThreadsPost({ ...baseInput, execute: true }, deps), /THREADS_REPLY_RECONCILE_FIRST/);
  assert.equal(state.sends, 1);
});

test('protected diagnostic failure preserves the original HTTP error and one-send reservation', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { responseStatus: 400, responseBody: { message: 'private-value' } });
  const result = await replyToThreadsPost({ ...baseInput, execute: true }, { ...deps,
    errorProtector: async () => { throw new Error('private-value'); } });
  assert.equal(result.code, 'THREADS_HTTP_400');
  assert.equal(result.providerErrorProtected, false);
  assert.equal(JSON.stringify(result).includes('private-value'), false);
  assert.equal((await readFile(result.journalPath, 'utf8')).includes('private-value'), false);
  await assert.rejects(replyToThreadsPost({ ...baseInput, execute: true }, deps), /THREADS_REPLY_RECONCILE_FIRST/);
  assert.equal(state.sends, 1);
});

test('diagnostic store refuses a non-persistent provider and mismatched protected readback', async () => {
  const input = { body: '{"message":"private-value"}', truncated: false, httpStatus: 400,
    postId: PARENT_ID, journalPath: 'test-journal' };
  await assert.rejects(protectThreadsReplyError(input, { store: {
    write() { return { stored: true, provider: 'process-memory', persistent: false }; },
  } }), /THREADS_REPLY_ERROR_DPAPI_REQUIRED/);
  await assert.rejects(protectThreadsReplyError(input, { store: {
    write() { return { stored: true, provider: 'Windows DPAPI CurrentUser', persistent: true }; },
    read() { return 'different'; },
  } }), /THREADS_REPLY_ERROR_READBACK_FAILED/);
});

test('exact SecFetch policy refusal gets a stop code, safe categories, and no resend', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { responseStatus: 400,
    responseBody: { message: 'SecFetch Policy violation', error_type: 'bad_request' } });
  const input = { ...baseInput, execute: true, receiptKey: 'benefit-base-31501987442' };
  const result = await replyToThreadsPost(input, deps);
  assert.equal(result.status, 'needs_reconciliation');
  assert.equal(result.code, 'THREADS_REPLY_SERVER_FETCH_POLICY_BLOCKED');
  assert.equal(result.httpStatus, 400);
  assert.equal(result.providerRejectionCategory, 'sec_fetch_policy_violation');
  assert.equal(result.providerContentTypeClass, 'json');
  assert.deepEqual(result.providerTopLevelKeys, ['message', 'error_type']);
  assert.equal(state.sends, 1);
  const journal = JSON.parse(await readFile(result.journalPath, 'utf8'));
  assert.equal(journal.status, 'needs_reconciliation');
  assert.equal(journal.writeFailureCode, 'THREADS_REPLY_SERVER_FETCH_POLICY_BLOCKED');
  assert.equal(journal.providerRejectionCategory, 'sec_fetch_policy_violation');
  assert.equal(JSON.stringify(journal).includes('SecFetch'), false);

  const reconciled = await replyToThreadsPost({ ...input, execute: false, reconcile: true }, deps);
  assert.equal(reconciled.reconciliationOnly, true);
  assert.equal(reconciled.code, 'THREADS_REPLY_SERVER_FETCH_POLICY_BLOCKED');
  assert.equal(reconciled.providerRejectionCategory, 'sec_fetch_policy_violation');
  assert.equal(state.sends, 1);
});

test('the captured integrity HTTP 400 is a target-scoped explicit no-create result', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { responseStatus: 400,
    responseBody: { message: 'Media blocked due to integrity.', status: 'fail' } });
  const result = await replyToThreadsPost({ ...baseInput, execute: true }, deps);
  assert.equal(result.status, 'not_created_explicit_refusal');assert.equal(result.notCreated,true);
  assert.equal(result.writeOutcome,'not_created_explicit_refusal');assert.equal(result.writes,1);
  assert.equal(result.code, 'THREADS_REPLY_SERVER_INTEGRITY_BLOCKED');
  assert.equal(result.httpStatus, 400);
  assert.equal(result.providerRejectionCategory, 'integrity_blocked');
  assert.equal(state.sends, 1);
  const reconciled = await replyToThreadsPost({ ...baseInput, reconcile: true }, deps);
  assert.equal(reconciled.status,'not_created_explicit_refusal');assert.equal(reconciled.notCreated,true);
  assert.equal(reconciled.writeOutcome,'not_created_explicit_refusal');
  assert.equal(reconciled.code, 'THREADS_REPLY_SERVER_INTEGRITY_BLOCKED');
  assert.equal(reconciled.httpStatus, 400);
  assert.equal(reconciled.providerRejectionCategory, 'integrity_blocked');
  assert.equal(reconciled.reconciliationOnly, true);
  assert.equal(state.sends, 1);
  const journal = JSON.parse(await readFile(result.journalPath, 'utf8'));
  assert.equal(journal.status,'not_created_explicit_refusal');assert.equal(journal.writeOutcome,'not_created_explicit_refusal');
  assert.equal(journal.httpStatus, 400);
  assert.equal(journal.attempts, 1);
  assert.equal(journal.writeFailureCode, 'THREADS_REPLY_SERVER_INTEGRITY_BLOCKED');
  assert.equal(journal.requestShape.parentIdsMatch, true);
  assert.equal(journal.requestShape.captionMatches, true);
  assert.equal(journal.requestDiagnostic.httpStatus, 400);
  assert.equal(result.diagnostic.request.writeSent, true);
  assert.equal(reconciled.diagnostic.request.httpStatus, 400);
});

test('configure shape fingerprints structure without content or authentication values', () => {
  const loaded = context(), secret = 'SYNTHETIC_PRIVATE_BODY';
  const request = buildObservedThreadsReplyRequest({ postId: PARENT_ID, message: secret,
    session: loaded.bundle, requestContext: { lsd: 'fresh-lsd' }, replyHeaders: loaded.replyHeaders });
  const shape = threadsConfigureRequestShape(request, { postId: PARENT_ID, message: secret });
  for (const value of [secret, 'fake-csrf', 'fresh-lsd', 'fake:session:id', PARENT_ID]) assert.equal(JSON.stringify(shape).includes(value), false);
  assert.equal(shape.parentIdsMatch, true); assert.equal(shape.captionMatches, true);
  assert.match(shape.fingerprint, /^[0-9a-f]{64}$/);
  const clone = { ...request, body: new URLSearchParams(request.body) };
  clone.body.set('caption', 'different-content');
  assert.notEqual(threadsConfigureRequestShape(clone, { postId: PARENT_ID, message: secret }).fingerprint, shape.fingerprint);
});

test('link reads finish before one configure, apply exact quote conversion, and require quote readback', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { useDefaultPublisher: true });
  const url = 'https://www.threads.com/@lifehack__ailab/post/Dd6FKe0lLG6';
  const message = MESSAGE + '\n' + url;
  const calls = [];
  const prepareLink = (text, options) => prepareThreadsReplyLink(text, { ...options, query: async (_ctx, operation, _docId, variables, referer) => {
    assert.equal(state.sends, 0);
    assert.equal(referer, 'https://www.threads.com/@target_person/post/Dd4LT_SmNY6');
    calls.push(operation);
    await new Promise(resolve => setTimeout(resolve, 5));
    if (operation === 'BarcelonaComposerQuotedPostPreviewQuery') {
      assert.equal(variables.postID, PARENT_ID);
      return { quotePost: { pk: PARENT_ID, code: 'Dd6FKe0lLG6', user: { username: OWNER } } };
    }
    return operation === 'BarcelonaLexicalAutoLinkPluginQuery' ? { link_attachment_disallowed_reason: null }
      : { link_type: 'quote', media: { pk: PARENT_ID, code: 'Dd6FKe0lLG6', user: { username: OWNER } } };
  } });
  const result = await replyToThreadsPost({ ...baseInput, message, execute: true }, { ...deps, prepareLink });
  assert.deepEqual(calls, ['BarcelonaLexicalAutoLinkPluginQuery', 'BarcelonaComposerLinkPreviewQuery', 'BarcelonaComposerQuotedPostPreviewQuery']);
  assert.equal(state.sends, 1);
  assert.equal(state.lastRequest.body.get('caption'), MESSAGE + '\n');
  assert.equal(JSON.parse(state.lastRequest.body.get('text_post_app_info')).quoted_post_id, PARENT_ID);
  assert.equal(Object.hasOwn(JSON.parse(state.lastRequest.body.get('text_post_app_info')), 'link_attachment_url'), false);
  assert.equal(result.code, 'THREADS_REPLY_QUOTE_READBACK_UNVERIFIED');
  assert.equal(result.readbackVerified, false);
  const legacy = JSON.parse(await readFile(result.journalPath, 'utf8'));
  delete legacy.linkMode;
  await writeFile(result.journalPath, JSON.stringify(legacy) + '\n', 'utf8');
  const reconciled = await replyToThreadsPost({ ...baseInput, message, reconcile: true, linkMode: 'plain_text' }, deps);
  assert.equal(reconciled.code, 'THREADS_REPLY_QUOTE_READBACK_UNVERIFIED');
  assert.equal(state.sends, 1);
  assert.equal(calls.length, 3);
});

function benefitReplyWithTwoLinks() {
  return composeThreadsBenefitReply({
    target: { id: '17824859445', handle: 'target_person', protected: false, pinnedPostId: PARENT_ID },
    pinnedPost: { id: PARENT_ID, author: 'target_person', isPinnedToProfile: true,
      publishedAt: '2026-09-30T09:00:00.000Z', text: '좋은 정보 감사합니다.' },
    contextComment: { postId: PARENT_ID, postAuthor: 'target_person', comment: '좋은 정보 감사합니다.' },
    mainShareLink: 'https://www.threads.com/@lifehack__ailab/post/Dd6FKe0lLG6',
  });
}

test('benefit reply link parser failure is an exact no-dispatch preflight before journal creation', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root);
  const composed = benefitReplyWithTwoLinks();
  assert.equal(composed.shouldReply, true);
  assert.equal((composed.text.match(/https?:\/\//g) || []).length, 2);
  let failure;
  await assert.rejects(replyToThreadsPost({ ...baseInput, message: composed.text, execute: true }, deps), error => {
    failure = error;
    return error.code === 'THREADS_REPLY_LINK_COUNT_UNSUPPORTED';
  });
  assert.equal(failure.preflightNoDispatch, true);
  assert.equal(failure.preflightStage, 'link_composition');
  assert.equal(failure.dispatchStarted, false);
  assert.equal(failure.writeSent, false);
  assert.equal(failure.journalCreated, false);
  assert.equal(failure.writes, 0);
  assert.equal(state.sends, 0);
  assert.deepEqual(await readdir(root), []);
});

test('explicit plain_text benefit mode preserves both approved URLs as caption with no quote attachment', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { useDefaultPublisher: true });
  const composed = benefitReplyWithTwoLinks();
  let linkParserCalls = 0;
  const result = await replyToThreadsPost({ ...baseInput, message: composed.text, execute: true, linkMode: 'plain_text' }, {
    ...deps, prepareLink: async () => { linkParserCalls += 1; throw new Error('must not run in plain_text mode'); },
  });
  const appInfo = JSON.parse(state.lastRequest.body.get('text_post_app_info'));
  assert.equal(linkParserCalls, 0);
  assert.equal(state.sends, 1);
  assert.equal(state.lastRequest.body.get('caption'), composed.text);
  assert.equal(appInfo.text_with_entities.text, composed.text);
  assert.equal(appInfo.quoted_post_id, null);
  assert.equal(appInfo.link_attachment_url, null);
  assert.equal(composed.text.includes('https://www.threads.com/@lifehack__ailab/post/Dd6FKe0lLG6'), true);
  assert.equal(composed.text.includes('https://t.me/lifehack_ailab'), true);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.readbackVerified, true);
  assert.equal(result.live_replay, false);
});

test('a STOP toggled during slow parent or owner-context preflight persists positive no-send proof', async t => {
  for (const stage of ['postReader', 'contextLoader']) {
    const root = await tempDir(t);
    const { state, deps } = makeDeps(root);
    let signalEntered, release;
    const entered = new Promise(resolve => { signalEntered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const original = deps[stage];
    deps[stage] = async (...args) => {
      const result = await original(...args);
      signalEntered();
      await gate;
      return result;
    };
    let mayWrite = true;
    const run = replyToThreadsPost({ ...baseInput, execute: true }, { ...deps,
      beforeWrite: async () => mayWrite });
    await entered;
    mayWrite = false;
    release();
    const result = await run;

    assert.equal(result.status, 'not_sent_verified', stage);
    assert.equal(result.notSentVerified, true, stage);
    assert.equal(result.preflightNoDispatch, true, stage);
    assert.equal(result.preflightStage, 'before_write_guard', stage);
    assert.equal(result.dispatchStarted, false, stage);
    assert.equal(result.writeSent, false, stage);
    assert.equal(result.journalCreated, true, stage);
    assert.equal(result.writes, 0, stage);
    assert.equal(result.observedWrites, 0, stage);
    assert.equal(state.sends, 0, stage);
    const stored = await readFile(result.journalPath, 'utf8');
    const journal = JSON.parse(stored);
    assert.equal(journal.status, 'not_sent_verified', stage);
    assert.equal(journal.notSentVerified, true, stage);
    assert.equal(journal.attempts, 0, stage);
    assert.equal(journal.dispatchStarted, false, stage);
    assert.equal(journal.writeSent, false, stage);
    assert.equal(Object.hasOwn(journal, 'writeStartedAt'), false, stage);
    assert.equal(Object.hasOwn(journal, 'createdPostId'), false, stage);
    assert.equal(Object.hasOwn(journal, 'requestShape'), false, stage);
    assert.equal((await readdir(root)).filter(name => name.endsWith('.json')).length, 1, stage);
  }
});

test('a thrown beforeWrite guard is verified no-send and can resume once on the same journal', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { useDefaultPublisher: true });
  const keyedInput = { ...baseInput, execute: true, receiptKey: 'benefit-base-123456' };
  const stopped = await replyToThreadsPost(keyedInput, { ...deps,
    beforeWrite: async () => { throw Object.assign(new Error('private stop reason'), { code: 'PRIVATE_VALUE' }); } });
  assert.equal(stopped.status, 'not_sent_verified');
  assert.equal(stopped.code, 'THREADS_REPLY_BEFORE_WRITE_STOPPED');
  assert.equal(stopped.writes, 0);
  assert.equal(state.sends, 0);
  const noSendRaw = await readFile(stopped.journalPath, 'utf8');
  const noSend = JSON.parse(noSendRaw);
  assert.equal(noSend.status, 'not_sent_verified');
  assert.equal(noSend.beforeWriteGuardResult, 'threw');
  assert.equal(noSend.attempts, 0);
  assert.equal(JSON.stringify(noSend).includes('private stop reason'), false);
  assert.equal(JSON.stringify(noSend).includes('PRIVATE_VALUE'), false);

  await writeFile(stopped.journalPath, JSON.stringify({ ...noSend, dispatchStarted: true }) + '\n', 'utf8');
  await assert.rejects(replyToThreadsPost(keyedInput, { ...deps, beforeWrite: async () => true }),
    { code: 'THREADS_REPLY_JOURNAL_MISMATCH' });
  assert.equal(state.sends, 0);
  await writeFile(stopped.journalPath, noSendRaw, 'utf8');

  const resumed = await replyToThreadsPost(keyedInput, { ...deps, beforeWrite: async () => undefined });
  assert.equal(resumed.journalPath, stopped.journalPath);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.writes, 1);
  assert.equal(state.sends, 1);
  const finalJournal = JSON.parse(await readFile(stopped.journalPath, 'utf8'));
  assert.equal(finalJournal.attempts, 1);
  assert.equal(finalJournal.status, 'succeeded');
  assert.equal(finalJournal.notSentVerified, false);
  assert.equal(Number.isFinite(Date.parse(finalJournal.priorNotSentVerifiedAt)), true);

  await assert.rejects(replyToThreadsPost(keyedInput, { ...deps, beforeWrite: async () => true }),
    { code: 'THREADS_REPLY_RECONCILE_FIRST' });
  assert.equal(state.sends, 1);
});

test('not-sent journal binds linkMode; changed mode is held before reads and same-mode resume works', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { useDefaultPublisher: true });
  const composed = benefitReplyWithTwoLinks();
  const plainInput = { ...baseInput, message: composed.text, execute: true, linkMode: 'plain_text' };
  const stopped = await replyToThreadsPost(plainInput, { ...deps, beforeWrite: async () => false });
  assert.equal(stopped.status, 'not_sent_verified');
  assert.equal(state.sends, 0);
  const originalJournal = await readFile(stopped.journalPath, 'utf8');
  assert.equal(JSON.parse(originalJournal).linkMode, 'plain_text');

  let reads = 0;
  const originalPostReader = deps.postReader, originalCommentsReader = deps.commentsReader;
  deps.postReader = async (...args) => { reads += 1; return originalPostReader(...args); };
  deps.commentsReader = async (...args) => { reads += 1; return originalCommentsReader(...args); };
  await assert.rejects(replyToThreadsPost({ ...plainInput, linkMode: 'auto_quote' }, { ...deps,
    beforeWrite: async () => true }), { code: 'THREADS_REPLY_JOURNAL_MISMATCH' });
  assert.equal(reads, 0);
  assert.equal(state.sends, 0);
  assert.equal(await readFile(stopped.journalPath, 'utf8'), originalJournal);

  const resumed = await replyToThreadsPost(plainInput, { ...deps, beforeWrite: async () => true });
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.journalPath, stopped.journalPath);
  assert.equal(state.sends, 1);
  assert.equal(state.lastRequest.body.get('caption'), composed.text);
  const appInfo = JSON.parse(state.lastRequest.body.get('text_post_app_info'));
  assert.equal(appInfo.quoted_post_id, null);
  assert.equal(appInfo.link_attachment_url, null);
});

test('unknown write journal still blocks before provider reads and is never overwritten', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { failSend: true });
  const keyedInput = { ...baseInput, execute: true, receiptKey: 'benefit-base-123456' };
  const sent = await replyToThreadsPost(keyedInput, deps);
  assert.equal(sent.status, 'needs_reconciliation');
  const legacy = JSON.parse(await readFile(sent.journalPath, 'utf8'));
  delete legacy.linkMode;
  const originalJournal = JSON.stringify(legacy) + '\n';
  await writeFile(sent.journalPath, originalJournal, 'utf8');
  let reads = 0;
  deps.postReader = async () => { reads += 1; throw new Error('must not read'); };
  deps.commentsReader = async () => { reads += 1; throw new Error('must not read'); };
  await assert.rejects(replyToThreadsPost(keyedInput, { ...deps, beforeWrite: async () => true }),
    { code: 'THREADS_REPLY_RECONCILE_FIRST' });
  assert.equal(reads, 0);
  assert.equal(state.sends, 1);
  assert.equal(await readFile(sent.journalPath, 'utf8'), originalJournal);
});

test('configure HTTP 429 persists a shared cooldown once and keeps its one-attempt journal held', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { useDefaultPublisher: true, responseStatus: 429,
    responseBody: { status: 'fail' } });
  const result = await replyToThreadsPost({ ...baseInput, execute: true }, { ...deps, http429CooldownRoot: root });
  assert.equal(result.code, 'THREADS_REPLY_HTTP_429');
  assert.equal(result.httpStatus, 429);
  assert.equal(result.rateLimited, true);
  assert.equal(result.cooldownPersisted, true);
  assert.equal(Number.isSafeInteger(result.retryAt), true);
  assert.equal(result.writes, 1);
  assert.equal(state.sends, 1);
  const cooldown = await readThreadsSharedCooldown({ root, now: Date.now() });
  assert.equal(cooldown.httpStatus, 429);
  assert.equal(cooldown.operation, 'configure_text_only_post');
  const records = await Promise.all((await readdir(root)).filter(name => name.endsWith('.json'))
    .map(async name => JSON.parse(await readFile(path.join(root, name), 'utf8'))));
  const journal = records.find(record => record.operation === 'reply');
  assert.equal(journal.attempts, 1);
  assert.equal(journal.status, 'needs_reconciliation');
  assert.equal(journal.writeHttpStatus, 429);
  await assert.rejects(replyToThreadsPost({ ...baseInput, execute: true }, { ...deps, http429CooldownRoot: root }),
    { code: 'THREADS_REPLY_RECONCILE_FIRST' });
  assert.equal(state.sends, 1);
});

test('429 cooldown persistence failure is surfaced without a second configure attempt', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { useDefaultPublisher: true, responseStatus: 429,
    responseBody: { status: 'fail' } });
  const http429CooldownRecorder = async () => {
    throw Object.assign(new Error('safe fixture failure'), { code: 'META_HTTP_429_COOLDOWN_PERSIST_FAILED',
      httpStatus: 429, retryAt: Date.now() + 900_000, retryAfterSeconds: 900, cooldownPersisted: false,
      rateLimited: true, cooldownReason: 'http_429_rate_limit', deadlineSource: 'local_fallback_15_minutes' });
  };
  const result = await replyToThreadsPost({ ...baseInput, execute: true }, { ...deps, http429CooldownRecorder });
  assert.equal(result.code, 'META_HTTP_429_COOLDOWN_PERSIST_FAILED');
  assert.equal(result.httpStatus, 429);
  assert.equal(result.cooldownPersisted, false);
  assert.equal(result.writes, 1);
  assert.equal(state.sends, 1);
  const records = await Promise.all((await readdir(root)).filter(name => name.endsWith('.json'))
    .map(async name => JSON.parse(await readFile(path.join(root, name), 'utf8'))));
  const journal = records.find(record => record.operation === 'reply');
  assert.equal(journal.attempts, 1);
  assert.equal(journal.writeHttpStatus, 429);
  await assert.rejects(replyToThreadsPost({ ...baseInput, execute: true }, { ...deps, http429CooldownRecorder }),
    { code: 'THREADS_REPLY_RECONCILE_FIRST' });
  assert.equal(state.sends, 1);
});

test('a mismatched final quote card stops before journal reservation and configure', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { useDefaultPublisher: true });
  const url = 'https://www.threads.com/@lifehack__ailab/post/Dd6FKe0lLG6';
  const prepareLink = (text, options) => prepareThreadsReplyLink(text, { ...options,
    query: async (_ctx, operation) => {
      if (operation === 'BarcelonaLexicalAutoLinkPluginQuery') return { link_attachment_disallowed_reason: null };
      if (operation === 'BarcelonaComposerLinkPreviewQuery') return { link_type: 'quote',
        media: { pk: PARENT_ID, code: 'Dd6FKe0lLG6', user: { username: OWNER } } };
      return { quotePost: { pk: REPLY_ID, code: 'Dd6FKe0lLG6', user: { username: OWNER } } };
    } });
  await assert.rejects(replyToThreadsPost({ ...baseInput, message: MESSAGE + '\n' + url, execute: true }, { ...deps, prepareLink }),
    { code: 'THREADS_REPLY_QUOTE_PREVIEW_IDENTITY_MISMATCH' });
  assert.equal(state.sends, 0);
  assert.deepEqual(await readdir(root), []);
});

test('reply referer must bind the verified parent author before reservation', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { useDefaultPublisher: true });
  const read = deps.postReader;
  deps.postReader = async input => ({ ...await read(input), url: 'https://www.threads.com/@other_author/post/Dd4LT_SmNY6' });
  await assert.rejects(replyToThreadsPost({ ...baseInput, execute: true }, deps), { code: 'THREADS_REPLY_PARENT_URL_INVALID' });
  assert.equal(state.sends, 0);
  assert.deepEqual(await readdir(root), []);
  for (const parentUrl of ['https://example.com/@target_person/post/Dd4LT_SmNY6',
    'https://www.threads.com/@target_person/post/Dd4LT_SmNY6?session=secret',
    'https://www.threads.com/@target_person/post/Dd4LT_SmNY6#draft']) {
    assert.throws(() => buildObservedThreadsReplyRequest({ postId: PARENT_ID, message: MESSAGE,
      session: context().bundle, replyHeaders: REPLY_HEADERS, requestContext: { lsd: 'fresh-lsd' }, parentUrl }),
      { code: 'THREADS_REPLY_PARENT_URL_INVALID' });
  }
});

test('a forbidden link or mismatched preview stops before reservation and configure', async t => {
  const url = 'https://www.threads.com/@lifehack__ailab/post/Dd6FKe0lLG6';
  for (const mismatch of [false, true]) {
    const root = await tempDir(t);
    const { state, deps } = makeDeps(root, { useDefaultPublisher: true });
    const prepareLink = (text, options) => prepareThreadsReplyLink(text, { ...options, query: async (_ctx, operation) =>
      operation === 'BarcelonaLexicalAutoLinkPluginQuery' ? { link_attachment_disallowed_reason: mismatch ? null : 'disallowed' }
        : { link_type: 'quote', media: { pk: PARENT_ID, code: 'othercode', user: { username: OWNER } } } });
    await assert.rejects(replyToThreadsPost({ ...baseInput, message: MESSAGE + '\n' + url, execute: true }, { ...deps, prepareLink }),
      mismatch ? /THREADS_REPLY_PREVIEW_IDENTITY_MISMATCH/ : /THREADS_REPLY_LINK_NOT_ALLOWED/);
    assert.equal(state.sends, 0);
    assert.deepEqual(await readdir(root), []);
  }
});

test('owner self-thread continuation verifies the exact adjacent parent when direct_replies omits it',async t=>{
  const root=await tempDir(t);
  const {state,deps}=makeDeps(root,{selfThreadReadback:true});
  const result=await replyToThreadsPost({...baseInput,execute:true},deps);
  assert.equal(result.status,'succeeded');
  assert.equal(result.readbackVerified,true);
  assert.equal(result.existingDirectRepliesObserved,0);
  assert.equal(result.existingSelfThreadRepliesObserved,0);
  assert.equal(result.parentRelationSource,'self_thread_adjacent_position');
  assert.equal(state.sends,1);
});

test('self-thread item with a different parent remains unresolved and is never inferred as direct',async t=>{
  const root=await tempDir(t);
  const {state,deps}=makeDeps(root,{selfThreadReadback:true,mismatchSelfThreadParent:true});
  const result=await replyToThreadsPost({...baseInput,execute:true},deps);
  assert.equal(result.status,'needs_reconciliation');
  assert.equal(result.success,false);
  assert.equal(result.code,'THREADS_REPLY_PARENT_PAGE_INCOMPLETE');
  assert.equal(state.sends,1);
});

test('benefit stage receipt keys allow separate base and bonus replies while reserving each key once', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root);
  const base = await replyToThreadsPost({ ...baseInput, message: '스하리 완료🚨', execute: true,
    receiptKey: 'benefit-base-123456' }, deps);
  const otherActor = await replyToThreadsPost({ ...baseInput, message: '스하리 완료🚨 @other_person', execute: true,
    receiptKey: 'benefit-base-987654' }, deps);
  const bonus = await replyToThreadsPost({ ...baseInput, message: '추가 반응 3쌍 완료', execute: true,
    receiptKey: 'benefit-bonus-123456' }, deps);
  assert.equal(base.status, 'succeeded');
  assert.equal(otherActor.status, 'succeeded');
  assert.equal(bonus.status, 'succeeded');
  assert.notEqual(base.journalPath, bonus.journalPath);
  assert.equal(new Set(state.runKeys).size, 3);
  await assert.rejects(replyToThreadsPost({ ...baseInput, message: '다른 기본 답글', execute: true,
    receiptKey: 'benefit-base-123456' }, deps), /THREADS_REPLY_JOURNAL_MISMATCH/);
  assert.equal(state.sends, 3);
  await assert.rejects(replyToThreadsPost({ ...baseInput, message: 'x', execute: true,
    receiptKey: 'benefit-base-123456-extra' }, deps), /THREADS_REPLY_INPUT_INVALID/);
});

test('ambiguous send remains reserved; explicit incomplete-scan reconciliation never resends', async t => {
  const root = await tempDir(t);
  const { state, deps } = makeDeps(root, { failSend: true });
  const keyedInput = { ...baseInput, execute: true, receiptKey: 'benefit-base-123456' };
  const result = await replyToThreadsPost(keyedInput, deps);
  assert.equal(result.status, 'needs_reconciliation');
  assert.equal(result.writes, 1);
  assert.equal(result.readbackVerified, undefined);
  assert.equal(state.sends, 1);

  await assert.rejects(replyToThreadsPost({ ...keyedInput, message: 'different text' }, deps),
    /THREADS_REPLY_JOURNAL_MISMATCH/);
  const reconciled = await replyToThreadsPost({ ...baseInput, receiptKey: keyedInput.receiptKey, reconcile: true }, deps);
  assert.equal(reconciled.status, 'needs_reconciliation');
  assert.equal(reconciled.reconciliationOnly, true);
  assert.equal(reconciled.parentPageFull, false);
  assert.equal(reconciled.live_replay, false);
  assert.equal(state.sends, 1);
});

test('--help explains the text-only prepare, execute, and reconcile modes', () => {
  for (const flag of ['--help', 'help']) {
    const output = execFileSync(process.execPath, [cli, flag], { encoding: 'utf8' });
    assert.match(output, /Prepare \(read only\)/);
    assert.match(output, /--execute/);
    assert.match(output, /--reconcile/);
  }
});
