import { record } from './native-handoff-envelope';
import { fetchCollectorResponse } from './hub/collectors/fetch-response';
import { tossRuntimeHttpFetch } from './toss-direct-http';
import { applyTossResponseCookies, exportTossCookieJar, restoreTossCookieJar, tossCookieKey, tossCookieHeader,
  TossCookieJarError, TOSS_COOKIE_NAMES, TOSS_COOKIE_HOSTS, TOSS_COOKIE_LIMIT } from './toss-cookie-jar';

// Ported from apps/toss-sharelink/client-core.mjs (2026-10-07 observed browser contracts).
export const TOSS_ORIGIN = 'https://sharelink.toss.im';
export const TOSS_MEMBER_PATH = '/api-public/v3/shopping-growth/sharelink/member';
export const TOSS_HOME_PATH = '/api-public/v3/shopping/sharelink/curation-sections';
export const TOSS_ISSUE_PATH = '/api-public/v3/shopping/sharelink/link/issue';
export const TOSS_SECTIONS = ['TODAY_DEAL', 'BEST_SELLING', 'TRENDING', 'CATEGORY_BEST',
  'MOST_ISSUED', 'GOOD_PRICE', 'HIGH_CONVERSION'] as const;
export type TossSection = typeof TOSS_SECTIONS[number];
export interface TossFailureDiagnostics {
  code: string; phase: 'member' | 'read' | 'issue' | 'sso_authorize' | 'sso_callback' | null; httpStatus: number | null;
  contentTypeFamily: string | null; tossErrorCode: string | null;
}
const CONTENT_TYPES = ['application/json', 'application/*+json', 'text/html', 'text/plain',
  'application/xml', 'text/xml', 'application/octet-stream', 'other'];
/** Closed projection: never include provider text, header parameters, URLs or identity. */
export function projectTossFailureDiagnostics(value: unknown): TossFailureDiagnostics {
  const d = record(value);
  return {
    code: typeof d?.code === 'string' && /^TOSS_[A-Z0-9_]{1,64}$/.test(d.code) ? d.code : 'TOSS_RUNTIME_UNAVAILABLE',
    phase: typeof d?.phase === 'string' && ['member', 'read', 'issue', 'sso_authorize', 'sso_callback'].includes(d.phase)
      ? d!.phase as TossFailureDiagnostics['phase'] : null,
    httpStatus: Number.isInteger(d?.httpStatus) && Number(d?.httpStatus) >= 100 && Number(d?.httpStatus) <= 599 ? Number(d?.httpStatus) : null,
    contentTypeFamily: typeof d?.contentTypeFamily === 'string' && CONTENT_TYPES.includes(d.contentTypeFamily) ? d.contentTypeFamily : null,
    tossErrorCode: sanitizeTossServiceCode(d?.tossErrorCode),
  };
}
function sanitizeTossServiceCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z0-9_.-]{1,48}$/.test(value) ? value : null;
}
function contentTypeFamily(value: string | null): string | null {
  if (!value) return null;
  const media = value.split(';', 1)[0].trim().toLowerCase();
  if (/^application\/[a-z0-9.+-]{1,48}\+json$/.test(media)) return 'application/*+json';
  return CONTENT_TYPES.includes(media) ? media : 'other';
}
export { contentTypeFamily as tossContentTypeFamily };
export function tossAuthServiceCode(code: string | null): 'TOSS_REAUTH_REQUIRED' | 'TOSS_TWO_FACTOR_REQUIRED' | null {
  if (code === 'AUTH_EXPIRED') return 'TOSS_REAUTH_REQUIRED';
  return code !== null && ['TWO_FACTOR_REQUIRED', 'TWO_FACTOR_AUTH_REQUIRED', 'OTP_REQUIRED'].includes(code)
    ? 'TOSS_TWO_FACTOR_REQUIRED' : null;
}
function loginRedirect(location: string | null): boolean {
  if (!location) return false;
  try { return /(?:^|\/)(?:login|signin|sign-in|auth|authenticate|oauth2?)(?:\/|$)/i.test(new URL(location, TOSS_ORIGIN).pathname); }
  catch { return false; }
}
export class TossSessionError extends Error {
  readonly code: string;
  readonly diagnostics: Readonly<TossFailureDiagnostics>;
  constructor(code: string, details: Partial<Omit<TossFailureDiagnostics, 'code'>> = {}) {
    const diagnostics = projectTossFailureDiagnostics({ ...details, code });
    super(diagnostics.code); this.code = diagnostics.code; this.diagnostics = Object.freeze(diagnostics);
  }
}
export const tossErrorCode = (error: unknown): string => error instanceof TossSessionError
  ? error.code : 'TOSS_RUNTIME_UNAVAILABLE';
