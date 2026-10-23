import { createHash } from 'node:crypto';
import { ScopedSession } from './scoped-session.mjs';
import { validateProfile, requestFromProfile, validateResponse, serviceName } from './profile.mjs';
import { extractOperationResponse } from './operation-extract.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const groups = ['path', 'query', 'body'];
const kinds = ['string', 'integer', 'number', 'boolean', 'object', 'array', 'null', 'json'];
const schemaKeys = new Set(['type', 'title', 'description', 'default', 'enum', 'properties', 'required', 'items',
  'additionalProperties', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
function problem(code, status) {
  const error = new Error(code); error.code = code;
  if (status !== undefined) error.status = status;
  throw error;
}
function plainKey(key) { return typeof key === 'string' && key.length > 0 && !['__proto__', 'prototype', 'constructor'].includes(key); }
function jsonValue(value, ancestors = new Set(), depth = 0) {
  if (depth > 30) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value) ||
      !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  ancestors.add(value);
  const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(item => jsonValue(item, ancestors, depth + 1));
  ancestors.delete(value); return valid;
}
function equalJson(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a).sort(), right = Object.keys(b).sort();
  return left.length === right.length && left.every((key, index) => key === right[index] && equalJson(a[key], b[key]));
}
const hasDefault = field => Object.hasOwn(field, 'default') || field.schema && Object.hasOwn(field.schema, 'default');
const defaultOf = field => Object.hasOwn(field, 'default') ? field.default : field.schema?.default;
function invoke(task, signal) {
  const abortError = () => Object.assign(new Error('OPERATION_ABORTED'), { code: 'OPERATION_ABORTED' });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok, value) => {
      if (done) return;
      done = true; signal?.removeEventListener('abort', onAbort);
      if (ok) resolve(value); else reject(value);
    };
    const onAbort = () => finish(false, abortError());
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => { if (signal?.aborted) throw abortError(); return task(); })
      .then(value => signal?.aborted ? onAbort() : finish(true, value), error =>
        signal?.aborted || error?.name === 'AbortError' ? finish(false, abortError()) : finish(false, error));
  });
}
function freeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value); for (const item of Object.values(value)) freeze(item, seen);
  return Object.freeze(value);
}

function assertSchema(schema, depth = 0, field = false) {
  if (!object(schema) || depth > 20 || Object.keys(schema).some(key => !schemaKeys.has(key) && !(field && key === 'schema')) ||
      schema.type !== undefined && !kinds.includes(schema.type)) problem('OPERATION_SCHEMA_INVALID');
  if (schema.schema !== undefined) assertSchema(schema.schema, depth + 1);
  if (schema.schema !== undefined && Object.keys(schema).some(key => !['schema', 'required', 'title', 'description', 'default'].includes(key))) problem('OPERATION_SCHEMA_INVALID');
  for (const key of ['description', 'title']) if (schema[key] !== undefined && typeof schema[key] !== 'string') problem('OPERATION_SCHEMA_INVALID');
  if (schema.required !== undefined && !(field && typeof schema.required === 'boolean') &&
      (!Array.isArray(schema.required) || schema.required.some(key => !plainKey(key)) || new Set(schema.required).size !== schema.required.length)) problem('OPERATION_SCHEMA_INVALID');
  if (schema.properties !== undefined) {
    if (!object(schema.properties)) problem('OPERATION_SCHEMA_INVALID');
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!plainKey(key)) problem('OPERATION_SCHEMA_INVALID');
      assertSchema(child, depth + 1);
    }
  }
  if (schema.items !== undefined) assertSchema(schema.items, depth + 1);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') problem('OPERATION_SCHEMA_INVALID');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || !jsonValue(schema.enum))) problem('OPERATION_SCHEMA_INVALID');
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && (!Number.isFinite(schema[key]) || /Length|Items/.test(key) && (!Number.isSafeInteger(schema[key]) || schema[key] < 0))) problem('OPERATION_SCHEMA_INVALID');
  }
  if (Object.hasOwn(schema, 'default')) validateOperationValue(schema.default, schema.schema ?? schema, 'OPERATION_DEFAULT_INVALID');
}

