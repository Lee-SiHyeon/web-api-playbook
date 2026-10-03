import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProtectedStore } from '../lib/protected-store.mjs';
import { createBrandconnectAuth } from '../lib/web-auth/brandconnect.mjs';

// /brand-connect/query/me and /space/check-owner as observed 2026-09-25 (JSON account, empty 200 owner check).
const NOW = Date.parse('2026-09-25T03:00:00Z');
const cookies = aut => [
  { name: 'NID_AUT', value: aut, domain: '.naver.com', path: '/', secure: true, expires: -1 },
  { name: 'NID_SES', value: 'ses-' + aut, domain: '.naver.com', path: '/', secure: true, expires: -1 },
];

async function harness(t, { loginId = () => 'owner1' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brandconnect-renew-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new ProtectedStore({ provider: 'memory', directory: dir });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), headers = new Headers(init.headers), cookie = headers.get('cookie') || '';
    calls.push({ path: u.pathname, aut: /NID_AUT=([^;]+)/.exec(cookie)?.[1] ?? null,
      space: headers.get('x-space-id'), userAgent: headers.get('user-agent') });
    if (u.pathname === '/brand-connect/query/me') {
      return new Response(JSON.stringify({ loginId: loginId(), creator: true, partner: false, activeSpaceIds: ['123456'] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname === '/brand-connect/query/space/check-owner') return new Response('', { status: 200 });
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  const auth = createBrandconnectAuth({ store, fetchImpl, now: () => NOW });
  await auth.importSession({ cookies: cookies('old'), expectedLoginId: 'owner1', spaceId: '123456' });
  calls.length = 0;
  return { store, calls, auth };
}

test('renew-session swaps in fresh Naver cookies after the same account verifies', async t => {
  const h = await harness(t);
  const r = await h.auth.renewSession({ cookies: cookies('fresh') });
  assert.equal(r.renewal, 'naver_session_import');
  assert.equal(r.ownerVerified, true);
  assert.ok(h.calls.every(c => c.aut === 'fresh' && c.space === '123456'), 'verification used the new cookies and the stored space');
  const saved = JSON.parse(h.store.read('brandconnect-state'));
  assert.equal(saved.expectedLoginId, 'owner1');
  assert.ok(JSON.stringify(saved.session).includes('fresh'));
  assert.ok(!JSON.stringify(saved.session).includes('"old"'));
});

test('renew-session uses a supplied observed Naver user agent and stores it after owner verification', async t => {
  const h = await harness(t);
  const userAgent = `Node.js/${process.versions.node} jsdom/26.1.0 NaverLoginHttpClient/1.0`;
  await h.auth.renewSession({ cookies: cookies('fresh'), userAgent });
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(c => c.aut === 'fresh' && c.space === '123456' && c.userAgent === userAgent));
  const saved = JSON.parse(h.store.read('brandconnect-state'));
  assert.equal(saved.session.defaultHeaders['user-agent'], userAgent);
});

test('renew-session falls back to the previously observed BrandConnect user agent when none is supplied', async t => {
  const h = await harness(t);
  const prior = JSON.parse(h.store.read('brandconnect-state'));
  const priorUserAgent = prior.session.defaultHeaders['user-agent'];
  await h.auth.renewSession({ cookies: cookies('fresh') });
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(c => c.aut === 'fresh' && c.space === '123456' && c.userAgent === priorUserAgent));
  const saved = JSON.parse(h.store.read('brandconnect-state'));
  assert.equal(saved.session.defaultHeaders['user-agent'], priorUserAgent);
});

test('renew-session rejects an invalid supplied user agent before making requests or saving', async t => {
  const h = await harness(t);
  const prior = h.store.read('brandconnect-state');
  await assert.rejects(h.auth.renewSession({ cookies: cookies('fresh'), userAgent: 'invalid\r\nInjected: header' }),
    e => e.code === 'USER_AGENT_INVALID');
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.read('brandconnect-state'), prior);
});

test('renew-session keeps the stored session when the cookies belong to another account', async t => {
  let id = 'owner1';
  const h = await harness(t, { loginId: () => id });
  const prior = JSON.parse(h.store.read('brandconnect-state'));
  id = 'someone-else';
  const userAgent = `Node.js/${process.versions.node} jsdom/26.1.0 NaverLoginHttpClient/1.0`;
  await assert.rejects(h.auth.renewSession({ cookies: cookies('other'), userAgent }),
    e => e.code === 'ACCOUNT_MISMATCH');
  const afterMismatch = JSON.parse(h.store.read('brandconnect-state'));
  assert.ok(JSON.stringify(afterMismatch.session).includes('old'));
  assert.equal(afterMismatch.session.defaultHeaders['user-agent'], prior.session.defaultHeaders['user-agent']);
  await assert.rejects(h.auth.renewSession({ cookies: cookies('x'), spaceId: '999' }), e => e.code === 'INPUT_INVALID');
});
