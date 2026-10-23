import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { definitions } from '../lib/service-operations/extras.mjs';
import { createOperationRegistry, validateOperationProfile } from '../lib/operation-registry.mjs';
import { validateServiceDefinitions } from '../lib/service-operations/index.mjs';
import { verifyServiceOperations } from '../lib/service-operations/verify.mjs';
import { ScopedSession } from '../lib/scoped-session.mjs';

const CHANNEL = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const VIDEO = 'dQw4w9WgXcQ';
const SECRET = 'EXTRAS_TEST_ONLY_CREDENTIAL_91827';
const AUTH = 'EXTRAS_TEST_ONLY_NID_AUT_4728';
const SES = 'EXTRAS_TEST_ONLY_NID_SES_9834';
const OWNER = { publisherId: 17, userNo: 29, bizUserNo: 41 };
const MEMBER_PATH = '/api-public/v3/shopping-growth/sharelink/member';
const CURATION_PATH = '/api-public/v3/shopping/sharelink/curation-sections';
const resolve = id => definitions.find(definition => definition.id === id);
function registry(id, options = {}) {
  const definition = resolve(id);
  return createOperationRegistry(definition.profile, definition.createAdapters(options));
}
function json(value, status = 200, headers = {}) { return Response.json(value, { status, headers }); }
function rss({ traffic = '20K+', keyword = 'A &amp; B' } = {}) {
  return `<rss xmlns:ht="https://trends.google.com/trending/rss"><channel><item><title>${keyword}</title>` +
    `<ht:approx_traffic>${traffic}</ht:approx_traffic><pubDate>Tue, 20 Oct 2026 01:00:00 GMT</pubDate>` +
    '<ht:picture_source>Example source</ht:picture_source><ht:news_item>' +
    '<ht:news_item_title><![CDATA[Related article]]></ht:news_item_title>' +
    '<ht:news_item_url>https://example.test/news</ht:news_item_url><ht:news_item_source>Example</ht:news_item_source>' +
    '</ht:news_item></item></channel></rss>';
}
function xmlResponse(value, status = 200) { return new Response(value, { status, headers: { 'content-type': 'application/rss+xml; charset=utf-8' } }); }
function youtubeFeed() {
  return '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">' +
    `<title>Public feed</title><entry><id>yt:video:${VIDEO}</id><yt:videoId>${VIDEO}</yt:videoId><yt:channelId>${CHANNEL}</yt:channelId>` +
    `<title>Creator coupon</title><link rel="alternate" href="https://www.youtube.com/watch?v=${VIDEO}"/>` +
    `<author><name>Creator</name><uri>https://www.youtube.com/channel/${CHANNEL}</uri></author>` +
    '<published>2026-10-19T01:00:00Z</published><updated>2026-10-19T01:00:00Z</updated>' +
    '<media:group><media:description>광고 포함 쿠폰 할인</media:description></media:group></entry></feed>';
}
function tossState() {
  return { version: 1, service: 'toss-sharelink', allowedOrigin: 'https://sharelink.toss.im', capturedAt: 1700000000000,
    cookies: [{ name: 'TBIZAUTH', value: SECRET, domain: '.toss.im', path: '/', secure: true, httpOnly: true, expires: -1 }],
    expectedOwner: { ...OWNER }, readRequests: {
      member: { method: 'GET', url: `https://sharelink.toss.im${MEMBER_PATH}` },
      'shopping-curation-sections': { method: 'GET', url: `https://sharelink.toss.im${CURATION_PATH}?surface=home&size=20` },
    } };
}
function elevenState() {
  const origin = 'https://elevenlabs.io';
  const session = new ScopedSession({ allowedOrigins: [origin], cookieOrigins: [], defaultHeaders: {},
    headersByOrigin: { [origin]: { authorization: `Bearer ${SECRET}` } }, maxRedirects: 0 }).toJSON();
  return { schema: 'elevenlabs-observed-session-v1', capturedAt: '2026-10-19T00:00:00.000Z',
    observedResponseStatuses: [200], credentialKinds: ['header:authorization'], session };
}
function brandState() {
  const origin = 'https://gw-brandconnect.naver.com';
  const session = new ScopedSession({ allowedOrigins: [origin], cookieOrigins: [origin],
    cookies: [
      { name: 'NID_AUT', value: AUTH, domain: '.naver.com', path: '/', secure: true, expires: -1 },
      { name: 'NID_SES', value: SES, domain: '.naver.com', path: '/', secure: true, expires: -1 },
    ], defaultHeaders: { accept: 'application/json' },
    headersByOrigin: { [origin]: { referer: 'https://brandconnect.naver.com/', 'x-space-id': '123456' } }, maxRedirects: 0 }).toJSON();
  return { version: 1, expectedLoginId: 'fixture-owner-login', spaceId: '123456',
    referer: 'https://brandconnect.naver.com/', userAgent: 'Fixture user agent', verified: true, session };
}
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'service-extras-tests-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function finite(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { assert.ok(Number.isFinite(value)); return; }
  assert.equal(typeof value, 'object', 'undefined and non-JSON values must be omitted');
  for (const child of Object.values(value)) finite(child);
}
function noSecrets(value) {
  finite(value);
  const serialized = JSON.stringify(value);
  for (const secret of [SECRET, AUTH, SES, 'fixture-owner-login']) assert.equal(serialized.includes(secret), false);
  for (const field of ['cookieJar', 'headersByOrigin', 'expectedOwner', 'expectedLoginId', 'credentialKinds']) assert.equal(serialized.includes(`"${field}"`), false);
}
async function rejected(promise, code, { networkUsed, status } = {}) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    noSecrets({ code: error.code, message: error.message, receipt: error.receipt });
    if (networkUsed !== undefined) assert.equal(error.receipt?.networkUsed, networkUsed);
    if (status !== undefined) assert.equal(error.receipt?.httpStatus, status);
    return true;
  });
}
function brandFetch(calls, { loginId = 'fixture-owner-login', catalogue = { items: [{ affiliateProductId: 'p-1', title: 'A product' }], totalCount: 1 } } = {}) {
  return async (target, init) => {
    const url = new URL(target), headers = new Headers(init.headers);
    assert.equal(init.method, 'GET');
    assert.equal(url.origin, 'https://gw-brandconnect.naver.com');
    assert.ok(headers.get('cookie').includes(AUTH));
    assert.ok(headers.get('cookie').includes(SES));
    calls.push(url);
    if (url.pathname === '/brand-connect/query/me') return json({ loginId, creator: true, partner: false, activeSpaceIds: ['123456'] });
    if (url.pathname === '/brand-connect/query/space/check-owner') return new Response('', { status: 200 });
    return json(catalogue);
  };
}

