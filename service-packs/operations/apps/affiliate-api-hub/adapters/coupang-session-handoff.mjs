// Persist a fresh first-party Coupang Partners browser session only after the
// canonical HTTP client verifies the saved owner's identity.
const PARTNERS_ORIGIN = 'https://partners.coupang.com';
const ALLOWED_ORIGINS = new Set(['https://partners.coupang.com', 'https://login.coupang.com']);
const ALLOWED_COOKIE_DOMAINS = new Set(['coupang.com', 'partners.coupang.com', 'login.coupang.com']);
const AUTH_COOKIES = new Set([
  'AFATK', 'CT_AT', 'CT_LSID', 'CT_JKTH', 'sid', 'web-session-id', 'member_srl',
  'CPUSR_RL', 'CSID', 'PCID', 'ILOGIN', 'MARKETID', 'CUPT',
]);
const ROUTING_COOKIES = new Set(['AWSALB', 'AWSALBCORS', 'AWSALBTG', 'AWSALBTGCORS']);
const ALLOWED_COOKIES = new Set([...AUTH_COOKIES, ...ROUTING_COOKIES]);
const ALLOWED_HEADERS = new Set(['accept', 'referer', 'lang', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);
const SAFE_PROVIDER_ERRORS = new Set([
  'AUTH_IMPORT_INVALID', 'AUTH_STATE_INVALID', 'SESSION_MISSING', 'REAUTH_REQUIRED',
  'AUTH_FORBIDDEN', 'AUTH_THROTTLED', 'AUTH_RESPONSE_INVALID', 'AUTH_APPLICATION_REJECTED',
  'OWNER_MISMATCH', 'COUPANG_HTTP_ACCESS_DENIED', 'SCOPED_SESSION_COOKIES_INVALID', 'SCOPED_SESSION_COOKIE_SCOPE_INVALID',
  'COUPANG_ATTESTATION_INVALID', 'COUPANG_OWNER_BINDING_INVALID', 'DASHBOARD_SCHEMA_INVALID',
]);
export const COUPANG_HANDOFF_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 30 * 1000;
const MAX_CAPTURE_COOKIES = 256;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateBundle(bundle, currentTime) {
  if (!plainObject(bundle) || Object.keys(bundle).some(key =>
    !['version', 'sourceOrigin', 'capturedAt', 'cookies', 'userAgent', 'headers', 'observedProof'].includes(key))) {
    fail('COUPANG_HANDOFF_BUNDLE_INVALID');
  }
  if (bundle.version !== 1) fail('COUPANG_HANDOFF_BUNDLE_INVALID');
  if (bundle.sourceOrigin !== PARTNERS_ORIGIN || !ALLOWED_ORIGINS.has(bundle.sourceOrigin)) {
    fail('COUPANG_HANDOFF_ORIGIN_INVALID');
  }
  if (!Number.isFinite(bundle.capturedAt) || bundle.capturedAt <= 0) fail('COUPANG_HANDOFF_CAPTURE_TIME_INVALID');
  if (currentTime - bundle.capturedAt > COUPANG_HANDOFF_MAX_AGE_MS
    || bundle.capturedAt - currentTime > MAX_FUTURE_SKEW_MS) fail('COUPANG_HANDOFF_CAPTURE_STALE');
  if (typeof bundle.userAgent !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(bundle.userAgent)
    || !bundle.userAgent.trim()) fail('COUPANG_HANDOFF_USER_AGENT_INVALID');
  const cookies = validateCookies(bundle.cookies, currentTime);
  const headers = validateHeaders(bundle.headers);
  const observedProof = Object.hasOwn(bundle, 'observedProof')
    ? validateObservedProof(bundle.observedProof, { bundleCapturedAt: bundle.capturedAt, currentTime, cookies })
    : null;
  return { cookies, headers, observedProof };
}

function validateObservedProof(proof, { bundleCapturedAt, currentTime, cookies }) {
  const proofKeys = ['version', 'origin', 'path', 'method', 'httpStatus', 'rCode', 'capturedAt', 'member', 'affiliate', 'requestCookies'];
  if (!plainObject(proof) || Object.keys(proof).some(key => !proofKeys.includes(key))
    || proofKeys.some(key => !Object.hasOwn(proof, key))) fail('COUPANG_HANDOFF_PROOF_INVALID');
  if (proof.version !== 1 || proof.origin !== PARTNERS_ORIGIN || proof.path !== '/api/v1/config'
    || proof.method !== 'GET' || proof.httpStatus !== 200 || proof.rCode !== '0'
    || !Number.isFinite(proof.capturedAt) || proof.capturedAt <= 0
    || currentTime - proof.capturedAt > COUPANG_HANDOFF_MAX_AGE_MS
    || proof.capturedAt - currentTime > MAX_FUTURE_SKEW_MS
    || Math.abs(proof.capturedAt - bundleCapturedAt) > COUPANG_HANDOFF_MAX_AGE_MS) {
    fail('COUPANG_HANDOFF_PROOF_INVALID');
  }
  if (!plainObject(proof.member) || Object.keys(proof.member).some(key => !['valid', 'email'].includes(key))
    || proof.member.valid !== true || typeof proof.member.email !== 'string'
    || proof.member.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(proof.member.email)
    || !plainObject(proof.affiliate) || Object.keys(proof.affiliate).some(key => key !== 'affiliateCode')
    || typeof proof.affiliate.affiliateCode !== 'string' || !proof.affiliate.affiliateCode.trim()
    || proof.affiliate.affiliateCode.length > 256) fail('COUPANG_HANDOFF_PROOF_INVALID');
  if (!Array.isArray(proof.requestCookies) || proof.requestCookies.length === 0
    || proof.requestCookies.length > AUTH_COOKIES.size) fail('COUPANG_HANDOFF_PROOF_INVALID');

  const seen = new Set();
  const requestCookies = [];
  for (const cookie of proof.requestCookies) {
    if (!plainObject(cookie) || Object.keys(cookie).some(key => !['name', 'value'].includes(key))
      || typeof cookie.name !== 'string' || !AUTH_COOKIES.has(cookie.name)
      || typeof cookie.value !== 'string' || cookie.value.length === 0 || cookie.value.length > 4096
      || /[\x00-\x20\x7f;]/.test(cookie.value) || seen.has(cookie.name)) fail('COUPANG_HANDOFF_PROOF_INVALID');
    seen.add(cookie.name);
    const matches = cookies.filter(candidate => candidate.name === cookie.name);
    if (matches.length !== 1 || matches[0].value !== cookie.value) fail('COUPANG_HANDOFF_PROOF_COOKIE_MISMATCH');
    requestCookies.push({ name: cookie.name, value: cookie.value });
  }
  if (!seen.has('AFATK')) fail('COUPANG_HANDOFF_PROOF_INVALID');
  return {
    version: 1,
    origin: proof.origin,
    path: proof.path,
    method: proof.method,
    httpStatus: proof.httpStatus,
    rCode: proof.rCode,
    capturedAt: proof.capturedAt,
    member: { valid: true, email: proof.member.email },
    affiliate: { affiliateCode: proof.affiliate.affiliateCode },
    requestCookies,
  };
}

function validateCookies(input, currentTime) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CAPTURE_COOKIES) {
    fail('COUPANG_HANDOFF_COOKIES_INVALID');
  }
  const cookies = [];
  const identities = new Set();
  for (const cookie of input) {
    if (!plainObject(cookie) || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') {
      fail('COUPANG_HANDOFF_COOKIES_INVALID');
    }
    // Ignore unrelated browser state, including analytics and challenge material.
    if (!ALLOWED_COOKIES.has(cookie.name)) continue;
    const domainInput = cookie.domain;
    if (typeof domainInput !== 'string' || !domainInput || /[\s/:?#@]/.test(domainInput)) {
      fail('COUPANG_HANDOFF_COOKIE_SCOPE_INVALID');
    }
    const domain = domainInput.replace(/^\./, '').toLowerCase();
    if (!ALLOWED_COOKIE_DOMAINS.has(domain)) fail('COUPANG_HANDOFF_COOKIE_SCOPE_INVALID');
    if (cookie.path !== '/') fail('COUPANG_HANDOFF_COOKIE_SCOPE_INVALID');
    if (typeof cookie.secure !== 'boolean') fail('COUPANG_HANDOFF_COOKIES_INVALID');
    if (cookie.hostOnly != null && typeof cookie.hostOnly !== 'boolean') fail('COUPANG_HANDOFF_COOKIES_INVALID');
    const hostOnly = typeof cookie.hostOnly === 'boolean' ? cookie.hostOnly : !domainInput.startsWith('.');
    if (hostOnly && domain === 'coupang.com') fail('COUPANG_HANDOFF_COOKIE_SCOPE_INVALID');
    if (cookie.httpOnly != null && typeof cookie.httpOnly !== 'boolean') fail('COUPANG_HANDOFF_COOKIES_INVALID');
    if (cookie.sameSite != null && !['strict', 'lax', 'none', 'no_restriction', 'unspecified'].includes(String(cookie.sameSite).toLowerCase())) {
      fail('COUPANG_HANDOFF_COOKIES_INVALID');
    }
    if (cookie.value.length === 0 || cookie.value.length > 4096 || /[\x00-\x20\x7f;]/.test(cookie.value)) {
      fail('COUPANG_HANDOFF_COOKIES_INVALID');
    }
    const expires = cookie.expires ?? cookie.expirationDate;
    if (expires != null && (typeof expires !== 'number' || !Number.isFinite(expires))) {
      fail('COUPANG_HANDOFF_COOKIES_INVALID');
    }
    if (expires > 0 && expires <= currentTime / 1000) fail('COUPANG_HANDOFF_COOKIE_EXPIRED');
    const identity = `${cookie.name}\u0000${domain}\u0000/`;
    if (identities.has(identity)) fail('COUPANG_HANDOFF_COOKIE_DUPLICATE');
    identities.add(identity);
    cookies.push({
      name: cookie.name,
      value: cookie.value,
      domain: domainInput.startsWith('.') ? `.${domain}` : domain,
      path: '/',
      hostOnly,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly === true,
      ...(expires == null ? {} : { expires }),
      ...(cookie.sameSite == null ? {} : { sameSite: String(cookie.sameSite) }),
    });
  }
  if (!cookies.some(cookie => AUTH_COOKIES.has(cookie.name))) fail('COUPANG_HANDOFF_AUTH_COOKIES_MISSING');
  return cookies;
}

