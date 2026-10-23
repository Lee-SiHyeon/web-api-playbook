import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CafeApiError, CafeSession } from '../lib/session.mjs';
import { renewCafeSessionFromStoredActorPin } from '../lib/client.mjs';

const CONTEXT = Object.freeze({ cafeId: '31796283', cafeSlug: 'lifehackailab' });
const NOW = 1_800_000_000_000;
const USER_ID = 'synthetic-owner-id';
const ACTOR_HASH = createHash('sha256').update(USER_ID, 'utf8').digest('hex');
const scopeSuffix = createHash('sha256').update(`${CONTEXT.cafeId}\n${CONTEXT.cafeSlug}`, 'utf8').digest('hex').slice(0, 32);
const CAFE_SESSION_KEY = `naver-cafe-session-${scopeSuffix}`;
const CAFE_STATE_KEY = `naver-cafe-session-state-${scopeSuffix}`;

function makeVault(seed = new Map()) {
  const values = new Map(seed);
  const writes = [];
  return {
    values,
    writes,
    async readCredential(key) { return values.get(key) ?? null; },
    async writeCredential(key, value) { writes.push(key); values.set(key, value); return { stored: true }; },
    async credentialExists(key) { return values.has(key); },
  };
}

function pinBundle(actorHash = ACTOR_HASH) {
  return JSON.stringify({
    version: 1,
    cafeId: CONTEXT.cafeId,
    cafeSlug: CONTEXT.cafeSlug,
    actorHash,
    cafeMember: true,
    verifiedAt: new Date(NOW - 86_400_000).toISOString(),
    cookies: [],
    userAgent: null,
  });
}

function sharedBlogBundle() {
  const expires = Math.floor(NOW / 1000) + 86_400;
  return JSON.stringify({
    version: 1,
    userAgent: 'synthetic-browser-agent',
    cookies: [
      { name: 'NID_AUT', value: 'synthetic-auth-cookie', domain: '.naver.com', path: '/', secure: true, expires },
      { name: 'NID_SES', value: 'synthetic-session-cookie', domain: '.naver.com', path: '/', secure: true, expires },
    ],
  });
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function renewalFetch({ userId = USER_ID, cafeMember = true } = {}) {
  const requests = [];
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    requests.push({ origin: url.origin, path: url.pathname });
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    if (url.pathname === '/home/v1/member/identifier') {
      return response({ result: { loggedIn: true, userId } });
    }
    if (url.pathname === '/cafe-web/cafe2/CafeMemberInfo.json') {
      return response({ result: { cafeId: CONTEXT.cafeId, cafeMember, memberLevelName: '카페매니저', memberLevel: 999 } });
    }
    throw new Error('Unexpected synthetic request path');
  };
  return { fetchImpl, requests };
}

test('reads an existing actor pin from the requested protected Cafe scope, even when old cookies are gone', async () => {
  const vault = makeVault(new Map([[CAFE_SESSION_KEY, pinBundle()]]));
  const actorHash = await CafeSession.readStoredActorPin({ context: CONTEXT, vault });

  assert.equal(actorHash, ACTOR_HASH);
  await assert.rejects(
    CafeSession.readStoredActorPin({ context: { cafeId: '31714934', cafeSlug: 'serenacademmy' }, vault }),
    (error) => error instanceof CafeApiError && error.code === 'CAFE_ACTOR_PIN_MISSING',
  );
});

test('renews only the scoped Cafe DPAPI bundle after the shared blog session matches its pinned actor and membership', async () => {
  const vault = makeVault(new Map([
    ['naver-blog-session', sharedBlogBundle()],
    [CAFE_SESSION_KEY, pinBundle()],
    [CAFE_STATE_KEY, JSON.stringify({ version: 1, cafeId: CONTEXT.cafeId, cafeSlug: CONTEXT.cafeSlug, state: 'reauth_required' })],
    ['naver-cafe-session', 'unrelated-default-scope'],
  ]));
  const { fetchImpl, requests } = renewalFetch();
  const result = await renewCafeSessionFromStoredActorPin({ context: CONTEXT, vault, fetchImpl, now: () => NOW });

  assert.equal(result.renewed, true);
  assert.equal(result.stored, true);
  assert.equal(result.actorMatched, true);
  assert.equal(result.cafeMember, true);
  assert.equal(Object.hasOwn(result, 'actorHash'), false);
  assert.deepEqual(requests.map(({ path }) => path), [
    '/home/v1/member/identifier',
    '/cafe-web/cafe2/CafeMemberInfo.json',
  ]);
  assert.deepEqual(vault.writes, [CAFE_SESSION_KEY, CAFE_STATE_KEY]);
  const stored = JSON.parse(vault.values.get(CAFE_SESSION_KEY));
  assert.equal(stored.actorHash, ACTOR_HASH);
  assert.equal(stored.cafeId, CONTEXT.cafeId);
  assert.equal(vault.values.get('naver-cafe-session'), 'unrelated-default-scope');
  assert.equal(vault.values.has('naver-blog-session'), true);
});

test('stops before any HTTP or DPAPI write when the saved actor pin is missing', async () => {
  const vault = makeVault(new Map([['naver-blog-session', sharedBlogBundle()]]));
  let requests = 0;

  await assert.rejects(
    renewCafeSessionFromStoredActorPin({ context: CONTEXT, vault, fetchImpl: async () => { requests++; throw new Error('must not run'); }, now: () => NOW }),
    (error) => error instanceof CafeApiError && error.code === 'CAFE_ACTOR_PIN_MISSING',
  );
  assert.equal(requests, 0);
  assert.deepEqual(vault.writes, []);
});

test('stops before DPAPI write when the shared session belongs to a different actor or is not a Cafe member', async () => {
  for (const scenario of [
    { name: 'different actor', fetch: renewalFetch({ userId: 'different-synthetic-owner' }), code: 'ACTOR_MISMATCH' },
    { name: 'not a member', fetch: renewalFetch({ cafeMember: false }), code: 'MEMBERSHIP_REQUIRED' },
  ]) {
    const vault = makeVault(new Map([
      ['naver-blog-session', sharedBlogBundle()],
      [CAFE_SESSION_KEY, pinBundle()],
    ]));
    await assert.rejects(
      renewCafeSessionFromStoredActorPin({ context: CONTEXT, vault, fetchImpl: scenario.fetch.fetchImpl, now: () => NOW }),
      (error) => error instanceof CafeApiError && error.code === scenario.code,
      scenario.name,
    );
    assert.deepEqual(vault.writes, []);
  }
});
