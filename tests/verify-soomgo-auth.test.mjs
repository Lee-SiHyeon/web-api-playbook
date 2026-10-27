import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  validateSoomgoAuthProof,
  validateSoomgoBootstrapContext,
  validateSoomgoChatsResult,
  validateSoomgoRequestsResult,
  validateSoomgoSourceRecord,
} from '../scripts/verify-soomgo-auth.mjs';

const checkedAt = '2026-10-27T07:12:00.000Z';
const implementation = Object.fromEntries([
  'lib/web-auth/soomgo.mjs',
  'scripts/soomgo-account.mjs',
  'lib/protected-store.mjs',
  'lib/scoped-session.mjs',
  'lib/session-lock.mjs',
  'scripts/dpapi-store.ps1',
  'lib/cli.mjs',
  'package.json',
  'package-lock.json',
].map(file => [file, 'a'.repeat(64)]));

function receipt({ path, authorizationScheme, operation, time = checkedAt, ...extra }) {
  return {
    method: 'GET',
    origin: 'https://api.soomgo.com',
    path,
    authorizationScheme,
    httpStatus: 200,
    mime: 'application/json',
    responseBytes: 150,
    checkedAt: time,
    browserUsed: false,
    authenticated: true,
    credentialsUsed: true,
    cookiesSent: false,
    readOnly: true,
    operation,
    ownerVerified: true,
    ...extra,
  };
}

function ownerReceipt(command = 'owner') {
  return receipt({ path: '/api2/users/me/', authorizationScheme: 'Token', operation: command });
}

function requestsResult(statusFilter = 'opened') {
  const sourceStatus = statusFilter === 'opened' ? 'opened' : 'closed,expired';
  const ownerPreflight = receipt({ path: '/api2/users/me/', authorizationScheme: 'Token',
    operation: 'requests-owner-preflight' });
  const page = receipt({ path: '/v1/me/requests/sent', authorizationScheme: 'Bearer', operation: 'requests',
    query: { status: sourceStatus, limit: 15, afterPresent: false }, page: 1, itemCount: 0,
    pagination: { count: 0, limit: 15, beforePresent: false, afterPresent: false }, legacyExisting: false });
  return {
    ok: true,
    service: 'soomgo',
    command: 'requests',
    authenticated: true,
    ownerVerified: true,
    ownerIdPinned: true,
    browserUsed: false,
    readOnly: true,
    credentialProvider: 'Windows DPAPI CurrentUser',
    persistent: true,
    bootstrapMode: 'manual_browser_token_import',
    readMode: 'pure_http',
    renewal: 'not_implemented',
    status: 'complete',
    statusFilter,
    sourceStatus,
    pageSize: 15,
    maxPages: 1,
    pageCount: 1,
    items: [],
    duplicateItemCount: 0,
    totalOpenedCount: 0,
    totalCompletedCount: 0,
    legacyExisting: false,
    sourceCountReconciliation: {
      returnedRows: 0,
      comparator: statusFilter === 'opened' ? 'equals_totalOpenedCount' : 'at_least_totalCompletedCount',
      expectedCount: 0,
      consistent: true,
    },
    startedWithAfter: false,
    resumedWindowOnly: false,
    paginationComplete: true,
    completeForSelectedStatus: true,
    coverage: {
      scope: 'source_reported_status_filter',
      legacyExisting: false,
      resumedWindowOnly: false,
      gaps: [],
      entireSoomgoCatalogComplete: false,
    },
    requestCount: 2,
    receipt: { ownerPreflight, pages: [page] },
  };
}

