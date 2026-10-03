import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScopedSession } from '../lib/scoped-session.mjs';
import { createCoupangAuth } from '../lib/web-auth/coupang.mjs';

const origins = ['https://partners.coupang.com', 'https://login.coupang.com'];
const input = {
  email: 'owner@example.test', affiliateCode: 'fixture-affiliate', userAgent: 'fixture-observed-agent',
  cookies: [{ name: 'AFATK', value: 'fixture-auth', domain: '.coupang.com', path: '/', secure: false }],
};

function harness(t, response) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'coupang-auth-denied-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = JSON.stringify({ version: 1, email: input.email, affiliateCode: input.affiliateCode,
    session: new ScopedSession({ allowedOrigins: origins, cookieOrigins: origins, cookies: input.cookies,
      defaultHeaders: { 'user-agent': input.userAgent } }).toJSON() });
  const writes = [], requests = [];
  const store = { directory, read: () => initial, write: (name, value) => writes.push({ name, value }) };
  const fetchImpl = async (url) => { requests.push(String(url)); return response(); };
  return { auth: createCoupangAuth({ store, fetchImpl }), requests, writes };
}

const denied = () => new Response('<html><title>Access Denied</title></html>',
  { status: 403, headers: { 'content-type': 'text/html',
    'set-cookie': 'AFATK=denied-response-fixture; Domain=.coupang.com; Path=/' } });

test('fresh import does not overwrite protected state after HTTP access denial', async t => {
  const h = harness(t, denied);
  await assert.rejects(h.auth.importSession(input), { code: 'COUPANG_HTTP_ACCESS_DENIED' });
  assert.deepEqual(h.requests, ['https://partners.coupang.com/api/v1/config']);
  assert.equal(h.writes.length, 0);
});

test('ensure does not retry login or prelogin after an HTML access denial', async t => {
  const h = harness(t, denied);
  await assert.rejects(h.auth.ensure(), { code: 'COUPANG_HTTP_ACCESS_DENIED' });
  assert.deepEqual(h.requests, ['https://partners.coupang.com/api/v1/config']);
  assert.equal(h.writes.length, 0);
});

test('application JSON forbidden remains distinct from HTTP access denial', async t => {
  const h = harness(t, () => new Response('{"rCode":"denied"}',
    { status: 403, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(h.auth.importSession(input), { code: 'AUTH_FORBIDDEN' });
  assert.equal(h.writes.length, 0);
});

test('owner verified import still persists the observed ordinary session', async t => {
  const h = harness(t, () => new Response(JSON.stringify({ rCode: '0', data: {
    member: { valid: true, email: input.email }, affiliate: { affiliateCode: input.affiliateCode },
  } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.deepEqual(await h.auth.importSession(input), {
    authenticated: true, ownerVerified: true, browserUsed: false, stored: true,
  });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].name, 'coupang-web-state');
  const saved = JSON.parse(h.writes[0].value);
  assert.equal(saved.session.cookieJar.cookies[0].secure === true, false);
});
