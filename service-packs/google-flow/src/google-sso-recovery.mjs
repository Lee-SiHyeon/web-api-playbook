import { readCredential, writeCredential } from './secure-credential-store.mjs';
import { FlowHttpTransport } from './http-transport.mjs';
import { parseFlowDocument } from './document-diagnostics.mjs';
import { buildProjectMediaRequest, RPC } from './protocol.mjs';
import { validateFlowSessionBundle } from './session-bundle.mjs';
import { FLOW_CREDENTIAL } from './session-name.mjs';

const FLOW_ORIGIN = 'https://flow.google.com';
const ACCOUNTS_ORIGIN = 'https://accounts.google.com';
export const GOOGLE_FLOW_AUTH_CREDENTIAL = 'google-flow-google-auth-v1';
const PROJECT_ID = /^[a-f0-9-]{16,64}$/i;
const COOKIE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,100}$/;
const COOKIE_VALUE = /^(?:[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E])*$/;
const OWNER_EMAIL = /^[^\s@]{1,64}@[A-Za-z0-9.-]{1,189}\.[A-Za-z]{2,63}$/;
const MAX_COOKIES = 128;
const MAX_COOKIE_BYTES = 131_072;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const RECOVERY_DIAGNOSTIC_HOSTS = new Set(['accounts.google.com', 'flow.google.com', 'unknown']);
const RECOVERY_DIAGNOSTIC_PATHS = new Set(['project', 'servicelogin', 'set_osid', 'protected_project_rpc', 'unknown']);
const MAX_RECOVERY_HOPS = 8;
const BROKER_KEYS = new Set([
  'version', 'origin', 'serviceOrigin', 'projectId', 'owner', 'cookies', 'capturedAt',
  // Older protected records may retain this one-use value. It is deliberately ignored and
  // removed from the next protected write; every recovery starts from a fresh HTTP redirect.
  'observedServiceLoginUrl',
]);
const COOKIE_KEYS = new Set([
  'name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'expires', 'expirationDate',
  'session', 'sameSite', 'hostOnly',
]);
const SAME_SITE = new Set(['Lax', 'Strict', 'None', 'lax', 'strict', 'none',
  'no_restriction', 'unspecified', 'Unspecified']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeDiagnosticNames(value, max = MAX_COOKIES) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(name => typeof name === 'string' && COOKIE_NAME.test(name)))].slice(0, max);
}

function safeRecoveryDiagnostics(hops) {
  return {
    hops: hops.slice(0, MAX_RECOVERY_HOPS).map(hop => ({
      host: RECOVERY_DIAGNOSTIC_HOSTS.has(hop.host) ? hop.host : 'unknown',
      path: RECOVERY_DIAGNOSTIC_PATHS.has(hop.path) ? hop.path : 'unknown',
      status: Number.isInteger(hop.status) && (hop.status === 0 || (hop.status >= 100 && hop.status <= 599))
        ? hop.status : 0,
      requestCookieCount: Number.isInteger(hop.requestCookieCount) && hop.requestCookieCount >= 0
        && hop.requestCookieCount <= MAX_COOKIES ? hop.requestCookieCount : 0,
      requestCookieNames: safeDiagnosticNames(hop.requestCookieNames),
      responseCookieCount: Number.isInteger(hop.responseCookieCount) && hop.responseCookieCount >= 0
        && hop.responseCookieCount <= 64 ? hop.responseCookieCount : 0,
      responseCookieNames: safeDiagnosticNames(hop.responseCookieNames, 64),
    })),
  };
}

function exactObjectKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Formats only bounded recovery hop metadata; URLs, bodies, identities, and values are rejected. */
export function formatSafeFlowRecoveryDiagnostics(value) {
  if (!exactObjectKeys(value, ['hops']) || !Array.isArray(value.hops)
    || value.hops.length > MAX_RECOVERY_HOPS) return null;
  const formatted = [];
  const hopKeys = ['host', 'path', 'status', 'requestCookieCount', 'requestCookieNames',
    'responseCookieCount', 'responseCookieNames'];
  for (const hop of value.hops) {
    if (!exactObjectKeys(hop, hopKeys)
      || !RECOVERY_DIAGNOSTIC_HOSTS.has(hop.host) || hop.host === 'unknown'
      || !RECOVERY_DIAGNOSTIC_PATHS.has(hop.path) || hop.path === 'unknown'
      || !Number.isInteger(hop.status) || !(hop.status === 0 || (hop.status >= 100 && hop.status <= 599))
      || !Number.isInteger(hop.requestCookieCount) || hop.requestCookieCount < 0 || hop.requestCookieCount > MAX_COOKIES
      || !Number.isInteger(hop.responseCookieCount) || hop.responseCookieCount < 0 || hop.responseCookieCount > 64
      || !Array.isArray(hop.requestCookieNames) || hop.requestCookieNames.length > MAX_COOKIES
      || !Array.isArray(hop.responseCookieNames) || hop.responseCookieNames.length > 64
      || hop.requestCookieNames.some(name => typeof name !== 'string' || !COOKIE_NAME.test(name))
      || hop.responseCookieNames.some(name => typeof name !== 'string' || !COOKIE_NAME.test(name))) return null;
    const requestNames = hop.requestCookieNames.join(',') || 'none';
    const responseNames = hop.responseCookieNames.join(',') || 'none';
    formatted.push(`${hop.host}/${hop.path}:status=${hop.status},requestCookieCount=${hop.requestCookieCount},requestCookieNames=${requestNames},responseCookieCount=${hop.responseCookieCount},responseCookieNames=${responseNames}`);
  }
  return `recoveryHops=${formatted.length ? formatted.join(';') : 'none'}`;
}

