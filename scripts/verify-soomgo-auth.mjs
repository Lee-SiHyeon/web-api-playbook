#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditCapabilityChecklist, safeRelativePath } from '../lib/capability-checklist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = 'verification/soomgo-auth-2026-10-27/';
const SOURCE_DIR = `${EVIDENCE_DIR}source/`;
const SOURCE_NAMES = [
  'soomgo-auth-session-import.json',
  'soomgo-auth-owner-one.json',
  'soomgo-auth-owner-two.json',
  'soomgo-auth-requests-opened.json',
  'soomgo-auth-requests-closed-expired.json',
  'soomgo-auth-chats.json',
];
const PROOF_NAMES = [
  'soomgo-auth-owner-proof.json',
  'soomgo-auth-owner-reuse-proof.json',
  'soomgo-auth-requests-opened-proof.json',
  'soomgo-auth-requests-closed-expired-proof.json',
  'soomgo-auth-chats-proof.json',
];
const BOOTSTRAP_CONTEXT_NAME = 'soomgo-auth-bootstrap-context.json';
const ARTIFACT_NAMES = [...PROOF_NAMES, BOOTSTRAP_CONTEXT_NAME];
const REQUIRED_IMPLEMENTATION = [
  'lib/web-auth/soomgo.mjs',
  'scripts/soomgo-account.mjs',
  'lib/protected-store.mjs',
  'lib/scoped-session.mjs',
  'lib/session-lock.mjs',
  'scripts/dpapi-store.ps1',
  'lib/cli.mjs',
  'package.json',
  'package-lock.json',
];
const SOOMGO_ORIGIN = 'https://api.soomgo.com';
const OWNER_PATH = '/api2/users/me/';
const REQUESTS_PATH = '/v1/me/requests/sent';
const CHATS_PATH = '/api/v2.4/chats/';
const WINDOWS_DPAPI = 'Windows DPAPI CurrentUser';
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ISO = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const shaJson = value => sha(Buffer.from(JSON.stringify(value), 'utf8'));
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactObject(value, label) {
  assert.ok(isObject(value), `${label} must be an object`);
}

function assertTime(value, label) {
  assert.ok(ISO(value), `${label} must be an ISO timestamp`);
}

function assertNoSecrets(value, label = 'value') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    assert.ok(!new Set(['cookie', 'cookies', 'cookievalue', 'authorization', 'accesstoken', 'refreshtoken',
      'authtoken', 'apikey', 'password', 'expectedemail', 'email', 'userid', 'ownerid', 'rawbody', 'rawhtml',
      'storagestate', 'secret', 'phone', 'firstname', 'lastname']).has(normalizedKey),
      `Sensitive field ${label}.${key}`);
    if (typeof child === 'string') {
      assert.ok(!/[?&](?:access_token|api_key)=/i.test(child), `Sensitive URL at ${label}.${key}`);
      assert.ok(!/\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/-]{10,}={0,4}/i.test(child), `Credential-like value at ${label}.${key}`);
      assert.ok(!/^(?:sessionid|auth_token|access_token)=/i.test(child), `Credential-like value at ${label}.${key}`);
    }
    assertNoSecrets(child, `${label}.${key}`);
  }
}

export function validateSoomgoBootstrapContext(context) {
  exactObject(context, 'bootstrap context');
  const expectedKeys = [
    'schema', 'service', 'recordedAt', 'hostLabel', 'loginProvider', 'bootstrapMode',
    'userApprovedRequiredConsent', 'optionalConsentSelected', 'loginSucceeded', 'newDeviceRegistrationSelected',
    'secretsPersistedInEvidence', 'automaticOAuthImplemented', 'automaticRefreshImplemented',
    'browserUsedForNativeReads', 'nameCertificationVerified', 'consentReadback', 'ownerControl',
    'businessWritesSubmitted',
  ];
  assert.deepEqual(Object.keys(context).sort(), expectedKeys.sort(), 'Bootstrap context fields changed');
  assert.equal(context.schema, 'web-api-soomgo-bootstrap-context-v1');
  assert.equal(context.service, 'soomgo');
  assertTime(context.recordedAt, 'bootstrapContext.recordedAt');
  assert.equal(context.hostLabel, '140.228');
  assert.equal(context.loginProvider, 'Naver');
  assert.equal(context.bootstrapMode, 'normal_browser_oauth');
  assert.equal(context.userApprovedRequiredConsent, true);
  assert.equal(context.optionalConsentSelected, false);
  assert.equal(context.loginSucceeded, true);
  assert.equal(context.newDeviceRegistrationSelected, false);
  assert.equal(context.secretsPersistedInEvidence, false);
  assert.equal(context.automaticOAuthImplemented, false);
  assert.equal(context.automaticRefreshImplemented, false);
  assert.equal(context.browserUsedForNativeReads, false);
  assert.equal(context.nameCertificationVerified, false);
  exactObject(context.consentReadback, 'bootstrapContext.consentReadback');
  assert.deepEqual(context.consentReadback, {
    allow_use_marketing: false,
    allow_use_select_info: false,
    allow_news_letters: false,
  });
  assert.equal(context.businessWritesSubmitted, 0);
  assert.ok(Array.isArray(context.ownerControl) && context.ownerControl.length === 2);
  const [anonymous, authenticated] = context.ownerControl;
  const controlKeys = ['checkedAt', 'method', 'origin', 'path', 'httpStatus', 'responseBytes',
    'browserUsedForRequest', 'authorizationSent', 'authorizationScheme', 'ownerMatched'];
  for (const [index, control] of context.ownerControl.entries()) {
    exactObject(control, `bootstrapContext.ownerControl[${index}]`);
    assert.deepEqual(Object.keys(control).sort(), controlKeys.sort());
    assert.equal(control.method, 'GET');
    assert.equal(control.origin, SOOMGO_ORIGIN);
    assert.equal(control.path, OWNER_PATH);
    assert.ok(Number.isSafeInteger(control.responseBytes) && control.responseBytes > 0);
    assert.equal(control.browserUsedForRequest, false);
  }
  assertTime(anonymous.checkedAt, 'bootstrapContext.ownerControl[0].checkedAt');
  assertTime(authenticated.checkedAt, 'bootstrapContext.ownerControl[1].checkedAt');
  assert.ok(Date.parse(anonymous.checkedAt) < Date.parse(authenticated.checkedAt));
  assert.equal(anonymous.httpStatus, 401);
  assert.equal(anonymous.authorizationSent, false);
  assert.equal(anonymous.authorizationScheme, null);
  assert.equal(anonymous.ownerMatched, false);
  assert.equal(authenticated.httpStatus, 200);
  assert.equal(authenticated.authorizationSent, true);
  assert.equal(authenticated.authorizationScheme, 'Token');
  assert.equal(authenticated.ownerMatched, true);
  assertNoSecrets(context, 'bootstrapContext');
  return context;
}

