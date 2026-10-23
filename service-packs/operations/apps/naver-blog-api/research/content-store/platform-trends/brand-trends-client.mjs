import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { withSessionLock } from '../../../../tistory-api/lib/lock.mjs';
import { canonicalRow } from './brand-trend-rows.mjs';
import { DEFAULT_CAPTURE_DIR, persistCapture, safeCaptureText, sanitizeCapture } from './capture-safety.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEDGER_PATH = path.join(ROOT, 'brand-trends-cadence.v1.json');
const LOCK_PATH = path.join(ROOT, 'brand-trends-client.lock');
const SIX_HOURS = 6 * 60 * 60 * 1000;
const KST_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
});
export const BRAND_TREND_RECEIPT_PATH = path.join(ROOT, `brand-trends-live.${kstDayKey(new Date())}.json`);

const PLATFORMS = Object.freeze({
  x: { platform: 'X', account: 'lifehack__ailab', maxPerDay: 2, minIntervalMs: SIX_HOURS },
  instagram: { platform: 'Instagram', account: 'lifehack__ailab', maxPerDay: 2, minIntervalMs: SIX_HOURS },
  threads: { platform: 'Threads', account: 'lifehack__ailab', maxPerDay: 2, minIntervalMs: SIX_HOURS },
  youtube: { platform: 'YouTube', account: 'lifehack__ailab', channelId: 'UCtLdZc1Ooz6KLbDNfo60E5A', maxPerDay: 1, minIntervalMs: 0 },
  tiktok: { platform: 'TikTok', account: 'lifehack__aibal', maxPerDay: 2, minIntervalMs: SIX_HOURS },
});
const CADENCE_POLICIES = Object.freeze({
  ...PLATFORMS,
  tiktok_public: { platform: 'TikTok', account: 'public', maxPerDay: 2, minIntervalMs: SIX_HOURS },
});

const SAFE_CODES = new Set([
  'X_ACTION_REQUEST_SCOPE', 'X_ACTION_SESSION_MISSING', 'X_ACTION_SESSION_INVALID', 'X_HOME_OWNER_UNVERIFIED',
  'X_HOME_VIEWER_INCOMPLETE', 'X_REAUTH_REQUIRED', 'X_READ_BUDGET_WAIT', 'X_READ_FAILED', 'X_READ_TIMEOUT',
  'X_RATE_LIMITED', 'X_OWNER_VERIFY_FAILED', 'META_REAUTH_REQUIRED', 'META_SESSION_MISSING',
  'META_SESSION_INVALID', 'META_DOCUMENT_OWNER_MISMATCH', 'META_DOCUMENT_HTTP_401', 'META_DOCUMENT_HTTP_403',
  'META_DOCUMENT_HTTP_429', 'META_OWNER_REDIRECT_AUTH_UNVERIFIED', 'META_ACTION_INPUT',
  'META_LOGIN_OR_BOOTSTRAP_REQUIRED', 'META_GRAPHQL_THROTTLED',
  'THREADS_GRAPHQL_THROTTLED', 'THREADS_READ_BUDGET_WAIT', 'YOUTUBE_REAUTH_REQUIRED',
  'YOUTUBE_AUTH_STATE_INVALID', 'YOUTUBE_AUTH_STATE_SCOPE_INVALID', 'YOUTUBE_AUTH_COOKIES_MISSING',
  'TIKTOK_REAUTH_REQUIRED', 'TIKTOK_AUTH_STATE_INVALID', 'TIKTOK_AUTH_COOKIES_MISSING',
  'HTTP_AUTH_REQUIRED', 'HTTP_FORBIDDEN', 'HTTP_RATE_LIMITED',
  'CAPTURE_UNSAFE_FORMAT', 'CAPTURE_UNSAFE_VALUE', 'CAPTURE_DIR_UNAVAILABLE', 'CAPTURE_DIR_NOT_ALLOWED',
  'CAPTURE_NAME_INVALID', 'CADENCE_STATE_INVALID', 'CADENCE_STATE_IO_FAILED', 'CADENCE_LIMIT',
  'CADENCE_MIN_INTERVAL', 'CAPTCHA_OR_CHALLENGE', 'CREATOR_TRENDS_NOT_AVAILABLE', 'TREND_CONTRACT_UNOBSERVED', 'ACCOUNT_SCOPE_MISMATCH',
  'PROVIDER_READ_FAILED', 'UNKNOWN_PLATFORM', 'OUTPUT_SCOPE_INVALID',
]);