test('extras definitions are lazy read-only v2 profiles with honest verification kinds and no commerce collisions', () => {
  assert.deepEqual(definitions.map(definition => definition.id), ['elevenlabs', 'toss-sharelink', 'creator-youtube', 'creator-google', 'brandconnect']);
  validateServiceDefinitions(definitions);
  for (const definition of definitions) {
    validateOperationProfile(definition.profile);
    const binding = definition.createAdapters({
      fetchImpl: () => assert.fail('metadata must not fetch'),
      credentialProvider: () => assert.fail('binding must not open credentials'),
    });
    for (const [action, operation] of Object.entries(definition.profile.operations)) {
      assert.equal(operation.adapter, `${definition.id}.${action}`);
      assert.equal(operation.semantics, 'read');
      assert.equal(typeof binding.adapters[operation.adapter], 'function');
      assert.ok(operation.evidence.length > 0);
    }
    for (const check of definition.verificationChecks) assert.equal(check.kind, definition.id === 'elevenlabs' ? 'local' : 'live_read');
  }
  assert.deepEqual(resolve('creator-youtube').verificationChecks, []);
  assert.deepEqual(resolve('creator-google').checklistIds, ['creator-google']);
  assert.equal(definitions.some(definition => ['ably', 'adpick'].includes(definition.id)), false);
});

