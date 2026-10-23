import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatGPTWebError } from './errors.mjs';

export const SERVICE = 'chatgpt-web';
export const PRIMARY_ORIGIN = 'https://chatgpt.com';
export const REGISTRY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'registry.json');

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,79}$/;
const INPUT_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const METHOD = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const OPERATION_KIND = new Set(['read', 'mutation', 'media-upload', 'media-download']);
const REQUEST_ENCODING = new Set(['none', 'json', 'form', 'multipart', 'binary']);
const RESPONSE_KIND = new Set(['json', 'sse', 'text', 'media']);
const SENSITIVE_NAME = /(authorization|authentication|(?:^|[_-])auth(?:$|[_-])|cookie|password|secret|token|captcha|challenge|sentinel|clearance|turnstile|api.?key|proof|session|csrf|signature|nonce|credential)/i;
const FORBIDDEN_HEADERS = /^(?:cookie|set-cookie|authorization|proxy-authorization|host|origin|referer|user-agent|content-length|connection|sec-.+)$/i;
const FORBIDDEN_HEADER_CONTENT = /(captcha|challenge|sentinel|turnstile|clearance|api.?key)/i;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

function invalid(reason = 'invalid') {
  throw new ChatGPTWebError('CONTRACT_INVALID', { reason });
}

function validOrigin(value, allowedOrigins, { primaryOnly = false } = {}) {
  if (typeof value !== 'string') invalid('origin');
  let parsed;
  try { parsed = new URL(value); } catch { invalid('origin'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) invalid('origin');
  const origin = parsed.origin;
  if (!allowedOrigins.includes(origin) || (primaryOnly && origin !== PRIMARY_ORIGIN)) invalid('origin');
  return origin;
}

function validateTemplate(node, inputSchema, depth = 0) {
  if (depth > 32) invalid('template-depth');
  if (Array.isArray(node)) {
    if (node.length > 10000) invalid('template-size');
    for (const value of node) validateTemplate(value, inputSchema, depth + 1);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const keys = Object.keys(node);
  if (keys.length === 1 && keys[0] === '$input') {
    if (typeof node.$input !== 'string' || !Object.hasOwn(inputSchema, node.$input)) invalid('input-reference');
    return;
  }
  for (const key of keys) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || SENSITIVE_NAME.test(key)) invalid('unsafe-template-key');
    validateTemplate(node[key], inputSchema, depth + 1);
  }
}

function validateInputSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) invalid('input-schema');
  for (const [name, spec] of Object.entries(schema)) {
    if (!INPUT_IDENTIFIER.test(name) || SENSITIVE_NAME.test(name)) invalid('input-name');
    if (!spec || !['string', 'number', 'integer', 'boolean'].includes(spec.type)) invalid('input-type');
    if (spec.required !== undefined && typeof spec.required !== 'boolean') invalid('input-required');
    if (spec.maxLength !== undefined && (!Number.isInteger(spec.maxLength) || spec.maxLength < 1 || spec.maxLength > 1_000_000)) invalid('input-limit');
    if (spec.min !== undefined && (!Number.isFinite(spec.min))) invalid('input-limit');
    if (spec.max !== undefined && (!Number.isFinite(spec.max))) invalid('input-limit');
    if (spec.enum !== undefined && (!Array.isArray(spec.enum) || spec.enum.length > 100)) invalid('input-enum');
  }
}

function validatePathTemplate(value, inputSchema) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096
    || value.includes('?') || value.includes('#') || value.includes('\\') || /[\r\n\0]/.test(value)
    || value.startsWith('//')) invalid('path');
  const plain = value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_whole, name) => {
    if (!Object.hasOwn(inputSchema, name) || inputSchema[name].required !== true) invalid('path-input');
    return 'placeholder';
  });
  if (/[{}]/.test(plain) || plain.split('/').some((part) => part === '.' || part === '..')) invalid('path-template');
}

