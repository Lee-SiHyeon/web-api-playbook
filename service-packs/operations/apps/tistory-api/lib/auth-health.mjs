const KAKAO_COOKIE_NAMES = new Set(['_kawlt', '_kaslt', '_kawltea', '_kahai']);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RENEWAL_WARNING_AFTER_HOURS = 24;
const COOKIE_EXPIRY_WARNING_WITHIN_MS = 3 * DAY_MS;
const WARNING_CODES = new Set([
  'TISTORY_KAKAO_RENEWAL_AGE_WARNING',
  'TISTORY_KAKAO_COOKIE_EXPIRY_WARNING',
  'TISTORY_KAKAO_REAUTH_REQUIRED',
  'TISTORY_KAKAO_RENEWAL_TIME_UNKNOWN',
]);

const FAILURE_CODES = new Set([
  'TISTORY_REAUTH_REQUIRED',
  'TISTORY_KAKAO_REAUTH_REQUIRED',
  'TISTORY_KAKAO_LOGIN_FAILED',
  'TISTORY_KAKAO_JSON_INVALID',
  'TISTORY_KAKAO_PAGE_CHANGED',
  'TISTORY_ACCOUNT_SELECTION_REQUIRED',
  'TISTORY_ACCOUNT_MISMATCH',
  'TISTORY_LOGIN_CONTRACT_CHANGED',
  'TISTORY_LOGIN_ENTRY_FAILED',
  'TISTORY_LOGIN_REDIRECT_INVALID',
  'TISTORY_LOGIN_REDIRECT_SCOPE',
  'TISTORY_LOGIN_REDIRECT_LIMIT',
  'TISTORY_LOGIN_HTTP_FAILED',
  'TISTORY_LOGIN_PAGE_UNEXPECTED',
  'TISTORY_OAUTH_SCOPE',
  'TISTORY_OAUTH_STATE_MISMATCH',
]);

const DIAGNOSTIC_REASONS = new Set([
  'password_login_required',
  'saved_account_missing',
  'saved_account_not_matched',
  'saved_account_rejected',
]);
const DIAGNOSTIC_PAGE_TYPES = new Set(['/login/login', '/login/simple_login', 'other']);
const DIAGNOSTIC_STAGES = new Set(['kakao_page', 'kakao_saved_account_post']);

function toMillis(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.length > 128 || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function toIso(value) {
  const time = toMillis(value);
  if (time == null) return null;
  try { return new Date(time).toISOString(); } catch { return null; }
}

function kakaoDomain(value) {
  if (typeof value !== 'string' || value.length > 253) return null;
  const normalized = value.replace(/^\./, '').toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(normalized) || normalized.endsWith('.')) return null;
  if (normalized !== 'kakao.com' && !normalized.endsWith('.kakao.com')) return null;
  return normalized;
}

function cookieExpiryMillis(cookie, now) {
  // Max-Age takes precedence over Expires. Match tough-cookie's expiryTime:
  // the last access is the age reference, with creation as a safe fallback.
  if (cookie.maxAge != null) {
    if (typeof cookie.maxAge !== 'number') return now;
    if (Number.isNaN(cookie.maxAge)) return null;
    if (cookie.maxAge <= 0) return now;
    if (!Number.isFinite(cookie.maxAge)) return null;
    const relativeTo = toMillis(cookie.lastAccessed) ?? toMillis(cookie.creation);
    if (relativeTo == null) return null;
    const expiry = relativeTo + cookie.maxAge * 1000;
    return Number.isFinite(expiry) ? expiry : null;
  }

  const expires = cookie.expires;
  if (expires == null || expires === 'Infinity') return null;
  if (typeof expires === 'number') {
    // Browser cookie metadata can represent Expires as seconds since epoch;
    // state jars normally use an ISO string.
    const time = Math.abs(expires) < 1e12 ? expires * 1000 : expires;
    return Number.isFinite(time) ? time : null;
  }
  return toMillis(expires);
}

function safeCookieCandidates(state, now) {
  const cookies = state?.session?.jar?.cookies;
  if (!Array.isArray(cookies)) return [];
  const result = [];
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) continue;
    if (!KAKAO_COOKIE_NAMES.has(cookie.key)) continue;
    const domain = kakaoDomain(cookie.domain);
    if (!domain) continue;
    const expiryMillis = cookieExpiryMillis(cookie, now);
    result.push({
      name: cookie.key,
      domain,
      expiresAt: expiryMillis == null ? null : toIso(expiryMillis),
      expired: expiryMillis != null && expiryMillis <= now,
      _expiryMillis: expiryMillis,
    });
  }
  return result;
}

/** Return only the explicitly allowed, low-risk fields from an auth diagnostic. */
export function sanitizeAuthDiagnostic(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    reason: DIAGNOSTIC_REASONS.has(input.reason) ? input.reason : null,
    pageType: DIAGNOSTIC_PAGE_TYPES.has(input.pageType) ? input.pageType : null,
    savedAccountCount: Number.isInteger(input.savedAccountCount)
      && input.savedAccountCount >= 0 && input.savedAccountCount <= 100
      ? input.savedAccountCount : null,
    pinnedSelectorMatched: typeof input.pinnedSelectorMatched === 'boolean'
      ? input.pinnedSelectorMatched : null,
    stage: DIAGNOSTIC_STAGES.has(input.stage) ? input.stage : null,
  };
}

