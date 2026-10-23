import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readCredential, writeCredential } from './secure-credential-store.mjs';
import { SOCIAL_REQUEST_TIMEOUTS } from '../../social-actions/lib/request-timeouts.mjs';

export const META_SERVICES = Object.freeze({
  instagram: { origin: 'https://www.instagram.com',
    requestOrigins: ['https://www.instagram.com', 'https://i.instagram.com'],
    responseOrigins: ['https://www.instagram.com', 'https://i.instagram.com'],
    domain: 'instagram.com', expectedOwner: 'lifehack__ailab', credential: 'instagram-auth-session' },
  threads: { origin: 'https://www.threads.com', requestOrigins: ['https://www.threads.com'],
    responseOrigins: ['https://www.threads.com'],
    domain: 'threads.com', expectedOwner: 'lifehack__ailab', credential: 'threads-auth-session' },
});
const cookieNames = new Set(['sessionid', 'csrftoken', 'ds_user_id', 'rur']);
const requiredCookies = ['sessionid', 'csrftoken', 'ds_user_id'];
const headerNames = new Set(['accept', 'referer', 'origin', 'user-agent', 'content-type', 'x-asbd-id', 'x-csrftoken',
  'x-ig-app-id', 'x-ig-www-claim', 'x-requested-with', 'x-web-session-id', 'x-fb-lsd', 'x-fb-friendly-name']);
const ownerContracts = Object.freeze({
  instagram: { method: 'GET', path: '/api/v1/accounts/edit/web_form_data/' },
  threads: { method: 'POST', path: '/graphql/query', operation: 'BarcelonaFeedTimelineViewerQuery', docId: '28683786577907583',
    // 2026-10-16 capture (box login): Threads rotated the viewer query doc and added the GhostPost provider flag.
    docIds: ['28683786577907583', '28756395033997468'] },
});
const fail = code => { throw Object.assign(new Error(code), { code }); };
const allowedCookieDomains = config => {
  const hosts = config.responseOrigins.map(origin => new URL(origin).hostname);
  return new Set([config.domain, '.' + config.domain, ...hosts, ...hosts.map(host => '.' + host)]);
};

export function normalizeMetaSession(service, input, { now = Date.now() } = {}) {
  const config = META_SERVICES[service];
  if (!config || input?.version !== 1 || input.service !== service || input.origin !== config.origin
    || typeof input.owner !== 'string' || !/^[A-Za-z0-9_.]{1,30}$/.test(input.owner)
    || input.owner.toLowerCase() !== config.expectedOwner || !Number.isFinite(input.capturedAt)
    || !Array.isArray(input.cookies) || input.cookies.length > 64) fail('META_SESSION_INVALID');
  const cookies = [];
  const seen = new Set();
  const cookieDomains = allowedCookieDomains(config);
  for (const cookie of input.cookies) {
    if (!cookieNames.has(cookie.name)) continue;
    if (!cookieDomains.has(cookie.domain)
      || cookie.path !== '/' || cookie.secure !== true || typeof cookie.value !== 'string'
      || !cookie.value || cookie.value.length > 8192 || /[\x00-\x20\x7f;]/.test(cookie.value)
      || !Number.isFinite(cookie.expires)) fail('META_COOKIE_SCOPE_INVALID');
    if (cookie.expires !== -1 && cookie.expires <= now / 1000) continue;
    if (seen.has(cookie.name)) fail('META_COOKIE_AMBIGUOUS');
    seen.add(cookie.name);
    cookies.push({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: '/', secure: true,
      httpOnly: cookie.httpOnly === true, expires: cookie.expires });
  }
  if (!requiredCookies.every(name => seen.has(name))) fail('META_REAUTH_REQUIRED');
  const request = input.ownerRequest;
  const contract = ownerContracts[service];
  if (!request || request.method !== contract.method || request.url !== config.origin + contract.path)
    fail('META_OWNER_CONTRACT_UNVERIFIED');
  if (service === 'instagram' && request.body != null) fail('META_OWNER_CONTRACT_UNVERIFIED');
  if (service === 'threads') {
    if (!/^\d{1,25}$/.test(input.ownerId || '') || input.ownerId !== cookies.find(c => c.name === 'ds_user_id').value
      || typeof request.body !== 'string' || request.body.length > 60000) fail('META_OWNER_CONTRACT_UNVERIFIED');
    const form = new URLSearchParams(request.body);
    if (new Set(form.keys()).size !== [...form.keys()].length
      || form.get('fb_api_req_friendly_name') !== contract.operation || !contract.docIds.includes(form.get('doc_id')))
      fail('META_OWNER_CONTRACT_UNVERIFIED');
    let variables;
    try { variables = JSON.parse(form.get('variables')); } catch { fail('META_OWNER_CONTRACT_UNVERIFIED'); }
    const allowed = new Set(['__relay_internal__pv__BarcelonaHasBestOfThreadsrelayprovider',
      '__relay_internal__pv__BarcelonaIsLoggedInrelayprovider',
      '__relay_internal__pv__BarcelonaHasPrivateRepliesDeprecationrelayprovider',
      '__relay_internal__pv__BarcelonaHasGhostPostProductionrelayprovider']);
    if (!variables || Object.keys(variables).length < allowed.size - 1
      || Object.entries(variables).some(([k,v]) => !allowed.has(k) || typeof v !== 'boolean')
      || variables.__relay_internal__pv__BarcelonaIsLoggedInrelayprovider !== true)
      fail('META_OWNER_CONTRACT_UNVERIFIED');
  }
  const headers = {};
  for (const [key, value] of Object.entries(request.headers || {})) {
    const name = key.toLowerCase();
    if (!headerNames.has(name)) continue;
    if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) fail('META_HEADER_INVALID');
    if (name === 'referer' && new URL(value).origin !== config.origin) fail('META_HEADER_SCOPE_INVALID');
    if (name === 'origin' && value !== config.origin) fail('META_HEADER_SCOPE_INVALID');
    headers[name] = value;
  }
  return { version: 1, service, origin: config.origin, owner: input.owner, capturedAt: input.capturedAt,
    ...(service === 'threads' ? { ownerId: input.ownerId } : {}),
    cookies, ownerRequest: { method: contract.method, url: request.url, headers,
      ...(service === 'threads' ? { body: request.body } : {}) },
    verifiedAt: typeof input.verifiedAt === 'string' ? input.verifiedAt : null };
}