function validateReceipt(receipt, { path: route, scheme, operation, label }) {
  exactObject(receipt, label);
  assert.equal(receipt.method, 'GET');
  assert.equal(receipt.origin, SOOMGO_ORIGIN);
  assert.equal(receipt.path, route);
  assert.equal(receipt.authorizationScheme, scheme);
  assert.equal(receipt.httpStatus, 200);
  assert.equal(receipt.mime, 'application/json');
  assert.ok(Number.isSafeInteger(receipt.responseBytes) && receipt.responseBytes > 0);
  assertTime(receipt.checkedAt, `${label}.checkedAt`);
  assert.equal(receipt.browserUsed, false);
  assert.equal(receipt.authenticated, true);
  assert.equal(receipt.credentialsUsed, true);
  assert.equal(receipt.cookiesSent, false);
  assert.equal(receipt.readOnly, true);
  assert.equal(receipt.ownerVerified, true);
  assert.equal(receipt.operation, operation);
  return receipt;
}

function validateOwnerResult(result, command, label = command) {
  exactObject(result, `${label}.result`);
  assert.equal(result.ok, true);
  assert.equal(result.service, 'soomgo');
  assert.equal(result.command, command);
  assert.equal(result.authenticated, true);
  assert.equal(result.ownerVerified, true);
  assert.equal(result.ownerIdPinned, true);
  assert.equal(result.browserUsed, false);
  assert.equal(result.readOnly, true);
  assert.equal(result.requestCount, 1);
  assert.equal(result.credentialProvider, WINDOWS_DPAPI);
  assert.equal(result.persistent, true);
  assert.equal(result.bootstrapMode, 'manual_browser_token_import');
  assert.equal(result.readMode, 'pure_http');
  assert.equal(result.renewal, 'not_implemented');
  validateReceipt(result.receipt, { path: OWNER_PATH, scheme: 'Token', operation: command,
    label: `${label}.result.receipt` });
  return result;
}

function assertProjectedRequestItems(items, label) {
  assert.ok(Array.isArray(items), `${label} must be an array`);
  const keys = ['id', 'service', 'status', 'progressStatus', 'startedAt', 'endedAt', 'quoteCount', 'unreadQuoteCnt'];
  for (let index = 0; index < items.length; index++) {
    const row = items[index];
    exactObject(row, `${label}[${index}]`);
    assert.deepEqual(Object.keys(row).sort(), [...keys].sort(), `${label}[${index}] projected fields changed`);
    assert.ok((Number.isSafeInteger(row.id) && row.id > 0) || typeof row.id === 'string' && row.id.length > 0);
    assert.ok(row.service === null || isObject(row.service) && Object.keys(row.service).sort().join(',') === 'id,name');
    if (row.service !== null) {
      assert.ok(row.service.id === null || Number.isSafeInteger(row.service.id) && row.service.id > 0 ||
        typeof row.service.id === 'string' && row.service.id.length > 0);
      assert.ok(row.service.name === null || typeof row.service.name === 'string');
    }
    assert.ok(row.status === null || ['opened', 'expired', 'closed'].includes(row.status));
    assert.ok(row.progressStatus === null || isObject(row.progressStatus) &&
      Object.keys(row.progressStatus).sort().join(',') === 'name,type' &&
      (row.progressStatus.type === null || Number.isInteger(row.progressStatus.type)) &&
      (row.progressStatus.name === null || typeof row.progressStatus.name === 'string'));
    for (const key of ['startedAt', 'endedAt']) assert.ok(row[key] === null || typeof row[key] === 'string');
    for (const key of ['quoteCount', 'unreadQuoteCnt']) assert.ok(row[key] === null || Number.isSafeInteger(row[key]) && row[key] >= 0);
  }
}

export function validateSoomgoRequestsResult(result, statusFilter) {
  exactObject(result, `requests ${statusFilter} result`);
  assert.equal(result.ok, true);
  assert.equal(result.service, 'soomgo');
  assert.equal(result.command, 'requests');
  assert.equal(result.authenticated, true);
  assert.equal(result.ownerVerified, true);
  assert.equal(result.ownerIdPinned, true);
  assert.equal(result.browserUsed, false);
  assert.equal(result.readOnly, true);
  assert.equal(result.credentialProvider, WINDOWS_DPAPI);
  assert.equal(result.persistent, true);
  assert.equal(result.bootstrapMode, 'manual_browser_token_import');
  assert.equal(result.readMode, 'pure_http');
  assert.equal(result.renewal, 'not_implemented');
  assert.equal(result.status, 'complete');
  assert.equal(result.statusFilter, statusFilter);
  assert.equal(result.sourceStatus, statusFilter === 'opened' ? 'opened' : 'closed,expired');
  assert.equal(result.pageSize, 15);
  assert.ok(Number.isSafeInteger(result.maxPages) && result.maxPages >= 1 && result.maxPages <= 15);
  assert.ok(Number.isSafeInteger(result.pageCount) && result.pageCount >= 1);
  assert.equal(result.completeForSelectedStatus, true);
  assert.equal(result.paginationComplete, true);
  assert.equal(result.legacyExisting, false);
  assert.equal(result.startedWithAfter, false);
  assert.equal(result.resumedWindowOnly, false);
  assert.deepEqual(result.coverage?.gaps, []);
  assert.equal(result.coverage?.legacyExisting, false);
  assert.equal(result.coverage?.resumedWindowOnly, false);
  assert.equal(result.coverage?.entireSoomgoCatalogComplete, false);
  assertProjectedRequestItems(result.items, `requests ${statusFilter}.items`);
  assert.equal(result.duplicateItemCount, 0);
  assert.ok(Number.isSafeInteger(result.totalOpenedCount) && result.totalOpenedCount >= 0);
  assert.ok(Number.isSafeInteger(result.totalCompletedCount) && result.totalCompletedCount >= 0);
  const reconciliation = result.sourceCountReconciliation;
  exactObject(reconciliation, `requests ${statusFilter}.sourceCountReconciliation`);
  assert.equal(reconciliation.returnedRows, result.items.length);
  assert.equal(reconciliation.consistent, true);
  assert.ok(['equals_totalOpenedCount', 'at_least_totalCompletedCount'].includes(reconciliation.comparator));
  assert.equal(reconciliation.expectedCount, statusFilter === 'opened' ? result.totalOpenedCount : result.totalCompletedCount);
  if (statusFilter === 'opened') assert.equal(result.items.length, result.totalOpenedCount);
  else assert.ok(result.items.length >= result.totalCompletedCount);
  assert.equal(result.requestCount, 1 + result.pageCount);
  exactObject(result.receipt, `requests ${statusFilter}.receipt`);
  validateReceipt(result.receipt.ownerPreflight, { path: OWNER_PATH, scheme: 'Token',
    operation: 'requests-owner-preflight', label: `requests ${statusFilter}.ownerPreflight` });
  assert.ok(Array.isArray(result.receipt.pages) && result.receipt.pages.length === result.pageCount);
  const expectedStatus = statusFilter === 'opened' ? 'opened' : 'closed,expired';
  for (let index = 0; index < result.receipt.pages.length; index++) {
    const page = result.receipt.pages[index];
    validateReceipt(page, { path: REQUESTS_PATH, scheme: 'Bearer', operation: 'requests',
      label: `requests ${statusFilter}.pages[${index}]` });
    assert.equal(page.page, index + 1);
    assert.equal(page.query?.status, expectedStatus);
    assert.equal(page.query?.limit, 15);
    assert.equal(page.query?.afterPresent, index > 0);
    assert.ok(Number.isSafeInteger(page.itemCount) && page.itemCount >= 0 && page.itemCount <= 15);
    assert.ok(isObject(page.pagination));
    assert.ok(Number.isSafeInteger(page.pagination.count) && page.pagination.count >= 0);
    assert.equal(page.pagination.limit, 15);
    assert.equal(typeof page.pagination.beforePresent, 'boolean');
    if (index === 0) assert.equal(page.pagination.beforePresent, false);
    assert.equal(page.pagination.afterPresent, index + 1 < result.pageCount);
    assert.equal(page.legacyExisting, false);
  }
  assert.equal(result.receipt.pages.reduce((total, page) => total + page.itemCount, 0), result.items.length);
  assert.ok(result.receipt.pages.every(page => page.pagination.count === page.itemCount) ||
    result.receipt.pages.every(page => page.pagination.count === result.items.length),
  'Source pagination count must reconcile with per-page or total result rows');
  assert.equal(result.nextAfter, undefined);
  return result;
}

