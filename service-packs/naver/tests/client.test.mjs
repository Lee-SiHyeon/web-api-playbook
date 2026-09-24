import test from 'node:test';
import assert from 'node:assert/strict';
import { operations, resolveRequest, read } from '../scripts/client.mjs';

// Synthetic inputs are for offline contract tests only, never live-replay evidence.
const query = { timeDimension: 'fixture', startDate: 'fixture', exclude: '', _: 'fixture' };
const input = { operation: 'daily/cv', query };
const success = () => Response.json({ statusCode: 200, result: { statDataList: [] } });
const reject = (promise, code) => assert.rejects(promise, e => e.code === code);

test('all observed read paths resolve; additional hour selector stays distinct', () => {
  assert.ok(Object.keys(operations).length >= 22);
  for (const operation of Object.keys(operations)) {
    const q = Object.fromEntries(operations[operation].queryFields.map(k => [k, 'fixture']));
    assert.equal(resolveRequest({ operation, query: q }).operation, operation);
  }
  assert.throws(() => resolveRequest({ operation: 'user/hour/cv', query }), e => e.code === 'INPUT');
});

test('request validation rejects unobserved paths, duplicate selectors, actor injection and URL credentials', () => {
  for (const url of [
    'https://blog.stat.naver.com/api/blog/unknown',
    'https://example.com/api/blog/daily/cv',
    'https://secret@example.com/api/blog/daily/cv',
    'https://blog.stat.naver.com/api/blog/daily/cv?timeDimension=x&startDate=x&exclude=&_=x&_=y',
    'https://blog.stat.naver.com/api/blog/daily/cv?timeDimension=x&startDate=x&exclude=&_=x&blogId=another',
  ]) assert.throws(() => resolveRequest({ url }));
});

test('missing session fails before fetching; only designated cookie reaches the transport', async () => {
  let calls = 0;
  await reject(read(input, { cookie: '', fetchImpl: async () => { calls++; return success(); } }), 'AUTH_MISSING');
  assert.equal(calls, 0);
  const result = await read(input, { cookie: 'fixture-session', fetchImpl: async (url, init) => {
    assert.equal(new URL(url).hostname, 'blog.stat.naver.com');
    assert.equal(init.headers.cookie, 'fixture-session');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.method, 'GET');
    assert.deepEqual(Object.keys(init.headers).sort(), ['accept', 'cookie', 'referer']);
    return success();
  } });
  assert.equal(result.evidence.applicationStatus, 200);
  assert.ok(!JSON.stringify(result.evidence).includes('fixture-session'));
});

test('HTTP 200 cannot hide application failure, login HTML, or wrong schema', async () => {
  for (const [response, code] of [
    [Response.json({ statusCode: 403, message: 'private response', result: { statDataList: [] } }), 'APPLICATION'],
    [Response.json({ statusCode: '200', result: { statDataList: [] } }), 'APPLICATION'],
    [new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }), 'MIME'],
    [Response.json({ statusCode: 200, result: { statDataList: {} } }), 'SCHEMA'],
  ]) await reject(read(input, { cookie: 'fixture', fetchImpl: async () => response }), code);
});

test('403 and redirects are never retried or followed', async () => {
  for (const [status, code] of [[403, 'FORBIDDEN'], [302, 'REDIRECT']]) {
    let calls = 0;
    await reject(read(input, { cookie: 'fixture', fetchImpl: async () => { calls++; return new Response('', { status, headers: { location: 'https://example.com/private' } }); } }), code);
    assert.equal(calls, 1);
  }
});

test('bounded throttling retry respects Retry-After and preserves long delays as deferred', async () => {
  let calls = 0;
  const delays = [];
  const result = await read(input, { cookie: 'fixture', sleep: async ms => delays.push(ms), fetchImpl: async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : success() });
  assert.equal(result.evidence.attempts, 2);
  assert.deepEqual(delays, [2000]);
  calls = 0;
  await reject(read(input, { cookie: 'fixture', fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); } }), 'THROTTLED');
  assert.equal(calls, 1);
});

test('body size and transport errors do not leak response content or session details', async () => {
  await reject(read(input, { cookie: 'fixture', maxBytes: 5, fetchImpl: async () => success() }), 'SIZE');
  await assert.rejects(read(input, { cookie: 'fixture', fetchImpl: async () => { throw Error('secret-cookie-value'); } }), e => e.code === 'TRANSPORT' && !e.message.includes('secret-cookie-value'));
});
