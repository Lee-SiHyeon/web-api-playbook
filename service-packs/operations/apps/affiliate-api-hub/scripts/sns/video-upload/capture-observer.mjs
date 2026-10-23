import { mkdir, open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizeBody, sanitizeCapture, sanitizeHeaders, sanitizeUrl } from './capture-safety.mjs';

const NETWORK_METHODS = [
  'Network.requestWillBeSent',
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceived',
  'Network.responseReceivedExtraInfo',
  'Network.dataReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
];

const BLOCKED_ROUTE_RE = /(?:^|\/)(?:login|log-in|signin|sign-in|oauth2?|auth(?:entication|orization)?|passport|captcha|challenge)(?:\/|$)/i;
const BLOCKED_ANALYTICS_RE = /(?:analytics?|telemetry|tracking|track|pixel|collect|event[-_]?batch|metrics?|beacon|heartbeat|sentry|doubleclick)/i;
const JSON_OR_FORM_RE = /(?:^|\s|;)(?:application\/[a-z0-9.+-]*json|application\/x-www-form-urlencoded)(?:\s|;|$)/i;

function safeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertDependencies(send, readEvents) {
  if (typeof send !== 'function' || typeof readEvents !== 'function') throw safeError('CDP_OBSERVER_CAPABILITY_REQUIRED');
}

function normalizeOrigins(allowedOrigins) {
  return allowedOrigins.map((item) => {
    let parsed;
    try { parsed = new URL(item.includes('://') ? item : `https://${item}`); } catch { throw safeError('CDP_ORIGIN_ALLOWLIST_INVALID'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw safeError('CDP_ORIGIN_ALLOWLIST_INVALID');
    }
    return parsed.origin.toLowerCase();
  });
}

function hostAllowed(url, allowedOrigins) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && allowedOrigins.includes(parsed.origin.toLowerCase());
}

function isBlockedUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return true; }
  const routeAndHost = `${parsed.hostname}${parsed.pathname}`;
  return BLOCKED_ROUTE_RE.test(parsed.pathname) || BLOCKED_ANALYTICS_RE.test(routeAndHost);
}

function isAllowedUrl(url, allowedOrigins) {
  return typeof url === 'string' && hostAllowed(url, allowedOrigins) && !isBlockedUrl(url);
}

function classifyRequest(requestFilter, url, method, allowedOrigins) {
  if (!isAllowedUrl(url, allowedOrigins)) return null;
  const safeMethod = typeof method === 'string' && /^[A-Za-z]{3,12}$/.test(method) ? method.toUpperCase() : 'UNKNOWN';
  let decision;
  try {
    // The caller sees only sanitized URL and method, never headers, body, source, or raw CDP params.
    decision = requestFilter({ url: sanitizeUrl(url), method: safeMethod });
  } catch {
    throw safeError('CDP_REQUEST_FILTER_FAILED');
  }
  if (decision === true) return 'full';
  if (decision === 'metadata_only') return 'metadata_only';
  return null;
}

function contentType(headers) {
  const entry = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type');
  return entry ? String(entry[1]) : '';
}

function isJsonOrForm(headers, mimeType = '') {
  const type = `${contentType(headers)} ${mimeType}`.trim();
  return JSON_OR_FORM_RE.test(type) && !/multipart\/|video\/|audio\/|octet-stream/i.test(type);
}

function safeCommandError(error) {
  // Tool exception text can contain request data; intentionally discard it.
  return safeError('CDP_READ_FAILED');
}

/** Enable passive Network events and return the cursor to use immediately before the UI upload. */
export async function beginUploadObservation({ send, readEvents, allowedOrigins }) {
  assertDependencies(send, readEvents);
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) throw safeError('CDP_ORIGIN_ALLOWLIST_REQUIRED');
  const normalizedOrigins = normalizeOrigins(allowedOrigins);
  try {
    await send('Network.enable', {});
  } catch (error) {
    throw safeCommandError(error);
  }
  let baseline;
  try {
    // The documented no-afterSequence form returns the current event cursor without draining history.
    baseline = await readEvents({ methods: NETWORK_METHODS, limit: 1, timeoutMs: 0 });
  } catch (error) {
    throw safeCommandError(error);
  }
  const cursor = Number(baseline?.cursor) || 0;
  return Object.freeze({ cursor, allowedOrigins: normalizedOrigins });
}

