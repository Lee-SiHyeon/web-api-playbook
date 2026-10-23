import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContractRegistry, findOperation, operationReadiness } from './contracts.mjs';
import { fail } from './errors.mjs';
import { OperationJournal } from './journal.mjs';
import { downloadValidatedMedia } from './media.mjs';
import { downloadValidatedFile, isFileDownloadMimeType } from './file-download.mjs';
import { readJsonPointer } from './json-pointer.mjs';
import { ProtectedJsonStore } from './protected-json-store.mjs';
import { GrokSessionStore } from './session.mjs';
import { renewGrokSession } from './grok-session-renewal.mjs';
import { collectStream } from './streaming.mjs';
import { createRequestDigest, ObservedHttpTransport } from './transport.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWNER_SCOPE_SHA256_PATTERN = /^[a-f0-9]{64}$/;

function validateExpectedOwnerScopeSha256(value) {
  if (value !== undefined && (typeof value !== 'string' || !OWNER_SCOPE_SHA256_PATTERN.test(value))) {
    throw fail('OWNER_SCOPE_DIGEST_INVALID');
  }
}

function verifiedOwnerDigestFromSnapshot(session) {
  if (!session || typeof session.generation !== 'string' || !session.generation
    || session.ownerBinding?.generation !== session.generation) return null;
  const digest = session.ownerBinding.identityDigest;
  return typeof digest === 'string' && OWNER_SCOPE_SHA256_PATTERN.test(digest) ? digest : null;
}

function requireExpectedOwnerScope(expectedOwnerScopeSha256, snapshotDigest) {
  if (!snapshotDigest) throw fail('OWNER_VERIFICATION_REQUIRED');
  if (expectedOwnerScopeSha256 !== undefined && snapshotDigest !== expectedOwnerScopeSha256) {
    throw fail('OWNER_SCOPE_MISMATCH');
  }
  return snapshotDigest;
}

export async function loadContractRegistry(filePath = path.resolve(HERE, '../contracts/grok-web.v1.json')) {
  let text;
  try { text = await readFile(filePath, 'utf8'); } catch { throw fail('CONTRACT_REGISTRY_READ_FAILED'); }
  let registry;
  try { registry = JSON.parse(text); } catch { throw fail('CONTRACT_REGISTRY_JSON_INVALID'); }
  return validateContractRegistry(registry);
}

function responseData(result, operation) {
  if (result.data !== undefined) return result.data;
  return collectStream(result.stream, operation.response.mode);
}

export function readinessMatrix(registry) {
  registry = validateContractRegistry(registry);
  const statuses = registry.operations.map(operation => {
    const readiness = operationReadiness(operation);
    return {
      operationId: operation.id,
      kind: operation.kind,
      ready: readiness.ready,
      reason: readiness.reason,
      sourceDerived: readiness.sourceDerived === true,
      browserCapture: readiness.browserCapture === true,
      directReadVerified: readiness.directReadVerified === true,
      directReplayVerified: readiness.directReplayVerified === true,
    };
  });
  const has = predicate => registry.operations.some(operation => predicate(operation) && operationReadiness(operation).ready);
  return {
    operations: statuses,
    capabilities: {
      publicModels: {
        captured: false,
        clientExists: has(operation => operation.id === 'public.models'),
        credentialPropagation: 'not_applicable',
        directReadVerified: has(operation => operation.id === 'public.models'),
        liveReplay: false,
      },
      textGeneration: {
        captured: has(operation => operation.effect === 'chat_write' && operation.id.startsWith('chat.')
          && operation.evidence.source === 'browser_network_capture'),
        clientExists: has(operation => operation.effect === 'chat_write' && operation.id.startsWith('chat.')),
        liveReplay: false,
      },
      history: { captured: has(operation => operation.kind === 'poll' || operation.id.includes('history')), clientExists: has(operation => operation.kind === 'poll' || operation.id.includes('history')), liveReplay: false },
      imageGeneration: { captured: has(operation => operation.effect === 'image_generation'), clientExists: has(operation => operation.effect === 'image_generation'), liveReplay: false },
      videoGeneration: { captured: has(operation => operation.effect === 'video_generation'), clientExists: has(operation => operation.effect === 'video_generation'), liveReplay: false },
      workspaceManagement: {
        captured: false,
        sourceDerived: has(operation => operation.effect === 'workspace_management'),
        browserCapture: false,
        clientExists: has(operation => operation.effect === 'workspace_management'),
        directReplayVerified: has(operation => operation.effect === 'workspace_management'
          && operation.evidence?.source === 'first_party_bundle_contract'),
        liveReplay: has(operation => operation.effect === 'workspace_management'
          && operation.evidence?.directReplay?.status === 200),
      },
    },
  };
}

