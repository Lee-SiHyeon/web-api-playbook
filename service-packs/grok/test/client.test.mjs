import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GrokWebClient, loadContractRegistry, readinessMatrix } from '../src/client.mjs';
import { fail, publicError } from '../src/errors.mjs';
import { materializeOperationUrl, validateOperationInput, validateContractRegistry } from '../src/contracts.mjs';
import { GrokSessionStore } from '../src/session.mjs';
import { OperationJournal } from '../src/journal.mjs';
import { ProtectedJsonStore } from '../src/protected-json-store.mjs';
import { downloadValidatedMedia, validateMediaPrefix } from '../src/media.mjs';
import { collectStream } from '../src/streaming.mjs';
import { ObservedHttpTransport } from '../src/transport.mjs';

function capturedRegistry() {
  const evidence = (method, requestPath) => ({
    source: 'browser_network_capture',
    capturedAt: '2026-10-03',
    requestMethod: method,
    requestPath,
    httpStatus: 200,
    responseContentType: 'application/json',
    securityBoundary: 'normal_observed_xhr',
    securitySignals: [],
  });
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    serviceOrigin: 'https://grok.com',
    allowedOrigins: ['https://grok.com'],
    identityOperationId: 'identity.read',
    operations: [
      {
        id: 'identity.read', kind: 'read', role: 'identity', identityJsonPointer: '/handle', method: 'GET',
        urlTemplate: 'https://grok.com/rest/account/me', authMode: 'session',
        request: { credentialBindings: { cookies: ['sid'], headers: [] }, inputSchema: { properties: {}, required: [] } },
        response: { mode: 'json', statuses: [200], contentTypes: ['application/json'], maxBytes: 4096 },
        evidence: evidence('GET', '/rest/account/me'),
      },
      {
        id: 'chat.create', kind: 'submit', effect: 'chat_write', method: 'POST',
        urlTemplate: 'https://grok.com/rest/app-chat/test', authMode: 'session',
        request: {
          bodyTemplate: { message: '{{input.message}}' }, bodyEncoding: 'json', contentType: 'application/json',
          inputSchema: { properties: { message: { type: 'string', maxLength: 100 } }, required: ['message'] },
          credentialBindings: { cookies: ['sid'], headers: [] },
        },
        response: { mode: 'json', statuses: [200], contentTypes: ['application/json'], maxBytes: 4096 },
        responseJobIdPointer: '/id',
        evidence: evidence('POST', '/rest/app-chat/test'),
      },
    ],
  };
}

function validBundle() {
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    origin: 'https://grok.com',
    capturedAt: new Date().toISOString(),
    sourceObservationId: 'test-handoff-1',
    origins: [{
      origin: 'https://grok.com',
      cookies: [{ name: 'sid', value: 'test-secret-cookie', origin: 'https://grok.com', path: '/', secure: true, httpOnly: true }],
      headers: [],
    }],
  };
}

