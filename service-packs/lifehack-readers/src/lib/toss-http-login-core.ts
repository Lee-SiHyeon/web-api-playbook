import { CookieJar, type Cookie } from 'tough-cookie';
import { applyTossResponseCookies, exportTossCookieJar, TossCookieJarError } from './toss-cookie-jar';

/** Server-side pure HTTP login for the consumer Toss Sharelink account. */
export const TOSS_HTTP_LOGIN_ORIGIN = 'https://sharelink.toss.im';
export const TOSS_HTTP_MEMBER_PATH = '/api-public/v3/shopping-growth/sharelink/member';
export const TOSS_HTTP_CURATION_URL = TOSS_HTTP_LOGIN_ORIGIN
  + '/api-public/v3/shopping/sharelink/curation-sections?surface=HOME&size=20';
const BUSINESS_ORIGIN = 'https://business.toss.im';
const BUSINESS_ACCOUNTS_ORIGIN = 'https://business-accounts.toss.im';
const OAUTH_RECEIVER_ORIGIN = 'https://oauth2.cert.toss.im';
const OAUTH_RECEIVER_PATH = '/oauth2/authorize';
const OAUTH_LOGIN_PATH = '/login';
const TOSS_PUBLIC_API_ORIGIN = 'https://api-public.toss.im';
const TOSS_APPROVAL_STATUS_PATH = '/api/v3/oauth2/login/status';
const TOSS_APPROVAL_RECEIVER_ORIGIN = BUSINESS_ORIGIN;
const SIGN_IN_PATH = '/v1/sign-in';
const SIGN_IN_PAGE_PATH = '/account/sign-in';
const CALLBACK_PATH = '/signup-start';
const ALLOWED_ORIGINS = new Set([BUSINESS_ORIGIN, BUSINESS_ACCOUNTS_ORIGIN,
  OAUTH_RECEIVER_ORIGIN, TOSS_HTTP_LOGIN_ORIGIN]);
const OAUTH_QUERY_KEYS = new Set(['grant_type', 'client_id', 'scope', 'response_type',
  'redirect_uri', 'custom_origin', 'token']);
const SESSION_COOKIE_NAMES = new Set(['TGSID', 'TBIZAUTH', 'TAUTH']);
const MEMBER_URL = TOSS_HTTP_LOGIN_ORIGIN + TOSS_HTTP_MEMBER_PATH;
const MAX_REDIRECTS = 8;
const MAX_BODY_BYTES = 1024 * 1024;
const HANDLE_TOKEN: unique symbol = Symbol('toss-http-login-handle');

export interface TossExpectedOwner {
  publisherId: string | number;
  userNo?: string | number;
  bizUserNo?: string | number;
}

/** Values in this binding must come from a current owner-authorized HTTP observation.
 * The authorization URL itself is never surfaced in results or diagnostics.
 */
export interface TossOAuthReceiverBinding {
  clientId: string;
  redirectUri: string;
  queryNames: readonly string[];
}

export interface TossHttpLoginOptions {
  email: string;
  password: string;
  expectedOwner?: unknown;
  oauthReceiverBinding?: TossOAuthReceiverBinding;
  /** Match the business login page's cross-domain browser-session initialization. */
  includeBrowserSessionCookie?: boolean;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}

export type TossHttpLoginPhase = 'signin_page' | 'browser_session' | 'signin' | 'oauth' | 'sharelink'
  | 'member_first' | 'member_second' | 'approval_status' | 'completion';
export type TossHttpLoginAction = 'two_factor' | 'consent' | 'password_change'
  | 'account_locked' | 'account_conversion' | 'user_action' | 'oauth_binding';

export interface TossHttpLoginStep {
  phase: TossHttpLoginPhase;
  httpStatus: number;
}

export interface TossHttpLoginErrorMetadata {
  code: string;
  phase: TossHttpLoginPhase | null;
  httpStatus: number | null;
  loginPostSent: boolean;
  completionPostSent?: boolean;
  providerResponse?: 'http_error_redirect' | 'json_error_redirect' | 'provider_failure' | 'non_success_http';
  redirectReceiver?: 'business_pending' | 'business_done' | 'auth_error' | 'auth_login' | 'oauth_authorize' | 'unknown';
  callbackCodePresent?: boolean;
  callbackSessionMatches?: boolean;
  redirectCount: number;
}

export class TossHttpLoginError extends Error {
  readonly metadata: Readonly<TossHttpLoginErrorMetadata>;

  constructor(metadata: TossHttpLoginErrorMetadata) {
    super(metadata.code);
    this.name = 'TossHttpLoginError';
    this.metadata = Object.freeze({ ...metadata });
  }

  toJSON(): TossHttpLoginErrorMetadata {
    return { ...this.metadata };
  }
}

interface InternalResponse {
  requestUrl: URL;
  status: number;
  contentType: string | null;
  location: string | null;
  text: string;
}

function phaseForUrl(url: URL): TossHttpLoginPhase {
  if (url.origin === OAUTH_RECEIVER_ORIGIN) return 'oauth';
  if (url.origin === TOSS_HTTP_LOGIN_ORIGIN) return 'sharelink';
  return 'signin';
}

interface MemberIdentity {
  publisherId: string;
  userNo: string | null;
  bizUserNo: string | null;
}

export interface TossPendingContext {
  cookieJar: CookieJar;
  continuationUrl: URL | null;
  expiresAt: number;
  steps: TossHttpLoginStep[];
  expectedOwner: TossExpectedOwner | null;
  oauthReceiverBinding: TossOAuthReceiverBinding | null;
}

/** Opaque, intentionally non-serializable holder for an interrupted login. */
export class TossHttpLoginPendingHandle {
  #cookieJar: CookieJar;
  #continuationUrl: URL | null;
  #expiresAt: number;
  #steps: TossHttpLoginStep[];
  #expectedOwner: TossExpectedOwner | null;
  #oauthReceiverBinding: TossOAuthReceiverBinding | null;
  #used = false;

  constructor(token: typeof HANDLE_TOKEN, cookieJar: CookieJar, continuationUrl: URL | null, expiresAt: number,
    steps: TossHttpLoginStep[] = [], expectedOwner: TossExpectedOwner | null = null,
    oauthReceiverBinding: TossOAuthReceiverBinding | null = null) {
    if (token !== HANDLE_TOKEN) throw new Error('TOSS_LOGIN_HANDLE_CONSTRUCTION_REJECTED');
    this.#cookieJar = cookieJar;
    this.#continuationUrl = continuationUrl ? new URL(continuationUrl.href) : null;
    this.#expiresAt = expiresAt;
    this.#steps = [...steps];
    this.#expectedOwner = expectedOwner ? Object.freeze({ ...expectedOwner }) : null;
    this.#oauthReceiverBinding = oauthReceiverBinding;
    Object.freeze(this);
  }

