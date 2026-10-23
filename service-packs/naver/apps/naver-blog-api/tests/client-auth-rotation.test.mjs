// Ported from affiliate-content-operations/apps/naver-blog-api (2026-10-05 client.mjs fix):
// a rejected session that deletes NID_AUT/NID_SES must not overwrite the shared vault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../scripts/client.mjs';
import { storeNaverCookies, loadNaverCookies } from '../scripts/session-vault.mjs';
import { resetTestCredentialStore } from '../scripts/secure-credential-store.mjs';

test.beforeEach(resetTestCredentialStore);
const query = { timeDimension: 'fixture', startDate: 'fixture', exclude: '', _: 'fixture' };
const input = { operation: 'daily/cv', query };
const cookie = (name, value) => ({ name, value, domain: '.naver.com', path: '/', secure: true, expires: -1 });

test('auth cookie deletion on a read fails closed and leaves the stored session untouched', async () => {
  delete process.env.NAVER_COOKIE;
  await storeNaverCookies([cookie('NID_AUT', 'synthetic-aut'), cookie('NID_SES', 'synthetic-ses')]);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'NID_SES=; Domain=.naver.com; Path=/; Max-Age=0; Secure');
    return new Response('{}', { status: 200, headers });
  };
  await assert.rejects(read(input, { fetchImpl, maxRetries: 0 }), error => error.code === 'AUTH_MISSING');
  assert.equal(calls, 1, 'no retry after auth rejection');
  const after = await loadNaverCookies({ env: {} });
  assert.equal(after.cookies.find(c => c.name === 'NID_SES')?.value, 'synthetic-ses');
});