export function storeMetaSession(service, input) {
  const bundle = normalizeMetaSession(service, input);
  return writeCredential(META_SERVICES[service].credential, JSON.stringify(bundle));
}

export function loadMetaSession(service) {
  const config = META_SERVICES[service];
  if (!config) fail('META_SERVICE_INVALID');
  const saved = readCredential(config.credential);
  if (!saved) fail('META_SESSION_MISSING');
  let input;
  try { input = JSON.parse(saved); } catch { fail('META_SESSION_INVALID'); }
  return normalizeMetaSession(service, input);
}

function cookieDomainMatchesHost(domain, hostname) {
  const normalizedDomain = domain.replace(/^\./, '').toLowerCase();
  const normalizedHost = hostname.toLowerCase();
  return normalizedHost === normalizedDomain || normalizedHost.endsWith('.' + normalizedDomain);
}

export function metaCookieHeader(bundle, targetUrl) {
  const config = META_SERVICES[bundle?.service];
  if (!config || bundle.origin !== config.origin || !Array.isArray(bundle.cookies)) fail('META_SESSION_INVALID');
  let target;
  try { target = new URL(targetUrl); } catch { fail('META_REQUEST_SCOPE_INVALID'); }
  if (!config.requestOrigins.includes(target.origin)) fail('META_REQUEST_SCOPE_INVALID');
  return bundle.cookies.filter(cookie => cookieDomainMatchesHost(cookie.domain, target.hostname))
    .map(cookie => cookie.name + '=' + cookie.value).join('; ');
}

