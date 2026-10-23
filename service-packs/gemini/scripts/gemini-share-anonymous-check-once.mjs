import { stdin, stdout } from 'node:process';
import { createHash } from 'node:crypto';
import { loadObservedContract } from '../src/contract.mjs';
import { parseBatchResponse, requireRpcResponse } from '../src/batch-response.mjs';
import { GEMINI_PUBLIC_SHARED_CONVERSATION_RPC } from '../src/conversation-lifecycle.mjs';

const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SHARE_ID = /^[A-Za-z0-9._~-]{8,256}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function wipe(value, depth = 0) {
  if (depth > 24 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (typeof value[i] === 'string') value[i] = '';
      else wipe(value[i], depth + 1);
    }
    value.length = 0;
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') value[key] = '';
    else wipe(child, depth + 1);
  }
}

async function readEnvelope() {
  if (stdin.isTTY === true) fail('ANONYMOUS_SHARE_ENVELOPE_REQUIRED');
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > MAX_ENVELOPE_BYTES) fail('ANONYMOUS_SHARE_ENVELOPE_TOO_LARGE');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) fail('ANONYMOUS_SHARE_ENVELOPE_REQUIRED');
  const raw = Buffer.concat(chunks, length);
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); }
  catch { raw.fill(0); fail('ANONYMOUS_SHARE_ENVELOPE_INVALID'); }
  raw.fill(0);
  const allowed = new Set(['shareUrls', 'taskTitle', 'taskMarker', 'batchContext', 'requestHeaders']);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).some((key) => !allowed.has(key))
      || !Array.isArray(envelope.shareUrls) || envelope.shareUrls.length !== 2
      || envelope.shareUrls.some((url) => typeof url !== 'string' || url.length > 2048)
      || typeof envelope.taskTitle !== 'string' || !envelope.taskTitle.trim() || envelope.taskTitle.length > 160
      || typeof envelope.taskMarker !== 'string' || !envelope.taskMarker.trim() || envelope.taskMarker.length > 80
      || !envelope.batchContext || typeof envelope.batchContext !== 'object' || Array.isArray(envelope.batchContext)
      || !Array.isArray(envelope.requestHeaders) || envelope.requestHeaders.length !== 2
      || envelope.requestHeaders.some((headers) => !headers || typeof headers !== 'object' || Array.isArray(headers))) {
    wipe(envelope);
    fail('ANONYMOUS_SHARE_ENVELOPE_INVALID');
  }
  return envelope;
}

function pathFamily(raw) {
  try {
    const url = new URL(raw);
    if (url.origin !== 'https://gemini.google.com') return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 2 || segments[0] !== 'share' || !SHARE_ID.test(segments[1])) return null;
    return { url, shareId: segments[1] };
  } catch { return null; }
}

function bindShareTemplate(template, shareId, depth = 0) {
  if (depth > 24) fail('ANONYMOUS_SHARE_TEMPLATE_INVALID');
  if (template === '{{shareId}}') return shareId;
  if (Array.isArray(template)) return template.map((value) => bindShareTemplate(value, shareId, depth + 1));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template)
    .map(([key, value]) => [key, bindShareTemplate(value, shareId, depth + 1)]));
  return template;
}

function containsTaskText(root, title, marker, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 100_000 || depth > 24) return { title: false, marker: false };
  if (typeof root === 'string') {
    const text = root;
    const trimmed = text.trimStart();
    if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length <= 2 * 1024 * 1024) {
      try { return containsTaskText(JSON.parse(trimmed), title, marker, depth + 1, budget); } catch { /* Plain text. */ }
    }
    return { title: text === title, marker: text.includes(marker) };
  }
  const children = Array.isArray(root) ? root : root && typeof root === 'object' ? Object.values(root) : [];
  return children.reduce((result, child) => {
    const next = containsTaskText(child, title, marker, depth + 1, budget);
    return { title: result.title || next.title, marker: result.marker || next.marker };
  }, { title: false, marker: false });
}

function unavailableSignal(text) {
  return /chat no longer exists|conversation (?:is|was) (?:unavailable|deleted)|unable to find (?:this )?(?:chat|conversation)|not found|더 이상 사용할 수 없|채팅을 찾을 수 없|대화를 찾을 수 없/i.test(text);
}

async function inspectUnauthenticatedGet(url, title, marker) {
  let response;
  let body = Buffer.alloc(0);
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      headers: { accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(30_000),
    });
    const array = await response.arrayBuffer();
    if (array.byteLength > MAX_RESPONSE_BYTES) fail('ANONYMOUS_SHARE_RESPONSE_TOO_LARGE');
    body = Buffer.from(array);
    const bodyText = body.toString('utf8');
    const content = containsTaskText(bodyText, title, marker);
    const unavailable = unavailableSignal(bodyText);
    return {
      httpStatus: response.status,
      contentType: (response.headers.get('content-type') || '').split(';', 1)[0].toLowerCase(),
      responseBytes: body.length,
      responseSha256: createHash('sha256').update(body).digest('hex'),
      taskTitleReturned: content.title,
      taskMarkerReturned: content.marker,
      unavailableMessagePresent: unavailable,
      anonymousContentDenied: !content.title && !content.marker && (response.status >= 400 || unavailable),
      cookieHeaderSent: false,
      authorizationHeaderSent: false,
    };
  } finally {
    body.fill(0);
    response = null;
  }
}

