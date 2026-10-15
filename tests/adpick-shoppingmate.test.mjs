import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAdpickReadClient, AdpickReadError, safeAdpickError } from '../lib/commerce/adpick-shoppingmate.mjs';

// All keys/responses here are synthetic; no provider request or account material is used.
let serial = 0;
const syntheticKey = () => `fixture_adpick_key_${++serial}_synthetic_only`;
const mall = { cp_code: 'FIXTURE', name: 'Fixture mall', icon: 'https://cdn.example.invalid/icon.png',
  title: 'Fixture description', commissionlink: '', commission_per: '3.0' };
const product = { title: 'Synthetic product', photo: 'https://cdn.example.invalid/photo.png', cp_code: 'FIXTURE',
  cp_name: 'Fixture mall', cp_icon: 'https://cdn.example.invalid/icon.png', commissionlink: 'https://link.adpick.co.kr/fixture' };
const envelope = data => ({ success: true, message: 'Synthetic response', data });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
function client(fetchImpl, options = {}) {
  const key = syntheticKey();
  return { key, client: createAdpickReadClient({ apiKeyProvider: () => key, fetchImpl, ...options }) };
}
const hasCode = code => error => error instanceof AdpickReadError && error.code === code;

test('documented malls GET preserves raw commission and empty returned links; exact origin/redirect/credential policies are enforced', async () => {
  const calls = [];
  const { client: api, key } = client(async (url, options) => { calls.push({ url, options }); return json(envelope([mall])); });
  const result = await api.readMalls({ rewardmalls: true, order: 'commission', pData: 'opaque_fixture_01' });
  assert.deepEqual(result.data, [mall]);
  const request = new URL(calls[0].url);
  assert.equal(request.origin, 'https://biz.adpick.co.kr');
  assert.equal(request.pathname, `/api/${key}/malls`);
  assert.deepEqual(Object.fromEntries(request.searchParams), { rewardmalls: 'true', order: 'commission', p_data: 'opaque_fixture_01' });
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(calls[0].options.headers, { accept: 'application/json' });
  assert.equal(result.receipt.path, '/api/{redacted}/malls');
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(result.semantics.authenticatedOwnerVerified, false);
});

test('UTF-8 search preserves formatted price and best preserves numeric KRW/commission as a random sample without ranks', async () => {
  const urls = [];
  const { client: api } = client(async url => {
    urls.push(new URL(url));
    return url.includes('/search?') ? json(envelope([{ ...product, price: '29,900원' }]))
      : json(envelope({ area: 'pick', area_name: 'Synthetic pick', count: 1, list: [{ ...product, price: 29900, commission_per: 3.5 }] }));
  });
  const search = await api.searchProducts({ q: '무선 이어폰 & 태블릿', limit: 20 });
  assert.equal(urls[0].searchParams.get('q'), '무선 이어폰 & 태블릿');
  assert.equal(urls[0].searchParams.size, 2);
  assert.equal(search.data[0].price, '29,900원');
  const best = await api.bestProducts({ area: 'pick', limit: 10 });
  assert.equal(best.data.list[0].price, 29900);
  assert.equal(best.data.list[0].commission_per, 3.5);
  assert.equal(best.semantics.selection, 'random_bounded_sample');
  assert.equal(best.semantics.explicitRanks, false);
  assert.equal(best.semantics.priceBasis, 'reference_only');
  assert.equal(best.semantics.originalProductOptionSellerIdentity, 'not_documented');
  assert.equal('rank' in best.data.list[0], false);
  assert.equal(urls.every(url => ['/search', '/best'].some(name => url.pathname.endsWith(name))), true, 'reads never generate a link again');
});