function validateHeaders(input) {
  if (input == null) return {};
  if (!plainObject(input)) fail('COUPANG_HANDOFF_HEADERS_INVALID');
  const result = {};
  const seen = new Set();
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (!ALLOWED_HEADERS.has(name)) continue;
    if (seen.has(name)) fail('COUPANG_HANDOFF_HEADERS_INVALID');
    seen.add(name);
    if (typeof value !== 'string' || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) {
      fail('COUPANG_HANDOFF_HEADERS_INVALID');
    }
    if (name === 'referer') {
      let referer;
      try { referer = new URL(value); } catch { fail('COUPANG_HANDOFF_HEADERS_INVALID'); }
      if (referer.origin !== PARTNERS_ORIGIN || referer.username || referer.password || referer.search || referer.hash) {
        fail('COUPANG_HANDOFF_HEADERS_INVALID');
      }
    }
    result[name] = value;
  }
  return result;
}

function safeProviderCode(error) {
  return SAFE_PROVIDER_ERRORS.has(error?.code) ? error.code : 'COUPANG_HANDOFF_IMPORT_FAILED';
}

function priorIdentity(prior) {
  if (!plainObject(prior) || ![1, 2].includes(prior.version) || typeof prior.email !== 'string'
    || prior.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(prior.email)
    || typeof prior.affiliateCode !== 'string' || !prior.affiliateCode.trim() || prior.affiliateCode.length > 256) {
    fail('COUPANG_HANDOFF_PRIOR_IDENTITY_MISSING');
  }
  return { email: prior.email, affiliateCode: prior.affiliateCode };
}

