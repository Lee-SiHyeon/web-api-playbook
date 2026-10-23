const FLOW_ORIGIN = 'https://flow.google.com';
const FLOW_HOST = 'flow.google.com';
const GOOGLE_DOMAIN = 'google.com';
const PROJECT_ID = /^[a-f0-9-]{16,64}$/i;
const COOKIE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,100}$/;
const MAX_COOKIES = 64;
const MAX_COOKIE_BYTES = 16_384;
const SAME_SITE_VALUES = new Map([
  ['no_restriction', 'no_restriction'],
  ['lax', 'lax'],
  ['strict', 'strict'],
  ['unspecified', 'unspecified'],
  ['Strict', 'strict'],
  ['Lax', 'lax'],
  ['None', 'no_restriction'],
]);
// This set is only a presence check. Every syntactically valid, in-scope cookie is preserved.
const AUTH_COOKIE_NAMES = new Set(['SID', '__Secure-1PSID', 'OSID', '__Secure-OSID']);

function fail(code) {
  throw new Error(code);
}

function pathMatches(cookiePath, requestPath) {
  return requestPath === cookiePath
    || (requestPath.startsWith(cookiePath)
      && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'));
}

function validateLegacyHeader(cookieHeader) {
  if (typeof cookieHeader !== 'string' || !cookieHeader
    || cookieHeader.length > MAX_COOKIE_BYTES || /[\r\n\0]/.test(cookieHeader)) {
    fail('FLOW_COOKIE_INVALID');
  }
  const entries = cookieHeader.split(/;\s*/);
  if (entries.length < 2 || entries.length > MAX_COOKIES || entries.some(entry => {
    const equal = entry.indexOf('=');
    if (equal < 1) return true;
    const name = entry.slice(0, equal);
    const value = entry.slice(equal + 1);
    return !COOKIE_NAME.test(name) || !value || /[;\r\n\0]/.test(value);
  })) fail('FLOW_COOKIE_INVALID');

  const names = entries.map(entry => entry.slice(0, entry.indexOf('=')));
  if (!names.some(name => AUTH_COOKIE_NAMES.has(name))) fail('FLOW_AUTH_COOKIE_MISSING');
  return { cookieHeader, cookieCount: entries.length };
}

function validateScopedCookies(cookies, projectPath, nowSeconds) {
  if (!Array.isArray(cookies) || cookies.length < 1 || cookies.length > MAX_COOKIES) {
    fail('FLOW_COOKIE_INVALID');
  }

  const seenScopes = new Set();
  let headerBytes = 0;
  const validated = cookies.map(cookie => {
    if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)
      || typeof cookie.name !== 'string' || !COOKIE_NAME.test(cookie.name)
      || typeof cookie.value !== 'string' || !cookie.value
      || /[;\r\n\0]/.test(cookie.value)
      || typeof cookie.domain !== 'string' || !cookie.domain
      || typeof cookie.path !== 'string' || !cookie.path.startsWith('/')
      || /[;\r\n\0]/.test(cookie.path)
      || typeof cookie.secure !== 'boolean') {
      fail('FLOW_COOKIE_INVALID');
    }
    if (Object.hasOwn(cookie, 'partitionKey')) fail('FLOW_COOKIE_PARTITIONED_UNSUPPORTED');

    if (cookie.domain !== cookie.domain.trim()) fail('FLOW_COOKIE_SCOPE_INVALID');
    const rawDomain = cookie.domain.toLowerCase();
    const dottedDomain = rawDomain.startsWith('.');
    const domain = dottedDomain ? rawDomain.slice(1) : rawDomain;
    if (domain !== FLOW_HOST && domain !== GOOGLE_DOMAIN) fail('FLOW_COOKIE_SCOPE_INVALID');
    if (Object.hasOwn(cookie, 'hostOnly') && typeof cookie.hostOnly !== 'boolean') {
      fail('FLOW_COOKIE_INVALID');
    }
    const hostOnly = Object.hasOwn(cookie, 'hostOnly') ? cookie.hostOnly : !dottedDomain;
    if ((dottedDomain && hostOnly)
      || (hostOnly && domain !== FLOW_HOST)
      || (!hostOnly && domain !== FLOW_HOST && domain !== GOOGLE_DOMAIN)) {
      fail('FLOW_COOKIE_SCOPE_INVALID');
    }
    if (!pathMatches(cookie.path, projectPath)) fail('FLOW_COOKIE_SCOPE_INVALID');

    if (Object.hasOwn(cookie, 'session') && typeof cookie.session !== 'boolean') {
      fail('FLOW_COOKIE_INVALID');
    }
    const hasExpires = Object.hasOwn(cookie, 'expires') && cookie.expires !== null;
    const hasExpirationDate = Object.hasOwn(cookie, 'expirationDate') && cookie.expirationDate !== null;
    if (hasExpires && (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires))) {
      fail('FLOW_COOKIE_INVALID');
    }
    if (hasExpirationDate
      && (typeof cookie.expirationDate !== 'number' || !Number.isFinite(cookie.expirationDate))) {
      fail('FLOW_COOKIE_INVALID');
    }
    if (hasExpires && hasExpirationDate && cookie.expires !== cookie.expirationDate) {
      fail('FLOW_COOKIE_INVALID');
    }
    const rawExpires = hasExpires ? cookie.expires : hasExpirationDate ? cookie.expirationDate : undefined;
    const sessionSentinel = rawExpires === -1;
    const isSessionCookie = sessionSentinel || rawExpires === undefined;
    if (isSessionCookie) {
      if (cookie.session !== true) fail('FLOW_COOKIE_INVALID');
    } else {
      if (rawExpires < 0) fail('FLOW_COOKIE_INVALID');
      if (rawExpires <= nowSeconds) fail('FLOW_COOKIE_EXPIRED');
      if (cookie.session === true) fail('FLOW_COOKIE_INVALID');
    }
    if (Object.hasOwn(cookie, 'httpOnly') && typeof cookie.httpOnly !== 'boolean') {
      fail('FLOW_COOKIE_INVALID');
    }
    if (Object.hasOwn(cookie, 'sameSite')
      && (typeof cookie.sameSite !== 'string' || !SAME_SITE_VALUES.has(cookie.sameSite))) {
      fail('FLOW_COOKIE_INVALID');
    }

    const scope = `${cookie.name}\0${domain}\0${hostOnly}\0${cookie.path}`;
    if (seenScopes.has(scope)) fail('FLOW_COOKIE_DUPLICATE_SCOPE');
    seenScopes.add(scope);

    headerBytes += Buffer.byteLength(`${cookie.name}=${cookie.value}; `, 'utf8');
    if (headerBytes > MAX_COOKIE_BYTES) fail('FLOW_COOKIE_INVALID');

    const result = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      hostOnly,
      path: cookie.path,
      secure: cookie.secure,
    };
    if (!isSessionCookie && hasExpires) result.expires = cookie.expires;
    if (!isSessionCookie && hasExpirationDate) result.expirationDate = cookie.expirationDate;
    if (isSessionCookie) result.session = true;
    else if (Object.hasOwn(cookie, 'session')) result.session = cookie.session;
    if (Object.hasOwn(cookie, 'httpOnly')) result.httpOnly = cookie.httpOnly;
    if (Object.hasOwn(cookie, 'sameSite')) result.sameSite = SAME_SITE_VALUES.get(cookie.sameSite);
    return result;
  });

  if (!validated.some(cookie => AUTH_COOKIE_NAMES.has(cookie.name))) fail('FLOW_AUTH_COOKIE_MISSING');
  return { cookies: validated, cookieCount: validated.length };
}

export function validateFlowSessionBundle(bundle, { now = Date.now() } = {}) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
    || bundle.origin !== FLOW_ORIGIN || typeof bundle.projectId !== 'string'
    || !PROJECT_ID.test(bundle.projectId)) {
    fail('FLOW_BOOTSTRAP_INVALID');
  }
  if (!Number.isFinite(now)) fail('FLOW_BOOTSTRAP_INVALID');

  const hasLegacyHeader = Object.hasOwn(bundle, 'cookieHeader');
  const hasScopedCookies = Object.hasOwn(bundle, 'cookies');
  if (hasLegacyHeader === hasScopedCookies) fail('FLOW_BOOTSTRAP_INVALID');

  const common = {
    version: 1,
    origin: FLOW_ORIGIN,
    projectId: bundle.projectId.toLowerCase(),
    capturedAt: new Date(now).toISOString(),
  };
  const cookies = hasLegacyHeader
    ? validateLegacyHeader(bundle.cookieHeader)
    : validateScopedCookies(bundle.cookies, `/project/${bundle.projectId}`, now / 1000);
  return { ...common, ...cookies };
}
