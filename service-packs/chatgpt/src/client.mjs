import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ChatGPTWebError } from './errors.mjs';
import { getOperation, loadRegistry, materializeRequest, operationSummary, PRIMARY_ORIGIN, validateRegistry } from './contracts.mjs';
import { ChatGPTHttpTransport, assertResponseHead, readBoundedBody } from './http-transport.mjs';
import { MutationJournal } from './journal.mjs';
import { downloadValidatedMedia, normalizeMime, prepareMediaUpload, validateMediaBytes } from './media.mjs';
import { ChatGPTSessionProvider } from './session.mjs';
import { parseSse } from './sse.mjs';

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function requestFingerprint(operation, request, { mediaBytes, fields } = {}) {
  const hash = createHash('sha256');
  hash.update(operation.method);
  hash.update('\0');
  hash.update(request.url.pathname);
  hash.update(request.url.search);
  hash.update('\0');
  if (mediaBytes) hash.update(mediaBytes);
  else if (request.body instanceof URLSearchParams) hash.update(request.body.toString());
  else if (typeof request.body === 'string') hash.update(request.body);
  else if (request.body && Buffer.isBuffer(request.body)) hash.update(request.body);
  if (fields) hash.update(jsonBytes(fields));
  return hash.digest();
}

function requestBodyByteLength(request, mediaBytes) {
  if (mediaBytes) return mediaBytes.length;
  if (request.body instanceof URLSearchParams) return Buffer.byteLength(request.body.toString());
  if (typeof request.body === 'string') return Buffer.byteLength(request.body);
  if (Buffer.isBuffer(request.body)) return request.body.length;
  return 0;
}

function safeResult(operation, response, mimeType, body) {
  return { operationId: operation.id, httpStatus: response.status, mimeType,
    responseKind: operation.response.kind, body };
}

export class ChatGPTWebClient {
  constructor({ registry, sessionProvider = new ChatGPTSessionProvider(), fetchImpl = globalThis.fetch,
    journal = new MutationJournal(), timeoutMs = 120_000 } = {}) {
    this.registry = validateRegistry(registry);
    this.sessionProvider = sessionProvider;
    this.transport = new ChatGPTHttpTransport({ fetchImpl, sessionProvider });
    this.journal = journal;
    this.timeoutMs = timeoutMs;
  }

  static async create(options = {}) {
    const registry = options.registry || await loadRegistry(options.registryPath);
    return new ChatGPTWebClient({ ...options, registry });
  }

  async status() {
    const session = await this.sessionProvider.status();
    return {
      service: 'chatgpt-web',
      primaryOrigin: PRIMARY_ORIGIN,
      ...operationSummary(this.registry),
      session: { providerReady: session.providerReady, credentialPresent: session.credentialPresent,
        authenticated: false, verification: 'not_checked' },
      browserUsed: false,
      liveReplay: false,
    };
  }

  getOperation(operationId) {
    this.registry = validateRegistry(this.registry);
    return getOperation(this.registry, operationId);
  }

  prepare(operationId, inputs = {}) {
    const operation = this.getOperation(operationId);
    return { operation, request: materializeRequest(operation, inputs), inputs };
  }

  async sendRead(operationId, inputs = {}) {
    const { operation, request } = this.prepare(operationId, inputs);
    if (!['read', 'media-download'].includes(operation.kind)) throw new ChatGPTWebError('OPERATION_KIND_MISMATCH', { operationId });
    const response = await this.transport.send(operation, request, { timeoutMs: this.timeoutMs });
    const { mimeType, empty } = assertResponseHead(response, operation);
    if (operation.response.kind === 'sse') throw new ChatGPTWebError('USE_STREAM_API', { operationId });
    if (operation.response.kind === 'media' || operation.kind === 'media-download') throw new ChatGPTWebError('USE_DOWNLOAD_API', { operationId });
    if (empty) return safeResult(operation, response, mimeType, null);
    const bytes = await readBoundedBody(response, operation.response.maxBytes);
    let body;
    if (operation.response.kind === 'json') {
      try { body = JSON.parse(bytes.toString('utf8')); }
      catch { throw new ChatGPTWebError('RESPONSE_JSON_INVALID', { operationId, httpStatus: response.status, mimeType }); }
    } else body = bytes.toString('utf8');
    return safeResult(operation, response, mimeType, body);
  }