async function verifiedSessionSnapshot(identity, cookieValue) {
  const sessionPersistence = new ProtectedJsonStore({ provider: 'memory' });
  const client = new GrokWebClient({
    registry: capturedRegistry(),
    sessionPersistence,
    fetchImpl: async (url, init) => {
      assert.equal(new Headers(init.headers).get('cookie'), `sid=${cookieValue}`);
      if (String(url).endsWith('/rest/account/me')) {
        return new Response(JSON.stringify({ handle: identity }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error('unexpected session setup request');
    },
  });
  const bundle = validBundle();
  bundle.origins[0].cookies[0].value = cookieValue;
  await client.importSession(bundle);
  const ownerRead = await client.verifyOwner(identity);
  assert.equal(ownerRead.httpStatus, 200);
  assert.equal(ownerRead.rawResponseDigestKind, 'raw_http_body');
  assert.match(ownerRead.rawResponseDigest, /^[a-f0-9]{64}$/);
  assert.match(ownerRead.requestDigest, /^[a-f0-9]{64}$/);
  return sessionPersistence.read();
}

class SessionSnapshotSwapStore {
  provider = 'memory';
  current;
  replacement;
  swapOnNextRead = false;
  readCount = 0;

  constructor(current, replacement) {
    this.current = structuredClone(current);
    this.replacement = structuredClone(replacement);
  }

  async read() {
    this.readCount++;
    const snapshot = structuredClone(this.current);
    if (this.swapOnNextRead) {
      this.swapOnNextRead = false;
      this.current = structuredClone(this.replacement);
    }
    return snapshot;
  }

  async write(value) {
    this.current = structuredClone(value);
    return { provider: this.provider, persistent: false };
  }

  transact(callback) {
    return Promise.resolve().then(async () => {
      const result = await callback(structuredClone(this.current));
      this.current = structuredClone(result.value);
      return result.result;
    });
  }

  async clear() {
    this.current = null;
    return { cleared: true };
  }
}

function publicModelsPayload() {
  return {
    models: [{ modelId: 'grok-3', name: '', description: '', ignoredField: 'must-not-be-returned' }],
    unavailableModels: [],
    defaultAnonModel: 'grok-3', defaultFreeModel: 'grok-3', defaultProModel: 'grok-4', defaultHeavyModel: 'grok-4',
    defaultAnonMode: 'MODEL_MODE_AUTO', defaultFreeMode: 'MODEL_MODE_AUTO', defaultProMode: 'MODEL_MODE_AUTO', defaultHeavyMode: 'MODEL_MODE_AUTO',
  };
}

test('contract registry distinguishes source-derived public models from browser capture', async () => {
  const registry = await loadContractRegistry();
  const operation = registry.operations.find(item => item.id === 'public.models');
  assert.equal(operation.evidence.source, 'public_bundle_callsite');
  const readiness = readinessMatrix(registry);
  assert.equal(readiness.capabilities.publicModels.captured, false);
  assert.equal(readiness.capabilities.publicModels.clientExists, true);
  assert.equal(readiness.capabilities.publicModels.directReadVerified, true);
  assert.equal(readiness.capabilities.textGeneration.clientExists, false);
  assert.equal(readiness.capabilities.history.captured, true);
  assert.equal(readiness.capabilities.imageGeneration.clientExists, false);
  assert.equal(readiness.capabilities.videoGeneration.clientExists, false);
});

test('observed init issuance can enable that phase without claiming file-upload completion', async () => {
  const registry = await loadContractRegistry();
  const init = registry.operations.find(operation => operation.id === 'attachment.upload.init');
  assert.equal(init.evidence.semanticReadbackVerified, false);
  assert.equal(init.evidence.resourceIssuance.fullUploadReadbackVerified, false);
  assert.equal(readinessMatrix(registry).operations.find(row => row.operationId === init.id).ready, true);
  const broken = structuredClone(registry);
  broken.operations.find(operation => operation.id === init.id).evidence.resourceIssuance.issuedUploadIdSha256 = 'missing';
  assert.throws(() => validateContractRegistry(broken), { code: 'CONTRACT_FIRST_PARTY_SEMANTIC_READBACK_REQUIRED' });
  const complete = registry.operations.find(operation => operation.id === 'attachment.upload.complete');
  assert.equal(readinessMatrix(registry).operations.find(row => row.operationId === complete.id).ready, false);
});

test('authenticated owner, history, sharing-read and settings contracts materialize only observed query fields', async () => {
  const registry = await loadContractRegistry();
  assert.equal(registry.identityOperationId, 'auth.owner.read');
  for (const id of ['auth.owner.read', 'conversation.list.read', 'conversation.read', 'history.response-nodes', 'history.load-responses', 'conversation.share.read', 'settings.read']) {
    assert.equal(registry.operations.find(operation => operation.id === id)?.evidence.securityBoundary, 'normal_observed_xhr');
  }
  const list = registry.operations.find(operation => operation.id === 'conversation.list.read');
  assert.equal(materializeOperationUrl(list, { pageSize: 50, excludeProjects: true }).href,
    'https://grok.com/rest/app-chat/conversations?pageSize=50&excludeProjects=true');
  const detail = registry.operations.find(operation => operation.id === 'conversation.read');
  assert.equal(materializeOperationUrl(detail, { conversationId: '0123456789abcdef' }).href,
    'https://grok.com/rest/app-chat/conversations_v2/0123456789abcdef?includeTaskResult=true&includeWorkspaces=true');
  const sharing = registry.operations.find(operation => operation.id === 'conversation.share.read');
  assert.equal(materializeOperationUrl(sharing, { conversationId: '0123456789abcdef', responseId: 'fedcba9876543210' }).searchParams.get('responseId'), 'fedcba9876543210');
  assert.throws(() => materializeOperationUrl(list, { pageSize: 50, arbitrary: true }), { code: 'OPERATION_INPUT_UNKNOWN_FIELD' });
});

test('nested input schemas reject unknown fields and path traversal variants', () => {
  const operation = {
    urlTemplate: 'https://grok.com/rest/items/{{input.id}}',
    request: { inputSchema: { properties: {
      id: { type: 'string', maxLength: 64 },
      details: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
      rows: { type: 'array', items: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] } },
    }, required: ['id', 'details', 'rows'] } },
  };
  assert.throws(() => validateOperationInput(operation, { id: 'x', details: { note: 'ok', other: 'no' }, rows: [] }), { code: 'OPERATION_INPUT_UNKNOWN_FIELD' });
  const preferenceMap = { request: { inputSchema: { properties: {
    preferences: { type: 'object', properties: {}, additionalProperties: { type: 'boolean' } },
  }, required: ['preferences'] } } };
  assert.equal(validateOperationInput(preferenceMap, { preferences: { autoWrapLongLinesCode: true } }).preferences.autoWrapLongLinesCode, true);
  assert.throws(() => validateOperationInput(preferenceMap, { preferences: { autoWrapLongLinesCode: 'enabled' } }), { code: 'OPERATION_INPUT_TYPE_INVALID' });
  assert.throws(() => materializeOperationUrl(operation, { id: '..', details: { note: 'ok' }, rows: [] }), { code: 'OPERATION_PATH_VALUE_INVALID' });
  assert.throws(() => materializeOperationUrl(operation, { id: '%2e%2e', details: { note: 'ok' }, rows: [] }), { code: 'OPERATION_PATH_VALUE_INVALID' });
  assert.throws(() => materializeOperationUrl(operation, { id: '%25252e%25252e', details: { note: 'ok' }, rows: [] }), { code: 'OPERATION_PATH_VALUE_INVALID' });
  assert.throws(() => materializeOperationUrl(operation, { id: '%252fadmin', details: { note: 'ok' }, rows: [] }), { code: 'OPERATION_PATH_VALUE_INVALID' });
});

test('a source-exact public models call omits credentials and returns only bounded public fields', async () => {
  let call;
  const result = await import('../src/public-models.mjs').then(({ fetchPublicModels }) => fetchPublicModels({
    fetchImpl: async (url, init) => {
      call = { url: String(url), init };
      return new Response(JSON.stringify(publicModelsPayload()), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    },
  }));
  assert.equal(call.url, 'https://grok.com/rest/models');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(JSON.parse(call.init.body), { locale: 'en' });
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.redirect, 'manual');
  assert.deepEqual(Object.keys(call.init.headers), ['content-type']);
  assert.equal(result.data.models[0].modelId, 'grok-3');
  assert.equal(Object.hasOwn(result.data.models[0], 'ignoredField'), false);
  assert.equal(result.evidence.sourceDerived, true);
  assert.equal(result.evidence.browserCaptured, false);
  assert.equal(result.evidence.transport, 'injected_fetch');
  assert.equal(result.evidence.credentialsUsed, false);
  assert.equal(result.evidence.requestSucceeded, true);
  assert.equal(result.evidence.liveReplay, false);
});

test('public models reader rejects unexpected shape and redirects without retry', async () => {
  let calls = 0;
  const { fetchPublicModels } = await import('../src/public-models.mjs');
  await assert.rejects(fetchPublicModels({ fetchImpl: async () => {
    calls++;
    return new Response('blocked', { status: 403, headers: { 'content-type': 'text/html' } });
  } }), { code: 'PUBLIC_MODELS_STATUS_UNEXPECTED' });
  assert.equal(calls, 1);
  await assert.rejects(fetchPublicModels({ fetchImpl: async () => new Response(JSON.stringify({ ...publicModelsPayload(), extra: true }), { status: 200, headers: { 'content-type': 'application/json' } }) }), { code: 'PUBLIC_MODELS_SCHEMA_INVALID' });
});

test('transport blocks evidenced challenge pages but does not infer one from a generic Cloudflare script', async () => {
  const registry = await loadContractRegistry();
  const operation = registry.operations.find(item => item.id === 'public.models');
  let calls = 0;
  const blocked = new ObservedHttpTransport({ registry, fetchImpl: async () => {
    calls++;
    return new Response('<html><title>Access denied</title><p>blocked</p></html>', { status: 403, headers: { 'content-type': 'text/html' } });
  } });
  await assert.rejects(blocked.request(operation), error => error.code === 'SECURITY_CHALLENGE_BLOCKED' && error.details.challengeDetected === true);
  assert.equal(calls, 1);
  const generic = new ObservedHttpTransport({ registry, fetchImpl: async () => {
    calls++;
    return new Response('<html><script src="cloudflare.js"></script></html>', { status: 403, headers: { 'content-type': 'text/html' } });
  } });
  await assert.rejects(generic.request(operation), error => error.code === 'HTTP_STATUS_UNEXPECTED' && error.details.challengeDetected === false);
  assert.equal(calls, 2);
});

test('session import leaves owner unverified and an arbitrary string cannot bind a caller identity', async () => {
  const store = new GrokSessionStore({ store: new ProtectedJsonStore({ provider: 'memory' }) });
  await store.importBundle(validBundle());
  assert.equal((await store.status()).ownerVerified, false);
  await assert.rejects(store.bindVerifiedOwner('some-user-name', {
    operationId: 'identity.read', httpStatus: 200, identityMatched: true, identityDigest: 'a'.repeat(64),
  }), { code: 'OWNER_BINDING_NOT_AUTHORIZED' });
  assert.equal((await store.status()).ownerVerified, false);
});

test('private owner reads stop before transport when no session cookie is present', async () => {
  const registry = capturedRegistry();
  let calls = 0;
  const client = new GrokWebClient({
    registry,
    sessionPersistence: new ProtectedJsonStore({ provider: 'memory' }),
    fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
  });
  await assert.rejects(client.verifyOwner('owner'), { code: 'SESSION_NOT_AVAILABLE' });
  assert.equal(calls, 0);
});

test('public errors retain safe status but suppress identifiers and credentials', () => {
  const error = fail('READ_FAILED', {
    status: 404,
    conversationId: 'private-conversation-id',
    localOperationId: 'private-operation-id',
    sessionCookieValue: 'private-cookie-value',
  });
  assert.deepEqual(publicError(error), { code: 'READ_FAILED', details: { status: 404 } });
});

test('a loaded session alone cannot submit; only the observed identity read can satisfy owner guard', async () => {
  const store = new ProtectedJsonStore({ provider: 'memory' });
  const journalStore = new ProtectedJsonStore({ provider: 'memory' });
  const journal = new OperationJournal({ store: journalStore });
  const registry = capturedRegistry();
  let calls = 0;
  const client = new GrokWebClient({
    registry,
    sessionPersistence: store,
    journal,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(new Headers(init.headers).get('cookie'), 'sid=test-secret-cookie');
      if (String(url).endsWith('/rest/account/me')) return new Response(JSON.stringify({ handle: 'owner' }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('simulated connection loss after submit');
    },
  });
  await client.importSession(validBundle());
  await assert.rejects(client.submit('chat.create', { message: 'private prompt' }, { confirm: true, intentId: 'chat-smoke-1' }), { code: 'OWNER_VERIFICATION_REQUIRED' });
  await assert.rejects(client.submit('chat.create', { message: 'private prompt' }, { intentId: 'chat-smoke-1' }), { code: 'SUBMIT_CONFIRM_REQUIRED' });
  assert.equal(calls, 0);
  await assert.rejects(client.verifyOwner('arbitrary-identity'), { code: 'IDENTITY_MISMATCH' });
  assert.equal((await client.status()).session.ownerVerified, false);
  await client.verifyOwner('owner');
  assert.equal((await client.status()).session.ownerVerified, true);
  const first = await client.submit('chat.create', { message: 'private prompt' }, { confirm: true, intentId: 'chat-smoke-1' }).catch(error => error);
  assert.equal(first.code, 'HTTP_TRANSPORT_FAILED');
  assert.equal(calls, 3); // identity mismatch read, identity match read, one submit attempt
  await assert.rejects(client.submit('chat.create', { message: 'private prompt' }, { confirm: true, intentId: 'chat-smoke-1' }), { code: 'OPERATION_ALREADY_HELD' });
  assert.equal(calls, 3);
  const entries = await journal.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, 'outcome_unknown');
  assert.equal(entries[0].attemptCount, 1);
  const stored = JSON.stringify(await journalStore.read());
  assert.equal(stored.includes('private prompt'), false);
  assert.equal(stored.includes('test-secret-cookie'), false);
});

test('regular submits retain raw response metadata without returning the business body', async () => {
  const rawReply = '{ "id": "fixture-job-42", "privateContent": "response secret" }\n';
  const journal = new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
  let submissions = 0;
  const client = new GrokWebClient({
    registry: capturedRegistry(),
    sessionPersistence: new ProtectedJsonStore({ provider: 'memory' }),
    journal,
    fetchImpl: async url => {
      if (String(url).endsWith('/rest/account/me')) {
        return new Response('{"handle":"owner"}', { headers: { 'content-type': 'application/json' } });
      }
      submissions++;
      return new Response(rawReply, { headers: { 'content-type': 'application/json' } });
    },
  });
  await client.importSession(validBundle());
  await client.verifyOwner('owner');
  const result = await client.submit('chat.create', { message: 'neutral fixture' }, { confirm: true, intentId: 'response-metadata-once' });
  assert.equal(submissions, 1);
  assert.equal(result.sourceDiscoveryReceipt, undefined);
  assert.equal(result.responseReceipt.responseBytes, Buffer.byteLength(rawReply));
  assert.equal(result.responseReceipt.responseDigestKind, 'raw_http_body');
  assert.equal(result.responseReceipt.responseDigest, createHash('sha256').update(rawReply).digest('hex'));
  assert.notEqual(result.responseReceipt.responseDigest, createHash('sha256').update(JSON.stringify(JSON.parse(rawReply))).digest('hex'));
  assert.equal(JSON.stringify(result).includes('response secret'), false);
  assert.equal(JSON.stringify(result).includes('fixture-job-42'), false);
  assert.equal(result.responseReceipt.trustEnv, null);
  await client.clearSession();
});

test('source discovery is consumed per owner intent and never retries an unknown intent across clients', async () => {
  const registry = capturedRegistry();
  const operation = registry.operations.find(item => item.id === 'chat.create');
  operation.evidence = {
    ...operation.evidence,
    source: 'first_party_sdk_contract', httpStatus: null, responseContentType: 'unknown',
    securityBoundary: 'not_applicable', sourceUrl: 'https://cdn.grok.com/_next/static/chunks/fixture.js',
    sourceSha256: 'a'.repeat(64), sourceFunctionName: 'fixtureSdkCreateRaw', firstLiveReplayPermit: true,
    sourceDeclaredHeaders: ['Content-Type'], browserWriteCapture: false, browserHeadersCaptured: false,
    clientCallsiteFabricated: false, directReplayReceipt: 'verification/fixture-source-replay.json',
  };
  const journal = new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
  let wireAttempts = 0;
  const makeClient = async identity => {
    const client = new GrokWebClient({ registry, journal,
      sessionPersistence: new ProtectedJsonStore({ provider: 'memory' }),
      fetchImpl: async url => {
        if (String(url).endsWith('/rest/account/me')) {
          return new Response(JSON.stringify({ handle: identity }), { headers: { 'content-type': 'application/json' } });
        }
        wireAttempts++;
        if (wireAttempts === 1) throw new Error('connection lost after request');
        return new Response('{"id":"fixture-resource-42"}', { headers: { 'content-type': 'application/json' } });
      },
    });
    await client.importSession(validBundle());
    await client.verifyOwner(identity);
    return client;
  };
  const first = await makeClient('owner');
  const options = { confirm: true, intentId: 'sdk-intent-unknown', sourceDiscoveryPermit: 'first-live:chat.create' };
  await assert.rejects(first.submit('chat.create', { message: 'first task' }, options), { code: 'HTTP_TRANSPORT_FAILED' });
  await assert.rejects(first.submit('chat.create', { message: 'changed serialization' }, options), {
    code: 'SOURCE_DISCOVERY_PERMIT_ALREADY_USED',
  });
  const restarted = await makeClient('owner');
  await assert.rejects(restarted.submit('chat.create', { message: 'another serialization' }, options), {
    code: 'SOURCE_DISCOVERY_PERMIT_ALREADY_USED',
  });
  assert.equal(wireAttempts, 1);
  const distinct = await restarted.submit('chat.create', { message: 'separate task' }, {
    ...options, intentId: 'sdk-intent-separate-task',
  });
  assert.equal(distinct.httpStatus, 200);
  assert.equal(wireAttempts, 2);
  const otherOwner = await makeClient('other-owner');
  const separatelyOwned = await otherOwner.submit('chat.create', { message: 'other owner task' }, options);
  assert.equal(separatelyOwned.httpStatus, 200);
  assert.equal(wireAttempts, 3);
  const entries = await journal.list();
  assert.equal(entries.length, 3);
  assert.equal(entries[0].state, 'outcome_unknown');
  assert.ok(entries.every(entry => entry.attemptCount === 1));
  assert.equal(new Set(entries.map(entry => entry.intentDigest)).size, 3);
});

test('read transport flags retain false, true and unknown values without inversion', async () => {
  for (const flags of [false, true, undefined]) {
    const client = new GrokWebClient({ registry: capturedRegistry(),
      sessionPersistence: new ProtectedJsonStore({ provider: 'memory' }),
      fetchImpl: async () => {
        const response = new Response('{"handle":"owner"}', { headers: { 'content-type': 'application/json' } });
        Object.defineProperty(response, 'transportEvidence', { value: {
          tlsVerified: true, httpVersion: 'h2', explicitRetries: 0,
          ...(flags !== undefined ? { trustEnv: flags, redirectsFollowed: flags } : {}),
        } });
        return response;
      },
    });
    await client.importSession(validBundle());
    await client.verifyOwner('owner');
    const result = await client.read('identity.read');
    assert.equal(result.transportEvidence.trustEnv, flags ?? null);
    assert.equal(result.transportEvidence.redirectsFollowed, flags ?? null);
    await client.clearSession();
  }
});

test('direct attachment response receipt preserves only the helper-verified streamed multipart byte count and digest', async () => {
  const registry = await loadContractRegistry();
  const direct = registry.operations.find(item => item.id === 'attachment.upload.direct');
  const identity = registry.operations.find(item => item.id === registry.identityOperationId);
  assert.ok(direct);
  assert.ok(identity?.identityJsonPointer);
  const multipart = Buffer.from('--GrokWebAttachmentUploadV2Boundary\r\nfixture-neutral-body\r\n--GrokWebAttachmentUploadV2Boundary--\r\n', 'utf8');
  const multipartBase64 = multipart.toString('base64');
  const multipartSha256 = createHash('sha256').update(multipart).digest('hex');
  let submits = 0;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === new URL(identity.urlTemplate).pathname) {
      const result = {};
      const parts = identity.identityJsonPointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
      let current = result;
      for (const part of parts.slice(0, -1)) current = current[part] ??= {};
      current[parts.at(-1)] = 'owner';
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(parsed.pathname, new URL(direct.urlTemplate).pathname);
    assert.equal(init.method, 'POST');
    assert.deepEqual(Buffer.from(init.body), multipart);
    submits++;
    const response = new Response('{"fileMetadata":{}}', { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'transportEvidence', { value: {
      httpVersion: 'h2', tlsVerified: true, trustEnv: false, redirectsFollowed: false, explicitRetries: 0,
      requestHeaderNames: ['content-length', 'content-type', 'cookie', 'origin', 'referer'],
      cookieNamesPrepared: ['sso'],
      requestMeta: { bodyBytes: multipart.length, bodySha256: multipartSha256, bodyMode: 'private_file_stream' },
      privateTempBodyCleanup: 'removed',
    } });
    return response;
  };
  const journal = new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
  const sessionPersistence = new ProtectedJsonStore({ provider: 'memory' });
  const client = new GrokWebClient({ registry, journal, sessionPersistence, fetchImpl });
  const bundle = validBundle();
  bundle.origins[0].cookies[0] = { name: 'sso', value: 'test-sso-cookie', origin: 'https://grok.com', domain: '.grok.com', path: '/', secure: true, httpOnly: true };
  await client.importSession(bundle);
  await client.verifyOwner('owner');
  const result = await client.submit('attachment.upload.direct', { multipartBodyBase64: multipartBase64 }, {
    confirm: true, intentId: 'attachment-response-body-receipt-once',
  });
  assert.equal(submits, 1);
  assert.equal(result.responseReceipt.requestBodyBytes, multipart.length);
  assert.equal(result.responseReceipt.requestBodySha256, multipartSha256);
  assert.equal(result.responseReceipt.requestBodyMode, 'private_file_stream');
  assert.equal(result.responseReceipt.privateTempBodyCleanup, 'removed');
  assert.equal(JSON.stringify(result.responseReceipt).includes(multipartBase64), false);
  assert.equal(JSON.stringify(result.responseReceipt).includes('test-sso-cookie'), false);
  multipart.fill(0);
  await client.clearSession();
});

test('submit checkpoints safe response metadata before journal transition and preserves the private response handle on transition failure', async () => {
  const rawReply = '{"id":"fixture-job-42","privateContent":"response secret"}';
  const journal = new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
  const events = [];
  let submissions = 0;
  let checkpoint;
  const originalTransition = journal.transition.bind(journal);
  journal.transition = async (localOperationId, state, options) => {
    const entry = await journal.get(localOperationId);
    if (entry?.contractId === 'chat.create' && state === 'accepted') {
      events.push('journal-transition');
      throw fail('INJECTED_JOURNAL_TRANSITION_FAILURE');
    }
    return originalTransition(localOperationId, state, options);
  };
  const client = new GrokWebClient({
    registry: capturedRegistry(),
    sessionPersistence: new ProtectedJsonStore({ provider: 'memory' }),
    journal,
    fetchImpl: async url => {
      if (String(url).endsWith('/rest/account/me')) {
        return new Response('{"handle":"owner"}', { headers: { 'content-type': 'application/json' } });
      }
      submissions++;
      return new Response(rawReply, { headers: { 'content-type': 'application/json' } });
    },
  });
  await client.importSession(validBundle());
  await client.verifyOwner('owner');

  const result = await client.submit('chat.create', { message: 'neutral fixture' }, {
    confirm: true,
    intentId: 'response-checkpoint-transition-failure',
    retainResponseInMemory: true,
    onResponseCheckpoint: async value => {
      events.push('response-checkpoint');
      checkpoint = value;
    },
  });

  assert.deepEqual(events, ['response-checkpoint', 'journal-transition']);
  assert.equal(result.state, 'response_observed');
  assert.equal(result.responseReturned, true);
  assert.equal(result.jobIdObserved, true);
  assert.deepEqual(result.responseCheckpoint, { state: 'stored' });
  assert.deepEqual(result.journalPersistence, {
    state: 'failed', errorCode: 'JOURNAL_TRANSITION_FAILED', businessRetryAllowed: false,
  });
  assert.equal(result.businessRetryAllowed, false);
  assert.equal(checkpoint.operationId, 'chat.create');
  assert.equal(checkpoint.localOperationId, result.localOperationId);
  assert.equal(checkpoint.requestDigest, result.responseReceipt.requestDigest);
  assert.equal(checkpoint.intentDigest, result.responseReceipt.intentDigest);
  assert.equal(checkpoint.serviceJobIdObserved, true);
  assert.equal(checkpoint.responseReceipt.responseStatus, 200);
  assert.equal(checkpoint.responseReceipt.responseDigest, createHash('sha256').update(rawReply).digest('hex'));
  assert.equal(Object.isFrozen(checkpoint), true);
  assert.equal(Object.isFrozen(checkpoint.responseReceipt), true);
  assert.equal(JSON.stringify(checkpoint).includes('fixture-job-42'), false);
  assert.equal(JSON.stringify(checkpoint).includes('response secret'), false);
  assert.equal(JSON.stringify(result).includes('fixture-job-42'), false);
  assert.equal(JSON.stringify(result).includes('response secret'), false);
  assert.deepEqual(await client.getInMemoryPrivateResponse(result.localOperationId), JSON.parse(rawReply));

  const entry = await journal.get(result.localOperationId);
  assert.equal(entry.state, 'sending');
  assert.equal(entry.attemptCount, 1);
  await assert.rejects(client.submit('chat.create', { message: 'neutral fixture' }, {
    confirm: true, intentId: 'response-checkpoint-transition-failure', retainResponseInMemory: true,
  }), { code: 'OPERATION_ALREADY_HELD' });
  assert.equal(submissions, 1);
  await client.clearInMemoryPrivateResponse(result.localOperationId);
  await client.clearSession();
});

test('response checkpoint failure returns observed metadata and does not transition or retry the known response', async () => {
  const rawReply = '{"id":"fixture-job-43","privateContent":"response secret"}';
  const journal = new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
  const originalTransition = journal.transition.bind(journal);
  let transitionCount = 0;
  let submissions = 0;
  journal.transition = async (...args) => {
    transitionCount++;
    return originalTransition(...args);
  };
  const client = new GrokWebClient({
    registry: capturedRegistry(),
    sessionPersistence: new ProtectedJsonStore({ provider: 'memory' }),
    journal,
    fetchImpl: async url => {
      if (String(url).endsWith('/rest/account/me')) {
        return new Response('{"handle":"owner"}', { headers: { 'content-type': 'application/json' } });
      }
      submissions++;
      return new Response(rawReply, { headers: { 'content-type': 'application/json' } });
    },
  });
  await client.importSession(validBundle());
  await client.verifyOwner('owner');

  const result = await client.submit('chat.create', { message: 'neutral fixture' }, {
    confirm: true,
    intentId: 'response-checkpoint-failure',
    retainResponseInMemory: true,
    onResponseCheckpoint: async () => { throw fail('INJECTED_CHECKPOINT_FAILURE', { privateContent: 'never returned' }); },
  });

  assert.equal(result.state, 'response_observed');
  assert.deepEqual(result.responseCheckpoint, { state: 'failed', errorCode: 'RESPONSE_CHECKPOINT_FAILED', businessRetryAllowed: false });
  assert.deepEqual(result.journalPersistence, { state: 'not_attempted', errorCode: 'RESPONSE_CHECKPOINT_FAILED', businessRetryAllowed: false });
  assert.equal(result.responseReceipt.responseStatus, 200);
  assert.equal(JSON.stringify(result).includes('fixture-job-43'), false);
  assert.equal(JSON.stringify(result).includes('response secret'), false);
  assert.deepEqual(await client.getInMemoryPrivateResponse(result.localOperationId), JSON.parse(rawReply));
  assert.equal((await journal.get(result.localOperationId)).state, 'sending');
  assert.equal(transitionCount, 0);
  await assert.rejects(client.submit('chat.create', { message: 'neutral fixture' }, {
    confirm: true, intentId: 'response-checkpoint-failure', retainResponseInMemory: true,
  }), { code: 'OPERATION_ALREADY_HELD' });
  assert.equal(submissions, 1);
  await client.clearInMemoryPrivateResponse(result.localOperationId);
  await client.clearSession();
});

test('submit binds request credentials and idempotency digest to one loaded owner snapshot during account replacement', async () => {
  const snapshotA = await verifiedSessionSnapshot('owner-a', 'owner-a-session');
  const snapshotB = await verifiedSessionSnapshot('owner-b', 'owner-b-session');
  const digestA = snapshotA.session.ownerBinding.identityDigest;
  const digestB = snapshotB.session.ownerBinding.identityDigest;
  assert.notEqual(digestA, digestB);

  const sessionPersistence = new SessionSnapshotSwapStore(snapshotA, snapshotB);
  sessionPersistence.swapOnNextRead = true;
  const journal = new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
  const requestCookies = [];
  const client = new GrokWebClient({
    registry: capturedRegistry(),
    sessionPersistence,
    journal,
    fetchImpl: async (url, init) => {
      requestCookies.push(new Headers(init.headers).get('cookie'));
      assert.equal(String(url), 'https://grok.com/rest/app-chat/test');
      return new Response('{"id":"fixture-job-owner-a"}', { headers: { 'content-type': 'application/json' } });
    },
  });

  const result = await client.submit('chat.create', { message: 'neutral fixture' }, {
    confirm: true,
    intentId: 'session-snapshot-race',
    expectedOwnerScopeSha256: digestA,
  });

  assert.equal(result.state, 'accepted');
  assert.equal(sessionPersistence.readCount, 1);
  assert.equal(sessionPersistence.current.session.ownerBinding.identityDigest, digestB);
  assert.deepEqual(requestCookies, ['sid=owner-a-session']);
  const [entry] = await journal.list();
  assert.equal(entry.intentDigest, createHash('sha256')
    .update(`chat.create\n${digestA}\nsession-snapshot-race`, 'utf8').digest('hex'));
  assert.equal(entry.intentDigest === createHash('sha256')
    .update(`chat.create\n${digestB}\nsession-snapshot-race`, 'utf8').digest('hex'), false);
  await client.clearSession();
});

test('read and submit reject an explicit expected owner scope mismatch before transport', async () => {
  const snapshotA = await verifiedSessionSnapshot('owner-a', 'owner-a-session');
  const snapshotB = await verifiedSessionSnapshot('owner-b', 'owner-b-session');
  const digestB = snapshotB.session.ownerBinding.identityDigest;
  for (const method of ['read', 'submit']) {
    const sessionPersistence = new SessionSnapshotSwapStore(snapshotA, snapshotB);
    sessionPersistence.swapOnNextRead = true;
    const journal = new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
    let requests = 0;
    const client = new GrokWebClient({
      registry: capturedRegistry(),
      sessionPersistence,
      journal,
      fetchImpl: async () => { requests++; return new Response('{}', { headers: { 'content-type': 'application/json' } }); },
    });
    if (method === 'read') {
      await assert.rejects(client.read('identity.read', {}, { expectedOwnerScopeSha256: digestB }), { code: 'OWNER_SCOPE_MISMATCH' });
    } else {
      await assert.rejects(client.submit('chat.create', { message: 'neutral fixture' }, {
        confirm: true, intentId: `wrong-owner-scope-${method}`, expectedOwnerScopeSha256: digestB,
      }), { code: 'OWNER_SCOPE_MISMATCH' });
    }
    assert.equal(requests, 0);
    assert.equal(sessionPersistence.readCount, 1);
    assert.equal((await journal.list()).length, 0);
  }
});

test('stream parsers handle chunk boundaries without persisting the response', async () => {
  const sse = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('id: 7\nevent: token\ndata: {"value":'));
      controller.enqueue(new TextEncoder().encode('"ok"}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
  assert.deepEqual(await collectStream(sse, 'sse'), [{ event: 'token', id: '7', data: { value: 'ok' } }]);
  const ndjson = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"a":'));
      controller.enqueue(new TextEncoder().encode('1}\n{"b":2}\n'));
      controller.close();
    },
  });
  assert.deepEqual(await collectStream(ndjson, 'ndjson'), [{ a: 1 }, { b: 2 }]);
});

