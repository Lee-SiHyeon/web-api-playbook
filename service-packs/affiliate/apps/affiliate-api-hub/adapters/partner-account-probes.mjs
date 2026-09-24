// Named, read-only operations. Credentials and raw account records stay in memory.
export const ACCOUNT_OPERATIONS = Object.freeze({
  myrealtrip: Object.freeze({
    origin: 'https://api3-backoffice.myrealtrip.com', path: '/partner/v1/partners',
    evidence: 'authenticated_browser_request_and_schema_observed',
  }),
  brandconnect: Object.freeze({
    origin: 'https://gw-brandconnect.naver.com', path: '/brand-connect/query/me',
    evidence: 'public_client_source_and_anonymous_http_schema_observed',
  }),
});

export class PartnerProbeError extends Error {
  constructor(code) { super(code); this.name = 'PartnerProbeError'; this.code = code; }
}
const fail = code => { throw new PartnerProbeError(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cookieOctets = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,16384}$/;
const MAX_BYTES = 1024 * 1024;

function validateText(value, max = 320) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x20\x7f]/.test(value)) fail('INPUT');
}

// This is deliberately scoped to one endpoint, not a generic Naver cookie jar.
export function brandconnectCookieHeader(cookies, now = Date.now()) {
  if (!Array.isArray(cookies) || cookies.length > 64) fail('AUTH_MISSING');
  const url = new URL(ACCOUNT_OPERATIONS.brandconnect.origin + ACCOUNT_OPERATIONS.brandconnect.path);
  const selected = new Map();
  for (const cookie of cookies) {
    if (!record(cookie) || !['NID_AUT', 'NID_SES', 'NID_JKL'].includes(cookie.name)) continue;
    const domain = typeof cookie.domain === 'string' ? cookie.domain.toLowerCase() : '';
    const host = domain.replace(/^\./, '');
    const domainMatches = host && (url.hostname === host || (domain.startsWith('.') && url.hostname.endsWith('.' + host)));
    const path = cookie.path;
    const pathMatches = typeof path === 'string' && path.startsWith('/') &&
      (url.pathname === path || (url.pathname.startsWith(path) && (path.endsWith('/') || url.pathname[path.length] === '/')));
    if (!domainMatches || !pathMatches) continue;
    if (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires)) fail('COOKIE_EXPIRY');
    if (cookie.expires !== -1 && cookie.expires * 1000 <= now) continue;
    if (typeof cookie.value !== 'string' || !cookieOctets.test(cookie.value)) fail('COOKIE_VALUE');
    if (selected.has(cookie.name)) fail('COOKIE_AMBIGUOUS');
    selected.set(cookie.name, cookie.value);
  }
  if (!['NID_AUT', 'NID_SES'].every(name => selected.has(name))) fail('AUTH_MISSING');
  return [...selected].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function requestAccount(service, headers, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail('INPUT');
  const operation = ACCOUNT_OPERATIONS[service];
  const url = operation.origin + operation.path;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET', headers: { accept: 'application/json', ...headers },
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { fail('TRANSPORT'); }
  let chunks = [];
  try {
    if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) fail('REDIRECT');
    if (response.status === 401) fail('REAUTH_REQUIRED');
    if (response.status === 403) fail('FORBIDDEN');
    if (response.status !== 200) fail('HTTP_STATUS');
    if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) fail('MIME');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) fail('SIZE');
    if (!response.body) fail('SCHEMA');
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) fail('SIZE');
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('JSON'); }
    if (!record(body)) fail('SCHEMA');
    return { body, receipt: {
      service, method: 'GET', ...operation, httpStatus: 200, responseBytes: bytes,
      checkedAt: new Date().toISOString(), browserUsed: false, executionMode: 'pure_http',
    } };
  } catch (error) {
    if (error instanceof PartnerProbeError) throw error;
    fail('TRANSPORT');
  } finally {
    chunks = [];
    await response.body?.cancel().catch(() => {});
  }
}