/** Deliberately bounded JSON Schema subset; unsupported keywords fail at registration. */
export function validateOperationValue(value, schema = {}, code = 'OPERATION_INPUT_INVALID', depth = 0) {
  if (depth === 0 && !jsonValue(value)) problem(code);
  if (depth > 30) problem(code);
  const type = schema.type;
  const valid = type === undefined || type === 'json' ||
    type === 'integer' && Number.isSafeInteger(value) ||
    type === 'number' && typeof value === 'number' && Number.isFinite(value) ||
    type === 'object' && object(value) || type === 'array' && Array.isArray(value) ||
    type === 'null' && value === null || ['string', 'boolean'].includes(type) && typeof value === type;
  if (!valid || value === undefined || typeof value === 'number' && !Number.isFinite(value)) problem(code);
  if (schema.enum && !schema.enum.some(item => equalJson(item, value))) problem(code);
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) problem(code);
  if (typeof value === 'string' && (schema.minLength !== undefined && [...value].length < schema.minLength || schema.maxLength !== undefined && [...value].length > schema.maxLength)) problem(code);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) problem(code);
    if (schema.items) for (const item of value) validateOperationValue(item, schema.items, code, depth + 1);
  }
  if (object(value)) {
    const properties = schema.properties ?? {};
    if (Array.isArray(schema.required) && schema.required.some(key => !Object.hasOwn(value, key))) problem(code);
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(properties, key))) problem(code);
    for (const [key, child] of Object.entries(properties)) if (Object.hasOwn(value, key)) validateOperationValue(value[key], child, code, depth + 1);
  }
  return value;
}

export function validateOperationProfile(profile) {
  if (profile?.schemaVersion === 1) return validateProfile(profile);
  if (profile?.schemaVersion !== 2 || !serviceName(profile.serviceId) || !object(profile.operations) ||
      !Object.keys(profile.operations).length || !Array.isArray(profile.allowedOrigins) || new Set(profile.allowedOrigins).size !== profile.allowedOrigins.length) problem('OPERATION_PROFILE_INVALID');
  for (const origin of profile.allowedOrigins) {
    let url; try { url = new URL(origin); } catch { problem('PROFILE_ORIGIN_INVALID'); }
    if (url.origin !== origin || url.username || url.password || !(url.protocol === 'https:' ||
        profile.allowLoopbackHttp === true && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) problem('PROFILE_ORIGIN_INVALID');
  }
  if (profile.cookieOrigins && (!Array.isArray(profile.cookieOrigins) || profile.cookieOrigins.some(origin => !profile.allowedOrigins.includes(origin)))) problem('PROFILE_COOKIE_SCOPE');
  for (const [name, op] of Object.entries(profile.operations)) {
    if (!serviceName(name) || !object(op) || !['read', 'write'].includes(op.semantics) || typeof op.evidence !== 'string' || !op.evidence.trim()) problem('OPERATION_DEFINITION_INVALID');
    for (const key of ['description', 'desc']) if (op[key] !== undefined && typeof op[key] !== 'string') problem('OPERATION_DEFINITION_INVALID');
    if (op.adapter !== undefined && !serviceName(op.adapter)) problem('OPERATION_ADAPTER_INVALID');
    if (!op.adapter && (!profile.allowedOrigins.includes(op.origin) || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(op.method) ||
        typeof op.path !== 'string' || !op.path.startsWith('/') || op.path.startsWith('//') || /[?#\\\s]/.test(op.path) ||
        !Number.isInteger(op.expected?.status) || op.expected.status < 100 || op.expected.status > 599)) problem('OPERATION_DEFINITION_INVALID');
    if (op.transport && op.transport !== 'http' && !op.adapter) problem('OPERATION_TRANSPORT_UNSUPPORTED');
    if (op.bodyEncoding !== undefined && !['json', 'form'].includes(op.bodyEncoding)) problem('OPERATION_BODY_ENCODING_INVALID');
    if (op.inputs !== undefined && (!object(op.inputs) || Object.keys(op.inputs).some(group => !groups.includes(group)))) problem('OPERATION_INPUT_SCHEMA_INVALID');
    for (const group of groups) {
      if (op.inputs?.[group] !== undefined && !object(op.inputs[group])) problem('OPERATION_INPUT_SCHEMA_INVALID');
      for (const [key, definition] of Object.entries(op.inputs?.[group] ?? {})) {
        if (!plainKey(key)) problem('OPERATION_INPUT_SCHEMA_INVALID');
        assertSchema(definition, 0, true);
      }
    }
    if (op.outputSchema !== undefined) assertSchema(op.outputSchema);
    if (!op.adapter) {
      const placeholders = [...op.path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]);
      if (/[{}]/.test(op.path.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, '')) ||
          placeholders.some(key => !op.inputs?.path?.[key]) || Object.keys(op.inputs?.path ?? {}).some(key => !placeholders.includes(key))) problem('OPERATION_PATH_SCHEMA_INVALID');
    }
  }
  return profile;
}

