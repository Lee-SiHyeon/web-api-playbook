// Deterministic local fixtures only: no real network, protected vault or login.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { definitions } from '../lib/service-operations/native.mjs';
import { createOperationRegistry, validateOperationProfile } from '../lib/operation-registry.mjs';
import { ScopedSession } from '../lib/scoped-session.mjs';
import { ScopedHttpSession } from '../service-packs/tistory/lib/transport.mjs';

const secret = 'fixture-sensitive-value';
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const html = value => new Response(value, { headers: { 'content-type': 'text/html' } });
const byId = id => definitions.find(definition => definition.id === id);
function use(t, id, options = {}) {
  const definition = byId(id);
  const adapter = definition.createAdapters({ fetchImpl: () => assert.fail('Unexpected fixture network request'), ...options });
  t.after(() => adapter.close());
  return createOperationRegistry(definition.profile, adapter);
}
function finite(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') { assert.equal(Number.isFinite(value), true); return; }
  assert.equal(typeof value, 'object');
  assert.equal(value instanceof Date, false);
  assert.ok(Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  Object.values(value).forEach(finite);
}
function clean(value) { finite(value); assert.equal(JSON.stringify(value).includes(secret), false); }
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-operation-fixture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
function inpockState() {
  const api = 'https://link-rest.inpock.co.kr';
  const session = new ScopedSession({ allowedOrigins: [api], cookieOrigins: [api],
    cookies: [{ name: 'token', value: secret, domain: new URL(api).hostname, path: '/', secure: true }],
    defaultHeaders: { accept: 'application/json' }, headersByOrigin: { [api]: { origin: 'https://link.inpock.co.kr', referer: 'https://link.inpock.co.kr/' } },
    timeoutMs: 15000, maxRequestBytes: 32768, maxResponseBytes: 1024 * 1024, maxRedirects: 0 });
  return { version: 1, username: 'fixture_owner', ownerId: 42, session: session.toJSON() };
}
const naverCredentials = () => ({ version: 1, cookies: ['NID_AUT', 'NID_SES'].map(name => ({ name, value: secret, domain: '.naver.com', path: '/', secure: true, expires: -1 })) });
const naverAdmin = () => html('<div id="lnbMenu"><a href="/aicandoanything/config/bloginfo">블로그 관리</a></div>');
function tistoryCredentials() {
  const session = ScopedHttpSession.fromBrowserCookies([{ name: 'TSESSION', value: secret, domain: '.tistory.com', path: '/', expires: -1, secure: true }]);
  return { version: 1, blogOrigin: 'https://i-never-stop-study.tistory.com', session: session.toJSON(), identity: { userId: 41, blogId: 42 } };
}
const tistoryAccount = () => json({ data: { user: { isLogin: true, id: 41, appUserId: 43 } } });
const tistoryBlog = () => json({ address: { primaryDomain: 'i-never-stop-study.tistory.com' }, info: { blogId: 42 } });

test('all native definitions are finite, read-only, and list/describe is fully lazy', t => {
  assert.deepEqual(definitions.map(d => d.id), ['inpock', 'gabia', 'threads', 'x', 'naver-blog', 'tistory', 'reddit']);
  for (const definition of definitions) {
    validateOperationProfile(definition.profile);
    const registry = use(t, definition.id, {
      credentialProvider: () => assert.fail('List must not resolve credentials'),
      importModule: () => assert.fail('List must not acquire a native module'),
    });
    const { createAdapters, ...metadata } = definition; finite(metadata);
    const list = registry.list(); finite(list); finite(registry.tools());
    assert.equal(list.length, Object.keys(definition.profile.operations).length);
    for (const op of list) {
      assert.equal(op.semantics, 'read'); assert.ok(op.evidence.length);
      assert.deepEqual(registry.describe(op.id), op);
    }
    for (const check of definition.verificationChecks) {
      assert.equal(check.kind, 'live_read');
      assert.ok(definition.profile.operations[check.operation]);
      assert.ok(check.input);
    }
    assert.deepEqual(definition.profile.allowedOrigins, []);
  }
  assert.deepEqual(byId('threads').checklistIds, ['creator-threads']);
  assert.equal(byId('threads').verificationChecks.some(x => x.operation === 'views'), false);
  assert.equal(byId('gabia').verificationChecks.some(x => x.operation === 'public-dns'), false);
});

test('missing providers stay explicit and make no network requests', async t => {
  for (const [id, operation, input] of [
    ['inpock', 'health', {}], ['gabia', 'domain-read', {}], ['x', 'profile', { path: { handle: 'sama' } }],
    ['naver-blog', 'health', {}], ['tistory', 'health', {}], ['reddit', 'search', { query: { q: 'fixture' } }],
  ]) {
    let calls = 0;
    const registry = use(t, id, { credentialProvider: async service => { assert.equal(service, id); calls++; return null; } });
    await assert.rejects(registry.execute(operation, input), error => {
      assert.equal(error.code, 'PROVIDER_MISSING'); assert.equal(error.receipt.networkUsed, false); clean(error.receipt); return true;
    });
    assert.equal(calls, 1);
  }
});

test('provider failures and malformed credential objects never leak values', async t => {
  for (const credentialProvider of [async () => { throw Object.assign(new Error(secret), { code: secret, receipt: { value: secret } }); }, async () => secret]) {
    await assert.rejects(use(t, 'inpock', { credentialProvider }).execute('health'), error => {
      assert.match(error.code, /^PROVIDER_(?:UNREADABLE|INVALID)$/); clean({ message: error.message, receipt: error.receipt }); return true;
    });
  }
});

test('nested input schemas reject arbitrary actions, credential fields, bad limits, and missing IDs before execution', async t => {
  const cases = [
    ['inpock', 'blocks', { query: { maxPages: 3 } }], ['inpock', 'blocks', { query: { maxPages: '1' } }],
    ['threads', 'public-profile', { query: { handle: 'threads', limit: 0 } }], ['threads', 'views', { query: { handle: 'threads' } }],
    ['x', 'profile', { handle: 'sama' }], ['x', 'profile', { path: { handle: 'sama' }, query: { token: secret } }],
    ['x', 'timeline', { path: { handle: 'sama' }, query: { maxPages: 50 } }],
    ['naver-blog', 'visits', { query: { metric: 'write' } }], ['tistory', 'statistics', { query: { operation: 'publish' } }],
    ['reddit', 'comments', { path: { postId: '1abc' }, query: { limit: 101 } }],
  ];
  for (const [id, operation, input] of cases) {
    const registry = use(t, id, { credentialProvider: () => assert.fail('Validation must precede provider access') });
    await assert.rejects(registry.execute(operation, input), error => /^OPERATION_INPUT_/.test(error.code));
  }
  await assert.rejects(use(t, 'inpock').execute('login'), { code: 'OPERATION_UNKNOWN' });
});

test('Gabia HTTPS uses the native strict TLS reader, one GET, and no body download', async t => {
  let calls = 0;
  const registry = use(t, 'gabia', { fetchImpl: async (url, init) => {
    calls++; assert.equal(url, 'https://www.gabia.com/'); assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('cookie'), null);
    return html('body is deliberately not read');
  } });
  const result = await registry.execute('public-https', byId('gabia').verificationChecks[0].input);
  assert.equal(calls, 1); assert.equal(result.data.status, 'reachable'); assert.equal(result.data.bodyReadBytes, 0);
  assert.equal(result.data.tlsValidation, 'strict_platform_default'); assert.equal(result.receipt.networkUsed, true); clean(result);
});