test('Google RSS reuses native fetch/parser and records an actual injected GET, not a rank or dashboard claim', async () => {
  const calls = [];
  const client = registry('creator-google', { fetchImpl: async (target, init) => {
    calls.push({ url: new URL(target), init });
    return xmlResponse(rss());
  }, credentialProvider: () => assert.fail('public RSS needs no provider') });
  const result = await client.execute('rss');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, 'https://trends.google.com/trending/rss?geo=KR');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(new Headers(calls[0].init.headers).has('cookie'), false);
  assert.equal(result.data.geo, 'KR');
  assert.equal(result.data.trends[0].keyword, 'A & B');
  assert.equal(result.data.trends[0].approxTraffic, 20000);
  assert.equal(result.data.trends[0].news[0].title, 'Related article');
  assert.equal('rank' in result.data.trends[0], false);
  assert.equal(result.receipt.networkUsed, true);
  assert.equal(result.receipt.httpStatus, 200);
  assert.equal(result.receipt.responseContentType, 'application/rss+xml; charset=utf-8');
  assert.equal(result.receipt.requestCount, 1);
  assert.equal(result.receipt.writesSubmitted, 0);
  noSecrets(result);
});

test('unsupported Google market HTTP status is preserved and is never reported as an empty successful feed', async () => {
  let calls = 0;
  const client = registry('creator-google', { fetchImpl: async () => { calls++; return new Response('not supported', { status: 400 }); } });
  await rejected(client.execute('rss', { query: { geo: 'CN' } }), 'HTTP_STATUS', { networkUsed: true, status: 400 });
  assert.equal(calls, 1);
});

test('Google input and RSS schema failures are stable, without returning a raw HTML body', async () => {
  let calls = 0;
  const client = registry('creator-google', { fetchImpl: async () => { calls++; return new Response(`<html>${SECRET}</html>`); } });
  await rejected(client.execute('rss', { query: { geo: 'kr' } }), 'OPERATION_INPUT_INVALID', { networkUsed: false });
  await rejected(client.execute('rss'), 'CREATOR_GOOGLE_SCHEMA_INVALID', { networkUsed: true, status: 200 });
  assert.equal(calls, 1);
});

test('RSS normalization omits non-finite approximate traffic instead of emitting invalid adapter JSON', async () => {
  const result = await registry('creator-google', { fetchImpl: async () => xmlResponse(rss({ traffic: '9'.repeat(400) })) }).execute('rss');
  assert.equal('approxTraffic' in result.data.trends[0], false);
  finite(result);
});

test('RSS body is bounded before native text parsing and over-limit retry does not issue a second read', async () => {
  let calls = 0;
  const client = registry('creator-google', { fetchImpl: async () => { calls++; return xmlResponse('x'.repeat(2 * 1024 * 1024 + 1)); } });
  await rejected(client.execute('rss'), 'CREATOR_GOOGLE_BODY_LIMIT', { networkUsed: true, status: 200 });
  assert.equal(calls, 1);
});