function definitions(profile, op) {
  if (profile.schemaVersion === 2) return op.inputs ?? {};
  return {
    path: Object.fromEntries([...op.path.matchAll(/\{(\w+)\}/g)].map(match => [match[1], { type: 'string', required: true }])),
    query: Object.fromEntries((op.queryFields ?? []).map(key => [key, { type: 'string', required: true }])),
    body: Object.fromEntries((op.bodyFields ?? []).map(key => [key, { type: 'json', required: true }])),
  };
}
function normalizeInput(profile, op, input) {
  if (!object(input) || Object.keys(input).some(key => !groups.includes(key) || !object(input[key]))) problem('OPERATION_INPUT_INVALID');
  const result = {};
  for (const [group, fields] of Object.entries(definitions(profile, op))) {
    const supplied = input[group] ?? {};
    if (!object(supplied) || Object.keys(supplied).some(key => !Object.hasOwn(fields, key))) problem('OPERATION_INPUT_INVALID');
    const values = {};
    for (const [key, field] of Object.entries(fields)) {
      let value = supplied[key];
      if (value === undefined && hasDefault(field)) value = clone(defaultOf(field));
      if (value === undefined) { if (field.required === true) problem('OPERATION_INPUT_REQUIRED'); continue; }
      values[key] = clone(validateOperationValue(value, field.schema ?? field));
    }
    if (Object.keys(values).length || Object.hasOwn(input, group)) result[group] = values;
  }
  for (const group of groups) if (Object.hasOwn(input, group) && !Object.hasOwn(definitions(profile, op), group) && Object.keys(input[group] ?? {}).length) problem('OPERATION_INPUT_INVALID');
  return result;
}