export async function probeMyrealtripAccount(input, dependencies) {
  if (!record(input)) fail('INPUT');
  const { token, expectedPartnerId, expectedEmail } = input;
  if (typeof token !== 'string' || !cookieOctets.test(token)) fail('AUTH_MISSING');
  if (!Number.isSafeInteger(expectedPartnerId) || expectedPartnerId <= 0) fail('INPUT');
  validateText(expectedEmail);
  if (!expectedEmail.includes('@')) fail('INPUT');
  const { body, receipt } = await requestAccount('myrealtrip', { 'partner-access-token': token }, dependencies);
  if (!record(body.result) || typeof body.result.status !== 'number') fail('SCHEMA');
  if (body.result.status === 401) fail('REAUTH_REQUIRED');
  if (body.result.status === 403) fail('FORBIDDEN');
  if (body.result.status !== 200) fail('SERVICE_STATUS');
  if (!record(body.data) || !Number.isSafeInteger(body.data.id) || typeof body.data.email !== 'string') fail('SCHEMA');
  if (body.data.id !== expectedPartnerId || body.data.email.toLowerCase() !== expectedEmail.toLowerCase()) fail('ACCOUNT_MISMATCH');
  return { ...receipt, applicationStatus: 200, authenticated: true, identityVerified: true,
    identityFields: ['id', 'email'], credentialPropagated: true, rawAccountReturned: false };
}

export async function probeBrandconnectAccount(input, dependencies = {}) {
  if (!record(input)) fail('INPUT');
  validateText(input.expectedLoginId, 100);
  const cookie = brandconnectCookieHeader(input.cookies, dependencies.now?.() ?? Date.now());
  const { body, receipt } = await requestAccount('brandconnect', { cookie }, dependencies);
  if (body.loginId === null || body.loginId === '') fail('REAUTH_REQUIRED');
  if (typeof body.loginId !== 'string' || !['partner', 'creator', 'groupAccount'].every(key => typeof body[key] === 'boolean')) fail('SCHEMA');
  if (body.loginId !== input.expectedLoginId) fail('ACCOUNT_MISMATCH');
  if (body.accountId !== null && typeof body.accountId !== 'string' && typeof body.accountId !== 'number') fail('SCHEMA');
  return { ...receipt, authenticated: true, identityVerified: true, identityFields: ['loginId'],
    credentialPropagated: true, rawAccountReturned: false,
    entitlement: { partner: body.partner, creator: body.creator, accountAssigned: body.accountId !== null } };
}

export async function probePartnerEnvelope(envelope, dependencies = {}) {
  if (!record(envelope) || envelope.schemaVersion !== 1 || !record(envelope.services)) fail('INPUT');
  if (Object.keys(envelope).some(key => !['schemaVersion', 'acquiredAt', 'services'].includes(key))) fail('INPUT');
  const names = Object.keys(envelope.services);
  if (!names.length || names.some(name => !Object.hasOwn(ACCOUNT_OPERATIONS, name))) fail('SCOPE');
  const acquiredAt = typeof envelope.acquiredAt === 'string' ? Date.parse(envelope.acquiredAt) : NaN;
  const age = (dependencies.now?.() ?? Date.now()) - acquiredAt;
  // Local freshness policy; this is not a claim about either site's token TTL.
  if (!Number.isFinite(age) || age < 0 || age > 5 * 60 * 1000) fail('HANDOFF_EXPIRED');
  const services = Object.fromEntries(await Promise.all(names.map(async name => {
    try {
      const probe = name === 'myrealtrip' ? probeMyrealtripAccount : probeBrandconnectAccount;
      return [name, { ok: true, ...await probe(envelope.services[name], dependencies) }];
    } catch (error) {
      return [name, { ok: false, code: error instanceof PartnerProbeError ? error.code : 'PROBE_FAILED',
        authenticated: false, identityVerified: false, credentialPropagated: false }];
    }
  })));
  return { schemaVersion: 1, checkedAt: new Date().toISOString(),
    ok: Object.values(services).every(result => result.ok), services,
    execution: { mode: 'pure_http', browserUsed: false, provider: 'memory_stdin', renewal: 'unverified' } };
}