export const tossFailureDiagnostics = (error: unknown): TossFailureDiagnostics =>
  projectTossFailureDiagnostics(error instanceof TossSessionError ? error.diagnostics : null);
/** A provider challenge does not prove that the same cookies expired in every execution context. */
export const tossNeedsSecondFactor = (error: unknown): boolean => error instanceof TossSessionError
  && (error.code === 'TOSS_TWO_FACTOR_REQUIRED' || tossAuthServiceCode(error.diagnostics.tossErrorCode) === 'TOSS_TWO_FACTOR_REQUIRED');
export function warnTossFailure(error: unknown): TossFailureDiagnostics {
  const diagnostics = tossFailureDiagnostics(error);
  console.warn('Toss request failed', diagnostics);
  return diagnostics;
}
export const tossHoldsSession = (code: string): boolean =>
  ['TOSS_RESPONSE_NOT_JSON', 'TOSS_RESPONSE_PARSE_FAILED', 'TOSS_SERVICE_REJECTED', 'TOSS_HTTP_FAILED', 'TOSS_ACCESS_DENIED', 'TOSS_SSO_REDIRECT_REJECTED'].includes(code);
export const tossStopsSession = (code: string): boolean =>
  tossHoldsSession(code) || ['TOSS_REAUTH_REQUIRED', 'TOSS_TWO_FACTOR_REQUIRED', 'TOSS_OWNER_MISMATCH', 'TOSS_COOKIE_REVOKED', 'TOSS_COOKIE_SCOPE_REJECTED', 'TOSS_STATE_INVALID', 'TOSS_THROTTLED'].includes(code);