test('Gabia HTTPS non-success and off-domain requests are not fabricated successes', async t => {
  let calls = 0;
  const registry = use(t, 'gabia', { fetchImpl: async () => { calls++; return json({}, 503); } });
  await assert.rejects(registry.execute('public-https', { query: { domain: 'gabia.com' } }), error => {
    assert.equal(error.code, 'GABIA_PUBLIC_HTTPS_NOT_REACHABLE'); assert.equal(error.receipt.httpStatus, 503);
    assert.equal(error.receipt.networkUsed, true); return true;
  });
  await assert.rejects(registry.execute('public-https', { query: { domain: 'gabia.com', url: 'https://other.invalid/' } }), { code: 'GABIA_HTTPS_URL_INVALID' });
  assert.equal(calls, 1);
});

test('Gabia DNS reuses the exact native 12-query recursive verifier and explicit record-plan contract', async t => {
  const calls = [];
  const registry = use(t, 'gabia', { fetchImpl: async raw => {
    const url = new URL(raw); calls.push(url);
    const name = url.searchParams.get('name'), type = url.searchParams.get('type');
    const record = name === 'fixture.example' && type === 'A' ? { name, type: 1, TTL: 60, data: '192.0.2.1' }
      : name === 'www.fixture.example' && type === 'CNAME' ? { name, type: 5, TTL: 60, data: 'target.example.' } : null;
    return json({ Status: 0, Answer: record ? [record] : [] });
  } });
  const result = await registry.execute('public-dns', { body: { recordSet: { schema: 'gabia-dns-record-set-v1', domain: 'fixture.example', records: [
    { type: 'A', host: '@', value: '192.0.2.1', ttl: 600 }, { type: 'CNAME', host: 'www', value: 'target.example', ttl: 600 },
  ] } } });
  assert.equal(calls.length, 12); assert.equal(new Set(calls.map(x => x.origin)).size, 2);
  assert.equal(result.data.status, 'verified'); assert.equal(result.data.authoritativeDns.status, 'not_queried'); clean(result);
});

