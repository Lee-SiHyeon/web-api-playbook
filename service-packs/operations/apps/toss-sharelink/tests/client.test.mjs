import test from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, allowedUrl, requestWithDependencies, schema, todayDealItemsUrl, validateBundle } from '../client-core.mjs';

function validBundle() {
  return {
    version: 1,
    service: 'toss-sharelink',
    allowedOrigin: ORIGIN,
    cookies: [{
      name: 'TGSID',
      domain: '.toss.im',
      path: '/',
      secure: true,
      httpOnly: true,
      value: 'unit-test-placeholder',
    }],
    expectedOwner: { publisherId: 42 },
    readRequests: {
      member: { method: 'GET', url: `${ORIGIN}/api-public/v3/shopping-growth/sharelink/member` },
      'shopping-products': { method: 'GET', url: `${ORIGIN}/api-public/v3/shopping/sharelink/products` },
    },
  };
}

test('validates a captured read-operation table and Toss cookie scope', () => {
  const contract = validBundle();
  assert.equal(validateBundle(contract), contract);
  assert.deepEqual(Object.keys(contract.readRequests), ['member', 'shopping-products']);
  assert.equal(allowedUrl(contract.readRequests.member.url).origin, ORIGIN);
});

test('rejects cookies and operation URLs outside the allowed origin scope', () => {
  const badCookie = validBundle();
  badCookie.cookies[0].domain = '.outside.test';
  assert.throws(() => validateBundle(badCookie), { code: 'TOSS_COOKIE_SCOPE_REJECTED' });

  const badRequest = validBundle();
  badRequest.readRequests['shopping-products'].url = 'https://outside.test/api-public/v3/shopping/sharelink/products';
  assert.throws(() => validateBundle(badRequest), { code: 'TOSS_REQUEST_SCOPE_REJECTED' });
});

test('rejects non-GET operations in a captured table', () => {
  const contract = validBundle();
  contract.readRequests['shopping-products'].method = 'POST';
  assert.throws(() => validateBundle(contract), { code: 'TOSS_OPERATION_REJECTED' });
});

test('uses an injected fetch and refuses redirects without following them', async () => {
  const bundle = validBundle();
  const calls = [];
  await assert.rejects(requestWithDependencies('member', {
    loadSession: () => bundle,
    fetchImpl: async (url, options) => {
      calls.push({
        origin: url.origin,
        path: url.pathname,
        redirect: options.redirect,
        cookieNames: options.headers.Cookie.split('; ').map(part => part.split('=')[0]),
      });
      return { status: 302 };
    },
    persistSession: () => { throw new Error('unexpected persistence'); },
  }), { code: 'TOSS_REAUTH_REQUIRED' });
  assert.deepEqual(calls, [{
    origin: ORIGIN,
    path: '/api-public/v3/shopping-growth/sharelink/member',
    redirect: 'manual',
    cookieNames: ['TGSID'],
  }]);
});

test('member read requires publisherId and compares optional owner fields only when saved', async () => {
  const publisherOnly = validBundle();
  const accepted = await requestWithDependencies('member', {
    loadSession: () => publisherOnly,
    fetchImpl: async () => Response.json({ resultType: 'SUCCESS', success: { publisherId: 42, userNo: 90, bizUserNo: 91 } }),
  });
  assert.equal(accepted.status, 200);

  for (const success of [
    { publisherId: 42 },
    { publisherId: 42, userNo: 44 },
  ]) {
    const withSavedOptional = validBundle();
    withSavedOptional.expectedOwner.userNo = 43;
    await assert.rejects(requestWithDependencies('member', {
      loadSession: () => withSavedOptional,
      fetchImpl: async () => Response.json({ resultType: 'SUCCESS', success }),
    }), { code: 'TOSS_OWNER_MISMATCH' });
  }
});

test('summarizes nested response data without retaining values', () => {
  assert.deepEqual(schema({
    resultType: 'SUCCESS',
    success: { items: [{ id: 7, label: 'sample', optional: null }], active: true },
    empty: [],
  }), {
    resultType: 'string',
    success: { items: [{ id: 'number', label: 'string', optional: 'null' }], active: 'boolean' },
    empty: [],
  });
});

test('builds the observed TODAY_DEAL items GET URL and only adds a supplied response cursor', () => {
  const firstPage = new URL(todayDealItemsUrl());
  assert.equal(firstPage.origin, ORIGIN);
  assert.equal(firstPage.pathname, '/api-public/v3/shopping/sharelink/curation-sections/TODAY_DEAL/items');
  assert.deepEqual([...firstPage.searchParams.entries()], [['size', '20']]);
  assert.equal(allowedUrl(firstPage.href).href, firstPage.href);

  const cursor = 'observed+cursor/2==';
  const nextPage = new URL(todayDealItemsUrl(cursor));
  assert.deepEqual([...nextPage.searchParams.entries()], [['size', '20'], ['nextCursor', cursor]]);
  assert.throws(() => todayDealItemsUrl('bad\nvalue'), { code: 'TOSS_INPUT_INVALID' });
  assert.throws(() => todayDealItemsUrl(123), { code: 'TOSS_INPUT_INVALID' });
});