export async function persistVerifiedCoupangHandoff(bundle, { readPriorState, createAuth, now = Date.now } = {}) {
  if (typeof readPriorState !== 'function' || typeof createAuth !== 'function' || typeof now !== 'function') {
    fail('COUPANG_HANDOFF_DEPENDENCY_MISSING');
  }
  const currentTime = now();
  if (!Number.isFinite(currentTime) || currentTime <= 0) fail('COUPANG_HANDOFF_CLOCK_INVALID');
  const { cookies, headers, observedProof } = validateBundle(bundle, currentTime);

  let prior;
  try { prior = priorIdentity(await readPriorState()); }
  catch (error) {
    if (error?.code === 'COUPANG_HANDOFF_PRIOR_IDENTITY_MISSING') throw error;
    fail('COUPANG_HANDOFF_PRIOR_STATE_UNAVAILABLE');
  }

  if (observedProof && (observedProof.member.email.toLowerCase() !== prior.email.toLowerCase()
    || observedProof.affiliate.affiliateCode !== prior.affiliateCode)) fail('COUPANG_HANDOFF_PROOF_OWNER_MISMATCH');

  let auth;
  try { auth = await createAuth(); }
  catch { fail('COUPANG_HANDOFF_IMPORT_FAILED'); }
  if (!auth || typeof auth.importSession !== 'function'
    || observedProof && typeof auth.importAttestedSession !== 'function') fail('COUPANG_HANDOFF_IMPORT_FAILED');

  let result;
  try {
    const importInput = {
      cookies,
      email: prior.email,
      affiliateCode: prior.affiliateCode,
      userAgent: bundle.userAgent,
      headers,
    };
    result = observedProof
      ? await auth.importAttestedSession({ ...importInput, observedProof })
      : await auth.importSession(importInput);
  } catch (error) {
    fail(safeProviderCode(error));
  }
  if (result?.stored !== true || result?.authenticated !== true || result?.ownerVerified !== true
    || result?.browserUsed !== false) fail('COUPANG_HANDOFF_OWNER_VERIFY_FAILED');
  const receipt = { stored: true, authenticated: true, ownerVerified: true, browserUsed: false };
  if (observedProof) {
    if (result.ownerVerificationSource !== 'authorized_browser_config_session_binding'
      || result.freshHttpIdentityRead !== false) fail('COUPANG_HANDOFF_OWNER_VERIFY_FAILED');
    receipt.ownerVerificationSource = result.ownerVerificationSource;
    receipt.freshHttpIdentityRead = false;
  }
  return receipt;
}