export function validateSoomgoChatsResult(result) {
  exactObject(result, 'chats result');
  assert.equal(result.ok, true);
  assert.equal(result.service, 'soomgo');
  assert.equal(result.command, 'chats');
  assert.equal(result.authenticated, true);
  assert.equal(result.ownerVerified, true);
  assert.equal(result.ownerIdPinned, true);
  assert.equal(result.browserUsed, false);
  assert.equal(result.readOnly, true);
  assert.equal(result.credentialProvider, WINDOWS_DPAPI);
  assert.equal(result.persistent, true);
  assert.equal(result.bootstrapMode, 'manual_browser_token_import');
  assert.equal(result.readMode, 'pure_http');
  assert.equal(result.renewal, 'not_implemented');
  assert.equal(result.status, 'first_page_only');
  assert.equal(result.pageCount, 1);
  assert.equal(result.complete, false);
  assert.equal(result.requestCount, 2);
  assert.ok(Array.isArray(result.results));
  for (let index = 0; index < result.results.length; index++) {
    const row = result.results[index];
    exactObject(row, `chats.results[${index}]`);
    assert.deepEqual(Object.keys(row).sort(), ['id', 'last_message_type', 'new_message_count', 'updated_at']);
    assert.ok((Number.isSafeInteger(row.id) && row.id > 0) || typeof row.id === 'string' && row.id.length > 0);
    assert.ok(row.updated_at === null || typeof row.updated_at === 'string');
    assert.ok(row.new_message_count === null || Number.isSafeInteger(row.new_message_count) && row.new_message_count >= 0);
    assert.ok(row.last_message_type === null || Number.isSafeInteger(row.last_message_type) || typeof row.last_message_type === 'string');
  }
  assert.ok(Number.isSafeInteger(result.escrowEventsMetaCount) && result.escrowEventsMetaCount >= 0);
  assert.ok(isObject(result.pagination));
  assert.equal(typeof result.pagination.nextPresent, 'boolean');
  assert.equal(typeof result.pagination.cursorPresent, 'boolean');
  assert.equal(result.pagination.followupQueryVerified, false);
  exactObject(result.receipt, 'chats.receipt');
  validateReceipt(result.receipt.ownerPreflight, { path: OWNER_PATH, scheme: 'Token',
    operation: 'chats-owner-preflight', label: 'chats.ownerPreflight' });
  validateReceipt(result.receipt.response, { path: CHATS_PATH, scheme: 'Token', operation: 'chats', label: 'chats.response' });
  assert.deepEqual(result.receipt.response.query, { role: 'customer' });
  assert.equal(result.receipt.response.resultCount, result.results.length);
  assert.equal(result.receipt.response.escrowEventsMetaCount, result.escrowEventsMetaCount);
  assert.deepEqual(result.receipt.response.pagination, {
    nextPresent: result.pagination.nextPresent,
    cursorPresent: result.pagination.cursorPresent,
  });
  return result;
}