function codeOf(error) {
  if (SAFE_CODES.has(error?.code)) return error.code;
  if (typeof error?.code === 'string' && /^META_(?:DOCUMENT|OWNER)_HTTP_[1-5]\d\d$/.test(error.code)) return error.code;
  return 'PROVIDER_READ_FAILED';
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw Object.assign(new Error('CADENCE_STATE_INVALID'), { code: 'CADENCE_STATE_INVALID' });
  return date;
}

export function kstDayKey(value = new Date()) {
  const parts = Object.fromEntries(KST_FORMATTER.formatToParts(asDate(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function emptyLedger() {
  return { schemaVersion: 1, entries: [] };
}

async function readLedger(filename) {
  try {
    const ledger = JSON.parse(await readFile(filename, 'utf8'));
    if (ledger?.schemaVersion !== 1 || !Array.isArray(ledger.entries) || ledger.entries.length > 1000
      || ledger.entries.some((entry) => !CADENCE_POLICIES[entry?.platform]
        || typeof entry?.attemptedAt !== 'string' || !Number.isFinite(Date.parse(entry.attemptedAt))
        || typeof entry?.kstDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.kstDay))) {
      throw Object.assign(new Error('CADENCE_STATE_INVALID'), { code: 'CADENCE_STATE_INVALID' });
    }
    return ledger;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyLedger();
    if (error?.code === 'CADENCE_STATE_INVALID') throw error;
    throw Object.assign(new Error('CADENCE_STATE_IO_FAILED'), { code: 'CADENCE_STATE_IO_FAILED' });
  }
}

async function writeLedger(filename, ledger) {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(ledger, null, 2), { flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function cadenceDecision(ledger, key, now) {
  const day = kstDayKey(now);
  const entries = ledger.entries.filter((entry) => entry.platform === key);
  const today = entries.filter((entry) => entry.kstDay === day).sort((a, b) => Date.parse(a.attemptedAt) - Date.parse(b.attemptedAt));
  if (today.length >= CADENCE_POLICIES[key].maxPerDay) return { allowed: false, day, count: today.length, code: 'CADENCE_LIMIT' };
  const latest = entries.at(-1);
  if (latest && CADENCE_POLICIES[key].minIntervalMs > 0) {
    const elapsed = now.getTime() - Date.parse(latest.attemptedAt);
    if (elapsed < CADENCE_POLICIES[key].minIntervalMs) {
      return { allowed: false, day, count: today.length, code: 'CADENCE_MIN_INTERVAL', nextEligibleAt: new Date(Date.parse(latest.attemptedAt) + CADENCE_POLICIES[key].minIntervalMs).toISOString() };
    }
  }
  return { allowed: true, day, count: today.length };
}

function baseResult(key, observedAt, cadence, fields = {}) {
  const cfg = PLATFORMS[key];
  return {
    platform_key: key,
    platform: cfg.platform,
    account_scope: cfg.account,
    market: 'KR',
    observed_at: observedAt.toISOString(),
    kst_day: cadence.day,
    status: 'blocked',
    code: 'TREND_CONTRACT_UNOBSERVED',
    retry_at: null,
    fields: [],
    trend_rows: [],
    capture_ref: null,
    http_status: null,
    http_request_count: 0,
    platform_write_count: 0,
    ...fields,
  };
}

function contentTypeOf(response) {
  const headers = response?.headers;
  const value = headers?.get?.('content-type') ?? headers?.['content-type'] ?? headers?.['Content-Type'];
  return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
}

async function responseText(response) {
  if (typeof response?.raw === 'string') return response.raw;
  if (typeof response?.text === 'function') return response.text();
  return '';
}

function isChallenge(status, text) {
  return /captcha|bot.?guard|verify (?:that )?you are human|unusual traffic|security challenge|recaptcha/i.test(text.slice(0, 250_000));
}

function countingFetch(fetchImpl, counter) {
  return async (...args) => {
    counter.count += 1;
    return fetchImpl(...args);
  };
}

async function loadDeps(key, supplied = {}) {
  const deps = { ...supplied };
  const base = new URL('../../../../social-actions/', import.meta.url);
  const load = async (relative) => import(new URL(relative, base).href);
  if (key === 'x' && (!deps.withXReadContext || !deps.readCooldown)) {
    const x = await load('providers/x.mjs');
    deps.withXReadContext ??= x.withXReadContext;
    deps.readCooldown ??= (await load('x-read-cooldown.mjs')).readCooldown;
  }
  if (['instagram', 'threads'].includes(key)) {
    if (!deps.openMetaContext || !deps.withMetaSessionLock) {
      const meta = await load('lib/meta-bootstrap.mjs');
      deps.openMetaContext ??= meta.openMetaContext;
      deps.withMetaSessionLock ??= meta.withMetaSessionLock;
    }
    if (key === 'threads' && !deps.readThreadsSharedCooldown) {
      deps.readThreadsSharedCooldown = (await load('lib/threads-graphql-throttle.mjs')).readThreadsSharedCooldown;
    }
  }
  if (key === 'youtube' && !deps.loadYoutubeSession) deps.loadYoutubeSession = (await load('lib/youtube-auth-session.mjs')).loadYoutubeSession;
  if (key === 'tiktok' && !deps.loadTikTokSession) deps.loadTikTokSession = (await load('lib/tiktok-auth-session.mjs')).loadTikTokSession;
  return deps;
}

async function probeX(deps, options) {
  const counter = { count: 0 };
  const route = '/i/api/graphql/S_hzVUv1trgZ_5ruDe2IoA/GenericTimelineById';
  const fetchImpl = countingFetch(options.fetchImpl || globalThis.fetch, counter);
  try {
    const probe = await deps.withXReadContext(async (context) => {
      if (context?.ownerHandle?.toLowerCase() !== PLATFORMS.x.account) {
        return { code: 'ACCOUNT_SCOPE_MISMATCH', ownerVerified: false };
      }
      // The observed operation is intentionally submitted only to the existing guarded provider.
      // That provider currently rejects GenericTimelineById before network dispatch.
      try {
        await context.request('GET', route, `https://x.com${route}`);
        return { code: 'TREND_CONTRACT_UNOBSERVED', ownerVerified: true, retry_at: null };
      } catch (error) {
        const cooldown = deps.readCooldown?.(error, 'read');
        return { code: codeOf(error), ownerVerified: true,
          retry_at: Number.isFinite(cooldown?.retryAt) ? new Date(cooldown.retryAt).toISOString() : null };
      }
    }, { fetchImpl });
    return { code: probe?.code || 'TREND_CONTRACT_UNOBSERVED', account_scope_verified: probe?.ownerVerified === true,
      http_request_count: counter.count, retry_at: probe?.retry_at ?? null };
  } catch (error) {
    const cooldown = deps.readCooldown?.(error, 'read');
    return { code: codeOf(error), account_scope_verified: false, http_request_count: counter.count,
      retry_at: Number.isFinite(cooldown?.retryAt) ? new Date(cooldown.retryAt).toISOString() : null };
  }
}

async function probeMeta(key, deps, options) {
  const service = key;
  const counter = { count: 0 };
  const fetchImpl = countingFetch(options.fetchImpl || globalThis.fetch, counter);
  try {
    let context;
    const open = () => deps.openMetaContext(service, PLATFORMS[key].account, { fetchImpl });
    if (service === 'threads') {
      const cooldown = await deps.readThreadsSharedCooldown();
      if (cooldown) return { code: 'THREADS_GRAPHQL_THROTTLED', account_scope_verified: false, http_request_count: 0 };
      context = await deps.withMetaSessionLock(service, open);
    } else {
      context = await deps.withMetaSessionLock(service, open);
    }
    const ownerVerified = context?.documentReceipt?.ownerVerified === true
      && context?.bundle?.owner?.toLowerCase() === PLATFORMS[key].account;
    if (!ownerVerified) return { code: 'ACCOUNT_SCOPE_MISMATCH', account_scope_verified: false, http_request_count: counter.count };
    return { code: 'TREND_CONTRACT_UNOBSERVED', account_scope_verified: true,
      professional_account: key === 'instagram' ? null : undefined,
      http_status: context?.documentReceipt?.httpStatus ?? null, http_request_count: counter.count };
  } catch (error) {
    return { code: codeOf(error), account_scope_verified: false, http_request_count: counter.count };
  }
}

async function probeYoutube(deps) {
  let httpRequestCount = 0;
  try {
    const loaded = await deps.loadYoutubeSession();
    if (loaded?.channelId !== PLATFORMS.youtube.channelId || loaded?.currentHandle?.toLowerCase() !== PLATFORMS.youtube.account) {
      return { code: 'ACCOUNT_SCOPE_MISMATCH', account_scope_verified: false, http_request_count: 0 };
    }
    httpRequestCount += 1;
    const response = await loaded.session.request(`https://studio.youtube.com/channel/${PLATFORMS.youtube.channelId}/`);
    const status = Number(response?.status) || null;
    const text = await responseText(response);
    if (isChallenge(status, text)) return { code: 'CAPTCHA_OR_CHALLENGE', account_scope_verified: false, http_status: status, http_request_count: httpRequestCount };
    if (status === 401) return { code: 'HTTP_AUTH_REQUIRED', account_scope_verified: false, http_status: status, http_request_count: httpRequestCount };
    if (status === 403) return { code: 'HTTP_FORBIDDEN', account_scope_verified: false, http_status: status, http_request_count: httpRequestCount };
    if (status === 429) return { code: 'HTTP_RATE_LIMITED', account_scope_verified: false, http_status: status, http_request_count: httpRequestCount };
    // A successful Studio document does not establish which Research/Insights contract returned trends.
    return { code: 'TREND_CONTRACT_UNOBSERVED', account_scope_verified: false, http_status: status, http_request_count: httpRequestCount };
  } catch (error) {
    return { code: codeOf(error), account_scope_verified: false, http_request_count: httpRequestCount };
  }
}

async function probeTiktok(deps) {
  let httpRequestCount = 0;
  try {
    const loaded = await deps.loadTikTokSession();
    if (loaded?.ownerHandle?.toLowerCase() !== PLATFORMS.tiktok.account) {
      return { code: 'ACCOUNT_SCOPE_MISMATCH', account_scope_verified: false, http_request_count: 0 };
    }
    httpRequestCount += 1;
    const response = await loaded.session.request(`https://www.tiktok.com/@${PLATFORMS.tiktok.account}/`);
    const status = Number(response?.status) || null;
    const text = await responseText(response);
    if (isChallenge(status, text)) return { code: 'CAPTCHA_OR_CHALLENGE', account_scope_verified: false, http_status: status, http_request_count: httpRequestCount };
    if (status === 401) return { code: 'HTTP_AUTH_REQUIRED', account_scope_verified: false, http_status: status, http_request_count: httpRequestCount };
    if (status === 403) return { code: 'HTTP_FORBIDDEN', account_scope_verified: false, http_status: status, http_request_count: httpRequestCount };
    if (status === 429) return { code: 'HTTP_RATE_LIMITED', account_scope_verified: false, http_status: status, http_request_count: httpRequestCount };
    // The profile document is an identity probe, not evidence that Creator Center exposed trends.
    return { code: 'TREND_CONTRACT_UNOBSERVED', account_scope_verified: false, http_status: status, http_request_count: httpRequestCount };
  } catch (error) {
    return { code: codeOf(error), account_scope_verified: false, http_request_count: httpRequestCount };
  }
}

async function probePlatform(key, deps, options) {
  if (key === 'x') return probeX(deps, options);
  if (key === 'instagram' || key === 'threads') return probeMeta(key, deps, options);
  if (key === 'youtube') return probeYoutube(deps);
  return probeTiktok(deps);
}

async function finalizeRead(key, adapterResult, observedAt, cadence, options) {
  const sourceFields = values => [...new Set((Array.isArray(values) ? values : []).filter(value =>
    typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.\[\]]{0,120}$/.test(value)
      && !/cookie|token|authorization|password|signature|csrf|xsrf/i.test(value)))];
  const result = baseResult(key, observedAt, cadence, {
    code: adapterResult?.code || 'TREND_CONTRACT_UNOBSERVED',
    account_scope_verified: adapterResult?.account_scope_verified === true,
    professional_account: adapterResult?.professional_account ?? null,
    retry_at: typeof adapterResult?.retry_at === 'string' ? adapterResult.retry_at : null,
    http_status: Number.isInteger(adapterResult?.http_status) ? adapterResult.http_status : null,
    http_request_count: Number.isSafeInteger(adapterResult?.http_request_count) ? adapterResult.http_request_count : 0,
  });
  if (adapterResult?.uiEvidence?.observed === true && adapterResult.uiEvidence.available === false
    && adapterResult.account_scope_verified === true) {
    result.status = 'not_available';
    result.code = 'CREATOR_TRENDS_NOT_AVAILABLE';
    result.fields = sourceFields(adapterResult.uiEvidence.fields);
    return result;
  }
  if (adapterResult?.account_scope_verified !== true || adapterResult?.trendContractVerified !== true || !Array.isArray(adapterResult.trendRows)
    || adapterResult.trendRows.length === 0 || adapterResult.http_status !== 200
    || typeof adapterResult.trendBody !== 'string') return result;

  let sanitizedBody;
  try {
    sanitizedBody = safeCaptureText(adapterResult.trendBody, adapterResult.contentType || 'application/json');
  } catch (error) {
    result.code = codeOf(error);
    return result;
  }
  const captureName = `${key}-${kstDayKey(observedAt)}-${randomUUID()}.json`;
  try {
    await (options.persistCaptureImpl || persistCapture)(captureName, sanitizedBody, {
      captureDir: options.captureDir || DEFAULT_CAPTURE_DIR,
      contentType: adapterResult.contentType || 'application/json',
    });
  } catch (error) {
    result.code = codeOf(error);
    return result;
  }
  const trendRows = adapterResult.trendRows.map((row) => canonicalRow({
    ...row,
    platform: PLATFORMS[key].platform,
    market: row.market || 'KR',
    account_scope: PLATFORMS[key].account,
    observed_at: observedAt.toISOString(),
    capture_ref: captureName,
    access: 'brand-session',
    verdict: 'brand_session_required',
    http_status: 200,
  })).filter((row) => typeof row.label === 'string' && row.label.length > 0);
  if (!trendRows.length) {
    result.code = 'TREND_CONTRACT_UNOBSERVED';
    return result;
  }
  result.status = 'http_ready';
  result.code = 'TREND_RESPONSE_NORMALIZED';
  result.fields = sourceFields(adapterResult.observedFields);
  result.trend_rows = trendRows;
  result.capture_ref = captureName;
  return result;
}

/** Read one brand-owned platform surface, with a KST cadence ledger and fail-closed trend contracts. */
export async function collectPlatform(platform, options = {}) {
  const key = String(platform || '').toLowerCase();
  if (!PLATFORMS[key]) return { platform_key: key || null, status: 'blocked', code: 'UNKNOWN_PLATFORM', trend_rows: [], platform_write_count: 0 };
  const now = asDate(options.now ?? new Date());
  const ledgerPath = options.ledgerPath || DEFAULT_LEDGER_PATH;
  let reservation;
  try { reservation = await reserveCollectionRun(key, { ...options, now, ledgerPath }); }
  catch (error) { return baseResult(key, now, { day: kstDayKey(now), count: 0 }, { code: codeOf(error) }); }
  if (!reservation.allowed) return baseResult(key, now, { day: reservation.kst_day, count: reservation.attempts_today }, {
    code: reservation.code, next_eligible_at: reservation.next_eligible_at || null,
  });

  let adapterResult;
  try {
    if (typeof options.probeAdapters?.[key] === 'function') adapterResult = await options.probeAdapters[key]({ platform: key, observedAt: now });
    else {
      const deps = await loadDeps(key, options.dependencies);
      adapterResult = await probePlatform(key, deps, options);
    }
  } catch (error) {
    adapterResult = { code: codeOf(error), account_scope_verified: false, http_request_count: 0 };
  }
  return sanitizeCapture(await finalizeRead(key, adapterResult, now, { day: reservation.kst_day, count: reservation.attempts_today }, options));
}

/** Atomically reserve a collection slot for brand-session or public platform readers. */
export async function reserveCollectionRun(platform, options = {}) {
  const key = String(platform || '').toLowerCase();
  if (!CADENCE_POLICIES[key]) throw Object.assign(new Error('UNKNOWN_PLATFORM'), { code: 'UNKNOWN_PLATFORM' });
  const now = asDate(options.now ?? new Date());
  const ledgerPath = options.ledgerPath || DEFAULT_LEDGER_PATH;
  const lockPath = options.lockPath || (ledgerPath === DEFAULT_LEDGER_PATH ? LOCK_PATH : `${ledgerPath}.lock`);
  const lock = options.withSessionLock || withSessionLock;
  return lock(async () => {
    const ledger = await readLedger(ledgerPath);
    const decision = cadenceDecision(ledger, key, now);
    if (!decision.allowed) return {
      allowed: false, platform_key: key, code: decision.code, kst_day: decision.day,
      attempts_today: decision.count, next_eligible_at: decision.nextEligibleAt || null,
    };
    ledger.entries.push({ platform: key, attemptedAt: now.toISOString(), kstDay: decision.day });
    ledger.entries = ledger.entries.filter((entry) => Date.parse(entry.attemptedAt) >= now.getTime() - 8 * 24 * 60 * 60 * 1000);
    try { await writeLedger(ledgerPath, ledger); }
    catch { throw Object.assign(new Error('CADENCE_STATE_IO_FAILED'), { code: 'CADENCE_STATE_IO_FAILED' }); }
    return { allowed: true, platform_key: key, code: null, kst_day: decision.day,
      attempts_today: decision.count + 1, attempted_at: now.toISOString(), next_eligible_at: null };
  }, { lockPath, timeoutMs: options.lockTimeoutMs || 30_000 });
}

export async function collectPlatforms(platform = 'all', options = {}) {
  const keys = String(platform).toLowerCase() === 'all' ? Object.keys(PLATFORMS) : [String(platform).toLowerCase()];
  const results = [];
  for (const key of keys) results.push(await collectPlatform(key, options));
  return { schemaVersion: 1, observed_at: asDate(options.now ?? new Date()).toISOString(), market: 'KR', results };
}

export async function writeReceipt(receipt, outputPath = BRAND_TREND_RECEIPT_PATH) {
  const resolved = path.resolve(outputPath);
  if (resolved.toLowerCase() !== BRAND_TREND_RECEIPT_PATH.toLowerCase()) {
    throw Object.assign(new Error('OUTPUT_SCOPE_INVALID'), { code: 'OUTPUT_SCOPE_INVALID' });
  }
  const temporary = `${resolved}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(sanitizeCapture(receipt), null, 2), { flag: 'wx' });
    await rename(temporary, resolved);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return resolved;
}

async function cli(argv) {
  let platform = 'all';
  let outputPath = BRAND_TREND_RECEIPT_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--platform' && argv[index + 1]) platform = argv[++index];
    else if (argv[index] === '--out' && argv[index + 1]) outputPath = path.resolve(argv[++index]);
    else if (argv[index] === '--help') {
      process.stdout.write('Usage: node brand-trends-client.mjs [--platform all|x|instagram|threads|youtube|tiktok] [--out fixed-target-receipt]\n');
      return;
    }
  }
  const receipt = await collectPlatforms(platform);
  try { await writeReceipt(receipt, outputPath); }
  catch (error) {
    process.stdout.write(JSON.stringify({ status: 'blocked', code: codeOf(error), platform_write_count: 0 }) + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(sanitizeCapture(receipt), null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((error) => {
    process.stdout.write(JSON.stringify({ status: 'blocked', code: codeOf(error), platform_write_count: 0 }) + '\n');
    process.exitCode = 1;
  });
}
