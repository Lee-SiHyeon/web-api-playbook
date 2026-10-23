import { GeminiClientError } from './errors.mjs';

const SERVICE_ORIGIN = 'https://gemini.google.com';
const STREAM_GENERATE_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const REQUIRED_FORM_FIELDS = new Set(['at', 'f.req']);
const FORBIDDEN_HEADER_NAMES = new Set(['cookie', 'authorization', 'proxy-authorization', 'host', 'content-length']);

function typeShape(value, depth = 0) {
  if (depth > 12) return 'depth_limit';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) {
    return Object.freeze({
      type: 'array',
      length: value.length,
      items: Object.freeze(value.slice(0, 80).map((item) => typeShape(item, depth + 1))),
    });
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return Object.freeze({
      type: 'object',
      keys: Object.freeze(keys.slice(0, 100)),
      fields: Object.freeze(Object.fromEntries(keys.slice(0, 100).map((key) => [key, typeShape(value[key], depth + 1)]))),
    });
  }
  return 'unsupported';
}

function collectExactStringPaths(value, expected, path = [], found = [], depth = 0) {
  if (depth > 24 || found.length >= 100) return found;
  if (typeof value === 'string') {
    if (value === expected) found.push(Object.freeze([...path]));
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectExactStringPaths(item, expected, [...path, index], found, depth + 1));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectExactStringPaths(item, expected, [...path, key], found, depth + 1);
    }
  }
  return found;
}

function decodeInnerRequest(outer) {
  if (!Array.isArray(outer) || outer.length !== 2 || outer[0] !== null || typeof outer[1] !== 'string') {
    return Object.freeze({ decoded: false, outerShape: typeShape(outer), innerShape: null, innerValue: null });
  }
  try {
    const innerValue = JSON.parse(outer[1]);
    return Object.freeze({ decoded: true, outerShape: typeShape(outer), innerShape: typeShape(innerValue), innerValue });
  } catch {
    return Object.freeze({ decoded: false, outerShape: typeShape(outer), innerShape: 'invalid_json_string', innerValue: null });
  }
}

export function inspectMediaFormBody(body, expectedIntent) {
  if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    throw new GeminiClientError('MEDIA_CAPTURE_BODY_INVALID', 'The intercepted media request body must be bytes in memory.');
  }
  if (typeof expectedIntent !== 'string' || !expectedIntent) {
    throw new GeminiClientError('MEDIA_INTENT_REQUIRED', 'A bounded nonsecret media intent is required for capture matching.');
  }
  let form;
  try { form = new URLSearchParams(Buffer.from(body).toString('utf8')); }
  catch { throw new GeminiClientError('MEDIA_CAPTURE_FORM_INVALID', 'The intercepted media request was not a valid form body.'); }
  const fieldNames = [...form.keys()];
  if (fieldNames.length !== new Set(fieldNames).size
      || [...REQUIRED_FORM_FIELDS].some((name) => !fieldNames.includes(name))
      || fieldNames.some((name) => !/^[A-Za-z0-9_][A-Za-z0-9_.~-]{0,150}$/.test(name))) {
    throw new GeminiClientError('MEDIA_CAPTURE_FIELDS_MISMATCH', 'The intercepted media request fields did not match the observed capture.');
  }
  const at = form.get('at');
  const encoded = form.get('f.req');
  let outer;
  try { outer = JSON.parse(encoded); }
  catch { throw new GeminiClientError('MEDIA_CAPTURE_ENVELOPE_INVALID', 'The media request envelope could not be decoded in memory.'); }
  const decoded = decodeInnerRequest(outer);
  const promptPaths = decoded.innerValue === null
    ? []
    : collectExactStringPaths(decoded.innerValue, expectedIntent);
  const intentMatch = decoded.decoded === true && promptPaths.length > 0;
  if (!at || !intentMatch) {
    throw new GeminiClientError('MEDIA_CAPTURE_INTENT_MISMATCH', 'The intercepted media request did not match the caller intent.');
  }
  return Object.freeze({
    fieldNames: Object.freeze(fieldNames),
    bodyBytes: Buffer.byteLength(Buffer.from(body)),
    outerShape: decoded.outerShape,
    innerDecoded: decoded.decoded,
    innerShape: decoded.innerShape,
    promptPaths: Object.freeze(promptPaths),
    intentMatch,
  });
}

export function validateMediaCapture(capture, { capability, expectedIntent } = {}) {
  if (!['image', 'video'].includes(capability) || !capture || typeof capture !== 'object') {
    throw new GeminiClientError('MEDIA_CAPTURE_INVALID', 'An image or video browser capture is required.');
  }
  if (capture.origin !== SERVICE_ORIGIN || capture.method !== 'POST' || capture.resourceType !== 'xhr'
      || capture.path !== STREAM_GENERATE_PATH || capture.contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded'
      || capture.browserAbortVerified !== true) {
    throw new GeminiClientError('MEDIA_CAPTURE_CONTRACT_MISMATCH', 'The browser capture did not match the observed Gemini media request.');
  }
  const body = Buffer.isBuffer(capture.body) ? capture.body : Buffer.from(capture.body || []);
  const inspected = inspectMediaFormBody(body, expectedIntent);
  const url = new URL(capture.url);
  if (url.origin !== SERVICE_ORIGIN || url.pathname !== STREAM_GENERATE_PATH) {
    throw new GeminiClientError('MEDIA_CAPTURE_ORIGIN_BLOCKED', 'The intercepted media request escaped the observed Gemini endpoint.');
  }
  const headerValues = {};
  for (const [name, value] of Object.entries(capture.headers || {})) {
    const normalized = name.toLowerCase();
    if (FORBIDDEN_HEADER_NAMES.has(normalized) || typeof value !== 'string' || /[\r\n\0]/.test(value)) continue;
    headerValues[normalized] = value;
  }
  if (headerValues['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    throw new GeminiClientError('MEDIA_CAPTURE_CONTENT_TYPE_MISSING', 'The browser request did not provide the observed form content type.');
  }
  return Object.freeze({
    capability,
    origin: url.origin,
    path: url.pathname,
    url: capture.url,
    method: capture.method,
    contentType: capture.contentType,
    queryKeys: Object.freeze([...url.searchParams.keys()]),
    query: Object.freeze([...url.searchParams.entries()].map((pair) => Object.freeze(pair))),
    headerNames: Object.freeze(Object.keys(headerValues).sort()),
    headerValues: Object.freeze(headerValues),
    body,
    inspection: inspected,
  });
}

export function mediaCaptureSchemaSummary(capture) {
  return Object.freeze({
    capability: capture.capability,
    method: capture.method,
    origin: capture.origin,
    path: capture.path,
    queryKeys: capture.queryKeys,
    headerNames: capture.headerNames,
    contentType: capture.contentType.split(';', 1)[0].trim().toLowerCase(),
    bodyFieldNames: capture.inspection.fieldNames,
    bodyBytes: capture.inspection.bodyBytes,
    outerFReqShape: capture.inspection.outerShape,
    innerFReqDecoded: capture.inspection.innerDecoded,
    innerFReqShape: capture.inspection.innerShape,
    promptPaths: capture.inspection.promptPaths,
    intentMatch: capture.inspection.intentMatch,
  });
}