export function validateSoomgoSourceRecord(record, { name, command }) {
  exactObject(record, name);
  assert.equal(record.schema, 'soomgo-account-live-command-v1');
  assert.equal(record.name, name.replace(/^soomgo-auth-/, '').replace(/\.json$/, ''));
  assert.equal(record.command, command);
  assert.ok(Number.isSafeInteger(record.processId) && record.processId > 0);
  assert.equal(record.exitCode, 0);
  assertTime(record.startedAt, `${name}.startedAt`);
  assertTime(record.finishedAt, `${name}.finishedAt`);
  assert.ok(Date.parse(record.startedAt) <= Date.parse(record.finishedAt));
  assert.equal(record.platform, 'win32');
  assert.match(record.nodeVersion ?? '', /^v24\./);
  assert.equal(record.hostLabel, '140.228');
  assert.match(record.sourceCommit ?? '', COMMIT);
  assert.equal(record.stdinUsed, command === 'session-import');
  assert.match(record.storeScopeId ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
    `${name} must carry the same opaque storeScopeId`);
  assert.equal(record.storeBindingEvidence, 'harness_invocation_metadata');
  exactObject(record.implementationBefore, `${name}.implementationBefore`);
  exactObject(record.implementationAfter, `${name}.implementationAfter`);
  assert.deepEqual(Object.keys(record.implementationBefore).sort(), [...REQUIRED_IMPLEMENTATION].sort());
  assert.deepEqual(record.implementationAfter, record.implementationBefore,
    `${name} implementation changed while command ran`);
  for (const relative of REQUIRED_IMPLEMENTATION) assert.match(record.implementationBefore[relative] ?? '', SHA256,
    `${name} missing hash for ${relative}`);
  assert.match(record.sourceResultSha256 ?? '', SHA256);
  assert.equal(record.sourceResultSha256, shaJson(record.result), `${name} CLI result hash mismatch`);
  assertNoSecrets(record, name);
  if (command === 'session-import') {
    const result = record.result;
    exactObject(result, `${name}.result`);
    assert.equal(result.ok, true);
    assert.equal(result.service, 'soomgo');
    assert.equal(result.command, 'session-import');
    assert.equal(result.stored, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.ownerVerified, true);
    assert.equal(result.ownerIdPinned, true);
    assert.equal(result.credentialProvider, WINDOWS_DPAPI);
    assert.equal(result.persistent, true);
    assert.equal(result.bootstrapMode, 'manual_browser_token_import');
    assert.equal(result.readMode, 'pure_http');
    assert.equal(result.browserUsed, false);
    assert.equal(result.requestCount, 1);
    assert.equal(result.renewal, 'not_implemented');
    validateReceipt(result.receipt, { path: OWNER_PATH, scheme: 'Token', operation: 'session-import',
      label: `${name}.result.receipt` });
  } else if (command === 'owner' || command === 'verify') validateOwnerResult(record.result, command, name);
  else if (command === 'requests') {
    const status = name.includes('closed-expired') ? 'closed_expired' : 'opened';
    validateSoomgoRequestsResult(record.result, status);
  } else if (command === 'chats') validateSoomgoChatsResult(record.result);
  return record;
}

function validateStoreBinding(records) {
  const ids = new Set(records.map(record => record.storeScopeId));
  assert.equal(ids.size, 1, 'All recorded CLI calls must use the same opaque DPAPI store scope');
  const [storeScopeId] = ids;
  assert.match(storeScopeId ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
    'storeScopeId must be a non-secret UUID generated by the capture harness');
  return storeScopeId;
}

function validateRuntimeMap(record, implementation, label) {
  assert.deepEqual(record.implementationBefore, implementation, `${label} runtime map differs from manifest`);
  assert.deepEqual(record.implementationAfter, implementation, `${label} runtime map differs from manifest`);
}

function executionOf(record, sourceRecord) {
  return {
    processId: record.processId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    platform: record.platform,
    hostLabel: record.hostLabel,
    nodeVersion: record.nodeVersion,
    sourceCommit: record.sourceCommit,
    storeScopeId: record.storeScopeId,
    storeBindingEvidence: record.storeBindingEvidence,
    sourceResultSha256: record.sourceResultSha256,
    implementationStableDuringRun: true,
    sourceRecord,
  };
}

function normalizedRequest(receipt, ownerMatched = true) {
  return { ...receipt, ownerMatched };
}

function genericProof({ capabilityId, command, record, sourceFile, sourceDigest, implementation, request, projection }) {
  return {
    schema: 'web-api-capability-receipt-v1',
    service: 'soomgo',
    capabilityId,
    checkedAt: request.checkedAt,
    secretsPersistedInEvidence: false,
    authenticated: true,
    ownerVerified: true,
    ownerIdPinned: true,
    expectedEmailMatched: true,
    credentialProvider: WINDOWS_DPAPI,
    persistent: true,
    bootstrapMode: 'manual_browser_token_import',
    readMode: 'pure_http',
    browserUsed: false,
    automatedLoginPosts: 0,
    renewal: 'not_implemented',
    command,
    request,
    execution: executionOf(record, sourceFile),
    sourceRecord: sourceFile,
    sourceRecordSha256: sourceDigest,
    sourceResultSha256: record.sourceResultSha256,
    implementation,
    ...(projection ? { projection } : {}),
  };
}