function exactString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && !/[\r\n\0]/.test(value);
}

function domainValue(cookie) {
  return cookie.domain.toLowerCase().replace(/^\./, '');
}

function pathMatches(cookiePath, requestPath) {
  return requestPath === cookiePath
    || (requestPath.startsWith(cookiePath)
      && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'));
}

function cookieScopeKey(cookie) {
  return `${cookie.name}\0${domainValue(cookie)}\0${cookie.hostOnly}\0${cookie.path}`;
}

function normalizedCookie(input, { responseHost, now, source = 'broker' } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !COOKIE_KEYS.has(key))) throw fail('FLOW_SSO_RECOVERY_COOKIE_INVALID');
  if (!exactString(input.name, 101) || !COOKIE_NAME.test(input.name)
    || typeof input.value !== 'string' || input.value.length > 16_384
    || (source === 'broker' && input.value.length === 0)
    || !COOKIE_VALUE.test(input.value)
    || !exactString(input.domain, 255) || input.domain !== input.domain.trim()
    || !exactString(input.path, 2_048) || !input.path.startsWith('/') || /[;\r\n\0]/.test(input.path)
    || typeof input.secure !== 'boolean' || typeof input.httpOnly !== 'boolean'
    || typeof input.hostOnly !== 'boolean' || typeof input.session !== 'boolean') {
    throw fail('FLOW_SSO_RECOVERY_COOKIE_INVALID');
  }
  const rawDomain = input.domain.toLowerCase();
  const domain = domainValue(input);
  if ((rawDomain.startsWith('.') && input.hostOnly)
    || !['google.com', 'accounts.google.com', 'flow.google.com'].includes(domain)) {
    throw fail('FLOW_SSO_RECOVERY_COOKIE_SCOPE');
  }
  if (source === 'broker' && domain === 'flow.google.com') throw fail('FLOW_SSO_RECOVERY_BROKER_SCOPE');
  if (responseHost) {
    const host = responseHost.toLowerCase();
    if (input.hostOnly ? host !== domain : host !== domain && !host.endsWith(`.${domain}`)) {
      throw fail('FLOW_SSO_RECOVERY_COOKIE_SCOPE');
    }
  }
  if (input.hostOnly && domain !== 'accounts.google.com' && domain !== 'google.com' && domain !== 'flow.google.com') {
    throw fail('FLOW_SSO_RECOVERY_COOKIE_SCOPE');
  }
  if (input.name.startsWith('__Secure-') && !input.secure) throw fail('FLOW_SSO_RECOVERY_COOKIE_INVALID');
  if (input.name.startsWith('__Host-') && (!input.secure || !input.hostOnly || input.path !== '/')) {
    throw fail('FLOW_SSO_RECOVERY_COOKIE_INVALID');
  }

  if (Object.hasOwn(input, 'sameSite') && !SAME_SITE.has(input.sameSite)) {
    throw fail('FLOW_SSO_RECOVERY_COOKIE_INVALID');
  }
  const rawExpires = input.expires ?? input.expirationDate;
  if (Object.hasOwn(input, 'expires') && input.expires !== null
    && (typeof input.expires !== 'number' || !Number.isFinite(input.expires))) {
    throw fail('FLOW_SSO_RECOVERY_COOKIE_INVALID');
  }
  if (Object.hasOwn(input, 'expirationDate') && input.expirationDate !== null
    && (typeof input.expirationDate !== 'number' || !Number.isFinite(input.expirationDate))) {
    throw fail('FLOW_SSO_RECOVERY_COOKIE_INVALID');
  }
  if (input.expires !== undefined && input.expires !== null
    && input.expirationDate !== undefined && input.expirationDate !== null
    && input.expires !== input.expirationDate) throw fail('FLOW_SSO_RECOVERY_COOKIE_INVALID');
  const sessionSentinel = rawExpires === -1;
  const isSession = sessionSentinel || rawExpires === undefined || rawExpires === null;
  if ((isSession && input.session !== true)
    || (!isSession && (rawExpires < 0 || input.session === true))) {
    throw fail('FLOW_SSO_RECOVERY_COOKIE_INVALID');
  }

  const cookie = {
    name: input.name,
    value: input.value,
    domain: input.domain,
    hostOnly: input.hostOnly,
    path: input.path,
    secure: input.secure,
    httpOnly: input.httpOnly,
    session: isSession,
  };
  if (!isSession) cookie.expires = rawExpires;
  if (Object.hasOwn(input, 'sameSite')) cookie.sameSite = input.sameSite;
  return { cookie, expired: !isSession && rawExpires <= now / 1000 };
}