test('Gabia authenticated domain read reuses the existing stdin-bundle schema and sanitized owner/DNS output', async t => {
  const calls = [], domain = 'fixture.example';
  const registry = use(t, 'gabia', { credentialProvider: async () => ({ schema: 'gabia-read-input-v1', domain,
    expectedUserId: secret, cookies: [{ name: 'gabia-session', value: secret, domain: '.gabia.com', hostOnly: false, path: '/', secure: true }] }),
    fetchImpl: async (raw, init) => {
      const url = new URL(raw); calls.push(url.pathname); assert.equal(init.method, 'GET');
      if (url.pathname === '/v1/users/me') return json({ data: { user_id: secret, user_name: secret, user_type: 'member', registration_site: 'web', registration_date: '2026-01-01' } });
      if (url.pathname === '/dns/ajax/domain') return json({ list: [{ num: 1, domain, type: 'internal', status: 'active', tbl: secret, owner_approval: null,
        domain_seqno: secret, domain_addition: '', expire_date: '2027-01-01', disabled: 'N', ssl_target: '' }], last_flag: true, domain_cnt: '1', request_view_cnt: '10', request_view_page: '1' });
      return json({ update_date: '2026-01-01', record: [{ ttl: 600, services_idx: 1, seqno: secret, domain, host: '@', type: 'A', data: '192.0.2.1',
        service: '', protocol: '', priority: '', weight: '', port: '', target: '', is_layer: 'N', services_name: '', addition_service_name: '', action: '' }],
      nameserver: secret, addition: {}, hasDomainConn: [], hasService: [], option: {}, forwardingInfo: [] });
    },
  });
  const result = await registry.execute('domain-read'); clean(result);
  assert.deepEqual(calls, ['/v1/users/me', '/dns/ajax/domain', '/dns/ajax/dns']);
  assert.equal(result.data.owner.ownerVerified, true); assert.equal(result.data.domainList.targetDomainPresent, true);
  assert.deepEqual(result.data.dns.records, [{ type: 'A', host: '@', value: '192.0.2.1', ttl: 600 }]);
  assert.equal(result.data.write.dispatched, false); assert.equal(result.receipt.networkUsed, true);
});

