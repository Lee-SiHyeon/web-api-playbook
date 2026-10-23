import { createHash, createHmac } from 'node:crypto';

const API_ORIGIN = 'https://api-gateway.coupang.com';
const API_BASE_PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1';
const DEEPLINK_PATH = API_BASE_PATH + '/deeplink';
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const SHORT_HOSTS = new Set(['coupa.ng', 'link.coupang.com']);
const LANDING_QUERY_KEYS = new Set(['lptag', 'pageKey', 'itemId', 'vendorItemId', 'traceid']);

export const COUPANG_PARTNERS_OPENAPI_CONTRACT_STATUS = Object.freeze({
  state: 'first_party_contract_verified',
  executable: true,
  credentialsConfiguredByClient: false,
  liveReplayVerified: false,
  specUrl: 'https://partners.coupang.com/api/v1/configuration/content/OPEN_API_SPEC',
  guideUrl: 'https://partners.coupang.com/api/v1/configuration/content/OPEN_API_GUIDE',
  apiOrigin: API_ORIGIN,
  apiBasePath: API_BASE_PATH,
  deepLinkMethod: 'POST',
  deepLinkPath: DEEPLINK_PATH,
  deepLinkMaxUrls: 20,
  requestSigning: 'CEA HmacSHA256 over YYMMDDTHHmmssZ + method + path + raw query',
  ownerIdentityVerifiedByApiKeyAlone: false,
} as const);

export interface CoupangPartnersOpenApiCredentials {
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface CoupangOpenApiDependencies {
  readonly credentials: CoupangPartnersOpenApiCredentials;
  readonly journal: CoupangOpenApiIssueJournal;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  /** Supply only from separately owner-verified server state. */
  readonly expectedAffiliateCode?: string | null;
  /** The channel must already be registered in Partners; otherwise omit it. */
  readonly subId?: string;
}

export interface CoupangOpenApiIssueIntent {
  readonly service: 'coupang_partners';
  readonly fingerprint: string;
  readonly payloadDigest: string;
  readonly productUrl: string;
  readonly method: 'POST';
  readonly path: typeof DEEPLINK_PATH;
}

export interface CoupangOpenApiIssueReservation {
  readonly reserved: true;
  readonly reservationId: string;
}

export interface CoupangOpenApiIssueJournal {
  /** Must durably reserve or reject this stable fingerprint before network dispatch. */
  prepare(intent: CoupangOpenApiIssueIntent): Promise<CoupangOpenApiIssueReservation | null>;
  /** Persist only the outcome and safe status metadata; never store keys, headers, body, or short URL. */
  finish(receipt: {
    readonly reservationId: string;
    readonly outcome: 'acknowledged' | 'rejected' | 'outcome_unknown';
    readonly httpStatus: number | null;
    readonly responseCode?: string;
  }): Promise<void>;
}

export interface CoupangPartnerLinkIssue {
  readonly productUrl: string;
  readonly shortUrl: string;
  readonly verification: 'official_openapi_response';
  readonly destinationVerified: boolean;
  readonly destinationVerification: 'generation_response_only' | 'official_response_short_url_only';
  readonly attributionVerified: boolean;
  readonly attributionMismatch?: true;
  readonly independentReadbackVerified: false;
  /** A signed API-key response does not establish the operator's identity. */
  readonly ownerVerified: false;
  readonly cached: false;
}

export class CoupangPartnersOpenApiError extends Error {
  readonly code: string;
  readonly httpStatus: number | null;