/**
 * Build a safe health summary from a DPAPI-loaded state-shaped object.
 * Cookie contents, identity, user agent, and arbitrary diagnostic fields are
 * deliberately never copied to the result.
 */
export function buildAuthHealth(state, { now = Date.now() } = {}) {
  const nowMillis = toMillis(now) ?? Date.now();
  const login = state?.login && typeof state.login === 'object' && !Array.isArray(state.login)
    ? state.login : {};
  const reauthRequired = login.reauthRequired === true;
  const lastRenewedAt = toIso(login.lastRenewedAt);
  const renewedMillis = lastRenewedAt == null ? null : Date.parse(lastRenewedAt);
  const renewalAgeHours = renewedMillis == null
    ? null : Math.max(0, Math.round((nowMillis - renewedMillis) / HOUR_MS));
  const kakaoCookieCandidates = safeCookieCandidates(state, nowMillis);
  const expiryMillis = kakaoCookieCandidates
    .map(cookie => cookie._expiryMillis)
    .filter(value => value != null);
  const earliestExpiryMillis = expiryMillis.length ? Math.min(...expiryMillis) : null;
  const warnings = [];

  if (renewedMillis != null && nowMillis - renewedMillis >= RENEWAL_WARNING_AFTER_HOURS * HOUR_MS) {
    warnings.push('TISTORY_KAKAO_RENEWAL_AGE_WARNING');
  }
  if (expiryMillis.some(value => value <= nowMillis + COOKIE_EXPIRY_WARNING_WITHIN_MS)) {
    warnings.push('TISTORY_KAKAO_COOKIE_EXPIRY_WARNING');
  }
  if (reauthRequired) warnings.push('TISTORY_KAKAO_REAUTH_REQUIRED');
  if (lastRenewedAt == null) warnings.push('TISTORY_KAKAO_RENEWAL_TIME_UNKNOWN');

  const rawFailureCode = login.failureCode ?? login.lastFailure;
  const failureCode = typeof rawFailureCode === 'string' && FAILURE_CODES.has(rawFailureCode)
    ? rawFailureCode : null;
  const rawDiagnostic = login.failureDiagnostic ?? login.lastDiagnostic ?? login.diagnostic;

  return {
    reauthRequired,
    lastRenewedAt,
    renewalAgeHours,
    renewalWarningAfterHours: RENEWAL_WARNING_AFTER_HOURS,
    warnings,
    kakaoCookieCandidates: kakaoCookieCandidates.map(({ name, domain, expiresAt, expired }) => ({
      name, domain, expiresAt, expired,
    })),
    earliestKakaoCookieExpiry: earliestExpiryMillis == null ? null : toIso(earliestExpiryMillis),
    failedAt: reauthRequired ? toIso(login.failedAt) : null,
    failureCode,
    failureDiagnostic: rawDiagnostic == null ? null : sanitizeAuthDiagnostic(rawDiagnostic),
  };
}

/** Validate and copy only the public auth-health schema from a child result. */
export function sanitizeAuthHealth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.reauthRequired !== 'boolean'
    || value.renewalWarningAfterHours !== RENEWAL_WARNING_AFTER_HOURS
    || !Array.isArray(value.warnings)
    || !Array.isArray(value.kakaoCookieCandidates)) return null;

  const candidates = [];
  for (const candidate of value.kakaoCookieCandidates.slice(0, 1024)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || !KAKAO_COOKIE_NAMES.has(candidate.name)) continue;
    const domain = kakaoDomain(candidate.domain);
    if (!domain || typeof candidate.expired !== 'boolean') continue;
    candidates.push({
      name: candidate.name,
      domain,
      expiresAt: toIso(candidate.expiresAt),
      expired: candidate.expired,
    });
  }

  const renewalAgeHours = typeof value.renewalAgeHours === 'number'
    && Number.isFinite(value.renewalAgeHours) && value.renewalAgeHours >= 0
    ? Math.round(value.renewalAgeHours) : null;
  const failureCode = typeof value.failureCode === 'string' && FAILURE_CODES.has(value.failureCode)
    ? value.failureCode : null;
  const rawDiagnostic = value.failureDiagnostic;
  const diagnostic = rawDiagnostic && typeof rawDiagnostic === 'object' && !Array.isArray(rawDiagnostic)
    ? sanitizeAuthDiagnostic(rawDiagnostic) : null;

  return {
    reauthRequired: value.reauthRequired,
    lastRenewedAt: toIso(value.lastRenewedAt),
    renewalAgeHours,
    renewalWarningAfterHours: RENEWAL_WARNING_AFTER_HOURS,
    warnings: [...new Set(value.warnings.filter(code => typeof code === 'string' && WARNING_CODES.has(code)))],
    kakaoCookieCandidates: candidates,
    earliestKakaoCookieExpiry: toIso(value.earliestKakaoCookieExpiry),
    failedAt: value.reauthRequired ? toIso(value.failedAt) : null,
    failureCode,
    failureDiagnostic: diagnostic,
  };
}