function validateOperation(operation, registry) {
  if (!operation || typeof operation !== 'object' || !IDENTIFIER.test(operation.id)) invalid('operation-id');
  if (!OPERATION_KIND.has(operation.kind) || operation.captured !== true) invalid('operation-capture');
  if (typeof operation.observedAt !== 'string' || !Number.isFinite(Date.parse(operation.observedAt))) invalid('observed-at');
  if (!operation.evidence || typeof operation.evidence.requestRef !== 'string'
    || !operation.evidence.requestRef || typeof operation.evidence.responseRef !== 'string'
    || !operation.evidence.responseRef) invalid('evidence-ref');
  const origin = validOrigin(operation.origin, registry.allowedOrigins);
  if (typeof operation.method !== 'string' || !METHOD.has(operation.method.toUpperCase())) invalid('method');
  if (operation.auth !== 'chatgpt-session' && operation.auth !== 'none') invalid('auth-mode');
  const inputSchema = operation.inputSchema || {};
  validateInputSchema(inputSchema);
  validatePathTemplate(operation.pathTemplate, inputSchema);
  if (operation.queryTemplate !== undefined) {
    if (!Array.isArray(operation.queryTemplate) || operation.queryTemplate.length > 100) invalid('query-template');
    for (const pair of operation.queryTemplate) {
      if (!pair || typeof pair.name !== 'string' || pair.name.length > 256 || /[\r\n\0&=#]/.test(pair.name)
        || SENSITIVE_NAME.test(pair.name)) invalid('query-name');
      if (pair.input !== undefined && (!Object.hasOwn(inputSchema, pair.input) || SENSITIVE_NAME.test(pair.input))) invalid('query-input');
      if (pair.value !== undefined && typeof pair.value !== 'string' && typeof pair.value !== 'number' && typeof pair.value !== 'boolean') invalid('query-value');
      if (pair.input === undefined && pair.value === undefined) invalid('query-value');
    }
  }
  const request = operation.request;
  if (!request || !REQUEST_ENCODING.has(request.encoding)) invalid('request-encoding');
  if (request.headers !== undefined) {
    if (!request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers)) invalid('request-headers');
    for (const [name, value] of Object.entries(request.headers)) {
      if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.test(name) || FORBIDDEN_HEADER_CONTENT.test(name)
        || SENSITIVE_NAME.test(name)) invalid('request-header-name');
      if (typeof value !== 'string' && !(value && typeof value === 'object' && typeof value.$input === 'string'
        && Object.hasOwn(inputSchema, value.$input) && !SENSITIVE_NAME.test(value.$input))) invalid('request-header-value');
      if (typeof value === 'string' && /[\r\n\0]/.test(value)) invalid('request-header-value');
    }
  }
  if (request.encoding === 'json' || request.encoding === 'form') {
    if (!Object.hasOwn(request, 'template')) invalid('request-template');
    validateTemplate(request.template, inputSchema);
  } else if (request.encoding === 'none') {
    if (Object.hasOwn(request, 'template')) invalid('unexpected-request-template');
  } else if (request.encoding === 'multipart' || request.encoding === 'binary') {
    const media = request.media;
    if (!media || typeof media !== 'object' || typeof media.maxBytes !== 'number'
      || !Number.isInteger(media.maxBytes) || media.maxBytes < 1 || media.maxBytes > 200_000_000
      || !Array.isArray(media.contentTypes) || !media.contentTypes.length
      || media.contentTypes.some((type) => typeof type !== 'string' || !MIME.test(type))) invalid('media-request');
    if (request.encoding === 'multipart' && (typeof media.fieldName !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(media.fieldName))) invalid('media-field');
    if (request.encoding === 'multipart' && Object.keys(request.headers || {}).some((name) => name.toLowerCase() === 'content-type')) invalid('multipart-content-type');
    const binaryContentType = Object.entries(request.headers || {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    if (request.encoding === 'binary' && (typeof binaryContentType !== 'string'
      || !media.contentTypes.includes(binaryContentType.split(';', 1)[0].trim().toLowerCase()))) invalid('binary-content-type');
    if (media.filenameInput !== undefined && (!Object.hasOwn(inputSchema, media.filenameInput) || SENSITIVE_NAME.test(media.filenameInput))) invalid('media-filename-input');
    if (request.encoding === 'multipart' && request.textFields !== undefined) validateTemplate(request.textFields, inputSchema);
  }
  const response = operation.response;
  if (!response || !RESPONSE_KIND.has(response.kind) || !Array.isArray(response.contentTypes)
    || !response.contentTypes.length || response.contentTypes.some((type) => typeof type !== 'string' || !MIME.test(type))
    || !Array.isArray(response.successStatuses) || !response.successStatuses.length
    || response.successStatuses.some((status) => !Number.isInteger(status) || status < 200 || status > 299)
    || !Number.isInteger(response.maxBytes) || response.maxBytes < 1 || response.maxBytes > 200_000_000) invalid('response-contract');
  if (response.allowEmpty !== undefined && typeof response.allowEmpty !== 'boolean') invalid('allow-empty');
  if (response.kind === 'sse' && (response.maxBytes > 200_000_000
    || !response.contentTypes.some((type) => type.toLowerCase() === 'text/event-stream'))) invalid('sse-content-type');
  if ((operation.kind === 'media-download' || response.kind === 'media')
    && (!response.media || !Array.isArray(response.media.contentTypes) || !response.media.contentTypes.length
      || response.media.contentTypes.some((type) => typeof type !== 'string' || !MIME.test(type)))) invalid('media-response');
  if (operation.kind === 'media-upload' && !['multipart', 'binary'].includes(request.encoding)) invalid('media-upload-encoding');
  if (operation.kind === 'mutation' || operation.kind === 'media-upload') {
    if (operation.targetInput !== undefined && (!Object.hasOwn(inputSchema, operation.targetInput) || SENSITIVE_NAME.test(operation.targetInput))) invalid('target-input');
  }
  if (operation.readbackOperationId !== undefined && !IDENTIFIER.test(operation.readbackOperationId)) invalid('readback-operation');
  if (operation.readbackAuthoritativeForAbsence !== undefined && typeof operation.readbackAuthoritativeForAbsence !== 'boolean') invalid('readback-authority');
  return { ...operation, origin, method: operation.method.toUpperCase(), inputSchema };
}

export function validateRegistry(registry) {
  if (!registry || typeof registry !== 'object' || registry.schemaVersion !== 1
    || registry.service !== SERVICE || registry.primaryOrigin !== PRIMARY_ORIGIN
    || !Array.isArray(registry.allowedOrigins) || !registry.allowedOrigins.includes(PRIMARY_ORIGIN)
    || !Array.isArray(registry.operations)) invalid('registry');
  const allowedOrigins = [...new Set(registry.allowedOrigins.map((origin) => validOrigin(origin, registry.allowedOrigins)))];
  for (const origin of allowedOrigins) {
    if (origin === PRIMARY_ORIGIN) continue;
    const reference = registry.originEvidence?.[origin];
    if (!reference || typeof reference.requestRef !== 'string' || !reference.requestRef
      || typeof reference.responseRef !== 'string' || !reference.responseRef) invalid('origin-evidence');
  }
  const ids = new Set();
  const operations = registry.operations.map((operation) => {
    const validated = validateOperation(operation, { ...registry, allowedOrigins });
    if (ids.has(validated.id)) invalid('duplicate-operation-id');
    ids.add(validated.id);
    return validated;
  });
  return { ...registry, allowedOrigins, operations };
}

export async function loadRegistry(file = REGISTRY_PATH) {
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new ChatGPTWebError('CONTRACT_REGISTRY_UNAVAILABLE'); }
  return validateRegistry(parsed);
}