function recordFor(map, requestId, sequence) {
  let record = map.get(requestId);
  if (!record) {
    record = { firstSequence: Number(sequence) || 0, request: null, response: null, transfer: [], pendingRequestHeaders: null, pendingResponseHeaders: null, bodyStatus: {} };
    map.set(requestId, record);
  } else if (Number(sequence) > 0 && (!record.firstSequence || Number(sequence) < record.firstSequence)) record.firstSequence = Number(sequence);
  return record;
}

function safeEventRequest(event, record, allowedOrigins) {
  const request = event?.params?.request;
  if (!request || !record.requestFilter) return false;
  const mode = classifyRequest(record.requestFilter, request.url, request.method, allowedOrigins);
  record.includeMode = mode;
  if (!mode) {
    record.request = null;
    delete record.rawRequestBody;
    return false;
  }
  record.request = {
    sequence: Number(event.sequence) || 0,
    url: sanitizeUrl(request.url),
    method: typeof request.method === 'string' ? request.method : undefined,
    headers: sanitizeHeaders(request.headers ?? {}),
    hasPostData: Boolean(request.hasPostData || request.postData),
  };
  if (mode === 'full' && typeof request.postData === 'string' && isJsonOrForm(request.headers)) record.rawRequestBody = request.postData;
  if (mode === 'metadata_only' && typeof request.postData === 'string' && isJsonOrForm(request.headers)) {
    const fieldNames = extractFieldNames(request.postData, request.headers);
    if (fieldNames?.length) record.request.fieldNames = fieldNames;
  }
  if (record.pendingRequestHeaders) record.request.headers = sanitizeHeaders(record.pendingRequestHeaders);
  return true;
}

function safeEventResponse(event, record, allowedOrigins) {
  const response = event?.params?.response;
  if (!record.includeMode || !response || !isAllowedUrl(response.url, allowedOrigins)) return false;
  record.response = {
    sequence: Number(event.sequence) || 0,
    url: sanitizeUrl(response.url),
    status: Number.isFinite(response.status) ? response.status : undefined,
    mimeType: typeof response.mimeType === 'string' ? response.mimeType : undefined,
    headers: sanitizeHeaders(response.headers ?? {}),
    encodedDataLength: Number.isFinite(response.encodedDataLength) ? response.encodedDataLength : undefined,
  };
  if (record.pendingResponseHeaders) record.response.headers = sanitizeHeaders(record.pendingResponseHeaders);
  return true;
}

function cleanRecord(record) {
  const output = { firstSequence: record.firstSequence };
  if (record.request) output.request = record.request;
  if (record.response) output.response = record.response;
  if (record.transfer.length) output.transfer = record.transfer;
  if (record.body !== undefined) output.body = record.body;
  if (record.includeMode === 'metadata_only' && record.request?.fieldNames) output.request.fieldNames = record.request.fieldNames;
  if (Object.keys(record.bodyStatus).length) output.bodyStatus = record.bodyStatus;
  if (record.load) output.load = record.load;
  return sanitizeCapture(output);
}

function extractFieldNames(rawBody, headers) {
  if (typeof rawBody !== 'string' || !isJsonOrForm(headers)) return [];
  const type = contentType(headers);
  try {
    let names;
    if (/json/i.test(type)) {
      const parsed = JSON.parse(rawBody);
      names = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
    } else {
      names = [...new URLSearchParams(rawBody).keys()];
    }
    return [...new Set(names.filter((name) => /^[A-Za-z0-9_.-]{1,100}$/.test(name)))];
  } catch {
    return [];
  }
}