test('Inpock saved-state health and stats reuse actual clients, sanitize receipts, and never POST', async t => {
  const calls = [], storeDirectory = await temporary(t);
  const registry = use(t, 'inpock', { storeDirectory, credentialProvider: async () => inpockState(), fetchImpl: async (raw, init) => {
    const url = new URL(raw); calls.push(url.pathname); assert.equal(init.method, 'GET');
    assert.match(new Headers(init.headers).get('cookie'), /token=/);
    return url.pathname === '/v2/users' ? json({ id: 42, username: 'fixture_owner', plan: 'FREE', email: secret, token: secret })
      : json({ results: { today: 1, accumulated: 10, realtime: 0, subscribers: 2 }, updated_at: '2026-10-20T00:00:00Z' });
  } });
  const health = await registry.execute('health'); clean(health); assert.equal(health.data.ownerVerified, true);
  const stats = await registry.execute('stats'); clean(stats); assert.deepEqual(stats.data.stats, { today: 1, accumulated: 10, realtime: 0, subscribers: 2 });
  assert.deepEqual(calls, ['/v2/users', '/v2/users', '/stats/mini']); assert.equal(stats.receipt.networkUsed, true);
});

test('Inpock rejected saved session cannot read password credentials or implicitly log in', async t => {
  const calls = [], storeDirectory = await temporary(t);
  const registry = use(t, 'inpock', { storeDirectory, credentialProvider: async () => inpockState(), fetchImpl: async (raw, init) => {
    calls.push(new URL(raw).pathname); assert.equal(init.method, 'GET'); return json({}, 401);
  } });
  await assert.rejects(registry.execute('stats'), error => {
    assert.equal(error.code, 'REAUTH_REQUIRED'); assert.equal(error.receipt.networkUsed, true); return true;
  });
  assert.deepEqual(calls, ['/v2/users']);
});

test('Inpock bounded blocks retain native sanitized business summaries, not raw block/profile objects', async t => {
  const calls = [], storeDirectory = await temporary(t);
  const registry = use(t, 'inpock', { storeDirectory, credentialProvider: async () => inpockState(), fetchImpl: async raw => {
    const url = new URL(raw); calls.push(url.pathname);
    return url.pathname === '/v2/users' ? json({ id: 42, username: 'fixture_owner' })
      : json({ blocks: [{ id: 1, private: secret }], has_next: true, next_cursor: 23 });
  } });
  const result = await registry.execute('blocks'); assert.equal(result.data.recordCount, 1);
  assert.equal(result.data.blocks, undefined); assert.equal(result.pageInfo.complete, false); assert.equal(result.pageInfo.pages, 1);
  assert.equal(result.pageInfo.stopReason, 'page_budget'); assert.deepEqual(calls, ['/v2/users', '/v2/blocks']); clean(result);
});

test('root ProtectedStore name/directory overrides are reused, without reading any login entry', async t => {
  const calls = [], storeDirectory = await temporary(t), saved = inpockState();
  const registry = use(t, 'inpock', { sessionName: 'prepared-native-session', storeDirectory,
    importModule: async url => url.endsWith('/protected-store.mjs') ? { ProtectedStore: class {
      constructor(options) { assert.equal(options.directory, storeDirectory); this.directory = storeDirectory; }
      read(name) { calls.push(['read', name]); return JSON.stringify(saved); }
      write(name) { calls.push(['write', name]); return { stored: true }; }
    } } : import(url),
    fetchImpl: async () => json({ id: 42, username: 'fixture_owner' }),
  });
  await registry.execute('health');
  assert.ok(calls.length >= 2); assert.ok(calls.every(([, name]) => name === 'prepared-native-session'));
});

test('Threads public HTML uses the real native parser and keeps unknown views null', async t => {
  let calls = 0;
  const post = { caption: { text: 'Fixture public post' }, user: { username: 'threads' }, code: 'ABCdef123', taken_at: 1750000000, like_count: 2, text_post_app_info: { direct_reply_count: 1 } };
  const registry = use(t, 'threads', { fetchImpl: async (url, init) => {
    calls++; assert.equal(url, 'https://www.threads.com/@threads'); assert.equal(init.redirect, 'manual');
    return html(`<script type="application/json">${JSON.stringify({ post, token: secret })}</script>`);
  } });
  const result = await registry.execute('public-html', { query: { handle: 'threads', limit: 1 } });
  assert.equal(calls, 1); assert.equal(result.data.items[0].summary, 'Fixture public post');
  assert.equal(result.data.items[0].engagement.views, null); assert.equal(result.pageInfo.fullTimeline, false);
  assert.equal(result.receipt.bodyMethod, 'public_html_embedded_json'); clean(result);
});