/** Validates a scoped Google-to-Flow session broker without using its saved redirect URL. */
export function validateGoogleFlowAuthBundle(bundle, { now = Date.now() } = {}) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
    || Object.keys(bundle).some(key => !BROKER_KEYS.has(key))
    || bundle.version !== 1 || bundle.origin !== ACCOUNTS_ORIGIN || bundle.serviceOrigin !== FLOW_ORIGIN
    || typeof bundle.projectId !== 'string' || !PROJECT_ID.test(bundle.projectId)
    || typeof bundle.owner !== 'string' || !OWNER_EMAIL.test(bundle.owner)
    || typeof bundle.capturedAt !== 'string' || !Number.isFinite(Date.parse(bundle.capturedAt))
    || !Array.isArray(bundle.cookies) || bundle.cookies.length < 1 || bundle.cookies.length > MAX_COOKIES
    || !Number.isFinite(now)) throw fail('FLOW_SSO_RECOVERY_BROKER_INVALID');
  if (Object.hasOwn(bundle, 'observedServiceLoginUrl')
    && (typeof bundle.observedServiceLoginUrl !== 'string' || bundle.observedServiceLoginUrl.length > 8_192)) {
    throw fail('FLOW_SSO_RECOVERY_BROKER_INVALID');
  }

  const seen = new Set();
  let bytes = 0;
  const cookies = bundle.cookies.map(input => {
    const parsed = normalizedCookie(input, { now, source: 'broker' });
    const cookie = parsed.cookie;
    if (seen.has(cookieScopeKey(cookie))) throw fail('FLOW_SSO_RECOVERY_COOKIE_DUPLICATE');
    seen.add(cookieScopeKey(cookie));
    bytes += Buffer.byteLength(`${cookie.name}=${cookie.value}; `, 'utf8');
    if (bytes > MAX_COOKIE_BYTES) throw fail('FLOW_SSO_RECOVERY_COOKIE_INVALID');
    return cookie;
  });
  return {
    version: 1,
    origin: ACCOUNTS_ORIGIN,
    serviceOrigin: FLOW_ORIGIN,
    projectId: bundle.projectId.toLowerCase(),
    owner: bundle.owner,
    cookies,
    capturedAt: bundle.capturedAt,
  };
}

function activeCookie(cookie, url, now) {
  const domain = domainValue(cookie);
  const host = url.hostname.toLowerCase();
  if (cookie.hostOnly ? host !== domain : host !== domain && !host.endsWith(`.${domain}`)) return false;
  if (!pathMatches(cookie.path, url.pathname)) return false;
  if (cookie.secure && url.protocol !== 'https:') return false;
  const expires = cookie.expires ?? cookie.expirationDate;
  if (expires === undefined || expires === null || expires === -1) return cookie.session === true;
  return Number.isFinite(Number(expires)) && Number(expires) > now / 1000;
}

function cookieUnexpired(cookie, now) {
  const expires = cookie.expires ?? cookie.expirationDate;
  return expires === undefined || expires === null || expires === -1
    ? cookie.session === true
    : Number.isFinite(Number(expires)) && Number(expires) > now / 1000;
}

function cookieHeader(cookies, url, now) {
  const selected = cookies.filter(cookie => activeCookie(cookie, url, now));
  if (!selected.length) throw fail('FLOW_SSO_RECOVERY_COOKIE_UNAVAILABLE');
  return {
    header: selected.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
    names: selected.map(cookie => cookie.name),
    count: selected.length,
  };
}

