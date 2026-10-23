import { GeminiClientError } from './errors.mjs';
import { CREDENTIAL_NAME, SERVICE_ID, SERVICE_ORIGIN } from './constants.mjs';
import { stdin } from 'node:process';
import path from 'node:path';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertValue(value, label) {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\r\n\0]/.test(value)) {
    throw new GeminiClientError('SESSION_INVALID', label + ' is invalid.');
  }
  return value;
}

function validateRequestHeaders(input, contract) {
  if (input === undefined) return Object.freeze({});
  if (!isRecord(input)) throw new GeminiClientError('SESSION_INVALID', 'Captured Gemini request headers are invalid.');
  const result = {};
  for (const [operationName, values] of Object.entries(input)) {
    const operation = contract.operations?.[operationName];
    if (!operation || !isRecord(values)) {
      throw new GeminiClientError('SESSION_FIELD_UNOBSERVED', 'A captured request-header group is outside the observed contract.');
    }
    const allowed = new Set(operation.request.headerNames.map((name) => name.toLowerCase()));
    const headers = {};
    for (const [name, value] of Object.entries(values)) {
      const normalized = name.toLowerCase();
      if (!allowed.has(normalized) || ['cookie', 'authorization', 'proxy-authorization', 'host', 'content-length'].includes(normalized)) {
        throw new GeminiClientError('SESSION_FIELD_UNOBSERVED', 'A captured request header is outside the observed operation contract.');
      }
      if (Object.hasOwn(headers, normalized)) throw new GeminiClientError('SESSION_INVALID', 'A captured request header is duplicated.');
      headers[normalized] = assertValue(value, 'request header value');
    }
    result[operationName] = Object.freeze(headers);
  }
  return Object.freeze(result);
}

function validateBatchContext(input, contract) {
  if (input === undefined) return undefined;
  if (!isRecord(input) || !contract.operations?.history_list) {
    throw new GeminiClientError('SESSION_FIELD_UNOBSERVED', 'The batch context is outside the observed history contract.');
  }
  const at = assertValue(input.at, 'batch token');
  const fSid = assertValue(input.fSid, 'batch session value');
  const buildLabel = assertValue(input.buildLabel, 'batch build label');
  const locale = assertValue(input.locale, 'batch locale');
  const requestType = assertValue(input.requestType, 'batch response type');
  const sourcePath = assertValue(input.sourcePath, 'batch source path');
  const historyListArgs = input.historyListArgs;
  if (!/^\d{1,12}$/.test(String(input.requestId))
      || !/^[A-Za-z0-9._-]{1,256}$/.test(buildLabel)
      || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(locale)
      || !/^[A-Za-z0-9_-]{1,16}$/.test(requestType)
      || !sourcePath.startsWith('/') || sourcePath.startsWith('//') || sourcePath.includes('\\')
      || !Array.isArray(historyListArgs) || historyListArgs.length !== 3
      || !Number.isSafeInteger(historyListArgs[0]) || historyListArgs[0] < 1 || historyListArgs[0] > 200
      || historyListArgs[1] !== null || !Array.isArray(historyListArgs[2]) || historyListArgs[2].length !== 3
      || !Number.isSafeInteger(historyListArgs[2][0]) || historyListArgs[2][0] < 0 || historyListArgs[2][0] > 1000000
      || historyListArgs[2][1] !== null || !Number.isSafeInteger(historyListArgs[2][2])
      || historyListArgs[2][2] < 0 || historyListArgs[2][2] > 10) {
    throw new GeminiClientError('SESSION_INVALID', 'The captured Gemini batch context is malformed.');
  }
  return Object.freeze({
    at, fSid, buildLabel, locale, requestType, sourcePath, requestId: String(input.requestId),
    historyListArgs: Object.freeze([historyListArgs[0], null, Object.freeze([historyListArgs[2][0], null, historyListArgs[2][2]])]),
  });
}