test('Threads GraphQL adapter forwards the existing client contract and permits only its named read POST', async t => {
  const calls = [];
  const registry = use(t, 'threads', {
    // Stub only the cache-owning client: deterministic fixtures must not write
    // anonymous fixture CSRF values into the real Windows Threads vault.
    importModule: async url => {
      assert.ok(url.endsWith('/threads-xhr.mjs'));
      return { fetchThreadsXhr: async (handle, limit, { fetchImpl }) => {
        assert.equal(handle, 'threads'); assert.equal(limit, 1);
        await fetchImpl('https://www.threads.com/api/graphql', { method: 'POST', body: new URLSearchParams({ fb_api_req_friendly_name: 'BarcelonaProfileThreadsTabDirectQuery' }) });
        return { items: [{ title: 'Fixture GraphQL item', engagement: { views: null } }], receipt: { bodyMethod: 'graphql_json', live_replay: true, headers: { cookie: secret }, csrfToken: secret } };
      } };
    }, fetchImpl: async (url, init) => { calls.push([url, init.method]); return json({}); },
  });
  const result = await registry.execute('public-profile', { query: { handle: 'threads', limit: 1 } });
  assert.equal(result.receipt.bodyMethod, 'graphql_json'); assert.equal(result.receipt.networkUsed, true);
  assert.deepEqual(calls, [['https://www.threads.com/api/graphql', 'POST']]); clean(result);
});

test('Threads adapter never promotes an arbitrary POST or provider-only stub to live network success', async t => {
  const registry = use(t, 'threads', { importModule: async () => ({ fetchThreadsXhr: async (handle, limit, { fetchImpl }) => {
    await fetchImpl('https://www.threads.com/api/v1/media/configure_text_only_post/', { method: 'POST', body: new URLSearchParams({}) });
  } }) });
  await assert.rejects(registry.execute('public-profile', { query: { handle: 'threads' } }), error => {
    assert.equal(error.code, 'NATIVE_READ_ONLY'); assert.equal(error.receipt.networkUsed, false); return true;
  });
  const localStub = use(t, 'threads', { importModule: async () => ({ fetchThreadsXhr: async () => ({ items: [], receipt: { live_replay: false } }) }) });
  assert.equal((await localStub.execute('public-profile', { query: { handle: 'threads' } })).receipt.networkUsed, false);
});

test('Threads public verification cannot make a third network read during cached-session recovery', async t => {
  let calls = 0;
  const registry = use(t, 'threads', { fetchImpl: async () => { calls++; return html('fixture'); },
    importModule: async () => ({ fetchThreadsXhr: async (handle, limit, { fetchImpl }) => {
      for (let i = 0; i < 3; i++) await fetchImpl('https://www.threads.com/@threads');
      return { items: [] };
    } }),
  });
  await assert.rejects(registry.execute('public-profile', { query: { handle: 'threads' } }), error => {
    assert.equal(error.code, 'NATIVE_READ_BUDGET_EXCEEDED'); assert.equal(error.receipt.networkUsed, true); return true;
  });
  assert.equal(calls, 2);
});

test('Threads view availability null and native failure codes remain distinct', async t => {
  const input = { query: { handle: 'threads', code: 'ABCdef123', postId: '1234567890123' } };
  const registry = use(t, 'threads', { importModule: async () => ({ probeThreadsViews: async () => ({ views: null, availability: 'not_provided_by_server', receipt: {} }) }) });
  const result = await registry.execute('views', input); assert.equal(result.data.views, null); assert.equal(result.data.availability, 'not_provided_by_server'); clean(result);
  const broken = use(t, 'threads', { importModule: async () => ({ probeThreadsViews: async () => ({ error: 'THREADS_XHR_HTTP_403', views: null, receipt: { httpStatus: 403 } }) }) });
  await assert.rejects(broken.execute('views', input), { code: 'THREADS_XHR_HTTP_403' });
});

