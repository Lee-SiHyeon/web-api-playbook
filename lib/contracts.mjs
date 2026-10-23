import { createHash } from 'node:crypto';

const FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,127}$/;
const OPERATION_FIELD = /^(?:action|cmd|command|event|method|mode|mutation|operation|operationName|query|resource|route|rpc|service|task|type)$/i;
const IDENTIFIER_SEGMENT = /^(?:\d{3,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/i;
const SENSITIVE_PREDECESSOR = /^(?:access|account|accounts|auth|authorization|blog|blogs|category|categories|code|comment|comments|csrf|file|id|item|items|key|member|members|nonce|order|orders|post|posts|profile|profiles|product|products|refresh|resource|session|sessions|signature|state|token|uid|user|users|uuid)$/i;
const RESPONSE_SCHEMA_MAX_BYTES = 4 * 1024 * 1024;
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_KEYS = 256;
const MAX_FIELD_NAMES = 256;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function looksLikeDynamicKey(value) {
  if (typeof value !== 'string' || value.length === 0) return true;
  if (value.length > 128 || /[\x00-\x20\x7f]/.test(value)) return true;
  if (/^\d+$/.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return true;
  if (value.length >= 24 && /^[A-Za-z0-9_-]+$/.test(value)) return true;
  if (/[\u0080-\uffff]/.test(value)) return true;
  return false;
}

export function safeFieldName(value) {
  if (typeof value !== 'string') return null;
  if (looksLikeDynamicKey(value)) return ':dynamicKey';
  if (!FIELD_NAME.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) return ':field';
  return value;
}

export function normalizeFieldNames(values = []) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(safeFieldName).filter(Boolean))].sort().slice(0, MAX_FIELD_NAMES);
}

function isOpaqueSegment(segment) {
  let decoded;
  try { decoded = decodeURIComponent(segment); } catch { return true; }
  if (decoded !== segment || /[\u0080-\uffff]/.test(decoded)) return true;
  if (IDENTIFIER_SEGMENT.test(decoded)) return true;
  if (/^v\d+$/i.test(decoded)) return false;
  return false;
}