test('documented JSON envelope is validated independently of PHP text MIME while HTML login pages never succeed', async () => {
  for (const mime of ['text/html; charset=UTF-8', 'text/plain', 'application/problem+json']) {
    const { client: api } = client(async () => new Response(JSON.stringify(envelope([mall])), { headers: { 'content-type': mime } }));
    assert.deepEqual((await api.readMalls()).data, [mall]);
  }
  const { client: missingMime } = client(async () => {
    const response = new Response(JSON.stringify(envelope([mall])));
    response.headers.delete('content-type');
    return response;
  });
  assert.deepEqual((await missingMime.readMalls()).data, [mall]);
  const { client: login } = client(async () => new Response('<html><form>Sign in</form></html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(login.readMalls(), hasCode('ADPICK_SCHEMA_INVALID'));
  const { client: quota } = client(async () => new Response(JSON.stringify({ status: 'error', code: 403, error: 'Synthetic quota' }),
    { status: 403, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(quota.readMalls(), hasCode('ADPICK_API_QUOTA'));
});

test('invalid query/limit/area/private p_data/unknown options fail before credential or network access; no write methods exist', () => {
  let credentials = 0, requests = 0;
  const api = createAdpickReadClient({ apiKeyProvider: () => { credentials++; return syntheticKey(); }, fetchImpl: () => { requests++; throw new Error(); } });
  for (const input of [{}, { q: '' }, { q: 'x', limit: 21 }, { q: 'x', limit: 0 }, { q: 'x', url: 'https://example.invalid/' },
    { q: 'x', pData: 'private@example.invalid' }, { q: 'x', pData: 'x'.repeat(51) }, { q: 'x\nsecret' }]) {
    assert.throws(() => api.searchProducts(input), hasCode('ADPICK_INPUT_INVALID'));
  }
  for (const input of [{ area: 'unknown' }, { area: 'today', limit: 11 }, { area: 'today', pData: 'order/customer' }]) {
    assert.throws(() => api.bestProducts(input), hasCode('ADPICK_INPUT_INVALID'));
  }
  assert.throws(() => api.readMalls({ order: 'all' }), hasCode('ADPICK_INPUT_INVALID'));
  assert.throws(() => api.readMalls({ rewardmalls: 'true' }), hasCode('ADPICK_INPUT_INVALID'));
  assert.deepEqual(Object.keys(api).sort(), ['bestProducts', 'readMalls', 'searchProducts']);
  assert.equal(credentials, 0);
  assert.equal(requests, 0);
});

test('missing/throwing/path-unsafe credentials fail without key-bearing messages or network access', async () => {
  let requests = 0;
  const key = syntheticKey();
  for (const provider of [() => '', () => '..', () => 'x/y', () => ' x ', () => undefined, () => { throw new Error(`secret=${key}`); }]) {
    const api = createAdpickReadClient({ apiKeyProvider: provider, fetchImpl: () => { requests++; throw new Error(); } });
    await assert.rejects(api.readMalls(), error => hasCode('ADPICK_CREDENTIAL_UNAVAILABLE')(error) && !String(error.stack).includes(key));
  }
  assert.equal(requests, 0);
  assert.equal(safeAdpickError({ code: key }), 'ADPICK_TRANSPORT');
  const forged = new AdpickReadError(key, { method: 'GET', origin: 'https://biz.adpick.co.kr', path: '/api/{redacted}/malls',
    queryFields: ['order', key], httpStatus: 401, secret: key });
  assert.equal(String(forged.stack).includes(key), false);
  assert.equal(JSON.stringify(forged).includes(key), false);
  forged.code = key;
  assert.equal(safeAdpickError(forged), 'ADPICK_TRANSPORT');
});

test('redirects are rejected before following or parsing any response, including same-origin and cross-origin redirects', async () => {
  for (const location of ['https://biz.adpick.co.kr/next', 'https://evil.example.invalid/']) {
    let requests = 0;
    const { client: api } = client(async (_, options) => { requests++; assert.equal(options.redirect, 'manual');
      return new Response('', { status: 302, headers: { location } }); });
    await assert.rejects(api.readMalls(), hasCode('ADPICK_REDIRECT_REJECTED'));
    assert.equal(requests, 1);
  }
});

test('API auth/quota errors stay distinct from generic HTML403; no error body, message, URL or key is exposed and no retry occurs', async () => {
  for (const [status, payload, expected] of [
    [401, { status: 'error', code: 401, error: 'echo' }, 'ADPICK_KEY_REJECTED'],
    [403, { status: 'error', code: 403, error: 'echo' }, 'ADPICK_API_QUOTA'],
    [403, { message: 'echo' }, 'ADPICK_ACCESS_UNKNOWN'],
    [400, { status: 'error', code: 400, error: 'echo' }, 'ADPICK_API_INPUT_REJECTED'],
    [501, { status: 'error', code: 501, error: 'echo' }, 'ADPICK_API_UNAVAILABLE'],
  ]) {
    let calls = 0;
    const key = syntheticKey();
    const api = createAdpickReadClient({ apiKeyProvider: () => key, fetchImpl: async () => { calls++; return json({ ...payload, error: `https://biz.adpick.co.kr/api/${key}/malls` }, status); } });
    await assert.rejects(api.readMalls(), error => {
      assert.equal(error.code, expected);
      assert.equal(JSON.stringify(error).includes(key), false);
      assert.equal(String(error.stack).includes(key), false);
      assert.equal('cause' in error, false);
      return true;
    });
    assert.equal(calls, 1);
  }
  const { client: html } = client(async () => new Response('<html>Forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(html.readMalls(), hasCode('ADPICK_ACCESS_UNKNOWN'));
});

test('transport and body-reader exceptions cannot leak key-bearing errors', async () => {
  const key = syntheticKey();
  for (const fetchImpl of [async url => { throw new Error(url); }, async url => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(url)); },
  }), { headers: { 'content-type': 'application/json' } })]) {
    const api = createAdpickReadClient({ apiKeyProvider: () => key, fetchImpl });
    await assert.rejects(api.readMalls(), error => hasCode('ADPICK_TRANSPORT')(error)
      && !JSON.stringify(error).includes(key) && !String(error.stack).includes(key));
  }
});

test('response schema rejects wrong envelopes/types/coverage and secret reflections; unknown fields never enter results', async () => {
  const key = syntheticKey();
  const cases = [
    [envelope([{ ...product, price: 29900 }]), 'search', 'ADPICK_SCHEMA_INVALID'],
    [envelope({ area: 'today', area_name: 'Synthetic', count: 2, list: [{ ...product, price: 1, commission_per: 3 }] }), 'best', 'ADPICK_SCHEMA_INVALID'],
    [envelope({ area: 'popular', area_name: 'Synthetic', count: 0, list: [] }), 'best', 'ADPICK_SCHEMA_INVALID'],
    [{ success: true, data: [] }, 'malls', 'ADPICK_SCHEMA_INVALID'],
    [envelope([{ ...mall, name: key }]), 'malls', 'ADPICK_SECRET_REFLECTION'],
    [envelope([{ ...mall, name: key.replaceAll('_', '%5F') }]), 'malls', 'ADPICK_SECRET_REFLECTION'],
    [envelope([{ ...mall, name: key.replaceAll('_', '%25255F') }]), 'malls', 'ADPICK_SECRET_REFLECTION'],
    [envelope([{ ...mall, name: '%GG' + key.replaceAll('_', '%5F') }]), 'malls', 'ADPICK_SECRET_REFLECTION'],
    [envelope([{ ...mall, commissionlink: 'https://biz.adpick.co.kr/api/other_key/directlink' }]), 'malls', 'ADPICK_SECRET_REFLECTION'],
    [envelope([{ ...mall, commissionlink: 'https://biz.adpick.co.kr/%61pi/other_key/directlink' }]), 'malls', 'ADPICK_SECRET_REFLECTION'],
    [envelope([{ ...mall, commissionlink: 'javascript:alert(1)' }]), 'malls', 'ADPICK_SCHEMA_INVALID'],
  ];
  for (const [index, [payload, operation, expected]] of cases.entries()) {
    const api = createAdpickReadClient({ apiKeyProvider: () => key, now: () => 1_000_000 + index * 60_000,
      fetchImpl: async () => json(payload) });
    const action = operation === 'search' ? api.searchProducts({ q: 'fixture' }) : operation === 'best' ? api.bestProducts({ area: 'today' }) : api.readMalls();
    await assert.rejects(action, hasCode(expected));
  }
  const { client: api } = client(async () => json({ ...envelope([{ ...mall, debug_key: key }]), message: key, debug: key }));
  const result = await api.readMalls();
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.deepEqual(result.data, [mall]);
});

test('process-wide per-key rolling quota also bounds separate clients and resets after60s without retry', async () => {
  const key = syntheticKey();
  let time = 1_000_000, calls = 0;
  const options = { apiKeyProvider: () => key, now: () => time,
    fetchImpl: async url => { calls++; return url.includes('/malls?') ? json(envelope([])) : json(envelope([])); } };
  const first = createAdpickReadClient(options), second = createAdpickReadClient(options);
  for (let index = 0; index < 10; index++) await (index % 2 ? first.readMalls() : second.searchProducts({ q: 'fixture' }));
  await assert.rejects(first.readMalls(), hasCode('ADPICK_LOCAL_QUOTA'));
  assert.equal(calls, 10);
  time += 60_000;
  await second.readMalls();
  assert.equal(calls, 11);
});

test('body limit is enforced during streaming and via Content-Length with cancellation', async () => {
  for (const contentLength of [undefined, '9999']) {
    let cancelled = false;
    const { client: api } = client(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(101)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json', ...(contentLength ? { 'content-length': contentLength } : {}) } }), { maxBodyBytes: 100 });
    await assert.rejects(api.readMalls(), hasCode('ADPICK_BODY_LIMIT'));
    assert.equal(cancelled, true);
  }
});

test('early redirect and unexpected MIME rejection cancel the response stream without reading or retrying', async () => {
  for (const [status, headers, expected] of [
    [302, { location: 'https://evil.example.invalid/' }, 'ADPICK_REDIRECT_REJECTED'],
    [200, { 'content-type': 'application/octet-stream' }, 'ADPICK_SCHEMA_INVALID'],
  ]) {
    let cancelled = false, calls = 0;
    const { client: api } = client(async () => {
      calls++;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers });
    });
    await assert.rejects(api.readMalls(), hasCode(expected));
    assert.equal(cancelled, true);
    assert.equal(calls, 1);
  }
});

test('deadline includes provider and response body; late credentials do not cause a post-timeout HTTP request', async () => {
  let release, requests = 0;
  const api = createAdpickReadClient({ timeoutMs: 20, apiKeyProvider: () => new Promise(resolve => { release = resolve; }),
    fetchImpl: async () => { requests++; return json(envelope([])); } });
  await assert.rejects(api.readMalls(), hasCode('ADPICK_TIMEOUT'));
  release(syntheticKey());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);
  let cancelled = false;
  const { client: body } = client(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }), { timeoutMs: 20 });
  await assert.rejects(body.readMalls(), hasCode('ADPICK_TIMEOUT'));
  assert.equal(cancelled, true);
});