  async streamRead(operationId, inputs = {}) {
    const { operation, request } = this.prepare(operationId, inputs);
    if (operation.kind !== 'read' || operation.response.kind !== 'sse') throw new ChatGPTWebError('OPERATION_KIND_MISMATCH', { operationId });
    const response = await this.transport.send(operation, request, { timeoutMs: this.timeoutMs });
    const head = assertResponseHead(response, operation);
    return { operationId, httpStatus: response.status, mimeType: head.mimeType,
      events: parseSse(response.body, { maxEventBytes: Math.min(operation.response.maxBytes, 10_000_000) }) };
  }

  async #sendMutation(operationId, inputs, { bodyOverride, mediaBytes, fields, requestOverride } = {}) {
    const { operation, request: builtRequest } = this.prepare(operationId, inputs);
    if (!['mutation', 'media-upload'].includes(operation.kind)) throw new ChatGPTWebError('OPERATION_KIND_MISMATCH', { operationId });
    const request = requestOverride || builtRequest;
    const readyRequest = await this.transport.prepareRequest(operation, request);
    const requestHashBytes = requestFingerprint(operation, request, { mediaBytes, fields });
    const targetValue = operation.targetInput ? inputs[operation.targetInput] : null;
    const journalRecord = await this.journal.begin({ operationId, requestBytes: requestHashBytes, targetValue });
    await this.journal.markDispatchStarted(journalRecord.journalId);
    let response;
    try {
      response = await this.transport.send(operation, readyRequest, { timeoutMs: this.timeoutMs, bodyOverride, prepared: true });
      const head = assertResponseHead(response, operation);
      if (operation.response.kind === 'sse') {
        const events = this.#journalledEvents(operation, response, journalRecord.journalId, head);
        return { operationId, journalId: journalRecord.journalId, state: 'dispatch_started',
          httpStatus: response.status, mimeType: head.mimeType, events };
      }
      let body = null;
      let byteLength = 0;
      if (!head.empty) {
        const bytes = await readBoundedBody(response, operation.response.maxBytes);
        byteLength = bytes.length;
        if (operation.response.kind === 'json') {
          try { body = JSON.parse(bytes.toString('utf8')); }
          catch { throw new ChatGPTWebError('RESPONSE_JSON_INVALID', { operationId, httpStatus: response.status, mimeType: head.mimeType }); }
        } else if (operation.response.kind === 'text') body = bytes.toString('utf8');
        else throw new ChatGPTWebError('MUTATION_MEDIA_RESPONSE_UNSUPPORTED', { operationId });
      }
      await this.journal.markResponseReceived(journalRecord.journalId, {
        httpStatus: response.status, mimeType: head.mimeType, byteLength,
      });
      return { operationId, journalId: journalRecord.journalId, state: 'response_received',
        httpStatus: response.status, mimeType: head.mimeType, body };
    } catch (error) {
      await this.journal.markOutcomeUnknown(journalRecord.journalId, {
        ...(Number.isInteger(error?.details?.httpStatus) ? { httpStatus: error.details.httpStatus } : {}),
        ...(typeof error?.details?.mimeType === 'string' ? { mimeType: error.details.mimeType } : {}),
      }).catch(() => {});
      if (error instanceof ChatGPTWebError) {
        error.details = { ...error.details, journalId: journalRecord.journalId };
        throw error;
      }
      throw new ChatGPTWebError('MUTATION_OUTCOME_UNKNOWN', { operationId, journalId: journalRecord.journalId });
    }
  }

  async *#journalledEvents(operation, response, journalId, head) {
    let completed = false;
    let totalBytes = 0;
    const source = parseSse(response.body, { maxEventBytes: Math.min(operation.response.maxBytes, 10_000_000) });
    try {
      for await (const event of source) {
        totalBytes += Buffer.byteLength(event.data || '', 'utf8');
        if (totalBytes > operation.response.maxBytes) throw new ChatGPTWebError('RESPONSE_TOO_LARGE', { byteLength: totalBytes });
        yield event;
      }
      completed = true;
      await this.journal.markResponseReceived(journalId, { httpStatus: response.status,
        mimeType: head.mimeType, byteLength: totalBytes });
    } catch {
      await this.journal.markOutcomeUnknown(journalId).catch(() => {});
      throw new ChatGPTWebError('MUTATION_STREAM_OUTCOME_UNKNOWN', { operationId: operation.id, journalId });
    } finally {
      if (!completed) await this.journal.markOutcomeUnknown(journalId).catch(() => {});
    }
  }

  async sendMutation(operationId, inputs = {}) {
    const operation = this.getOperation(operationId);
    if (operation.kind !== 'mutation') throw new ChatGPTWebError('OPERATION_KIND_MISMATCH', { operationId });
    return this.#sendMutation(operationId, inputs);
  }

  async uploadMedia(operationId, inputs, filePath) {
    const { operation, request } = this.prepare(operationId, inputs);
    if (operation.kind !== 'media-upload') throw new ChatGPTWebError('OPERATION_KIND_MISMATCH', { operationId });
    const media = await prepareMediaUpload(filePath, operation.request.media);
    let bodyOverride;
    let fields = {};
    const headers = new Headers(request.headers);
    if (operation.request.encoding === 'binary') {
      if (headers.has('content-type') && normalizeMime(headers.get('content-type')) !== media.mimeType) {
        throw new ChatGPTWebError('MEDIA_MIME_REJECTED', { operationId, mimeType: media.mimeType });
      }
      headers.set('content-type', media.mimeType);
      bodyOverride = media.bytes;
      request.headers = headers;
    } else {
      if (headers.has('content-type')) throw new ChatGPTWebError('CONTRACT_INVALID', { operationId, reason: 'multipart-content-type' });
      const form = new FormData();
      fields = operation.request.textFields
        ? this.#bindUploadFields(operation.request.textFields, inputs)
        : {};
      for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
      const filename = operation.request.media.filenameInput ? String(inputs[operation.request.media.filenameInput]) : media.filename;
      if (!filename || /[\r\n\0]/.test(filename) || /[/\\]/.test(filename)) throw new ChatGPTWebError('MEDIA_FILENAME_INVALID');
      form.append(operation.request.media.fieldName, new Blob([media.bytes], { type: media.mimeType }), filename);
      bodyOverride = form;
    }
    return this.#sendMutation(operationId, inputs, { bodyOverride, mediaBytes: media.bytes, fields,
      requestOverride: request });
  }

  #bindUploadFields(template, inputs) {
    if (Array.isArray(template)) return template.map((value) => this.#bindUploadFields(value, inputs));
    if (!template || typeof template !== 'object') return template;
    if (Object.keys(template).length === 1 && typeof template.$input === 'string') return inputs[template.$input];
    const result = Object.create(null);
    for (const [key, value] of Object.entries(template)) result[key] = this.#bindUploadFields(value, inputs);
    return result;
  }

  async downloadMedia(operationId, inputs, outputPath) {
    const { operation, request } = this.prepare(operationId, inputs);
    if (operation.kind !== 'media-download' || operation.response.kind !== 'media') {
      throw new ChatGPTWebError('OPERATION_KIND_MISMATCH', { operationId });
    }
    const response = await this.transport.send(operation, request, { timeoutMs: this.timeoutMs });
    assertResponseHead(response, operation);
    return downloadValidatedMedia(response, { outputPath, media: operation.response.media,
      maxBytes: operation.response.maxBytes });
  }

  async reconcileMutation(journalId, { readbackOperationId, inputs = {}, matches } = {}) {
    if (typeof matches !== 'function') throw new ChatGPTWebError('RECONCILIATION_MATCHER_REQUIRED');
    const record = await this.journal.get(journalId);
    const writeOperation = this.getOperation(record.operationId);
    const readbackId = readbackOperationId || writeOperation.readbackOperationId;
    if (!readbackId || (writeOperation.readbackOperationId && readbackId !== writeOperation.readbackOperationId)) {
      throw new ChatGPTWebError('RECONCILIATION_CONTRACT_NOT_CAPTURED', { operationId: writeOperation.id });
    }
    const readbackOperation = this.getOperation(readbackId);
    if (readbackOperation.kind !== 'read') throw new ChatGPTWebError('RECONCILIATION_CONTRACT_INVALID', { operationId: readbackId });
    const result = await this.sendRead(readbackId, inputs);
    let outcome;
    try { outcome = await matches(result.body, record); } catch { outcome = null; }
    const normalized = outcome === true ? 'present' : outcome === false ? 'absent' : 'ambiguous';
    const updated = await this.journal.recordReconciliation(journalId, {
      outcome: normalized,
      authoritative: normalized === 'absent' && writeOperation.readbackAuthoritativeForAbsence === true,
      readbackOperationId: readbackId,
    });
    return { journalId, state: updated.state, outcome: normalized,
      authoritative: updated.authoritative === true, readbackOperationId: readbackId };
  }

  async listJournals() {
    return this.journal.listSafe();
  }
}