  constructor(code: string, httpStatus: number | null = null) {
    super(code);
    this.name = 'CoupangPartnersOpenApiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

type CoupangProductTarget = {
  productId: string;
  itemId: string;
  vendorItemId: string;
  productUrl: string;
};

type VerifiedLanding = { lptag: string };

/** Creates the CEA HMAC Authorization value described in the official API guide. */
export function buildCoupangOpenApiAuthorization(
  method: 'GET' | 'POST',
  requestTarget: string,
  credentials: CoupangPartnersOpenApiCredentials,
  now = new Date(),
): string {
  validateCredentials(credentials);
  if (method !== 'GET' && method !== 'POST') throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_METHOD_INVALID');
  if (!validRequestTarget(requestTarget)) throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_REQUEST_TARGET_INVALID');
  const signedDate = formatCoupangUtcTimestamp(now);
  const [path, query = ''] = requestTarget.split('?');
  const message = signedDate + method + path + query;
  const signature = createHmac('sha256', credentials.secretKey).update(message, 'utf8').digest('hex');
  return 'CEA algorithm=HmacSHA256, access-key=' + credentials.accessKey
    + ', signed-date=' + signedDate + ', signature=' + signature;
}

/**
 * Issues one link through the official Partners deeplink API. Credentials must
 * come from a server-side provider. The function performs exactly one POST,
 * never opens the returned URL, and never retries an uncertain outcome.
 */
export async function issueCoupangPartnerLink(
  productUrl: string,
  dependencies: CoupangOpenApiDependencies,
): Promise<CoupangPartnerLinkIssue> {
  const target = normalizeCoupangProductUrl(productUrl);
  const credentials = dependencies?.credentials;
  validateCredentials(credentials);
  if (!dependencies?.journal || typeof dependencies.journal.prepare !== 'function'
    || typeof dependencies.journal.finish !== 'function') {
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_INTENT_JOURNAL_REQUIRED');
  }
  const expectedAffiliateCode = validateAffiliateCode(dependencies.expectedAffiliateCode);
  const subId = validateSubId(dependencies.subId);
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_TIMEOUT_INVALID');
  }
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_TRANSPORT_UNAVAILABLE');

  const now = dependencies.now?.() ?? new Date();
  const endpoint = new URL(DEEPLINK_PATH, API_ORIGIN);
  const requestTarget = endpoint.pathname + endpoint.search;
  const authorization = buildCoupangOpenApiAuthorization('POST', requestTarget, credentials, now);
  const body = JSON.stringify({ coupangUrls: [target.productUrl], ...(subId ? { subId } : {}) });
  const payloadDigest = createHash('sha256').update(body, 'utf8').digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify({
    service: 'coupang_partners', method: 'POST', path: DEEPLINK_PATH,
    productUrl: target.productUrl, payloadDigest,
  }), 'utf8').digest('hex');
  let reservation: CoupangOpenApiIssueReservation | null;
  try {
    reservation = await dependencies.journal.prepare({
      service: 'coupang_partners', fingerprint, payloadDigest, productUrl: target.productUrl,
      method: 'POST', path: DEEPLINK_PATH,
    });
  } catch {
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_INTENT_RESERVATION_FAILED');
  }
  if (!reservation) throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_INTENT_ALREADY_RESERVED');
  if (reservation.reserved !== true || !/^[A-Za-z0-9_-]{1,128}$/.test(reservation.reservationId)) {
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_INTENT_RESERVATION_INVALID');
  }
  let finalized = false;
  const finish = async (outcome: 'acknowledged' | 'rejected' | 'outcome_unknown', httpStatus: number | null,
    responseCode?: string): Promise<void> => {
    if (finalized) throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_JOURNAL_FINALIZE_FAILED', httpStatus);
    try {
      await dependencies.journal.finish({ reservationId: reservation.reservationId, outcome, httpStatus,
        ...(responseCode && /^[A-Z0-9_]{1,48}$/.test(responseCode) ? { responseCode } : {}) });
      finalized = true;
    } catch {
      throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_OUTCOME_UNKNOWN', httpStatus);
    }
  };

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization,
      },
      body,
    });
  } catch {
    // The provider may have created a link before the connection failed.
    await finish('outcome_unknown', null, 'TRANSPORT_AFTER_DISPATCH');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_OUTCOME_UNKNOWN');
  }

  if (response.url) {
    let responseUrl: URL;
    try { responseUrl = new URL(response.url); } catch {
      await finish('outcome_unknown', response.status, 'RESPONSE_SCOPE_INVALID');
      throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_RESPONSE_SCOPE_INVALID', response.status);
    }
    if (responseUrl.origin !== API_ORIGIN || responseUrl.pathname !== DEEPLINK_PATH || responseUrl.search) {
      await finish('outcome_unknown', response.status, 'RESPONSE_SCOPE_INVALID');
      throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_RESPONSE_SCOPE_INVALID', response.status);
    }
  }
  if (response.status === 401 || response.status === 403) {
    await finish('rejected', response.status, 'AUTH_REJECTED');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_AUTH_REJECTED', response.status);
  }
  if (response.status === 429) {
    await finish('rejected', response.status, 'RATE_LIMITED');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_RATE_LIMITED', response.status);
  }
  if (response.status !== 200) {
    await finish(response.status >= 500 ? 'outcome_unknown' : 'rejected', response.status,
      response.status >= 500 ? 'SERVER_ERROR' : 'HTTP_REJECTED');
    throw new CoupangPartnersOpenApiError(
      response.status >= 500 ? 'COUPANG_OPENAPI_OUTCOME_UNKNOWN' : 'COUPANG_OPENAPI_HTTP_REJECTED',
      response.status,
    );
  }
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
    await finish('outcome_unknown', response.status, 'RESPONSE_SCHEMA_INVALID');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_OUTCOME_UNKNOWN', response.status);
  }

  let responseText: string;
  try { responseText = await readBoundedResponse(response); } catch {
    await finish('outcome_unknown', response.status, 'RESPONSE_READ_FAILED');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_OUTCOME_UNKNOWN', response.status);
  }
  let payload: unknown;
  try { payload = JSON.parse(responseText); } catch {
    await finish('outcome_unknown', response.status, 'RESPONSE_SCHEMA_INVALID');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_OUTCOME_UNKNOWN', response.status);
  }
  if (!record(payload)) {
    await finish('outcome_unknown', response.status, 'RESPONSE_SCHEMA_INVALID');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_RESPONSE_SCHEMA_INVALID', response.status);
  }
  const root = payload;
  if (typeof root.rCode !== 'string' || typeof root.rMessage !== 'string' || !Object.hasOwn(root, 'data')) {
    await finish('outcome_unknown', response.status, 'RESPONSE_SCHEMA_INVALID');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_RESPONSE_ENVELOPE_INVALID', response.status);
  }
  if (root.rCode !== '0') {
    const responseCode = typeof root.rCode === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(root.rCode)
      ? 'APPLICATION_' + root.rCode : 'APPLICATION_REJECTED';
    await finish('rejected', response.status, responseCode);
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_APPLICATION_REJECTED', response.status);
  }
  if (!Array.isArray(root.data)) {
    await finish('outcome_unknown', response.status, 'RESPONSE_SCHEMA_INVALID');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_RESPONSE_DATA_INVALID', response.status);
  }
  if (root.data.length !== 1) {
    await finish('outcome_unknown', response.status, 'RESPONSE_SCHEMA_INVALID');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_OUTCOME_UNKNOWN', response.status);
  }
  const rawItem = root.data[0];
  if (!record(rawItem)) {
    await finish('outcome_unknown', response.status, 'RESPONSE_SCHEMA_INVALID');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_RESPONSE_DATA_INVALID', response.status);
  }
  const item = rawItem;
  if (item.originalUrl !== target.productUrl || typeof item.shortenUrl !== 'string') {
    await finish('outcome_unknown', response.status, 'RESPONSE_SCHEMA_INVALID');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_OUTCOME_UNKNOWN', response.status);
  }
  const shortUrl = validateShortUrl(item.shortenUrl);
  if (!shortUrl) {
    await finish('outcome_unknown', response.status, 'RESPONSE_SCHEMA_INVALID');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_OUTCOME_UNKNOWN', response.status);
  }
  const landing = item.landingUrl == null
    ? null
    : validateLandingUrl(item.landingUrl, target);
  if (item.landingUrl != null && !landing) {
    await finish('outcome_unknown', response.status, 'RESPONSE_SCHEMA_INVALID');
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_OUTCOME_UNKNOWN', response.status);
  }
  await finish('acknowledged', response.status, 'ISSUED');
  const attributionVerified = Boolean(landing && expectedAffiliateCode && landing.lptag === expectedAffiliateCode);
  const attributionMismatch = Boolean(landing && expectedAffiliateCode && landing.lptag !== expectedAffiliateCode);

  return {
    productUrl: target.productUrl,
    shortUrl,
    verification: 'official_openapi_response',
    destinationVerified: landing !== null,
    destinationVerification: landing ? 'generation_response_only' : 'official_response_short_url_only',
    attributionVerified,
    ...(attributionMismatch ? { attributionMismatch: true as const } : {}),
    independentReadbackVerified: false,
    ownerVerified: false,
    cached: false,
  };
}