function defaultCookiePath(pathname) {
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function parseSetCookie(line, responseUrl, now) {
  if (typeof line !== 'string' || line.length > 16_384 || /[\r\n\0]/.test(line)) {
    throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');
  }
  const [pair, ...parts] = line.split(';');
  const equal = pair.indexOf('=');
  if (equal < 1) throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');
  const name = pair.slice(0, equal).trim();
  const value = pair.slice(equal + 1).trim();
  if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');
  const attributes = Object.create(null);
  for (const part of parts) {
    const attribute = part.trim();
    if (!attribute) continue;
    const index = attribute.indexOf('=');
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const attributeValue = index < 0 ? '' : attribute.slice(index + 1).trim();
    if (!/^[a-z][a-z0-9-]{0,49}$/.test(key) || Object.hasOwn(attributes, key)) {
      throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');
    }
    attributes[key] = attributeValue;
  }
  if (Object.hasOwn(attributes, 'partitioned')) throw fail('FLOW_SSO_RECOVERY_COOKIE_SCOPE');
  for (const flag of ['secure', 'httponly']) {
    if (Object.hasOwn(attributes, flag) && attributes[flag] !== '') throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');
  }
  let domain = responseUrl.hostname.toLowerCase();
  const hasDomain = Object.hasOwn(attributes, 'domain');
  if (hasDomain) {
    const rawDomain = attributes.domain.toLowerCase();
    if (rawDomain.startsWith('..')) throw fail('FLOW_SSO_RECOVERY_COOKIE_SCOPE');
    domain = rawDomain.replace(/^\./, '');
    if (!['google.com', 'accounts.google.com', 'flow.google.com'].includes(domain)) {
      throw fail('FLOW_SSO_RECOVERY_COOKIE_SCOPE');
    }
    const host = responseUrl.hostname.toLowerCase();
    if (host !== domain && !host.endsWith(`.${domain}`)) throw fail('FLOW_SSO_RECOVERY_COOKIE_SCOPE');
  }
  let path = defaultCookiePath(responseUrl.pathname);
  if (Object.hasOwn(attributes, 'path')) {
    path = attributes.path;
    if (!path.startsWith('/') || /[\r\n\0;]/.test(path)) throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');
  }
  let sameSite;
  if (Object.hasOwn(attributes, 'samesite')) {
    const valueLower = attributes.samesite.toLowerCase();
    if (valueLower === 'lax') sameSite = 'Lax';
    else if (valueLower === 'strict') sameSite = 'Strict';
    else if (valueLower === 'none') sameSite = 'None';
    else throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');
  }
  const secure = Object.hasOwn(attributes, 'secure');
  const httpOnly = Object.hasOwn(attributes, 'httponly');
  if ((name.startsWith('__Secure-') || name.startsWith('__Host-')) && !secure) {
    throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');
  }
  if (name.startsWith('__Host-') && (hasDomain || path !== '/')) {
    throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');
  }
  if (sameSite === 'None' && !secure) throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');

  let expires;
  let session = true;
  let deleted = false;
  if (Object.hasOwn(attributes, 'max-age')) {
    if (!/^-?\d+$/.test(attributes['max-age'])) throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');
    const maxAge = Number(attributes['max-age']);
    if (!Number.isSafeInteger(maxAge)) throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');
    if (maxAge <= 0) deleted = true;
    else {
      expires = now / 1000 + maxAge;
      session = false;
    }
  } else if (Object.hasOwn(attributes, 'expires')) {
    const expiresAt = Date.parse(attributes.expires);
    if (!Number.isFinite(expiresAt)) throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');
    expires = expiresAt / 1000;
    session = false;
    deleted = expiresAt <= now;
  }
  const cookie = {
    name, value, domain, hostOnly: !hasDomain, path, secure, httpOnly, session,
    ...(expires === undefined ? {} : { expires }),
    ...(sameSite === undefined ? {} : { sameSite }),
  };
  normalizedCookie(cookie, { responseHost: responseUrl.hostname, now, source: 'response' });
  return { cookie, deleted };
}

function getSetCookieLines(response) {
  if (typeof response?.headers?.getSetCookie !== 'function') return [];
  let lines;
  try { lines = response.headers.getSetCookie(); } catch { throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID'); }
  if (!Array.isArray(lines) || lines.length > 64) throw fail('FLOW_SSO_RECOVERY_COOKIE_HEADER_INVALID');
  return lines;
}

function applyResponseCookies(cookies, response, requestUrl, now, { allowFlow = true } = {}) {
  const responseUrl = new URL(response.url);
  if (responseUrl.href !== requestUrl.href) throw fail('FLOW_SSO_RECOVERY_RESPONSE_SCOPE');
  const lines = getSetCookieLines(response);
  const updates = lines.map(line => parseSetCookie(line, responseUrl, now));
  const seen = new Set();
  for (const update of updates) {
    const key = cookieScopeKey(update.cookie);
    if (seen.has(key)) throw fail('FLOW_SSO_RECOVERY_COOKIE_DUPLICATE');
    seen.add(key);
    if (!allowFlow && domainValue(update.cookie) === 'flow.google.com') {
      throw fail('FLOW_SSO_RECOVERY_COOKIE_SCOPE');
    }
  }
  const next = cookies.map(cookie => ({ ...cookie }));
  for (const update of updates) {
    const key = cookieScopeKey(update.cookie);
    const index = next.findIndex(cookie => cookieScopeKey(cookie) === key);
    if (update.deleted) {
      if (index >= 0) next.splice(index, 1);
    } else if (index >= 0) next[index] = update.cookie;
    else next.push(update.cookie);
  }
  if (next.length > MAX_COOKIES) throw fail('FLOW_SSO_RECOVERY_COOKIE_INVALID');
  const totalBytes = next.reduce((sum, cookie) => sum + Buffer.byteLength(`${cookie.name}=${cookie.value}; `, 'utf8'), 0);
  if (totalBytes > MAX_COOKIE_BYTES) throw fail('FLOW_SSO_RECOVERY_COOKIE_INVALID');
  return { cookies: next, names: [...new Set(updates.map(update => update.cookie.name))], count: updates.length, updates };
}

function exactQuery(url, expectedKeys) {
  const entries = [...url.searchParams.entries()];
  return entries.length === expectedKeys.length
    && entries.every(([key]) => expectedKeys.includes(key))
    && expectedKeys.every(key => url.searchParams.getAll(key).length === 1);
}

function safeUrl(value, base) {
  if (typeof value !== 'string' || !value || value.length > 16_384 || /[\r\n\0]/.test(value)) {
    throw fail('FLOW_SSO_RECOVERY_REDIRECT_INVALID');
  }
  let target;
  try { target = new URL(value, base); } catch { throw fail('FLOW_SSO_RECOVERY_REDIRECT_INVALID'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) {
    throw fail('FLOW_SSO_RECOVERY_REDIRECT_INVALID');
  }
  return target;
}

function expectedProjectUrl(value, projectId, { pli = false } = {}) {
  const url = safeUrl(value);
  if (url.origin !== FLOW_ORIGIN || url.pathname !== `/project/${projectId}`) {
    throw fail('FLOW_SSO_RECOVERY_REDIRECT_UNEXPECTED');
  }
  if (pli) {
    if (!exactQuery(url, ['pli']) || url.searchParams.get('pli') !== '1') {
      throw fail('FLOW_SSO_RECOVERY_REDIRECT_UNEXPECTED');
    }
  } else if (url.search) throw fail('FLOW_SSO_RECOVERY_REDIRECT_UNEXPECTED');
  return url;
}

function serviceLoginUrl(location, responseUrl, projectId) {
  const url = safeUrl(location, responseUrl);
  if (url.origin === ACCOUNTS_ORIGIN && /\/(?:signin|challenge|captcha|identifier)(?:\/|$)/i.test(url.pathname)) {
    throw fail('FLOW_SSO_RECOVERY_LOGIN_REQUIRED');
  }
  if (url.origin !== ACCOUNTS_ORIGIN || url.pathname !== '/ServiceLogin'
    || !exactQuery(url, ['passive', 'osid', 'continue', 'followup', 'authuser'])
    || url.searchParams.get('passive') !== '1209600'
    || url.searchParams.get('osid') !== '1'
    || url.searchParams.get('authuser') !== '0') {
    throw fail('FLOW_SSO_RECOVERY_REDIRECT_UNEXPECTED');
  }
  expectedProjectUrl(url.searchParams.get('continue'), projectId);
  expectedProjectUrl(url.searchParams.get('followup'), projectId);
  return url;
}

function setOsidUrl(location, responseUrl, projectId) {
  const url = safeUrl(location, responseUrl);
  if (url.origin !== FLOW_ORIGIN || url.pathname !== '/accounts/SetOSID'
    || !exactQuery(url, ['authuser', 'continue', 'osidt'])
    || url.searchParams.get('authuser') !== '0'
    || !exactString(url.searchParams.get('osidt'), 4_096)) {
    if (url.origin === ACCOUNTS_ORIGIN && /\/(?:signin|challenge|captcha|identifier)(?:\/|$)/i.test(url.pathname)) {
      throw fail('FLOW_SSO_RECOVERY_LOGIN_REQUIRED');
    }
    throw fail('FLOW_SSO_RECOVERY_REDIRECT_UNEXPECTED');
  }
  expectedProjectUrl(url.searchParams.get('continue'), projectId, { pli: true });
  return url;
}

function finalProjectUrl(location, responseUrl, projectId) {
  const url = safeUrl(location, responseUrl);
  if (url.origin !== FLOW_ORIGIN) {
    if (url.origin === ACCOUNTS_ORIGIN && /\/(?:signin|challenge|captcha|identifier)(?:\/|$)/i.test(url.pathname)) {
      throw fail('FLOW_SSO_RECOVERY_LOGIN_REQUIRED');
    }
    throw fail('FLOW_SSO_RECOVERY_REDIRECT_UNEXPECTED');
  }
  return expectedProjectUrl(url.href, projectId, { pli: true });
}

function assertResponseUrl(response, requestUrl) {
  if (typeof response?.url !== 'string') throw fail('FLOW_SSO_RECOVERY_RESPONSE_SCOPE');
  let actual;
  try { actual = new URL(response.url); } catch { throw fail('FLOW_SSO_RECOVERY_RESPONSE_SCOPE'); }
  if (actual.href !== requestUrl.href) throw fail('FLOW_SSO_RECOVERY_RESPONSE_SCOPE');
}

function pathKind(url) {
  if (url.origin === ACCOUNTS_ORIGIN && url.pathname === '/ServiceLogin') return 'servicelogin';
  if (url.origin === FLOW_ORIGIN && /^\/project\/[a-f0-9-]{16,64}$/i.test(url.pathname)) return 'project';
  if (url.origin === FLOW_ORIGIN && url.pathname === '/accounts/SetOSID') return 'set_osid';
  return 'rpc';
}

function parseOwner(html) {
  const pattern = /"oPEP7c"\s*:\s*("(?:\\.|[^"\\])*")/g;
  const matches = [...html.matchAll(pattern)];
  if (matches.length !== 1) throw fail('FLOW_SSO_RECOVERY_OWNER_FIELD_INVALID');
  let owner;
  try { owner = JSON.parse(matches[0][1]); } catch { throw fail('FLOW_SSO_RECOVERY_OWNER_FIELD_INVALID'); }
  if (typeof owner !== 'string' || !OWNER_EMAIL.test(owner)) throw fail('FLOW_SSO_RECOVERY_OWNER_FIELD_INVALID');
  return owner;
}

async function boundedText(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) throw fail('FLOW_SSO_RECOVERY_DOCUMENT_TOO_LARGE');
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    let bytes = 0;
    const chunks = [];
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_HTML_BYTES) throw fail('FLOW_SSO_RECOVERY_DOCUMENT_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      if (error?.code === 'FLOW_SSO_RECOVERY_DOCUMENT_TOO_LARGE') throw error;
      throw fail('FLOW_SSO_RECOVERY_DOCUMENT_INVALID');
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  let text;
  try { text = await response.text(); } catch { throw fail('FLOW_SSO_RECOVERY_DOCUMENT_INVALID'); }
  if (Buffer.byteLength(text, 'utf8') > MAX_HTML_BYTES) throw fail('FLOW_SSO_RECOVERY_DOCUMENT_TOO_LARGE');
  return text;
}

function readProtected(readCredentialImpl, name) {
  try { return readCredentialImpl(name) || null; } catch (error) {
    if (error?.code === 'CREDENTIAL_STORE_TIMEOUT') {
      throw fail('FLOW_SSO_RECOVERY_CREDENTIAL_STORE_READ_TIMEOUT');
    }
    throw fail('FLOW_SSO_RECOVERY_CREDENTIAL_STORE_READ_FAILED');
  }
}

function validateExistingFlow(raw, projectId) {
  if (raw === null) return;
  let existing;
  try { existing = JSON.parse(raw); } catch { throw fail('FLOW_SSO_RECOVERY_FLOW_STORE_INVALID'); }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)
    || existing.version !== 1 || existing.origin !== FLOW_ORIGIN
    || typeof existing.projectId !== 'string' || !PROJECT_ID.test(existing.projectId)) {
    throw fail('FLOW_SSO_RECOVERY_FLOW_STORE_INVALID');
  }
  if (existing.projectId.toLowerCase() !== projectId.toLowerCase()) {
    throw fail('FLOW_SSO_RECOVERY_PROJECT_CONFLICT');
  }
}

