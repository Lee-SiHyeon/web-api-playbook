import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oliveyoungTestPython } from './helpers/oliveyoung-python.mjs';
import {
  createOliveyoungHttpFetch,
  OliveyoungHttpTransportError,
} from '../lib/commerce/oliveyoung-http-transport.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(root, 'scripts/oliveyoung-http-transport.py');
const pythonPath = oliveyoungTestPython;
const rankUrl = 'https://www.oliveyoung.co.kr/store/main/getBestList.do';
const request = overrides => ({
  protocolVersion: 1,
  url: rankUrl,
  method: 'GET',
  headers: {},
  bodyBase64: '',
  timeoutMs: 2000,
  maxResponseBytes: 1024 * 1024,
  ...overrides,
});

function helperReply(value) {
  const result = spawnSync(pythonPath, [helper], {
    cwd: root,
    input: JSON.stringify(value),
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 16 * 1024,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  return JSON.parse(result.stdout);
}

test('Olive Young transport rejects target origins outside the fixed public origins before spawning', async () => {
  const fetchImpl = createOliveyoungHttpFetch({ pythonPath: '/missing/python' });
  await assert.rejects(fetchImpl('https://example.com/', {}), error =>
    error instanceof OliveyoungHttpTransportError && error.code === 'OLIVEYOUNG_HTTP_TRANSPORT_TARGET_REJECTED');
});

test('Olive Young transport rejects unobserved routes, including source-pending product detail', async () => {
  const fetchImpl = createOliveyoungHttpFetch({ pythonPath: '/missing/python' });
  await assert.rejects(fetchImpl('https://www.oliveyoung.co.kr/goods/api/v1/detail?goodsNo=A000000263510'), error =>
    error instanceof OliveyoungHttpTransportError && error.code === 'OLIVEYOUNG_HTTP_TRANSPORT_PATH_REJECTED');
  await assert.rejects(fetchImpl('https://www.oliveyoung.co.kr/store/main/unknown.do'), error =>
    error instanceof OliveyoungHttpTransportError && error.code === 'OLIVEYOUNG_HTTP_TRANSPORT_PATH_REJECTED');
});

test('Olive Young transport rejects credentials, cookies and profile override headers', async () => {
  const fetchImpl = createOliveyoungHttpFetch({ pythonPath: '/missing/python' });
  for (const header of [
    { cookie: 'cf_clearance=private' },
    { authorization: 'Bearer private' },
    { 'user-agent': 'caller override' },
  ]) {
    await assert.rejects(fetchImpl(rankUrl, { method: 'GET', headers: header }), error =>
      error instanceof OliveyoungHttpTransportError && error.code === 'OLIVEYOUNG_HTTP_TRANSPORT_HEADER_REJECTED');
  }
  await assert.rejects(fetchImpl(rankUrl, { method: 'GET', credentials: 'include' }), error =>
    error instanceof OliveyoungHttpTransportError && error.code === 'OLIVEYOUNG_HTTP_TRANSPORT_REQUEST_INVALID');
});

test('Olive Young transport cancels request bodies that exceed the bounded stdin size', async () => {
  const fetchImpl = createOliveyoungHttpFetch({ pythonPath: '/missing/python' });
  await assert.rejects(fetchImpl('https://www.oliveyoung.co.kr/store/search/NewMainSearchApi.do', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'x'.repeat(256 * 1024 + 1),
  }), error => error instanceof OliveyoungHttpTransportError &&
    error.code === 'OLIVEYOUNG_HTTP_TRANSPORT_BODY_TOO_LARGE');
});

test('Python helper independently rejects unknown origins and routes without a network request', () => {
  assert.deepEqual(helperReply(request({ url: 'https://example.com/' })), { ok: false, error: 'REQUEST_REJECTED' });
  assert.deepEqual(helperReply(request({ url: 'https://www.oliveyoung.co.kr/goods/api/v1/detail?goodsNo=A000000263510' })),
    { ok: false, error: 'REQUEST_REJECTED' });
});

test('Python helper independently rejects credential headers and unknown query fields', () => {
  assert.deepEqual(helperReply(request({ headers: { cookie: '__cf_bm=private' } })),
    { ok: false, error: 'REQUEST_REJECTED' });
  assert.deepEqual(helperReply(request({ url: rankUrl + '?token=private' })),
    { ok: false, error: 'REQUEST_REJECTED' });
});

test('Python helper rejects a disallowed POST body field before attempting HTTP', () => {
  const body = Buffer.from(JSON.stringify({ email: 'private@example.invalid' })).toString('base64');
  assert.deepEqual(helperReply(request({
    url: 'https://m.oliveyoung.co.kr/review/api/v2/reviews/cursor',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    bodyBase64: body,
  })), { ok: false, error: 'REQUEST_REJECTED' });
});

test('transport options keep the network and response bounds', () => {
  assert.throws(() => createOliveyoungHttpFetch({ timeoutMs: 121_000 }), error =>
    error instanceof OliveyoungHttpTransportError && error.code === 'OLIVEYOUNG_HTTP_TRANSPORT_OPTIONS_INVALID');
  assert.throws(() => createOliveyoungHttpFetch({ maxResponseBytes: 9 * 1024 * 1024 }), error =>
    error instanceof OliveyoungHttpTransportError && error.code === 'OLIVEYOUNG_HTTP_TRANSPORT_OPTIONS_INVALID');
});