export interface TossCookie {
  name: string; value: string; domain: string; path: '/'; secure: true; httpOnly: true;
  expires?: number; hostOnly?: boolean; sameSite?: string;
}
export interface TossSessionBundle {
  version: 1; service: 'toss-sharelink'; allowedOrigin: typeof TOSS_ORIGIN; capturedAt?: string;
  cookies: TossCookie[]; expectedOwner: { publisherId: string | number; userNo?: string | number; bizUserNo?: string | number };
  readRequests: Record<string, { method: 'GET'; url: string }>;
}
export interface TossSessionState {
  version: 1; provider: 'toss_sharelink'; ownerEmail: string; bundle: TossSessionBundle;
}
const COOKIE_NAMES: readonly string[] = TOSS_COOKIE_NAMES;
const COOKIE_DOMAINS: readonly string[] = TOSS_COOKIE_HOSTS.flatMap(host => [host, '.' + host]);
export function allowedTossUrl(value: string): URL {
  let u: URL;
  if (typeof value !== 'string' || value.length > 65536) throw new TossSessionError('TOSS_REQUEST_SCOPE_REJECTED');
  try { u = new URL(value); } catch { throw new TossSessionError('TOSS_REQUEST_SCOPE_REJECTED'); }
  if (u.origin !== TOSS_ORIGIN || u.username || u.password || u.hash
    || !(/^\/api-public\/v3\/shopping-growth\/sharelink\//.test(u.pathname)
      || /^\/api-public\/v3\/shopping\/sharelink\//.test(u.pathname))) {
    throw new TossSessionError('TOSS_REQUEST_SCOPE_REJECTED');
  }
  return u;
}
export function tossOwnerMatches(actual: unknown, expected: TossSessionBundle['expectedOwner']): boolean {
  const owner = record(actual);
  if (!owner || !expected?.publisherId || !Object.hasOwn(owner, 'publisherId')
    || String(owner.publisherId) !== String(expected.publisherId)) return false;
  return ['userNo', 'bizUserNo'].every(key => !Object.hasOwn(expected, key)
    || String(owner[key]) === String(expected[key as keyof typeof expected]));
}
export function validateTossBundle(value: unknown, now = Date.now(), requireLive = true): TossSessionBundle {
  const b = record(value), owner = record(b?.expectedOwner), requests = record(b?.readRequests);
  if (!b || Object.keys(b).some(k => !['version', 'service', 'allowedOrigin', 'capturedAt', 'cookies', 'expectedOwner', 'readRequests'].includes(k))
    || b.version !== 1 || b.service !== 'toss-sharelink' || b.allowedOrigin !== TOSS_ORIGIN
    // The PC re-login (2026-10-12) saved capturedAt as epoch ms; accept that and normalize to ISO below.
    || (b.capturedAt !== undefined && !(typeof b.capturedAt === 'string' ? Number.isFinite(Date.parse(b.capturedAt))
      : Number.isSafeInteger(b.capturedAt) && (b.capturedAt as number) > 0))
    || !owner || !tossId(owner.publisherId) || Object.keys(owner).some(k => !['publisherId', 'userNo', 'bizUserNo'].includes(k))
    || ['userNo', 'bizUserNo'].some(k => owner[k] !== undefined && !tossId(owner[k]))
    || !requests || !record(requests.member) || Object.keys(requests).length > 32
    || !Array.isArray(b.cookies) || b.cookies.length < 1 || b.cookies.length > TOSS_COOKIE_LIMIT) throw new TossSessionError('TOSS_STATE_INVALID');
  const names = new Set<string>();
  for (const entry of b.cookies) {
    const c = record(entry);
    if (!c || Object.keys(c).some(k => !['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'expires', 'hostOnly', 'sameSite'].includes(k))
      || typeof c.name !== 'string' || !COOKIE_NAMES.includes(c.name)
      || typeof c.domain !== 'string' || !COOKIE_DOMAINS.includes(c.domain) || c.path !== '/'
      || c.secure !== true || c.httpOnly !== true || typeof c.value !== 'string' || !c.value
      || c.value.length > 16384 || /[;\r\n\0]/.test(c.value)
      || (c.hostOnly !== undefined && typeof c.hostOnly !== 'boolean')
      || (c.sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(String(c.sameSite)))
      || (c.expires !== undefined && (typeof c.expires !== 'number' || !Number.isFinite(c.expires)))) {
      throw new TossSessionError('TOSS_COOKIE_SCOPE_REJECTED');
    }
    const key = tossCookieKey(c as unknown as TossCookie);
    if (names.has(key)) throw new TossSessionError('TOSS_COOKIE_SCOPE_REJECTED');
    names.add(key);
  }
  for (const [name, raw] of Object.entries(requests)) {
    const r = record(raw);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !r || Object.keys(r).some(k => !['method', 'url'].includes(k))
      || r.method !== 'GET' || typeof r.url !== 'string') throw new TossSessionError('TOSS_OPERATION_REJECTED');
    allowedTossUrl(r.url);
  }
  const member = requests.member as { url: string };
  if (allowedTossUrl(member.url).pathname !== TOSS_MEMBER_PATH || allowedTossUrl(member.url).search) throw new TossSessionError('TOSS_OWNER_REQUEST_INVALID');
  const home = requests['shopping-curation-sections'] as { url?: string } | undefined;
  if (home && (!home.url || allowedTossUrl(home.url).pathname !== TOSS_HOME_PATH
    || [...allowedTossUrl(home.url).searchParams.keys()].some(k => !['surface', 'size'].includes(k)))) {
    throw new TossSessionError('TOSS_OPERATION_REJECTED');
  }
  if (requireLive && !b.cookies.some(c => liveCookie(c, now))) throw new TossSessionError('TOSS_REAUTH_REQUIRED');
  if (typeof b.capturedAt === 'number') return { ...(value as TossSessionBundle), capturedAt: new Date(b.capturedAt).toISOString() };
  return value as TossSessionBundle;
}
export function liveCookie(c: TossCookie, now: number): boolean {
  return c.expires === undefined || c.expires === -1 || c.expires * 1000 > now;
}
export function tossId(value: unknown): string | null {
  const n = Number(value);
  return (typeof value === 'string' || typeof value === 'number') && /^[1-9][0-9]*$/.test(String(value))
    && Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}
export function tossSectionUrl(section: TossSection, tab: string | null = null, cursor: string | null = null): string {
  if (!TOSS_SECTIONS.includes(section) || (tab !== null && (section !== 'CATEGORY_BEST' || !/^\d{1,24}$/.test(tab)))
    || (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 8192 || /[\r\n]/.test(cursor)))) {
    throw new TossSessionError('TOSS_INPUT_INVALID');
  }
  const u = new URL(`${TOSS_ORIGIN}/api-public/v3/shopping/sharelink/curation-sections/${section}/items`);
  u.searchParams.set('size', '20');
  if (tab !== null) u.searchParams.set('tabCode', tab);
  if (cursor !== null) u.searchParams.set('nextCursor', cursor);
  return u.href;
}
export function tossShareUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const u = new URL(value);
    return u.origin === 'https://toss.shopping' && !u.username && !u.password && !u.hash
      && !u.search && /^\/_m\/[A-Za-z0-9_-]{1,128}$/.test(u.pathname) ? u.href : null;
  } catch { return null; }
}
export interface TossTransportOptions {
  fetchImpl?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>;
  delayMs?: number; timeoutMs?: number; maxBytes?: number; maxRequests?: number; deadline?: number;
}
/** Serialized callers only. Redirects are never followed; no ambient browser credentials are used. */
export class TossSessionClient {
  readonly bundle: TossSessionBundle;
  sourceRequests = 0;
  private lastAt = -Infinity;
  private verified = false;
  private readonly jar: ReturnType<typeof restoreTossCookieJar>;
  private readonly options: Required<TossTransportOptions>;
  constructor(bundle: TossSessionBundle, options: TossTransportOptions = {}) {
    this.options = { fetchImpl: tossRuntimeHttpFetch, now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      delayMs: 400, timeoutMs: 8000, maxBytes: 1024 * 1024, maxRequests: 180, deadline: Date.now() + 220_000, ...options };
    const o = this.options;
    if (!Number.isInteger(o.delayMs) || o.delayMs < 400 || o.delayMs > 30_000
      || !Number.isInteger(o.timeoutMs) || o.timeoutMs < 1 || o.timeoutMs > 30_000
      || !Number.isInteger(o.maxBytes) || o.maxBytes < 1 || o.maxBytes > 2 * 1024 * 1024
      || !Number.isInteger(o.maxRequests) || o.maxRequests < 1 || o.maxRequests > 500 || !Number.isFinite(o.deadline)) {
      throw new TossSessionError('TOSS_LIMIT_INVALID');
    }
    this.bundle = validateTossBundle(bundle, o.now());
    try { this.jar = restoreTossCookieJar(this.bundle.cookies, o.now()); }
    catch { throw new TossSessionError('TOSS_COOKIE_SCOPE_REJECTED'); }
  }
  async verifyOwner(): Promise<void> {
    this.verified = false;
    const body = await this.send(this.bundle.readRequests.member.url, 'GET');
    if (!tossOwnerMatches(body.success, this.bundle.expectedOwner)) throw new TossSessionError('TOSS_OWNER_MISMATCH');
    this.verified = true;
  }
  async read(url: string): Promise<Record<string, unknown>> {
    if (!this.verified) throw new TossSessionError('TOSS_OWNER_CHECK_REQUIRED');
    return this.send(url, 'GET');
  }
  /** True when at least `reserveRequests` more requests and `reserveMs` (plus one paced request) fit in the budget. */
  hasCapacity(reserveRequests: number, reserveMs: number): boolean {
    const o = this.options, delay = Math.max(0, this.lastAt + o.delayMs - o.now());
    return this.sourceRequests + reserveRequests < o.maxRequests && o.now() + delay + o.timeoutMs + reserveMs <= o.deadline;
  }
  assertRequestCapacity(): void {
    const o = this.options, delay = Math.max(0, this.lastAt + o.delayMs - o.now());
    if (this.sourceRequests >= o.maxRequests) throw new TossSessionError('TOSS_REQUEST_LIMIT');
    if (o.now() + delay + o.timeoutMs > o.deadline) throw new TossSessionError('TOSS_TIME_LIMIT');
    if (!this.bundle.cookies.some(c => liveCookie(c, o.now()))) throw new TossSessionError('TOSS_REAUTH_REQUIRED');
  }
  async issue(tacaItemId: string): Promise<string> {
    if (!this.verified) throw new TossSessionError('TOSS_OWNER_CHECK_REQUIRED');
    if (!tossId(tacaItemId)) throw new TossSessionError('TOSS_INPUT_INVALID');
    const data = await this.send(TOSS_ORIGIN + TOSS_ISSUE_PATH, 'POST', JSON.stringify({ tacaItemId: Number(tacaItemId) }));
    const url = tossShareUrl(record(data.success)?.shortUrl ?? data.shortUrl);
    if (!url) throw new TossSessionError('TOSS_ISSUE_OUTCOME_UNKNOWN');
    return url;
  }
  private async send(value: string, method: 'GET' | 'POST', body?: string): Promise<Record<string, unknown>> {
    const u = allowedTossUrl(value), o = this.options;
    const phase: NonNullable<TossFailureDiagnostics['phase']> = method === 'POST' ? 'issue' : u.pathname === TOSS_MEMBER_PATH ? 'member' : 'read';
    if (method === 'POST' && (u.pathname !== TOSS_ISSUE_PATH || u.search || !body || Buffer.byteLength(body) > 128)) {
      throw new TossSessionError('TOSS_REQUEST_SCOPE_REJECTED');
    }
    this.assertRequestCapacity();
    const delay = Math.max(0, this.lastAt + o.delayMs - o.now());
    if (delay) await o.sleep(delay);
    const cookie = tossCookieHeader(this.jar, u.href, o.now());
    if (!cookie) { this.verified = false; throw new TossSessionError('TOSS_REAUTH_REQUIRED'); }
    this.lastAt = o.now(); this.sourceRequests++;
    let response: Awaited<ReturnType<typeof fetchCollectorResponse>>;
    try {
      response = await fetchCollectorResponse(o.fetchImpl, u.href, { method, redirect: 'manual', cache: 'no-store', body,
        headers: { Accept: 'application/json', Cookie: cookie,
          ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: TOSS_ORIGIN, Referer: TOSS_ORIGIN + '/home' } : {}) },
      }, { timeoutMs: o.timeoutMs, maxBytes: o.maxBytes, readErrorBody: true });
    } catch {
      this.verified = false;
      const error = new TossSessionError(method === 'POST' ? 'TOSS_ISSUE_OUTCOME_UNKNOWN' : 'TOSS_HTTP_FAILED', { phase });
      warnTossFailure(error); throw error;
    }
    const details = { phase, httpStatus: response.status, contentTypeFamily: contentTypeFamily(response.headers.get('content-type')) };
    try {
      let cookieFailure: TossCookieJarError | null = null;
      try { applyTossResponseCookies(this.jar, response.headers, u.href, o.now()); }
      catch (error) { if (!(error instanceof TossCookieJarError)) throw error; cookieFailure = error; }
      if (cookieFailure?.code === 'TOSS_COOKIE_SCOPE_REJECTED') throw new TossSessionError(cookieFailure.code, details);
      this.bundle.cookies = exportTossCookieJar(this.jar, o.now());
      if ([301, 302, 303, 307, 308].includes(response.status)
        && loginRedirect(response.headers.get('location'))) throw new TossSessionError('TOSS_REAUTH_REQUIRED', details);
      if (response.status === 429) throw new TossSessionError('TOSS_THROTTLED', details);
      if (response.status === 401 || response.status === 403) {
        let provider: string | null = null;
        try { const rejected = record(JSON.parse(new TextDecoder().decode(response.body)));
          provider = sanitizeTossServiceCode(record(rejected?.error)?.errorCode); } catch { /* Unknown forbidden responses remain permission failures. */ }
        throw new TossSessionError(tossAuthServiceCode(provider)
          ?? (response.status === 401 ? 'TOSS_REAUTH_REQUIRED' : 'TOSS_ACCESS_DENIED'), { ...details, tossErrorCode: provider });
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        throw new TossSessionError(method === 'POST' ? 'TOSS_ISSUE_OUTCOME_UNKNOWN' : 'TOSS_HTTP_FAILED', details);
      }
      // fetchCollectorResponse cancels non-2xx bodies; do not label that empty buffer a parse failure.
      if (!response.ok) throw new TossSessionError(method === 'POST' ? 'TOSS_ISSUE_OUTCOME_UNKNOWN' : 'TOSS_HTTP_FAILED', details);
      if (!['application/json', 'application/*+json'].includes(details.contentTypeFamily ?? '')) {
        throw new TossSessionError(method === 'POST' ? 'TOSS_ISSUE_OUTCOME_UNKNOWN' : 'TOSS_RESPONSE_NOT_JSON', details);
      }
      let data: Record<string, unknown> | null;
      try { data = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body))); }
      catch { throw new TossSessionError(method === 'POST' ? 'TOSS_ISSUE_OUTCOME_UNKNOWN' : 'TOSS_RESPONSE_PARSE_FAILED', details); }
      if (data?.resultType !== 'SUCCESS') {
        const providerError = record(data?.error);
        const tossErrorCode = sanitizeTossServiceCode(providerError?.errorCode) ?? sanitizeTossServiceCode(providerError?.reason);
        const authCode = tossAuthServiceCode(tossErrorCode);
        if (authCode) throw new TossSessionError(authCode, { ...details, tossErrorCode });
        throw new TossSessionError(method === 'POST' ? 'TOSS_ISSUE_REJECTED' : 'TOSS_SERVICE_REJECTED', { ...details, tossErrorCode });
      }
      if (cookieFailure) throw new TossSessionError(cookieFailure.code, details);
      return data;
    } catch (error) { if (error instanceof TossSessionError && tossStopsSession(error.code)) this.verified = false;
      warnTossFailure(error); throw error; }
    finally { response.body.fill(0); }
  }
}