function buildProofs(records, sourceDigests, implementation) {
  const byName = new Map(records.map(record => [record.name, record]));
  const ownerOne = byName.get('owner-one');
  const ownerTwo = byName.get('owner-two');
  const imported = byName.get('session-import');
  const opened = byName.get('requests-opened');
  const closed = byName.get('requests-closed-expired');
  const chats = byName.get('chats');
  const sourceName = recordName => SOURCE_NAMES.find(name => name.replace(/^soomgo-auth-/, '').replace(/\.json$/, '') === recordName);
  const ownerOneFile = sourceName(ownerOne.name);
  const ownerTwoFile = sourceName(ownerTwo.name);
  const openedFile = sourceName(opened.name);
  const closedFile = sourceName(closed.name);
  const chatsFile = sourceName(chats.name);
  const ownerProof = genericProof({
    capabilityId: 'auth.owner', command: 'owner', record: ownerOne, sourceFile: ownerOneFile,
    sourceDigest: sourceDigests[ownerOneFile], implementation,
    request: normalizedRequest(ownerOne.result.receipt),
  });
  const reuseRuns = [ownerOne, ownerTwo].map((record, index) => ({
    processId: record.processId,
    command: record.command,
    freshProcess: true,
    checkedAt: record.result.receipt.checkedAt,
    authenticated: true,
    ownerVerified: true,
    ownerIdPinned: true,
    expectedEmailMatched: true,
    credentialProvider: WINDOWS_DPAPI,
    persistent: true,
    sessionImportDuringProcess: false,
    loginPostsSent: 0,
    storeScopeId: record.storeScopeId,
    request: normalizedRequest(record.result.receipt),
    sourceRecord: index === 0 ? ownerOneFile : ownerTwoFile,
    sourceRecordSha256: sourceDigests[index === 0 ? ownerOneFile : ownerTwoFile],
    sourceResultSha256: record.sourceResultSha256,
  }));
  const reuseProof = {
    ...genericProof({ capabilityId: 'auth.reuse', command: 'verify', record: ownerTwo,
      sourceFile: ownerTwoFile, sourceDigest: sourceDigests[ownerTwoFile], implementation,
      request: normalizedRequest(ownerTwo.result.receipt) }),
    reuse: {
      schema: 'web-api-soomgo-auth-reuse-v1',
      credentialProvider: WINDOWS_DPAPI,
      persistent: true,
      ownerIdPinned: true,
      sameOwnerAcrossProcesses: true,
      storeScopeId: validateStoreBinding(records),
      storeBindingEvidence: 'harness_invocation_metadata',
      initialSessionImportCount: 1,
      sessionImportsDuringReuse: 0,
      automatedLoginPosts: 0,
      refreshAttempts: 0,
      browserUsed: false,
      importProcessId: imported.processId,
      importSourceRecord: SOURCE_NAMES[0],
      importSourceRecordSha256: sourceDigests[SOURCE_NAMES[0]],
      runs: reuseRuns,
    },
  };
  const openedResult = opened.result;
  const openedProof = genericProof({ capabilityId: 'account.requests.opened', command: 'requests',
    record: opened, sourceFile: openedFile, sourceDigest: sourceDigests[openedFile], implementation,
    request: normalizedRequest(openedResult.receipt.pages[0]),
    projection: {
      status: openedResult.status,
      statusFilter: openedResult.statusFilter,
      sourceStatus: openedResult.sourceStatus,
      pageCount: openedResult.pageCount,
      completeForSelectedStatus: openedResult.completeForSelectedStatus,
      rowCount: openedResult.items.length,
      sourceCountReconciliation: openedResult.sourceCountReconciliation,
      projectedFields: ['id', 'service', 'status', 'progressStatus', 'startedAt', 'endedAt', 'quoteCount', 'unreadQuoteCnt'],
    },
  });
  const closedResult = closed.result;
  const closedProof = genericProof({ capabilityId: 'account.requests.closed-expired', command: 'requests',
    record: closed, sourceFile: closedFile, sourceDigest: sourceDigests[closedFile], implementation,
    request: normalizedRequest(closedResult.receipt.pages[0]),
    projection: {
      status: closedResult.status,
      statusFilter: closedResult.statusFilter,
      sourceStatus: closedResult.sourceStatus,
      pageCount: closedResult.pageCount,
      completeForSelectedStatus: closedResult.completeForSelectedStatus,
      rowCount: closedResult.items.length,
      sourceCountReconciliation: closedResult.sourceCountReconciliation,
      projectedFields: ['id', 'service', 'status', 'progressStatus', 'startedAt', 'endedAt', 'quoteCount', 'unreadQuoteCnt'],
    },
  });
  const chatResult = chats.result;
  const chatsProof = genericProof({ capabilityId: 'account.chats-read', command: 'chats',
    record: chats, sourceFile: chatsFile, sourceDigest: sourceDigests[chatsFile], implementation,
    request: normalizedRequest(chatResult.receipt.response),
    projection: {
      status: chatResult.status,
      complete: chatResult.complete,
      pageCount: chatResult.pageCount,
      rowCount: chatResult.results.length,
      escrowEventsMetaCount: chatResult.escrowEventsMetaCount,
      followupQueryVerified: chatResult.pagination.followupQueryVerified,
      projectedFields: ['id', 'updated_at', 'new_message_count', 'last_message_type'],
    },
  });
  assert.equal(ownerProof.execution.processId, ownerOne.processId);
  assert.equal(reuseProof.execution.processId, ownerTwo.processId);
  return {
    'soomgo-auth-owner-proof.json': ownerProof,
    'soomgo-auth-owner-reuse-proof.json': reuseProof,
    'soomgo-auth-requests-opened-proof.json': openedProof,
    'soomgo-auth-requests-closed-expired-proof.json': closedProof,
    'soomgo-auth-chats-proof.json': chatsProof,
  };
}