test('journal holds an uncertain mutation digest and stores only digests and metadata', async () => {
  const store = new ProtectedJsonStore({ provider: 'memory' });
  const journal = new OperationJournal({ store });
  const secretBody = 'prompt that must never be stored';
  const requestDigest = createHash('sha256').update(secretBody).digest('hex');
  const entry = await journal.begin({ contractId: 'chat.create', requestDigest });
  await journal.transition(entry.localOperationId, 'outcome_unknown', { serviceJobId: 'sensitive-service-job-id', reasonCode: 'HTTP_TRANSPORT_FAILED' });
  await assert.rejects(journal.begin({ contractId: 'chat.create', requestDigest }), { code: 'OPERATION_ALREADY_HELD' });
  const serialized = JSON.stringify(await store.read());
  assert.equal(serialized.includes(secretBody), false);
  assert.equal(serialized.includes('sensitive-service-job-id'), false);
  assert.equal(serialized.includes(requestDigest), true);
});

test('a completed semantic intent cannot dispatch again when per-action request bytes change', async () => {
  const journal = new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
  const intentDigest = createHash('sha256').update('chat.text.wss\nowner\nprotocol-intent-v1').digest('hex');
  const first = await journal.begin({ contractId: 'chat.text.wss', requestDigest: 'a'.repeat(64), intentDigest });
  await journal.transition(first.localOperationId, 'accepted', { httpStatus: 101 });
  await journal.transition(first.localOperationId, 'completed', {
    httpStatus: 101, reasonCode: 'TEXT_WSS_READBACK_VERIFIED', reconciledBy: 'history.load-responses',
  });

  await assert.rejects(journal.begin({
    contractId: 'chat.text.wss',
    requestDigest: 'b'.repeat(64),
    intentDigest,
  }), { code: 'OPERATION_ALREADY_COMPLETED' });
  assert.equal((await journal.list()).length, 1);
});