  toJSON(): { kind: 'toss_login_pending'; expiresAt: number } {
    return { kind: 'toss_login_pending', expiresAt: this.#expiresAt };
  }

  async inspectContext<T>(callback: (context: TossPendingContext) => Promise<T> | T, now = Date.now()): Promise<T> {
    if (this.#used || now >= this.#expiresAt) throw new TossHttpLoginError({
      code: this.#used ? 'TOSS_LOGIN_PENDING_ALREADY_CONSUMED' : 'TOSS_LOGIN_PENDING_EXPIRED',
      phase: null, httpStatus: null, loginPostSent: true, redirectCount: 0,
    });
    return callback({ cookieJar: this.#cookieJar,
      continuationUrl: this.#continuationUrl ? new URL(this.#continuationUrl.href) : null,
      expiresAt: this.#expiresAt, steps: [...this.#steps],
      expectedOwner: this.#expectedOwner ? { ...this.#expectedOwner } : null,
      oauthReceiverBinding: this.#oauthReceiverBinding });
  }

  async withContext<T>(callback: (context: TossPendingContext) => Promise<T> | T, now = Date.now()): Promise<T> {
    if (this.#used || now >= this.#expiresAt) throw new TossHttpLoginError({
      code: this.#used ? 'TOSS_LOGIN_PENDING_ALREADY_CONSUMED' : 'TOSS_LOGIN_PENDING_EXPIRED',
      phase: null, httpStatus: null, loginPostSent: true, redirectCount: 0,
    });
    this.#used = true;
    return callback({ cookieJar: this.#cookieJar,
      continuationUrl: this.#continuationUrl ? new URL(this.#continuationUrl.href) : null,
      expiresAt: this.#expiresAt, steps: [...this.#steps],
      expectedOwner: this.#expectedOwner ? { ...this.#expectedOwner } : null,
      oauthReceiverBinding: this.#oauthReceiverBinding });
  }
}

export interface TossHttpSessionCookie {
  name: string;
  value: string;
  domain: string;
  path: '/';
  secure: true;
  httpOnly: true;
  expires: number;
  hostOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface TossHttpSessionBundle {
  version: 1;
  service: 'toss-sharelink';
  allowedOrigin: typeof TOSS_HTTP_LOGIN_ORIGIN;
  capturedAt: string;
  cookies: TossHttpSessionCookie[];
  expectedOwner: TossExpectedOwner;
  readRequests: {
    member: { method: 'GET'; url: string };
    'shopping-curation-sections': { method: 'GET'; url: string };
  };
}

/** Opaque server-only holder. Cookie values are available only inside a callback. */
export class TossHttpAuthenticatedSessionHandle {
  #cookieJar: CookieJar;
  #expectedOwner: TossExpectedOwner | null;
  #ownerVerified: boolean;
  #capturedAt: string;
  #bundleExported = false;

  constructor(token: typeof HANDLE_TOKEN, cookieJar: CookieJar, expectedOwner: TossExpectedOwner | null,
    ownerVerified: boolean, capturedAt: string) {
    if (token !== HANDLE_TOKEN) throw new Error('TOSS_LOGIN_HANDLE_CONSTRUCTION_REJECTED');
    this.#cookieJar = cookieJar;
    this.#expectedOwner = expectedOwner ? Object.freeze({ ...expectedOwner }) : null;
    this.#ownerVerified = ownerVerified;
    this.#capturedAt = capturedAt;
    Object.freeze(this);
  }

  toJSON(): { kind: 'toss_authenticated_session'; ownerVerified: boolean; needsOwnerBinding: boolean } {
    return { kind: 'toss_authenticated_session', ownerVerified: this.#ownerVerified,
      needsOwnerBinding: !this.#ownerVerified };
  }

  async withVerifiedBundle<T>(callback: (bundle: TossHttpSessionBundle) => Promise<T> | T): Promise<T> {
    if (!this.#ownerVerified || !this.#expectedOwner) throw new TossHttpLoginError({
      code: 'TOSS_LOGIN_OWNER_BINDING_REQUIRED', phase: null, httpStatus: null,
      loginPostSent: true, redirectCount: 0,
    });
    if (this.#bundleExported) throw new TossHttpLoginError({
      code: 'TOSS_LOGIN_SESSION_ALREADY_EXPORTED', phase: null, httpStatus: null,
      loginPostSent: true, redirectCount: 0,
    });
    const cookies = exportSessionCookies(this.#cookieJar);
    if (!cookies.length) throw new TossHttpLoginError({
      code: 'TOSS_LOGIN_SESSION_COOKIE_MISSING', phase: null, httpStatus: null,
      loginPostSent: true, redirectCount: 0,
    });
    this.#bundleExported = true;
    const bundle: TossHttpSessionBundle = {
      version: 1,
      service: 'toss-sharelink',
      allowedOrigin: TOSS_HTTP_LOGIN_ORIGIN,
      capturedAt: this.#capturedAt,
      cookies,
      expectedOwner: { ...this.#expectedOwner },
      readRequests: {
        member: { method: 'GET', url: MEMBER_URL },
        'shopping-curation-sections': { method: 'GET', url: TOSS_HTTP_CURATION_URL },
      },
    };
    return callback(bundle);
  }
}

export interface TossHttpLoginAuthenticatedResult {
  status: 'authenticated';
  authenticated: true;
  ownerVerified: boolean;
  needsOwnerBinding: boolean;
  memberReadCount: 2;
  loginPostCount: 1;
  steps: TossHttpLoginStep[];
  session: TossHttpAuthenticatedSessionHandle;
}

export interface TossHttpLoginActionRequiredResult {
  status: 'action_required';
  authenticated: false;
  ownerVerified: false;
  needsOwnerBinding: true;
  code: string;
  action: TossHttpLoginAction;
  phase: TossHttpLoginPhase;
  httpStatus: number;
  loginPostCount: 1;
  redirectCount: number;
  steps: TossHttpLoginStep[];
  pending: TossHttpLoginPendingHandle;
}

export type TossHttpLoginResult = TossHttpLoginAuthenticatedResult | TossHttpLoginActionRequiredResult;

/** Private root-supplied descriptor for the observed Toss app approval receiver. */
export interface TossApprovalReceiverBinding {
  receiverOrigin: string;
  receiverPath: string;
  receiverQueryNames: readonly string[];
  tokenQueryName: 'token';
}

export interface TossApprovalCompletionOptions {
  binding: TossApprovalReceiverBinding;
  authorizationBinding?: TossOAuthReceiverBinding;
  expectedOwner?: unknown;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
  beforeCompletion?: () => Promise<void>;
  completionEncoding?: 'urlencoded' | 'multipart';
  authorizationWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onCompletionResponse?: (context: TossPendingContext, observation: {
    completionResponseHttpStatus: number;
    completionCookieNames: Array<'TAUTH' | 'TBIZAUTH' | 'TGSID'>;
    completionResponseShape: 'redirect' | 'wrapped_redirect' | 'failure' | 'other';
  }) => Promise<void>;
}

export interface TossHttpApprovalPendingResult {
  status: 'approval_pending';
  authenticated: false;
  ownerVerified: false;
  needsOwnerBinding: true;
  code: 'TOSS_LOGIN_APPROVAL_PENDING';
  approvalStatus: string;
  completionPostCount: 0;
  steps: TossHttpLoginStep[];
  pending: TossHttpLoginPendingHandle;
}

export interface TossHttpCompletedLoginResult {
  status: 'authenticated';
  authenticated: true;
  ownerVerified: boolean;
  needsOwnerBinding: boolean;
  loginPostCount: 1;
  completionPostCount: 1;
  reconciled?: boolean;
  memberReadCount: 2;
  steps: TossHttpLoginStep[];
  session: TossHttpAuthenticatedSessionHandle;
}

export type TossHttpApprovalCompletionResult = TossHttpApprovalPendingResult | TossHttpCompletedLoginResult;

export interface TossHttpApprovalState {
  approvalHttpStatus: number;
  providerApprovalStatus: 'REQUESTED' | 'PENDING' | 'AGREED' | 'COMPLETED' | 'REJECTED' | 'EXPIRED' | 'CANCELED' | 'UNKNOWN';
  canLogin: boolean | null;
  pendingSessionHttpStatus: number;
  pendingSessionValid: boolean;
  pendingSessionType: 'MULTI_FACTOR' | 'UNKNOWN';
}

function safeTossId(value: unknown): string | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9][0-9]*$/.test(String(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(value) : null;
}

export function validateExpectedOwner(value: unknown): TossExpectedOwner | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TossHttpLoginError({
    code: 'TOSS_LOGIN_OWNER_BASELINE_INVALID', phase: null, httpStatus: null,
    loginPostSent: false, redirectCount: 0,
  });
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => !['publisherId', 'userNo', 'bizUserNo'].includes(key))) throw new TossHttpLoginError({
    code: 'TOSS_LOGIN_OWNER_BASELINE_INVALID', phase: null, httpStatus: null,
    loginPostSent: false, redirectCount: 0,
  });
  const publisherId = safeTossId(source.publisherId);
  if (!publisherId) throw new TossHttpLoginError({ code: 'TOSS_LOGIN_OWNER_BASELINE_INVALID',
    phase: null, httpStatus: null, loginPostSent: false, redirectCount: 0 });
  const result: TossExpectedOwner = { publisherId };
  for (const key of ['userNo', 'bizUserNo'] as const) {
    if (Object.hasOwn(source, key)) {
      const id = safeTossId(source[key]);
      if (!id) throw new TossHttpLoginError({ code: 'TOSS_LOGIN_OWNER_BASELINE_INVALID',
        phase: null, httpStatus: null, loginPostSent: false, redirectCount: 0 });
      result[key] = id;
    }
  }
  return result;
}

function validateOAuthReceiverBinding(binding: TossOAuthReceiverBinding | undefined): TossOAuthReceiverBinding | null {
  if (!binding) return null;
  if (typeof binding !== 'object' || typeof binding.clientId !== 'string' || !binding.clientId.trim()
    || binding.clientId.length > 256 || /[\r\n\0]/.test(binding.clientId)
    || typeof binding.redirectUri !== 'string' || binding.redirectUri.length > 2048
    || /[\r\n\0]/.test(binding.redirectUri) || !Array.isArray(binding.queryNames)) {
    throw new TossHttpLoginError({ code: 'TOSS_LOGIN_OAUTH_BINDING_INVALID', phase: null,
      httpStatus: null, loginPostSent: false, redirectCount: 0 });
  }
  let redirect: URL;
  try { redirect = new URL(binding.redirectUri); } catch {
    throw new TossHttpLoginError({ code: 'TOSS_LOGIN_OAUTH_BINDING_INVALID', phase: null,
      httpStatus: null, loginPostSent: false, redirectCount: 0 });
  }
  const queryNames = [...binding.queryNames];
  if (!ALLOWED_ORIGINS.has(redirect.origin) || redirect.username || redirect.password || redirect.hash
    || queryNames.length > 16 || new Set(queryNames).size !== queryNames.length
    || queryNames.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(name))) {
    throw new TossHttpLoginError({ code: 'TOSS_LOGIN_OAUTH_BINDING_INVALID', phase: null,
      httpStatus: null, loginPostSent: false, redirectCount: 0 });
  }
  return { clientId: binding.clientId, redirectUri: binding.redirectUri, queryNames };
}

function validateApprovalReceiverBinding(binding: TossApprovalReceiverBinding): TossApprovalReceiverBinding {
  if (!binding || binding.receiverOrigin !== TOSS_APPROVAL_RECEIVER_ORIGIN
    || binding.receiverPath !== '/account/two-factor/push-status' || !binding.receiverPath.startsWith('/')
    || binding.receiverPath.startsWith('//') || binding.receiverPath.includes('?')
    || binding.receiverPath.includes('#') || !/(?:^|\/)two-factor(?:\/|$)/i.test(binding.receiverPath)
    || binding.tokenQueryName !== 'token' || !Array.isArray(binding.receiverQueryNames)
    || binding.receiverQueryNames.length < 1 || binding.receiverQueryNames.length > 16) {
    throw metadataError('TOSS_LOGIN_COMPLETION_BINDING_INVALID', 'oauth', null, true, 0);
  }
  const names = [...binding.receiverQueryNames];
  if (new Set(names).size !== names.length || !names.includes(binding.tokenQueryName)
    || names.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(name))) {
    throw metadataError('TOSS_LOGIN_COMPLETION_BINDING_INVALID', 'oauth', null, true, 0);
  }
  return { receiverOrigin: binding.receiverOrigin, receiverPath: binding.receiverPath,
    receiverQueryNames: names, tokenQueryName: 'token' };
}

function metadataError(code: string, phase: TossHttpLoginPhase | null, httpStatus: number | null,
  loginPostSent: boolean, redirectCount: number): TossHttpLoginError {
  return new TossHttpLoginError({ code, phase, httpStatus, loginPostSent, redirectCount });
}

function validateInput(options: TossHttpLoginOptions): { owner: TossExpectedOwner | null; binding: TossOAuthReceiverBinding | null } {
  if (!options || typeof options.email !== 'string' || !options.email.trim()
    || options.email.length > 320 || /[\r\n\0]/.test(options.email)
    || typeof options.password !== 'string' || !options.password || options.password.length > 1024
    || /[\r\n\0]/.test(options.password)) throw metadataError('TOSS_LOGIN_INPUT_INVALID', null, null, false, 0);
  return { owner: validateExpectedOwner(options.expectedOwner),
    binding: validateOAuthReceiverBinding(options.oauthReceiverBinding) };
}

