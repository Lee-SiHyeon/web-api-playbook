import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareThreadsReplyLink } from '../threads-reply-link.mjs';
import { recordThreadsGraphqlCooldown, readThreadsSharedCooldown } from '../lib/threads-graphql-throttle.mjs';

const link = 'https://www.threads.com/@lifehack__ailab/post/Dd6FKe0lLG6';
const parent = 'https://www.threads.com/@target_person/post/Dd4LT_SmNY6';
const message = '스하리 혜택 안내\n' + link;
const quote = { pk: '3997530329766474170', code: 'Dd6FKe0lLG6', user: { username: 'lifehack__ailab' } };
async function fixture(t, fetchImpl) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'threads-preview-cooldown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { service: 'threads', handle: 'lifehack__ailab', createdAt: Date.now(), requestCount: 0, throttleRoot: root,
    url: 'https://www.threads.com/@lifehack__ailab/', fetchImpl,
    documentReceipt: { ownerVerified: true },
    bundle: { service: 'threads', origin: 'https://www.threads.com', owner: 'lifehack__ailab', ownerId: '17824859444',
      cookies: [{ name: 'csrftoken', value: 'synthetic-csrf', domain: '.threads.com', path: '/', secure: true }] },
    document: { modules: new Map([
      ['DTSGInitialData', { token: 'synthetic-dtsg' }], ['LSD', { token: 'synthetic-lsd' }],
      ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
      ['CurrentUserInitialData', { USER_ID: '0' }],
      ['RelayAPIConfigDefaults', { actorID: '0', customHeaders: { 'x-ig-app-id': 'synthetic-app' } }],
      ['SiteData', { haste_session: 'synthetic', pr: 1, client_revision: 1, hsi: 1, comet_env: 1, __spin_r: 1, __spin_b: 'trunk', __spin_t: 1 }],
    ]) }, sources: new Map([['DTSGUtils', { source: 'SprinkleConfig .charCodeAt(' }]]) };
  return { root, context };
}
const jsonResponse = data => {
  const response = new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  Object.defineProperty(response, 'url', { value: 'https://www.threads.com/graphql/query' });
  return response;
};

test('a shared hold prevents composer preview dispatch on the alternate GraphQL path', async t => {
  let fetches = 0;
  const { root, context } = await fixture(t, async () => { fetches++; throw new Error('unexpected dispatch'); });
  await recordThreadsGraphqlCooldown({ response: new Response(null, { status: 200 }), operation: 'BarcelonaProfileTimelineQuery', root });
  await assert.rejects(prepareThreadsReplyLink(message, { context, parentUrl: parent }), error =>
    error.code === 'META_GRAPHQL_THROTTLED' && error.writeSent === false && error.dispatchStarted === false);
  assert.equal(fetches, 0);
});

test('preview error1675004 persists a shared hold and prevents the next preview', async t => {
  const requests = [];
  const { root, context } = await fixture(t, async (url, init) => {
    requests.push({ url, operation: init.body.get('fb_api_req_friendly_name'), referer: init.headers.referer });
    return jsonResponse({ data: null, errors: [{ code: 1675004 }] });
  });
  await assert.rejects(prepareThreadsReplyLink(message, { context, parentUrl: parent }), { code: 'META_GRAPHQL_THROTTLED' });
  const held = await readThreadsSharedCooldown({ root });
  assert.equal(held.providerErrorCode, 1675004);
  assert.equal(held.operation, 'BarcelonaLexicalAutoLinkPluginQuery');
  await assert.rejects(prepareThreadsReplyLink(message, { context, parentUrl: parent }), { code: 'META_GRAPHQL_THROTTLED' });
  assert.deepEqual(requests, [{ url: 'https://www.threads.com/graphql/query', operation: 'BarcelonaLexicalAutoLinkPluginQuery', referer: parent }]);
});

test('three successful native previews preserve exact quote identity and parent Referer', async t => {
  const requests = [];
  const { context } = await fixture(t, async (url, init) => {
    const operation = init.body.get('fb_api_req_friendly_name');
    requests.push({ url, operation, referer: init.headers.referer });
    if (operation === 'BarcelonaLexicalAutoLinkPluginQuery') return jsonResponse({ status: 'ok', data: { data: { link_attachment_disallowed_reason: null } } });
    if (operation === 'BarcelonaComposerLinkPreviewQuery') return jsonResponse({ status: 'ok', data: { data: { link_type: 'quote', media: quote } } });
    return jsonResponse({ status: 'ok', data: { quotePost: quote } });
  });
  const prepared = await prepareThreadsReplyLink(message, { context, parentUrl: parent });
  assert.equal(prepared.quotedPostId, quote.pk);
  assert.equal(prepared.caption, '스하리 혜택 안내\n');
  assert.equal(prepared.quoteRead.httpStatus, 200);
  assert.equal(prepared.quoteRead.identityVerified, true);
  assert.deepEqual(requests.map(request => request.operation), ['BarcelonaLexicalAutoLinkPluginQuery', 'BarcelonaComposerLinkPreviewQuery', 'BarcelonaComposerQuotedPostPreviewQuery']);
  for (const request of requests) assert.deepEqual([request.url, request.referer], ['https://www.threads.com/graphql/query', parent]);
});

test('a challenge response remains an interaction stop and does not become a throttle', async t => {
  let fetches = 0;
  const { root, context } = await fixture(t, async () => {
    fetches++; return jsonResponse({ data: null, errors: [{ code: 1675004, message: 'checkpoint required' }] });
  });
  await assert.rejects(prepareThreadsReplyLink(message, { context, parentUrl: parent }), { code: 'META_INTERACTION_REQUIRED' });
  assert.equal(fetches, 1);
  assert.equal(await readThreadsSharedCooldown({ root }), null);
});