function xFixture(routes) {
  const calls = [];
  const contracts = ['UserByScreenName', 'UserOriginalsTimeline', 'TweetDetail'].map(name => `queryId:"fixture_${name}",operationName:"${name}",operationType:"query",metadata:{featureSwitches:[],fieldToggles:[]}`).join(';');
  return { calls, fetchImpl: async (raw, init) => {
    const url = new URL(raw); calls.push(url.pathname);
    assert.equal(init.method ?? 'GET', 'GET');
    if (url.pathname === '/manifest.js') return html('window.__INITIAL_STATE__=' + JSON.stringify({ featureSwitch: { defaultConfig: {} } }) + ';window.next=1; https://abs.twimg.com/responsive-web/client-web/main.fixture.js');
    if (url.hostname === 'abs.twimg.com') return new Response(contracts + ';AAAA' + 'A'.repeat(60));
    return routes(url, init);
  } };
}
const xProfile = () => json({ data: { user: { result: { __typename: 'User', rest_id: '12345678901', core: { screen_name: 'sama', name: 'Fixture' }, privacy: { protected: false } } } } });
const xTweet = id => ({ __typename: 'Tweet', rest_id: id, core: { user_results: { result: { core: { screen_name: 'sama' } } } }, legacy: { full_text: `Fixture ${id}`, created_at: 'Tue Oct 20 00:00:00 +0000 2026', favorite_count: 1 } });
const xInstructions = [ { entries: [ { content: { itemContent: { tweet_results: { result: xTweet('1234567890123') } } } }, { content: { cursorType: 'Bottom', value: 'fixture-next' } } ] } ];

test('X supplied session uses actual source-discovered client and request-specific transaction provider', async t => {
  const tx = [], h = xFixture((url, init) => {
    assert.equal(new Headers(init.headers).get('x-client-transaction-id'), secret); return xProfile();
  });
  const registry = use(t, 'x', { fetchImpl: h.fetchImpl, credentialProvider: async () => ({ authToken: secret, csrfToken: secret,
    transactionProvider: async request => { tx.push(request); return secret; } }) });
  const result = await registry.execute('profile', { path: { handle: 'sama' } });
  assert.equal(h.calls.length, 3); assert.equal(tx.length, 1); assert.equal(tx[0].method, 'GET');
  assert.equal(result.data.handle, 'sama'); assert.equal(result.receipt.networkUsed, true); assert.equal(result.receipt.httpStatus, 200); clean(result);
});

test('X timelines retain partial-page meaning, all items, and an explicit nextCursor', async t => {
  const h = xFixture(url => url.pathname.endsWith('/UserByScreenName') ? xProfile()
    : json({ data: { user: { result: { timeline: { timeline: { instructions: xInstructions } } } } } }));
  const registry = use(t, 'x', { fetchImpl: h.fetchImpl, credentialProvider: async () => ({ authToken: secret, csrfToken: secret }) });
  const result = await registry.execute('timeline', { path: { handle: 'sama' } });
  assert.equal(h.calls.length, 4); assert.equal(result.data.items.length, 1); assert.equal(result.data.remainder.length, 0);
  assert.equal(result.pageInfo.nextCursor, 'fixture-next'); assert.equal(result.pageInfo.fullTimeline, false); clean(result);
});

test('X conversation reuses the existing social decoder without returning raw GraphQL instructions', async t => {
  const h = xFixture(() => json({ data: { threaded_conversation_with_injections_v2: { instructions: xInstructions } } }));
  const registry = use(t, 'x', { fetchImpl: h.fetchImpl, credentialProvider: async () => ({ authToken: secret, csrfToken: secret }) });
  const result = await registry.execute('conversation', { path: { postId: '1234567890123' } });
  assert.equal(result.data.focal.id, '1234567890123'); assert.equal(result.data.ranking, 'Relevance');
  assert.equal(result.data.instructions, undefined); assert.equal(result.pageInfo.representative, false); clean(result);
});