export function getOperation(registry, operationId) {
  if (!registry || registry.service !== SERVICE || !Array.isArray(registry.operations)) {
    throw new ChatGPTWebError('CONTRACT_NOT_CAPTURED', { operationId, contractState: 'registry_unavailable' });
  }
  const operation = registry.operations.find((candidate) => candidate.id === operationId && candidate.captured === true);
  if (!operation) throw new ChatGPTWebError('CONTRACT_NOT_CAPTURED', { operationId, contractState: 'not_captured' });
  return operation;
}

export function validateInputs(operation, inputs = {}) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new ChatGPTWebError('INPUTS_INVALID');
  const schema = operation.inputSchema || {};
  for (const name of Object.keys(inputs)) if (!Object.hasOwn(schema, name)) throw new ChatGPTWebError('INPUT_UNKNOWN');
  for (const [name, spec] of Object.entries(schema)) {
    const value = inputs[name];
    if (value === undefined || value === null) {
      if (spec.required) throw new ChatGPTWebError('INPUT_REQUIRED');
      continue;
    }
    const typeOk = spec.type === 'string' ? typeof value === 'string'
      : spec.type === 'integer' ? Number.isInteger(value)
        : spec.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === 'boolean';
    if (!typeOk) throw new ChatGPTWebError('INPUT_TYPE_INVALID');
    if (typeof value === 'string' && (value.length > (spec.maxLength ?? 1_000_000)
      || value.length < (spec.minLength ?? 0) || /[\0]/.test(value))) throw new ChatGPTWebError('INPUT_VALUE_INVALID');
    if (typeof value === 'number' && ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max))) {
      throw new ChatGPTWebError('INPUT_VALUE_INVALID');
    }
    if (spec.enum && !spec.enum.includes(value)) throw new ChatGPTWebError('INPUT_VALUE_INVALID');
  }
  return inputs;
}