function parseSanitizedBody(rawBody, headers, mimeType = '') {
  const safeBody = sanitizeBody(rawBody);
  if (!/json/i.test(`${contentType(headers)} ${mimeType}`)) return safeBody;
  try { return JSON.parse(safeBody); } catch { return safeBody; }
}

async function readRequestBody(send, requestId, request, headers) {
  if (!request?.hasPostData) return { status: 'not_present' };
  if (!isJsonOrForm(headers)) return { status: 'not_json_or_form' };
  if (typeof request.rawPostData === 'string') {
    return { status: 'captured', value: parseSanitizedBody(request.rawPostData, headers) };
  }
  try {
    const result = await send('Network.getRequestPostData', { requestId });
    if (typeof result?.postData !== 'string') return { status: 'unavailable' };
    return { status: 'captured', value: parseSanitizedBody(result.postData, headers) };
  } catch {
    return { status: 'unavailable' };
  }
}

async function readResponseBody(send, requestId, response, headers) {
  if (!response) return { status: 'not_observed' };
  if (!isJsonOrForm(headers, response.mimeType)) return { status: 'not_json_or_form' };
  try {
    const result = await send('Network.getResponseBody', { requestId });
    if (result?.base64Encoded) return { status: 'binary' };
    if (typeof result?.body !== 'string') return { status: 'unavailable' };
    return { status: 'captured', value: parseSanitizedBody(result.body, headers, response.mimeType) };
  } catch {
    return { status: 'unavailable' };
  }
}

function sanitizeOutputDirectory(outputDir) {
  if (typeof outputDir !== 'string' || !outputDir.trim()) throw safeError('CDP_OUTPUT_DIRECTORY_REQUIRED');
  const resolved = path.resolve(outputDir);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw safeError('CDP_OUTPUT_MUST_BE_TEMPORARY');
  return resolved;
}

function safeBasename(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/i.test(name) || name.includes('..')) {
    throw safeError('CDP_CAPTURE_FILENAME_INVALID');
  }
  return name;
}

async function writeSanitizedCapture({ outputDir, fileName, document }) {
  const safeDir = sanitizeOutputDirectory(outputDir);
  const safeName = safeBasename(fileName);
  await mkdir(safeDir, { recursive: true });
  const resolvedDir = await realpath(safeDir);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolvedDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw safeError('CDP_OUTPUT_MUST_BE_TEMPORARY');
  const outputPath = path.join(resolvedDir, safeName);
  const safeDocument = sanitizeCapture(document);
  const serialized = `${JSON.stringify(safeDocument, null, 2)}\n`;
  let handle;
  try {
    handle = await open(outputPath, 'wx');
    await handle.writeFile(serialized, { encoding: 'utf8' });
  } catch {
    throw safeError('CDP_CAPTURE_WRITE_FAILED');
  } finally {
    await handle?.close().catch(() => {});
  }
  return outputPath;
}