test('Naver native health and visit statistics verify the pinned owner and do not import login code', async t => {
  const calls = [];
  const registry = use(t, 'naver-blog', { credentialProvider: async () => naverCredentials(), fetchImpl: async (raw, init) => {
    const url = new URL(raw); calls.push(url.pathname); assert.equal(init.method, 'GET');
    assert.match(new Headers(init.headers).get('cookie'), /NID_AUT=/);
    return url.hostname === 'admin.blog.naver.com' ? naverAdmin()
      : json({ statusCode: 200, result: { statDataList: [{ value: 3, token: secret }] } });
  } });
  const health = await registry.execute('health'); assert.equal(health.data.ownerVerified, true); clean(health);
  const visits = await registry.execute('visits', { query: { metric: 'cv', _: '1', exclude: 'false', startDate: '2026-10-20', timeDimension: 'date' } });
  assert.equal(visits.data.data.result.statDataList[0].value, 3); clean(visits);
  assert.deepEqual(calls, ['/aicandoanything', '/aicandoanything', '/api/blog/visit/cv']);
});

test('Naver preserves its canonical SecureString vault reader even with the explicit canonical directory', async t => {
  const canonical = path.join(os.homedir(), '.config', 'affiliate-content-operations', 'credentials');
  const registry = use(t, 'naver-blog', { storeDirectory: canonical, sessionName: 'naver-blog-session',
    importModule: async url => {
      if (url.endsWith('/secure-credential-store.mjs')) return { readCredential: name => { assert.equal(name, 'naver-blog-session'); return JSON.stringify(naverCredentials()); } };
      assert.equal(url.endsWith('/protected-store.mjs'), false); return import(url);
    }, fetchImpl: async () => naverAdmin(),
  });
  assert.equal((await registry.execute('health')).data.authenticated, true);
});

test('Naver missing/expired required auth cookies fail without starting login or sending any request', async t => {
  const credentials = naverCredentials();
  credentials.cookies[0].expires = 1;
  const registry = use(t, 'naver-blog', { credentialProvider: async () => credentials });
  await assert.rejects(registry.execute('health'), error => {
    assert.equal(error.code, 'NAVER_BLOG_AUTH_MISSING'); assert.equal(error.receipt.networkUsed, false); return true;
  });
});

test('Tistory actual protected verifier uses two reads, with no renewal, and statistics/categories use only named GETs', async t => {
  const calls = [];
  const registry = use(t, 'tistory', { credentialProvider: async () => tistoryCredentials(), fetchImpl: async (raw, init) => {
    const url = new URL(raw); calls.push(url.pathname); assert.equal(init.method, 'GET');
    if (url.pathname === '/api/v1/init') return tistoryAccount();
    if (url.pathname === '/manage/setting/blog.json') return tistoryBlog();
    return json({ fixtureValue: 4, csrf_token: secret, session: { cookie: secret } });
  } });
  const health = await registry.execute('health'); assert.equal(health.data.ownerVerified, true); clean(health);
  assert.deepEqual(calls, ['/api/v1/init', '/manage/setting/blog.json']);
  const statistics = await registry.execute('statistics', { query: { operation: 'count' } }); clean(statistics); assert.equal(statistics.data.statistics.fixtureValue, 4);
  const categories = await registry.execute('categories'); clean(categories); assert.equal(categories.data.categories.fixtureValue, 4);
  assert.equal(calls.length, 8); assert.ok(calls.every(route => !/kakao|login|renew/.test(route)));
});

test('Tistory owner rejection fails before business reads or Kakao renewal', async t => {
  const calls = [];
  const registry = use(t, 'tistory', { credentialProvider: async () => tistoryCredentials(), fetchImpl: async (raw, init) => {
    calls.push(new URL(raw).pathname); assert.equal(init.method, 'GET'); return json({}, 401);
  } });
  await assert.rejects(registry.execute('statistics', { query: { operation: 'count' } }), error => {
    assert.equal(error.code, 'TISTORY_REAUTH_REQUIRED'); assert.equal(error.receipt.networkUsed, true); return true;
  });
  assert.deepEqual(calls, ['/api/v1/init']);
});