export function validateSessionBundle(bundle, contract) {
  if (!isRecord(bundle) || bundle.version !== 1 || bundle.service !== SERVICE_ID
      || bundle.origin !== SERVICE_ORIGIN || !contract || contract.origin !== SERVICE_ORIGIN) {
    throw new GeminiClientError('SESSION_SCOPE_INVALID', 'The protected session is not scoped to Gemini web.');
  }
  if (contract.auth.origins.length !== 1 || contract.auth.origins[0] !== SERVICE_ORIGIN) {
    throw new GeminiClientError('SESSION_SCOPE_INVALID', 'The observed credential scope is not the Gemini web origin.');
  }
  if (typeof bundle.capturedAt !== 'string' || !Number.isFinite(Date.parse(bundle.capturedAt))) {
    throw new GeminiClientError('SESSION_INVALID', 'The protected session is missing its capture time.');
  }
  if (!Array.isArray(bundle.cookies) || !isRecord(bundle.headers)) {
    throw new GeminiClientError('SESSION_INVALID', 'The protected session must contain cookies and headers from the captured contract.');
  }
  const cookieNames = new Set(contract.auth.cookieNames);
  const seenCookies = new Set();
  const cookies = bundle.cookies.map((cookie) => {
    if (!isRecord(cookie) || !cookieNames.has(cookie.name) || seenCookies.has(cookie.name)) {
      throw new GeminiClientError('SESSION_FIELD_UNOBSERVED', 'The protected session contains a cookie outside the observed allowlist.');
    }
    seenCookies.add(cookie.name);
    const value = assertValue(cookie.value, 'cookie value');
    if (value.includes(';')) throw new GeminiClientError('SESSION_INVALID', 'A cookie value contains an invalid delimiter.');
    if (cookie.expires !== undefined && (typeof cookie.expires !== 'number'
        || !Number.isFinite(cookie.expires) || (cookie.expires < 0 && cookie.expires !== -1))) {
      throw new GeminiClientError('SESSION_INVALID', 'A cookie expiration must be epoch seconds or the browser session-cookie sentinel.');
    }
    return Object.freeze({ name: cookie.name, value,
      ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
    });
  });
  if (cookies.length !== cookieNames.size || [...cookieNames].some((name) => !seenCookies.has(name))) {
    throw new GeminiClientError('SESSION_INCOMPLETE', 'The protected session does not contain every cookie required by the observed contract.');
  }
  const headerNames = new Set(contract.auth.headerNames.map((name) => name.toLowerCase()));
  const normalizedHeaders = {};
  for (const [name, value] of Object.entries(bundle.headers)) {
    if (!headerNames.has(name.toLowerCase())) {
      throw new GeminiClientError('SESSION_FIELD_UNOBSERVED', 'The protected session contains an authentication header outside the observed allowlist.');
    }
    const normalizedName = name.toLowerCase();
    if (Object.hasOwn(normalizedHeaders, normalizedName)) {
      throw new GeminiClientError('SESSION_INVALID', 'The protected session repeats an authentication header.');
    }
    normalizedHeaders[normalizedName] = assertValue(value, 'header value');
  }
  if (Object.keys(normalizedHeaders).length !== headerNames.size
      || [...headerNames].some((name) => !Object.hasOwn(normalizedHeaders, name))) {
    throw new GeminiClientError('SESSION_INCOMPLETE', 'The protected session does not contain every header required by the observed contract.');
  }
  const requestHeaders = validateRequestHeaders(bundle.requestHeaders, contract);
  const batchContext = validateBatchContext(bundle.batchContext, contract);
  let mediaCookies = [];
  if (bundle.mediaCookies !== undefined) {
    const mediaContract = contract.mediaAssetDownload;
    if (!mediaContract || !Array.isArray(bundle.mediaCookies) || bundle.mediaCookies.length > mediaContract.cookieScopes.length) {
      throw new GeminiClientError('SESSION_FIELD_UNOBSERVED', 'The session contains media cookies without a matching observed media credential contract.');
    }
    const allowedScopes = new Map(mediaContract.cookieScopes.map((scope) => [scope.name, scope]));
    const seenMediaCookieNames = new Set();
    mediaCookies = bundle.mediaCookies.map((cookie) => {
      if (!isRecord(cookie) || !allowedScopes.has(cookie.name) || seenMediaCookieNames.has(cookie.name)) {
        throw new GeminiClientError('SESSION_FIELD_UNOBSERVED', 'The session contains a media cookie outside the observed asset redirect contract.');
      }
      const scope = allowedScopes.get(cookie.name);
      if (cookie.domain !== scope.domain || cookie.path !== scope.path || cookie.secure !== scope.secure) {
        throw new GeminiClientError('SESSION_COOKIE_SCOPE_INVALID', 'A media cookie does not match its observed domain, path, and secure scope.');
      }
      const value = assertValue(cookie.value, 'media cookie value');
      if (value.includes(';')) throw new GeminiClientError('SESSION_INVALID', 'A media cookie value contains an invalid delimiter.');
      if (cookie.expires !== undefined && (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires))) {
        throw new GeminiClientError('SESSION_INVALID', 'A media cookie expiration is invalid.');
      }
      seenMediaCookieNames.add(cookie.name);
      return Object.freeze({
        name: cookie.name, value, domain: cookie.domain, path: cookie.path,
        secure: cookie.secure, ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
      });
    });
  }
  return Object.freeze({
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    capturedAt: bundle.capturedAt,
    cookies: Object.freeze(cookies),
    headers: Object.freeze(normalizedHeaders),
    requestHeaders,
    ...(batchContext ? { batchContext } : {}),
    ...(bundle.mediaCookies !== undefined ? { mediaCookies: Object.freeze(mediaCookies) } : {}),
  });
}