function issuedOsidCookies(update) {
  const names = new Set(update.updates.filter(value => !value.deleted
    && domainValue(value.cookie) === 'flow.google.com' && value.cookie.hostOnly
    && value.cookie.path === '/' && value.cookie.secure && value.cookie.httpOnly)
    .map(value => value.cookie.name));
  return names.has('OSID') && names.has('__Secure-OSID');
}

function validateOsidCookies(cookies, now) {
  for (const name of ['OSID', '__Secure-OSID']) {
    const matches = cookies.filter(cookie => cookie.name === name
      && domainValue(cookie) === 'flow.google.com' && cookie.hostOnly && cookie.path === '/'
      && cookie.secure && cookie.httpOnly);
    if (matches.length !== 1 || !activeCookie(matches[0], new URL(`${FLOW_ORIGIN}/project/`), now)) {
      throw fail('FLOW_SSO_RECOVERY_FLOW_COOKIES_INVALID');
    }
  }
}

function accountCookies(cookies) {
  return cookies.filter(cookie => {
    const domain = domainValue(cookie);
    return domain === 'google.com' || domain === 'accounts.google.com';
  });
}

function mergeFlowRotationsIntoJar(jar, before, after) {
  const beforeShared = before.cookies.filter(cookie => domainValue(cookie) === 'google.com' && !cookie.hostOnly);
  const afterShared = after.cookies.filter(cookie => domainValue(cookie) === 'google.com' && !cookie.hostOnly);
  const afterKeys = new Set(afterShared.map(cookieScopeKey));
  for (const cookie of beforeShared) {
    if (afterKeys.has(cookieScopeKey(cookie))) continue;
    const index = jar.findIndex(value => cookieScopeKey(value) === cookieScopeKey(cookie));
    if (index >= 0) jar.splice(index, 1);
  }
  for (const cookie of afterShared) {
    const key = cookieScopeKey(cookie);
    const index = jar.findIndex(value => cookieScopeKey(value) === key);
    if (index >= 0) jar[index] = { ...cookie };
    else jar.push({ ...cookie });
  }
}

