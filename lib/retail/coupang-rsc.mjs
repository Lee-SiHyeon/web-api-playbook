import { createHash } from 'node:crypto';
import { coupangPublicUrl, CoupangPublicError } from './coupang-public.mjs';
import { createCoupangVisitorContext, prepareCoupangVisitorRead } from '../../service-packs/affiliate/apps/affiliate-api-hub/lib/coupang-visitor-context.mjs';
const ORIGIN = 'https://www.coupang.com', MAX = 8 * 1024 * 1024;
const tree = '["",{"children":["srp",{"children":["__PAGE__",{},null,null]},null,null]},null,null,true]';
const fail = (code, receipt) => { throw new CoupangPublicError(code, receipt); };
const clean = value => typeof value === 'string' ? value.replace(/\s+/g,' ').trim() : '';
const validId = value => (typeof value !== 'number' || Number.isSafeInteger(value)) && /^[1-9]\d{0,19}$/.test(String(value));

// Confirmed against the loaded Next.js chunk and the observed request in memory.
// _rsc is the first 12 SHA-256 bytes of router header inputs, not a session token.
export function buildCoupangRscInput(query) {
  if(typeof query!=='string'||!query.trim()||query.length>100||/[\r\n\0]/.test(query))fail('COUPANG_RSC_INPUT');
  const referer=new URL('/np/search',ORIGIN);referer.searchParams.set('q',query);referer.searchParams.set('channel','user');
  const headers={rsc:'1','next-url':'/srp','next-router-state-tree':encodeURIComponent(tree),referer:referer.href,accept:'*/*'};
  const digest=createHash('sha256').update(['0','0',headers['next-router-state-tree'],headers['next-url']].join(',')).digest();
  const url=new URL(referer);url.searchParams.set('sorter','salePriceAsc');url.searchParams.set('_rsc',digest.subarray(0,12).toString('base64url'));
  return validateCoupangRscInput({url:url.href,headers});
}

export function validateCoupangRscInput(input, { observed = false } = {}) {
  let url;
  try { url = new URL(input.url); } catch { fail('COUPANG_RSC_INPUT'); }
  const keys = [...url.searchParams.keys()];
  if (url.origin !== ORIGIN || url.pathname !== '/np/search' || url.username || url.password || url.hash
    || new Set(keys).size !== keys.length || keys.some(k => !['q','channel','sorter','_rsc',...(observed?['component','traceId']:[])].includes(k))
    || observed && (url.searchParams.has('component') && url.searchParams.get('component') !== ''
      || url.searchParams.has('traceId') && !/^[A-Za-z0-9._-]{1,128}$/.test(url.searchParams.get('traceId')))
    || !url.searchParams.get('q')?.trim() || url.searchParams.get('q').length > 100
    || !['user','recent','undefined','relate'].includes(url.searchParams.get('channel'))
    || url.searchParams.get('sorter') !== 'salePriceAsc' || !/^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get('_rsc') ?? '')) fail('COUPANG_RSC_INPUT');
  const headers = input.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)
    || Object.keys(headers).some(k => !['rsc','next-url','next-router-state-tree','referer','accept',...(observed?
      ['user-agent','sec-ch-ua','sec-ch-ua-platform','sec-ch-ua-mobile','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','priority','accept-language','cache-control']:[])].includes(k))
    || Object.values(headers).some(v => typeof v !== 'string' || v.length > 16384 || /[\r\n\0]/.test(v))
    || JSON.stringify(headers).length > 32768
    || headers.rsc !== '1' || headers['next-url'] !== '/srp' || (headers.accept !== '*/*' && !(observed && headers.accept === undefined))) fail('COUPANG_RSC_HEADERS');
  try {
    if (decodeURIComponent(headers['next-router-state-tree']) !== tree) fail('COUPANG_RSC_HEADERS');
    const referer = new URL(headers.referer);
    if (referer.origin !== ORIGIN || referer.pathname !== '/np/search' || referer.username || referer.password || referer.hash
      || referer.searchParams.get('q') !== url.searchParams.get('q')) fail('COUPANG_RSC_HEADERS');
  } catch { fail('COUPANG_RSC_HEADERS'); }
  return { url: url.href, headers: { ...headers } };
}

