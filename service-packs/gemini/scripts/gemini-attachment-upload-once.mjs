#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { Readable } from 'node:stream';
import { loadObservedContract } from '../src/contract.mjs';
import { GeminiWebClient } from '../src/client.mjs';
import { readAttachmentUploadEnvelopeFromStdin } from '../src/session.mjs';

const MAX_INPUT_BYTES = 48 * 1024 * 1024;

async function readInput() {
  if (process.env.GEMINI_UPLOAD_ORCHESTRATOR !== '1' || stdin.isTTY === true || stdout.isTTY === true) {
    throw Object.assign(new Error('ORCHESTRATOR_PIPE_REQUIRED'), { code: 'ORCHESTRATOR_PIPE_REQUIRED' });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > MAX_INPUT_BYTES) throw Object.assign(new Error('ATTACHMENT_UPLOAD_ENVELOPE_TOO_LARGE'), { code: 'ATTACHMENT_UPLOAD_ENVELOPE_TOO_LARGE' });
    chunks.push(Buffer.from(bytes));
  }
  if (!length) throw Object.assign(new Error('ATTACHMENT_UPLOAD_ENVELOPE_STDIN_REQUIRED'), { code: 'ATTACHMENT_UPLOAD_ENVELOPE_STDIN_REQUIRED' });
  const raw = Buffer.concat(chunks, length);
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw Object.assign(new Error('ATTACHMENT_UPLOAD_ENVELOPE_INVALID'), { code: 'ATTACHMENT_UPLOAD_ENVELOPE_INVALID' }); }
  finally { raw.fill(0); }
}

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

async function main() {
  let rawInput;
  let envelope;
  let client;
  try {
    rawInput = await readInput();
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)
        || typeof rawInput.expectedOwner !== 'string'
        || typeof rawInput.callerIntent !== 'string'
        || Object.keys(rawInput).some((key) => ![
          'expectedOwner', 'callerIntent', 'journalRoot', 'session', 'capture', 'uploadCookies', 'file',
        ].includes(key))) {
      throw Object.assign(new Error('ATTACHMENT_UPLOAD_ENVELOPE_INVALID'), { code: 'ATTACHMENT_UPLOAD_ENVELOPE_INVALID' });
    }
    const contract = await loadObservedContract();
    const envelopeInput = {
      session: rawInput.session,
      capture: rawInput.capture,
      uploadCookies: rawInput.uploadCookies,
      file: rawInput.file,
      expectedOwner: rawInput.expectedOwner,
    };
    envelope = await readAttachmentUploadEnvelopeFromStdin(contract, {
      input: Readable.from([Buffer.from(JSON.stringify(envelopeInput))]),
    });
    client = new GeminiWebClient({ contract, session: envelope.session });
    const result = await client.uploadAttachmentOnce({
      expectedOwner: envelope.expectedOwner,
      callerIntent: rawInput.callerIntent,
      capture: envelope.capture,
      uploadCookies: envelope.uploadCookies,
      file: envelope.file,
      journalRoot: rawInput.journalRoot,
    });
    stdout.write(JSON.stringify({ status: result.outputStatus ?? result.status, result }) + '\n');
    return 0;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)
      ? error.code : 'ATTACHMENT_UPLOAD_FAILED';
    const details = error?.details && typeof error.details === 'object' ? error.details : {};
    stdout.write(JSON.stringify({
      status: 'failed',
      errorCode: code,
      ...(Number.isInteger(details.directDispatchCount) ? { directDispatchCount: details.directDispatchCount } : {}),
      ...(Number.isInteger(details.httpRequestCount) ? { httpRequestCount: details.httpRequestCount } : {}),
      ...(typeof details.stage === 'string' ? { stage: details.stage } : {}),
    }) + '\n');
    return 1;
  } finally {
    if (client?.transport) client.transport.session = null;
    if (Buffer.isBuffer(envelope?.capture?.body)) envelope.capture.body.fill(0);
    if (Buffer.isBuffer(envelope?.file?.body)) envelope.file.body.fill(0);
    for (const cookie of envelope?.uploadCookies ?? []) cookie.value = '';
    for (const name of Object.keys(envelope?.capture?.headers ?? {})) envelope.capture.headers[name] = '';
    clearStrings(rawInput);
  }
}

process.exitCode = await main();