export function validateSoomgoAuthProof(proof, { capabilityId, command, sourceRecord, sourceDigest, implementation }) {
  exactObject(proof, `${capabilityId} proof`);
  assert.equal(proof.schema, 'web-api-capability-receipt-v1');
  assert.equal(proof.service, 'soomgo');
  assert.equal(proof.capabilityId, capabilityId);
  assertTime(proof.checkedAt, `${capabilityId}.checkedAt`);
  assert.equal(proof.secretsPersistedInEvidence, false);
  assert.equal(proof.authenticated, true);
  assert.equal(proof.ownerVerified, true);
  assert.equal(proof.ownerIdPinned, true);
  assert.equal(proof.expectedEmailMatched, true);
  assert.equal(proof.credentialProvider, WINDOWS_DPAPI);
  assert.equal(proof.persistent, true);
  assert.equal(proof.bootstrapMode, 'manual_browser_token_import');
  assert.equal(proof.readMode, 'pure_http');
  assert.equal(proof.browserUsed, false);
  assert.equal(proof.automatedLoginPosts, 0);
  assert.equal(proof.renewal, 'not_implemented');
  assert.equal(proof.command, command);
  assert.equal(proof.sourceRecord, sourceRecord);
  assert.equal(proof.sourceRecordSha256, sourceDigest);
  assert.match(proof.sourceResultSha256 ?? '', SHA256);
  assert.deepEqual(proof.implementation, implementation);
  validateReceipt(proof.request, { path: proof.request.path, scheme: proof.request.authorizationScheme,
    operation: proof.request.operation, label: `${capabilityId}.request` });
  assert.equal(proof.request.ownerMatched, true);
  assertTime(proof.execution?.startedAt, `${capabilityId}.execution.startedAt`);
  assertTime(proof.execution?.finishedAt, `${capabilityId}.execution.finishedAt`);
  assert.ok(Date.parse(proof.execution.startedAt) <= Date.parse(proof.execution.finishedAt));
  assert.equal(proof.execution?.platform, 'win32');
  assert.equal(proof.execution?.hostLabel, '140.228');
  assert.match(proof.execution?.nodeVersion ?? '', /^v24\./);
  assert.match(proof.execution?.sourceCommit ?? '', COMMIT);
  assert.match(proof.execution?.storeScopeId ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  assert.equal(proof.execution?.storeBindingEvidence, 'harness_invocation_metadata');
  assert.equal(proof.execution?.sourceRecord, sourceRecord);
  assert.equal(proof.execution?.sourceResultSha256, proof.sourceResultSha256);
  assert.equal(proof.execution?.implementationStableDuringRun, true);
  assertNoSecrets(proof, capabilityId);
  if (capabilityId === 'auth.owner') {
    assert.equal(proof.request.path, OWNER_PATH);
    assert.equal(proof.request.authorizationScheme, 'Token');
  } else if (capabilityId === 'auth.reuse') {
    assert.equal(proof.request.path, OWNER_PATH);
    assert.equal(proof.request.authorizationScheme, 'Token');
    assert.deepEqual(proof.reuse?.runs?.map(run => run.processId), [proof.reuse?.runs?.[0]?.processId, proof.execution.processId]);
    assert.equal(proof.reuse?.runs?.length, 2);
    assert.notEqual(proof.reuse.runs[0].processId, proof.reuse.runs[1].processId);
    assert.equal(proof.reuse.schema, 'web-api-soomgo-auth-reuse-v1');
    assert.equal(proof.reuse.credentialProvider, WINDOWS_DPAPI);
    assert.equal(proof.reuse.persistent, true);
    assert.equal(proof.reuse.sameOwnerAcrossProcesses, true);
    assert.match(proof.reuse.storeScopeId ?? '', /^[a-f0-9-]{36}$/i);
    assert.equal(proof.reuse.storeBindingEvidence, 'harness_invocation_metadata');
    assert.equal(proof.reuse.initialSessionImportCount, 1);
    assert.equal(proof.reuse.sessionImportsDuringReuse, 0);
    assert.equal(proof.reuse.automatedLoginPosts, 0);
    assert.equal(proof.reuse.refreshAttempts, 0);
    assert.equal(proof.reuse.browserUsed, false);
    assert.ok(Number.isSafeInteger(proof.reuse.importProcessId) && proof.reuse.importProcessId > 0);
    assert.notEqual(proof.reuse.importProcessId, proof.reuse.runs[0].processId);
    assert.notEqual(proof.reuse.importProcessId, proof.reuse.runs[1].processId);
    assert.match(proof.reuse.importSourceRecordSha256 ?? '', SHA256);
    for (const run of proof.reuse.runs) {
      exactObject(run, 'reuse run');
      assert.equal(run.freshProcess, true);
      assert.equal(run.authenticated, true);
      assert.equal(run.ownerVerified, true);
      assert.equal(run.ownerIdPinned, true);
      assert.equal(run.expectedEmailMatched, true);
      assert.equal(run.credentialProvider, WINDOWS_DPAPI);
      assert.equal(run.persistent, true);
      assert.equal(run.sessionImportDuringProcess, false);
      assert.equal(run.loginPostsSent, 0);
      assert.equal(run.storeScopeId, proof.reuse.storeScopeId);
      assert.equal(run.request.ownerMatched, true);
      assert.match(run.sourceRecordSha256 ?? '', SHA256);
      assert.match(run.sourceResultSha256 ?? '', SHA256);
      validateReceipt(run.request, { path: OWNER_PATH, scheme: 'Token', operation: run.command,
        label: 'reuse run request' });
    }
  } else if (capabilityId === 'account.requests.opened' || capabilityId === 'account.requests.closed-expired') {
    assert.equal(proof.request.path, REQUESTS_PATH);
    assert.equal(proof.request.authorizationScheme, 'Bearer');
    const status = capabilityId === 'account.requests.opened' ? 'opened' : 'closed_expired';
    assert.equal(proof.request.query?.status, status === 'opened' ? 'opened' : 'closed,expired');
    assert.equal(proof.request.query?.limit, 15);
    assert.equal(proof.projection?.status, 'complete');
    assert.equal(proof.projection?.statusFilter, status);
    assert.equal(proof.projection?.completeForSelectedStatus, true);
    assert.ok(Number.isSafeInteger(proof.projection?.rowCount) && proof.projection.rowCount >= 0);
    assert.deepEqual(proof.projection?.projectedFields,
      ['id', 'service', 'status', 'progressStatus', 'startedAt', 'endedAt', 'quoteCount', 'unreadQuoteCnt']);
  } else if (capabilityId === 'account.chats-read') {
    assert.equal(proof.request.path, CHATS_PATH);
    assert.equal(proof.request.authorizationScheme, 'Token');
    assert.deepEqual(proof.request.query, { role: 'customer' });
    assert.equal(proof.projection?.status, 'first_page_only');
    assert.equal(proof.projection?.complete, false);
    assert.equal(proof.projection?.followupQueryVerified, false);
    assert.ok(Number.isSafeInteger(proof.projection?.rowCount) && proof.projection.rowCount >= 0);
    assert.deepEqual(proof.projection?.projectedFields, ['id', 'updated_at', 'new_message_count', 'last_message_type']);
  }
  return proof;
}

async function readSafe(root, relative, maxBytes = 4 * 1024 * 1024) {
  assert.ok(safeRelativePath(relative), `Unsafe path: ${relative}`);
  const rootReal = await realpath(root);
  const target = path.join(rootReal, relative);
  const targetReal = await realpath(target);
  assert.ok(targetReal.startsWith(rootReal + path.sep), `Path escaped root: ${relative}`);
  const info = await stat(targetReal);
  assert.ok(info.isFile() && info.size <= maxBytes, `File invalid: ${relative}`);
  return readFile(targetReal);
}

async function readJson(root, relative) {
  const bytes = await readSafe(root, relative);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { fail('SOOMGO_AUTH_EVIDENCE_JSON_INVALID', `Invalid JSON: ${relative}`); }
  return { value, bytes };
}

function sourcePath(name) {
  assert.ok(SOURCE_NAMES.includes(name), `Unexpected source file: ${name}`);
  return SOURCE_DIR + name;
}

function proofPath(name) {
  assert.ok(PROOF_NAMES.includes(name), `Unexpected proof file: ${name}`);
  return EVIDENCE_DIR + name;
}

async function currentImplementation(root) {
  const implementation = {};
  for (const relative of REQUIRED_IMPLEMENTATION) implementation[relative] = sha(await readSafe(root, relative, 64 * 1024 * 1024));
  return implementation;
}

function validateRecordSet(records) {
  const expected = [
    ['soomgo-auth-session-import.json', 'session-import'],
    ['soomgo-auth-owner-one.json', 'owner'],
    ['soomgo-auth-owner-two.json', 'verify'],
    ['soomgo-auth-requests-opened.json', 'requests'],
    ['soomgo-auth-requests-closed-expired.json', 'requests'],
    ['soomgo-auth-chats.json', 'chats'],
  ];
  assert.equal(records.length, expected.length);
  for (let index = 0; index < records.length; index++) validateSoomgoSourceRecord(records[index], {
    name: expected[index][0], command: expected[index][1],
  });
  const commitSet = new Set(records.map(record => record.sourceCommit));
  assert.equal(commitSet.size, 1, 'All source records must refer to one commit');
  const scope = validateStoreBinding(records);
  assert.notEqual(records[1].processId, records[2].processId, 'Owner reads must be separate processes');
  assert.notEqual(records[0].processId, records[1].processId, 'Session import and owner read must be separate processes');
  assert.notEqual(records[0].processId, records[2].processId, 'Session import and owner verify must be separate processes');
  const ordered = [records[0], records[1], records[2], ...records.slice(3)];
  for (let index = 1; index < ordered.length; index++) {
    assert.ok(Date.parse(ordered[index - 1].finishedAt) <= Date.parse(ordered[index].startedAt),
      'Recorded CLI commands must be sequential and non-overlapping');
  }
  return { baseCommit: records[0].sourceCommit, storeScopeId: scope };
}

async function loadSourceRecords(root) {
  const records = [];
  const digests = {};
  for (const name of SOURCE_NAMES) {
    const relative = sourcePath(name);
    const { value, bytes } = await readJson(root, relative);
    records.push(value);
    digests[name] = sha(bytes);
  }
  return { records, digests };
}

export async function prepareSoomgoAuthEvidence({ root = ROOT } = {}) {
  const { records, digests } = await loadSourceRecords(root);
  const { baseCommit } = validateRecordSet(records);
  const { value: bootstrapContext, bytes: bootstrapBytes } = await readJson(root, EVIDENCE_DIR + BOOTSTRAP_CONTEXT_NAME);
  validateSoomgoBootstrapContext(bootstrapContext);
  const implementation = await currentImplementation(root);
  for (const record of records) validateRuntimeMap(record, implementation, record.name);
  const proofs = buildProofs(records, digests, implementation);
  for (const [name, proof] of Object.entries(proofs)) {
    const capabilityId = proof.capabilityId;
    const recordName = proof.sourceRecord;
    const sourceRecord = records.find(record => record.name === recordName.replace(/^soomgo-auth-/, '').replace(/\.json$/, ''));
    validateSoomgoAuthProof(proof, { capabilityId, command: sourceRecord.command, sourceRecord: recordName,
      sourceDigest: digests[recordName], implementation });
  }
  const evidencePath = path.join(root, EVIDENCE_DIR);
  await mkdir(evidencePath, { recursive: true });
  const artifactDigests = {};
  artifactDigests[BOOTSTRAP_CONTEXT_NAME] = sha(bootstrapBytes);
  for (const [name, proof] of Object.entries(proofs)) {
    const bytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`, 'utf8');
    await writeFile(path.join(evidencePath, name), bytes);
    artifactDigests[name] = sha(bytes);
  }
  const recordedAt = records.map(record => record.finishedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
  const manifest = {
    schema: 'web-api-soomgo-auth-verification-v1',
    recordedAt,
    baseCommit,
    implementation,
    sourceRecords: digests,
    artifacts: artifactDigests,
    storeScopeId: validateStoreBinding(records),
    boundaries: {
      secretsPersistedInEvidence: false,
      browserUsedForRecordedCliReads: false,
      automatedLoginPosts: 0,
      sessionRefreshImplemented: false,
      businessWritesPerformed: false,
    },
  };
  assertNoSecrets(manifest, 'manifest');
  await writeFile(path.join(evidencePath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, prepared: true, evidenceDirectory: EVIDENCE_DIR, recordedAt, baseCommit,
    sourceRecordCount: Object.keys(digests).length, proofCount: Object.keys(proofs).length,
    artifactCount: Object.keys(artifactDigests).length,
    networkUsed: false };
}

export async function verifySoomgoAuthEvidence({ root = ROOT } = {}) {
  const { value: manifest } = await readJson(root, EVIDENCE_DIR + 'manifest.json');
  exactObject(manifest, 'auth manifest');
  assert.equal(manifest.schema, 'web-api-soomgo-auth-verification-v1');
  assertTime(manifest.recordedAt, 'manifest.recordedAt');
  assert.match(manifest.baseCommit ?? '', COMMIT);
  exactObject(manifest.implementation, 'manifest.implementation');
  assert.deepEqual(Object.keys(manifest.implementation).sort(), [...REQUIRED_IMPLEMENTATION].sort());
  exactObject(manifest.sourceRecords, 'manifest.sourceRecords');
  exactObject(manifest.artifacts, 'manifest.artifacts');
  assert.deepEqual(Object.keys(manifest.sourceRecords).sort(), [...SOURCE_NAMES].sort());
  assert.deepEqual(Object.keys(manifest.artifacts).sort(), [...ARTIFACT_NAMES].sort());
  assert.deepEqual(manifest.boundaries, {
    secretsPersistedInEvidence: false,
    browserUsedForRecordedCliReads: false,
    automatedLoginPosts: 0,
    sessionRefreshImplemented: false,
    businessWritesPerformed: false,
  });
  const implementationNow = await currentImplementation(root);
  assert.deepEqual(manifest.implementation, implementationNow, 'Runtime implementation changed since evidence capture');
  const { records, digests: sourceDigests } = await loadSourceRecords(root);
  const { baseCommit, storeScopeId } = validateRecordSet(records);
  assert.equal(baseCommit, manifest.baseCommit);
  assert.equal(storeScopeId, manifest.storeScopeId);
  assert.deepEqual(sourceDigests, manifest.sourceRecords, 'Source CLI record changed');
  for (const record of records) validateRuntimeMap(record, manifest.implementation, record.name);
  assert.equal(records.at(-1).finishedAt, manifest.recordedAt);
  assert.equal(records.at(-1).sourceCommit, manifest.baseCommit);
  const { value: bootstrapContext, bytes: bootstrapBytes } = await readJson(root, EVIDENCE_DIR + BOOTSTRAP_CONTEXT_NAME);
  validateSoomgoBootstrapContext(bootstrapContext);
  assert.equal(sha(bootstrapBytes), manifest.artifacts[BOOTSTRAP_CONTEXT_NAME], 'Bootstrap context changed');
  const byName = new Map(records.map(record => [record.name, record]));
  const proofOptions = new Map([
    ['soomgo-auth-owner-proof.json', ['auth.owner', 'owner', 'owner-one']],
    ['soomgo-auth-owner-reuse-proof.json', ['auth.reuse', 'verify', 'owner-two']],
    ['soomgo-auth-requests-opened-proof.json', ['account.requests.opened', 'requests', 'requests-opened']],
    ['soomgo-auth-requests-closed-expired-proof.json', ['account.requests.closed-expired', 'requests', 'requests-closed-expired']],
    ['soomgo-auth-chats-proof.json', ['account.chats-read', 'chats', 'chats']],
  ]);
  const proofs = {};
  for (const name of PROOF_NAMES) {
    const relative = proofPath(name);
    const { value: proof, bytes } = await readJson(root, relative);
    assert.equal(sha(bytes), manifest.artifacts[name], `Proof changed: ${name}`);
    const [capabilityId, command, sourceRecordName] = proofOptions.get(name);
    const sourceFile = SOURCE_NAMES.find(file => file.replace(/^soomgo-auth-/, '').replace(/\.json$/, '') === sourceRecordName);
    const record = byName.get(sourceRecordName);
    validateSoomgoAuthProof(proof, { capabilityId, command, sourceRecord: sourceFile,
      sourceDigest: sourceDigests[sourceFile], implementation: manifest.implementation });
    assert.equal(proof.sourceResultSha256, record.sourceResultSha256);
    assert.equal(proof.execution.processId, record.processId);
    assert.equal(proof.execution.startedAt, record.startedAt);
    assert.equal(proof.execution.finishedAt, record.finishedAt);
    assert.equal(proof.execution.hostLabel, record.hostLabel);
    assert.equal(proof.execution.storeScopeId, storeScopeId);
    if (capabilityId === 'auth.owner' || capabilityId === 'auth.reuse') {
      assert.deepEqual(proof.request, normalizedRequest(record.result.receipt));
    } else if (capabilityId.startsWith('account.requests.')) {
      assert.deepEqual(proof.request, normalizedRequest(record.result.receipt.pages[0]));
      const status = capabilityId === 'account.requests.opened' ? 'opened' : 'closed_expired';
      assert.deepEqual(proof.projection, {
        status: record.result.status,
        statusFilter: record.result.statusFilter,
        sourceStatus: record.result.sourceStatus,
        pageCount: record.result.pageCount,
        completeForSelectedStatus: record.result.completeForSelectedStatus,
        rowCount: record.result.items.length,
        sourceCountReconciliation: record.result.sourceCountReconciliation,
        projectedFields: ['id', 'service', 'status', 'progressStatus', 'startedAt', 'endedAt', 'quoteCount', 'unreadQuoteCnt'],
      });
      assert.equal(record.result.statusFilter, status);
    } else if (capabilityId === 'account.chats-read') {
      assert.deepEqual(proof.request, normalizedRequest(record.result.receipt.response));
      assert.deepEqual(proof.projection, {
        status: record.result.status,
        complete: record.result.complete,
        pageCount: record.result.pageCount,
        rowCount: record.result.results.length,
        escrowEventsMetaCount: record.result.escrowEventsMetaCount,
        followupQueryVerified: record.result.pagination.followupQueryVerified,
        projectedFields: ['id', 'updated_at', 'new_message_count', 'last_message_type'],
      });
    }
    proofs[name] = proof;
  }
  const reuse = proofs['soomgo-auth-owner-reuse-proof.json'].reuse;
  assert.equal(reuse.storeScopeId, storeScopeId);
  assert.equal(reuse.storeBindingEvidence, 'harness_invocation_metadata');
  assert.equal(reuse.importProcessId, byName.get('session-import').processId);
  assert.equal(reuse.importSourceRecord, SOURCE_NAMES[0]);
  assert.equal(reuse.importSourceRecordSha256, sourceDigests[SOURCE_NAMES[0]]);
  assert.equal(reuse.runs[0].sourceRecord, SOURCE_NAMES[1]);
  assert.equal(reuse.runs[1].sourceRecord, SOURCE_NAMES[2]);
  assert.equal(reuse.runs[0].sourceRecordSha256, sourceDigests[SOURCE_NAMES[1]]);
  assert.equal(reuse.runs[1].sourceRecordSha256, sourceDigests[SOURCE_NAMES[2]]);
  assert.deepEqual(reuse.runs[0].request, normalizedRequest(byName.get('owner-one').result.receipt));
  assert.deepEqual(reuse.runs[1].request, normalizedRequest(byName.get('owner-two').result.receipt));
  assert.equal(reuse.runs[0].sourceResultSha256, byName.get('owner-one').sourceResultSha256);
  assert.equal(reuse.runs[1].sourceResultSha256, byName.get('owner-two').sourceResultSha256);
  assertNoSecrets(manifest, 'manifest');
  const checklist = await auditCapabilityChecklist({ root, service: 'soomgo' });
  const statusOf = id => checklist.capabilities.find(capability => capability.id === id)?.status;
  const capabilities = {
    owner: statusOf('auth.owner'),
    reuse: statusOf('auth.reuse'),
    requestsOpened: statusOf('account.requests.opened'),
    requestsClosedExpired: statusOf('account.requests.closed-expired'),
    chats: statusOf('account.chats-read'),
  };
  for (const [name, status] of Object.entries(capabilities)) assert.equal(status, 'recorded_live', `${name} checklist entry`);
  const openedCount = proofs['soomgo-auth-requests-opened-proof.json'].projection.rowCount;
  const closedCount = proofs['soomgo-auth-requests-closed-expired-proof.json'].projection.rowCount;
  const chatCount = proofs['soomgo-auth-chats-proof.json'].projection.rowCount;
  return {
    ok: true,
    verification: 'soomgo_auth_evidence_revalidated',
    recordedAt: manifest.recordedAt,
    checkedAt: new Date().toISOString(),
    networkUsed: false,
    liveCheckedNow: false,
    sourceCommit: manifest.baseCommit,
    credentialProvider: WINDOWS_DPAPI,
    persistent: true,
    ownerVerified: true,
    separateOwnerProcesses: [reuse.runs[0].processId, reuse.runs[1].processId].every((pid, index, all) => all.indexOf(pid) === index),
    storeScopeBinding: reuse.storeBindingEvidence,
    reads: { requestsOpenedRows: openedCount, requestsClosedExpiredRows: closedCount,
      chatsFirstPageRows: chatCount, chatsComplete: false },
    capabilities,
    bootstrap: {
      provider: bootstrapContext.loginProvider,
      requiredConsentApproved: bootstrapContext.userApprovedRequiredConsent,
      optionalConsentSelected: bootstrapContext.optionalConsentSelected,
      optionalConsentReadback: bootstrapContext.consentReadback,
      nameCertificationVerified: bootstrapContext.nameCertificationVerified,
      anonymousOwnerControlStatus: bootstrapContext.ownerControl[0].httpStatus,
      authenticatedOwnerControlStatus: bootstrapContext.ownerControl[1].httpStatus,
      businessWritesSubmitted: bootstrapContext.businessWritesSubmitted,
    },
    boundaries: {
      secretsPersistedInEvidence: false,
      browserUsedForRecordedCliReads: false,
      sessionRefreshImplemented: false,
      businessWritesPerformed: false,
      sourceDataMayBeEmpty: true,
    },
    artifacts: manifest.artifacts,
  };
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--prepare') {
    process.stdout.write(JSON.stringify(await prepareSoomgoAuthEvidence(), null, 2) + '\n');
    return;
  }
  assert.equal(args.length, 0, 'Use --prepare explicitly to derive proofs from sanitized CLI source records');
  process.stdout.write(JSON.stringify(await verifySoomgoAuthEvidence(), null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ ok: false, verification: 'soomgo_auth_evidence_invalid',
      networkUsed: false, code: error.code ?? 'SOOMGO_AUTH_EVIDENCE_INVALID', message: error.message }) + '\n');
    process.exitCode = 1;
  });
}