test('intent journal blocks a repeated caller intent even when request serialization changes', async () => {
  const journal = new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
  const intentDigest = createHash('sha256').update('owner\nchat.create\nintent-17').digest('hex');
  const entry = await journal.begin({ contractId: 'chat.create', requestDigest: 'a'.repeat(64), intentDigest });
  await journal.transition(entry.localOperationId, 'outcome_unknown', { reasonCode: 'HTTP_TRANSPORT_FAILED' });
  await assert.rejects(journal.begin({ contractId: 'chat.create', requestDigest: 'b'.repeat(64), intentDigest }), { code: 'OPERATION_ALREADY_HELD' });
});

test('parallel journal begins serialize the hold check and admit one matching digest', async () => {
  const journal = new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
  const requestDigest = createHash('sha256').update('same logical request').digest('hex');
  const outcomes = await Promise.allSettled(Array.from({ length: 16 }, () => journal.begin({ contractId: 'chat.create', requestDigest })));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected' && result.reason.code === 'OPERATION_ALREADY_HELD').length, 15);
  assert.equal((await journal.list()).length, 1);
});

test('media validation checks signatures and rejects short GIF headers and HTML', () => {
  assert.throws(() => validateMediaPrefix(Buffer.from('GIF89a'), 'image/gif'), { code: 'MEDIA_SIGNATURE_MISMATCH' });
  const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
  assert.equal(validateMediaPrefix(gif, 'image/gif').width, 1);
  assert.throws(() => validateMediaPrefix(Buffer.from('<html>login</html>'), 'image/png'), { code: 'MEDIA_SIGNATURE_MISMATCH' });
});

test('validated media download bounds bytes and writes a sanitized local filename', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grok-media-test-'));
  try {
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(4, 16);
    png.writeUInt32BE(3, 20);
    const result = await downloadValidatedMedia(new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
    }), {
      outputDir: directory,
      suggestedName: '../unsafe\\result',
      allowedMimeTypes: ['image/png'],
      maxBytes: 1024,
    });
    assert.equal(path.dirname(result.path), directory);
    assert.match(path.basename(result.path), /^-unsafe-result-[a-f0-9-]+\.png$/);
    assert.deepEqual(await readFile(result.path), png);
    assert.equal(result.bytes, png.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
