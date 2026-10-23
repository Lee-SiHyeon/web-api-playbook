import { createHash, randomUUID } from 'node:crypto';
import { ProtectedJsonStore } from './protected-json-store.mjs';
import { NonSecretJsonFileStore } from './nonsecret-json-store.mjs';
import { fail } from './errors.mjs';
import { grokVideoNoWireProofDigest, isGrokVideoNoWireProof, isGrokVideoNoWireRecovery,
  validateGrokVideoNoWireEntries } from './grok-media-no-wire-proof.mjs';

const JOURNAL_KIND = 'grok-operation-journal';
const MAX_ENTRIES = 500;
const HELD_STATES = new Set(['sending', 'accepted', 'outcome_unknown', 'processing', 'needs_review']);
const ALLOWED_STATES = new Set(['sending', 'accepted', 'outcome_unknown', 'processing', 'completed', 'failed', 'rejected', 'blocked_security_boundary', 'needs_review']);
const TRANSITIONS = new Map([
  ['sending', new Set(['accepted', 'outcome_unknown', 'rejected', 'blocked_security_boundary', 'needs_review'])],
  ['accepted', new Set(['processing', 'completed', 'failed', 'outcome_unknown', 'needs_review'])],
  ['processing', new Set(['processing', 'completed', 'failed', 'outcome_unknown', 'needs_review'])],
  ['outcome_unknown', new Set(['accepted', 'completed', 'failed', 'needs_review'])],
  ['needs_review', new Set(['completed', 'failed'])],
]);
const SAFE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WSS_NO_BUSINESS_PROOF_KEYS = Object.freeze([
  'controlFrameSent', 'serverSessionAcknowledgementObserved', 'businessFrameBoundToServerSession',
  'directBusinessFrameSent', 'browserBusinessFramesDelivered', 'historyUnchanged', 'ownerVerified',
  'sameConversationTarget', 'sameParentTarget', 'targetAssistantUnchanged', 'userResponseCountUnchanged',
]);

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function emptyJournal() {
  return { kind: JOURNAL_KIND, schemaVersion: 1, entries: [] };
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !UUID_PATTERN.test(entry.localOperationId)
    || typeof entry.contractId !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(entry.contractId)
    || !ALLOWED_STATES.has(entry.state) || !Number.isFinite(Date.parse(entry.createdAt)) || !Number.isFinite(Date.parse(entry.updatedAt))
    || !/^[a-f0-9]{64}$/.test(entry.requestDigest)
    || (entry.intentDigest !== undefined && entry.intentDigest !== null && !/^[a-f0-9]{64}$/.test(entry.intentDigest))
    || (entry.serviceJobIdDigest !== null && !/^[a-f0-9]{64}$/.test(entry.serviceJobIdDigest))
    || (entry.httpStatus !== null && (!Number.isInteger(entry.httpStatus) || entry.httpStatus < 100 || entry.httpStatus > 599))
    || (entry.reasonCode !== null && (typeof entry.reasonCode !== 'string' || !SAFE_REASON.test(entry.reasonCode)))
    || !Number.isInteger(entry.attemptCount) || entry.attemptCount !== 1
    || (entry.reconciledBy !== null && (typeof entry.reconciledBy !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(entry.reconciledBy)))
    || (entry.recoveryOfRequestDigest !== undefined && !SHA256_PATTERN.test(entry.recoveryOfRequestDigest))
    || (entry.conversationBindingDigest !== undefined && !SHA256_PATTERN.test(entry.conversationBindingDigest))
    || (entry.parentBindingDigest !== undefined && !SHA256_PATTERN.test(entry.parentBindingDigest))
    || (entry.noBusinessRecoveryProof !== undefined && !validWssNoBusinessProof(entry.noBusinessRecoveryProof))) {
    throw fail('JOURNAL_STATE_INVALID');
  }
  const allowedKeys = new Set(['localOperationId', 'contractId', 'state', 'createdAt', 'updatedAt', 'requestDigest', 'intentDigest', 'serviceJobIdDigest', 'httpStatus', 'reasonCode', 'attemptCount', 'reconciledBy', 'recoveryOfRequestDigest', 'conversationBindingDigest', 'parentBindingDigest', 'noBusinessRecoveryProof', 'videoNoWireProof', 'videoNoWireRecovery']);
  if (Object.keys(entry).some(key => !allowedKeys.has(key))) throw fail('JOURNAL_STATE_INVALID');
  if (entry.noBusinessRecoveryProof !== undefined && (entry.contractId !== 'chat.regenerate.wss'
    || entry.state !== 'rejected' || entry.httpStatus !== 101 || entry.reasonCode !== 'CONVERSATION_WSS_FRAME_NOT_SENT')) {
    throw fail('JOURNAL_STATE_INVALID');
  }
  if (entry.recoveryOfRequestDigest !== undefined && (entry.contractId !== 'chat.regenerate.wss'
    || !SHA256_PATTERN.test(entry.conversationBindingDigest) || !SHA256_PATTERN.test(entry.parentBindingDigest))) {
    throw fail('JOURNAL_STATE_INVALID');
  }
  if (entry.videoNoWireProof !== undefined && (entry.contractId !== 'media.video.create'
    || !isGrokVideoNoWireProof(entry.videoNoWireProof, {
      intentDigest: entry.intentDigest,
      requestDigest: entry.requestDigest,
    }) || entry.state !== 'rejected' || entry.reasonCode !== 'MEDIA_VIDEO_CFFI_PREFLIGHT_FAILED'
    || entry.httpStatus !== null)) throw fail('JOURNAL_STATE_INVALID');
  if (entry.videoNoWireRecovery !== undefined && (entry.contractId !== 'media.video.create'
    || !isGrokVideoNoWireRecovery(entry.videoNoWireRecovery))) throw fail('JOURNAL_STATE_INVALID');
}