test('caller-selected creator YouTube feed uses only the existing public Atom reader', async () => {
  const calls = [];
  const client = registry('creator-youtube', { fetchImpl: async (target, init) => {
    calls.push({ url: new URL(target), init });
    return new Response(youtubeFeed(), { headers: { 'content-type': 'application/atom+xml' } });
  }, credentialProvider: () => assert.fail('public feed needs no provider') });
  const result = await client.execute('feed', { query: { channelId: CHANNEL } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(result.data.videos[0].videoId, VIDEO);
  assert.equal(result.data.videos[0].creatorClaims.status, 'unverified_creator_claim');
  assert.equal(result.data.collection.complete, false);
  assert.equal(result.receipt.networkUsed, true);
  assert.equal(result.receipt.request.httpStatus, 200);
  assert.equal(result.receipt.schemaVerified, true);
  noSecrets(result);
});

test('no invented public channel is substituted and missing/invalid channel inputs never fetch', async () => {
  let calls = 0;
  const client = registry('creator-youtube', { fetchImpl: async () => { calls++; assert.fail('invalid channel'); } });
  await assert.rejects(client.execute('feed'), { code: 'OPERATION_INPUT_REQUIRED' });
  await rejected(client.execute('feed', { query: { channelId: 'invalid' } }), 'YOUTUBE_CHANNEL_ID_INVALID', { networkUsed: false });
  assert.equal(calls, 0);
});

test('public feed redirect/login response fails with native sanitized status instead of following it', async () => {
  let calls = 0;
  const client = registry('creator-youtube', { fetchImpl: async () => { calls++; return new Response(SECRET, { status: 302, headers: { location: 'https://example.test/login' } }); } });
  await rejected(client.execute('feed', { query: { channelId: CHANNEL } }), 'YOUTUBE_REDIRECT_REJECTED', { networkUsed: true, status: 302 });
  assert.equal(calls, 1);
});

test('ElevenLabs existing-session status remains strictly local and never returns credential/session state', async () => {
  const ids = [];
  const result = await registry('elevenlabs', { credentialProvider: async id => { ids.push(id); return { state: elevenState() }; },
    fetchImpl: () => assert.fail('no ElevenLabs API endpoint is implemented') }).execute('status');
  assert.deepEqual(ids, ['elevenlabs']);
  assert.equal(result.data.stored, true);
  assert.equal(result.data.liveCheckPerformed, false);
  assert.equal(result.data.authenticatedOwnerVerified, false);
  assert.equal(result.data.generationPerformed, false);
  assert.equal(result.receipt.networkUsed, false);
  assert.equal('httpStatus' in result.receipt, false);
  assert.deepEqual(result.data.observedOrigins, ['https://elevenlabs.io']);
  noSecrets(result);
});

test('prepared store credentials honor sessionName/storeDirectory without reading or writing any other entry', async () => {
  const names = [];
  const source = { directory: os.tmpdir(), read(name) { names.push(name); return JSON.stringify(elevenState()); },
    write: () => assert.fail('read adapter must not write through'), status: () => assert.fail('do not expose raw provider status') };
  const result = await registry('elevenlabs', { credentialProvider: async () => ({ store: source }),
    sessionName: 'prepared-fixture', storeDirectory: os.tmpdir() }).execute('status');
  assert.deepEqual(names, ['prepared-fixture']);
  assert.equal(result.receipt.networkUsed, false);
  noSecrets(result);
});

test('protected provider absence has stable PROVIDER_MISSING before any network request', async () => {
  for (const id of ['elevenlabs', 'toss-sharelink', 'brandconnect']) {
    for (const credentialProvider of [async () => null, async () => { throw new Error(SECRET); }]) {
      await rejected(registry(id, { credentialProvider, fetchImpl: () => assert.fail('missing provider must not fetch') })
        .execute(id === 'elevenlabs' ? 'status' : 'health'), 'PROVIDER_MISSING', { networkUsed: false });
    }
  }
});

test('invalid ElevenLabs state does not become a successful provider inventory result', async () => {
  await rejected(registry('elevenlabs', { credentialProvider: async () => ({ state: { rawSecret: SECRET } }) }).execute('status'),
    'ELEVENLABS_STATE_INVALID', { networkUsed: false });
});

test('Toss health performs owner-bound GETs and emits only native summary counts; rotations stay in memory', async () => {
  const calls = [], names = [];
  const source = { read(name) { names.push(name); return JSON.stringify(tossState()); }, write: () => assert.fail('persistent cookie rotation not allowed') };
  const result = await registry('toss-sharelink', { credentialProvider: async () => ({ store: source }),
    fetchImpl: async (target, init) => {
      const url = new URL(target); calls.push(url.pathname);
      assert.equal(init.method, 'GET');
      assert.equal(url.origin, 'https://sharelink.toss.im');
      if (url.pathname === MEMBER_PATH) {
        assert.ok(new Headers(init.headers).get('cookie').includes(SECRET));
        return json({ resultType: 'SUCCESS', success: OWNER }, 200, { 'set-cookie': 'TBIZAUTH=rotated-fixture; Domain=toss.im; Path=/; Secure; HttpOnly' });
      }
      assert.ok(new Headers(init.headers).get('cookie').includes('rotated-fixture'));
      return json({ resultType: 'SUCCESS', success: { sections: [{ items: [{ todayDeal: {} }, { todayDeal: null }] }, { items: [{ todayDeal: {} }] }] } });
    } }).execute('health');
  assert.deepEqual(names, ['toss-sharelink-state']);
  assert.deepEqual(calls, [MEMBER_PATH, CURATION_PATH]);
  assert.equal(result.data.ownerMatched, true);
  assert.equal(result.data.sectionCount, 2);
  assert.equal(result.data.itemCount, 3);
  assert.equal(result.data.todayDealEntryCount, 2);
  assert.equal(result.receipt.networkUsed, true);
  assert.equal(result.receipt.requestCount, 2);
  assert.equal(result.receipt.httpStatus, 200);
  assert.equal(JSON.stringify(result).includes('rotated-fixture'), false);
  assert.equal('publisherId' in result.data, false);
  noSecrets(result);
});

test('Toss owner mismatch stops before curation and preserves native failure status', async () => {
  let calls = 0;
  const client = registry('toss-sharelink', { credentialProvider: async () => ({ bundle: tossState() }),
    fetchImpl: async () => { calls++; return json({ resultType: 'SUCCESS', success: { publisherId: 999 } }); } });
  await rejected(client.execute('health'), 'TOSS_OWNER_MISMATCH', { networkUsed: true, status: 200 });
  assert.equal(calls, 1);
});

test('Toss never invokes link creation or arbitrary captured request paths', async () => {
  const state = tossState();
  state.readRequests['shopping-curation-sections'].url = 'https://sharelink.toss.im/api-public/v3/shopping/sharelink/create-link';
  let calls = 0;
  const client = registry('toss-sharelink', { credentialProvider: async () => state,
    fetchImpl: async target => { calls++; assert.equal(new URL(target).pathname, MEMBER_PATH); return json({ resultType: 'SUCCESS', success: OWNER }); } });
  await rejected(client.execute('health'), 'TOSS_HTTP_FAILED', { networkUsed: true, status: 200 });
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(resolve('toss-sharelink').profile.operations), ['health']);
});

test('expired Toss state is not renewed and sends no network request', async () => {
  const state = tossState(); state.cookies[0].expires = 1;
  await rejected(registry('toss-sharelink', { credentialProvider: async () => state,
    fetchImpl: () => assert.fail('expired state must not trigger login') }).execute('health'), 'TOSS_REAUTH_REQUIRED', { networkUsed: false });
});

test('Brand Connect health safely reuses native owner checks and does not persist state or expose owner IDs', async t => {
  const calls = [], directory = await temporary(t);
  const source = { directory, read(name) { assert.equal(name, 'brandconnect-state'); return JSON.stringify(brandState()); },
    write: () => assert.fail('native saves must be isolated in the overlay') };
  const result = await registry('brandconnect', { credentialProvider: async () => ({ store: source }), storeDirectory: directory,
    fetchImpl: brandFetch(calls) }).execute('health');
  assert.deepEqual(calls.map(url => url.pathname), ['/brand-connect/query/me', '/brand-connect/query/space/check-owner']);
  assert.equal(result.data.ownerVerified, true);
  assert.equal(result.data.identityMatched, true);
  assert.equal('spaceId' in result.data, false);
  assert.equal(result.receipt.priorRead, 'account');
  assert.equal(result.receipt.networkUsed, true);
  assert.equal(result.receipt.httpStatus, 200);
  assert.equal(result.receipt.requestCount, 2);
  noSecrets(result);
});

test('Brand Connect shopping reads use only prepared owner-verified GET runners and allowlisted finite display data', async t => {
  const directory = await temporary(t);
  for (const [operation, input, expectedPath] of [
    ['shopping-search', { query: { query: 'shoes', limit: 2 } }, '/affiliate/query/affiliate-products/search-by-query'],
    ['shopping-stores', { query: { query: 'shop', pageSize: 2 } }, '/affiliate/query/affiliate-stores/search'],
    ['shopping-featured', {}, '/affiliate/query/popup-stores'],
  ]) {
    const calls = [];
    const client = registry('brandconnect', { credentialProvider: async () => ({ state: brandState() }), storeDirectory: directory,
      fetchImpl: brandFetch(calls, { catalogue: { totalCount: 1, items: [{ affiliateProductId: 'p-1', title: `Title ${AUTH}`,
        salePrice: null, arbitrarySecret: SECRET, session: { token: SECRET }, images: ['https://example.test/image', { raw: SECRET }] }],
        accessToken: SECRET, expectedOwner: OWNER } }) });
    const result = await client.execute(operation, input);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].pathname, expectedPath);
    assert.equal(result.data.items[0].title, '[redacted]');
    assert.equal(result.data.items[0].affiliateProductId, 'p-1');
    assert.deepEqual(result.data.items[0].images, ['https://example.test/image']);
    assert.equal(result.data.totalCount, 1);
    assert.equal(result.receipt.networkUsed, true);
    assert.equal(result.receipt.authenticated, true);
    assert.equal(result.receipt.ownerVerified, true);
    assert.equal(result.receipt.requestCount, 3);
    assert.equal(result.receipt.httpStatus, 200);
    noSecrets(result);
  }
});

