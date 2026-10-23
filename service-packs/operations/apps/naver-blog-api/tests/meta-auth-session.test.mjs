import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMetaSession, storeMetaSession, loadMetaSession, checkMetaSession, rotateMetaCookies, metaCookieHeader }
  from '../scripts/meta-auth-session.mjs';
import { resetTestCredentialStore } from '../scripts/secure-credential-store.mjs';

function fixture() {
  return { version: 1, service: 'instagram', origin: 'https://www.instagram.com', owner: 'lifehack__ailab', capturedAt: Date.now(),
    cookies: ['sessionid','csrftoken','ds_user_id'].map(name => ({ name, value: 'fixture', domain: '.instagram.com',
      path: '/', secure: true, httpOnly: name === 'sessionid', expires: -1 })),
    ownerRequest: { method: 'GET', url: 'https://www.instagram.com/api/v1/accounts/edit/web_form_data/', headers: { accept: '*/*' } } };
}
function threadsFixture() {
  const x = fixture();
  Object.assign(x, { service: 'threads', origin: 'https://www.threads.com', ownerId: '123' });
  x.cookies.forEach(c => { c.domain = '.threads.com'; if (c.name === 'ds_user_id') c.value = '123'; });
  const form = new URLSearchParams({ doc_id: '28683786577907583', fb_api_req_friendly_name: 'BarcelonaFeedTimelineViewerQuery', variables: JSON.stringify({
    __relay_internal__pv__BarcelonaHasBestOfThreadsrelayprovider: true,
    __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true,
    __relay_internal__pv__BarcelonaHasPrivateRepliesDeprecationrelayprovider: false,
  }) });
  x.ownerRequest = { method: 'POST', url: 'https://www.threads.com/graphql/query', headers: {}, body: form.toString() };
  return x;
}
function response(body, headers = {}, url = fixture().ownerRequest.url) {
  const r = new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  Object.defineProperty(r, 'url', { value: url });
  return r;
}
test('service scope, duplicate credentials, expiry and owner request are enforced', () => {
  for (const change of [
    x => { x.cookies[0].domain = '.threads.com'; },
    x => { x.cookies.push({ ...x.cookies[0] }); },
    x => { x.cookies[0].expires = 1; },
    x => { x.ownerRequest.url = 'https://example.com/'; },
    x => { x.ownerRequest.method = 'POST'; },
    x => { x.ownerRequest.headers.referer = 'https://example.com/'; },
  ]) { const x = fixture(); change(x); assert.throws(() => normalizeMetaSession('instagram', x)); }
  const x = fixture(); x.cookies.push({ name: 'rd_challenge', value: 'fixture' });
  assert.equal(normalizeMetaSession('instagram', x).cookies.length, 3);
  x.owner = 'another_owner';
  assert.throws(() => normalizeMetaSession('instagram', x), /META_SESSION_INVALID/);
});
test('HTML 200 and another owner cannot establish authentication', async () => {
  resetTestCredentialStore(); storeMetaSession('instagram', fixture());
  await assert.rejects(checkMetaSession('instagram', { fetchImpl: async () => response('<html>Login</html>', { 'content-type': 'text/html' }) }), /META_OWNER_MIME/);
  await assert.rejects(checkMetaSession('instagram', { fetchImpl: async () => response(JSON.stringify({ status: 'ok', form_data: { username: 'another_owner' } })) }), /META_OWNER_MISMATCH/);
});
test('a deleting Set-Cookie invalidates the protected bundle without retry', async () => {
  resetTestCredentialStore(); storeMetaSession('instagram', fixture()); let requests = 0;
  await assert.rejects(checkMetaSession('instagram', { fetchImpl: async () => { requests++; return response('{}',
    { 'set-cookie': 'sessionid=; Max-Age=0; Domain=.instagram.com; Path=/; Secure; HttpOnly' }); } }), /META_REAUTH_REQUIRED/);
  assert.equal(requests, 1); assert.throws(() => loadMetaSession('instagram'), /META_REAUTH_REQUIRED/);
});
test('Instagram host-only rotation stays on its response host and rejects sibling domains', () => {
  const x = fixture();
  const uploadResponse = setCookie => ({ url: 'https://i.instagram.com/rupload_igphoto/fixture',
    headers: { getSetCookie: () => [setCookie] } });
  rotateMetaCookies(x, uploadResponse('sessionid=rotated; Path=/; Secure; HttpOnly'));
  assert.equal(x.cookies.find(c => c.name === 'sessionid').domain, 'i.instagram.com');
  assert.ok(metaCookieHeader(x, 'https://i.instagram.com/rupload_igphoto/fixture').split('; ').includes('sessionid=rotated'));
  assert.ok(!metaCookieHeader(x, 'https://www.instagram.com/api/graphql').split('; ').includes('sessionid=rotated'));

  const sameHostDomain = fixture();
  rotateMetaCookies(sameHostDomain, uploadResponse('sessionid=upload-domain; Domain=i.instagram.com; Path=/; Secure'));
  assert.equal(sameHostDomain.cookies.find(c => c.name === 'sessionid').domain, '.i.instagram.com');
  assert.ok(metaCookieHeader(sameHostDomain, 'https://i.instagram.com/rupload_igphoto/fixture').split('; ').includes('sessionid=upload-domain'));
  assert.ok(!metaCookieHeader(sameHostDomain, 'https://www.instagram.com/api/graphql').split('; ').includes('sessionid=upload-domain'));

  const y = fixture();
  rotateMetaCookies(y, uploadResponse('sessionid=wrong-host; Domain=www.instagram.com; Path=/; Secure'));
  assert.equal(y.cookies.find(c => c.name === 'sessionid').value, 'fixture');
});
test('only the observed Threads viewer query and boolean variables are admitted', () => {
  const x = threadsFixture();
  assert.equal(normalizeMetaSession('threads', x).ownerId, '123');
  const form = new URLSearchParams(x.ownerRequest.body);
  form.set('doc_id', '1'); x.ownerRequest.body = form.toString();
  assert.throws(() => normalizeMetaSession('threads', x), /META_OWNER_CONTRACT_UNVERIFIED/);
});
test('Threads owner read rejects response username metadata that differs from the bound owner', async () => {
  resetTestCredentialStore(); storeMetaSession('threads', threadsFixture());
  const url = 'https://www.threads.com/graphql/query';
  const body = JSON.stringify({ data: { viewer: { user: { id: '123', username: 'another_owner' } } } });
  await assert.rejects(checkMetaSession('threads', { fetchImpl: async () => response(body, {}, url) }), /META_OWNER_MISMATCH/);
});
