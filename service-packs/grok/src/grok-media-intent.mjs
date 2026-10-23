import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.mjs';
import { grokVideoNoWireProofDigest, isGrokVideoNoWireProof } from './grok-media-no-wire-proof.mjs';

const SCHEMA_VERSION = 1;
const MAX_JOURNAL_BYTES = 128 * 1024;
const MAX_JOURNAL_ENTRIES = 500;
const MAX_VIDEO_NO_WIRE_RECOVERIES_PER_INTENT = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set(['media.image.create', 'media.video.create']);
const TERMINAL = new Set(['completed', 'failed', 'outcome_unknown', 'needs_review', 'blocked_security_boundary']);
const TRANSITIONS = Object.freeze({
  prepared: new Set(['sending', 'failed', 'blocked_security_boundary']),
  sending: new Set(['accepted', 'processing', 'completed', 'failed', 'outcome_unknown', 'needs_review', 'blocked_security_boundary']),
  accepted: new Set(['processing', 'completed', 'failed', 'outcome_unknown', 'needs_review']),
  processing: new Set(['processing', 'completed', 'failed', 'outcome_unknown', 'needs_review']),
  outcome_unknown: new Set(['completed']),
  needs_review: new Set(['completed', 'failed']),
});

function validOperation(value) {
  return typeof value === 'string' && OPERATIONS.has(value);
}

function validCode(value) {
  return value === null || value === undefined
    || (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value));
}

function promptDigest(prompt) {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function validVideoNoWireRecovery(value) {
  const baseKeys = ['eventId', 'operation', 'operationIdSha256', 'intentIdSha256', 'ownerIdentityDigest',
    'intentDigest', 'requestDigest', 'proofDigest', 'payloadProfile', 'promptSha256', 'stage',
    'requestStarted', 'responseReceived', 'httpStatus', 'responseBytesRead', 'helperErrorCode',
    'errorClass', 'createdAt'];
  const extendedKeys = [...baseKeys, 'preDispatchFailure'];
  const hasPreDispatchFailure = value && typeof value === 'object' && Object.hasOwn(value, 'preDispatchFailure');
  const preDispatchFailure = value?.preDispatchFailure;
  const preDispatchFailureValid = !hasPreDispatchFailure || preDispatchFailure && typeof preDispatchFailure === 'object'
    && !Array.isArray(preDispatchFailure)
    && JSON.stringify(Object.keys(preDispatchFailure).sort()) === JSON.stringify(['stage','mainFetchCallCount','requestStarted','responseReceived','errorCode'].sort())
    && preDispatchFailure.stage === 'operation_journal_begin'
    && preDispatchFailure.mainFetchCallCount === 0
    && preDispatchFailure.requestStarted === false
    && preDispatchFailure.responseReceived === false
    && preDispatchFailure.errorCode === 'JOURNAL_STATE_INVALID';
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...(hasPreDispatchFailure ? extendedKeys : baseKeys)].sort())
    && preDispatchFailureValid
    && typeof value.eventId === 'string' && UUID_PATTERN.test(value.eventId)
    && value.operation === 'media.video.create'
    && ['operationIdSha256', 'intentIdSha256', 'ownerIdentityDigest', 'intentDigest', 'requestDigest', 'proofDigest', 'promptSha256']
      .every(key => typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key]))
    && typeof value.payloadProfile === 'string' && /^video-(?:6s-480p-no-audio|image-reference-6s-480p-no-audio)$/.test(value.payloadProfile)
    && ['validation', 'dependency', 'session_setup'].includes(value.stage)
    && value.requestStarted === false && value.responseReceived === false && value.httpStatus === null
    && value.responseBytesRead === 0
    && typeof value.helperErrorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.helperErrorCode)
    && (value.errorClass === null || typeof value.errorClass === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.errorClass))
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt));
}