export function formatCoupangUtcTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_CLOCK_INVALID');
  }
  const year = String(value.getUTCFullYear() % 100).padStart(2, '0');
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  const hour = String(value.getUTCHours()).padStart(2, '0');
  const minute = String(value.getUTCMinutes()).padStart(2, '0');
  const second = String(value.getUTCSeconds()).padStart(2, '0');
  return year + month + day + 'T' + hour + minute + second + 'Z';
}

function validRequestTarget(value: string): boolean {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith(API_BASE_PATH + '/')
    || value.includes('#') || /[\r\n\0]/.test(value)) return false;
  const parts = value.split('?');
  if (parts.length > 2) return false;
  const path = parts[0];
  return path === DEEPLINK_PATH || path.startsWith(API_BASE_PATH + '/products/');
}

function validateCredentials(value: CoupangPartnersOpenApiCredentials): void {
  if (!record(value) || typeof value.accessKey !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.accessKey)
    || typeof value.secretKey !== 'string' || value.secretKey.length < 1 || value.secretKey.length > 512
    || /[\r\n\0]/.test(value.secretKey)) {
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_CREDENTIALS_INVALID');
  }
}

function validateAffiliateCode(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_OWNER_CODE_INVALID');
  }
  return value;
}

function validateSubId(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_SUB_ID_INVALID');
  }
  return value;
}

