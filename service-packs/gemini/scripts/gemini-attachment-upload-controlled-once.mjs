#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { loadObservedContract } from '../src/contract.mjs';
import { GeminiWebClient } from '../src/client.mjs';
import { readAttachmentUploadEnvelopeFromStdin } from '../src/session.mjs';

const MAX_LINE_BYTES = 48 * 1024 * 1024;

function clearStrings(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = '';
      else clearStrings(value[index], seen);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') value[key] = '';
    else clearStrings(value[key], seen);
  }
}

async function readLine(iterator) {
  const next = await iterator.next();
  if (next.done || typeof next.value !== 'string' || Buffer.byteLength(next.value) > MAX_LINE_BYTES) {
    throw Object.assign(new Error('ATTACHMENT_UPLOAD_PROTOCOL_INPUT_INVALID'), { code: 'ATTACHMENT_UPLOAD_PROTOCOL_INPUT_INVALID' });
  }
  return next.value;
}

function parseContinuationEnvelope(line, maxFileBytes) {
  let raw;
  try { raw = JSON.parse(line); }
  catch { throw Object.assign(new Error('ATTACHMENT_UPLOAD_CONTINUATION_INVALID'), { code: 'ATTACHMENT_UPLOAD_CONTINUATION_INVALID' }); }
  line = '';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).length !== 1 || !raw.continuationCapture
      || typeof raw.continuationCapture !== 'object' || Array.isArray(raw.continuationCapture)) {
    clearStrings(raw);
    throw Object.assign(new Error('ATTACHMENT_UPLOAD_CONTINUATION_INVALID'), { code: 'ATTACHMENT_UPLOAD_CONTINUATION_INVALID' });
  }
  const input = raw.continuationCapture;
  const allowed = new Set(['url', 'method', 'headerNames', 'headers', 'bodyBase64']);
  if (Object.keys(input).some((key) => !allowed.has(key))
      || typeof input.url !== 'string' || input.url.length > 8192 || input.method !== 'POST'
      || !Array.isArray(input.headerNames) || input.headerNames.length < 2 || input.headerNames.length > 96
      || input.headerNames.some((name) => typeof name !== 'string' || name.length > 128)
      || !input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers)
      || Object.keys(input.headers).length > 96
      || Object.entries(input.headers).some(([name, value]) => typeof name !== 'string' || typeof value !== 'string'
        || name.length > 128 || value.length > 8192 || /[\r\n\0]/.test(value))
      || typeof input.bodyBase64 !== 'string' || input.bodyBase64.length > Math.ceil(maxFileBytes * 4 / 3) + 16) {
    clearStrings(raw);
    throw Object.assign(new Error('ATTACHMENT_UPLOAD_CONTINUATION_INVALID'), { code: 'ATTACHMENT_UPLOAD_CONTINUATION_INVALID' });
  }
  const body = Buffer.from(input.bodyBase64, 'base64');
  if (!body.length || body.length > maxFileBytes || body.toString('base64') !== input.bodyBase64) {
    body.fill(0);
    clearStrings(raw);
    throw Object.assign(new Error('ATTACHMENT_UPLOAD_CONTINUATION_INVALID'), { code: 'ATTACHMENT_UPLOAD_CONTINUATION_INVALID' });
  }
  const capture = {
    url: input.url,
    method: input.method,
    headerNames: [...input.headerNames],
    headers: { ...input.headers },
    body,
  };
  clearStrings(raw);
  return capture;
}