function validateJournal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(value.intents) || value.intents.length > MAX_JOURNAL_ENTRIES) throw fail('MEDIA_INTENT_JOURNAL_INVALID');
  if (value.verifiedNoWireRecoveries === undefined) value.verifiedNoWireRecoveries = [];
  if (!Array.isArray(value.verifiedNoWireRecoveries) || value.verifiedNoWireRecoveries.length > MAX_JOURNAL_ENTRIES * MAX_VIDEO_NO_WIRE_RECOVERIES_PER_INTENT
    || value.verifiedNoWireRecoveries.some(entry => !validVideoNoWireRecovery(entry))) throw fail('MEDIA_INTENT_JOURNAL_INVALID');
  if (Object.keys(value).some(key => !['schemaVersion', 'updatedAt', 'intents', 'verifiedNoWireRecoveries'].includes(key))) {
    throw fail('MEDIA_INTENT_JOURNAL_INVALID');
  }
  for (const item of value.intents) {
    if (!item || typeof item !== 'object' || !validOperation(item.operation)
      || typeof item.intentId !== 'string' || !UUID_PATTERN.test(item.intentId)
      || typeof item.state !== 'string' || !['prepared', 'sending', ...TERMINAL, 'accepted', 'processing'].includes(item.state)
      || !Number.isInteger(item.promptLength) || item.promptLength < 1 || item.promptLength > 4_000
      || !Number.isInteger(item.attemptNumber) || item.attemptNumber !== 1
      || typeof item.payloadProfile !== 'string' || !/^[a-z][a-z0-9._-]{1,63}$/.test(item.payloadProfile)
      || (item.promptSha256 !== undefined && (typeof item.promptSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.promptSha256)))
      || (item.ownerIdentityDigest !== undefined && (typeof item.ownerIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(item.ownerIdentityDigest)))
      || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
      || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) {
      throw fail('MEDIA_INTENT_JOURNAL_INVALID');
    }
  }
  if (new Set(value.intents.map(item => item.intentId)).size !== value.intents.length) throw fail('MEDIA_INTENT_JOURNAL_INVALID');
  return value;
}

async function readJournal(filePath) {
  let bytes;
  try { bytes = await readFile(filePath); } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: SCHEMA_VERSION, updatedAt: null, intents: [], verifiedNoWireRecoveries: [] };
    throw fail('MEDIA_INTENT_JOURNAL_READ_FAILED');
  }
  if (bytes.length > MAX_JOURNAL_BYTES) throw fail('MEDIA_INTENT_JOURNAL_TOO_LARGE');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw fail('MEDIA_INTENT_JOURNAL_INVALID'); }
  return validateJournal(parsed);
}

async function atomicWrite(filePath, data) {
  const parent = path.dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 }).catch(() => { throw fail('MEDIA_INTENT_JOURNAL_WRITE_FAILED'); });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JOURNAL_BYTES) throw fail('MEDIA_INTENT_JOURNAL_TOO_LARGE');
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    if (error?.code === 'MEDIA_INTENT_JOURNAL_TOO_LARGE') throw error;
    throw fail('MEDIA_INTENT_JOURNAL_WRITE_FAILED');
  }
}

function safeReadback(readback) {
  if (readback === undefined) return undefined;
  if (!readback || typeof readback !== 'object' || Array.isArray(readback)) throw fail('MEDIA_INTENT_READBACK_INVALID');
  const result = {};
  if (Number.isInteger(readback.assetCount) && readback.assetCount >= 0) result.assetCount = readback.assetCount;
  if (Array.isArray(readback.mimeTypes) && readback.mimeTypes.length <= 16
    && readback.mimeTypes.every(value => typeof value === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value))) {
    result.mimeTypes = [...new Set(readback.mimeTypes)].sort();
  }
  if (typeof readback.magicVerified === 'boolean') result.magicVerified = readback.magicVerified;
  if (Number.isInteger(readback.bodyBytes) && readback.bodyBytes >= 0) result.bodyBytes = readback.bodyBytes;
  return result;
}

export class GrokMediaIntentJournal {
  #filePath;
  #queue = Promise.resolve();

