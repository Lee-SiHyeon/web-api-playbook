import { fail } from './cli.mjs';

export const serviceName = value => typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(value);
export function validateProfile(profile) {
  if (profile?.schemaVersion !== 1 || !serviceName(profile.serviceId) || !Array.isArray(profile.allowedOrigins)
    || !profile.allowedOrigins.length || !profile.operations || typeof profile.operations !== 'object' || Array.isArray(profile.operations)) fail('PROFILE_INVALID');
  for (const origin of profile.allowedOrigins) {
    let url; try { url = new URL(origin); } catch { fail('PROFILE_ORIGIN_INVALID'); }
    if (url.origin !== origin || url.username || url.password || !(url.protocol === 'https:'
      || profile.allowLoopbackHttp === true && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) fail('PROFILE_ORIGIN_INVALID');
  }
  if (new Set(profile.allowedOrigins).size !== profile.allowedOrigins.length) fail('PROFILE_ORIGIN_INVALID');
  const cookieOrigins = profile.cookieOrigins ?? profile.allowedOrigins;
  if (!Array.isArray(cookieOrigins) || cookieOrigins.some(origin => !profile.allowedOrigins.includes(origin))) fail('PROFILE_COOKIE_SCOPE');
  for (const [name, operation] of Object.entries(profile.operations)) {
    if (!serviceName(name) || !operation || !profile.allowedOrigins.includes(operation.origin)
      || !['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(operation.method)
      || !['read','write'].includes(operation.semantics) || typeof operation.path !== 'string'
      || !operation.path.startsWith('/') || operation.path.startsWith('//') || /[?#\\\s]/.test(operation.path)
      || typeof operation.evidence !== 'string' || !operation.evidence.trim()
      || !Number.isInteger(operation.expected?.status) || !Array.isArray(operation.expected?.checks)
      || !operation.expected.checks.length || operation.expected?.mime !== 'application/json') fail('PROFILE_OPERATION_INVALID');
    for (const field of ['queryFields','bodyFields']) if (operation[field] !== undefined
      && (!Array.isArray(operation[field]) || operation[field].some(key => typeof key !== 'string' || /token|cookie|password|secret|authorization|credential/i.test(key)))) fail('PROFILE_FIELDS_INVALID');
  }
  if (Object.values(profile.operations).some(operation => operation.protected === true)) {
    const probe = profile.operations[profile.probeOperation];
    if (!probe || probe.semantics !== 'read' || !probe.expected.checks.some(check => check.identity === true)
      || /[{}]/.test(probe.path) || probe.queryFields?.length || probe.bodyFields?.length) fail('PROFILE_IDENTITY_CHECK_REQUIRED');
  }
  return profile;
}
export function requestFromProfile(profile, name, input = {}) {
  const operation = profile.operations[name]; if (!operation) fail('OPERATION_UNKNOWN');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['path','query','body'].includes(key))) fail('PARAMETERS_INVALID');
  const used = new Set();
  const pathname = operation.path.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, key) => {
    used.add(key); const value = input.path?.[key];
    if (!['string','number'].includes(typeof value) || !String(value) || String(value).length > 256
      || /[\s/\\?#]/.test(String(value)) || ['.','..'].includes(String(value))) fail('PATH_PARAMETER_INVALID');
    return encodeURIComponent(String(value));
  });
  if (/[{}]/.test(pathname) || Object.keys(input.path ?? {}).some(key => !used.has(key))) fail('PATH_PARAMETER_INVALID');
  const url = new URL(pathname, operation.origin);
  if (url.origin !== operation.origin || url.pathname !== pathname) fail('REQUEST_SCOPE');
  function checkFields(value, fields, code) {
    const required = fields ?? [];
    if (value === undefined && required.length === 0) return;
    if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...required].sort())) fail(code);
  }
  checkFields(input.query, operation.queryFields, 'QUERY_FIELDS_INVALID');
  checkFields(input.body, operation.bodyFields, 'BODY_FIELDS_INVALID');
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (typeof value !== 'string' || /[\r\n]/.test(value)) fail('QUERY_VALUE_INVALID'); url.searchParams.set(key, value);
  }
  if (['GET','HEAD'].includes(operation.method) && input.body !== undefined) fail('GET_BODY_FORBIDDEN');
  return { operation, url: url.href, init: { method: operation.method,
    headers: { accept: 'application/json', ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}) } };
}
export function validateResponse(response, expected, { identity = {} } = {}) {
  const mime = response.headers?.['content-type'] ?? '';
  if (response.status !== expected.status) fail([301,302,303,307,308,401].includes(response.status) ? 'AUTH_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : response.status === 429 ? 'RATE_LIMITED' : 'HTTP_UNEXPECTED');
  if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(mime)) fail('MIME_UNEXPECTED');
  let data; try { data = JSON.parse(response.raw); } catch { fail('RESPONSE_JSON_INVALID'); }
  for (const check of expected.checks) {
    if (!Array.isArray(check.path) || check.path.some(key => !['string','number'].includes(typeof key) || ['__proto__','prototype','constructor'].includes(key))) fail('RESPONSE_CHECK_INVALID');
    let value = data; for (const key of check.path) value = value != null && Object.hasOwn(Object(value), key) ? value[key] : undefined;
    if (check.type && (check.type === 'array' ? !Array.isArray(value) : check.type === 'null' ? value !== null : check.type === 'object' ? value === null || typeof value !== 'object' || Array.isArray(value) : typeof value !== check.type)) fail('APPLICATION_SCHEMA_MISMATCH');
    if (Object.hasOwn(check, 'equals') && JSON.stringify(value) !== JSON.stringify(check.equals)) fail('APPLICATION_RESULT_MISMATCH');
    if (check.identity === true) {
      if (!serviceName(check.identityKey) || !Object.hasOwn(identity, check.identityKey) || JSON.stringify(value) !== JSON.stringify(identity[check.identityKey])) fail('OWNER_MISMATCH');
    }
    if (!check.type && !Object.hasOwn(check, 'equals') && check.identity !== true) fail('RESPONSE_CHECK_INVALID');
  }
  return data;
}