async function main() {
  if (process.env.GEMINI_UPLOAD_SESSION_ORCHESTRATOR !== '1' || stdin.isTTY === true || stdout.isTTY === true) {
    throw Object.assign(new Error('ORCHESTRATOR_PIPE_REQUIRED'), { code: 'ORCHESTRATOR_PIPE_REQUIRED' });
  }
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let firstLine = '';
  let first;
  let envelope;
  let client;
  try {
    firstLine = await readLine(iterator);
    try { first = JSON.parse(firstLine); }
    catch { throw Object.assign(new Error('ATTACHMENT_UPLOAD_ENVELOPE_INVALID'), { code: 'ATTACHMENT_UPLOAD_ENVELOPE_INVALID' }); }
    firstLine = '';
    if (!first || typeof first !== 'object' || Array.isArray(first)
        || Object.keys(first).some((key) => !['expectedOwner', 'callerIntent', 'journalRoot', 'session', 'capture', 'uploadCookies', 'file'].includes(key))
        || typeof first.expectedOwner !== 'string' || typeof first.callerIntent !== 'string'
        || (first.journalRoot !== undefined && typeof first.journalRoot !== 'string')) {
      clearStrings(first);
      throw Object.assign(new Error('ATTACHMENT_UPLOAD_ENVELOPE_INVALID'), { code: 'ATTACHMENT_UPLOAD_ENVELOPE_INVALID' });
    }
    const callerIntent = first.callerIntent;
    const journalRoot = first.journalRoot;
    const contract = await loadObservedContract();
    const safeEnvelopeInput = {
      expectedOwner: first.expectedOwner,
      session: first.session,
      capture: first.capture,
      uploadCookies: first.uploadCookies,
      file: first.file,
    };
    envelope = await readAttachmentUploadEnvelopeFromStdin(contract, {
      input: Readable.from([Buffer.from(JSON.stringify(safeEnvelopeInput))]),
    });
    clearStrings(first);
    first = null;
    client = new GeminiWebClient({ contract, session: envelope.session });
    const result = await client.uploadAttachmentOnce({
      expectedOwner: envelope.expectedOwner,
      callerIntent,
      capture: envelope.capture,
      uploadCookies: envelope.uploadCookies,
      file: envelope.file,
      journalRoot,
      continuationCaptureProvider: async (start) => {
        const startEvent = {
          event: 'start-response',
          httpStatus: start.httpStatus,
          uploadUrl: start.uploadUrl,
          responseHeaders: start.responseHeaders,
          responseBodyBase64: start.responseBody.toString('base64'),
        };
        stdout.write(JSON.stringify(startEvent) + '\n');
        clearStrings(startEvent);
        let continuationLine = await readLine(iterator);
        try { return parseContinuationEnvelope(continuationLine, envelope.file.body.length); }
        finally { continuationLine = ''; }
      },
    });
    stdout.write(JSON.stringify({ event: 'complete', result }) + '\n');
    return result.status === 'verified' ? 0 : 3;
  } finally {
    lines.close();
    if (client?.transport) client.transport.session = null;
    if (Buffer.isBuffer(envelope?.capture?.body)) envelope.capture.body.fill(0);
    if (Buffer.isBuffer(envelope?.file?.body)) envelope.file.body.fill(0);
    for (const cookie of envelope?.uploadCookies ?? []) cookie.value = '';
    for (const name of Object.keys(envelope?.capture?.headers ?? {})) envelope.capture.headers[name] = '';
    clearStrings(envelope);
    clearStrings(first);
    firstLine = '';
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code : 'ATTACHMENT_UPLOAD_FAILED';
  const details = error?.details && typeof error.details === 'object' ? error.details : {};
  const queryReadback = details.queryReadback && typeof details.queryReadback === 'object'
    ? details.queryReadback : null;
  stdout.write(JSON.stringify({
    event: 'error',
    errorCode: code,
    ...(Number.isInteger(details.directDispatchCount) ? { directDispatchCount: details.directDispatchCount } : {}),
    ...(Number.isInteger(details.startDispatchCount) ? { startDispatchCount: details.startDispatchCount } : {}),
    ...(Number.isInteger(details.transferDispatchCount) ? { transferDispatchCount: details.transferDispatchCount } : {}),
    ...(Number.isInteger(details.httpRequestCount) ? { httpRequestCount: details.httpRequestCount } : {}),
    ...(typeof details.stage === 'string' ? { stage: details.stage } : {}),
    ...(Number.isInteger(details.httpStatus) ? { httpStatus: details.httpStatus } : {}),
    ...(queryReadback ? { queryReadback: {
      httpStatus: queryReadback.httpStatus ?? null,
      uploadStatus: queryReadback.uploadStatus ?? null,
      sizeReceived: queryReadback.sizeReceived ?? null,
    } } : {}),
  }) + '\n');
  process.exitCode = 3;
}