  constructor({ filePath } = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || /[\r\n\0]/.test(filePath)) {
      throw fail('MEDIA_INTENT_JOURNAL_PATH_INVALID');
    }
    this.#filePath = filePath;
  }

  #locked(work) {
    const current = this.#queue.then(work);
    this.#queue = current.catch(() => {});
    return current;
  }

  async begin({ operation, prompt, payloadProfile, intentId, ownerIdentityDigest } = {}) {
    if (!validOperation(operation) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4_000
      || typeof payloadProfile !== 'string' || !/^[a-z][a-z0-9._-]{1,63}$/.test(payloadProfile)
      || (intentId !== undefined && (typeof intentId !== 'string' || !UUID_PATTERN.test(intentId)))
      || (ownerIdentityDigest !== undefined && (typeof ownerIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(ownerIdentityDigest)))) {
      throw fail('MEDIA_INTENT_INVALID');
    }
    return this.#locked(async () => {
      const journal = await readJournal(this.#filePath);
      const id = intentId ?? randomUUID();
      if (journal.intents.some(item => item.intentId === id)) throw fail('MEDIA_INTENT_ALREADY_ATTEMPTED');
      if (journal.intents.length >= MAX_JOURNAL_ENTRIES) throw fail('MEDIA_INTENT_JOURNAL_FULL');
      const now = new Date().toISOString();
      const intent = {
        intentId: id,
        operation,
        state: 'prepared',
        attemptNumber: 1,
        payloadProfile,
        promptLength: prompt.length,
        promptSha256: promptDigest(prompt),
        ...(ownerIdentityDigest !== undefined ? { ownerIdentityDigest: ownerIdentityDigest.toLowerCase() } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const next = { schemaVersion: SCHEMA_VERSION, updatedAt: now, intents: [...journal.intents, intent],
        verifiedNoWireRecoveries: journal.verifiedNoWireRecoveries };
      await atomicWrite(this.#filePath, next);
      return { intentId: intent.intentId, operation, state: intent.state, attemptNumber: 1 };
    });
  }

  async prepare({ operation, prompt, payloadProfile, ownerIdentityDigest, intentId } = {}) {
    if (!validOperation(operation) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4_000
      || typeof payloadProfile !== 'string' || !/^[a-z][a-z0-9._-]{1,63}$/.test(payloadProfile)
      || typeof ownerIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(ownerIdentityDigest)
      || (intentId !== undefined && (typeof intentId !== 'string' || !UUID_PATTERN.test(intentId)))) {
      throw fail('MEDIA_INTENT_INVALID');
    }
    return this.#locked(async () => {
      const journal = await readJournal(this.#filePath);
      const id = intentId ?? randomUUID();
      const existingIndex = journal.intents.findIndex(item => item.intentId === id);
      const now = new Date().toISOString();
      const digest = promptDigest(prompt);
      if (existingIndex >= 0) {
        const existing = journal.intents[existingIndex];
        if (existing.state !== 'prepared' || existing.attemptNumber !== 1) throw fail('MEDIA_INTENT_ALREADY_ATTEMPTED');
        if (existing.operation !== operation || existing.payloadProfile !== payloadProfile
          || existing.promptLength !== prompt.length) throw fail('MEDIA_INTENT_PREPARED_PROFILE_MISMATCH');
        if (existing.promptSha256 !== undefined && existing.promptSha256 !== digest) throw fail('MEDIA_INTENT_PREPARED_PROMPT_MISMATCH');
        if (existing.ownerIdentityDigest !== undefined
          && existing.ownerIdentityDigest !== ownerIdentityDigest.toLowerCase()) throw fail('MEDIA_INTENT_PREPARED_OWNER_MISMATCH');
        const changed = {
          ...existing,
          promptSha256: digest,
          ownerIdentityDigest: ownerIdentityDigest.toLowerCase(),
          updatedAt: now,
        };
        const intents = [...journal.intents];
        intents[existingIndex] = changed;
        await atomicWrite(this.#filePath, { schemaVersion: SCHEMA_VERSION, updatedAt: now, intents,
          verifiedNoWireRecoveries: journal.verifiedNoWireRecoveries });
        return {
          intentId: id, operation, state: changed.state, attemptNumber: changed.attemptNumber,
          payloadProfile, promptLength: changed.promptLength, promptSha256: changed.promptSha256,
          ownerIdentityDigest: changed.ownerIdentityDigest,
        };
      }
      if (journal.intents.length >= MAX_JOURNAL_ENTRIES) throw fail('MEDIA_INTENT_JOURNAL_FULL');
      const item = {
        intentId: id,
        operation,
        state: 'prepared',
        attemptNumber: 1,
        payloadProfile,
        promptLength: prompt.length,
        promptSha256: digest,
        ownerIdentityDigest: ownerIdentityDigest.toLowerCase(),
        createdAt: now,
        updatedAt: now,
      };
      await atomicWrite(this.#filePath, { schemaVersion: SCHEMA_VERSION, updatedAt: now, intents: [...journal.intents, item],
        verifiedNoWireRecoveries: journal.verifiedNoWireRecoveries });
      return {
        intentId: id, operation, state: item.state, attemptNumber: item.attemptNumber,
        payloadProfile, promptLength: item.promptLength, promptSha256: item.promptSha256,
        ownerIdentityDigest: item.ownerIdentityDigest,
      };
    });
  }

  async transition(intentId, nextState, { httpStatus, reasonCode, readback } = {}) {
    if (typeof intentId !== 'string' || !UUID_PATTERN.test(intentId)
      || typeof nextState !== 'string' || !validCode(reasonCode)
      || (httpStatus !== undefined && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599))) {
      throw fail('MEDIA_INTENT_TRANSITION_INVALID');
    }
    const safe = safeReadback(readback);
    return this.#locked(async () => {
      const journal = await readJournal(this.#filePath);
      const index = journal.intents.findIndex(item => item.intentId === intentId);
      if (index < 0) throw fail('MEDIA_INTENT_NOT_FOUND');
      const current = journal.intents[index];
      if (!TRANSITIONS[current.state]?.has(nextState)) throw fail('MEDIA_INTENT_TRANSITION_INVALID');
      if (['accepted', 'outcome_unknown', 'needs_review'].includes(current.state) && nextState === 'completed'
        && (!safe || safe.assetCount < 1 || safe.magicVerified !== true || !Number.isInteger(safe.bodyBytes) || safe.bodyBytes < 1)) {
        throw fail('MEDIA_INTENT_READBACK_REQUIRED');
      }
      const now = new Date().toISOString();
      const changed = {
        ...current,
        state: nextState,
        updatedAt: now,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(reasonCode !== undefined ? { reasonCode } : {}),
        ...(safe !== undefined ? { readback: safe } : {}),
      };
      const intents = [...journal.intents];
      intents[index] = changed;
      await atomicWrite(this.#filePath, { schemaVersion: SCHEMA_VERSION, updatedAt: now, intents,
        verifiedNoWireRecoveries: journal.verifiedNoWireRecoveries });
      return { intentId, operation: changed.operation, state: changed.state, attemptNumber: changed.attemptNumber };
    });
  }

  async recoverVerifiedNoWire({ intentId, prompt, payloadProfile, ownerIdentityDigest, operationJournal,
    localOperationId, preDispatchFailure } = {}) {
    if (typeof intentId !== 'string' || !UUID_PATTERN.test(intentId)
      || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4_000
      || typeof payloadProfile !== 'string' || !/^video-(?:6s-480p-no-audio|image-reference-6s-480p-no-audio)$/.test(payloadProfile)
      || typeof ownerIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(ownerIdentityDigest)
      || !operationJournal || typeof operationJournal.get !== 'function'
      || typeof localOperationId !== 'string' || !UUID_PATTERN.test(localOperationId)) {
      throw fail('MEDIA_INTENT_NO_WIRE_RECOVERY_INVALID');
    }
    const operationEntry = await operationJournal.get(localOperationId);
    const operationEntries = typeof operationJournal.list === 'function' ? await operationJournal.list() : [];
    const ownerDigest = ownerIdentityDigest.toLowerCase();
    const intentIdSha256 = digest(intentId);
    const promptSha256 = promptDigest(prompt);
    const intentDigest = digest(`media.video.create\n${ownerDigest}\n${intentId}`);
    const proof = operationEntry?.videoNoWireProof;
    if (!operationEntry || operationEntry.contractId !== 'media.video.create' || operationEntry.state !== 'rejected'
      || operationEntry.reasonCode !== 'MEDIA_VIDEO_CFFI_PREFLIGHT_FAILED' || operationEntry.httpStatus !== null
      || operationEntry.intentDigest !== intentDigest || !isGrokVideoNoWireProof(proof, {
        ownerIdentityDigest: ownerDigest,
        intentIdSha256,
        intentDigest,
        requestDigest: operationEntry.requestDigest,
        payloadProfile,
        promptSha256,
      })) throw fail('MEDIA_INTENT_NO_WIRE_RECOVERY_UNVERIFIED');
    const matchingOperations = operationEntries.filter(entry => entry.contractId === 'media.video.create'
      && entry.intentDigest === intentDigest);
    if (!matchingOperations.length || matchingOperations.some(entry => entry.state !== 'rejected'
      || !isGrokVideoNoWireProof(entry.videoNoWireProof, { intentDigest, ownerIdentityDigest: ownerDigest,
        intentIdSha256, payloadProfile, promptSha256, requestDigest: entry.requestDigest }))) {
      throw fail('MEDIA_INTENT_NO_WIRE_RECOVERY_UNVERIFIED');
    }
    const localFailure = preDispatchFailure !== undefined;
    if (localFailure && (!preDispatchFailure || typeof preDispatchFailure !== 'object' || Array.isArray(preDispatchFailure)
      || JSON.stringify(Object.keys(preDispatchFailure).sort())
        !== JSON.stringify(['stage','mainFetchCallCount','requestStarted','responseReceived','errorCode'].sort())
      || preDispatchFailure.stage !== 'operation_journal_begin' || preDispatchFailure.mainFetchCallCount !== 0
      || preDispatchFailure.requestStarted !== false || preDispatchFailure.responseReceived !== false
      || preDispatchFailure.errorCode !== 'JOURNAL_STATE_INVALID')) {
      throw fail('MEDIA_INTENT_NO_WIRE_RECOVERY_UNVERIFIED');
    }

    const operationIdSha256 = digest(localOperationId);
    const proofDigest = grokVideoNoWireProofDigest(proof);
    return this.#locked(async () => {
      const journal = await readJournal(this.#filePath);
      const index = journal.intents.findIndex(item => item.intentId === intentId);
      if (index < 0) throw fail('MEDIA_INTENT_NOT_FOUND');
      const current = journal.intents[index];
      const priorRecovery = journal.verifiedNoWireRecoveries.find(item => item.operationIdSha256 === operationIdSha256
        && item.requestDigest === operationEntry.requestDigest && item.intentIdSha256 === intentIdSha256);
      if (current.state === 'prepared' && priorRecovery) {
        return { intentId, operation: current.operation, state: 'prepared', attemptNumber: current.attemptNumber,
          recovered: true, recoveryRecorded: true };
      }
      const failedBeforeWriter = localFailure && current.state === 'failed' && current.reasonCode === 'JOURNAL_STATE_INVALID';
      if (current.operation !== 'media.video.create'
        || !(failedBeforeWriter || ['sending', 'prepared'].includes(current.state)) || current.attemptNumber !== 1
        || current.payloadProfile !== payloadProfile || current.promptLength !== prompt.length
        || current.promptSha256 !== promptSha256 || current.ownerIdentityDigest !== ownerDigest) {
        throw fail('MEDIA_INTENT_NO_WIRE_RECOVERY_BINDING_MISMATCH');
      }
      if (priorRecovery && !localFailure
        || journal.verifiedNoWireRecoveries.filter(item => item.intentIdSha256 === intentIdSha256).length
          >= MAX_VIDEO_NO_WIRE_RECOVERIES_PER_INTENT) throw fail('MEDIA_INTENT_NO_WIRE_RECOVERY_LIMIT');
      const now = new Date().toISOString();
      const recovery = {
        eventId: randomUUID(),
        operation: 'media.video.create',
        operationIdSha256,
        intentIdSha256,
        ownerIdentityDigest: ownerDigest,
        intentDigest,
        requestDigest: operationEntry.requestDigest,
        proofDigest,
        payloadProfile,
        promptSha256,
        stage: proof.stage,
        requestStarted: false,
        responseReceived: false,
        httpStatus: null,
        responseBytesRead: 0,
        helperErrorCode: proof.helperErrorCode,
        errorClass: proof.errorClass,
        createdAt: now,
        ...(localFailure ? { preDispatchFailure: { ...preDispatchFailure } } : {}),
      };
      const changed = { ...current, state: 'prepared', updatedAt: now, reasonCode: null };
      const intents = [...journal.intents];
      intents[index] = changed;
      const verifiedNoWireRecoveries = [...journal.verifiedNoWireRecoveries, recovery];
      await atomicWrite(this.#filePath, { schemaVersion: SCHEMA_VERSION, updatedAt: now, intents, verifiedNoWireRecoveries });
      return { intentId, operation: changed.operation, state: changed.state, attemptNumber: changed.attemptNumber,
        recovered: true, recoveryRecorded: true };
    });
  }

  async get(intentId) {
    if (typeof intentId !== 'string' || !UUID_PATTERN.test(intentId)) throw fail('MEDIA_INTENT_ID_INVALID');
    return this.#locked(async () => {
      const journal = await readJournal(this.#filePath);
      const item = journal.intents.find(value => value.intentId === intentId);
      if (!item) throw fail('MEDIA_INTENT_NOT_FOUND');
      return {
        intentId: item.intentId,
        operation: item.operation,
        state: item.state,
        attemptNumber: item.attemptNumber,
        payloadProfile: item.payloadProfile,
        promptLength: item.promptLength,
        promptSha256: item.promptSha256 ?? null,
        ownerIdentityDigest: item.ownerIdentityDigest ?? null,
        reasonCode: item.reasonCode ?? null,
      };
    });
  }

  async status() {
    return this.#locked(async () => {
      const journal = await readJournal(this.#filePath);
      return {
        intents: journal.intents.map(item => ({
          operation: item.operation,
          state: item.state,
          attemptNumber: item.attemptNumber,
          httpStatus: item.httpStatus ?? null,
          reasonCode: item.reasonCode ?? null,
          readback: item.readback ?? null,
        })),
      };
    });
  }
}