export function sessionCredentialName() {
  return CREDENTIAL_NAME;
}

export function makeCookieHeader(session, targetUrl) {
  const url = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
  if (url.origin !== SERVICE_ORIGIN) {
    throw new GeminiClientError('CREDENTIAL_ORIGIN_BLOCKED', 'Gemini credentials cannot be sent outside the Gemini web origin.');
  }
  if (!Array.isArray(session?.cookies)) throw new GeminiClientError('SESSION_INVALID', 'The protected cookie bundle is unavailable.');
  if (session.cookies.some((cookie) => cookie.expires !== undefined && cookie.expires !== -1
      && cookie.expires <= Date.now() / 1000)) {
    throw new GeminiClientError('SESSION_EXPIRED', 'An observed required Gemini cookie has expired; acquire a fresh same-owner session before sending.');
  }
  return session.cookies.map((cookie) => cookie.name + '=' + cookie.value).join('; ');
}

export async function readSessionBundleFromStdin(contract, { input = stdin, maxBytes = 1024 * 1024 } = {}) {
  if (!input || input.isTTY === true || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new GeminiClientError('SESSION_STDIN_REQUIRED', 'A one-shot Gemini session bundle must be piped to stdin.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > maxBytes) throw new GeminiClientError('SESSION_TOO_LARGE', 'The one-shot Gemini session exceeded its size limit.');
    chunks.push(bytes);
  }
  if (!length) throw new GeminiClientError('SESSION_STDIN_REQUIRED', 'A one-shot Gemini session bundle was not received.');
  let bundle;
  try { bundle = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new GeminiClientError('SESSION_INVALID', 'The one-shot Gemini session is not valid JSON.'); }
  return validateSessionBundle(bundle, contract);
}

export async function readSessionRenewalEnvelopeFromStdin(contract, { input = stdin, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!input || input.isTTY === true || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new GeminiClientError('SESSION_RENEWAL_STDIN_REQUIRED', 'Pipe the current and normally acquired replacement sessions through stdin.');
  }
  const chunks = [];
  let size = 0;
  let raw;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += bytes.length;
      if (size > maxBytes) throw new GeminiClientError('SESSION_TOO_LARGE', 'The session handoff packet exceeded its size limit.');
      chunks.push(bytes);
    }
    raw = Buffer.concat(chunks);
    let packet;
    try { packet = JSON.parse(raw.toString('utf8')); }
    catch { throw new GeminiClientError('SESSION_RENEWAL_PACKET_INVALID', 'The session handoff packet is not valid JSON.'); }
    if (!isRecord(packet) || Object.keys(packet).some((key) => !['session', 'replacementSession'].includes(key))) {
      throw new GeminiClientError('SESSION_RENEWAL_PACKET_INVALID', 'The session handoff packet has unsupported fields.');
    }
    return Object.freeze({ session: validateSessionBundle(packet.session, contract),
      replacementSession: validateSessionBundle(packet.replacementSession, contract) });
  } finally {
    raw?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

export async function readTextMutationEnvelopeFromStdin(contract, { input = stdin, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (!input || input.isTTY === true || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new GeminiClientError('TEXT_ENVELOPE_STDIN_REQUIRED', 'A one-shot text request envelope must be piped to stdin.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > maxBytes) throw new GeminiClientError('TEXT_ENVELOPE_TOO_LARGE', 'The one-shot text request envelope exceeded its size limit.');
    chunks.push(bytes);
  }
  if (!length) throw new GeminiClientError('TEXT_ENVELOPE_STDIN_REQUIRED', 'A one-shot text request envelope was not received.');
  let envelope;
  try { envelope = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new GeminiClientError('TEXT_ENVELOPE_INVALID', 'The one-shot text request envelope is not valid JSON.'); }
  if (!isRecord(envelope) || Object.keys(envelope).some((key) => !['session', 'capturedRequest', 'prompt'].includes(key))
      || !isRecord(envelope.capturedRequest)
      || Object.keys(envelope.capturedRequest).some((key) => !['url', 'method', 'body', 'headers'].includes(key))
      || typeof envelope.capturedRequest.url !== 'string' || envelope.capturedRequest.url.length > 8192
      || envelope.capturedRequest.method !== 'POST' || typeof envelope.capturedRequest.body !== 'string'
      || Buffer.byteLength(envelope.capturedRequest.body, 'utf8') > 2 * 1024 * 1024
      || !isRecord(envelope.capturedRequest.headers)
      || typeof envelope.prompt !== 'string' || !envelope.prompt.trim() || envelope.prompt.length > 8000 || /[\0]/.test(envelope.prompt)) {
    throw new GeminiClientError('TEXT_ENVELOPE_INVALID', 'The one-shot text request envelope has an unsupported shape.');
  }
  const textOperation = contract?.operations?.text;
  const allowedHeaders = new Set(textOperation?.request?.headerNames?.map((name) => name.toLowerCase()) || []);
  for (const [name, value] of Object.entries(envelope.capturedRequest.headers)) {
    if (!allowedHeaders.has(name.toLowerCase()) || typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      throw new GeminiClientError('TEXT_ENVELOPE_INVALID', 'A captured text request header is outside the observed contract.');
    }
  }
  const session = validateSessionBundle(envelope.session, contract);
  return Object.freeze({
    session,
    capturedRequest: Object.freeze({
      url: envelope.capturedRequest.url,
      method: envelope.capturedRequest.method,
      body: envelope.capturedRequest.body,
      headers: Object.freeze({ ...envelope.capturedRequest.headers }),
    }),
    prompt: envelope.prompt,
  });
}

export async function readHistoryDetailEnvelopeFromStdin(contract, { input = stdin, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!input || input.isTTY === true || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new GeminiClientError('HISTORY_DETAIL_ENVELOPE_STDIN_REQUIRED', 'A one-shot Gemini history detail envelope must be piped to stdin.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > maxBytes) throw new GeminiClientError('HISTORY_DETAIL_ENVELOPE_TOO_LARGE', 'The history detail envelope exceeded its size limit.');
    chunks.push(bytes);
  }
  if (!length) throw new GeminiClientError('HISTORY_DETAIL_ENVELOPE_STDIN_REQUIRED', 'A history detail envelope was not received.');
  let envelope;
  try { envelope = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new GeminiClientError('HISTORY_DETAIL_ENVELOPE_INVALID', 'The history detail envelope is not valid JSON.'); }
  const operation = contract?.operations?.history_read;
  if (!isRecord(envelope) || Object.keys(envelope).some((key) => ![
    'session', 'apiConversationId', 'visibleRouteId', 'expectedIntent', 'expectedResponseId',
  ].includes(key)) || !operation?.request
      || (operation.observation?.request !== true && operation.observation?.requestResponse !== true)
      || typeof envelope.apiConversationId !== 'string' || !/^c_[0-9a-f]{16}$/.test(envelope.apiConversationId)
      || typeof envelope.visibleRouteId !== 'string' || !/^[0-9a-f]{16}$/.test(envelope.visibleRouteId)
      || typeof envelope.expectedIntent !== 'string' || !envelope.expectedIntent.trim() || envelope.expectedIntent.length > 8000
      || (envelope.expectedResponseId !== undefined
        && (typeof envelope.expectedResponseId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(envelope.expectedResponseId)))) {
    throw new GeminiClientError('HISTORY_DETAIL_ENVELOPE_INVALID', 'The history detail envelope has an unsupported shape.');
  }
  const session = validateSessionBundle(envelope.session, contract);
  return Object.freeze({
    session,
    apiConversationId: envelope.apiConversationId,
    visibleRouteId: envelope.visibleRouteId,
    expectedIntent: envelope.expectedIntent,
    expectedResponseId: envelope.expectedResponseId ?? null,
  });
}

/** Read a scoped current-session envelope for the hNvQHb-owned browser-free media downloader. */
export async function readTaskMediaDownloadEnvelopeFromStdin(contract, { input = stdin, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!input || input.isTTY === true || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new GeminiClientError('TASK_MEDIA_ENVELOPE_STDIN_REQUIRED', 'A bounded task media session envelope must be piped to stdin.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > maxBytes) throw new GeminiClientError('TASK_MEDIA_ENVELOPE_TOO_LARGE', 'The task media envelope exceeded its size limit.');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) throw new GeminiClientError('TASK_MEDIA_ENVELOPE_STDIN_REQUIRED', 'A task media envelope was not received.');
  const raw = Buffer.concat(chunks, length);
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); }
  catch { raw.fill(0); throw new GeminiClientError('TASK_MEDIA_ENVELOPE_INVALID', 'The task media envelope is not valid JSON.'); }
  raw.fill(0);
  const allowedKeys = new Set([
    'session', 'apiConversationId', 'visibleRouteId', 'expectedIntent', 'capability',
    'artifactRoot', 'artifactName', 'previousArtifactPath',
  ]);
  if (!isRecord(envelope) || Object.keys(envelope).some((key) => !allowedKeys.has(key))
      || !contract?.operations?.history_read
      || (contract.operations.history_read.observation?.request !== true
        && contract.operations.history_read.observation?.requestResponse !== true)
      || typeof envelope.apiConversationId !== 'string' || !/^c_[0-9a-f]{16}$/.test(envelope.apiConversationId)
      || typeof envelope.visibleRouteId !== 'string' || !/^[0-9a-f]{16}$/.test(envelope.visibleRouteId)
      || typeof envelope.expectedIntent !== 'string' || !envelope.expectedIntent.trim()
      || envelope.expectedIntent.length > 8000 || /[\0]/.test(envelope.expectedIntent)
      || !['image', 'video'].includes(envelope.capability)
      || typeof envelope.artifactRoot !== 'string' || !path.isAbsolute(envelope.artifactRoot)
      || typeof envelope.artifactName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(envelope.artifactName)
      || (envelope.previousArtifactPath !== undefined
        && (typeof envelope.previousArtifactPath !== 'string' || !path.isAbsolute(envelope.previousArtifactPath)))) {
    wipeParsedStrings(envelope);
    throw new GeminiClientError('TASK_MEDIA_ENVELOPE_INVALID', 'The task media envelope has an unsupported shape.');
  }
  let session;
  try { session = validateSessionBundle(envelope.session, contract); }
  catch (error) { wipeParsedStrings(envelope); throw error; }
  return Object.freeze({
    session,
    apiConversationId: envelope.apiConversationId,
    visibleRouteId: envelope.visibleRouteId,
    expectedIntent: envelope.expectedIntent,
    capability: envelope.capability,
    artifactRoot: envelope.artifactRoot,
    artifactName: envelope.artifactName,
    previousArtifactPath: envelope.previousArtifactPath ?? null,
  });
}

/** Read a bounded, current-session upload envelope. The file body and captured request remain in memory only. */
export async function readAttachmentUploadEnvelopeFromStdin(contract, {
  input = stdin,
  maxBytes = 48 * 1024 * 1024,
} = {}) {
  const upload = contract?.attachmentUpload;
  if (!upload || !input || input.isTTY === true || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_ENVELOPE_STDIN_REQUIRED', 'An observed upload contract and bounded one-shot envelope are required.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > maxBytes) throw new GeminiClientError('ATTACHMENT_UPLOAD_ENVELOPE_TOO_LARGE', 'The attachment upload envelope exceeded its size limit.');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) throw new GeminiClientError('ATTACHMENT_UPLOAD_ENVELOPE_STDIN_REQUIRED', 'An attachment upload envelope was not received.');
  const raw = Buffer.concat(chunks, length);
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); }
  catch { raw.fill(0); throw new GeminiClientError('ATTACHMENT_UPLOAD_ENVELOPE_INVALID', 'The attachment upload envelope is not valid JSON.'); }
  raw.fill(0);
  const allowedKeys = new Set(['session', 'capture', 'uploadCookies', 'file', 'expectedOwner']);
  const requiredHeaderNames = new Set(upload.source.headerNames.filter((name) => name !== 'cookie'));
  if (!isRecord(envelope) || Object.keys(envelope).some((key) => !allowedKeys.has(key))
      || !isRecord(envelope.capture) || Object.keys(envelope.capture).some((key) => ![
        'url', 'method', 'contentType', 'bodyBase64', 'declaredFileBytes', 'headerNames', 'headers',
      ].includes(key))
      || typeof envelope.capture.url !== 'string' || envelope.capture.url.length > 8192
      || envelope.capture.method !== upload.source.method || envelope.capture.contentType !== upload.source.contentType
      || typeof envelope.capture.bodyBase64 !== 'string' || envelope.capture.bodyBase64.length > 16_384
      || !Number.isSafeInteger(envelope.capture.declaredFileBytes) || envelope.capture.declaredFileBytes < 1
      || !Array.isArray(envelope.capture.headerNames) || envelope.capture.headerNames.length !== upload.source.headerNames.length
      || new Set(envelope.capture.headerNames.map((name) => String(name).toLowerCase())).size !== envelope.capture.headerNames.length
      || envelope.capture.headerNames.some((name) => !upload.source.headerNames.includes(String(name).toLowerCase()))
      || !isRecord(envelope.capture.headers)
      || Object.keys(envelope.capture.headers).length !== requiredHeaderNames.size
      || Object.keys(envelope.capture.headers).some((name) => !requiredHeaderNames.has(name.toLowerCase())
        || typeof envelope.capture.headers[name] !== 'string' || /[\r\n\0]/.test(envelope.capture.headers[name]))
      || !Array.isArray(envelope.uploadCookies)
      || !isRecord(envelope.file) || Object.keys(envelope.file).some((key) => !['name', 'mimeType', 'bodyBase64'].includes(key))
      || typeof envelope.file.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(envelope.file.name)
      || typeof envelope.file.mimeType !== 'string' || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(envelope.file.mimeType)
      || typeof envelope.file.bodyBase64 !== 'string' || envelope.file.bodyBase64.length > Math.ceil(32 * 1024 * 1024 * 4 / 3) + 16
      || (envelope.expectedOwner !== undefined && (typeof envelope.expectedOwner !== 'string'
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(envelope.expectedOwner)))) {
    wipeParsedStrings(envelope);
    throw new GeminiClientError('ATTACHMENT_UPLOAD_ENVELOPE_INVALID', 'The attachment upload envelope has an unsupported shape.');
  }
  const cookieScopes = new Map(upload.source.cookieScopes.map((scope) => [scope.name, scope]));
  const seenCookies = new Set();
  if (envelope.uploadCookies.some((cookie) => {
    if (!isRecord(cookie) || !cookieScopes.has(cookie.name) || seenCookies.has(cookie.name)
        || typeof cookie.value !== 'string' || /[;\r\n\0]/.test(cookie.value)) return true;
    const scope = cookieScopes.get(cookie.name);
    if (cookie.domain !== scope.domain || cookie.path !== scope.path || cookie.secure !== scope.secure
        || (cookie.expires !== undefined && (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires)))) return true;
    seenCookies.add(cookie.name);
    return false;
  }) || seenCookies.size !== upload.source.cookieNames.length
      || upload.source.cookieNames.some((name) => !seenCookies.has(name))) {
    wipeParsedStrings(envelope);
    throw new GeminiClientError('ATTACHMENT_UPLOAD_ENVELOPE_INVALID', 'The current upload cookies do not match the captured Google cookie scopes.');
  }
  let session;
  try { session = validateSessionBundle(envelope.session, contract); }
  catch (error) { wipeParsedStrings(envelope); throw error; }
  const decodeBase64 = (value, label, maxBytes) => {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length > maxBytes || bytes.toString('base64') !== value) {
      bytes.fill(0);
      throw new GeminiClientError('ATTACHMENT_UPLOAD_ENVELOPE_INVALID', `${label} is not bounded canonical base64.`);
    }
    return bytes;
  };
  let captureBody;
  let fileBody;
  try {
    captureBody = decodeBase64(envelope.capture.bodyBase64, 'The captured start body', 4096);
    fileBody = decodeBase64(envelope.file.bodyBase64, 'The attachment file', 32 * 1024 * 1024);
  } catch (error) {
    wipeParsedStrings(envelope);
    captureBody?.fill(0);
    fileBody?.fill(0);
    throw error;
  }
  const capture = {
    url: envelope.capture.url,
    method: envelope.capture.method,
    contentType: envelope.capture.contentType,
    body: captureBody,
    declaredFileBytes: envelope.capture.declaredFileBytes,
    headerNames: envelope.capture.headerNames.map((name) => String(name).toLowerCase()),
    headers: Object.fromEntries(Object.entries(envelope.capture.headers).map(([name, value]) => [name.toLowerCase(), value])),
  };
  const uploadCookies = envelope.uploadCookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
  }));
  const file = Object.freeze({ name: envelope.file.name, mimeType: envelope.file.mimeType, body: fileBody });
  const expectedOwner = envelope.expectedOwner;
  wipeParsedStrings(envelope);
  return Object.freeze({ session, capture, uploadCookies, file, ...(expectedOwner ? { expectedOwner } : {}) });
}