test('Tistory uses its canonical shared provider name, not pack-local inventory or the Kakao password entry', async t => {
  const names = [];
  const registry = use(t, 'tistory', { storeDirectory: path.join(os.homedir(), '.config', 'affiliate-content-operations', 'credentials'),
    importModule: async url => url.endsWith('/secure-credential-store.mjs')
      ? { readCredential: name => { names.push(name); return JSON.stringify(tistoryCredentials()); } } : import(url),
    fetchImpl: async raw => new URL(raw).pathname === '/api/v1/init' ? tistoryAccount() : tistoryBlog(),
  });
  clean(await registry.execute('health'));
  assert.deepEqual(names, ['tistory-auth-state-v1']);
});

test('Reddit OAuth search and comments reuse native projections, cursors, and unresolved more counts', async t => {
  const calls = [];
  const listing = children => ({ kind: 'Listing', data: { children, after: 't3_next' } });
  const post = { kind: 't3', data: { id: 'abc', title: 'Fixture post', permalink: '/r/fixture/comments/abc', author: 'fixture' } };
  const registry = use(t, 'reddit', { credentialProvider: async () => ({ accessToken: secret, userAgent: 'fixture-reader/1.0 local-test' }), fetchImpl: async (raw, init) => {
    const url = new URL(raw); calls.push(url); assert.equal(url.origin, 'https://oauth.reddit.com');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + secret);
    return json(url.pathname === '/search' ? listing([post]) : [listing([post]), listing([{ kind: 'more', data: { parent_id: 't3_abc', count: 7 } }])]);
  } });
  const search = await registry.execute('search', { query: { q: 'fixture', limit: 1 } }); clean(search);
  assert.equal(search.data.posts[0].title, 'Fixture post'); assert.equal(search.pageInfo.after, 't3_next');
  const comments = await registry.execute('comments', { path: { postId: 'abc' }, query: { limit: 1 } }); clean(comments);
  assert.equal(comments.data.unexpanded[0].count, 7); assert.equal(comments.pageInfo.complete, false);
  assert.equal(calls.length, 2); assert.equal(calls[0].searchParams.get('limit'), '1');
});

test('Reddit denial preserves native error status and is not an empty successful search', async t => {
  const registry = use(t, 'reddit', { credentialProvider: async () => ({ accessToken: secret, userAgent: 'fixture-reader/1.0 local-test' }), fetchImpl: async () => json({}, 429) });
  await assert.rejects(registry.execute('search', { query: { q: 'fixture' } }), error => {
    assert.equal(error.code, 'REDDIT_RATE_LIMITED'); assert.equal(error.receipt.status, 429); assert.equal(error.status, 429);
    assert.equal(error.receipt.networkUsed, true); clean(error.receipt); return true;
  });
});

test('abort, close, and non-finite native metadata cannot yield successful adapter output', async t => {
  const adapter = byId('gabia').createAdapters({ fetchImpl: async (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })) });
  t.after(() => adapter.close());
  const registry = createOperationRegistry(byId('gabia').profile, adapter);
  const pending = registry.execute('public-https', { query: { domain: 'gabia.com' } });
  await new Promise(resolve => setTimeout(resolve, 10)); adapter.close();
  await assert.rejects(pending, { code: 'OPERATION_ABORTED' });
  await assert.rejects(registry.execute('public-https', { query: { domain: 'gabia.com' } }), { code: 'NATIVE_ADAPTER_CLOSED' });
  for (const value of [NaN, Infinity, new Date(), new Map()]) {
    const bad = use(t, 'threads', { importModule: async () => ({ fetchThreadsXhr: async () => ({ items: [], receipt: { fixtureBad: value } }) }) });
    await assert.rejects(bad.execute('public-profile', { query: { handle: 'threads' } }), { code: 'NATIVE_OUTPUT_INVALID' });
  }
});