function responseContentType(response: Response): string | null {
  const raw = response.headers.get('content-type');
  if (!raw) return null;
  const media = raw.split(';', 1)[0].trim().toLowerCase();
  return media.slice(0, 80);
}

async function readBoundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelOnAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('BODY_LIMIT');
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('BODY_ENCODING'); }
    finally { bytes.fill(0); }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    signal.removeEventListener('abort', cancelOnAbort);
    reader.releaseLock();
  }
}

function storeResponseCookies(jar: CookieJar, response: Response, url: URL): void {
  const lines = response.headers.getSetCookie?.() ?? [];
  try {
    for (const line of lines) {
      if (!/^(?:TGSID|TBIZAUTH|TAUTH)=/.test(line)) jar.setCookieSync(line, url.href, { ignoreError: false });
    }
    try { applyTossResponseCookies(jar, response.headers, url.href); }
    catch (error) { if (!(error instanceof TossCookieJarError) || error.code !== 'TOSS_COOKIE_REVOKED') throw error; }
  } catch {
    throw new Error('COOKIE_REJECTED');
  }
}

function providerCode(text: string, contentType: string | null): string | null {
  if (!contentType || !/(?:^application\/json$|\+json$)/.test(contentType)) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const error = root.error && typeof root.error === 'object' && !Array.isArray(root.error)
    ? root.error as Record<string, unknown> : null;
  const code = [error?.errorCode, error?.reason, error?.code, root.errorCode, root.reason]
    .find(item => typeof item === 'string');
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : null;
}

function actionForCode(code: string | null): TossHttpLoginAction | null {
  switch (code) {
    case 'TWO_FACTOR_REQUIRED':
    case 'TWO_FACTOR_AUTH_REQUIRED':
    case 'OTP_REQUIRED': return 'two_factor';
    case 'CONSENT_REQUIRED': return 'consent';
    case 'PASSWORD_CHANGE_REQUIRED':
    case 'PASSWORD_EXPIRED': return 'password_change';
    case 'ACCOUNT_LOCKED': return 'account_locked';
    case 'ACCOUNT_CONVERSION_REQUIRED': return 'account_conversion';
    default: return null;
  }
}

function actionForPath(pathname: string): TossHttpLoginAction | null {
  if (/(?:two[-_/]?factor|(?:^|\/)2fa(?:\/|$)|(?:^|\/)otp(?:\/|$))/i.test(pathname)) return 'two_factor';
  if (/(?:consent|terms-accept|terms\/agree)/i.test(pathname)) return 'consent';
  if (/(?:password[-_/]?(?:change|expired|reset)|change[-_/]?password)/i.test(pathname)) return 'password_change';
  if (/(?:account[-_/]?locked|locked[-_/]?account)/i.test(pathname)) return 'account_locked';
  if (/(?:account[-_/]?(?:convert|conversion)|convert[-_/]?account)/i.test(pathname)) return 'account_conversion';
  return null;
}

function actionCode(action: TossHttpLoginAction): string {
  switch (action) {
    case 'two_factor': return 'TOSS_LOGIN_TWO_FACTOR_REQUIRED';
    case 'consent': return 'TOSS_LOGIN_CONSENT_REQUIRED';
    case 'password_change': return 'TOSS_LOGIN_PASSWORD_CHANGE_REQUIRED';
    case 'account_locked': return 'TOSS_LOGIN_ACCOUNT_LOCKED';
    case 'account_conversion': return 'TOSS_LOGIN_ACCOUNT_CONVERSION_REQUIRED';
    case 'oauth_binding': return 'TOSS_LOGIN_OAUTH_RECEIVER_BINDING_REQUIRED';
    default: return 'TOSS_LOGIN_USER_ACTION_REQUIRED';
  }
}

function memberIdentity(text: string, contentType: string | null, status: number): MemberIdentity {
  if (status !== 200 || !contentType || !/(?:^application\/json$|\+json$)/.test(contentType)) {
    throw new Error('MEMBER_RESPONSE_INVALID');
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('MEMBER_RESPONSE_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MEMBER_RESPONSE_INVALID');
  const root = value as Record<string, unknown>;
  if (root.resultType !== 'SUCCESS' || !root.success || typeof root.success !== 'object' || Array.isArray(root.success)) {
    const code = providerCode(text, contentType);
    throw new Error(code && actionForCode(code) === 'two_factor' ? 'TWO_FACTOR_REQUIRED' : 'MEMBER_RESPONSE_INVALID');
  }
  const member = root.success as Record<string, unknown>;
  const publisherId = safeTossId(member.publisherId);
  const userNo = member.userNo === undefined || member.userNo === null ? null : safeTossId(member.userNo);
  const bizUserNo = member.bizUserNo === undefined || member.bizUserNo === null ? null : safeTossId(member.bizUserNo);
  if (!publisherId || (member.userNo !== undefined && member.userNo !== null && !userNo)
    || (member.bizUserNo !== undefined && member.bizUserNo !== null && !bizUserNo)) throw new Error('MEMBER_RESPONSE_INVALID');
  return { publisherId, userNo, bizUserNo };
}

function ownerMatches(member: MemberIdentity, expected: TossExpectedOwner): boolean {
  return member.publisherId === String(expected.publisherId)
    && (!Object.hasOwn(expected, 'userNo') || member.userNo === String(expected.userNo))
    && (!Object.hasOwn(expected, 'bizUserNo') || member.bizUserNo === String(expected.bizUserNo));
}

function repeatedMemberMatches(first: MemberIdentity, second: MemberIdentity): boolean {
  if (first.publisherId !== second.publisherId) return false;
  return (first.userNo === null || second.userNo === null || first.userNo === second.userNo)
    && (first.bizUserNo === null || second.bizUserNo === null || first.bizUserNo === second.bizUserNo);
}

function callbackMatches(binding: TossOAuthReceiverBinding, value: string): boolean {
  return binding.redirectUri === value;
}

function validateOAuthAuthorizeUrl(url: URL, binding: TossOAuthReceiverBinding): boolean {
  if (url.origin !== OAUTH_RECEIVER_ORIGIN || url.pathname !== OAUTH_RECEIVER_PATH
    || url.username || url.password || url.hash || url.href.length > 16384) return false;
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.length !== binding.queryNames.length) return false;
  const expectedNames = [...binding.queryNames].sort();
  const actualNames = [...keys].sort();
  if (actualNames.some((key, index) => key !== expectedNames[index] || !OAUTH_QUERY_KEYS.has(key))) return false;
  return url.searchParams.getAll('client_id').length === 1
    && url.searchParams.get('client_id') === binding.clientId
    && url.searchParams.getAll('redirect_uri').length === 1
    && callbackMatches(binding, url.searchParams.get('redirect_uri') ?? '');
}

function validateRequestUrl(url: URL, binding: TossOAuthReceiverBinding | null, initial = false): boolean {
  if (!ALLOWED_ORIGINS.has(url.origin) || url.username || url.password || url.hash || url.href.length > 16384) return false;
  if (initial) return url.origin === BUSINESS_ORIGIN && url.pathname === SIGN_IN_PAGE_PATH;
  if (url.origin === OAUTH_RECEIVER_ORIGIN) return !!binding && validateOAuthAuthorizeUrl(url, binding);
  if (url.origin === BUSINESS_ACCOUNTS_ORIGIN) return url.pathname === SIGN_IN_PATH;
  if (url.origin === BUSINESS_ORIGIN) return url.pathname === SIGN_IN_PAGE_PATH;
  return url.origin === TOSS_HTTP_LOGIN_ORIGIN
    && (url.pathname === (binding ? new URL(binding.redirectUri).pathname : CALLBACK_PATH)
      || url.pathname === TOSS_HTTP_MEMBER_PATH);
}

function makeActionResult(action: TossHttpLoginAction, phase: TossHttpLoginPhase, status: number,
  nextUrl: URL | null, jar: CookieJar, redirectCount: number, steps: TossHttpLoginStep[], now: () => number,
  expectedOwner: TossExpectedOwner | null, oauthReceiverBinding: TossOAuthReceiverBinding | null = null): TossHttpLoginActionRequiredResult {
  return { status: 'action_required', authenticated: false, ownerVerified: false, needsOwnerBinding: true,
    code: actionCode(action), action, phase, httpStatus: status, loginPostCount: 1, redirectCount,
    steps: [...steps], pending: new TossHttpLoginPendingHandle(HANDLE_TOKEN, jar, nextUrl,
      now() + 15 * 60_000, steps, expectedOwner, oauthReceiverBinding) };
}

function exportSessionCookies(jar: CookieJar): TossHttpSessionCookie[] {
  return exportTossCookieJar(jar) as TossHttpSessionCookie[];
}

interface ApprovalRequestOptions {
  fetchImpl: typeof fetch;
  jar?: CookieJar;
  credentials: RequestCredentials;
  timeoutMs: number;
  deadline: number;
  maxResponseBytes: number;
  steps: TossHttpLoginStep[];
  phase: TossHttpLoginPhase;
  loginPostSent: boolean;
  completionPostSent: boolean;
}