function validWssNoBusinessProof(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...WSS_NO_BUSINESS_PROOF_KEYS].sort())
    && value.controlFrameSent === true
    && value.serverSessionAcknowledgementObserved === true
    && value.businessFrameBoundToServerSession === false
    && value.directBusinessFrameSent === false
    && value.browserBusinessFramesDelivered === 0
    && value.historyUnchanged === true
    && value.ownerVerified === true
    && value.sameConversationTarget === true
    && value.sameParentTarget === true
    && value.targetAssistantUnchanged === true
    && value.userResponseCountUnchanged === true;
}

function validateJournal(value) {
  if (value === null) return emptyJournal();
  if (!value || value.kind !== JOURNAL_KIND || value.schemaVersion !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
    throw fail('JOURNAL_STATE_INVALID');
  }
  for (const entry of value.entries) validateEntry(entry);
  if (new Set(value.entries.map(entry => entry.localOperationId)).size !== value.entries.length) throw fail('JOURNAL_STATE_INVALID');
  if (!validateGrokVideoNoWireEntries(value.entries)) throw fail('JOURNAL_STATE_INVALID');
  return value;
}

function evictableTerminalIndex(entries) {
  const referenced = new Set(entries.map(entry => entry.videoNoWireRecovery?.priorOperationIdSha256).filter(Boolean));
  return entries.findIndex(entry => !HELD_STATES.has(entry.state)
    && !entry.noBusinessRecoveryProof && !entry.videoNoWireProof
    && !entry.videoNoWireRecovery && !referenced.has(digest(entry.localOperationId)));
}

function duplicateEntry(entries, contractId, requestDigest, intentDigest) {
  return entries.filter(entry => entry.contractId === contractId
    && (intentDigest
      ? (entry.intentDigest ? entry.intentDigest === intentDigest : entry.requestDigest === requestDigest)
      : entry.requestDigest === requestDigest)).at(-1);
}

export class OperationJournal {
  #store;

