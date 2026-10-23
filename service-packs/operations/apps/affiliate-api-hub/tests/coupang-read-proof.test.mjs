import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCoupangReadProof } from '../lib/coupang-read-proof.mjs';

const identity = {
  productId: '6247736560',
  itemId: '12646874013',
  vendorItemId: '79914317500',
};
const checkedAt = '2026-10-04T03:30:00.000Z';

function quantityReceipt(overrides = {}) {
  return {
    checkedAt,
    operation: 'quantity_info',
    method: 'GET',
    origin: 'https://www.coupang.com',
    path: '/next-api/products/quantity-info',
    query: { productId: identity.productId, vendorItemId: identity.vendorItemId },
    status: 403,
    contentType: 'text/html',
    bytes: 2048,
    bodyComplete: true,
    bodyError: null,
    execution: 'pure_http',
    browserUsed: false,
    authenticationMode: 'protected',
    credentialSent: true,
    credentialPropagated: true,
    authenticatedOwnerVerified: null,
    applicationAuthenticated: null,
    transport: 'native_fetch',
    server: 'AkamaiGHost',
    challengeConfirmed: false,
    accessDeniedTitle: true,
    dpopChallengePresent: false,
    denialSignals: { requestBlocked: true, automatedAccess: false, permissionDenied: true, loginPage: false },
    cookieRotationApplied: false,
    cookieRotationPersisted: false,
    visitorCookieRotationApplied: null,
    visitorBootstrap: null,
    retry: false,
    redirectsFollowed: false,
    ...overrides,
  };
}

test('projects bounded read proof without query values or sensitive receipt material', () => {
  const receipt = quantityReceipt({
    query: { productId: identity.productId, vendorItemId: identity.vendorItemId },
    requestUrl: 'https://private.invalid/path?token=CANARY_URL',
    headers: { cookie: 'CANARY_COOKIE', authorization: 'CANARY_HEADER' },
    responseText: 'CANARY_BODY',
    responseSha256: 'CANARY_HASH',
    requestToken: 'CANARY_TOKEN',
    responseCookieHeadersAvailable: true,
    responseCookieCount: 2,
    retryAfterSeconds: 45,
    durationMs: 132,
  });
  const projected = projectCoupangReadProof(receipt, identity);

  assert.equal(projected.operation, 'quantity_info');
  assert.equal(projected.path, '/next-api/products/quantity-info');
  assert.deepEqual(projected.queryKeys, ['productId', 'vendorItemId']);
  assert.equal(projected.exactRequestIdentityMatched, true);
  assert.deepEqual(projected.identityFieldsMatched, ['productId', 'vendorItemId']);
  assert.equal(projected.status, 403);
  assert.equal(projected.server, 'AkamaiGHost');
  assert.equal(projected.authenticatedOwnerVerified, null);
  assert.equal(projected.applicationAuthenticated, null);
  assert.equal(projected.visitorCookieRotationApplied, null);
  assert.equal(projected.visitorCookiesSent, null);
  assert.equal(projected.visitorCookieNames, null);
  assert.deepEqual(projected.denialSignals, {
    requestBlocked: true,
    automatedAccess: false,
    permissionDenied: true,
    loginPage: false,
  });
  assert.equal(projected.visitorBootstrapStatus, null);
  assert.equal(projected.responseCookieCount, 2);
  assert.equal(projected.retryAfterSeconds, 45);
  assert.equal(projected.durationMs, 132);
  const serialized = JSON.stringify(projected);
  for (const canary of [identity.productId, identity.itemId, identity.vendorItemId,
    'private.invalid', 'CANARY_URL', 'CANARY_COOKIE', 'CANARY_HEADER', 'CANARY_BODY',
    'CANARY_HASH', 'CANARY_TOKEN',
    'requestUrl', 'responseText', 'responseSha256', 'headers']) {
    assert.equal(serialized.includes(canary), false, canary);
  }
});