function chatsResult() {
  const ownerPreflight = receipt({ path: '/api2/users/me/', authorizationScheme: 'Token',
    operation: 'chats-owner-preflight' });
  const response = receipt({ path: '/api/v2.4/chats/', authorizationScheme: 'Token', operation: 'chats',
    query: { role: 'customer' }, resultCount: 0, escrowEventsMetaCount: 0,
    pagination: { nextPresent: false, cursorPresent: false } });
  return {
    ok: true,
    service: 'soomgo',
    command: 'chats',
    authenticated: true,
    ownerVerified: true,
    ownerIdPinned: true,
    browserUsed: false,
    readOnly: true,
    credentialProvider: 'Windows DPAPI CurrentUser',
    persistent: true,
    bootstrapMode: 'manual_browser_token_import',
    readMode: 'pure_http',
    renewal: 'not_implemented',
    status: 'first_page_only',
    pageCount: 1,
    complete: false,
    results: [],
    escrowEventsMetaCount: 0,
    pagination: { nextPresent: false, cursorPresent: false, followupQueryVerified: false },
    requestCount: 2,
    receipt: { ownerPreflight, response },
  };
}

function ownerProof() {
  const ownerRequest = ownerReceipt();
  ownerRequest.ownerMatched = true;
  return {
    schema: 'web-api-capability-receipt-v1',
    service: 'soomgo',
    capabilityId: 'auth.owner',
    checkedAt,
    secretsPersistedInEvidence: false,
    authenticated: true,
    ownerVerified: true,
    ownerIdPinned: true,
    expectedEmailMatched: true,
    credentialProvider: 'Windows DPAPI CurrentUser',
    persistent: true,
    bootstrapMode: 'manual_browser_token_import',
    readMode: 'pure_http',
    browserUsed: false,
    automatedLoginPosts: 0,
    renewal: 'not_implemented',
    command: 'owner',
    request: ownerRequest,
    execution: {
      processId: 100,
      startedAt: checkedAt,
      finishedAt: checkedAt,
      platform: 'win32',
      hostLabel: '140.228',
      nodeVersion: 'v24.22.1',
      sourceCommit: 'b'.repeat(40),
      storeScopeId: 'fb8a7b02-8ad7-5e14-af3c-3a89ec165634',
      storeBindingEvidence: 'harness_invocation_metadata',
      sourceResultSha256: 'c'.repeat(64),
      implementationStableDuringRun: true,
      sourceRecord: 'soomgo-auth-owner-one.json',
    },
    sourceRecord: 'soomgo-auth-owner-one.json',
    sourceRecordSha256: 'd'.repeat(64),
    sourceResultSha256: 'c'.repeat(64),
    implementation,
  };
}

function bootstrapContext() {
  return {
    schema: 'web-api-soomgo-bootstrap-context-v1',
    service: 'soomgo',
    recordedAt: checkedAt,
    hostLabel: '140.228',
    loginProvider: 'Naver',
    bootstrapMode: 'normal_browser_oauth',
    userApprovedRequiredConsent: true,
    optionalConsentSelected: false,
    loginSucceeded: true,
    newDeviceRegistrationSelected: false,
    secretsPersistedInEvidence: false,
    automaticOAuthImplemented: false,
    automaticRefreshImplemented: false,
    browserUsedForNativeReads: false,
    nameCertificationVerified: false,
    consentReadback: {
      allow_use_marketing: false,
      allow_use_select_info: false,
      allow_news_letters: false,
    },
    ownerControl: [
      { checkedAt: '2026-10-27T07:10:00.000Z', method: 'GET', origin: 'https://api.soomgo.com',
        path: '/api2/users/me/', httpStatus: 401, responseBytes: 115, browserUsedForRequest: false,
        authorizationSent: false, authorizationScheme: null, ownerMatched: false },
      { checkedAt: checkedAt, method: 'GET', origin: 'https://api.soomgo.com',
        path: '/api2/users/me/', httpStatus: 200, responseBytes: 1153, browserUsedForRequest: false,
        authorizationSent: true, authorizationScheme: 'Token', ownerMatched: true },
    ],
    businessWritesSubmitted: 0,
  };
}

