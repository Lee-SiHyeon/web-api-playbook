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
    const u = new URL(url), cookie = new Headers(init.headers).get('cookie') || '';
    calls.push({ path: u.pathname, aut: /NID_AUT=([^;]+)/.exec(cookie)?.[1] ?? null, space: new Headers(init.headers).get('x-space-id') });
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

test('renew-session keeps the stored session when the cookies belong to another account', async t => {
  let id = 'owner1';
  const h = await harness(t, { loginId: () => id });
  id = 'someone-else';
  await assert.rejects(h.auth.renewSession({ cookies: cookies('other') }), e => e.code === 'ACCOUNT_MISMATCH');
  assert.ok(JSON.stringify(JSON.parse(h.store.read('brandconnect-state')).session).includes('old'));
  await assert.rejects(h.auth.renewSession({ cookies: cookies('x'), spaceId: '999' }), e => e.code === 'INPUT_INVALID');
});