export function rotateMetaCookies(bundle, response, now = Date.now()) {
  const config = META_SERVICES[bundle.service];
  let responseUrl;
  try { responseUrl = new URL(response.url); } catch { fail('META_RESPONSE_SCOPE_INVALID'); }
  if (!config || !config.responseOrigins.includes(responseUrl.origin)) fail('META_RESPONSE_SCOPE_INVALID');
  let changed = false;
  for (const line of (response.headers.getSetCookie?.() || []).slice(0, 50)) {
    if (line.length > 16384 || /[\r\n]/.test(line)) continue;
    const [pair, ...attributes] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1 || !cookieNames.has(pair.slice(0, eq).trim())) continue;
    const cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(),
      domain: responseUrl.hostname.toLowerCase(), path: '/', secure: false, httpOnly: false, expires: -1 };
    let domainAttribute = false;
    let maxAge;
    for (const attribute of attributes) {
      const sep = attribute.indexOf('=');
      const name = (sep < 0 ? attribute : attribute.slice(0, sep)).trim().toLowerCase();
      const value = sep < 0 ? '' : attribute.slice(sep + 1).trim();
      if (name === 'domain') { cookie.domain = '.' + value.toLowerCase().replace(/^\./, ''); domainAttribute = true; }
      if (name === 'path') cookie.path = value;
      if (name === 'secure') cookie.secure = true;
      if (name === 'httponly') cookie.httpOnly = true;
      if (name === 'expires' && Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value) / 1000;
      if (name === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
    }
    if (!allowedCookieDomains(config).has(cookie.domain) || cookie.path !== '/') continue;
    if (domainAttribute && !cookieDomainMatchesHost(cookie.domain, responseUrl.hostname)) continue;
    if (maxAge !== undefined) cookie.expires = maxAge <= 0 ? 0 : now / 1000 + maxAge;
    if (!cookie.value || cookie.expires !== -1 && cookie.expires <= now / 1000) {
      bundle.cookies = bundle.cookies.filter(c => c.name !== cookie.name);
      changed = true;
      continue;
    }
    if (!cookie.secure || /[\x00-\x20\x7f;]/.test(cookie.value)) continue;
    bundle.cookies = [...bundle.cookies.filter(c => c.name !== cookie.name), cookie];
    changed = true;
  }
  if (changed) {
    // Persist deletions too, so the next run cannot reuse a rejected bundle.
    writeCredential(config.credential, JSON.stringify(bundle));
    normalizeMetaSession(bundle.service, bundle, { now });
  }
}

export async function checkMetaSession(service, { fetchImpl = globalThis.fetch } = {}) {
  const bundle = loadMetaSession(service);
  const headers = { ...bundle.ownerRequest.headers,
    cookie: metaCookieHeader(bundle, bundle.ownerRequest.url),
    'x-csrftoken': bundle.cookies.find(c => c.name === 'csrftoken').value };
  const contract = ownerContracts[service];
  const response = await fetchImpl(bundle.ownerRequest.url, { method: contract.method, headers,
    ...(bundle.ownerRequest.body ? { body: bundle.ownerRequest.body } : {}), redirect: 'manual',
    signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.read) });
  rotateMetaCookies(bundle, response, Date.now());
  if ([401,419].includes(response.status)) fail('META_REAUTH_REQUIRED');
  if ([301,302,303,307,308].includes(response.status)) fail('META_OWNER_REDIRECT_AUTH_UNVERIFIED');
  if (response.status !== 200) fail('META_OWNER_HTTP_' + response.status);
  if (!/^(?:application\/json|text\/javascript)(?:;|$)/i.test(response.headers.get('content-type') || '')) fail('META_OWNER_MIME');
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1000000) fail('META_OWNER_RESPONSE_LIMIT');
    chunks.push(chunk);
  }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^for \(;;\);\s*/, '')); } catch { fail('META_OWNER_NOT_JSON'); }
  if (service === 'instagram') {
    if (payload.status !== 'ok' || payload.form_data?.username !== bundle.owner) fail('META_OWNER_MISMATCH');
  } else {
    const viewer = payload.data?.viewer?.user;
    if (payload.errors?.length || payload.error || viewer?.id !== bundle.ownerId
      || typeof viewer?.username === 'string' && viewer.username.toLowerCase() !== bundle.owner.toLowerCase()) {
      fail('META_OWNER_MISMATCH');
    }
  }
  bundle.verifiedAt = new Date().toISOString();
  storeMetaSession(service, bundle);
  return { service, authenticated: true, ownerVerified: true, owner: bundle.owner, provider: 'windows_dpapi_current_user',
    httpStatus: response.status, method: contract.method, path: contract.path,
    ...(contract.operation ? { operation: contract.operation } : {}), live_replay: true, executionMode: 'pure_http',
    browserUsed: false, passwordStored: false, plaintextPersisted: false, checkedAt: bundle.verifiedAt,
    sessionRenewalVerified: false };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  checkMetaSession(process.argv[2]).then(r => console.log(JSON.stringify(r))).catch(e => {
    console.log(JSON.stringify({ authenticated: false, code: /^[A-Z0-9_]+$/.test(e.code || '') ? e.code : 'META_SESSION_CHECK_FAILED' }));
    process.exitCode = 2;
  });
}