function namesFromRequestHeader(value) {
  if (typeof value !== 'string' || !value) return [];
  return [...new Set(value.split(/;\s*/).map(entry => {
    const equal = entry.indexOf('=');
    const name = equal < 1 ? '' : entry.slice(0, equal).trim();
    return COOKIE_NAME.test(name) ? name : null;
  }).filter(Boolean))];
}

function safeResponseCookieNames(response) {
  let lines = [];
  try {
    if (typeof response?.headers?.getSetCookie === 'function') {
      const value = response.headers.getSetCookie();
      if (Array.isArray(value)) lines = value;
    }
  } catch { return []; }
  return [...new Set(lines.map(line => {
    if (typeof line !== 'string') return null;
    const equal = line.indexOf('=');
    const name = equal < 1 ? '' : line.slice(0, equal).trim();
    return COOKIE_NAME.test(name) ? name : null;
  }).filter(Boolean))];
}

function storeCredential(writeCredentialImpl, name, value) {
  let result;
  try { result = writeCredentialImpl(name, JSON.stringify(value)); } catch (error) {
    if (error?.code === 'CREDENTIAL_STORE_TIMEOUT') {
      throw fail('FLOW_SSO_RECOVERY_CREDENTIAL_STORE_WRITE_TIMEOUT');
    }
    throw fail('FLOW_SSO_RECOVERY_CREDENTIAL_STORE_WRITE_FAILED');
  }
  if (!result || result.stored !== true || result.plaintextPersisted !== false) {
    throw fail('FLOW_SSO_RECOVERY_CREDENTIAL_STORE_UNVERIFIED');
  }
}

/**
 * Rebuilds only the Flow session from a valid protected Google session. It starts from a
 * fresh Flow redirect, follows the observed Google ServiceLogin/SetOSID GET sequence,
 * verifies the active owner and protected project RPC, then commits the protected records.
 */
export async function recoverFlowGoogleSession(options = {}) {
  const hops = [];
  try {
    return await recoverFlowGoogleSessionInternal({ ...options, diagnosticHops: hops });
  } catch (error) {
    const diagnostics = safeRecoveryDiagnostics(hops);
    if (error && typeof error === 'object') {
      try {
        Object.defineProperty(error, 'recoveryDiagnostics', {
          value: diagnostics, enumerable: true, configurable: true,
        });
      } catch {
        const safeError = fail(typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
          ? error.code : 'FLOW_SSO_RECOVERY_FAILED');
        safeError.recoveryDiagnostics = diagnostics;
        throw safeError;
      }
      throw error;
    }
    const safeError = fail('FLOW_SSO_RECOVERY_FAILED');
    safeError.recoveryDiagnostics = diagnostics;
    throw safeError;
  }
}

