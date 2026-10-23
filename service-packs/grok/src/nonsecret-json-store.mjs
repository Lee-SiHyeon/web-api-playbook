import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fail } from './errors.mjs';
import { isGrokVideoNoWireProof, isGrokVideoNoWireRecovery,
  validateGrokVideoNoWireEntries } from './grok-media-no-wire-proof.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const STATES = new Set(['sending','accepted','outcome_unknown','processing','completed','failed','rejected','blocked_security_boundary','needs_review']);
const ENTRY_KEYS = new Set(['localOperationId','contractId','state','createdAt','updatedAt','requestDigest','intentDigest','serviceJobIdDigest','httpStatus','reasonCode','attemptCount','reconciledBy','recoveryOfRequestDigest','conversationBindingDigest','parentBindingDigest','noBusinessRecoveryProof','videoNoWireProof','videoNoWireRecovery']);
const LOCK_WAIT_MS = 5000;
const WSS_NO_BUSINESS_PROOF_KEYS = Object.freeze([
  'controlFrameSent', 'serverSessionAcknowledgementObserved', 'businessFrameBoundToServerSession',
  'directBusinessFrameSent', 'browserBusinessFramesDelivered', 'historyUnchanged', 'ownerVerified',
  'sameConversationTarget', 'sameParentTarget', 'targetAssistantUnchanged', 'userResponseCountUnchanged',
]);

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

function defaultFilePath() {
  return path.join(os.homedir(), '.nad-scratch', 'grok-web-xhr-client', 'operations.json');
}

function validateJournalDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.kind !== 'grok-operation-journal' || value.schemaVersion !== 1
    || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES
    || Object.keys(value).some(key => !['kind','schemaVersion','entries'].includes(key))) {
    throw fail('NONSECRET_JOURNAL_SHAPE_INVALID');
  }
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !ENTRY_KEYS.has(key))
      || !UUID.test(entry.localOperationId)
      || typeof entry.contractId !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(entry.contractId)
      || !STATES.has(entry.state)
      || !Number.isFinite(Date.parse(entry.createdAt)) || !Number.isFinite(Date.parse(entry.updatedAt))
      || !SHA256.test(entry.requestDigest)
      || (entry.intentDigest !== undefined && entry.intentDigest !== null && !SHA256.test(entry.intentDigest))
      || (entry.serviceJobIdDigest !== null && !SHA256.test(entry.serviceJobIdDigest))
      || (entry.httpStatus !== null && (!Number.isInteger(entry.httpStatus) || entry.httpStatus < 100 || entry.httpStatus > 599))
      || (entry.reasonCode !== null && (typeof entry.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(entry.reasonCode)))
      || entry.attemptCount !== 1
      || (entry.reconciledBy !== null && (typeof entry.reconciledBy !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(entry.reconciledBy)))
      || (entry.recoveryOfRequestDigest !== undefined && !SHA256.test(entry.recoveryOfRequestDigest))
      || (entry.conversationBindingDigest !== undefined && !SHA256.test(entry.conversationBindingDigest))
      || (entry.parentBindingDigest !== undefined && !SHA256.test(entry.parentBindingDigest))
      || (entry.noBusinessRecoveryProof !== undefined && !validWssNoBusinessProof(entry.noBusinessRecoveryProof))) {
      throw fail('NONSECRET_JOURNAL_ENTRY_INVALID');
    }
    if (entry.noBusinessRecoveryProof !== undefined && (entry.contractId !== 'chat.regenerate.wss'
      || entry.state !== 'rejected' || entry.httpStatus !== 101 || entry.reasonCode !== 'CONVERSATION_WSS_FRAME_NOT_SENT')) {
      throw fail('NONSECRET_JOURNAL_ENTRY_INVALID');
    }
    if (entry.recoveryOfRequestDigest !== undefined && (entry.contractId !== 'chat.regenerate.wss'
      || !SHA256.test(entry.conversationBindingDigest) || !SHA256.test(entry.parentBindingDigest))) {
      throw fail('NONSECRET_JOURNAL_ENTRY_INVALID');
    }
    if (entry.videoNoWireProof !== undefined && (entry.contractId !== 'media.video.create'
      || !isGrokVideoNoWireProof(entry.videoNoWireProof, {
        intentDigest: entry.intentDigest,
        requestDigest: entry.requestDigest,
      }) || entry.state !== 'rejected' || entry.reasonCode !== 'MEDIA_VIDEO_CFFI_PREFLIGHT_FAILED'
      || entry.httpStatus !== null)) throw fail('NONSECRET_JOURNAL_ENTRY_INVALID');
    if (entry.videoNoWireRecovery !== undefined && (entry.contractId !== 'media.video.create'
      || !isGrokVideoNoWireRecovery(entry.videoNoWireRecovery))) throw fail('NONSECRET_JOURNAL_ENTRY_INVALID');
  }
  if (!validateGrokVideoNoWireEntries(value.entries)) throw fail('NONSECRET_JOURNAL_ENTRY_INVALID');
  return value;
}