export function parseCoupangRsc(body, sourceUrl) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX) fail('COUPANG_RSC_SIZE');
  const lists = []; let visits = 0;
  function walk(value, depth = 0) {
    if (++visits > 250000 || depth > 80) fail('COUPANG_RSC_STRUCTURE_LIMIT');
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.products) && value.products.length > 0
      && value.products.every(p => p && validId(p.legacyProductId) && typeof p.link === 'string' && p.imageAndTitleArea)) lists.push(value.products);
    for (const item of Object.values(value)) if (item && typeof item === 'object') walk(item, depth + 1);
  }
  for (const line of body.split('\n')) {
    const match = /^([\da-f]+):([\[{].*)$/i.exec(line);
    if (!match) continue;
    let model; try { model = JSON.parse(match[2]); } catch { continue; }
    walk(model);
  }
  if (lists.length !== 1 || lists[0].length > 1000) fail('COUPANG_RSC_LIST_MISSING_OR_AMBIGUOUS');
  const products = lists[0].map(p => {
    const url = coupangPublicUrl(p.link), u = url ? new URL(url) : null;
    const price = p.priceArea?.i18nSalesPrice;
    const amount = price?.amount;
    if (!u || u.origin !== ORIGIN || !/^\/vp\/products\/[1-9]\d*$/.test(u.pathname)
      || u.pathname.split('/').at(-1) !== String(p.legacyProductId) || !validId(p.vendorItemId)
      || u.searchParams.get('vendorItemId') !== String(p.vendorItemId) || !validId(u.searchParams.get('itemId'))
      || !clean(p.imageAndTitleArea.title) || price?.currency !== 'KRW' || price.fractionDigits !== 0
      || !/^\d+$/.test(String(amount)) || !Number.isSafeInteger(Number(amount))) fail('COUPANG_RSC_PRODUCT_SCHEMA');
    return { productId: String(p.legacyProductId), itemId: u.searchParams.get('itemId'), vendorItemId: String(p.vendorItemId),
      productUrl: url, title: clean(p.imageAndTitleArea.title), price: { amount: Number(amount), currency: 'KRW',
        label: clean(p.priceArea.price), basis: 'rsc_displayed_sales_price', accountApplied: false },
      shippingLabel: clean(p.priceArea.shippingFeeDescription), sponsored: p.adBadgeArea?.sponsored === true,
      rating: typeof p.reviewArea?.ratingAverage === 'number' ? p.reviewArea.ratingAverage : null,
      reviewCount: Number.isSafeInteger(p.reviewArea?.ratingCount) ? p.reviewArea.ratingCount : null };
  });
  return { kind: 'retail_rsc_listing', sourceUrl: coupangPublicUrl(sourceUrl), products,
    pagination: { hasNext: null, completeCatalog: false }, membershipEligibilityVerified: false };
}

export async function readCoupangRsc(input, { authentication = 'anonymous', fetchImpl = globalThis.fetch } = {}) {
  if (!['anonymous','visitor'].includes(authentication)) fail('COUPANG_RSC_AUTH_INPUT');
  const { url, headers } = validateCoupangRscInput(input);
  const receipt = { origin: ORIGIN, path: '/np/search', queryFields: [...new URL(url).searchParams.keys()],
    headerNames: Object.keys(headers), authenticationMode: authentication, cookieSent: false, ownerCredentialUsed: false,
    browserUsedForTransport: false, inputSource: 'observed_browser_request', runtimeInputsPersisted: false,
    status: null, contentType: null, server: null, retries: 0, redirectsFollowed: false };
  if (authentication === 'visitor') {
    try {
      const context = createCoupangVisitorContext({ fetchImpl, allowRebootstrap: false });
      const prepared = await prepareCoupangVisitorRead({ context, target: url, operation: 'retail_search_rsc', fetchImpl });
      headers.cookie = prepared.cookie; receipt.visitorCookieNames = prepared.cookieNames; receipt.visitorBootstrap = prepared.bootstrapReceipt;
    } catch (e) { fail(e.code ?? 'COUPANG_RSC_VISITOR_FAILED', { ...receipt, visitorBootstrap: e.receipt ?? null }); }
  }
  let response;
  try { receipt.cookieSent = !!headers.cookie; response = await fetchImpl(url, { method: 'GET', headers, credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(20000) }); }
  catch { fail('COUPANG_RSC_TRANSPORT', receipt); }
  receipt.status = response.status; receipt.contentType = response.headers.get('content-type')?.split(';')[0] ?? null;
  receipt.server = /^(?:envoy|AkamaiGHost|cloudflare)$/i.test(response.headers.get('server') ?? '') ? response.headers.get('server') : null;
  let size = 0; const chunks = [];
  for await (const chunk of response.body ?? []) { size += chunk.length; if (size > MAX) fail('COUPANG_RSC_SIZE', receipt); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks); receipt.bytes = bytes.length; receipt.bodySha256 = createHash('sha256').update(bytes).digest('hex');
  const text = bytes.toString('utf8'); receipt.accessDeniedTitle = /<title\b[^>]*>\s*Access Denied\s*<\/title>/i.test(text);
  if (response.redirected || response.url && response.url !== url) fail('COUPANG_RSC_REDIRECT', receipt);
  if (response.status !== 200) fail(`COUPANG_RSC_HTTP_${response.status}`, receipt);
  if (receipt.contentType !== 'text/x-component') fail('COUPANG_RSC_CONTENT_TYPE', receipt);
  let data; try { data = parseCoupangRsc(text, url); } catch (e) { e.receipt = receipt; throw e; }
  return { ok: true, checkedAt: new Date().toISOString(), executionMode: 'pure_http_with_observed_inputs', receipt, data,
    projectionSha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
    states: { captured: true, client_exists: true, remnant_free: 'transport_only_inputs_currently_browser_observed',
      credential_propagated: 'not_applicable_anonymous', live_replay: fetchImpl === globalThis.fetch } };
}
