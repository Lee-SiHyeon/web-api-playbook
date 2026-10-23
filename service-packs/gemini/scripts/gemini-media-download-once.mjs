#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { loadObservedContract } from '../src/contract.mjs';
import { GeminiWebClient } from '../src/client.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    length += chunk.length;
    if (length > MAX_INPUT_BYTES) throw Object.assign(new Error('too_large'), { code: 'MEDIA_INPUT_TOO_LARGE' });
    chunks.push(Buffer.from(chunk));
  }
  if (!length) throw Object.assign(new Error('empty'), { code: 'MEDIA_INPUT_REQUIRED' });
  const raw = Buffer.concat(chunks, length);
  try { return JSON.parse(raw.toString('utf8')); }
  finally { raw.fill(0); }
}

function clearStrings(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
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
  const input = await readInput();
  const contract = await loadObservedContract();
  const client = new GeminiWebClient({ contract });
  try {
    const result = await client.downloadMediaOnce(input);
    stdout.write(JSON.stringify({
      phase: 'direct_http_media_download',
      status: 'verified',
      httpStatus: result.httpStatus,
      contentType: result.contentType,
      mime: result.mime,
      capability: result.capability,
      bytes: result.bytes,
      sha256: result.sha256,
      mimeMagicMatched: result.mimeMagicMatched,
      independentFileReadback: result.independentFileReadback,
      credentialForwarding: result.credentialForwarding,
      observedRequestHeaderNamesForwarded: result.observedRequestHeaderNamesForwarded,
      redirects: result.redirects,
      artifact: result.artifact,
      sourceUrlPersisted: false,
      cookieValuesPersisted: false,
    }));
  } finally {
    client.transport.session = null;
    clearStrings(input);
  }
}

main().catch((error) => {
  stdout.write(JSON.stringify({
    phase: 'direct_http_media_download',
    status: 'failed',
    errorCode: typeof error?.code === 'string' ? error.code : 'MEDIA_DOWNLOAD_FAILED',
    errorClass: error?.constructor?.name ?? 'Error',
    httpStatus: Number.isInteger(error?.details?.httpStatus) ? error.details.httpStatus : null,
    sourceRef: typeof error?.details?.origin === 'string' && typeof error?.details?.pathFamily === 'string'
      ? { origin: error.details.origin, pathFamily: error.details.pathFamily,
          queryKeyNames: Array.isArray(error.details.queryKeyNames) ? error.details.queryKeyNames : [] }
      : null,
    redirectProof: error?.details?.redirectProof && typeof error.details.redirectProof === 'object'
      ? { referenceMatched: error.details.redirectProof.referenceMatched === true,
          fromIdentityMatched: error.details.redirectProof.fromIdentityMatched === true,
          toIdentityMatched: error.details.redirectProof.toIdentityMatched === true,
          targetOriginAllowed: error.details.targetOriginAllowed === true }
      : null,
    sourceUrlPersisted: false,
    cookieValuesPersisted: false,
  }));
  process.exitCode = 1;
});