  constructor({ store } = {}) {
    this.#store = store ?? (process.platform === 'win32'
      ? new ProtectedJsonStore({ fileName: 'operations.dpapi' })
      : new NonSecretJsonFileStore());
  }

  async #read() {
    return validateJournal(await this.#store.read());
  }

  async begin({ contractId, requestDigest, intentDigest = null, localOperationId = randomUUID(), now = new Date().toISOString() } = {}) {
    if (typeof contractId !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(contractId)
      || !/^[a-f0-9]{64}$/.test(requestDigest) || (intentDigest !== null && !/^[a-f0-9]{64}$/.test(intentDigest))
      || !UUID_PATTERN.test(localOperationId)) throw fail('JOURNAL_INPUT_INVALID');
    return this.#store.transact(current => {
      const journal = validateJournal(current);
      const duplicate = duplicateEntry(journal.entries, contractId, requestDigest, intentDigest);
      if (duplicate) {
        const code = HELD_STATES.has(duplicate.state)
          ? 'OPERATION_ALREADY_HELD'
          : duplicate.state === 'completed' ? 'OPERATION_ALREADY_COMPLETED' : 'OPERATION_ALREADY_ATTEMPTED';
        throw fail(code, { state: duplicate.state });
      }
      if (journal.entries.length >= MAX_ENTRIES) {
        const terminalIndex = evictableTerminalIndex(journal.entries);
        if (terminalIndex < 0) throw fail('JOURNAL_FULL_HELD');
        journal.entries.splice(terminalIndex, 1);
      }
      const entry = {
        localOperationId,
        contractId,
        state: 'sending',
        createdAt: now,
        updatedAt: now,
        requestDigest,
        intentDigest,
        serviceJobIdDigest: null,
        httpStatus: null,
        reasonCode: null,
        attemptCount: 1,
        reconciledBy: null,
      };
      journal.entries.push(entry);
      validateJournal(journal);
      return { value: journal, result: { ...entry } };
    });
  }

  async rejectMediaVideoNoWireAttempt(localOperationId, proof, { now = new Date().toISOString() } = {}) {
    if (!UUID_PATTERN.test(localOperationId) || !isGrokVideoNoWireProof(proof)
      || !Number.isFinite(Date.parse(now))) throw fail('JOURNAL_VIDEO_NO_WIRE_PROOF_INVALID');
    return this.#store.transact(current => {
      const journal = validateJournal(current);
      const entry = journal.entries.find(item => item.localOperationId === localOperationId);
      if (!entry || entry.contractId !== 'media.video.create' || entry.state !== 'sending'
        || entry.requestDigest !== proof.requestDigest || entry.intentDigest !== proof.intentDigest
        || entry.videoNoWireProof !== undefined) throw fail('JOURNAL_VIDEO_NO_WIRE_RECOVERY_NOT_ALLOWED');
      entry.state = 'rejected';
      entry.updatedAt = now;
      entry.httpStatus = null;
      entry.reasonCode = 'MEDIA_VIDEO_CFFI_PREFLIGHT_FAILED';
      entry.videoNoWireProof = { ...proof,
        requestHeaderNames: [...proof.requestHeaderNames],
        responseHeaderNames: [...proof.responseHeaderNames],
        cookieNamesUsed: [...proof.cookieNamesUsed],
      };
      validateJournal(journal);
      return { value: journal, result: {
        localOperationId,
        contractId: entry.contractId,
        state: entry.state,
        requestDigest: entry.requestDigest,
        intentDigest: entry.intentDigest,
        noWireProofPersisted: true,
      } };
    });
  }

  async beginVerifiedNoWireVideoRecovery({ requestDigest, intentDigest, intentId, ownerIdentityDigest,
    payloadProfile, promptSha256, now = new Date().toISOString() } = {}) {
    if (!SHA256_PATTERN.test(requestDigest) || !SHA256_PATTERN.test(intentDigest)
      || !UUID_PATTERN.test(intentId) || !SHA256_PATTERN.test(ownerIdentityDigest)
      || typeof payloadProfile !== 'string' || !/^video-(?:6s-480p-no-audio|image-reference-6s-480p-no-audio)$/.test(payloadProfile)
      || !SHA256_PATTERN.test(promptSha256)
      || !Number.isFinite(Date.parse(now))) throw fail('JOURNAL_VIDEO_NO_WIRE_BINDING_INVALID');
    const expectedIntentDigest = digest(`media.video.create\n${ownerIdentityDigest}\n${intentId}`);
    const intentIdSha256 = digest(intentId);
    if (expectedIntentDigest !== intentDigest) throw fail('JOURNAL_VIDEO_NO_WIRE_BINDING_INVALID');
    return this.#store.transact(current => {
      const journal = validateJournal(current);
      const matching = journal.entries.filter(entry => entry.contractId === 'media.video.create'
        && entry.intentDigest === intentDigest);
      if (!matching.length || matching.some(entry => entry.state !== 'rejected'
        || !isGrokVideoNoWireProof(entry.videoNoWireProof, {
          ownerIdentityDigest,
          intentIdSha256,
          intentDigest,
          payloadProfile,
          promptSha256,
        }))) throw fail('JOURNAL_VIDEO_NO_WIRE_RECOVERY_NOT_ALLOWED');
      const prior = matching.at(-1);
      const priorOperationIdSha256 = digest(prior.localOperationId);
      if (journal.entries.some(entry => entry.videoNoWireRecovery?.priorOperationIdSha256 === priorOperationIdSha256)) {
        throw fail('JOURNAL_VIDEO_NO_WIRE_RECOVERY_ALREADY_USED');
      }
      if (journal.entries.length >= MAX_ENTRIES) throw fail('JOURNAL_FULL_HELD');
      const recovery = {
        schemaVersion: 1,
        priorOperationIdSha256,
        priorRequestDigest: prior.requestDigest,
        priorProofDigest: grokVideoNoWireProofDigest(prior.videoNoWireProof),
        ownerIdentityDigest,
        intentIdSha256,
        payloadProfile: prior.videoNoWireProof.payloadProfile,
        promptSha256: prior.videoNoWireProof.promptSha256,
      };
      const entry = {
        localOperationId: randomUUID(),
        contractId: 'media.video.create',
        state: 'sending',
        createdAt: now,
        updatedAt: now,
        requestDigest,
        intentDigest,
        serviceJobIdDigest: null,
        httpStatus: null,
        reasonCode: null,
        attemptCount: 1,
        reconciledBy: null,
        videoNoWireRecovery: recovery,
      };
      journal.entries.push(entry);
      validateJournal(journal);
      return { value: journal, result: { ...entry } };
    });
  }

  async recordVerifiedNoBusinessWssAttempt(localOperationId, proof) {
    if (!UUID_PATTERN.test(localOperationId) || !validWssNoBusinessProof(proof)) {
      throw fail('JOURNAL_WSS_RECOVERY_PROOF_INVALID');
    }
    return this.#store.transact(current => {
      const journal = validateJournal(current);
      const entry = journal.entries.find(item => item.localOperationId === localOperationId);
      if (!entry || entry.contractId !== 'chat.regenerate.wss' || entry.state !== 'rejected'
        || entry.httpStatus !== 101 || entry.reasonCode !== 'CONVERSATION_WSS_FRAME_NOT_SENT'
        || entry.noBusinessRecoveryProof !== undefined) throw fail('JOURNAL_WSS_RECOVERY_NOT_ALLOWED');
      entry.noBusinessRecoveryProof = { ...proof };
      validateEntry(entry);
      return { value: journal, result: { recorded: true, contractId: entry.contractId, state: entry.state,
        httpStatus: entry.httpStatus, recoveryProofRecorded: true } };
    });
  }

  async beginVerifiedNoBusinessWssRecovery({ requestDigest, intentDigest, conversationBindingDigest,
    parentBindingDigest, now = new Date().toISOString() } = {}) {
    if (!SHA256_PATTERN.test(requestDigest) || !SHA256_PATTERN.test(intentDigest)
      || !SHA256_PATTERN.test(conversationBindingDigest) || !SHA256_PATTERN.test(parentBindingDigest)) {
      throw fail('JOURNAL_WSS_RECOVERY_BINDING_INVALID');
    }
    return this.#store.transact(current => {
      const journal = validateJournal(current);
      const matching = journal.entries.filter(item => item.contractId === 'chat.regenerate.wss' && item.intentDigest === intentDigest);
      if (matching.length !== 1) throw fail('JOURNAL_WSS_RECOVERY_NOT_ALLOWED');
      const prior = matching[0];
      if (prior.state !== 'rejected' || prior.httpStatus !== 101 || prior.reasonCode !== 'CONVERSATION_WSS_FRAME_NOT_SENT'
        || !validWssNoBusinessProof(prior.noBusinessRecoveryProof)
        || prior.requestDigest === requestDigest
        || journal.entries.some(item => item.recoveryOfRequestDigest === prior.requestDigest)) {
        throw fail('JOURNAL_WSS_RECOVERY_NOT_ALLOWED');
      }
      if (journal.entries.length >= MAX_ENTRIES) {
        const terminalIndex = evictableTerminalIndex(journal.entries);
        if (terminalIndex < 0) throw fail('JOURNAL_FULL_HELD');
        journal.entries.splice(terminalIndex, 1);
      }
      const createdAt = now;
      if (!Number.isFinite(Date.parse(createdAt))) throw fail('JOURNAL_INPUT_INVALID');
      const entry = {
        localOperationId: randomUUID(),
        contractId: 'chat.regenerate.wss',
        state: 'sending',
        createdAt,
        updatedAt: createdAt,
        requestDigest,
        intentDigest,
        serviceJobIdDigest: null,
        httpStatus: null,
        reasonCode: null,
        attemptCount: 1,
        reconciledBy: null,
        recoveryOfRequestDigest: prior.requestDigest,
        conversationBindingDigest,
        parentBindingDigest,
      };
      journal.entries.push(entry);
      validateJournal(journal);
      return { value: journal, result: { ...entry } };
    });
  }

  async transition(localOperationId, state, { httpStatus = null, reasonCode = null, serviceJobId = null, reconciledBy = null, now = new Date().toISOString() } = {}) {
    if (!UUID_PATTERN.test(localOperationId) || !ALLOWED_STATES.has(state)
      || (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599))
      || (reasonCode !== null && (typeof reasonCode !== 'string' || !SAFE_REASON.test(reasonCode)))
      || (reconciledBy !== null && (typeof reconciledBy !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(reconciledBy)))) {
      throw fail('JOURNAL_TRANSITION_INVALID');
    }
    return this.#store.transact(current => {
      const journal = validateJournal(current);
      const entry = journal.entries.find(item => item.localOperationId === localOperationId);
      if (!entry) throw fail('JOURNAL_ENTRY_NOT_FOUND');
      if (['completed', 'failed', 'rejected', 'blocked_security_boundary'].includes(entry.state)) throw fail('JOURNAL_ENTRY_TERMINAL');
      if (!TRANSITIONS.get(entry.state)?.has(state)) throw fail('JOURNAL_TRANSITION_INVALID');
      if (['completed', 'failed'].includes(state) && entry.state === 'needs_review' && !reconciledBy) {
        throw fail('JOURNAL_READBACK_REQUIRED');
      }
      entry.state = state;
      entry.updatedAt = now;
      entry.httpStatus = httpStatus;
      entry.reasonCode = reasonCode;
      if (serviceJobId !== null) entry.serviceJobIdDigest = digest(serviceJobId);
      if (reconciledBy !== null) entry.reconciledBy = reconciledBy;
      validateJournal(journal);
      return { value: journal, result: { ...entry } };
    });
  }

  async get(localOperationId) {
    if (!UUID_PATTERN.test(localOperationId)) throw fail('JOURNAL_ID_INVALID');
    const journal = await this.#read();
    const entry = journal.entries.find(item => item.localOperationId === localOperationId);
    return entry ? { ...entry } : null;
  }

  async list() {
    const journal = await this.#read();
    return journal.entries.map(entry => ({ ...entry }));
  }
}

export const operationJournalContract = Object.freeze({
  persistedFields: ['localOperationId', 'contractId', 'state', 'timestamps', 'requestDigest', 'intentDigest', 'serviceJobIdDigest', 'httpStatus', 'reasonCode', 'attemptCount', 'reconciledBy', 'recoveryOfRequestDigest', 'conversationBindingDigest', 'parentBindingDigest', 'noBusinessRecoveryProof', 'videoNoWireProof', 'videoNoWireRecovery'],
  neverPersisted: ['prompts', 'responses', 'cookies', 'headers', 'tokens', 'authIds', 'sessionIds', 'serviceJobIds', 'artifactUrls'],
  retry: 'no automatic resubmission; unresolved matching request digests remain held',
  provider: 'Windows DPAPI CurrentUser on Windows; local nonsecret JSON file on Linux; injected stores remain supported',
});