function bindTemplate(template, inputs) {
  if (Array.isArray(template)) return template.map((value) => bindTemplate(value, inputs));
  if (!template || typeof template !== 'object') return template;
  if (Object.keys(template).length === 1 && typeof template.$input === 'string') return inputs[template.$input];
  const result = Object.create(null);
  for (const [key, value] of Object.entries(template)) result[key] = bindTemplate(value, inputs);
  return result;
}

export function materializeRequest(operation, inputs = {}) {
  validateInputs(operation, inputs);
  const pathValue = operation.pathTemplate.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (_whole, name) => encodeURIComponent(String(inputs[name])));
  const url = new URL(pathValue, operation.origin);
  if (url.origin !== operation.origin || url.protocol !== 'https:') throw new ChatGPTWebError('REQUEST_ORIGIN_REJECTED', { operationId: operation.id });
  for (const pair of operation.queryTemplate || []) {
    const value = pair.input === undefined ? pair.value : inputs[pair.input];
    url.searchParams.append(pair.name, String(value));
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(operation.request.headers || {})) {
    const bound = typeof value === 'string' ? value : String(inputs[value.$input]);
    if (/[\r\n\0]/.test(bound)) throw new ChatGPTWebError('INPUT_VALUE_INVALID');
    headers.set(name, bound);
  }
  let body;
  if (operation.request.encoding === 'json') {
    body = JSON.stringify(bindTemplate(operation.request.template, inputs));
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  } else if (operation.request.encoding === 'form') {
    const fields = bindTemplate(operation.request.template, inputs);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new ChatGPTWebError('CONTRACT_INVALID', { reason: 'form-template' });
    const form = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new ChatGPTWebError('CONTRACT_INVALID', { reason: 'form-value' });
      form.append(name, String(value));
    }
    body = form;
    if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
  } else if (operation.request.encoding === 'none') {
    body = undefined;
  }
  return { url, method: operation.method, headers, body };
}

export function operationSummary(registry) {
  const families = ['text', 'history', 'image', 'video'];
  const operations = Object.fromEntries(families.map((family) => [family, {
    captured: registry.operations.some((operation) => operation.family === family && operation.captured === true),
    clientExists: false,
    credentialPropagated: false,
    liveReplay: false,
  }]));
  return {
    genericInfrastructureReady: true,
    contractState: registry.operations.length ? 'partially_captured' : 'CONTRACT_NOT_CAPTURED',
    operations,
  };
}