test('CLI status/invalid inputs require no network, and synthetic stdin key is absent from default and data output', () => {
  const script = fileURLToPath(new URL('../scripts/adpick-read.mjs', import.meta.url));
  const run = (args, input = '') => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', input });
  const status = run(['status']);
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).networkUsed, false);
  assert.equal(JSON.parse(status.stdout).liveReplay, false);
  for (const operation of ['link', 'directlink', 'conversion', 'login']) {
    const result = run([operation, '--credential-stdin'], syntheticKey());
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'ADPICK_INPUT_INVALID');
  }
  assert.equal(JSON.parse(run(['malls']).stdout).code, 'ADPICK_CREDENTIAL_UNAVAILABLE');
  const mock = 'globalThis.fetch = async () => new Response(JSON.stringify(' + JSON.stringify(envelope([mall])) + '), {headers:{"content-type":"application/json"}});';
  const module = 'data:text/javascript,' + encodeURIComponent(mock);
  for (const flags of [[], ['--include-data']]) {
    const key = syntheticKey();
    const result = spawnSync(process.execPath, ['--import', module, script, 'malls', '--credential-stdin', ...flags], { encoding: 'utf8', input: key + '\n' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout + result.stderr).includes(key), false);
    const output = JSON.parse(result.stdout);
    assert.equal(output.count, 1);
    assert.equal(output.semantics.authenticatedOwnerVerified, false);
    if (flags.length) assert.deepEqual(output.data, [mall]);
    else assert.equal(output.dataOmitted, true);
  }
});