function wipeParsedStrings(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = '';
      else wipeParsedStrings(value[index]);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') value[key] = '';
    else wipeParsedStrings(child);
  }
}

/** Read a bounded, one-shot session envelope for an observed read-only lifecycle operation. */
export async function readLifecycleReadEnvelopeFromStdin(contract, {
  action,
  input = stdin,
  maxBytes = 2 * 1024 * 1024,
} = {}) {
  const actions = new Set(['history-search', 'models', 'settings', 'public-links']);
  if (!actions.has(action) || !input || input.isTTY === true || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new GeminiClientError('LIFECYCLE_ENVELOPE_STDIN_REQUIRED', 'A bounded lifecycle session envelope must be piped on stdin.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > maxBytes) throw new GeminiClientError('LIFECYCLE_ENVELOPE_TOO_LARGE', 'The lifecycle session envelope exceeded its size limit.');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) throw new GeminiClientError('LIFECYCLE_ENVELOPE_STDIN_REQUIRED', 'A lifecycle session envelope was not received.');
  const raw = Buffer.concat(chunks, length);
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); }
  catch {
    raw.fill(0);
    throw new GeminiClientError('LIFECYCLE_ENVELOPE_INVALID', 'The lifecycle session envelope is not valid JSON.');
  }
  raw.fill(0);
  try {
    const allowedKeys = action === 'history-search'
      ? new Set(['session', 'query'])
      : action === 'settings' ? new Set(['session', 'preferenceKeys']) : new Set(['session']);
    if (!isRecord(envelope) || Object.keys(envelope).some((key) => !allowedKeys.has(key))) {
      throw new GeminiClientError('LIFECYCLE_ENVELOPE_INVALID', 'The lifecycle session envelope has an unsupported shape.');
    }
    if (action === 'history-search'
        && (typeof envelope.query !== 'string' || !envelope.query.trim() || envelope.query.length > 256 || /[\0\r\n]/.test(envelope.query))) {
      throw new GeminiClientError('LIFECYCLE_ENVELOPE_INVALID', 'A bounded history search query is required.');
    }
    if (action === 'settings' && envelope.preferenceKeys !== undefined
        && (!Array.isArray(envelope.preferenceKeys) || envelope.preferenceKeys.length < 1
          || envelope.preferenceKeys.length > 7
          || envelope.preferenceKeys.some((key) => typeof key !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(key)))) {
      throw new GeminiClientError('LIFECYCLE_ENVELOPE_INVALID', 'The preference key list has an unsupported shape.');
    }
    const session = validateSessionBundle(envelope.session, contract);
    const result = {
      session,
      ...(action === 'history-search' ? { query: envelope.query } : {}),
      ...(action === 'settings' && envelope.preferenceKeys ? { preferenceKeys: [...envelope.preferenceKeys] } : {}),
    };
    wipeParsedStrings(envelope);
    return Object.freeze(result);
  } catch (error) {
    wipeParsedStrings(envelope);
    throw error;
  }
}