test('projects visitor bootstrap status and only allowlisted visitor cookie names', () => {
  const receipt = {
    checkedAt,
    operation: 'offer_list',
    method: 'GET',
    origin: 'https://www.coupang.com',
    path: '/next-api/offer-list',
    query: { productId: identity.productId, itemId: identity.itemId,
      selectedVendorItemId: identity.vendorItemId },
    status: 200,
    execution: 'pure_http',
    browserUsed: false,
    authenticationMode: 'visitor',
    credentialSent: false,
    credentialPropagated: false,
    transport: 'native_fetch',
    visitorBootstrap: { status: 200, requestUrl: 'CANARY_BOOTSTRAP_URL', cookie: 'CANARY_BOOTSTRAP_COOKIE' },
    visitorCookieRotationApplied: true,
    visitorCookiesSent: true,
    visitorCookieNames: ['x-coupang-target-market', 'PCID', 'x-coupang-accept-language'],
    cookie: 'CANARY_COOKIE',
  };
  const projected = projectCoupangReadProof(receipt, identity);
  assert.equal(projected.exactRequestIdentityMatched, true);
  assert.deepEqual(projected.identityFieldsMatched, ['productId', 'itemId', 'vendorItemId']);
  assert.equal(projected.visitorBootstrapStatus, 200);
  assert.equal(projected.visitorCookieRotationApplied, true);
  assert.equal(projected.visitorCookiesSent, true);
  assert.deepEqual(projected.visitorCookieNames, ['PCID', 'x-coupang-accept-language', 'x-coupang-target-market']);
  const serialized = JSON.stringify(projected);
  for (const canary of ['CANARY_BOOTSTRAP_URL', 'CANARY_BOOTSTRAP_COOKIE', 'CANARY_COOKIE'])
    assert.equal(serialized.includes(canary), false);

  const malformedNames = projectCoupangReadProof({ ...receipt,
    visitorCookieNames: ['PCID', 'CANARY_PRIVATE_COOKIE_NAME'],
  }, identity);
  assert.equal(malformedNames.visitorCookiesSent, true);
  assert.equal(malformedNames.visitorCookieNames, null);
  assert.equal(JSON.stringify(malformedNames).includes('CANARY_PRIVATE_COOKIE_NAME'), false);
  assert.equal(projectCoupangReadProof({ ...receipt, visitorCookieNames: 'PCID' }, identity).visitorCookieNames, null);
  assert.equal(projectCoupangReadProof({ ...receipt,
    visitorCookieNames: ['PCID', 'PCID'],
  }, identity).visitorCookieNames, null);
  assert.equal(projectCoupangReadProof({ ...receipt,
    visitorCookieNames: ['PCID', 'x-coupang-target-market', 'x-coupang-accept-language', 'EXTRA'],
  }, identity).visitorCookieNames, null);
});

test('marks an exact SKU mismatch and suppresses unrecognized query keys', () => {
  const projected = projectCoupangReadProof(quantityReceipt({
    query: { productId: identity.productId, vendorItemId: '79914317501', tracking: 'CANARY_QUERY' },
  }), identity);
  assert.equal(projected.exactRequestIdentityMatched, false);
  assert.deepEqual(projected.identityFieldsMatched, []);
  assert.deepEqual(projected.queryKeys, ['productId', 'vendorItemId']);
  assert.equal(JSON.stringify(projected).includes('CANARY_QUERY'), false);
});

test('malformed receipts produce fixed safe fields and never throw', () => {
  const projected = projectCoupangReadProof({
    operation: 'unrecognized-CANARY',
    origin: 'https://private.invalid/CANARY',
    path: '/private/CANARY',
    query: ['CANARY'],
    checkedAt: 'not-a-time-CANARY',
    status: '403-CANARY',
    server: 'private-server-CANARY',
    contentType: 'text/html; CANARY',
    bytes: Number.MAX_SAFE_INTEGER,
    bodyError: 'CANARY_BODY',
    visitorBootstrap: 'CANARY_BOOTSTRAP',
    raw: 'CANARY_RAW',
  }, identity);
  assert.equal(projected.operation, null);
  assert.equal(projected.origin, null);
  assert.equal(projected.path, null);
  assert.deepEqual(projected.queryKeys, []);
  assert.equal(projected.exactRequestIdentityMatched, false);
  assert.deepEqual(projected.identityFieldsMatched, []);
  assert.equal(projected.checkedAt, null);
  assert.equal(projected.status, null);
  assert.equal(projected.server, null);
  assert.equal(projected.bytes, null);
  assert.equal(projected.bodyError, null);
  assert.equal(projected.visitorBootstrapStatus, null);
  assert.equal(JSON.stringify(projected).includes('CANARY'), false);
  assert.equal(projectCoupangReadProof(null, identity), null);
});