function ownerSourceRecord() {
  const result = {
    ok: true,
    service: 'soomgo',
    command: 'owner',
    authenticated: true,
    ownerVerified: true,
    ownerIdPinned: true,
    browserUsed: false,
    readOnly: true,
    requestCount: 1,
    credentialProvider: 'Windows DPAPI CurrentUser',
    persistent: true,
    bootstrapMode: 'manual_browser_token_import',
    readMode: 'pure_http',
    renewal: 'not_implemented',
    receipt: ownerReceipt(),
  };
  return {
    schema: 'soomgo-account-live-command-v1',
    name: 'owner-one',
    command: 'owner',
    processId: 100,
    exitCode: 0,
    startedAt: checkedAt,
    finishedAt: checkedAt,
    platform: 'win32',
    hostLabel: '140.228',
    nodeVersion: 'v24.22.1',
    sourceCommit: 'b'.repeat(40),
    storeScopeId: 'fb8a7b02-8ad7-5e14-af3c-3a89ec165634',
    storeBindingEvidence: 'harness_invocation_metadata',
    implementationBefore: implementation,
    implementationAfter: implementation,
    stdinUsed: false,
    sourceResultSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    result,
  };
}

test('empty but complete request reads remain valid only with count and pagination reconciliation', () => {
  assert.equal(validateSoomgoRequestsResult(requestsResult('opened'), 'opened').items.length, 0);
  assert.equal(validateSoomgoRequestsResult(requestsResult('closed_expired'), 'closed_expired').items.length, 0);

  const incomplete = requestsResult();
  incomplete.completeForSelectedStatus = false;
  assert.throws(() => validateSoomgoRequestsResult(incomplete, 'opened'));

  const badPagination = requestsResult();
  badPagination.receipt.pages[0].pagination.count = 15;
  assert.throws(() => validateSoomgoRequestsResult(badPagination, 'opened'));
});

test('chat evidence accepts an empty first page while keeping completeness false', () => {
  assert.equal(validateSoomgoChatsResult(chatsResult()).results.length, 0);
  const falseCompleteness = chatsResult();
  falseCompleteness.complete = true;
  assert.throws(() => validateSoomgoChatsResult(falseCompleteness));
});

test('generic owner proof is bound to the exact Token owner endpoint and owner match', () => {
  const proof = ownerProof();
  assert.equal(validateSoomgoAuthProof(proof, {
    capabilityId: 'auth.owner', command: 'owner', sourceRecord: 'soomgo-auth-owner-one.json',
    sourceDigest: 'd'.repeat(64), implementation,
  }).request.ownerMatched, true);

  const wrongRoute = structuredClone(proof);
  wrongRoute.request.path = '/api2/users/other/';
  assert.throws(() => validateSoomgoAuthProof(wrongRoute, {
    capabilityId: 'auth.owner', command: 'owner', sourceRecord: 'soomgo-auth-owner-one.json',
    sourceDigest: 'd'.repeat(64), implementation,
  }));

  const missingOwnerMatch = structuredClone(proof);
  missingOwnerMatch.request.ownerMatched = false;
  assert.throws(() => validateSoomgoAuthProof(missingOwnerMatch, {
    capabilityId: 'auth.owner', command: 'owner', sourceRecord: 'soomgo-auth-owner-one.json',
    sourceDigest: 'd'.repeat(64), implementation,
  }));
});

test('bootstrap context preserves optional-consent and anonymous-versus-authenticated owner controls', () => {
  assert.equal(validateSoomgoBootstrapContext(bootstrapContext()).businessWritesSubmitted, 0);
  const badControl = bootstrapContext();
  badControl.ownerControl[0].authorizationSent = true;
  assert.throws(() => validateSoomgoBootstrapContext(badControl));
  const optionalConsent = bootstrapContext();
  optionalConsent.consentReadback.allow_news_letters = true;
  assert.throws(() => validateSoomgoBootstrapContext(optionalConsent));
});

test('source record hash binds the sanitized CLI result and rejects personal identifiers', () => {
  const record = ownerSourceRecord();
  assert.equal(validateSoomgoSourceRecord(record, {
    name: 'soomgo-auth-owner-one.json', command: 'owner',
  }).sourceResultSha256.length, 64);
  const leakedIdentity = structuredClone(record);
  leakedIdentity.result.ownerId = 12345;
  leakedIdentity.sourceResultSha256 = createHash('sha256').update(JSON.stringify(leakedIdentity.result)).digest('hex');
  assert.throws(() => validateSoomgoSourceRecord(leakedIdentity, {
    name: 'soomgo-auth-owner-one.json', command: 'owner',
  }), /Sensitive field/);
});
