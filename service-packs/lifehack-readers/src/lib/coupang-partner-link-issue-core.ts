export const COUPANG_PARTNER_LINK_ISSUANCE = 'observed_provider_short_url' as const;
const SHORT_URL = /^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]{1,64}$/;
const ID = /^[1-9][0-9]{0,19}$/;

export interface CoupangExactProductTarget {
  readonly productId: string;
  readonly itemId: string;
  readonly vendorItemId: string;
  readonly identity: string;
  readonly productUrl: string;
}

export interface CoupangObservedIssueResponse {
  readonly shortUrl: string;
  readonly productUrl: string;
  readonly lptag: string | null;
  readonly expectedAffiliateCode: string;
  readonly verification: typeof COUPANG_PARTNER_LINK_ISSUANCE;
  readonly destinationVerified: boolean;
  readonly destinationVerification: typeof COUPANG_PARTNER_LINK_ISSUANCE | 'generation_response_only';
  readonly attributionVerified: boolean;
  readonly independentReadbackVerified: false;
}

export class CoupangPartnerLinkIssueError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'CoupangPartnerLinkIssueError';
    this.code = code;
  }
}

export function normalizeCoupangExactProductTarget(value: unknown): CoupangExactProductTarget | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== 'https://www.coupang.com' || url.username || url.password
    || url.port || url.hash || !/^\/vp\/products\/[1-9][0-9]{0,19}$/.test(url.pathname)
    || url.searchParams.size !== 2 || url.searchParams.getAll('itemId').length !== 1
    || url.searchParams.getAll('vendorItemId').length !== 1
    || [...url.searchParams.keys()].some((key) => key !== 'itemId' && key !== 'vendorItemId')) return null;
  const productId = url.pathname.slice('/vp/products/'.length);
  const itemId = url.searchParams.get('itemId') ?? '';
  const vendorItemId = url.searchParams.get('vendorItemId') ?? '';
  if (!ID.test(productId) || !ID.test(itemId) || !ID.test(vendorItemId)) return null;
  const canonical = `https://www.coupang.com/vp/products/${productId}?itemId=${itemId}&vendorItemId=${vendorItemId}`;
  if (canonical !== value) return null;
  return { productId, itemId, vendorItemId, identity: `${productId}:${itemId}:${vendorItemId}`, productUrl: canonical };
}

/**
 * Matches the observed Playbook response contract for GET /api/v1/url/any.
 * This parser does not open the provider short URL. A separate bounded public
 * redirect check may resolve it once. If the source returns a landing URL, that
 * URL must identify this exact product variant and any lptag must match the
 * freshly owner-verified affiliate code.
 */
export function parseCoupangObservedIssueResponse(
  response: { status: number; headers: Record<string, string>; raw: string },
  target: CoupangExactProductTarget,
  expectedAffiliateCode: string,
): CoupangObservedIssueResponse {
  if (!target || normalizeCoupangExactProductTarget(target.productUrl)?.identity !== target.identity
    || typeof expectedAffiliateCode !== 'string' || !expectedAffiliateCode
    || expectedAffiliateCode.length > 256 || /[\u0000-\u001f\u007f]/.test(expectedAffiliateCode)) {
    throw new CoupangPartnerLinkIssueError('COUPANG_LINK_ISSUANCE_INPUT_INVALID');
  }
  if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')
    || typeof response.raw !== 'string' || response.raw.length > 256 * 1024) {
    throw new CoupangPartnerLinkIssueError('COUPANG_LINK_OUTCOME_UNKNOWN');
  }
  let body: unknown;
  try { body = JSON.parse(response.raw); } catch { throw new CoupangPartnerLinkIssueError('COUPANG_LINK_OUTCOME_UNKNOWN'); }
  if (!isRecord(body) || body.rCode !== '0' || !isRecord(body.data)) {
    throw new CoupangPartnerLinkIssueError('COUPANG_LINK_OUTCOME_UNKNOWN');
  }
  const data = body.data;
  if (typeof data.shortUrl !== 'string' || !SHORT_URL.test(data.shortUrl)) {
    throw new CoupangPartnerLinkIssueError('COUPANG_LINK_OUTCOME_UNKNOWN');
  }

  let destinationVerified = false;
  let lptag: string | null = null;
  if (Object.hasOwn(data, 'landingUrl')) {
    const landing = observedLanding(data.landingUrl, target, data.type);
    if (!landing) throw new CoupangPartnerLinkIssueError('COUPANG_LINK_OUTCOME_UNKNOWN');
    destinationVerified = true;
    lptag = landing.lptag;
  }
  const attributionVerified = lptag !== null && lptag === expectedAffiliateCode;
  if (lptag !== null && !attributionVerified) {
    throw new CoupangPartnerLinkIssueError('COUPANG_LINK_ATTRIBUTION_MISMATCH');
  }
  return {
    shortUrl: data.shortUrl,
    productUrl: target.productUrl,
    lptag: attributionVerified ? lptag : null,
    expectedAffiliateCode,
    verification: COUPANG_PARTNER_LINK_ISSUANCE,
    destinationVerified,
    destinationVerification: destinationVerified ? 'generation_response_only' : COUPANG_PARTNER_LINK_ISSUANCE,
    attributionVerified,
    independentReadbackVerified: false,
  };
}