/** Read a public-share request envelope; the client omits all application credentials on the RPC. */
export async function readAnonymousShareReadEnvelopeFromStdin(contract, {
  input = stdin,
  maxBytes = 2 * 1024 * 1024,
} = {}) {
  if (!input || input.isTTY === true || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new GeminiClientError('PUBLIC_SHARE_READ_ENVELOPE_REQUIRED', 'A bounded anonymous share-read envelope must be piped on stdin.');
  }
  const chunks = [];
  let length = 0;
  let raw;
  let envelope;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      length += bytes.length;
      if (length > maxBytes) throw new GeminiClientError('PUBLIC_SHARE_READ_ENVELOPE_TOO_LARGE', 'The anonymous share-read envelope exceeded its size limit.');
      chunks.push(Buffer.from(bytes));
    }
    if (!length) throw new GeminiClientError('PUBLIC_SHARE_READ_ENVELOPE_REQUIRED', 'An anonymous share-read envelope was not received.');
    raw = Buffer.concat(chunks, length);
    try { envelope = JSON.parse(raw.toString('utf8')); }
    catch { throw new GeminiClientError('PUBLIC_SHARE_READ_ENVELOPE_INVALID', 'The anonymous share-read envelope is not valid JSON.'); }
    if (!isRecord(envelope) || Object.keys(envelope).some((key) => !['session', 'shareId'].includes(key))
        || typeof envelope.shareId !== 'string' || !/^[A-Za-z0-9._~-]{8,256}$/.test(envelope.shareId)) {
      throw new GeminiClientError('PUBLIC_SHARE_READ_ENVELOPE_INVALID', 'The anonymous share-read envelope has an unsupported shape.');
    }
    const result = { session: validateSessionBundle(envelope.session, contract), shareId: envelope.shareId };
    wipeParsedStrings(envelope);
    return result;
  } catch (error) {
    if (envelope) wipeParsedStrings(envelope);
    throw error;
  } finally {
    raw?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Read a minimal one-shot envelope for the source-verified, reversible settings writer. */
export async function readSettingsUpdateEnvelopeFromStdin(contract, {
  action,
  input = stdin,
  maxBytes = 2 * 1024 * 1024,
} = {}) {
  const actions = new Set(['settings-read-one', 'settings-update', 'settings-update-test']);
  if (!actions.has(action) || !input || input.isTTY === true
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new GeminiClientError('SETTINGS_UPDATE_ENVELOPE_STDIN_REQUIRED', 'A bounded settings-update envelope must be piped on stdin.');
  }
  const chunks = [];
  let size = 0;
  let raw;
  let envelope;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += bytes.length;
      if (size > maxBytes) {
        throw new GeminiClientError('SETTINGS_UPDATE_ENVELOPE_TOO_LARGE', 'The settings-update envelope exceeded the size limit.');
      }
      chunks.push(Buffer.from(bytes));
    }
    if (!size) throw new GeminiClientError('SETTINGS_UPDATE_ENVELOPE_STDIN_REQUIRED', 'A settings-update envelope was not received.');
    raw = Buffer.concat(chunks, size);
    try { envelope = JSON.parse(raw.toString('utf8')); }
    catch { throw new GeminiClientError('SETTINGS_UPDATE_ENVELOPE_INVALID', 'The settings-update envelope is not valid JSON.'); }
    if (!isRecord(envelope)) {
      throw new GeminiClientError('SETTINGS_UPDATE_ENVELOPE_INVALID', 'The settings-update envelope has an unsupported shape.');
    }
    const allowedKeys = action === 'settings-read-one'
      ? new Set(['session', 'preferenceKey'])
      : action === 'settings-update-test'
        ? new Set(['session', 'preferenceKey', 'baselineValue'])
        : new Set(['session', 'preferenceKey', 'value', 'baselineValue']);
    if (Object.keys(envelope).some((key) => !allowedKeys.has(key))
        || envelope.preferenceKey !== 'side_nav_open_by_default'
        || (action === 'settings-update'
          && (typeof envelope.value !== 'boolean' || typeof envelope.baselineValue !== 'boolean'
            || envelope.value === envelope.baselineValue))
        || (action === 'settings-update-test' && envelope.baselineValue !== undefined
          && typeof envelope.baselineValue !== 'boolean')
        || !envelope.session || typeof envelope.session !== 'object' || Array.isArray(envelope.session)) {
      throw new GeminiClientError('SETTINGS_UPDATE_ENVELOPE_INVALID', 'The settings-update envelope contains an unsupported field or value.');
    }
    const result = {
      session: validateSessionBundle(envelope.session, contract),
      preferenceKey: envelope.preferenceKey,
      ...(action === 'settings-update' ? {
        value: envelope.value,
        baselineValue: envelope.baselineValue,
      } : action === 'settings-update-test' && envelope.baselineValue !== undefined
        ? { baselineValue: envelope.baselineValue } : {}),
    };
    wipeParsedStrings(envelope);
    return result;
  } catch (error) {
    if (envelope) wipeParsedStrings(envelope);
    throw error;
  } finally {
    raw?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Parse one task-scoped media request capture; all values remain in this process and are wiped by the caller. */
export async function readMediaMutationEnvelopeFromStdin(contract, { input = stdin, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (!input || input.isTTY === true || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new GeminiClientError('MEDIA_ENVELOPE_STDIN_REQUIRED', 'A one-shot media capture envelope must be piped on stdin.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > maxBytes) throw new GeminiClientError('MEDIA_ENVELOPE_TOO_LARGE', 'The media capture envelope exceeded its size limit.');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) throw new GeminiClientError('MEDIA_ENVELOPE_STDIN_REQUIRED', 'A media capture envelope was not received.');
  const raw = Buffer.concat(chunks, length);
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); }
  catch {
    raw.fill(0);
    throw new GeminiClientError('MEDIA_ENVELOPE_INVALID', 'The media capture envelope is not valid JSON.');
  }
  raw.fill(0);
  try {
    const topKeys = new Set(['session', 'capture', 'expectedIntent']);
    const captureKeys = new Set([
      'origin', 'url', 'path', 'method', 'resourceType', 'contentType', 'headers', 'bodyBase64', 'browserAbortVerified',
    ]);
    if (!isRecord(envelope) || Object.keys(envelope).some((key) => !topKeys.has(key))
        || !isRecord(envelope.capture) || Object.keys(envelope.capture).some((key) => !captureKeys.has(key))
        || typeof envelope.expectedIntent !== 'string' || !envelope.expectedIntent.trim()
        || envelope.expectedIntent.length > 8_000 || /[\0]/.test(envelope.expectedIntent)
        || typeof envelope.capture.bodyBase64 !== 'string' || envelope.capture.bodyBase64.length > 4 * 1024 * 1024
        || typeof envelope.capture.headers !== 'object' || envelope.capture.headers === null || Array.isArray(envelope.capture.headers)) {
      throw new GeminiClientError('MEDIA_ENVELOPE_INVALID', 'The media capture envelope has an unsupported shape.');
    }
    const body = Buffer.from(envelope.capture.bodyBase64, 'base64');
    if (!body.length || body.toString('base64') !== envelope.capture.bodyBase64 || body.length > 2 * 1024 * 1024) {
      body.fill(0);
      throw new GeminiClientError('MEDIA_ENVELOPE_INVALID', 'The captured media request body is not bounded canonical base64.');
    }
    const capture = {
      origin: envelope.capture.origin,
      url: envelope.capture.url,
      path: envelope.capture.path,
      method: envelope.capture.method,
      resourceType: envelope.capture.resourceType,
      contentType: envelope.capture.contentType,
      headers: { ...envelope.capture.headers },
      body,
      browserAbortVerified: envelope.capture.browserAbortVerified,
    };
    const session = validateSessionBundle(envelope.session, contract);
    wipeParsedStrings(envelope);
    return { session, capture, expectedIntent: envelope.expectedIntent };
  } catch (error) {
    wipeParsedStrings(envelope);
    throw error;
  }
}