test('newly rotated response cookies are redacted too, even before they are sent on a later read', async t => {
  const directory = await temporary(t), calls = [], rotated = 'EXTRAS_ROTATED_COOKIE_FIXTURE_82736';
  const nativeFetch = brandFetch(calls);
  const client = registry('brandconnect', { credentialProvider: async () => brandState(), storeDirectory: directory,
    fetchImpl: async (target, init) => {
      const response = await nativeFetch(target, init);
      if (new URL(target).pathname !== '/affiliate/query/popup-stores') return response;
      return json([{ id: 'fixture-store', title: encodeURIComponent(`New ${rotated}`) }], 200,
        { 'set-cookie': `NID_AUT=${rotated}; Domain=naver.com; Path=/; Secure; HttpOnly` });
    } });
  const result = await client.execute('shopping-featured');
  assert.equal(result.data[0].title, '[redacted]');
  assert.equal(JSON.stringify(result).includes(rotated), false);
  noSecrets(result);
});

test('Brand Connect account mismatch stops after its first read, without returning raw identity or logging in', async t => {
  const calls = [], directory = await temporary(t);
  const client = registry('brandconnect', { credentialProvider: async () => brandState(), storeDirectory: directory,
    fetchImpl: brandFetch(calls, { loginId: 'different-account' }) });
  await rejected(client.execute('shopping-search', { query: { query: 'shoes' } }), 'ACCOUNT_MISMATCH', { networkUsed: true, status: 200 });
  assert.equal(calls.length, 1);
});