export class GrokWebClient {
  #registry;
  #sessionStore;
  #journal;
  #transport;
  #fetch;
  #ownerBindingToken;
  #serviceJobIds = new Map();
  #privateResponses = new Map();
  #sourceDiscoveryConsumed = new Set();

  constructor({ registry, sessionPersistence, journal, transport, fetchImpl, timeoutMs } = {}) {
    this.#registry = validateContractRegistry(registry);
    this.#ownerBindingToken = randomBytes(32).toString('hex');
    const defaultSessionPersistence = sessionPersistence ?? new ProtectedJsonStore({
      provider: process.platform === 'win32' ? 'dpapi' : 'memory',
    });
    this.#sessionStore = new GrokSessionStore({ store: defaultSessionPersistence, ownerBindingToken: this.#ownerBindingToken });
    this.#journal = journal ?? new OperationJournal();
    this.#fetch = fetchImpl ?? globalThis.fetch;
    this.#transport = transport ?? new ObservedHttpTransport({
      registry: this.#registry,
      sessionStore: this.#sessionStore,
      fetchImpl: this.#fetch,
      timeoutMs,
    });
  }

  async status() {
    const [session, journalEntries] = await Promise.all([this.#sessionStore.status(), this.#journal.list()]);
    return {
      serviceId: 'grok-web',
      session,
      readiness: readinessMatrix(this.#registry),
      journal: {
        entries: journalEntries.length,
        held: journalEntries.filter(item => ['sending', 'accepted', 'outcome_unknown', 'processing', 'needs_review'].includes(item.state)).length,
      },
    };
  }

  readiness() {
    return readinessMatrix(this.#registry);
  }

  async importSession(bundle, options) {
    return this.#sessionStore.importBundle(bundle, options);
  }

  async renewSession({ expectedIdentity, acquireSession, timeoutMs } = {}) {
    return renewGrokSession({ registry: this.#registry, sessionStore: this.#sessionStore,
      ownerBindingToken: this.#ownerBindingToken, expectedIdentity, acquireSession,
      fetchImpl: this.#fetch, timeoutMs });
  }

  async clearSession() {
    this.#serviceJobIds.clear();
    this.#privateResponses.clear();
    return this.#sessionStore.clear();
  }

  async read(operationId, input = {}, { signal, sourceDiscoveryPermit = null, expectedOwnerScopeSha256 } = {}) {
    const operation = findOperation(this.#registry, operationId);
    if (!['read', 'poll'].includes(operation.kind)) throw fail('OPERATION_KIND_NOT_READABLE');
    validateExpectedOwnerScopeSha256(expectedOwnerScopeSha256);
    const readiness = operationReadiness(operation);
    const sourceReadEligible = sourceDiscoveryPermit === `first-read:${operation.id}`
      && operation.kind === 'read'
      && operation.evidence?.source === 'first_party_sdk_contract'
      && operation.evidence.firstLiveReadPermit === true
      && !operation.evidence.directReplay;
    if (!readiness.ready && !sourceReadEligible) throw fail(readiness.reason);
    const sessionSnapshot = operation.authMode === 'session' || expectedOwnerScopeSha256 !== undefined
      ? await this.#sessionStore.load() : null;
    if (expectedOwnerScopeSha256 !== undefined) {
      requireExpectedOwnerScope(expectedOwnerScopeSha256, verifiedOwnerDigestFromSnapshot(sessionSnapshot));
    }
    const session = operation.authMode === 'session' ? sessionSnapshot : null;
    const result = await this.#transport.request(operation, input, { session, signal, sourceDiscoveryPermit });
    const data = await responseData(result, operation);
    return {
      status: result.status,
      contentType: result.contentType,
      responseBytes: result.responseBytes ?? null,
      data,
      requestDigest: result.prepared.requestDigest,
      responseDigest: createHash('sha256').update(JSON.stringify(data), 'utf8').digest('hex'),
      rawResponseDigest: result.rawResponseDigest ?? null,
      rawResponseDigestKind: result.rawResponseDigest ? 'raw_http_body' : null,
      transportEvidence: result.transportEvidence ? {
        httpVersion: result.transportEvidence.httpVersion ?? null,
        profile: result.transportEvidence.profile ?? null,
        tlsVerified: result.transportEvidence.tlsVerified === true,
        trustEnv: typeof result.transportEvidence.trustEnv === 'boolean'
          ? result.transportEvidence.trustEnv : null,
        redirectsFollowed: typeof result.transportEvidence.redirectsFollowed === 'boolean'
          ? result.transportEvidence.redirectsFollowed : null,
        explicitRetries: Number.isInteger(result.transportEvidence.explicitRetries)
          ? result.transportEvidence.explicitRetries : null,
        requestHeaderNames: Array.isArray(result.transportEvidence.requestHeaderNames)
          ? result.transportEvidence.requestHeaderNames.filter(name => typeof name === 'string') : [],
        cookieNames: Array.isArray(result.transportEvidence.cookieNamesPrepared)
          ? result.transportEvidence.cookieNamesPrepared.filter(name => typeof name === 'string') : [],
      } : null,
      readiness: sourceReadEligible
        ? { ready: true, reason: null, sourceDerived: true, browserCapture: false,
          directReadVerified: true, directReplayVerified: true }
        : readiness,
    };
  }

  async verifyOwner(expectedIdentity, input = {}) {
    const operationId = this.#registry.identityOperationId;
    if (!operationId || typeof expectedIdentity !== 'string' || !expectedIdentity.trim()) {
      throw fail('IDENTITY_OPERATION_UNAVAILABLE');
    }
    const operation = findOperation(this.#registry, operationId);
    if (operation.role !== 'identity' || operation.kind !== 'read'
      || operation.evidence.source !== 'browser_network_capture' || !operationReadiness(operation).ready) {
      throw fail('IDENTITY_CONTRACT_NOT_CAPTURED');
    }
    const verificationSession = await this.#sessionStore.load();
    const result = await this.read(operationId, input);
    const identity = readJsonPointer(result.data, operation.identityJsonPointer);
    if (typeof identity !== 'string' || identity !== expectedIdentity) throw fail('IDENTITY_MISMATCH');
    const identityDigest = createHash('sha256').update(identity, 'utf8').digest('hex');
    const binding = await this.#sessionStore.bindVerifiedOwner(this.#ownerBindingToken, {
      operationId,
      httpStatus: result.status,
      identityMatched: true,
      identityDigest,
      expectedGeneration: verificationSession.generation,
    });
    return {
      ...binding,
      httpStatus: result.status,
      contentType: result.contentType,
      responseBytes: result.responseBytes ?? null,
      requestDigest: result.requestDigest,
      responseDigest: result.responseDigest,
      rawResponseDigest: result.rawResponseDigest ?? null,
      rawResponseDigestKind: result.rawResponseDigestKind ?? null,
    };
  }

  async submit(operationId, input = {}, { signal, confirm, intentId, requestMetadataHeaders = {}, sourceDiscoveryPermit = null,
    retainResponseInMemory = false, onResponseCheckpoint, expectedOwnerScopeSha256 } = {}) {
    const operation = findOperation(this.#registry, operationId);
    if (operation.kind !== 'submit') throw fail('OPERATION_KIND_NOT_SUBMITTABLE');
    const readiness = operationReadiness(operation);
    const expectedSourceDiscoveryPermit = `first-live:${operation.id}`;
    if (sourceDiscoveryPermit !== null && sourceDiscoveryPermit !== expectedSourceDiscoveryPermit) {
      throw fail('SOURCE_DISCOVERY_PERMIT_INVALID');
    }
    const sourceDiscoveryCandidate = sourceDiscoveryPermit === expectedSourceDiscoveryPermit
      && operation.evidence?.source === 'first_party_sdk_contract'
      && operation.evidence.firstLiveReplayPermit === true
      && !operation.evidence.directReplay;
    if (!readiness.ready && !sourceDiscoveryCandidate) throw fail(readiness.reason);
    if (confirm !== true) throw fail('SUBMIT_CONFIRM_REQUIRED');
    if (typeof retainResponseInMemory !== 'boolean') throw fail('SUBMIT_PRIVATE_RESPONSE_OPTION_INVALID');
    if (onResponseCheckpoint !== undefined && typeof onResponseCheckpoint !== 'function') {
      throw fail('SUBMIT_RESPONSE_CHECKPOINT_INVALID');
    }
    validateExpectedOwnerScopeSha256(expectedOwnerScopeSha256);
    if (typeof intentId !== 'string' || !intentId.trim() || intentId.length > 256 || /[\r\n\0]/.test(intentId)) {
      throw fail('SUBMIT_INTENT_ID_REQUIRED');
    }
    // Bind both credentials and the idempotency digest to one immutable owner
    // snapshot. Separate status/digest reads can straddle a session rotation.
    let sessionSnapshot;
    try { sessionSnapshot = await this.#sessionStore.load(); }
    catch (error) {
      // Preserve the prior public-submit error for an authMode:none operation:
      // submit still requires a verified owner scope even without session auth.
      if (operation.authMode === 'none' && error?.code === 'SESSION_NOT_AVAILABLE') {
        throw fail('OWNER_VERIFICATION_REQUIRED');
      }
      throw error;
    }
    const ownerIdentityDigest = requireExpectedOwnerScope(expectedOwnerScopeSha256,
      verifiedOwnerDigestFromSnapshot(sessionSnapshot));
    const session = operation.authMode === 'session' ? sessionSnapshot : null;
    const intentDigest = createHash('sha256')
      .update(`${operation.id}\n${ownerIdentityDigest}\n${intentId.trim()}`, 'utf8')
      .digest('hex');
    // A discovery permit authorizes one confirmed semantic intent under this
    // owner. Earlier unrelated tasks must not consume the operation forever.
    // The durable journal still blocks the same intent after an unknown or
    // completed dispatch, even if the caller changes its serialized body.
    const sourceDiscoveryAttemptExists = sourceDiscoveryCandidate
      && (await this.#journal.list()).some(entry => entry.contractId === operation.id
        && entry.intentDigest === intentDigest);
    const sourceDiscoveryEligible = sourceDiscoveryCandidate && !sourceDiscoveryAttemptExists
      && !this.#sourceDiscoveryConsumed.has(intentDigest);
    if (!readiness.ready && !sourceDiscoveryEligible) throw fail('SOURCE_DISCOVERY_PERMIT_ALREADY_USED');
    const prepared = this.#transport.prepare(operation, input, session, requestMetadataHeaders, {
      sourceDiscoveryPermit: sourceDiscoveryEligible ? expectedSourceDiscoveryPermit : null,
    });
    const journalEntry = await this.#journal.begin({ contractId: operation.id, requestDigest: prepared.requestDigest, intentDigest });
    if (sourceDiscoveryEligible) this.#sourceDiscoveryConsumed.add(intentDigest);
    let result;
    try {
      result = await this.#transport.request(operation, input, {
        session, signal, prepared,
        sourceDiscoveryPermit: sourceDiscoveryEligible ? expectedSourceDiscoveryPermit : null,
      });
    } catch (error) {
      const state = error?.code === 'SECURITY_CHALLENGE_BLOCKED' ? 'blocked_security_boundary' : 'outcome_unknown';
      await this.#journal.transition(journalEntry.localOperationId, state, {
        httpStatus: Number.isInteger(error?.details?.status) ? error.details.status : null,
        reasonCode: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'HTTP_TRANSPORT_FAILED',
      });
      throw error;
    }

    let data;
    try {
      data = await responseData(result, operation);
    } catch {
      await this.#journal.transition(journalEntry.localOperationId, 'needs_review', {
        httpStatus: result.status,
        reasonCode: 'RESPONSE_PARSE_FAILED',
      });
      throw fail('SUBMIT_RESPONSE_UNREADABLE');
    }
    let serviceJobId = null;
    if (operation.responseJobIdPointer) {
      try { serviceJobId = readJsonPointer(data, operation.responseJobIdPointer); } catch { serviceJobId = null; }
      if (typeof serviceJobId !== 'string' || !serviceJobId || serviceJobId.length > 512) serviceJobId = null;
    }
    if (serviceJobId) this.#serviceJobIds.set(journalEntry.localOperationId, serviceJobId);
    if (retainResponseInMemory) this.#privateResponses.set(journalEntry.localOperationId, data);

    // Build the safe receipt while the response is available and before the
    // journal transition. A caller can durably checkpoint this metadata and
    // the local handle without receiving the response body or server IDs.
    const responseReceipt = Object.freeze({
      operationId: operation.id,
      observedAt: new Date().toISOString(),
      method: operation.method,
      requestDigest: prepared.requestDigest,
      intentDigest,
      responseStatus: result.status,
      responseContentType: result.contentType,
      responseBytes: result.responseBytes ?? null,
      responseDigest: result.rawResponseDigest ?? createHash('sha256').update(JSON.stringify(data), 'utf8').digest('hex'),
      responseDigestKind: result.rawResponseDigest ? 'raw_http_body' : 'parsed_json_data',
      responseTopLevelFieldNames: Object.freeze(data && typeof data === 'object' && !Array.isArray(data)
        ? Object.keys(data).filter(name => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)).sort().slice(0, 100) : []),
      ...(operation.id === 'attachment.upload.direct' && Number.isSafeInteger(result.transportEvidence?.requestMeta?.bodyBytes)
        ? { requestBodyBytes: result.transportEvidence.requestMeta.bodyBytes } : {}),
      ...(operation.id === 'attachment.upload.direct' && typeof result.transportEvidence?.requestMeta?.bodySha256 === 'string'
        && /^[a-f0-9]{64}$/.test(result.transportEvidence.requestMeta.bodySha256)
        ? { requestBodySha256: result.transportEvidence.requestMeta.bodySha256 } : {}),
      ...(operation.id === 'attachment.upload.direct' && result.transportEvidence?.requestMeta?.bodyMode === 'private_file_stream'
        ? { requestBodyMode: 'private_file_stream' } : {}),
      ...(operation.id === 'attachment.upload.direct'
        && ['removed', 'remove_failed'].includes(result.transportEvidence?.privateTempBodyCleanup)
        ? { privateTempBodyCleanup: result.transportEvidence.privateTempBodyCleanup } : {}),
      requestHeaderNames: Object.freeze(Array.isArray(result.transportEvidence?.requestHeaderNames)
        ? result.transportEvidence.requestHeaderNames.filter(name => typeof name === 'string') : []),
      cookieNames: Object.freeze(Array.isArray(result.transportEvidence?.cookieNamesPrepared)
        ? result.transportEvidence.cookieNamesPrepared.filter(name => typeof name === 'string') : []),
      transportHttpVersion: result.transportEvidence?.httpVersion ?? null,
      tlsVerified: result.transportEvidence?.tlsVerified === true,
      trustEnv: result.transportEvidence ? result.transportEvidence.trustEnv === true : null,
      redirectsFollowed: result.transportEvidence ? result.transportEvidence.redirectsFollowed === true : null,
      explicitRetries: Number.isInteger(result.transportEvidence?.explicitRetries) ? result.transportEvidence.explicitRetries : null,
      attemptCount: 1,
      ownerVerified: true,
      businessResponsePersisted: false,
    });
    const sourceDiscoveryReceipt = sourceDiscoveryEligible ? {
      operationId: operation.id,
      observedAt: responseReceipt.observedAt,
      sourceFunctionName: operation.evidence.sourceFunctionName,
      method: operation.method,
      pathTemplate: operation.evidence.requestPath,
      requestDigest: prepared.requestDigest,
      intentDigest,
      responseStatus: result.status,
      responseContentType: result.contentType,
      responseBytes: result.responseBytes ?? null,
      responseDigest: createHash('sha256').update(JSON.stringify(data), 'utf8').digest('hex'),
      responseTopLevelFieldNames: data && typeof data === 'object' && !Array.isArray(data)
        ? Object.keys(data).sort().slice(0, 100) : [],
      responseJobIdObserved: Boolean(serviceJobId),
      requestHeaderNames: Array.isArray(result.transportEvidence?.requestHeaderNames) ? result.transportEvidence.requestHeaderNames : [],
      cookieNames: Array.isArray(result.transportEvidence?.cookieNamesPrepared) ? result.transportEvidence.cookieNamesPrepared : [],
      transportHttpVersion: typeof result.transportEvidence?.httpVersion === 'string' ? result.transportEvidence.httpVersion : null,
      tlsVerified: true,
      trustEnv: false,
      redirectsFollowed: false,
      explicitRetries: 0,
      attemptCount: 1,
      ownerVerified: true,
      businessResponsePersisted: false,
      responseDigestPersisted: false,
    } : undefined;

    let responseCheckpoint;
    if (onResponseCheckpoint) {
      try {
        await onResponseCheckpoint(Object.freeze({
          operationId: operation.id,
          localOperationId: journalEntry.localOperationId,
          requestDigest: prepared.requestDigest,
          intentDigest,
          responseReceipt,
          serviceJobIdObserved: Boolean(serviceJobId),
        }));
        responseCheckpoint = Object.freeze({ state: 'stored' });
      } catch {
        // The HTTP response is known. Keep it held and return its safe handle;
        // the caller must not mistake an audit sink failure for a retryable send.
        return {
          localOperationId: journalEntry.localOperationId,
          state: 'response_observed',
          jobIdObserved: Boolean(serviceJobId),
          responseReturned: true,
          responseReceipt,
          responseCheckpoint: Object.freeze({ state: 'failed', errorCode: 'RESPONSE_CHECKPOINT_FAILED', businessRetryAllowed: false }),
          journalPersistence: Object.freeze({ state: 'not_attempted', errorCode: 'RESPONSE_CHECKPOINT_FAILED', businessRetryAllowed: false }),
          businessRetryAllowed: false,
          ...(sourceDiscoveryReceipt ? { sourceDiscoveryReceipt } : {}),
        };
      }
    }

    try {
      await this.#journal.transition(journalEntry.localOperationId, serviceJobId ? 'accepted' : 'needs_review', {
        httpStatus: result.status,
        reasonCode: serviceJobId ? null : 'JOB_ID_NOT_OBSERVED',
        ...(serviceJobId ? { serviceJobId } : {}),
      });
    } catch {
      // A transition failure is not a lost HTTP response. Keep the response in
      // memory (when requested), return the local handle and prohibit replay.
      return {
        localOperationId: journalEntry.localOperationId,
        state: 'response_observed',
        jobIdObserved: Boolean(serviceJobId),
        responseReturned: true,
        responseReceipt,
        ...(responseCheckpoint ? { responseCheckpoint } : {}),
        journalPersistence: Object.freeze({ state: 'failed', errorCode: 'JOURNAL_TRANSITION_FAILED', businessRetryAllowed: false }),
        businessRetryAllowed: false,
        ...(sourceDiscoveryReceipt ? { sourceDiscoveryReceipt } : {}),
      };
    }

    return {
      localOperationId: journalEntry.localOperationId,
      state: serviceJobId ? 'accepted' : 'needs_review',
      httpStatus: result.status,
      jobIdObserved: Boolean(serviceJobId),
      responseReturned: true,
      responseReceipt,
      ...(responseCheckpoint ? { responseCheckpoint } : {}),
      ...(sourceDiscoveryReceipt ? { sourceDiscoveryReceipt } : {}),
    };
  }

  async getInMemoryServiceJobId(localOperationId) {
    if (!await this.#journal.get(localOperationId)) throw fail('JOURNAL_ENTRY_NOT_FOUND');
    return this.#serviceJobIds.get(localOperationId) ?? null;
  }

  async clearInMemoryServiceJobId(localOperationId) {
    if (!await this.#journal.get(localOperationId)) throw fail('JOURNAL_ENTRY_NOT_FOUND');
    return { cleared: this.#serviceJobIds.delete(localOperationId) };
  }

  async getInMemoryPrivateResponse(localOperationId) {
    if (!await this.#journal.get(localOperationId)) throw fail('JOURNAL_ENTRY_NOT_FOUND');
    return this.#privateResponses.get(localOperationId) ?? null;
  }

  async clearInMemoryPrivateResponse(localOperationId) {
    if (!await this.#journal.get(localOperationId)) throw fail('JOURNAL_ENTRY_NOT_FOUND');
    return { cleared: this.#privateResponses.delete(localOperationId) };
  }

  async reconcile(localOperationId, { signal } = {}) {
    const entry = await this.#journal.get(localOperationId);
    if (!entry) throw fail('JOURNAL_ENTRY_NOT_FOUND');
    if (!['accepted', 'outcome_unknown', 'processing', 'needs_review'].includes(entry.state)) {
      return { localOperationId, state: entry.state, reconciled: false };
    }
    const operation = findOperation(this.#registry, entry.contractId);
    const reconciliation = operation.reconciliation;
    const serviceJobId = this.#serviceJobIds.get(localOperationId);
    if (!reconciliation || !serviceJobId) {
      if (entry.state !== 'needs_review') {
        await this.#journal.transition(localOperationId, 'needs_review', { reasonCode: 'READBACK_CONTRACT_OR_JOB_ID_UNAVAILABLE' });
      }
      return { localOperationId, state: 'needs_review', reconciled: false, hold: true };
    }
    const pollOperation = findOperation(this.#registry, reconciliation.operationId);
    const result = await this.read(pollOperation.id, { [reconciliation.jobIdInputField]: serviceJobId }, { signal });
    const observedState = readJsonPointer(result.data, reconciliation.statusPointer);
    if (reconciliation.terminalValues.includes(observedState)) {
      const finalState = reconciliation.failureValues.includes(observedState) ? 'failed' : 'completed';
      await this.#journal.transition(localOperationId, finalState, {
        httpStatus: result.status,
        reasonCode: `READBACK_${String(observedState).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40)}`,
        ...(entry.state === 'needs_review' ? { reconciledBy: pollOperation.id } : {}),
      });
      this.#serviceJobIds.delete(localOperationId);
      return { localOperationId, state: finalState, reconciled: true, readbackStatus: result.status };
    }
    if (entry.state === 'outcome_unknown') {
      await this.#journal.transition(localOperationId, 'accepted', { httpStatus: result.status });
    }
    if (entry.state !== 'processing') {
      await this.#journal.transition(localOperationId, 'processing', { httpStatus: result.status });
    }
    return { localOperationId, state: 'processing', reconciled: true, readbackStatus: result.status };
  }

  async downloadArtifact(operationId, input, { outputDir, suggestedName, signal, expectedOwnerScopeSha256 } = {}) {
    const operation = findOperation(this.#registry, operationId);
    if (operation.kind !== 'download') throw fail('OPERATION_KIND_NOT_DOWNLOADABLE');
    const readiness = operationReadiness(operation);
    if (!readiness.ready) throw fail(readiness.reason);
    const source = findOperation(this.#registry, operation.artifact.sourceOperationId);
    const sourceResult = await this.read(source.id, input, { signal, expectedOwnerScopeSha256,
      ...(source.evidence?.source === 'first_party_sdk_contract' && source.evidence.firstLiveReadPermit === true
        && !source.evidence.directReplay ? { sourceDiscoveryPermit: `first-read:${source.id}` } : {}) });
    const artifactUrl = readJsonPointer(sourceResult.data, operation.artifact.urlJsonPointer);
    if (typeof artifactUrl !== 'string' || artifactUrl.length > 8192) throw fail('ARTIFACT_URL_INVALID');
    let parsed;
    try { parsed = new URL(artifactUrl); } catch { throw fail('ARTIFACT_URL_INVALID'); }
    if (parsed.protocol !== 'https:' || !operation.artifact.allowedOrigins.includes(parsed.origin)
      || parsed.username || parsed.password || parsed.hash) throw fail('ARTIFACT_URL_SCOPE');
    const response = await this.#fetch(parsed, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    }).catch(() => { throw fail('MEDIA_TRANSPORT_FAILED'); });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw fail('MEDIA_STATUS_UNEXPECTED', { status: response.status });
    }
    const downloadRequestDigest = createRequestDigest({ method: 'GET', url: parsed.href });
    const rawTransportEvidence = response.transportEvidence;
    const options = {
      outputDir,
      suggestedName,
      allowedMimeTypes: operation.artifact.mimeTypes,
      maxBytes: operation.artifact.maxBytes,
    };
    const artifact = operation.artifact.mimeTypes.every(isFileDownloadMimeType)
      ? downloadValidatedFile(response, options)
      : downloadValidatedMedia(response, options);
    const downloaded = await artifact;
    return {
      ...downloaded,
      httpStatus: response.status,
      resolverStatus: sourceResult.status,
      resolverRequestDigest: sourceResult.requestDigest,
      downloadRequestDigest,
      downloadTransportEvidence: rawTransportEvidence ? {
        httpVersion: rawTransportEvidence.httpVersion ?? null,
        profile: rawTransportEvidence.profile ?? null,
        tlsVerified: rawTransportEvidence.tlsVerified === true,
        trustEnv: rawTransportEvidence.trustEnv === false,
        redirectsFollowed: rawTransportEvidence.redirectsFollowed === false,
        explicitRetries: Number.isInteger(rawTransportEvidence.explicitRetries) ? rawTransportEvidence.explicitRetries : null,
        requestHeaderNames: Array.isArray(rawTransportEvidence.requestHeaderNames)
          ? rawTransportEvidence.requestHeaderNames : [],
        cookieNamesPrepared: Array.isArray(rawTransportEvidence.cookieNamesPrepared)
          ? rawTransportEvidence.cookieNamesPrepared : [],
      } : null,
    };
  }

  async listJournal() {
    return this.#journal.list();
  }
}