/** Drain only allowlisted, non-auth, non-analytics Network traffic and save sanitized JSON. */
export async function collectUploadObservation({
  send,
  readEvents,
  observation,
  outputDir,
  fileName,
  platform,
  requestFilter,
  limit = 500,
  timeoutMs = 0,
}) {
  assertDependencies(send, readEvents);
  if (!observation || !Number.isFinite(observation.cursor) || !Array.isArray(observation.allowedOrigins)) throw safeError('CDP_OBSERVATION_HANDLE_REQUIRED');
  if (typeof platform !== 'string' || !/^[a-z0-9][a-z0-9-]{0,30}$/i.test(platform)) throw safeError('CDP_PLATFORM_REQUIRED');
  if (typeof requestFilter !== 'function') throw safeError('CDP_REQUEST_FILTER_REQUIRED');

  let afterSequence = observation.cursor;
  let maxCursor = afterSequence;
  let truncated = false;
  const records = new Map();
  let pages = 0;
  while (pages < 1000) {
    let page;
    try {
      page = await readEvents({ afterSequence, methods: NETWORK_METHODS, limit, timeoutMs });
    } catch (error) {
      throw safeCommandError(error);
    }
    pages += 1;
    const events = Array.isArray(page?.events) ? page.events : [];
    truncated ||= Boolean(page?.truncated);
    maxCursor = Math.max(maxCursor, Number(page?.cursor) || 0);

    for (const event of events) {
      const method = event?.method;
      const params = event?.params ?? {};
      const requestId = params.requestId;
      if (typeof requestId !== 'string' || !NETWORK_METHODS.includes(method)) continue;
      const record = recordFor(records, requestId, event.sequence);
      record.requestFilter = requestFilter;

      if (method === 'Network.requestWillBeSent') safeEventRequest(event, record, observation.allowedOrigins);
      if (method === 'Network.responseReceived') safeEventResponse(event, record, observation.allowedOrigins);
      if (method === 'Network.requestWillBeSentExtraInfo') {
        record.pendingRequestHeaders = params.headers ?? {};
        if (record.request) record.request.headers = sanitizeHeaders(record.pendingRequestHeaders);
      }
      if (method === 'Network.responseReceivedExtraInfo') {
        record.pendingResponseHeaders = params.headers ?? {};
        if (record.response) record.response.headers = sanitizeHeaders(record.pendingResponseHeaders);
      }
      if (method === 'Network.dataReceived' && record.includeMode && (record.request || record.response)) {
        const transfer = { sequence: Number(event.sequence) || 0 };
        if (Number.isFinite(params.dataLength)) transfer.dataLength = params.dataLength;
        if (Number.isFinite(params.encodedDataLength)) transfer.encodedDataLength = params.encodedDataLength;
        record.transfer.push(transfer);
      }
      if (method === 'Network.loadingFinished' && record.includeMode) {
        record.load = { sequence: Number(event.sequence) || 0, status: 'finished' };
        if (Number.isFinite(params.encodedDataLength)) record.load.encodedDataLength = params.encodedDataLength;
      }
      if (method === 'Network.loadingFailed' && record.includeMode) record.load = { sequence: Number(event.sequence) || 0, status: 'failed' };
    }

    const lastEvent = events.reduce((last, event) => Math.max(last, Number(event?.sequence) || 0), afterSequence);
    if (!page?.hasMore || lastEvent <= afterSequence) break;
    afterSequence = lastEvent;
  }

  // Fetch JSON/form bodies only after the event list is correlated and the URL is allowlisted.
  for (const [requestId, record] of records) {
    if (!record.request || !record.includeMode || !isAllowedUrl(record.request.url, observation.allowedOrigins)) continue;
    if (record.includeMode === 'metadata_only') {
      record.bodyStatus = { request: 'not_classified', response: 'not_classified' };
      continue;
    }
    const requestHeaders = record.pendingRequestHeaders ?? record.request.headers;
    const requestBody = await readRequestBody(send, requestId, { ...record.request, rawPostData: record.rawRequestBody }, requestHeaders);
    record.bodyStatus.request = requestBody.status;
    if (requestBody.status === 'captured') record.body = { ...(record.body ?? {}), request: requestBody.value };
    delete record.rawRequestBody;

    const result = await readResponseBody(send, requestId, record.response, record.pendingResponseHeaders ?? record.response?.headers);
    record.bodyStatus.response = result.status;
    if (result.status === 'captured') record.body = { ...(record.body ?? {}), response: result.value };
  }

  const requests = [...records.values()]
    .filter((record) => record.request && record.includeMode && isAllowedUrl(record.request.url, observation.allowedOrigins))
    .sort((a, b) => a.firstSequence - b.firstSequence)
    .map(cleanRecord);
  const document = {
    format: 'sanitized-cdp-upload-observation-v1',
    platform,
    eventRange: { afterSequence: observation.cursor, cursor: maxCursor, truncated },
    requests,
  };
  const safeDocument = sanitizeCapture(document);
  const actualFileName = fileName ?? `${platform}-upload-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const outputPath = await writeSanitizedCapture({ outputDir, fileName: actualFileName, document: safeDocument });
  return { outputPath, requestCount: requests.length, cursor: maxCursor, truncated };
}