test('pre-aborted operations open neither credentials nor a network connection', async () => {
  const controller = new AbortController(); controller.abort();
  const definition = resolve('toss-sharelink');
  const binding = definition.createAdapters({ credentialProvider: () => assert.fail('aborted provider'), fetchImpl: () => assert.fail('aborted fetch') });
  await rejected(binding.adapters['toss-sharelink.health']({}, { signal: controller.signal }), 'OPERATION_ABORTED', { networkUsed: false });
});

test('caller cancellation reaches native transport and is sanitized without a fresh request', async () => {
  const controller = new AbortController();
  let observed, calls = 0;
  const definition = resolve('toss-sharelink');
  const binding = definition.createAdapters({ credentialProvider: async () => tossState(), fetchImpl: async (_target, init) => {
    calls++; observed = init.signal;
    controller.abort();
    throw Object.assign(new Error(SECRET), { name: 'AbortError' });
  } });
  await rejected(binding.adapters['toss-sharelink.health']({}, { signal: controller.signal }), 'OPERATION_ABORTED', { networkUsed: true });
  assert.equal(observed.aborted, true);
  assert.equal(calls, 1);
});

test('common verification counts only actual read receipts as live; local status and missing public input are not live proofs', async () => {
  let calls = 0;
  const selected = ['creator-google', 'elevenlabs', 'creator-youtube'].map(resolve);
  const result = await verifyServiceOperations({ definitions: selected, services: selected.map(definition => definition.id),
    credentialProvider: async id => { assert.equal(id, 'elevenlabs'); return elevenState(); },
    fetchImpl: async target => { calls++; assert.equal(new URL(target).origin, 'https://trends.google.com'); return xmlResponse(rss()); } });
  assert.equal(calls, 1);
  assert.equal(result.summary.liveReadChecksPassed, 1);
  assert.equal(result.results[0].checks[0].liveReadVerified, true);
  assert.equal(result.results[1].checks[0].evidenceScope, 'local');
  assert.equal(result.results[1].checks[0].liveReadVerified, false);
  assert.equal(result.results[2].checks.length, 0);
  noSecrets(result);
});
