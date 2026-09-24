import test from 'node:test';
import assert from 'node:assert/strict';
import { environmentSession } from '../scripts/api/environment-session.mjs';
const origin = 'https://blog.naver.com/';
const seed = 'NID_AUT=synthetic-aut; NID_SES=synthetic-ses';
const response = cookie => new Response('', { headers: { 'set-cookie': cookie } });
test('runtime session accepts rotation, expires it and never serializes credentials', () => {
  let clock = 100000;
  const session = environmentSession({ NAVER_COOKIE: seed, now: () => clock });
  session.markOwnerVerified();
  session.acceptResponse(response('NID_SES=synthetic-next; Domain=.naver.com; Path=/; Max-Age=10; Secure'), origin);
  assert.match(session.cookieFor(origin), /synthetic-next/);
  assert.equal(session.status().cookieRotationObserved, true);
  assert.doesNotMatch(JSON.stringify(session), /synthetic|NID_AUT=/);
  clock += 11000;
  assert.throws(() => session.cookieFor(origin), /AUTH_MISSING/);
  assert.equal(session.status().authState, 'reauth_required');
});
test('server deletion and authentication rejection invalidate the session', () => {
  for (const method of ['delete', 'reject']) {
    const session = environmentSession({ NAVER_COOKIE: seed });
    if (method === 'delete') session.acceptResponse(response('NID_AUT=; Domain=.naver.com; Path=/; Max-Age=0'), origin);
    else session.requireReauthentication();
    assert.equal(session.status().authState, 'reauth_required');
    assert.throws(() => session.cookieFor(origin), /AUTH_MISSING/);
  }
});
test('scope, duplicate credentials and unrelated cookie injection are rejected or ignored', () => {
  assert.throws(() => environmentSession({ NAVER_COOKIE: seed + '; NID_AUT=synthetic-other' }), /AUTH_MISSING/);
  assert.throws(() => environmentSession({ NAVER_COOKIE: seed + '; NID_AUT=' }), /AUTH_MISSING/);
  const session = environmentSession({ NAVER_COOKIE: seed + '; unrelated=synthetic-extra' });
  assert.equal(session.cookieFor(origin), seed);
  assert.throws(() => session.acceptResponse(response('NID_AUT=synthetic-forged'), 'https://evil.example/'), /SCOPE/);
  session.acceptResponse(response('NID_AUT=synthetic-forged; Domain=evil.example; Path=/'), origin);
  assert.equal(session.cookieFor(origin), seed);
  session.acceptResponse(response('unrelated=synthetic-extra; Domain=.naver.com; Path=/; Secure'), origin);
  assert.equal(session.status().cookieRotationObserved, false);
  assert.equal(session.status().automaticLoginRenewalVerified, false);
  session.clear(); assert.equal(session.status().authState, 'cleared');
});