export function normalizePath(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return '/';
  let path = pathname.split(/[?#]/, 1)[0];
  if (!path.startsWith('/')) path = `/${path}`;
  const inputSegments = path.split('/');
  const outputSegments = [];
  for (let index = 0; index < inputSegments.length; index += 1) {
    const segment = inputSegments[index];
    if (!segment) { outputSegments.push(''); continue; }
    const previous = inputSegments[index - 1] ?? '';
    const idLike = isOpaqueSegment(segment)
      || (SENSITIVE_PREDECESSOR.test(previous) && !/^(?:authorize|callback|config|exchange|list|login|manage|new|refresh|search|settings)$/i.test(segment));
    outputSegments.push(idLike ? ':id' : segment);
  }
  const normalized = outputSegments.join('/').replace(/\/+/g, '/');
  return normalized || '/';
}

export function normalizeUrl(raw, { baseUrl } = {}) {
  let url;
  try { url = baseUrl ? new URL(raw, baseUrl) : new URL(raw); }
  catch { throw fail('XHR_URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw fail('XHR_URL_SCHEME_UNSUPPORTED');
  const queryFields = normalizeFieldNames([...url.searchParams.keys()]);
  return {
    origin: url.origin,
    path: normalizePath(url.pathname),
    queryFields,
  };
}

export function normalizeMime(value) {
  if (typeof value !== 'string') return null;
  const mime = value.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : null;
}

function schemaKey(value) {
  if (looksLikeDynamicKey(value)) return ':dynamicKey';
  return safeFieldName(value) ?? ':field';
}

export function schemaOf(value, { maxDepth = MAX_SCHEMA_DEPTH, maxKeys = MAX_SCHEMA_KEYS } = {}) {
  let remaining = maxKeys;
  const walk = (item, depth) => {
    if (item === null) return { type: 'null' };
    if (Array.isArray(item)) {
      if (!item.length) return { type: 'array', items: [] };
      const candidates = item.slice(0, Math.min(8, item.length)).map(child => walk(child, depth + 1));
      const unique = new Map(candidates.map(candidate => [JSON.stringify(candidate), candidate]));
      return { type: 'array', items: [...unique.values()].slice(0, 4) };
    }
    if (typeof item === 'object') {
      if (depth >= maxDepth) return { type: 'object', truncated: 'depth_limit' };
      const properties = Object.create(null);
      const keys = Object.keys(item).sort();
      for (const key of keys) {
        if (remaining <= 0) break;
        remaining -= 1;
        const safeKey = schemaKey(key);
        if (Object.hasOwn(properties, safeKey)) continue;
        properties[safeKey] = walk(item[key], depth + 1);
      }
      return { type: 'object', properties, ...(keys.length > Object.keys(properties).length ? { truncated: 'key_limit_or_dynamic_key_collision' } : {}) };
    }
    if (typeof item === 'string') return { type: 'string' };
    if (typeof item === 'number') return { type: Number.isInteger(item) ? 'integer' : 'number' };
    if (typeof item === 'boolean') return { type: 'boolean' };
    return { type: 'unknown' };
  };
  return walk(value, 0);
}

function contentType(headers = []) {
  if (!Array.isArray(headers)) return null;
  const header = headers.find(item => typeof item?.name === 'string' && item.name.toLowerCase() === 'content-type');
  return normalizeMime(header?.value);
}

function collectNestedFields(value, { limit = MAX_FIELD_NAMES, maxDepth = 8 } = {}) {
  const fields = new Set();
  const visit = (item, prefix = '', depth = 0) => {
    if (fields.size >= limit || depth > maxDepth || item == null || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      for (const child of item.slice(0, 8)) visit(child, prefix, depth + 1);
      return;
    }
    for (const key of Object.keys(item).sort()) {
      if (fields.size >= limit) break;
      const safeKey = safeFieldName(key);
      if (!safeKey) continue;
      const name = prefix ? `${prefix}.${safeKey}` : safeKey;
      fields.add(name.slice(0, 160));
      visit(item[key], name, depth + 1);
    }
  };
  visit(value);
  return [...fields].sort();
}

function parsePostData(postData, mime) {
  if (!postData || typeof postData !== 'object') return { fields: [], encoding: null, bytes: null };
  const postMime = normalizeMime(postData.mimeType) ?? mime;
  const text = typeof postData.text === 'string' ? postData.text : null;
  let fields = [];
  if (Array.isArray(postData.params)) {
    fields = postData.params.map(param => param?.name).filter(name => typeof name === 'string');
  }
  if (text !== null && postMime === 'application/json') {
    try { fields = [...fields, ...collectNestedFields(JSON.parse(text))]; }
    catch { /* Retain names from HAR params only; never expose an unparsed sample. */ }
  } else if (text !== null && postMime === 'application/x-www-form-urlencoded') {
    try { fields = [...fields, ...new URLSearchParams(text).keys()]; }
    catch { /* Malformed form data stays an unnamed body candidate. */ }
  }
  const encoding = postMime ?? (Array.isArray(postData.params) ? 'multipart/form-data' : text !== null ? 'text/plain' : null);
  return {
    fields: normalizeFieldNames(fields),
    encoding,
    bytes: text === null ? null : Buffer.byteLength(text, 'utf8'),
  };
}

function requestedJsonpCallback(request) {
  // The wrapper must match the callback actually requested, never a name
  // inferred from executable response text. Keep the value in memory only.
  const callbacks = new URL(request.url).searchParams.getAll('callback');
  return {
    present: callbacks.length > 0,
    value: callbacks.length === 1 && /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(callbacks[0])
      ? callbacks[0] : null,
  };
}

function parseJsonp(text, callback) {
  if (!callback) throw fail('XHR_JSONP_INVALID');
  const trimmed = text.trim();
  const prefix = new RegExp(`^${callback.replace(/[$]/g, '\\$')}\\s*\\(`).exec(trimmed);
  const suffix = /\)\s*;?$/.exec(trimmed);
  if (!prefix || !suffix || suffix.index < prefix[0].length) throw fail('XHR_JSONP_INVALID');
  // JSON.parse rejects multiple arguments, expressions, comments, executable
  // suffixes and JS object literals. No eval, Function or VM is involved.
  return JSON.parse(trimmed.slice(prefix[0].length, suffix.index));
}

function responsePayload(response, request) {
  const content = response?.content && typeof response.content === 'object' ? response.content : {};
  const mime = normalizeMime(content.mimeType) ?? contentType(response?.headers);
  if (typeof content.text !== 'string') {
    return { mime, bytes: Number.isSafeInteger(content.size) && content.size >= 0 ? content.size : null, sha256: null, schema: null, bodyAvailable: false };
  }
  const bytes = content.encoding === 'base64'
    ? Buffer.from(content.text, 'base64')
    : Buffer.from(content.text, 'utf8');
  if (content.encoding === 'base64' && bytes.toString('base64') !== content.text
    || content.encoding != null && content.encoding !== 'base64') {
    return { mime, bytes: null, sha256: null, schema: { state: 'invalid_body_encoding' }, format: null, bodyAvailable: false };
  }
  let schema = null, format = null;
  const callback = requestedJsonpCallback(request);
  const jsonMime = mime === 'application/json' || mime?.endsWith('+json');
  const jsMime = ['application/javascript', 'text/javascript', 'application/x-javascript'].includes(mime);
  if (jsonMime || jsMime && callback.present) {
    if (bytes.length > RESPONSE_SCHEMA_MAX_BYTES) schema = { state: 'omitted_size_limit', limitBytes: RESPONSE_SCHEMA_MAX_BYTES };
    else {
      const text = bytes.toString('utf8');
      try { schema = schemaOf(JSON.parse(text)); format = 'json'; }
      catch {
        try { schema = schemaOf(parseJsonp(text, callback.value)); format = 'jsonp'; }
        catch { schema = { state: callback.present ? 'invalid_jsonp' : 'invalid_json' }; }
      }
    }
  }
  return { mime, bytes: bytes.length, sha256: sha256(bytes), schema, format, bodyAvailable: true };
}

function operationFields(fields) {
  return fields.filter(field => OPERATION_FIELD.test(field.split('.').at(-1) ?? field));
}

function identityOf(candidate) {
  const identity = {
    method: candidate.method,
    origin: candidate.origin,
    path: candidate.path,
    queryFields: candidate.queryFields,
    bodyFields: candidate.bodyFields,
    encoding: candidate.encoding,
    operationFields: candidate.operationFields,
  };
  return sha256(JSON.stringify(identity)).slice(0, 24);
}

export function normalizeCandidate(candidate = {}, evidence = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw fail('XHR_CANDIDATE_INVALID');
  let normalizedUrl = null;
  if (typeof candidate.url === 'string') normalizedUrl = normalizeUrl(candidate.url, { baseUrl: candidate.baseUrl });
  const origin = typeof candidate.origin === 'string' ? normalizeUrl(candidate.origin).origin : normalizedUrl?.origin;
  const path = typeof candidate.path === 'string' ? normalizePath(candidate.path) : normalizedUrl?.path;
  if (!origin || !path) throw fail('XHR_CANDIDATE_SCOPE_REQUIRED');
  const method = typeof candidate.method === 'string' && /^[A-Za-z]{3,12}$/.test(candidate.method)
    ? candidate.method.toUpperCase() : 'UNKNOWN';
  const queryFields = normalizeFieldNames(candidate.queryFields ?? normalizedUrl?.queryFields ?? []);
  const bodyFields = normalizeFieldNames(candidate.bodyFields ?? []);
  const opFields = normalizeFieldNames(candidate.operationFields ?? operationFields([...queryFields, ...bodyFields]));
  const encoding = normalizeMime(candidate.encoding) ?? null;
  const normalized = { method, origin, path, queryFields, bodyFields, encoding, operationFields: opFields };
  return {
    id: identityOf(normalized),
    ...normalized,
    mutationCandidate: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method),
    semanticOperation: opFields.length ? 'selector_fields_observed_values_omitted' : 'unknown',
    evidence: {
      source: ['HAR', 'HTML', 'source', 'direct_replay', 'DOM', 'network'].includes(evidence.source) ? evidence.source : 'unknown',
      sourceReference: typeof evidence.sourceReference === 'string' && /^(?:entry|html-node|source)-\d{1,9}$/.test(evidence.sourceReference)
        ? evidence.sourceReference : null,
      valuesRecorded: false,
    },
  };
}

export function contractsFromHar(har, { generatedAt = new Date().toISOString() } = {}) {
  if (!har || typeof har !== 'object' || Array.isArray(har) || !Array.isArray(har.log?.entries)) throw fail('XHR_HAR_INVALID');
  const grouped = new Map();
  let skipped = 0;
  har.log.entries.forEach((entry, sourceIndex) => {
    try {
      const request = entry?.request;
      if (!request || typeof request.url !== 'string') { skipped += 1; return; }
      const normalizedUrl = normalizeUrl(request.url);
      const method = typeof request.method === 'string' && /^[A-Za-z]{3,12}$/.test(request.method) ? request.method.toUpperCase() : 'UNKNOWN';
      const headerRequestMime = contentType(request.headers);
      const body = parsePostData(request.postData, headerRequestMime);
      const requestMime = headerRequestMime ?? normalizeMime(request.postData?.mimeType);
      const queryFields = normalizeFieldNames([
        ...normalizedUrl.queryFields,
        ...(Array.isArray(request.queryString) ? request.queryString.map(item => item?.name).filter(name => typeof name === 'string') : []),
      ]);
      const fields = [...queryFields, ...body.fields];
      const candidate = normalizeCandidate({
        method,
        origin: normalizedUrl.origin,
        path: normalizedUrl.path,
        queryFields,
        bodyFields: body.fields,
        encoding: body.encoding,
      }, { source: 'HAR', sourceReference: `entry-${sourceIndex + 1}` });
      const response = responsePayload(entry.response, request);
      const observedAt = typeof entry.startedDateTime === 'string' && Number.isFinite(Date.parse(entry.startedDateTime))
        ? new Date(entry.startedDateTime).toISOString() : null;
      const observation = {
        source: 'HAR',
        sourceEntry: sourceIndex + 1,
        observedAt,
        requestMime,
        requestBytes: body.bytes ?? (Number.isSafeInteger(request.bodySize) && request.bodySize >= 0 ? request.bodySize : null),
        status: Number.isInteger(entry.response?.status) ? entry.response.status : null,
        responseMime: response.mime,
        responseBytes: response.bytes,
        responseSha256: response.sha256,
        responseBodyAvailable: response.bodyAvailable,
        responseSchema: response.schema,
        responseFormat: response.format ?? null,
        businessOutcome: 'unclassified',
        operationFields: operationFields(fields),
        selectorValuesRecorded: false,
      };
      const existing = grouped.get(candidate.id);
      if (existing) existing.observations.push(observation);
      else grouped.set(candidate.id, { ...candidate, evidence: undefined, observations: [observation] });
    } catch {
      skipped += 1;
    }
  });
  const contracts = [...grouped.values()].map(contract => ({
    ...contract,
    observations: contract.observations.sort((a, b) => a.sourceEntry - b.sourceEntry),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema: 'xhr-contract-inventory-v1',
    generatedAt: Number.isFinite(Date.parse(generatedAt)) ? new Date(generatedAt).toISOString() : null,
    sourceEvidence: { kind: 'HAR', entriesSeen: har.log.entries.length, entriesSkipped: skipped, valuesRecorded: false },
    contracts,
  };
}
