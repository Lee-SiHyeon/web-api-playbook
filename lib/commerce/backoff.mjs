// Bounded retry, Retry-After parsing, request pacing and anti-bot stop classification.
// Pure helpers: no network, no timers unless a sleep function is injected.
// See references/rate-limit-backoff.md and references/anti-bot-boundaries.md.

const RETRYABLE = new Set([429, 502, 503, 504]);
const CHALLENGE_STATUSES = new Set([403, 418, 451]);

// Markers are detection-only heuristics used to classify responses.
export const CHALLENGE_MARKERS = Object.freeze([
  { vendor: 'cloudflare', pattern: /cf-chl-|challenges\.cloudflare\.com|__cf_chl_|Just a moment\.\.\./i },
  { vendor: 'akamai', pattern: /_abck|bm_sz|ak_bmsc|Reference #\d+\.[0-9a-f]+/i },
  { vendor: 'perimeterx', pattern: /_px[a-z0-9]*|px-captcha|perimeterx|human\.com\/captcha/i },
  { vendor: 'datadome', pattern: /datadome|captcha-delivery\.com/i },
  { vendor: 'aliexpress', pattern: /x5sec|punish\?|_____tmd_____|baxia|nc_1_wrapper/i },
  { vendor: 'recaptcha', pattern: /www\.google\.com\/recaptcha|g-recaptcha|hcaptcha\.com/i },
  { vendor: 'amazon', pattern: /\/errors\/validateCaptcha|api-services-support@amazon\.com/i },
]);

/** Lower-case string map from a plain object or fetch Headers. */
export function normalizeHeaders(headers = {}) {
  const out = Object.create(null);
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      if (typeof key === 'string' && (typeof value === 'string' || typeof value === 'number')) {
        out[key.toLowerCase()] = String(value);
      }
    });
    return out;
  }
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof key === 'string' && (typeof value === 'string' || typeof value === 'number')) {
        out[key.toLowerCase()] = String(value);
      }
    }
  }
  return out;
}

/** Parse Retry-After (delta-seconds or HTTP-date) into milliseconds, or null. */
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d{1,7}$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * Classify a response for the retry loop.
 * Returns { action: 'ok'|'retry'|'stop', reason, vendor? }.
 * Challenge pages and auth rejections are always 'stop' (record and end the run).
 */
export function classifyResponse({ status, headers = {}, bodySample = '' } = {}) {
  const sample = typeof bodySample === 'string' ? bodySample.slice(0, 20_000) : '';
  const normalized = normalizeHeaders(headers);
  const headerText = Object.entries(normalized).map(([k, v]) => `${k}: ${v}`).join('\n');
  for (const marker of CHALLENGE_MARKERS) {
    if (marker.pattern.test(sample) || marker.pattern.test(headerText)) {
      return { action: 'stop', reason: 'challenge_detected', vendor: marker.vendor };
    }
  }
  if (CHALLENGE_STATUSES.has(status)) return { action: 'stop', reason: `http_${status}` };
  if (status === 401) return { action: 'stop', reason: 'auth_rejected' };
  if (RETRYABLE.has(status)) return { action: 'retry', reason: `http_${status}` };
  if (status >= 200 && status < 300) return { action: 'ok', reason: 'success' };
  return { action: 'stop', reason: `http_${status}` };
}

/** Full-jitter exponential delay, capped; Retry-After wins when larger (still capped). */
export function computeBackoffDelay({
  attempt, baseMs = 2_000, maxMs = 120_000, retryAfterMs = null, random = Math.random,
}) {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new TypeError('attempt must be a non-negative integer');
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20));
  const jittered = Math.floor(random() * ceiling);
  const floor = retryAfterMs == null ? 0 : retryAfterMs;
  return Math.min(maxMs, Math.max(jittered, floor));
}

/**
 * Per-origin pacing gate: minimum interval between requests and a hard daily cap.
 * State is in memory; persist `snapshot()` if a runner restarts within the window.
 */
export function createRateGate({ minIntervalMs = 5_000, dailyLimit = 500, now = Date.now, state } = {}) {
  let last = state?.last ?? null;
  let day = state?.day ?? null;
  let count = state?.count ?? 0;
  return {
    /** Returns { allowed, waitMs, reason }. Does not sleep. */
    reserve() {
      const t = now();
      const today = new Date(t).toISOString().slice(0, 10);
      if (today !== day) { day = today; count = 0; }
      if (count >= dailyLimit) return { allowed: false, waitMs: null, reason: 'daily_limit' };
      const waitMs = last == null ? 0 : Math.max(0, last + minIntervalMs - t);
      if (waitMs > 0) return { allowed: false, waitMs, reason: 'min_interval' };
      last = t; count += 1;
      return { allowed: true, waitMs: 0, reason: 'reserved' };
    },
    snapshot() { return { last, day, count }; },
  };
}

/**
 * Run a safe READ with bounded retries. `request()` must resolve to
 * { status, headers, bodySample, value }. Writes must not use this helper.
 * Call createRateGate().reserve() inside `request` so every attempt is paced.
 */
export async function withBoundedRetry(request, {
  maxAttempts = 3, baseMs = 2_000, maxMs = 120_000, sleep, random = Math.random, now = Date.now,
} = {}) {
  if (typeof sleep !== 'function') throw new TypeError('sleep must be injected');
  const attempts = [];
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await request();
    const verdict = classifyResponse(response);
    attempts.push({ attempt, status: response.status, ...verdict });
    if (verdict.action === 'ok') return { ok: true, value: response.value, attempts };
    if (verdict.action === 'stop' || attempt === maxAttempts - 1) return { ok: false, attempts };
    const headers = normalizeHeaders(response.headers);
    const retryAfterMs = parseRetryAfter(headers['retry-after'], now());
    await sleep(computeBackoffDelay({ attempt, baseMs, maxMs, retryAfterMs, random }));
  }
  return { ok: false, attempts };
}