export class NonSecretJsonFileStore {
  #filePath;
  #directory;
  #tail = Promise.resolve();

  constructor({ filePath = defaultFilePath() } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) throw fail('NONSECRET_JOURNAL_PATH_INVALID');
    this.#filePath = path.resolve(filePath);
    this.#directory = path.dirname(this.#filePath);
  }

  get filePath() { return this.#filePath; }
  get provider() { return 'local-nonsecret-json-file'; }

  async #readUnlocked() {
    let bytes;
    try { bytes = await readFile(this.#filePath); } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw fail('NONSECRET_JOURNAL_READ_FAILED');
    }
    if (!bytes.length || bytes.length > MAX_BYTES) throw fail('NONSECRET_JOURNAL_SIZE_INVALID');
    try { return validateJournalDocument(JSON.parse(bytes.toString('utf8'))); }
    catch (error) {
      if (error?.code?.startsWith('NONSECRET_JOURNAL_')) throw error;
      throw fail('NONSECRET_JOURNAL_JSON_INVALID');
    } finally { bytes.fill(0); }
  }

  async read() { return this.#readUnlocked(); }

  async #writeUnlocked(value) {
    const validated = validateJournalDocument(value);
    const bytes = Buffer.from(JSON.stringify(validated), 'utf8');
    if (!bytes.length || bytes.length > MAX_BYTES) {
      bytes.fill(0);
      throw fail('NONSECRET_JOURNAL_SIZE_INVALID');
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700).catch(() => {});
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.#filePath);
      await chmod(this.#filePath, 0o600);
    } catch {
      throw fail('NONSECRET_JOURNAL_WRITE_FAILED');
    } finally {
      bytes.fill(0);
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
    return { stored: true, provider: this.provider, persistent: true };
  }

  async write(value) {
    return this.transact(() => ({ value, result: { stored: true, provider: this.provider, persistent: true } }));
  }

  async #acquireLock() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700).catch(() => {});
    const lockPath = `${this.#filePath}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
        return async () => { await handle.close().catch(() => {}); await rm(lockPath, { force: true }).catch(() => {}); };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw fail('NONSECRET_JOURNAL_LOCK_FAILED');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    throw fail('NONSECRET_JOURNAL_BUSY');
  }

  async transact(mutator) {
    if (typeof mutator !== 'function') throw fail('NONSECRET_JOURNAL_MUTATOR_INVALID');
    const apply = async () => {
      const release = await this.#acquireLock();
      try {
        const current = await this.#readUnlocked();
        const outcome = mutator(current);
        if (outcome && typeof outcome.then === 'function') throw fail('NONSECRET_JOURNAL_MUTATOR_INVALID');
        if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)
          || !Object.hasOwn(outcome, 'result') || !Object.hasOwn(outcome, 'value')) {
          throw fail('NONSECRET_JOURNAL_MUTATOR_INVALID');
        }
        await this.#writeUnlocked(outcome.value);
        return outcome.result;
      } finally { await release(); }
    };
    const pending = this.#tail.then(apply);
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async clear() {
    return this.transact(() => ({ value: { kind: 'grok-operation-journal', schemaVersion: 1, entries: [] }, result: { cleared: true } }));
  }

  async status() {
    const value = await this.read();
    return { available: value !== null, provider: this.provider, persistent: true, entryCount: value?.entries?.length ?? 0 };
  }
}