async function sendApprovalRequest(url: URL, method: 'GET' | 'POST', body: BodyInit | undefined,
  headers: Record<string, string>, options: ApprovalRequestOptions): Promise<InternalResponse> {
  if ((!ALLOWED_ORIGINS.has(url.origin) && url.origin !== TOSS_PUBLIC_API_ORIGIN)
    || url.username || url.password || url.hash || url.href.length > 16384) {
    throw metadataError('TOSS_LOGIN_ORIGIN_OR_PATH_REJECTED', options.phase, null, options.loginPostSent, 0);
  }
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) throw new TossHttpLoginError({ code: options.phase === 'completion'
    ? 'TOSS_LOGIN_COMPLETION_OUTCOME_UNKNOWN' : options.phase === 'approval_status'
      ? 'TOSS_LOGIN_APPROVAL_STATUS_UNAVAILABLE' : 'TOSS_LOGIN_COMPLETION_AUTH_NOT_ESTABLISHED',
    phase: options.phase, httpStatus: null, loginPostSent: options.loginPostSent,
    completionPostSent: options.completionPostSent, redirectCount: 0 });
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout: ((error: Error) => void) | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const timeoutHandle = setTimeout(() => { timedOut = true; controller.abort(); rejectTimeout?.(new Error('TIMEOUT')); },
    Math.min(options.timeoutMs, remaining));
  const cookie = options.credentials === 'include' && options.jar
    ? options.jar.getCookieStringSync(url.href) : '';
  const requestHeaders = { ...headers, ...(cookie ? { Cookie: cookie } : {}) };
  let response: Response | null = null;
  try {
    response = await Promise.race([options.fetchImpl(url, { method, ...(body ? { body } : {}),
      headers: requestHeaders, credentials: options.credentials, redirect: 'manual', cache: 'no-store',
      signal: controller.signal }), timeoutPromise]);
    if (options.jar) storeResponseCookies(options.jar, response, url);
    const contentType = responseContentType(response);
    const location = response.headers.get('location');
    const text = await Promise.race([readBoundedText(response, options.maxResponseBytes, controller.signal), timeoutPromise]);
    if (timedOut) throw new Error('TIMEOUT');
    options.steps.push({ phase: options.phase, httpStatus: response.status });
    return { requestUrl: new URL(url.href), status: response.status, contentType, location, text };
  } catch (error) {
    if (response?.body) await response.body.cancel().catch(() => undefined);
    const code = options.phase === 'completion'
      ? 'TOSS_LOGIN_COMPLETION_OUTCOME_UNKNOWN'
      : options.phase === 'approval_status' ? 'TOSS_LOGIN_APPROVAL_STATUS_UNAVAILABLE'
        : 'TOSS_LOGIN_COMPLETION_AUTH_NOT_ESTABLISHED';
    throw new TossHttpLoginError({ code, phase: options.phase,
      httpStatus: response?.status ?? null, loginPostSent: options.loginPostSent,
      completionPostSent: options.completionPostSent || (options.phase === 'completion' && (timedOut || response !== null)),
      redirectCount: 0 });
  } finally { clearTimeout(timeoutHandle); }
}

function approvalTokenFromCandidate(url: URL | null, binding: TossApprovalReceiverBinding): string {
  if (!url || url.origin !== binding.receiverOrigin || url.pathname !== binding.receiverPath
    || url.username || url.password || url.hash || url.href.length > 16384) {
    throw metadataError('TOSS_LOGIN_COMPLETION_RECEIVER_REJECTED', 'oauth', null, true, 0);
  }
  const names = [...url.searchParams.keys()];
  const expected = [...binding.receiverQueryNames].sort();
  if (new Set(names).size !== names.length || names.length !== expected.length
    || names.sort().some((name, index) => name !== expected[index])) {
    throw metadataError('TOSS_LOGIN_COMPLETION_RECEIVER_REJECTED', 'oauth', null, true, 0);
  }
  const values = url.searchParams.getAll(binding.tokenQueryName);
  const token = values.length === 1 ? values[0] : '';
  if (!token || token.length > 8192 || /[\r\n\0]/.test(token)) {
    throw metadataError('TOSS_LOGIN_COMPLETION_RECEIVER_REJECTED', 'oauth', null, true, 0);
  }
  return token;
}

function approvalStatus(text: string, contentType: string | null): string | null {
  if (!contentType || !/(?:^application\/json$|\+json$)/.test(contentType)) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const success = root.success && typeof root.success === 'object' && !Array.isArray(root.success)
    ? root.success as Record<string, unknown> : null;
  return root.resultType === 'SUCCESS' && typeof success?.status === 'string' ? success.status : null;
}

function completionError(code: string, httpStatus: number | null = null,
  providerResponse?: TossHttpLoginErrorMetadata['providerResponse'],
  details: Partial<Pick<TossHttpLoginErrorMetadata, 'redirectReceiver' | 'callbackCodePresent' | 'callbackSessionMatches'>> = {}): TossHttpLoginError {
  return new TossHttpLoginError({ code, phase: 'completion', httpStatus, loginPostSent: true,
    completionPostSent: true, redirectCount: 0, ...(providerResponse ? { providerResponse } : {}), ...details });
}