/** Returns true only when an unauthenticated public redirect exposes exact SKU and owner lptag. */
export function verifiesCoupangPublicRedirectTarget(
  location: string,
  target: CoupangExactProductTarget,
  expectedAffiliateCode: string,
): boolean {
  const direct = productIdentity(location, true);
  if (direct && sameIdentity(direct, target)) return direct.lptag === expectedAffiliateCode;
  const landing = observedLanding(location, target, 'sdp');
  return landing !== null && landing.lptag === expectedAffiliateCode;
}

function observedLanding(value: unknown, target: CoupangExactProductTarget, responseType: unknown): { lptag: string | null } | null {
  const direct = productIdentity(value, true);
  if (direct && sameIdentity(direct, target)) return { lptag: direct.lptag };
  if (responseType !== 'sdp' || typeof value !== 'string' || value.length > 4096) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== 'https://link.coupang.com' || url.username || url.password
    || url.port || url.hash || url.pathname !== '/re/AFFSDP') return null;
  const entries = [...url.searchParams.entries()];
  const expectedKeys = new Set(['lptag', 'pageKey', 'itemId', 'vendorItemId', 'traceid']);
  if (entries.length !== expectedKeys.size) return null;
  const values = new Map<string, string>();
  for (const [key, item] of entries) {
    if (!expectedKeys.has(key) || values.has(key)) return null;
    values.set(key, item);
  }
  const candidateTag = values.get('lptag') ?? '';
  const traceid = values.get('traceid') ?? '';
  if (values.get('pageKey') !== target.productId || values.get('itemId') !== target.itemId
    || values.get('vendorItemId') !== target.vendorItemId || !/^[A-Za-z0-9_-]{1,256}$/.test(candidateTag)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(traceid)) return null;
  return { lptag: candidateTag };
}

function productIdentity(value: unknown, allowLptag: boolean): (CoupangExactProductTarget & { lptag: string | null }) | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== 'https://www.coupang.com' || url.username || url.password
    || url.port || url.hash || !/^\/vp\/products\/[1-9][0-9]{0,19}$/.test(url.pathname)) return null;
  const allowed = new Set(allowLptag ? ['itemId', 'vendorItemId', 'lptag'] : ['itemId', 'vendorItemId']);
  const entries = [...url.searchParams.entries()];
  if (entries.some(([key]) => !allowed.has(key))
    || entries.some(([key]) => url.searchParams.getAll(key).length !== 1)) return null;
  const productId = url.pathname.slice('/vp/products/'.length);
  const itemId = url.searchParams.get('itemId') ?? '';
  const vendorItemId = url.searchParams.get('vendorItemId') ?? '';
  const lptag = url.searchParams.getAll('lptag');
  if (!ID.test(productId) || !ID.test(itemId) || !ID.test(vendorItemId) || lptag.length > 1
    || (lptag.length === 1 && !/^[A-Za-z0-9_-]{1,256}$/.test(lptag[0]))) return null;
  return {
    productId,
    itemId,
    vendorItemId,
    identity: `${productId}:${itemId}:${vendorItemId}`,
    productUrl: `https://www.coupang.com/vp/products/${productId}?itemId=${itemId}&vendorItemId=${vendorItemId}`,
    lptag: lptag[0] ?? null,
  };
}

function sameIdentity(left: CoupangExactProductTarget, right: CoupangExactProductTarget): boolean {
  return left.productId === right.productId && left.itemId === right.itemId && left.vendorItemId === right.vendorItemId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