async function recoverFlowGoogleSessionInternal({
  fetchImpl = globalThis.fetch,
  readCredentialImpl = readCredential,
  writeCredentialImpl = writeCredential,
  clock = Date.now,
  diagnosticHops,
} = {}) {
  const hops = diagnosticHops;
  if (typeof fetchImpl !== 'function' || typeof readCredentialImpl !== 'function'
    || typeof writeCredentialImpl !== 'function' || typeof clock !== 'function') {
    throw new TypeError('Flow session recovery dependencies are invalid.');
  }
  const startedAt = clock();
  if (!Number.isFinite(startedAt)) throw new TypeError('Flow session recovery clock is invalid.');

  const brokerRaw = readProtected(readCredentialImpl, GOOGLE_FLOW_AUTH_CREDENTIAL);
  if (!brokerRaw) throw fail('FLOW_SSO_RECOVERY_GOOGLE_AUTH_MISSING');
  let decodedBroker;
  try { decodedBroker = JSON.parse(brokerRaw); } catch { throw fail('FLOW_SSO_RECOVERY_BROKER_INVALID'); }
  const broker = validateGoogleFlowAuthBundle(decodedBroker, { now: startedAt });
  const projectId = broker.projectId;
  const flowRaw = readProtected(readCredentialImpl, FLOW_CREDENTIAL);
  validateExistingFlow(flowRaw, projectId);

  // The saved ServiceLogin URL is intentionally not read. This request asks Google for a
  // fresh redirect contract using only active cookies scoped to Flow.
  let jar = broker.cookies.map(cookie => ({ ...cookie }));
  async function get(url, pathLabel = pathKind(url)) {
    const sent = cookieHeader(jar, url, clock());
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { cookie: sent.header, accept: 'text/html' },
      });
    } catch {
      hops.push({
        host: url.hostname,
        path: pathLabel,
        status: 0,
        requestCookieNames: sent.names,
        requestCookieCount: sent.count,
        responseCookieNames: [],
        responseCookieCount: 0,
      });
      throw fail('FLOW_SSO_RECOVERY_TRANSPORT');
    }
    const observedResponseNames = safeResponseCookieNames(response);
    const hop = {
      host: url.hostname,
      path: pathLabel,
      status: Number.isInteger(response.status) ? response.status : 0,
      requestCookieNames: sent.names,
      requestCookieCount: sent.count,
      responseCookieNames: observedResponseNames,
      responseCookieCount: observedResponseNames.length,
    };
    hops.push(hop);
    assertResponseUrl(response, url);
    const applied = applyResponseCookies(jar, response, url, clock());
    jar = applied.cookies;
    hop.responseCookieNames = applied.names;
    hop.responseCookieCount = applied.count;
    return { response, applied };
  }
  async function discard(response) {
    try { await response?.body?.cancel(); } catch { /* response is intentionally discarded */ }
  }
  function require302(response) {
    if (response.status !== 302) {
      if (response.status === 401 || response.status === 403) throw fail('FLOW_SSO_RECOVERY_LOGIN_REQUIRED');
      if (response.status === 200) throw fail('FLOW_SSO_RECOVERY_LOGIN_OR_CHALLENGE');
      throw fail('FLOW_SSO_RECOVERY_HTTP_STATUS');
    }
    const location = response.headers?.get?.('location');
    if (!location) throw fail('FLOW_SSO_RECOVERY_REDIRECT_INVALID');
    return location;
  }

  const initialProject = new URL(`/project/${projectId}`, FLOW_ORIGIN);
  const first = await get(initialProject, 'project');
  let loginUrl;
  try { loginUrl = serviceLoginUrl(require302(first.response), initialProject, projectId); }
  finally { await discard(first.response); }

  const login = await get(loginUrl, 'servicelogin');
  let setOsid;
  try { setOsid = setOsidUrl(require302(login.response), loginUrl, projectId); }
  finally { await discard(login.response); }

  const osid = await get(setOsid, 'set_osid');
  let finalProject;
  try {
    finalProject = finalProjectUrl(require302(osid.response), setOsid, projectId);
    if (!issuedOsidCookies(osid.applied)) throw fail('FLOW_SSO_RECOVERY_FLOW_COOKIES_INVALID');
  } finally { await discard(osid.response); }

  const finalPage = await get(finalProject, 'project');
  const finalResponse = finalPage.response;
  if (finalResponse.status !== 200) {
    await discard(finalResponse);
    if (finalResponse.status === 401 || finalResponse.status === 403) throw fail('FLOW_SSO_RECOVERY_LOGIN_REQUIRED');
    if (finalResponse.status >= 300 && finalResponse.status < 400) {
      const location = finalResponse.headers?.get?.('location');
      if (typeof location === 'string' && /accounts\.google\.com\/(?:ServiceLogin|signin|challenge|captcha|identifier)/i.test(location)) {
        throw fail('FLOW_SSO_RECOVERY_LOGIN_OR_CHALLENGE');
      }
      throw fail('FLOW_SSO_RECOVERY_REDIRECT_UNEXPECTED');
    }
    throw fail('FLOW_SSO_RECOVERY_HTTP_STATUS');
  }
  const mime = finalResponse.headers?.get?.('content-type') || '';
  if (!/^text\/html(?:\s*;|$)/i.test(mime)) {
    await discard(finalResponse);
    throw fail('FLOW_SSO_RECOVERY_DOCUMENT_MIME');
  }
  const html = await boundedText(finalResponse);
  const activeOwner = parseOwner(html);
  if (activeOwner.trim().toLowerCase() !== broker.owner.trim().toLowerCase()) {
    throw fail('FLOW_SSO_RECOVERY_OWNER_MISMATCH');
  }
  const sourcePath = `${finalProject.pathname}${finalProject.search}`;
  let document;
  try {
    document = parseFlowDocument(html, {
      sourcePath,
      responseUrl: finalProject.href,
      httpStatus: finalResponse.status,
      mime,
    });
  } catch { throw fail('FLOW_SSO_RECOVERY_DOCUMENT_INVALID'); }
  validateOsidCookies(jar, clock());

  const flowCookies = jar.filter(cookie => {
    if (!cookieUnexpired(cookie, clock())) return false;
    const domain = domainValue(cookie);
    return (domain === 'google.com' && !cookie.hostOnly)
      || (domain === 'flow.google.com' && cookie.hostOnly);
  });
  let validatedFlow;
  try {
    validatedFlow = validateFlowSessionBundle({
      version: 1,
      origin: FLOW_ORIGIN,
      projectId,
      capturedAt: new Date(clock()).toISOString(),
      cookies: flowCookies,
    }, { now: clock() });
  } catch { throw fail('FLOW_SSO_RECOVERY_FLOW_BUNDLE_INVALID'); }

  // Reuse the maintained read transport with an isolated no-op credential writer. The
  // document and cookies stay in memory until the protected project RPC proves the session.
  let rpcHop = null;
  const transport = new FlowHttpTransport({
    fetchImpl: async (urlValue, init) => {
      const url = new URL(urlValue);
      const response = await fetchImpl(url, init);
      if (typeof response?.url !== 'string' || response.url !== url.href) {
        throw fail('FLOW_SSO_RECOVERY_RESPONSE_SCOPE');
      }
      const requestCookieNames = namesFromRequestHeader(init?.headers?.cookie);
      const responseCookieNames = safeResponseCookieNames(response);
      rpcHop = {
        host: url.hostname,
        path: 'protected_project_rpc',
        status: Number.isInteger(response?.status) ? response.status : 0,
        requestCookieNames,
        requestCookieCount: requestCookieNames.length,
        responseCookieNames,
        responseCookieCount: responseCookieNames.length,
      };
      hops.push(rpcHop);
      return response;
    },
    readCredentialImpl: () => JSON.stringify(validatedFlow),
    writeCredentialImpl: (name, value) => {
      if (name !== FLOW_CREDENTIAL) throw fail('FLOW_SSO_RECOVERY_ISOLATION_FAILED');
      // Keep this argument in memory only; this transport is used solely for the pre-commit RPC.
      void value;
      return { stored: true, plaintextPersisted: false, encryption: 'isolated memory' };
    },
  });
  transport.bundle = validatedFlow;
  transport.document = { ...document, checkedAt: new Date(clock()).toISOString() };
  let projectRead;
  try { projectRead = await transport.rpc(RPC.projectMedia, buildProjectMediaRequest(projectId)); }
  catch { throw fail('FLOW_SSO_RECOVERY_PROJECT_RPC_FAILED'); }
  if (!Array.isArray(projectRead?.payload?.[1]) || !Array.isArray(projectRead?.payload?.[2])
    || projectRead.payload[1].length > 50_000 || projectRead.payload[2].length > 50_000) {
    throw fail('FLOW_SSO_RECOVERY_PROJECT_RPC_SCHEMA');
  }
  const verifiedFlow = transport.bundle;
  mergeFlowRotationsIntoJar(jar, { cookies: flowCookies }, verifiedFlow);
  try {
    validatedFlow = validateFlowSessionBundle({
      version: 1,
      origin: FLOW_ORIGIN,
      projectId,
      capturedAt: new Date(clock()).toISOString(),
      cookies: verifiedFlow.cookies,
    }, { now: clock() });
  } catch { throw fail('FLOW_SSO_RECOVERY_FLOW_BUNDLE_INVALID'); }

  const brokerCookies = accountCookies(jar).filter(cookie => cookieUnexpired(cookie, clock()));
  const updatedBroker = validateGoogleFlowAuthBundle({
    version: 1,
    origin: ACCOUNTS_ORIGIN,
    serviceOrigin: FLOW_ORIGIN,
    projectId,
    owner: broker.owner,
    cookies: brokerCookies,
    capturedAt: new Date(clock()).toISOString(),
  }, { now: clock() });

  // Optimistic concurrency guard: neither protected input may be replaced while the
  // network verification is in flight. In particular, project changes never get clobbered.
  const latestBrokerRaw = readProtected(readCredentialImpl, GOOGLE_FLOW_AUTH_CREDENTIAL);
  const latestFlowRaw = readProtected(readCredentialImpl, FLOW_CREDENTIAL);
  if (latestBrokerRaw !== brokerRaw || latestFlowRaw !== flowRaw) throw fail('FLOW_SSO_RECOVERY_STORE_CONFLICT');
  validateExistingFlow(latestFlowRaw, projectId);

  storeCredential(writeCredentialImpl, FLOW_CREDENTIAL, validatedFlow);
  try {
    storeCredential(writeCredentialImpl, GOOGLE_FLOW_AUTH_CREDENTIAL, updatedBroker);
  } catch (storeError) {
    const error = fail('FLOW_SSO_RECOVERY_PARTIAL_COMMIT');
    error.flowStored = true;
    error.googleAuthStored = false;
    if (['FLOW_SSO_RECOVERY_CREDENTIAL_STORE_WRITE_TIMEOUT',
      'FLOW_SSO_RECOVERY_CREDENTIAL_STORE_WRITE_FAILED',
      'FLOW_SSO_RECOVERY_CREDENTIAL_STORE_UNVERIFIED'].includes(storeError?.code)) {
      error.storeFailureCode = storeError.code;
    }
    throw error;
  }

  // This object is safe for CLI logs: no URLs, identities, cookie values, tokens, or bodies.
  if (!rpcHop || rpcHop.status !== projectRead.evidence.httpStatus) throw fail('FLOW_SSO_RECOVERY_PROJECT_RPC_FAILED');
  return {
    operation: 'google_sso_flow_session_recovery',
    method: 'GET',
    hops,
    projectVerified: true,
    ownerVerified: true,
    protectedRpcVerified: true,
    listedMediaCount: projectRead.payload[2].length,
    flowCookieCount: validatedFlow.cookies.length,
    googleAuthCookieCount: updatedBroker.cookies.length,
    flowStored: true,
    googleAuthStored: true,
    capturedAt: validatedFlow.capturedAt,
  };
}
