import { ScopedSession } from '../scoped-session.mjs';

const ORIGIN = 'https://ko.aliexpress.com';
const ROUTE = '/aeglodetailweb/api/seo/seodata';
const PRODUCT_ID = /^[0-9]{8,20}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class AliExpressPublicError extends Error {
  constructor(code, receipt = null) {
    super(code);
    this.name = 'AliExpressPublicError';
    this.code = code;
    this.receipt = receipt;
  }
}

function fail(code, receipt) {
  throw new AliExpressPublicError(code, receipt);
}

function canonicalProductUrl(markup, productId) {
  if (typeof markup !== 'string' || markup.length > 4096) return null;
  const href = /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']\s*\/?\s*>/i.exec(markup)?.[1];
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.origin !== ORIGIN || url.pathname !== `/item/${productId}.html`
      || url.search || url.hash || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

// The SEO title is "<product name> - AliExpress". On 2026-10-16 the endpoint (and the
// item Document og:title) returned the bare suffix " - AliExpress " for some items, with
// or without `subject`. Strip the site suffix and report null instead of a fake title.
const TITLE_SUFFIX = /\s*[-|–]\s*ali\s*express(?:\.com)?\s*$/i;
export function cleanAliExpressTitle(raw) {
  if (typeof raw !== 'string') return null;
  const title = raw.replace(TITLE_SUFFIX, '').replace(/\s+/g, ' ').trim().replace(/^[-|–\s]+|[-|–\s]+$/g, '').trim();
  return title && !/^ali\s*express$/i.test(title) ? title : null;
}

/**
 * Anonymous product SEO metadata observed on the desktop item page, 2026-10-05.
 * The browser sends a `subject` listing title. Independent replay confirmed
 * that field is optional when the exact item Referer is present. The endpoint
 * does not provide a verified offer price, stock, search, or category.
 */
export function createAliExpressPublicClient({ fetchImpl, now = Date.now } = {}) {
  if (typeof now !== 'function') fail('ALIEXPRESS_OPTIONS_INVALID');
  const session = new ScopedSession({
    allowedOrigins: [ORIGIN],
    cookieOrigins: [],
    ...(fetchImpl ? { fetchImpl } : {}),
    defaultHeaders: { accept: 'application/json' },
    timeoutMs: 15_000,
    maxResponseBytes: 256 * 1024,
    maxRequestBytes: 1024,
    maxRedirects: 0,
  });

  return {
    async getProductSeo({ productId, subject } = {}) {
      if (typeof productId !== 'string' || !PRODUCT_ID.test(productId)
        || subject !== undefined && (typeof subject !== 'string' || subject.length < 1 || subject.length > 300
          || !subject.trim() || /[\r\n\0]/.test(subject))) fail('ALIEXPRESS_INPUT_INVALID');
      const itemUrl = `${ORIGIN}/item/${productId}.html`;
      const url = new URL(ROUTE, ORIGIN);
      url.search = new URLSearchParams({ channel: 'detail', device: 'pc', productId,
        ...(subject === undefined ? {} : { subject }) }).toString();
      const receipt = {
        method: 'GET', origin: ORIGIN, path: ROUTE, checkedAt: new Date(now()).toISOString(),
        browserUsed: false, anonymous: true, cookieSent: false,
      };
      let response;
      try {
        response = await session.request(url.href, { headers: { referer: itemUrl } });
      } catch (error) {
        if (error?.code === 'SCOPED_SESSION_REDIRECT_LIMIT') fail('ALIEXPRESS_REDIRECTED', receipt);
        if (error?.code === 'SCOPED_SESSION_RESPONSE_TOO_LARGE') fail('ALIEXPRESS_RESPONSE_TOO_LARGE', receipt);
        if (error?.code === 'SCOPED_SESSION_TIMEOUT') fail('ALIEXPRESS_TIMEOUT', receipt);
        fail('ALIEXPRESS_TRANSPORT_FAILED', receipt);
      }
      receipt.httpStatus = response.status;
      receipt.mime = response.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? null;
      receipt.responseBytes = Buffer.byteLength(response.raw);
      if (response.status === 429) fail('ALIEXPRESS_THROTTLED', receipt);
      if (response.status === 403) fail('ALIEXPRESS_ACCESS_BLOCKED', receipt);
      if (response.status !== 200 || receipt.mime !== 'application/json') fail('ALIEXPRESS_RESPONSE_INVALID', receipt);
      let data;
      try { data = JSON.parse(response.raw); } catch { fail('ALIEXPRESS_RESPONSE_INVALID', receipt); }
      const body = data?.body;
      const canonicalUrl = canonicalProductUrl(body?.canonical, productId);
      if (!object(data) || data.code !== 200 || data.success !== true || !object(body)
        || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 2000
        || typeof body.description !== 'string' || body.description.length > 20_000
        || canonicalUrl === null) fail('ALIEXPRESS_SCHEMA_INVALID', receipt);
      const title = cleanAliExpressTitle(body.title);
      return {
        productId,
        title,
        titleSource: title ? 'seo_title_suffix_stripped' : 'unavailable_site_returned_suffix_only',
        seoTitleRaw: body.title,
        description: body.description,
        canonicalUrl,
        price: null,
        currency: null,
        receipt: { ...receipt, schemaVerified: true, productIdMatched: true },
      };
    },
  };
}