function completionResponseLocation(text: string, contentType: string | null, httpStatus: number): URL {
  if (!contentType || !/(?:^application\/json$|\+json$)/.test(contentType)) {
    throw completionError('TOSS_LOGIN_COMPLETION_RESPONSE_INVALID');
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    throw completionError('TOSS_LOGIN_COMPLETION_RESPONSE_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw completionError('TOSS_LOGIN_COMPLETION_RESPONSE_INVALID');
  }
  const root = value as Record<string, unknown>;
  if (root.resultType === 'FAIL' || root.resultType === 'ERROR') {
    throw completionError('TOSS_LOGIN_COMPLETION_PROVIDER_REJECTED', httpStatus, 'provider_failure');
  }
  if (typeof root.location !== 'string' || !root.location || root.location.length > 8192) {
    throw completionError('TOSS_LOGIN_COMPLETION_RESPONSE_INVALID');
  }
  let location: URL;
  try { location = new URL(root.location, OAUTH_RECEIVER_ORIGIN); }
  catch { throw completionError('TOSS_LOGIN_COMPLETION_RESPONSE_INVALID'); }
  if (location.username || location.password || location.hash) {
    throw completionError('TOSS_LOGIN_COMPLETION_REDIRECT_REJECTED');
  }
  if (location.pathname === '/error') {
    throw completionError('TOSS_LOGIN_COMPLETION_PROVIDER_REJECTED', httpStatus, 'json_error_redirect');
  }
  return location;
}

/** Read-only provider state for reconciliation. Never dispatches a login or completion mutation. */
export async function inspectTossHttpApprovalState(pending: TossHttpLoginPendingHandle,
  options: Pick<TossApprovalCompletionOptions, 'fetchImpl' | 'requestTimeoutMs' | 'totalTimeoutMs'> = {}
): Promise<TossHttpApprovalState> {
  if (!(pending instanceof TossHttpLoginPendingHandle)) throw metadataError('TOSS_LOGIN_PENDING_REQUIRED', 'oauth', null, true, 0);
  return pending.inspectContext(async context => {
    const token = approvalTokenFromCandidate(context.continuationUrl, {
      receiverOrigin: BUSINESS_ORIGIN, receiverPath: '/account/two-factor/push-status',
      receiverQueryNames: ['session_token', 'token'], tokenQueryName: 'token',
    });
    const sessionToken = context.continuationUrl!.searchParams.get('session_token');
    if (!sessionToken) throw metadataError('TOSS_LOGIN_COMPLETION_BINDING_INVALID', 'oauth', null, true, 0);
    const deadline = Date.now() + (options.totalTimeoutMs ?? 30_000);
    const request = (url: URL, credentials: RequestCredentials) => sendApprovalRequest(url, 'GET', undefined,
      { Accept: 'application/json', 'X-Toss-Locale': 'ko' }, {
        fetchImpl: options.fetchImpl ?? fetch, ...(credentials === 'include' ? { jar: context.cookieJar } : {}),
        credentials, timeoutMs: options.requestTimeoutMs ?? 10_000, deadline, maxResponseBytes: MAX_BODY_BYTES,
        steps: [], phase: 'approval_status', loginPostSent: true, completionPostSent: false,
      });
    const successObject = (response: InternalResponse): Record<string, unknown> | null => {
      if (response.status !== 200 || !response.contentType || !/(?:^application\/json$|\+json$)/.test(response.contentType)) return null;
      try {
        const root: unknown = JSON.parse(response.text);
        if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
        const value = root as Record<string, unknown>;
        return value.resultType === 'SUCCESS' && value.success && typeof value.success === 'object' && !Array.isArray(value.success)
          ? value.success as Record<string, unknown> : null;
      } catch { return null; }
    };
    const statusUrl = new URL(TOSS_PUBLIC_API_ORIGIN + TOSS_APPROVAL_STATUS_PATH);
    statusUrl.searchParams.set('token', token);
    let approval: InternalResponse;
    try { approval = await request(statusUrl, 'omit'); } finally { statusUrl.search = ''; }
    const success = successObject(approval);
    const statuses = ['REQUESTED', 'PENDING', 'AGREED', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELED'];
    const status = typeof success?.status === 'string' && statuses.includes(success.status) ? success.status : 'UNKNOWN';
    const canLogin = typeof success?.canLogin === 'boolean' ? success.canLogin : null;
    approval.text = ''; approval.requestUrl.search = '';
    const metadataUrl = new URL(BUSINESS_ACCOUNTS_ORIGIN + '/account/session/metadata');
    metadataUrl.searchParams.set('sessionToken', sessionToken);
    let metadata: InternalResponse;
    try { metadata = await request(metadataUrl, 'include'); } finally { metadataUrl.search = ''; }
    const session = successObject(metadata);
    metadata.text = ''; metadata.requestUrl.search = '';
    return { approvalHttpStatus: approval.status, providerApprovalStatus: status as TossHttpApprovalState['providerApprovalStatus'],
      canLogin, pendingSessionHttpStatus: metadata.status, pendingSessionValid: metadata.status === 200 && session?.valid === true,
      pendingSessionType: session?.type === 'MULTI_FACTOR' ? 'MULTI_FACTOR' : 'UNKNOWN' };
  });
}

/** Follows the authorization issued by the sign-in response, without starting another sign-in. */
export async function continueTossHttpOAuth(pending: TossHttpLoginPendingHandle,
  options: Pick<TossApprovalCompletionOptions, 'fetchImpl' | 'requestTimeoutMs' | 'totalTimeoutMs' | 'maxResponseBytes' | 'now'> = {}
): Promise<TossHttpLoginPendingHandle> {
  if (!(pending instanceof TossHttpLoginPendingHandle)) throw metadataError('TOSS_LOGIN_PENDING_REQUIRED', 'oauth', null, true, 0);
  return pending.withContext(async context => {
    const url = context.continuationUrl;
    if (!url || url.origin !== OAUTH_RECEIVER_ORIGIN || url.pathname !== OAUTH_RECEIVER_PATH) {
      throw metadataError('TOSS_LOGIN_OAUTH_RECEIVER_REJECTED', 'oauth', null, true, 0);
    }
    const binding = validateOAuthReceiverBinding({ clientId: url.searchParams.get('client_id') ?? '',
      redirectUri: url.searchParams.get('redirect_uri') ?? '', queryNames: [...url.searchParams.keys()] })!;
    const callback = new URL(binding.redirectUri);
    if (!validateOAuthAuthorizeUrl(url, binding) || callback.origin !== BUSINESS_ORIGIN
      || callback.pathname !== '/account/two-factor/sign-in-done' || callback.search) {
      throw metadataError('TOSS_LOGIN_OAUTH_RECEIVER_REJECTED', 'oauth', null, true, 0);
    }
    const steps = [...context.steps];
    const deadline = Date.now() + (options.totalTimeoutMs ?? 45_000);
    const response = await sendApprovalRequest(url, 'GET', undefined, { Accept: 'text/html,application/json', 'X-Toss-Locale': 'ko' }, {
      fetchImpl: options.fetchImpl ?? fetch, jar: context.cookieJar, credentials: 'include',
      timeoutMs: options.requestTimeoutMs ?? 10_000, deadline,
      maxResponseBytes: options.maxResponseBytes ?? MAX_BODY_BYTES, steps, phase: 'oauth', loginPostSent: true, completionPostSent: false,
    });
    if (response.status !== 302 || !response.location) throw metadataError('TOSS_LOGIN_OAUTH_RECEIVER_REJECTED', 'oauth', response.status, true, 0);
    const next = new URL(response.location, url);
    approvalTokenFromCandidate(next, { receiverOrigin: BUSINESS_ORIGIN, receiverPath: '/account/two-factor/push-status',
      receiverQueryNames: ['session_token', 'token'], tokenQueryName: 'token' });
    const receiver = await sendApprovalRequest(next, 'GET', undefined,
      { Accept: 'text/html,application/json', 'X-Toss-Locale': 'ko' }, {
        fetchImpl: options.fetchImpl ?? fetch, jar: context.cookieJar, credentials: 'include',
        timeoutMs: options.requestTimeoutMs ?? 10_000, deadline,
        maxResponseBytes: options.maxResponseBytes ?? MAX_BODY_BYTES, steps, phase: 'oauth', loginPostSent: true,
        completionPostSent: false,
      });
    if (receiver.status !== 200 || !receiver.contentType?.startsWith('text/html')) {
      throw metadataError('TOSS_LOGIN_APPROVAL_RECEIVER_UNAVAILABLE', 'oauth', receiver.status, true, 0);
    }
    receiver.text = '';
    return new TossHttpLoginPendingHandle(HANDLE_TOKEN, context.cookieJar, next, context.expiresAt, steps,
      context.expectedOwner, binding);
  }, (options.now ?? Date.now)());
}

async function finishTossBusinessAccountHttp(context: TossPendingContext, location: URL,
  options: TossApprovalCompletionOptions, steps: TossHttpLoginStep[],
  beforeAccountMutations?: () => Promise<void>, completionDeadline?: number): Promise<TossHttpCompletedLoginResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const deadline = completionDeadline ?? Date.now() + (options.totalTimeoutMs ?? 45_000);
  const maxResponseBytes = options.maxResponseBytes ?? MAX_BODY_BYTES;
  const now = options.now ?? Date.now;
  const owner = options.expectedOwner === undefined ? context.expectedOwner : validateExpectedOwner(options.expectedOwner);
  const sessionToken = context.continuationUrl?.searchParams.get('session_token');
  if (!sessionToken || (owner && context.expectedOwner && !sameExpectedOwner(owner, context.expectedOwner))) throw completionError('TOSS_LOGIN_COMPLETION_BINDING_INVALID');
  const request = async (url: URL, method: 'GET' | 'POST' = 'GET', body?: BodyInit,
    extraHeaders: Record<string, string> = {}) => sendApprovalRequest(url, method, body,
      { Accept: 'application/json, text/html', 'X-Toss-Locale': 'ko', ...extraHeaders }, {
        fetchImpl, jar: context.cookieJar, credentials: 'include', timeoutMs: requestTimeoutMs, deadline,
        maxResponseBytes, steps, phase: 'completion', loginPostSent: true, completionPostSent: true,
      });
  const waitMs = options.authorizationWaitMs ?? 0;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw completionError('TOSS_LOGIN_LIMIT_INVALID');
  const until = Math.min(deadline,Date.now()+waitMs);
  let authorization = await request(location);
  // Only the original bound pending receiver may be read again; no login/account POST is repeated.
  while (waitMs > 0 && authorization.status === 302 && authorization.location && Date.now() < until) {
    const candidate = new URL(authorization.location,location);
    if (candidate.origin !== BUSINESS_ORIGIN || candidate.pathname !== '/account/two-factor/push-status'
      || candidate.username || candidate.password || candidate.hash || candidate.searchParams.has('code')
      || candidate.searchParams.get('session_token') !== sessionToken
      || candidate.searchParams.has('token') && candidate.searchParams.get('token') !== context.continuationUrl!.searchParams.get('token')) break;
    await (options.sleep ?? (ms=>new Promise(resolve=>setTimeout(resolve,ms))))(Math.min(1000,until-Date.now()));
    if (Date.now() >= until) break;
    authorization.text = '';
    authorization = await request(location);
  }
  if (authorization.status !== 302 || !authorization.location) throw completionError('TOSS_LOGIN_COMPLETION_AUTH_NOT_ESTABLISHED');
  const callback = new URL(authorization.location, location);
  if (callback.origin !== BUSINESS_ORIGIN || callback.pathname !== '/account/two-factor/sign-in-done'
    || callback.username || callback.password || callback.hash || !callback.searchParams.get('code')
    || (callback.searchParams.has('session_token') && callback.searchParams.get('session_token') !== sessionToken)) {
    const redirectReceiver: TossHttpLoginErrorMetadata['redirectReceiver'] = callback.origin === BUSINESS_ORIGIN
      ? callback.pathname === '/account/two-factor/push-status' ? 'business_pending'
        : callback.pathname === '/account/two-factor/sign-in-done' ? 'business_done' : 'unknown'
      : callback.origin === 'https://auth.cert.toss.im'
        ? callback.pathname === '/error' ? 'auth_error' : 'auth_login'
        : callback.origin === OAUTH_RECEIVER_ORIGIN && callback.pathname === OAUTH_RECEIVER_PATH ? 'oauth_authorize' : 'unknown';
    throw completionError('TOSS_LOGIN_COMPLETION_REDIRECT_REJECTED', authorization.status, undefined,
      { redirectReceiver, callbackCodePresent: !!callback.searchParams.get('code'),
        callbackSessionMatches: !callback.searchParams.has('session_token') || callback.searchParams.get('session_token') === sessionToken });
  }
  await beforeAccountMutations?.();
  await request(callback);
  let checkInBody = JSON.stringify({ sessionToken, code: callback.searchParams.get('code') });
  let checkIn: InternalResponse;
  try { checkIn = await request(new URL(BUSINESS_ACCOUNTS_ORIGIN + '/account/verify/toss-login/check-in'),
    'POST', checkInBody, { 'Content-Type': 'application/json', Origin: BUSINESS_ORIGIN, Referer: BUSINESS_ORIGIN + '/' }); }
  finally { checkInBody = ''; callback.search = ''; }
  if (checkIn.status !== 200 || !checkIn.contentType?.startsWith('application/json')) throw completionError('TOSS_LOGIN_CHECK_IN_REJECTED');
  let checkInResult: Record<string, unknown>;
  try { checkInResult = JSON.parse(checkIn.text); } catch { throw completionError('TOSS_LOGIN_CHECK_IN_REJECTED'); }
  checkIn.text = '';
  if (checkInResult.resultType !== 'SUCCESS') throw completionError('TOSS_LOGIN_CHECK_IN_REJECTED');
  // The first-party sign-in-done page waits two seconds before submitting this form.
  if (Date.now() + 2000 >= deadline) throw completionError('TOSS_LOGIN_COMPLETION_AUTH_NOT_ESTABLISHED');
  await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(2000);
  const doneForm = new URLSearchParams({ sessionToken });
  let done: InternalResponse;
  try { done = await request(new URL(BUSINESS_ACCOUNTS_ORIGIN + '/account/two-factor/done'), 'POST', doneForm,
    { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BUSINESS_ORIGIN, Referer: BUSINESS_ORIGIN + '/' }); }
  finally { doneForm.delete('sessionToken'); }
  let reachedSharelink = false;
  for (let hop = 0; hop < MAX_REDIRECTS && done.location; hop++) {
    if (![301,302,303].includes(done.status)) throw completionError('TOSS_LOGIN_COMPLETION_OUTCOME_UNKNOWN');
    const next = new URL(done.location, done.requestUrl);
    if (next.username || next.password || next.hash || !((next.origin === BUSINESS_ACCOUNTS_ORIGIN
      && next.pathname === '/oauth2/authorize'
      && next.searchParams.get('redirect_uri') === TOSS_HTTP_LOGIN_ORIGIN + CALLBACK_PATH)
      || (next.origin === TOSS_HTTP_LOGIN_ORIGIN && next.pathname === CALLBACK_PATH))) {
      throw completionError('TOSS_LOGIN_COMPLETION_REDIRECT_REJECTED');
    }
    reachedSharelink ||= next.origin === TOSS_HTTP_LOGIN_ORIGIN;
    done = await request(next);
  }
  if (!reachedSharelink || done.status !== 200) throw completionError('TOSS_LOGIN_COMPLETION_AUTH_NOT_ESTABLISHED');
  const firstResponse = await sendApprovalRequest(new URL(MEMBER_URL), 'GET', undefined,
    { Accept: 'application/json', 'X-Toss-Locale': 'ko_KR' }, {
      fetchImpl, jar: context.cookieJar, credentials: 'include', timeoutMs: requestTimeoutMs,
      deadline, maxResponseBytes, steps, phase: 'member_first', loginPostSent: true,
      completionPostSent: true,
    });
  let first: MemberIdentity;
  try { first = memberIdentity(firstResponse.text, firstResponse.contentType, firstResponse.status); }
  catch {
    firstResponse.text = '';
    throw new TossHttpLoginError({ code: 'TOSS_LOGIN_COMPLETION_AUTH_NOT_ESTABLISHED',
      phase: 'member_first', httpStatus: firstResponse.status, loginPostSent: true,
      completionPostSent: true, redirectCount: 0 });
  }
  firstResponse.text = '';
  const secondResponse = await sendApprovalRequest(new URL(MEMBER_URL), 'GET', undefined,
    { Accept: 'application/json', 'X-Toss-Locale': 'ko_KR' }, {
      fetchImpl, jar: context.cookieJar, credentials: 'include', timeoutMs: requestTimeoutMs,
      deadline, maxResponseBytes, steps, phase: 'member_second', loginPostSent: true,
      completionPostSent: true,
    });
  let second: MemberIdentity;
  try { second = memberIdentity(secondResponse.text, secondResponse.contentType, secondResponse.status); }
  catch {
    secondResponse.text = '';
    throw new TossHttpLoginError({ code: 'TOSS_LOGIN_COMPLETION_AUTH_NOT_ESTABLISHED',
      phase: 'member_second', httpStatus: secondResponse.status, loginPostSent: true,
      completionPostSent: true, redirectCount: 0 });
  }
  secondResponse.text = '';
  if (!repeatedMemberMatches(first, second)
    || (owner && (!ownerMatches(first, owner) || !ownerMatches(second, owner)))) {
    throw new TossHttpLoginError({ code: 'TOSS_LOGIN_OWNER_MISMATCH', phase: 'member_second',
      httpStatus: secondResponse.status, loginPostSent: true, completionPostSent: true, redirectCount: 0 });
  }
  const ownerVerified = owner !== null;
  const session = new TossHttpAuthenticatedSessionHandle(HANDLE_TOKEN, context.cookieJar, owner,
    ownerVerified, new Date(now()).toISOString());
  return { status: 'authenticated', authenticated: true, ownerVerified,
    needsOwnerBinding: !ownerVerified, loginPostCount: 1, completionPostCount: 1,
    memberReadCount: 2, steps, session };
}

/** Reconciles an already completed approval without repeating the provider's completion POST. */
export async function reconcileCompletedTossLoginHttp(pending: TossHttpLoginPendingHandle,
  options: TossApprovalCompletionOptions): Promise<Omit<TossHttpCompletedLoginResult, 'completionPostCount'> & { completionPostCount: 0; reconciled: true }> {
  if (options.authorizationWaitMs !== undefined && (!Number.isInteger(options.authorizationWaitMs)
    || options.authorizationWaitMs < 0 || options.authorizationWaitMs > 30000)) throw completionError('TOSS_LOGIN_LIMIT_INVALID');
  const deadline = Date.now() + (options.totalTimeoutMs ?? 45_000);
  const state = await inspectTossHttpApprovalState(pending, options);
  if (state.providerApprovalStatus !== 'COMPLETED' || !state.pendingSessionValid || state.pendingSessionType !== 'MULTI_FACTOR') {
    throw metadataError('TOSS_LOGIN_RECOVERY_UNAVAILABLE', 'oauth', state.approvalHttpStatus, true, 0);
  }
  return pending.withContext(async context => {
    const token = approvalTokenFromCandidate(context.continuationUrl, validateApprovalReceiverBinding(options.binding));
    const binding = context.oauthReceiverBinding;
    if (!binding || !context.continuationUrl?.searchParams.get('session_token')) throw metadataError('TOSS_LOGIN_COMPLETION_BINDING_INVALID', 'oauth', null, true, 0);
    const authorization = observedApprovalAuthorizationUrl(context, binding, token);
    const completed = await finishTossBusinessAccountHttp(context, authorization, options, [...context.steps], options.beforeCompletion, deadline);
    return { ...completed, completionPostCount: 0 as const, reconciled: true as const };
  });
}

function observedApprovalAuthorizationUrl(context: TossPendingContext, binding: TossOAuthReceiverBinding, token: string): URL {
  // These fields were independently observed on the successful authorized HTTP flow.
  const receiver = new URL(BUSINESS_ORIGIN + '/account/two-factor/push-status');
  receiver.searchParams.set('session_token', context.continuationUrl!.searchParams.get('session_token')!);
  const authorization = new URL(OAUTH_RECEIVER_ORIGIN + OAUTH_RECEIVER_PATH);
  authorization.search = new URLSearchParams({ grant_type: 'authorization_code', client_id: binding.clientId,
    scope: 'user_ci', response_type: 'code', redirect_uri: binding.redirectUri, custom_origin: receiver.href, token }).toString();
  if (!validateOAuthAuthorizeUrl(authorization, binding)) throw metadataError('TOSS_LOGIN_OAUTH_RECEIVER_REJECTED', 'oauth', null, true, 0);
  return authorization;
}

/** Status reads send no cookies. Each completion mutation is dispatched once on the consumed handle. */
export async function completeApprovedTossLoginHttp(pending: TossHttpLoginPendingHandle,
  options: TossApprovalCompletionOptions): Promise<TossHttpApprovalCompletionResult> {
  if (!(pending instanceof TossHttpLoginPendingHandle)) throw metadataError(
    'TOSS_LOGIN_PENDING_REQUIRED', 'oauth', null, true, 0);
  const binding = validateApprovalReceiverBinding(options.binding);
  let suppliedOwner: TossExpectedOwner | null = null;
  if (options.expectedOwner !== undefined) {
    try { suppliedOwner = validateExpectedOwner(options.expectedOwner); }
    catch { throw metadataError('TOSS_LOGIN_OWNER_BASELINE_INVALID', 'oauth', null, true, 0); }
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const totalTimeoutMs = options.totalTimeoutMs ?? 45_000;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_BODY_BYTES;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 15_000
    || !Number.isInteger(totalTimeoutMs) || totalTimeoutMs < requestTimeoutMs || totalTimeoutMs > 55_000
    || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 2 * 1024 * 1024
    || options.authorizationWaitMs !== undefined && (!Number.isInteger(options.authorizationWaitMs)
      || options.authorizationWaitMs < 0 || options.authorizationWaitMs > 30000)) {
    throw metadataError('TOSS_LOGIN_LIMIT_INVALID', 'oauth', null, true, 0);
  }

  let approvalToken = '';
  let candidateHref = '';
  const readSteps: TossHttpLoginStep[] = [];
  const deadline = Date.now() + totalTimeoutMs;
  try {
    const inspection = await pending.inspectContext(async context => {
      const owner = suppliedOwner ?? context.expectedOwner;
      if (suppliedOwner && context.expectedOwner && !sameExpectedOwner(suppliedOwner, context.expectedOwner)) {
        throw metadataError('TOSS_LOGIN_OWNER_BASELINE_INVALID', 'oauth', null, true, 0);
      }
      const token = approvalTokenFromCandidate(context.continuationUrl, binding);
      candidateHref = context.continuationUrl!.href;
      const approvalUrl = new URL(TOSS_PUBLIC_API_ORIGIN + TOSS_APPROVAL_STATUS_PATH);
      approvalUrl.searchParams.set('token', token);
      const steps = [...context.steps];
      let response: InternalResponse;
      try {
        response = await sendApprovalRequest(approvalUrl, 'GET', undefined,
          { Accept: 'application/json', 'X-Toss-Locale': 'ko_KR' }, {
            fetchImpl, credentials: 'omit', timeoutMs: requestTimeoutMs, deadline, maxResponseBytes,
            steps, phase: 'approval_status', loginPostSent: true, completionPostSent: false,
          });
      } finally { approvalUrl.search = ''; }
      if (response.status !== 200) throw metadataError('TOSS_LOGIN_APPROVAL_STATUS_UNAVAILABLE',
        'approval_status', response.status, true, 0);
      const status = approvalStatus(response.text, response.contentType);
      response.text = '';
      response.requestUrl.search = '';
      if (!status) throw metadataError('TOSS_LOGIN_APPROVAL_STATUS_UNAVAILABLE',
        'approval_status', response.status, true, 0);
      return { status, steps, owner, token };
    });
    approvalToken = inspection.token;
    inspection.token = '';
    readSteps.push(...inspection.steps);
    if (inspection.status !== 'AGREED') {
      if (['REJECTED','EXPIRED','CANCELED','COMPLETED'].includes(inspection.status)) throw metadataError('TOSS_LOGIN_APPROVAL_NOT_AGREED',
        'approval_status', 200, true, 0);
      return { status: 'approval_pending', authenticated: false, ownerVerified: false,
        needsOwnerBinding: true, code: 'TOSS_LOGIN_APPROVAL_PENDING', approvalStatus: inspection.status,
        completionPostCount: 0, steps: [...readSteps], pending };
    }

    return await pending.withContext(async context => {
      if (context.continuationUrl?.href !== candidateHref) throw metadataError(
        'TOSS_LOGIN_COMPLETION_RECEIVER_REJECTED', 'oauth', null, true, 0);
      const token = approvalTokenFromCandidate(context.continuationUrl, binding);
      if (token !== approvalToken) throw metadataError('TOSS_LOGIN_COMPLETION_RECEIVER_REJECTED',
        'oauth', null, true, 0);
      const owner = suppliedOwner ?? context.expectedOwner;
      if (suppliedOwner && context.expectedOwner && !sameExpectedOwner(suppliedOwner, context.expectedOwner)) {
        throw metadataError('TOSS_LOGIN_OWNER_BASELINE_INVALID', 'oauth', null, true, 0);
      }
      const steps = [...readSteps];
      await options.beforeCompletion?.();
      const loginUrl = new URL(OAUTH_RECEIVER_ORIGIN + OAUTH_LOGIN_PATH);
      const sessionToken = context.continuationUrl!.searchParams.get('session_token');
      const authorizationBinding = context.oauthReceiverBinding ?? validateOAuthReceiverBinding(options.authorizationBinding);
      if (!sessionToken || !authorizationBinding) throw completionError('TOSS_LOGIN_COMPLETION_BINDING_INVALID');
      const form = options.completionEncoding === 'multipart' ? new FormData() : new URLSearchParams();
      let completionToken = token;
      form.append('token', completionToken);
      let completionResponse: InternalResponse;
      try {
        completionResponse = await sendApprovalRequest(loginUrl, 'POST', form,
          { Accept: 'application/json, text/html, */*', 'X-Toss-Locale': 'ko',
            ...(form instanceof URLSearchParams ? { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {}),
            Origin: BUSINESS_ORIGIN, Referer: BUSINESS_ORIGIN + '/' }, {
            fetchImpl, jar: context.cookieJar, credentials: 'include', timeoutMs: requestTimeoutMs,
            deadline, maxResponseBytes, steps, phase: 'completion', loginPostSent: true,
            completionPostSent: true,
          });
      } finally { form.delete('token'); completionToken = ''; }
      let completionResponseShape: 'redirect' | 'wrapped_redirect' | 'failure' | 'other' = 'other';
      try {
        const root = JSON.parse(completionResponse.text);
        completionResponseShape = typeof root?.location === 'string' ? 'redirect'
          : root?.resultType === 'SUCCESS' && typeof root?.success?.location === 'string' ? 'wrapped_redirect'
          : ['FAIL','ERROR'].includes(root?.resultType) ? 'failure' : 'other';
      } catch { /* Never retain the body in diagnostics. */ }
      await options.onCompletionResponse?.(context, {
        completionResponseHttpStatus: completionResponse.status,
        completionCookieNames: context.cookieJar.getCookiesSync(OAUTH_RECEIVER_ORIGIN + '/login')
          .map(cookie => cookie.key).filter((key): key is 'TAUTH' | 'TBIZAUTH' | 'TGSID' => ['TAUTH','TBIZAUTH','TGSID'].includes(key)),
        completionResponseShape,
      });
      if ([301, 302, 303, 307, 308].includes(completionResponse.status)) {
        if (completionResponse.location) {
          try {
            const redirect = new URL(completionResponse.location, loginUrl);
            if (redirect.pathname === '/error') throw completionError('TOSS_LOGIN_COMPLETION_PROVIDER_REJECTED',
              completionResponse.status, 'http_error_redirect');
          } catch (error) { if (error instanceof TossHttpLoginError) throw error; }
        }
        throw new TossHttpLoginError({ code: 'TOSS_LOGIN_COMPLETION_OUTCOME_UNKNOWN', phase: 'completion',
          httpStatus: completionResponse.status, loginPostSent: true, completionPostSent: true, redirectCount: 0 });
      }
      if (completionResponse.status !== 200) throw completionError('TOSS_LOGIN_COMPLETION_PROVIDER_REJECTED',
        completionResponse.status, 'non_success_http');
      let location: URL;
      let reconciled = false;
      try { location = completionResponseLocation(completionResponse.text, completionResponse.contentType, completionResponse.status); }
      catch (error) {
        if (!(error instanceof TossHttpLoginError) || error.metadata.providerResponse !== 'json_error_redirect') throw error;
        // The POST may have completed approval and rotated cookies before returning the error UI.
        // Confirm provider state, then continue with this invocation's updated jar. Never resend /login.
        const statusUrl = new URL(TOSS_PUBLIC_API_ORIGIN + TOSS_APPROVAL_STATUS_PATH);
        statusUrl.searchParams.set('token', token);
        let statusResponse: InternalResponse;
        try { statusResponse = await sendApprovalRequest(statusUrl, 'GET', undefined,
          { Accept: 'application/json', 'X-Toss-Locale': 'ko_KR' }, { fetchImpl, credentials: 'omit',
            timeoutMs: requestTimeoutMs, deadline, maxResponseBytes, steps, phase: 'approval_status',
            loginPostSent: true, completionPostSent: true }); }
        finally { statusUrl.search = ''; }
        const status = approvalStatus(statusResponse.text, statusResponse.contentType);
        statusResponse.text = ''; statusResponse.requestUrl.search = '';
        if (statusResponse.status !== 200 || status !== 'COMPLETED') throw error;
        location = observedApprovalAuthorizationUrl(context, authorizationBinding, token);
        reconciled = true;
      }
      finally { completionResponse.text = ''; }
      if (!validateOAuthAuthorizeUrl(location, authorizationBinding)) throw completionError('TOSS_LOGIN_COMPLETION_REDIRECT_REJECTED');
      const completed = await finishTossBusinessAccountHttp(context, location, options, steps, undefined, deadline);
      return reconciled ? { ...completed, reconciled: true } : completed;
    });
  } finally { approvalToken = ''; candidateHref = ''; }
}

/** Server-owned encrypted transactions only; this is not exposed as an HTTP cookie import. */
export function restoreTossHttpPendingContext(context: TossPendingContext): TossHttpLoginPendingHandle {
  const owner = validateExpectedOwner(context.expectedOwner);
  const binding = validateOAuthReceiverBinding(context.oauthReceiverBinding ?? undefined);
  if (!Number.isFinite(context.expiresAt) || context.expiresAt <= Date.now() || context.expiresAt > Date.now() + 15 * 60_000
    || !(context.cookieJar instanceof CookieJar) || !Array.isArray(context.steps)) {
    throw metadataError('TOSS_LOGIN_PENDING_EXPIRED', 'oauth', null, true, 0);
  }
  approvalTokenFromCandidate(context.continuationUrl, { receiverOrigin: BUSINESS_ORIGIN,
    receiverPath: '/account/two-factor/push-status', receiverQueryNames: ['session_token','token'], tokenQueryName: 'token' });
  return new TossHttpLoginPendingHandle(HANDLE_TOKEN, context.cookieJar, context.continuationUrl, context.expiresAt,
    context.steps, owner, binding);
}

function sameExpectedOwner(left: TossExpectedOwner, right: TossExpectedOwner): boolean {
  return left.publisherId === right.publisherId
    && left.userNo === right.userNo && left.bizUserNo === right.bizUserNo;
}

function textAction(text: string): TossHttpLoginAction | null {
  if (text.length > 256 * 1024) return null;
  if (/(?:two[- ]factor|twofactor|2fa|otp|verification\s+code|인증\s*번호|추가\s*인증)/i.test(text)) return 'two_factor';
  if (/(?:consent\s+required|accept\s+terms|약관\s*동의)/i.test(text)) return 'consent';
  if (/(?:change\s+password|password\s+expired|비밀번호\s*변경)/i.test(text)) return 'password_change';
  return null;
}

/** Pure HTTP only. It never opens a browser, retries signin, stores credentials, or persists a session. */
export async function loginTossSharelinkHttp(options: TossHttpLoginOptions): Promise<TossHttpLoginResult> {
  let validated: { owner: TossExpectedOwner | null; binding: TossOAuthReceiverBinding | null };
  try { validated = validateInput(options); }
  catch (error) {
    if (options && typeof options === 'object') {
      try { options.password = ''; } catch { /* caller input may be frozen */ }
    }
    throw error;
  }
  const { owner, binding } = validated;
  const email = options.email.trim();
  let password = options.password;
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const totalTimeoutMs = options.totalTimeoutMs ?? 45_000;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_BODY_BYTES;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 15_000
    || !Number.isInteger(totalTimeoutMs) || totalTimeoutMs < requestTimeoutMs || totalTimeoutMs > 55_000
    || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 2 * 1024 * 1024
    || (options.includeBrowserSessionCookie !== undefined && typeof options.includeBrowserSessionCookie !== 'boolean')) {
    try { options.password = ''; } catch { /* caller input may be frozen */ }
    throw metadataError('TOSS_LOGIN_LIMIT_INVALID', null, null, false, 0);
  }
  const jar = new CookieJar();
  const steps: TossHttpLoginStep[] = [];
  const startedAt = Date.now();
  const deadline = startedAt + totalTimeoutMs;
  let loginPostSent = false;
  let redirectCount = 0;
  let currentPhase: TossHttpLoginPhase | null = 'signin_page';
  let lastStatus: number | null = null;

  async function send(url: URL, method: 'GET' | 'POST', body: string | Uint8Array | undefined,
    headers: Record<string, string>, phase: TossHttpLoginPhase): Promise<InternalResponse> {
    const browserSession = phase === 'browser_session' && options.includeBrowserSessionCookie === true
      && !loginPostSent && method === 'POST' && body === undefined
      && url.href === BUSINESS_ACCOUNTS_ORIGIN + '/wgslog';
    if (!browserSession && !validateRequestUrl(url, binding, phase === 'signin_page')) throw metadataError('TOSS_LOGIN_ORIGIN_OR_PATH_REJECTED', phase, null, loginPostSent, redirectCount);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw metadataError(loginPostSent ? 'TOSS_LOGIN_OUTCOME_UNKNOWN' : 'TOSS_LOGIN_TIMEOUT', phase, null, loginPostSent, redirectCount);
    const timeoutMs = Math.min(requestTimeoutMs, remaining);
    const controller = new AbortController();
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let rejectTimeout: ((error: Error) => void) | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout?.(new Error('TIMEOUT'));
    }, timeoutMs);
    const cookie = jar.getCookieStringSync(url.href);
    const requestHeaders = { ...headers, ...(cookie ? { Cookie: cookie } : {}) };
    const requestInit: RequestInit = { method, headers: requestHeaders, redirect: 'manual',
      cache: 'no-store', signal: controller.signal };
    let bodyCopy: Uint8Array | null = null;
    if (typeof body === 'string') requestInit.body = body;
    else if (body) {
      bodyCopy = new Uint8Array(body.byteLength);
      bodyCopy.set(body);
      requestInit.body = bodyCopy.buffer as ArrayBuffer;
    }
    let response: Response | null = null;
    try {
      response = await Promise.race([fetchImpl(url, requestInit), timeoutPromise]);
      lastStatus = response.status;
      storeResponseCookies(jar, response, url);
      const contentType = responseContentType(response);
      const location = response.headers.get('location');
      const text = await Promise.race([readBoundedText(response, maxResponseBytes, controller.signal), timeoutPromise]);
      if (timedOut) throw new Error('TIMEOUT');
      steps.push({ phase, httpStatus: response.status });
      return { requestUrl: new URL(url.href), status: response.status, contentType, location, text };
    } catch (error) {
      if (response?.body) await response.body.cancel().catch(() => undefined);
      if (error instanceof TossHttpLoginError) throw error;
      if (timedOut || (error instanceof Error && error.message === 'TIMEOUT')) {
        throw metadataError(loginPostSent ? 'TOSS_LOGIN_OUTCOME_UNKNOWN' : 'TOSS_LOGIN_TIMEOUT', phase,
          lastStatus, loginPostSent, redirectCount);
      }
      if (error instanceof Error && error.message === 'BODY_LIMIT') {
        throw metadataError(loginPostSent ? 'TOSS_LOGIN_OUTCOME_UNKNOWN' : 'TOSS_LOGIN_RESPONSE_TOO_LARGE', phase,
          lastStatus, loginPostSent, redirectCount);
      }
      if (error instanceof Error && error.message === 'BODY_ENCODING') {
        throw metadataError(loginPostSent ? 'TOSS_LOGIN_OUTCOME_UNKNOWN' : 'TOSS_LOGIN_RESPONSE_INVALID', phase,
          lastStatus, loginPostSent, redirectCount);
      }
      if (error instanceof Error && error.message === 'COOKIE_REJECTED') {
        throw metadataError('TOSS_LOGIN_COOKIE_REJECTED', phase, lastStatus, loginPostSent, redirectCount);
      }
      throw metadataError(loginPostSent ? 'TOSS_LOGIN_OUTCOME_UNKNOWN' : 'TOSS_LOGIN_HTTP_FAILED', phase,
        lastStatus, loginPostSent, redirectCount);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      bodyCopy?.fill(0);
    }
  }

  function actionResult(action: TossHttpLoginAction, phase: TossHttpLoginPhase, response: InternalResponse,
    next: URL | null = null): TossHttpLoginActionRequiredResult {
    currentPhase = phase;
    lastStatus = response.status;
    return makeActionResult(action, phase, response.status, next, jar, redirectCount, steps, now, owner, binding);
  }

  try {
    const signInPage = new URL(BUSINESS_ORIGIN + SIGN_IN_PAGE_PATH);
    signInPage.searchParams.set('client_id', 'ajvm9wq2t0p1ttet13y3qzb3rvjxhacn');
    signInPage.searchParams.set('redirect_uri', TOSS_HTTP_LOGIN_ORIGIN + CALLBACK_PATH);
    const page = await send(signInPage, 'GET', undefined, { Accept: 'text/html,application/xhtml+xml' }, 'signin_page');
    if (page.status !== 200) throw metadataError('TOSS_LOGIN_SIGNIN_PAGE_FAILED', 'signin_page', page.status, false, 0);

    if (options.includeBrowserSessionCookie === true) {
      // The first-party account logger enables useCrossDomainSession and POSTs
      // /wgslog before sign-in. It issues TGSID; it is not an authentication proof.
      // Like that frontend's browser-id fallback, unavailable telemetry must not
      // prevent the actual login. Never forward a redirect or a credential here.
      try {
        const browser = await send(new URL(BUSINESS_ACCOUNTS_ORIGIN + '/wgslog'), 'POST', undefined,
          { Accept: 'application/json', Origin: BUSINESS_ORIGIN, Referer: signInPage.href }, 'browser_session');
        browser.text = '';
      } catch (error) {
        if (error instanceof TossHttpLoginError && error.metadata.code === 'TOSS_LOGIN_COOKIE_REJECTED') throw error;
      }
    }

    const form = new URLSearchParams();
    form.set('email', email);
    form.set('password', password);
    form.set('client_id', 'ajvm9wq2t0p1ttet13y3qzb3rvjxhacn');
    form.set('redirect_uri', TOSS_HTTP_LOGIN_ORIGIN + CALLBACK_PATH);
    let encodedForm = form.toString();
    const postBody = Buffer.from(encodedForm, 'utf8');
    encodedForm = '';
    form.set('password', '');
    password = '';
    loginPostSent = true;
    currentPhase = 'signin';
    let response: InternalResponse;
    try {
      response = await send(new URL(BUSINESS_ACCOUNTS_ORIGIN + SIGN_IN_PATH), 'POST', postBody, {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: BUSINESS_ORIGIN,
        Referer: signInPage.href,
      }, 'signin');
    } finally { postBody.fill(0); }
    const firstCode = providerCode(response.text, response.contentType);
    const firstAction = actionForCode(firstCode);
    if (firstAction) return actionResult(firstAction, 'signin', response,
      response.location ? new URL(response.location, BUSINESS_ACCOUNTS_ORIGIN) : null);
    if (response.status < 200 || response.status >= 400) {
      throw metadataError('TOSS_LOGIN_REJECTED', 'signin', response.status, true, redirectCount);
    }
    if (firstCode && firstCode !== 'SUCCESS') throw metadataError('TOSS_LOGIN_PROVIDER_REJECTED',
      'signin', response.status, true, redirectCount);

    let nextLocation = response.location;
    let nextUrl: URL | null = null;
    while (nextLocation && [301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount >= MAX_REDIRECTS) throw metadataError('TOSS_LOGIN_REDIRECT_LIMIT', currentPhase, response.status, true, redirectCount);
      try { nextUrl = new URL(nextLocation, response.requestUrl); }
      catch { throw metadataError('TOSS_LOGIN_REDIRECT_INVALID', currentPhase, response.status, true, redirectCount); }
      if (!ALLOWED_ORIGINS.has(nextUrl.origin) || nextUrl.username || nextUrl.password || nextUrl.hash
        || nextUrl.href.length > 16384) throw metadataError('TOSS_LOGIN_ORIGIN_OR_PATH_REJECTED',
        currentPhase, response.status, true, redirectCount);
      const urlAction = actionForPath(nextUrl.pathname);
      if (urlAction) return actionResult(urlAction, phaseForUrl(nextUrl), response, nextUrl);
      const redirectCode = nextUrl.searchParams.get('error');
      const redirectAction = actionForCode(redirectCode);
      if (redirectAction) return actionResult(redirectAction, phaseForUrl(nextUrl), response, nextUrl);
      if (redirectCode) throw metadataError('TOSS_LOGIN_REJECTED', currentPhase, response.status, true, redirectCount);
      if (nextUrl.origin === OAUTH_RECEIVER_ORIGIN && nextUrl.pathname === OAUTH_RECEIVER_PATH) {
        if (!binding) return actionResult('oauth_binding', 'oauth', response, nextUrl);
        if (!validateOAuthAuthorizeUrl(nextUrl, binding)) throw metadataError('TOSS_LOGIN_OAUTH_RECEIVER_REJECTED',
          'oauth', response.status, true, redirectCount);
      } else if (!validateRequestUrl(nextUrl, binding)) {
        throw metadataError('TOSS_LOGIN_ORIGIN_OR_PATH_REJECTED', currentPhase, response.status, true, redirectCount);
      }
      if (response.status === 307 || response.status === 308) throw metadataError('TOSS_LOGIN_OUTCOME_UNKNOWN',
        currentPhase, response.status, true, redirectCount);
      redirectCount++;
      const phase: TossHttpLoginPhase = nextUrl.origin === OAUTH_RECEIVER_ORIGIN ? 'oauth'
        : nextUrl.origin === TOSS_HTTP_LOGIN_ORIGIN ? 'sharelink' : 'oauth';
      currentPhase = phase;
      response = await send(nextUrl, 'GET', undefined, { Accept: 'application/json, text/html, */*' }, phase);
      const code = providerCode(response.text, response.contentType);
      const action = actionForCode(code) ?? (phase === 'oauth' || phase === 'sharelink' ? textAction(response.text) : null);
      if (action) return actionResult(action, phase, response,
        response.location ? new URL(response.location, response.requestUrl) : null);
      if (code && code !== 'SUCCESS') throw metadataError('TOSS_LOGIN_PROVIDER_REJECTED', phase, response.status, true, redirectCount);
      nextLocation = response.location;
    }

    if (response.status < 200 || response.status >= 300) throw metadataError('TOSS_LOGIN_AUTH_NOT_ESTABLISHED',
      currentPhase, response.status, true, redirectCount);
    if (currentPhase === 'oauth' && !nextUrl) throw metadataError('TOSS_LOGIN_AUTH_NOT_ESTABLISHED', 'oauth', response.status, true, redirectCount);

    const firstMemberResponse = await send(new URL(MEMBER_URL), 'GET', undefined,
      { Accept: 'application/json', Referer: TOSS_HTTP_LOGIN_ORIGIN + '/home' }, 'member_first');
    let firstMember: MemberIdentity;
    try { firstMember = memberIdentity(firstMemberResponse.text, firstMemberResponse.contentType, firstMemberResponse.status); }
    catch (error) {
      if (error instanceof Error && error.message === 'TWO_FACTOR_REQUIRED') return actionResult('two_factor', 'member_first', firstMemberResponse);
      throw metadataError('TOSS_LOGIN_AUTH_NOT_ESTABLISHED', 'member_first', firstMemberResponse.status, true, redirectCount);
    }
    const secondMemberResponse = await send(new URL(MEMBER_URL), 'GET', undefined,
      { Accept: 'application/json', Referer: TOSS_HTTP_LOGIN_ORIGIN + '/home' }, 'member_second');
    let secondMember: MemberIdentity;
    try { secondMember = memberIdentity(secondMemberResponse.text, secondMemberResponse.contentType, secondMemberResponse.status); }
    catch {
      throw metadataError('TOSS_LOGIN_AUTH_NOT_ESTABLISHED', 'member_second', secondMemberResponse.status, true, redirectCount);
    }
    if (!repeatedMemberMatches(firstMember, secondMember)
      || (owner && (!ownerMatches(firstMember, owner) || !ownerMatches(secondMember, owner)))) {
      throw metadataError('TOSS_LOGIN_OWNER_MISMATCH', 'member_second', secondMemberResponse.status, true, redirectCount);
    }
    const ownerVerified = owner !== null;
    const session = new TossHttpAuthenticatedSessionHandle(HANDLE_TOKEN, jar, owner, ownerVerified, new Date(now()).toISOString());
    return { status: 'authenticated', authenticated: true, ownerVerified,
      needsOwnerBinding: !ownerVerified, memberReadCount: 2, loginPostCount: 1, steps: [...steps], session };
  } catch (error) {
    if (error instanceof TossHttpLoginError) throw error;
    throw metadataError('TOSS_LOGIN_RUNTIME_FAILED', currentPhase, lastStatus, loginPostSent, redirectCount);
  } finally {
    password = '';
    if (options && typeof options === 'object') {
      try { options.password = ''; } catch { /* caller input may be frozen */ }
    }
  }
}

