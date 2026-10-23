import test from 'node:test';
import assert from 'node:assert/strict';
import { hasFreshAuthenticationCookies, mergeLoginResponseCookies } from '../tools/discovery/naver-login-http-handoff-utils.mjs';
import { classifyUnauthenticatedLoginResponse, summarizeNaverLoginResponse } from '../scripts/naver-login-http.mjs';
import { loadNaverCookies, storeNaverCookies } from '../scripts/session-vault.mjs';
import { resetTestCredentialStore } from '../scripts/secure-credential-store.mjs';
import { SessionClient } from '../scripts/session-client.mjs';

test.beforeEach(resetTestCredentialStore);

const cookie = (name, value, domain = '.naver.com', path = '/') => ({
  name, value, domain, path, secure: true, expires: -1, httpOnly: true,
});

function responseWithCookies(lines) {
  const headers = new Headers();
  for (const line of lines) headers.append('set-cookie', line);
  return { headers };
}

test('login response rotation uses the shared parser and requires both protected-origin auth cookies to change', () => {
  const previous = [cookie('NID_AUT', 'old-aut'), cookie('NID_SES', 'old-ses')];
  const response = responseWithCookies([
    'NID_AUT=new-aut; Domain=.naver.com; Path=/; Secure; HttpOnly; SameSite=Lax',
    'NID_SES=new-ses; Domain=.naver.com; Path=/; Secure; HttpOnly; SameSite=Lax',
  ]);

  const update = mergeLoginResponseCookies(previous, response, 1_800_000_000_000);
  assert.equal(update.changed, true);
  assert.equal(update.cookies.find(item => item.name === 'NID_AUT').value, 'new-aut');
  assert.equal(update.cookies.find(item => item.name === 'NID_SES').value, 'new-ses');
  assert.equal(hasFreshAuthenticationCookies(previous, update.cookies), true);
});

test('deleted, unchanged, or login-host-only auth cookies do not count as a fresh Blog session', () => {
  const previous = [cookie('NID_AUT', 'old-aut'), cookie('NID_SES', 'old-ses')];
  const deleted = mergeLoginResponseCookies(previous, responseWithCookies([
    'NID_AUT=; Domain=.naver.com; Path=/; Max-Age=0',
    'NID_SES=new-ses; Domain=.naver.com; Path=/; Secure',
  ]), 1_800_000_000_000);
  assert.equal(deleted.cookies.some(item => item.name === 'NID_AUT'), false);
  assert.equal(hasFreshAuthenticationCookies(previous, deleted.cookies), false);

  const unchanged = mergeLoginResponseCookies(previous, responseWithCookies([
    'NID_AUT=old-aut; Domain=.naver.com; Path=/; Secure; HttpOnly',
    'NID_SES=new-ses; Domain=.naver.com; Path=/; Secure; HttpOnly',
  ]), 1_800_000_000_000);
  assert.equal(hasFreshAuthenticationCookies(previous, unchanged.cookies), false);

  const loginHostOnly = mergeLoginResponseCookies(previous, responseWithCookies([
    'NID_AUT=new-aut; Path=/; Secure; HttpOnly',
    'NID_SES=new-ses; Path=/; Secure; HttpOnly',
  ]), 1_800_000_000_000);
  assert.equal(hasFreshAuthenticationCookies(previous, loginHostOnly.cookies), false);
});

test('no-fresh-cookie responses reuse the safe account-protection and CAPTCHA classifications', async () => {
  const protectedResponse = new Response('', { status: 302, headers: {
    location: 'https://nid.naver.com/user2/help/idSafetyRelease?proof=private-marker',
  } });
  const protectedShape = summarizeNaverLoginResponse('', protectedResponse);
  assert.equal(classifyUnauthenticatedLoginResponse(protectedShape, protectedResponse.status), 'ACCOUNT_PROTECTION_REQUIRED');
  assert.doesNotMatch(JSON.stringify(protectedShape), /private-marker/);

  const captchaResponse = new Response('<form><input name="chptcha"></form>', {
    status: 200, headers: { 'content-type': 'text/html' },
  });
  const captchaShape = summarizeNaverLoginResponse(await captchaResponse.text(), captchaResponse);
  assert.equal(captchaShape.captchaInputDetected, true);
  assert.equal(classifyUnauthenticatedLoginResponse(captchaShape, captchaResponse.status), 'IMAGE_CHALLENGE_REQUIRED');
});

test('deferred login rotation is not saved when protected owner verification fails', async () => {
  const previous = [cookie('NID_AUT', 'old-aut'), cookie('NID_SES', 'old-ses')];
  await storeNaverCookies(previous, { userAgent: 'SyntheticBrowser/1.0' });
  const wrongOwnerHtml = `<div id="lnbMenu">블로그 관리</div><a href="/another-owner/config/bloginfo">settings</a>${' '.repeat(1200)}`;
  const client = new SessionClient({ cookies: previous, ownerBlogId: 'aicandoanything',
    defaultHeaders: { 'user-agent': 'SyntheticBrowser/2.0' }, persistRotation: false,
    fetchImpl: async raw => {
      const url = new URL(raw);
      assert.equal(url.origin, 'https://admin.blog.naver.com');
      assert.equal(url.pathname, '/aicandoanything');
      return new Response(wrongOwnerHtml, { headers: { 'content-type': 'text/html',
        'set-cookie': 'NID_SES=rotated-ses; Domain=.naver.com; Path=/; Secure' } });
    } });

  try { await assert.rejects(client.persistVerifiedSession(), { code: 'AUTH_UNVERIFIED' }); }
  finally { client.clear(); }
  const saved = await loadNaverCookies({ env: {} });
  assert.equal(saved.cookies.find(item => item.name === 'NID_AUT')?.value, 'old-aut');
  assert.equal(saved.cookies.find(item => item.name === 'NID_SES')?.value, 'old-ses');
  assert.equal(saved.userAgent, 'SyntheticBrowser/1.0');
});