export function operationInputSchema(profile, name) {
  const op = profile.operations[name]; if (!op) problem('OPERATION_UNKNOWN');
  const properties = {}, required = [];
  for (const [group, fields] of Object.entries(definitions(profile, op))) {
    if (!Object.keys(fields).length) continue;
    const groupRequired = [], fieldProperties = {};
    for (const [key, definition] of Object.entries(fields)) {
      const schema = clone(definition.schema ?? definition);
      for (const key of ['description', 'title', 'default']) if (Object.hasOwn(definition, key)) schema[key] = clone(definition[key]);
      if (typeof schema.required === 'boolean') delete schema.required;
      fieldProperties[key] = jsonSchema(schema);
      if (definition.required === true && !hasDefault(definition)) groupRequired.push(key);
    }
    properties[group] = { type: 'object', properties: fieldProperties, additionalProperties: false, ...(groupRequired.length ? { required: groupRequired } : {}) };
    if (groupRequired.length) required.push(group);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function jsonSchema(schema) {
  if (schema.type === 'json') delete schema.type;
  if (schema.properties) for (const [key, value] of Object.entries(schema.properties)) schema.properties[key] = jsonSchema(value);
  if (schema.items) schema.items = jsonSchema(schema.items);
  return schema;
}

function buildRequest(profile, op, input) {
  if (profile.schemaVersion === 1) return requestFromProfile(profile, Object.keys(profile.operations).find(key => profile.operations[key] === op), input);
  const path = op.path.replace(/\{(\w+)\}/g, (_, key) => {
    const value = input.path?.[key];
    if (!['string', 'number'].includes(typeof value) || !String(value) || String(value).length > 256 || /[\s/\\?#]/.test(String(value)) || ['.', '..'].includes(String(value))) problem('PATH_PARAMETER_INVALID');
    return encodeURIComponent(value);
  });
  const url = new URL(path, op.origin);
  if (url.origin !== op.origin || url.pathname !== path) problem('REQUEST_SCOPE');
  for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, object(value) || Array.isArray(value) ? JSON.stringify(value) : String(value));
  if (['GET', 'HEAD'].includes(op.method) && input.body !== undefined) problem('GET_BODY_FORBIDDEN');
  const headers = { accept: op.expected?.mime ?? (op.response?.format === 'html' ? 'text/html' : 'application/json'), ...op.headers };
  let body;
  if (input.body !== undefined) {
    if (op.bodyEncoding === 'form') {
      if (Object.values(input.body).some(value => object(value) || Array.isArray(value))) problem('OPERATION_FORM_VALUE_INVALID');
      body = new URLSearchParams(Object.entries(input.body).map(([key, value]) => [key, String(value)])).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else { body = JSON.stringify(input.body); headers['content-type'] = 'application/json'; }
  }
  return { url: url.href, init: { method: op.method, headers, ...(body === undefined ? {} : { body }) } };
}

function toolName(service, name) {
  const value = `${service}__${name}`;
  return value.length <= 128 ? value : `${value.slice(0, 111)}_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}
export function createOperationRegistry(rawProfile, { adapters = {}, writeExecutor, session, fetchImpl, identity = {} } = {}) {
  const profile = freeze(clone(validateOperationProfile(rawProfile)));
  let http = session;
  const list = () => Object.entries(profile.operations).map(([id, op]) => ({
    id, serviceId: profile.serviceId, description: op.description ?? op.desc ?? id,
    semantics: op.semantics, inputSchema: operationInputSchema(profile, id),
    ...(op.outputSchema ? { outputSchema: clone(op.outputSchema) } : {}),
    ...(op.adapter ? { adapter: op.adapter } : {}), evidence: op.evidence,
  }));
  const describe = name => { const found = list().find(op => op.id === name); if (!found) problem('OPERATION_UNKNOWN'); return found; };
  const tools = () => list().map(op => ({ name: toolName(profile.serviceId, op.id), description: op.description,
    inputSchema: op.inputSchema, annotations: { readOnlyHint: op.semantics === 'read' },
    ...(op.outputSchema ? { outputSchema: { type: 'object', properties: {
      data: jsonSchema(op.outputSchema), pageInfo: { type: 'object' }, receipt: { type: 'object' },
    }, required: ['data', 'pageInfo', 'receipt'] } } : {}) }));
  async function execute(name, rawInput = {}, { signal } = {}) {
    const op = profile.operations[name]; if (!op) problem('OPERATION_UNKNOWN');
    if (signal?.aborted) problem('OPERATION_ABORTED');
    const input = normalizeInput(profile, op, rawInput);
    let result, response;
    if (op.semantics === 'write') {
      if (typeof writeExecutor !== 'function') problem('WRITE_ADAPTER_REQUIRED');
      result = await invoke(() => writeExecutor(name, clone(input), { signal, operation: clone(op) }), signal);
    } else if (op.adapter) {
      if (typeof adapters[op.adapter] !== 'function') problem('OPERATION_ADAPTER_REQUIRED');
      result = await invoke(() => adapters[op.adapter](clone(input), { signal, operation: clone(op) }), signal);
    } else {
      if (op.protected === true) problem('OPERATION_ADAPTER_REQUIRED');
      http ??= new ScopedSession({ allowedOrigins: profile.allowedOrigins, cookieOrigins: profile.cookieOrigins ?? [],
        allowLoopbackHttp: profile.allowLoopbackHttp === true, ...(fetchImpl ? { fetchImpl } : {}) });
      const request = buildRequest(profile, op, input);
      try { response = await invoke(() => http.request(request.url, { ...request.init, signal, includeFinalUrl: true }), signal); }
      catch (error) { if (signal?.aborted) problem('OPERATION_ABORTED'); throw error; }
      if (signal?.aborted) problem('OPERATION_ABORTED');
      if (profile.schemaVersion === 1) result = { data: validateResponse(response, op.expected, { identity }), pageInfo: {} };
      else {
        if (response.status !== op.expected.status) problem(response.status === 429 ? 'RATE_LIMITED' : response.status === 403 ? 'ACCESS_DENIED' : 'HTTP_UNEXPECTED', response.status);
        if (op.expected.mime && response.headers?.['content-type']?.split(';')[0].trim().toLowerCase() !== op.expected.mime.toLowerCase()) problem('MIME_UNEXPECTED', response.status);
        result = extractOperationResponse({ ...response, url: response.url ?? request.url }, op.response ?? { format: 'json' });
      }
    }
    if (signal?.aborted) problem('OPERATION_ABORTED');
    if (!object(result) || !Object.hasOwn(result, 'data') || !jsonValue(result.data) ||
        result.pageInfo !== undefined && (!object(result.pageInfo) || !jsonValue(result.pageInfo)) ||
        result.receipt !== undefined && (!object(result.receipt) || !jsonValue(result.receipt))) problem('OPERATION_ADAPTER_RESULT_INVALID');
    if (op.graphql === true && Array.isArray(result.data?.errors) && result.data.errors.length) problem('GRAPHQL_ERRORS');
    if (op.outputSchema) validateOperationValue(result.data, op.outputSchema, 'OPERATION_OUTPUT_MISMATCH');
    return { data: result.data, pageInfo: result.pageInfo ?? {}, receipt: {
      ...(result.receipt ?? {}), serviceId: profile.serviceId, operation: name, semantics: op.semantics,
      executionMode: op.adapter || op.semantics === 'write' ? 'existing_adapter' : 'pure_http',
      ...(response ? { httpStatus: response.status, responseSha256: createHash('sha256').update(response.raw).digest('hex') } : {}),
    } };
  }
  const callTool = async (name, input, options) => {
    const entry = Object.keys(profile.operations).find(id => toolName(profile.serviceId, id) === name);
    if (!entry) problem('OPERATION_UNKNOWN'); return execute(entry, input, options);
  };
  return { profile, list, describe, tools, execute, callTool };
}