async function inspectUnauthenticatedRpc(contract, context, requestHeaders, shareId, url, title, marker) {
  const operation = contract.operations?.share_public_read;
  if (!operation || operation.request?.rpcId !== GEMINI_PUBLIC_SHARED_CONVERSATION_RPC) fail('ANONYMOUS_SHARE_CONTRACT_MISSING');
  const args = bindShareTemplate(operation.request.rpcArgsTemplate, shareId);
  const requestId = String(context.requestId);
  const queryValues = {
    rpcids: GEMINI_PUBLIC_SHARED_CONVERSATION_RPC,
    'source-path': context.sourcePath,
    bl: context.buildLabel,
    'f.sid': context.fSid,
    hl: context.locale,
    _reqid: requestId,
    rt: context.requestType,
  };
  const query = new URLSearchParams(operation.request.queryKeys.map((name) => [name, queryValues[name]]));
  const call = [GEMINI_PUBLIC_SHARED_CONVERSATION_RPC, JSON.stringify(args), null, 'generic'];
  const form = new URLSearchParams(operation.request.bodyFieldNames.map((name) => [
    name, name === 'f.req' ? JSON.stringify([[call]]) : context.at,
  ]));
  const headers = {};
  for (const name of ['accept', 'content-type', 'origin', 'referer', 'x-same-domain', 'user-agent']) {
    if (typeof requestHeaders[name] === 'string') headers[name] = requestHeaders[name];
  }
  headers['content-type'] = operation.request.contentType;
  headers.origin = 'https://gemini.google.com';
  headers.referer = url;
  headers['x-same-domain'] = requestHeaders['x-same-domain'] || '1';
  const target = `${operation.request.origin}${operation.request.path}?${query.toString()}`;
  let response;
  let body = Buffer.alloc(0);
  try {
    response = await fetch(target, {
      method: operation.request.method,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      headers,
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const array = await response.arrayBuffer();
    if (array.byteLength > MAX_RESPONSE_BYTES) fail('ANONYMOUS_SHARE_RESPONSE_TOO_LARGE');
    body = Buffer.from(array);
    let data = null;
    let rpcResponseFound = false;
    let parseError = false;
    try {
      const frames = parseBatchResponse(body, {
        lengthUnit: operation.response.frameLengthUnit,
        frameLengthOverheadUnits: operation.response.frameLengthOverheadUnits,
      });
      data = requireRpcResponse(frames, GEMINI_PUBLIC_SHARED_CONVERSATION_RPC).data;
      rpcResponseFound = true;
    } catch { parseError = true; }
    const content = data === null ? { title: false, marker: false } : containsTaskText(data, title, marker);
    const dataText = data === null ? '' : JSON.stringify(data);
    const unavailable = unavailableSignal(dataText);
    if (data && typeof data === 'object') wipe(data);
    return {
      httpStatus: response.status,
      contentType: (response.headers.get('content-type') || '').split(';', 1)[0].toLowerCase(),
      responseBytes: body.length,
      responseSha256: createHash('sha256').update(body).digest('hex'),
      rpcResponseFound,
      parseError,
      taskTitleReturned: content.title,
      taskMarkerReturned: content.marker,
      unavailableMessagePresent: unavailable,
      anonymousContentDenied: !content.title && !content.marker && (response.status >= 400 || unavailable || parseError),
      cookieHeaderSent: false,
      authorizationHeaderSent: false,
    };
  } finally {
    body.fill(0);
    response = null;
  }
}

export async function runAnonymousShareCheck(envelope) {
  const contract = await loadObservedContract();
  const checks = [];
  for (let index = 0; index < envelope.shareUrls.length; index += 1) {
    const target = pathFamily(envelope.shareUrls[index]);
    if (!target) fail('ANONYMOUS_SHARE_URL_INVALID');
    const get = await inspectUnauthenticatedGet(envelope.shareUrls[index], envelope.taskTitle, envelope.taskMarker);
    const rpc = await inspectUnauthenticatedRpc(contract, envelope.batchContext, envelope.requestHeaders[index],
      target.shareId, envelope.shareUrls[index], envelope.taskTitle, envelope.taskMarker);
    checks.push({ shareIdLength: target.shareId.length, get, rpc });
  }
  return Object.freeze({
    shareUrlsChecked: checks.length,
    allCookiesOmitted: checks.every((item) => !item.get.cookieHeaderSent && !item.rpc.cookieHeaderSent),
    allAuthorizationOmitted: checks.every((item) => !item.get.authorizationHeaderSent && !item.rpc.authorizationHeaderSent),
    allAnonymousReadsRejected: checks.every((item) => item.get.anonymousContentDenied && item.rpc.anonymousContentDenied),
    checks,
  });
}

async function main() {
  let envelope;
  try {
    envelope = await readEnvelope();
    stdout.write(`${JSON.stringify(await runAnonymousShareCheck(envelope))}\n`);
    return 0;
  } finally {
    wipe(envelope);
  }
}

main().catch((error) => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code : 'ANONYMOUS_SHARE_CHECK_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