function normalizeCoupangProductUrl(value: string): CoupangProductTarget {
  if (typeof value !== 'string' || value.length > 1024) throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_PRODUCT_URL_INVALID');
  let url: URL;
  try { url = new URL(value); } catch { throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_PRODUCT_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.origin !== 'https://www.coupang.com'
    || url.username || url.password || url.port || url.hash
    || !/^\/vp\/products\/[1-9][0-9]{0,19}$/.test(url.pathname)
    || url.searchParams.size !== 2
    || url.searchParams.getAll('itemId').length !== 1
    || url.searchParams.getAll('vendorItemId').length !== 1
    || [...url.searchParams.keys()].some((key) => key !== 'itemId' && key !== 'vendorItemId')) {
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_PRODUCT_URL_INVALID');
  }
  const productId = url.pathname.slice('/vp/products/'.length);
  const itemId = url.searchParams.get('itemId') ?? '';
  const vendorItemId = url.searchParams.get('vendorItemId') ?? '';
  if (!validProductId(itemId) || !validProductId(vendorItemId)) {
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_PRODUCT_URL_INVALID');
  }
  const canonical = 'https://www.coupang.com/vp/products/' + productId + '?itemId=' + itemId + '&vendorItemId=' + vendorItemId;
  if (value !== canonical) throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_PRODUCT_URL_NOT_CANONICAL');
  return { productId, itemId, vendorItemId, productUrl: canonical };
}

function validateShortUrl(value: string): string | null {
  if (value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || !SHORT_HOSTS.has(url.hostname.toLowerCase())
    || url.username || url.password || url.port || url.search || url.hash) return null;
  if (url.hostname.toLowerCase() === 'coupa.ng') return /^\/[A-Za-z0-9]+$/.test(url.pathname) ? url.href : null;
  return /^\/a\/[A-Za-z0-9]{1,64}$/.test(url.pathname) ? url.href : null;
}

function validateLandingUrl(value: unknown, target: CoupangProductTarget): VerifiedLanding | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== 'https://link.coupang.com'
    || url.username || url.password || url.port || url.hash || url.pathname !== '/re/AFFSDP') return null;
  const entries = [...url.searchParams.entries()];
  if (entries.length !== LANDING_QUERY_KEYS.size) return null;
  const values = new Map<string, string>();
  for (const [key, item] of entries) {
    if (!LANDING_QUERY_KEYS.has(key) || values.has(key)) return null;
    values.set(key, item);
  }
  const lptag = values.get('lptag') ?? '';
  const traceid = values.get('traceid') ?? '';
  if (values.get('pageKey') !== target.productId || values.get('itemId') !== target.itemId
    || values.get('vendorItemId') !== target.vendorItemId
    || !/^[A-Za-z0-9_-]{1,256}$/.test(lptag) || !/^[A-Za-z0-9_-]{1,128}$/.test(traceid)) return null;
  return { lptag };
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_RESPONSE_TOO_LARGE', response.status);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof CoupangPartnersOpenApiError) throw error;
    throw new CoupangPartnersOpenApiError('COUPANG_OPENAPI_OUTCOME_UNKNOWN', response.status);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function validProductId(value: string): boolean {
  return /^[1-9][0-9]{0,19}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