export interface TossLinkRecord { state: 'intent' | 'issued' | 'needs_reconciliation' | 'rejected'; shortUrl: string | null; created: boolean }
export interface TossLinkJournal {
  reserve(id: string): Promise<TossLinkRecord>;
  finish(id: string, state: TossLinkRecord['state'], shortUrl: string | null): Promise<void>;
}
/** Persist intent BEFORE sending. Any existing nonterminal intent may only be reconciled, never resent. */
export async function issueTossLinkOnce(client: TossSessionClient, journal: TossLinkJournal, id: string): Promise<string> {
  if (!tossId(id)) throw new TossSessionError('TOSS_INPUT_INVALID');
  const entry = await journal.reserve(id);
  if (entry.state === 'issued' && tossShareUrl(entry.shortUrl)) return entry.shortUrl!;
  if (!entry.created || entry.state !== 'intent') throw new TossSessionError('TOSS_ISSUE_RECONCILE_REQUIRED');
  let url: string;
  try { url = await client.issue(id); }
  catch (error) {
    await journal.finish(id, tossErrorCode(error) === 'TOSS_ISSUE_REJECTED' ? 'rejected' : 'needs_reconciliation', null);
    throw error;
  }
  // If this write fails, durable intent prevents a duplicate POST after a crash.
  await journal.finish(id, 'issued', url);
  return url;
}
