import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { createCoupangVisitorContext, prepareCoupangVisitorRead, rotateCoupangVisitorCookies,
  CoupangVisitorError } from '../../service-packs/affiliate/apps/affiliate-api-hub/lib/coupang-visitor-context.mjs';
import { isStrongPublicChallenge } from '../../service-packs/affiliate/apps/affiliate-api-hub/lib/cps-public-reader.mjs';

const WWW = 'https://www.coupang.com', TRIP = 'https://trip.coupang.com';
const MAX_BYTES = 6 * 1024 * 1024;
const clean = v => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = v => (typeof v !== 'number' || Number.isSafeInteger(v)) && /^(?:0|[1-9]\d{0,19})$/.test(String(v));
const integer = v => Number.isSafeInteger(v) && v >= 0;
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const QUERY = new Set('q keyword page listSize sorter filter filters filterType rating channel landingId mlpPageId itemId vendorItemId productId categoryId productType travelSearchType dateSearchType checkIn checkOut numberOfAdults childrenAges regionId linkCode selectDate sortBy displayCategoryCode pickUpDate pickUpTime dropOffDate dropOffTime'.split(' '));

export class CoupangPublicError extends Error {
  constructor(code, receipt = null) { super(code); this.code = code; this.receipt = receipt; }
}
const fail = (code, receipt) => { throw new CoupangPublicError(code, receipt); };

/** Public identity only. Tracking, session identifiers, signed inputs and fragments never persist. */
export function coupangPublicUrl(value, base = WWW) {
  try {
    const u = new URL(value, base);
    if (u.protocol !== 'https:' || u.username || u.password || u.port
      || !['www.coupang.com', 'trip.coupang.com', 'travel.coupang.com', 'pages.coupang.com'].includes(u.hostname)) return null;
    const query = new URLSearchParams();
    for (const [k, v] of u.searchParams) if (QUERY.has(k)) query.append(k, v);
    return u.origin + u.pathname + (query.size ? `?${query}` : '');
  } catch { return null; }
}

function money(p) {
  if (!object(p) || (p.salePrice != null && !integer(p.salePrice))) fail('COUPANG_PRICE_SCHEMA');
  const amount = k => p[k] == null ? null : integer(p[k]) ? p[k] : fail('COUPANG_PRICE_SCHEMA');
  return { salePrice: p.salePrice ?? null, priceAvailable: p.salePrice != null, originalPrice: amount('originalPrice'), discountPrice: amount('discountPrice'),
    discountedSalePrice: amount('discountedSalePrice'), totalSalesPrice: amount('totalSalesPrice'),
    totalDiscountedPrice: amount('totalDiscountedPrice'), unitPeriod: p.unitPeriod ?? null,
    description: clean(p.description), priceTag: clean(p.priceTag),
    membershipCondition: p.wowMemberOnlyPromotionFlag === true ? 'wow_member_only'
      : /member-only/.test(p.badge?.imageUrl ?? '') ? 'member_only' : 'not_verified',
    currency: 'KRW', currencyBasis: 'observed_Korean_storefront_won_label', accountApplied: false };
}

function pagination(p, count) {
  if (!object(p) || !integer(p.page) || !integer(p.totalCount) || !integer(p.totalPages)
    || !integer(p.countPerPage) || (p.countPerPage === 0 && (p.totalCount !== 0 || count !== 0))
    || count > p.countPerPage) fail('COUPANG_PAGINATION_SCHEMA');
  return { page: p.page, countPerPage: p.countPerPage, totalCount: p.totalCount, totalPages: p.totalPages,
    hasNext: typeof p.hasNext === 'boolean' ? p.hasNext : null,
    hasPrevious: typeof p.hasPrevious === 'boolean' ? p.hasPrevious : null };
}

export function parseTravelSearch(data) {
  const result = data?.searchResult ?? data;
  const group = result?.products;
  if (!object(group) || !Array.isArray(group.result)) fail('COUPANG_TRAVEL_SEARCH_SCHEMA');
  const products = group.result.map(p => {
    if (!id(p.productId) || !clean(p.productName) || !clean(p.productType)) fail('COUPANG_TRAVEL_PRODUCT_SCHEMA');
    return { productId: String(p.productId), title: clean(p.productName), productType: p.productType,
      productDetailType: p.productDetailType ?? null, itemId: id(p.itemId) ? String(p.itemId) : null,
      vendorItemId: id(p.vendorItemId) ? String(p.vendorItemId) : null,
      price: money(p.price), reviewCount: integer(p.productReview?.ratingCount) ? p.productReview.ratingCount : null,
      ratingAverage: typeof p.productReview?.ratingAverage === 'number' ? p.productReview.ratingAverage : null,
      isSoldOut: typeof p.stock?.isSoldOut === 'boolean' ? p.stock.isSoldOut : null,
      // This field, not productId, identifies the UI's /tp/products route.
      packageProductId: id(p.vendorItemPackageId) ? String(p.vendorItemPackageId) : null,
      productUrl: id(p.vendorItemPackageId) ? `${TRIP}/tp/products/${p.vendorItemPackageId}` : null,
      detailState: id(p.vendorItemPackageId) ? 'pending' : 'needs_observed_package_url' };
  });
  const page = pagination(group.pagination, products.length);
  if (!products.length && page.totalCount !== 0) fail('COUPANG_TRAVEL_EMPTY_PAGE');
  return { kind: 'travel_listing', products, pagination: page,
    context: { keyword: clean(result.currentValue?.keyword), checkIn: result.currentValue?.checkInDate ?? null,
      checkOut: result.currentValue?.checkOutDate ?? null, checkInTime: result.currentValue?.checkInTime ?? null,
      checkOutTime: result.currentValue?.checkOutTime ?? null, numberOfAdults: result.currentValue?.numberOfAdults ?? null,
      childrenAges: result.currentValue?.childrenAges ?? null, dateSearchType: result.currentValue?.dateSearchType ?? null },
    sortOptions: (result.sort?.filterValues ?? []).map(x => ({ label: clean(x.text), value: clean(x.value), selected: x.selected === true })),
    completeCatalog: false };
}

export function parseTravelRooms(data) {
  if (!id(data?.productId) || !Array.isArray(data.rooms) || !integer(data.days)) fail('COUPANG_TRAVEL_ROOMS_SCHEMA');
  return { kind: 'travel_rooms', productId: String(data.productId), nights: data.days,
    context: { checkIn: data.defaultValue?.checkIn ?? null, checkOut: data.defaultValue?.checkOut ?? null,
      numberOfAdults: data.defaultValue?.numberOfAdults ?? null, childrenAges: data.defaultValue?.childrenAges ?? [] },
    rooms: data.rooms.map(r => {
      if (!id(r.vendorItemId) || !id(r.itemId) || !clean(r.vendorItemName) || !Array.isArray(r.rateCategories)) fail('COUPANG_TRAVEL_ROOM_SCHEMA');
      return { vendorItemId: String(r.vendorItemId), itemId: String(r.itemId), name: clean(r.vendorItemName),
        rates: r.rateCategories.map(c => ({ rateCategoryId: c.rateCategoryId == null ? null : String(c.rateCategoryId),
          numberOfGuests: c.numberOfGuests ?? null, price: money(c.price),
          stockCount: integer(c.stock?.stockCount) ? c.stock.stockCount : null,
          isSoldOut: typeof c.stock?.isSoldOut === 'boolean' ? c.stock.isSoldOut : null,
          saleStatus: clean(c.saleStatus), conditions: (c.ratePlans ?? []).map(x => clean(x.ratePlan)).filter(Boolean) })) };
    }), bookingSubmitted: false };
}

export function parseTravelReviews(data) {
  if (!Array.isArray(data?.result)) fail('COUPANG_TRAVEL_REVIEWS_SCHEMA');
  return { kind: 'travel_reviews', pagination: pagination(data.pagination, data.result.length), reviews: data.result.map(r => {
    if (!id(r.reviewId) || !id(r.productId) || typeof r.rating !== 'number') fail('COUPANG_TRAVEL_REVIEW_SCHEMA');
    // No author identities, access passes, attachment tokens or full review prose in catalog artifacts.
    return { reviewId: String(r.reviewId), productId: String(r.productId), rating: r.rating,
      itemName: clean(r.itemName), reviewedAt: r.reviewContent?.reviewAt ?? r.reviewContent?.createdAt ?? null };
  }) };
}

export function parseTravelTicketOptions(data) {
  if (!id(data?.productId) || !Array.isArray(data.travelItems)) fail('COUPANG_TRAVEL_OPTIONS_SCHEMA');
  return { kind: 'travel_ticket_options', productId: String(data.productId), options: data.travelItems.map(t => {
    // These IDs exceed Number.MAX_SAFE_INTEGER. The service supplies their exact decimal strings.
    const travelItemId = t.travelItemIdStr ?? t.travelItemId;
    if (!id(travelItemId) || !clean(t.travelItemName) || !Array.isArray(t.vendorItems)) fail('COUPANG_TRAVEL_OPTION_SCHEMA');
    return { travelItemId: String(travelItemId), name: clean(t.travelItemName),
      validFrom: t.useStartedAt ?? null, validTo: t.useEndedAt ?? null,
      vendorItems: t.vendorItems.map(v => {
        const vendorItemId = v.vendorItemIdStr ?? v.vendorItemId;
        if (!id(vendorItemId)) fail('COUPANG_TRAVEL_OPTION_ID');
        return { vendorItemId: String(vendorItemId), name: clean(v.vendorItemName), price: money(v.price),
          stockCount: integer(v.stockCount) ? v.stockCount : null, saleStatus: clean(v.saleStatus) };
      }) };
  }), purchaseSubmitted: false };
}

export function parseCoupangCategories(data) {
  if (!object(data?.data?.gnb)) fail('COUPANG_CATEGORIES_SCHEMA');
  const nodes = [], edges = [], seen = new Set(); let visited = 0;
  function walk(v, parent, depth, path) {
    if (++visited > 100000 || depth > 32) fail('COUPANG_CATEGORIES_LIMIT');
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, parent, depth + 1, `${path}[${i}]`)); return; }
    const url = typeof v.linkUri === 'string' ? coupangPublicUrl(v.linkUri) : null;
    let nextParent = parent;
    if (clean(v.name) && url && /^\/np\/(?:categories|campaigns)\//.test(new URL(url).pathname)) {
      if (!seen.has(url)) { nodes.push({ url, label: clean(v.name), categoryId: String(v.linkCode ?? v.id),
        depth, sourcePath: path, state: 'pending', evidenceSource: 'direct_replay' }); seen.add(url); }
      if (parent && parent !== url) edges.push({ from: parent, to: url, kind: 'category_child' });
      nextParent = url;
    }
    for (const [k, x] of Object.entries(v)) if (x && typeof x === 'object' && !/ABTarget|Assets|Banner|Meta/.test(k)) walk(x, nextParent, depth + 1, `${path}.${k}`);
  }
  walk(data.data.gnb, null, 0, 'data.gnb');
  if (!nodes.length) fail('COUPANG_CATEGORIES_SCHEMA');
  return { kind: 'category_tree', nodes, edges, completeCatalog: false, catalogListingsRead: 0 };
}

function jsonScript(document, scriptId) {
  const node = document.getElementById(scriptId);
  if (!node) return null;
  try { return JSON.parse(node.textContent); } catch { fail('COUPANG_EMBEDDED_JSON_INVALID'); }
}

/** Parses only the received Document. Initial HTML and hydrated DOM coverage stay separate. */
export function parseCoupangDocument(html, sourceUrl) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BYTES) fail('COUPANG_RESPONSE_LIMIT');
  const document = parseHTML(html).document, title = clean(document.querySelector('title')?.textContent);
  if (/access denied|just a moment|verify you are human/i.test(title)
    || document.querySelector('#challenge-form, #px-captcha')) fail('COUPANG_CHALLENGE');
  const navigation = [], seen = new Set();
  const add = (label, href, edgeType = 'link') => {
    const url = coupangPublicUrl(href, sourceUrl);
    if (!url || seen.has(url) || !/^(?:\/$|\/(?:tp|np|vp)\/(?:categories|campaigns|products)\/\d+$|\/(?:tp|np)\/search$|\/np\/(?:coupangglobal|omp)$|\/p\/(?:\d+|bep)$|\/mlp\/web\/mlp-landing-page$)/.test(new URL(url).pathname)) return;
    seen.add(url); navigation.push({ label: clean(label), url, edgeType, state: 'pending' });
  };
  for (const a of document.querySelectorAll('a[href]')) add(a.textContent || a.querySelector('img')?.getAttribute('alt'), a.getAttribute('href'));
  const banners = jsonScript(document, 'travel-banners-data');
  for (const group of [banners?.domesticTravelCategory, banners?.internationalTravelCategory, banners?.travelCategory]) {
    for (const c of group?.subCategories ?? []) {
      if (!id(c.linkCode)) fail('COUPANG_CATEGORY_ID_INVALID');
      // UI-click verified routes; live flights retain their separately observed legacy host.
      const url = String(c.linkCode) === '396580' ? `https://travel.coupang.com/np/categories/${c.linkCode}` : `${TRIP}/tp/categories/${c.linkCode}`;
      add(c.name, url, 'travel_category');
    }
  }
  const search = jsonScript(document, 'travel-search-result-data');
  if (search) {
    const parsed = parseTravelSearch(search), requestedPage = new URL(sourceUrl).searchParams.get('page');
    if (requestedPage !== null && parsed.pagination.page !== Number(requestedPage)) fail('COUPANG_PAGE_MISMATCH');
    return { ...parsed, sourceUrl, title, navigation, sourceFormat: 'document_embedded_json' };
  }
  const detail = jsonScript(document, 'travel-detail-product-data');
  if (detail) {
    if (!id(detail.productBasis?.vendorItemPackageId) || !id(detail.product?.productId)
      || String(detail.productBasis.vendorItemPackageId) !== new URL(sourceUrl).pathname.split('/').at(-1)) fail('COUPANG_TRAVEL_DETAIL_SCHEMA');
    const p = detail.product;
    const components = jsonScript(document, 'travel-detail-component-data');
    const rental = components?.rentalCarSearchOption;
    const context = rental ? Object.fromEntries(['pickUpDate','pickUpTime','dropOffDate','dropOffTime'].map(k=>[k,rental[k]??null]))
      : Object.fromEntries([...new URL(sourceUrl).searchParams].filter(([k])=>['checkIn','checkOut','numberOfAdults','childrenAges','selectDate'].includes(k)));
    const representative = p.representativeVendorItem;
    const representativeOption = p.productType === 'RENTAL_CAR' && id(representative?.vendorItemIdStr ?? representative?.vendorItemId)
      ? {vendorItemId:String(representative.vendorItemIdStr ?? representative.vendorItemId),name:clean(representative.vendorItemName),
        rateCategoryName:clean(representative.rateCategoryName),stockCount:integer(representative.stockCount)?representative.stockCount:null,
        coverage:'representative_only',allOptionsVerified:false} : null;
    const optionTables = [...document.querySelectorAll('#productTabs table, #lodgingTabs table')]
      .map(t => ({ headers: [...t.querySelectorAll('tr:first-child th, tr:first-child td')].map(x => clean(x.textContent)),
        rows: [...t.querySelectorAll('tr')].slice(1).map(r => [...r.querySelectorAll('td')].map(x => clean(x.textContent))) }));
    return { kind: 'travel_detail', sourceUrl, title, navigation, packageProductId: String(detail.productBasis.vendorItemPackageId),
      productId: String(p.productId), productType: p.productType, name: clean(p.productName),
      price: p.representativeVendorItem?.price ? money(p.representativeVendorItem.price) : null,
      context, representativeOption,
      optionTables, sourceFormat: 'document_embedded_json_and_tables',
      completeOptions: optionTables.some(t => t.rows.length > 0), accountAppliedPriceVerified: false };
  }
  const cards = [...document.querySelectorAll('#product-list > li')].filter(li => li.querySelector('a[href*="/vp/products/"]'));
  if (cards.length) {
    const products = cards.map(li => {
      const a = li.querySelector('a[href*="/vp/products/"]'), url = coupangPublicUrl(a.getAttribute('href'), sourceUrl);
      const name = clean(li.querySelector('[class*="productName"]')?.textContent || li.querySelector('img')?.getAttribute('alt'));
      if (!url || !name) fail('COUPANG_RETAIL_CARD_SCHEMA');
      const u = new URL(url);
      return { productId: u.pathname.split('/').at(-1), itemId: u.searchParams.get('itemId'), vendorItemId: u.searchParams.get('vendorItemId'),
        title: name, productUrl: url, priceLabel: clean(li.querySelector('[class*="priceArea"]')?.textContent),
        shippingLabel: clean(li.querySelector('[data-badge-type="feePrice"]')?.textContent),
        ratingLabel: clean(li.querySelector('[class*="productRating"]')?.textContent),
        sponsored: /광고/.test(li.textContent), accountAppliedPriceVerified: false };
    });
    const source = new URL(sourceUrl), nextLink = [...document.querySelectorAll('a[href]')].find(a => clean(a.textContent) === '다음');
    const candidate = nextLink ? coupangPublicUrl(nextLink.getAttribute('href'), sourceUrl) : null;
    const next = candidate ? new URL(candidate) : null;
    const nextUrl = next && next.origin === source.origin && next.pathname === source.pathname
      && next.searchParams.get('q') === source.searchParams.get('q') && Number(next.searchParams.get('page')) > Number(source.searchParams.get('page') ?? 1) ? next.href : null;
    return { kind: 'retail_listing', sourceUrl, title, products, navigation, sourceFormat: 'document_html',
      pagination: { page: Number(source.searchParams.get('page') ?? 1), hasNext: nextUrl ? true : null, nextUrl, totalCount: null,
        authRequiredForMore: /로그인하고 더 많은 상품/.test(document.body.textContent) },
      coverage: 'received_html_cards_only', completeCatalog: false };
  }
  if (banners) return { kind: 'travel_gateway', sourceUrl, title, navigation, sourceFormat: 'document_embedded_json', products: [],
    listingVerified: false, completeCatalog: false };
  if (navigation.length) return { kind: 'navigation_document', sourceUrl, title, navigation,
    sourceFormat: 'document_html', listingVerified: false, completeCatalog: false };
  fail('COUPANG_HTML_LAYOUT_CHANGED');
}

async function transport(url, { body, fetchImpl = fetch, json = true, authentication = 'anonymous', visitorContext } = {}) {
  if (!['anonymous', 'visitor'].includes(authentication) || authentication !== 'visitor' && visitorContext != null)
    fail('COUPANG_PUBLIC_AUTH_INPUT');
  const u = new URL(url), method = body === undefined ? 'GET' : 'POST';
  const receipt = { origin: u.origin, path: u.pathname, queryFields: [...u.searchParams.keys()], method,
    authenticationMode: authentication, transport: fetchImpl === globalThis.fetch ? 'native_fetch' : 'injected',
    cookieSent: false, credentialsUsed: false, browserUsed: false, httpStatus: null, mime: null };
  const headers = { accept: json ? 'application/json' : 'text/html', ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  let visitor, visitorOperation;
  if (authentication === 'visitor') {
    if (json || method !== 'GET') fail('COUPANG_VISITOR_OPERATION_SCOPE', receipt);
    visitorOperation = u.pathname === '/np/search' ? 'retail_search_document' : 'retail_category_document';
    visitor = visitorContext ?? createCoupangVisitorContext({ fetchImpl, allowRebootstrap: false });
    try {
      const inputs = await prepareCoupangVisitorRead({ context: visitor, target: url, operation: visitorOperation, fetchImpl });
      headers.cookie = inputs.cookie;
      Object.assign(receipt, { visitorCookieNames: inputs.cookieNames, visitorBootstrap: inputs.bootstrapReceipt,
        visitorValuesPersisted: false, ownerCredentialUsed: false });
    } catch (error) {
      if (error instanceof CoupangVisitorError) fail(error.code, { ...receipt, visitorBootstrap: error.receipt });
      throw error;
    }
  }
  let response;
  try { receipt.cookieSent = !!headers.cookie; response = await fetchImpl(url, { method, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(20000),
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { fail('COUPANG_TRANSPORT_FAILED', receipt); }
  receipt.httpStatus = response.status; receipt.mime = response.headers.get('content-type')?.split(';')[0] ?? null;
  receipt.server = /^(?:envoy|AkamaiGHost|cloudflare)$/i.test(response.headers.get('server') ?? '') ? response.headers.get('server') : null;
  receipt.responseCookieNames = [...new Set((response.headers.getSetCookie?.() ?? []).map(line => line.split('=', 1)[0])
    .filter(name => /^[A-Za-z0-9_-]{1,80}$/.test(name)))].sort();
  receipt.retryAfterPresent = response.headers.has('retry-after');
  if (response.redirected || response.url && response.url !== url) {
    await response.body?.cancel().catch(() => {}); fail('COUPANG_UNEXPECTED_REDIRECT', receipt);
  }
  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
    receipt.redirectTarget = coupangPublicUrl(response.headers.get('location'), url);
    try { const next = new URL(response.headers.get('location'), url); receipt.redirectOrigin = next.origin; receipt.redirectPath = next.pathname; } catch {}
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body ?? []) { bytes += chunk.length; if (bytes > MAX_BYTES) fail('COUPANG_RESPONSE_LIMIT', receipt); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString('utf8'); receipt.responseBytes = bytes;
  receipt.responseSha256 = createHash('sha256').update(text).digest('hex');
  receipt.accessDeniedTitle = /<title\b[^>]*>\s*Access Denied\s*<\/title>/i.test(text);
  receipt.edgeSupportLinkPresent = /https?:\/\/errors\.edgesuite\.net\//i.test(text);
  receipt.loginFormPresent = /<input\b[^>]*type=["']password["']/i.test(text);
  receipt.interactiveChallengeSignal = /verify you are human|captcha challenge|id=["'](?:challenge-form|px-captcha)["']/i.test(text)
    || response.headers.get('cf-mitigated') === 'challenge' || response.headers.get('x-captcha-required') === 'true';
  receipt.challengeConfirmed = isStrongPublicChallenge(Object.fromEntries(['cf-mitigated','x-captcha-required','x-sucuri-block']
    .map(key => [key, response.headers.get(key)])), text);
  receipt.challengeSignal = /<title>\s*(?:access denied|just a moment)|verify you are human|errors\.edgesuite\.net/i.test(text);
  if (response.status !== 200) fail(`COUPANG_HTTP_${response.status}`, receipt);
  if (receipt.challengeSignal || receipt.challengeConfirmed) fail('COUPANG_CHALLENGE', receipt);
  if (json ? receipt.mime !== 'application/json' : receipt.mime !== 'text/html') fail('COUPANG_MIME_MISMATCH', receipt);
  let data = text;
  if (json) { try { data = JSON.parse(text); } catch { fail('COUPANG_JSON_INVALID', receipt); } }
  return { data, receipt, acceptVisitorRotation: () => {
    if (!visitor) return;
    try { receipt.visitorCookieRotationApplied = rotateCoupangVisitorCookies(visitor,
      response.headers.getSetCookie?.() ?? [], url, visitorOperation); }
    catch (error) { if (error instanceof CoupangVisitorError) fail(error.code, receipt); throw error; }
  } };
}

function wrap(data, receipt) {
  return { schema: 'web-api-coupang-public-result-v1', ok: true, checkedAt: new Date().toISOString(),
    executionMode: 'pure_http', browserUsed: false, credentialsUsed: false, anonymous: true, writesSubmitted: 0,
    request: receipt, data, projectionSha256: hash(data),
    states: { captured: true, client_exists: true, remnant_free: true, credential_propagated: 'not_applicable_anonymous', live_replay: receipt.transport === 'native_fetch' } };
}

export async function readCoupangCategories(options) {
  const { data, receipt } = await transport(`${WWW}/n-api/web-adapter/category-list`, options);
  return wrap(parseCoupangCategories(data), receipt);
}

/** General retail Document reader. RSC Fetch capture and protected replay remain separate. */
export async function readCoupangRetailSearch(query, { sorter, freeDelivery = false, page = 1, authentication = 'visitor', ...options } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 100 || !integer(Number(page)) || Number(page) < 1
    || Number(page) > 1000 || (sorter !== undefined && sorter !== 'salePriceAsc')) fail('COUPANG_RETAIL_SEARCH_INPUT');
  const url = new URL('/np/search', WWW); url.searchParams.set('q', query.trim()); url.searchParams.set('channel', 'user');
  if (sorter) url.searchParams.set('sorter', sorter);
  if (Number(page) !== 1) url.searchParams.set('page', String(page));
  if (freeDelivery) { url.searchParams.set('listSize','36'); url.searchParams.set('filterType','free'); url.searchParams.set('rating','0'); url.searchParams.set('filter',''); }
  const run = await readCoupangDocument(url.href, { ...options, authentication });
  if (run.data.kind !== 'retail_listing') fail('COUPANG_RETAIL_LISTING_MISSING', run.request);
  return run;
}

export async function readCoupangDocument(value, options) {
  const url = coupangPublicUrl(value);
  if (!url) fail('COUPANG_URL_SCOPE');
  const u = new URL(url);
  if (!/^(?:\/$|\/np\/(?:search|coupangglobal|omp)$|\/np\/(?:categories|campaigns)\/\d+$|\/tp\/(?:search|categories\/\d+|products\/\d+)$|\/p\/(?:\d+|bep)$|\/mlp\/web\/mlp-landing-page$|\/vp\/products\/\d+$)/.test(u.pathname)) fail('COUPANG_URL_SCOPE');
  let raw;
  try { raw = await transport(url, { ...options, json: false }); }
  catch (e) {
    if (options?.authentication !== 'visitor' && [301,302,303,307,308].includes(e.receipt?.httpStatus) && e.receipt.redirectTarget && (options?.redirectDepth ?? 0) < 3) {
      try {
        const result = await readCoupangDocument(e.receipt.redirectTarget, { ...options, redirectDepth: (options?.redirectDepth ?? 0) + 1 });
        result.redirects = [e.receipt, ...(result.redirects ?? [])]; return result;
      } catch (next) { next.redirects = [e.receipt, ...(next.redirects ?? [])]; throw next; }
    }
    throw e;
  }
  const { data, receipt } = raw;
  try {
    const result = wrap(parseCoupangDocument(data, url), receipt);
    if (options?.authentication === 'visitor' && result.data.kind !== 'retail_listing') fail('COUPANG_RETAIL_LISTING_MISSING', receipt);
    raw.acceptVisitorRotation();
    result.states.captured = u.origin === TRIP && /^\/tp\/categories\/\d+$/.test(u.pathname);
    result.states.captureScope = result.states.captured ? 'observed_category_document_contract_family' : 'browser_document_request_not_paired';
    return result;
  }
  catch (e) { if (e instanceof CoupangPublicError) e.receipt = receipt; throw e; }
}

const SEARCH_TYPES = new Set(['ACCOMMODATION', 'TICKET', 'TOUR', 'RENTAL_CAR']);
export async function readCoupangTravelSearch(template, { page, sort, resultsOnly = false, ...options } = {}) {
  const body = structuredClone(template), c = body?.searchCondition;
  if (!object(body?.contextCondition) || !object(c) || !SEARCH_TYPES.has(c.productType)
    || !Array.isArray(c.productDetailTypes) || !Array.isArray(c.appliedFilters)
    || !['DEFAULT', 'CATEGORY'].includes(c.searchType?.entitySearchType)) fail('COUPANG_SEARCH_INPUT');
  for (const key of ['searchGroupId', 'q2cId']) if (body.contextCondition[key] != null) fail('COUPANG_RUNTIME_INPUT_NOT_ALLOWED');
  const allowedKeys = (obj, keys) => object(obj) && Object.keys(obj).every(k => keys.includes(k));
  if (!allowedKeys(body, ['contextCondition','searchCondition'])
    || !allowedKeys(body.contextCondition, ['linkCode','channel','sourcePage','searchGroupId','q2cId','bundleId'])
    || !allowedKeys(c, ['keyword','appliedFilters','productId','productType','productDetailTypes','page','searchType','lodging','rentalCar'])
    || !allowedKeys(c.searchType, ['entitySearchType','entityViewType'])
    || (c.lodging && !allowedKeys(c.lodging, ['checkIn','checkOut','numberOfAdults','childrenAges']))
    || (c.rentalCar && !allowedKeys(c.rentalCar, ['displayCategoryCode','pickUpDate','pickUpTime','dropOffDate','dropOffTime']))) fail('COUPANG_SEARCH_INPUT');
  if (page !== undefined) c.page = Number(page);
  if (!integer(c.page) || c.page < 1 || c.page > 10000) fail('COUPANG_PAGE_INPUT');
  if (sort !== undefined) {
    if (!['COUPANG_RATING', 'LOWEST_PRICE', 'HIGHEST_PRICE'].includes(sort)) fail('COUPANG_SORT_INPUT');
    c.appliedFilters = c.appliedFilters.filter(x => !x.startsWith('sorting=')); c.appliedFilters.push(`sorting=${sort}`);
  }
  const { data, receipt } = await transport(`${TRIP}/api/search/${resultsOnly ? 'results-only' : 'results'}`, { ...options, body });
  let parsed; try { parsed = parseTravelSearch(data); } catch (e) { e.receipt = receipt; throw e; }
  if (parsed.pagination.page !== c.page) fail('COUPANG_PAGE_MISMATCH', receipt);
  return wrap({ ...parsed, query: c }, receipt);
}

export async function readCoupangTravelAutocomplete(query, options) {
  if (typeof query !== 'string' || !query.trim() || query.length > 100) fail('COUPANG_QUERY_INPUT');
  const { data, receipt } = await transport(`${TRIP}/api/search/auto-complete`, { ...options,
    body: { contextCondition: { linkCode: null, sourcePage: 'TRAVEL_HOME_GATEWAY', searchGroupId: '', bundleId: 62 }, query, productType: 'ACCOMMODATION' } });
  if (!Array.isArray(data.autoCompleteGroups)) fail('COUPANG_AUTOCOMPLETE_SCHEMA', receipt);
  const groups = data.autoCompleteGroups.map(g => ({ title: clean(g.title), suggestions: (g.autoCompleteSuggestions ?? []).map(s => ({
    id: String(s.id), text: clean(s.text), count: s.count, parentId: s.parentId == null ? null : String(s.parentId), type: s.autoCompleteType })) }));
  return wrap({ kind: 'travel_autocomplete', groups }, receipt);
}

export async function readCoupangTravelRooms(observed, options) {
  if (!/^https:\/\/trip\.coupang\.com\/api\/lodging\/hotels\/\d{1,20}\/rooms$/.test(observed?.url ?? '')
    || !object(observed.body) || observed.body.action !== 'selectorTrigger') fail('COUPANG_ROOM_INPUT');
  const allowed = new Set(['checkIn','checkOut','numberOfAdults','childrenAges','channel','keyword','action']);
  if (Object.keys(observed.body).some(k => !allowed.has(k))) fail('COUPANG_ROOM_INPUT');
  const { data, receipt } = await transport(observed.url, { ...options, body: observed.body });
  let parsed; try { parsed = parseTravelRooms(data); } catch (e) { e.receipt = receipt; throw e; }
  if (parsed.productId !== new URL(observed.url).pathname.split('/')[4]) fail('COUPANG_PRODUCT_MISMATCH', receipt);
  return wrap(parsed, receipt);
}

export async function readCoupangTravelReviews(productId, { page = 0, sort = 'DATE_DESC', ...options } = {}) {
  if (!id(productId) || !integer(Number(page)) || !['DATE_DESC', 'ORDER_SCORE_ASC'].includes(sort)) fail('COUPANG_REVIEW_INPUT');
  const { data, receipt } = await transport(`${TRIP}/api/review/web/products/${productId}/reviews?page=${page}&sortBy=${sort}`, options);
  let parsed;try{parsed=parseTravelReviews(data)}catch(e){e.receipt=receipt;throw e;}
  if(parsed.pagination.page!==Number(page)||parsed.reviews.some(r=>r.productId!==String(productId)))fail('COUPANG_REVIEW_RESULT_MISMATCH',receipt);
  return wrap(parsed, receipt);
}

export async function readCoupangTravelTicketOptions(observed, options) {
  if (!/^https:\/\/trip\.coupang\.com\/api\/products\/\d{1,20}\/vendor-items$/.test(observed?.url ?? '')
    || !id(observed.body?.vendorItemPackageId) || observed.body.productType !== 'TICKET'
    || observed.body.selectDate !== null || Object.keys(observed.body).some(k=>!['vendorItemPackageId','productType','selectDate'].includes(k))) fail('COUPANG_TICKET_INPUT');
  const { data, receipt } = await transport(observed.url, { ...options, body: observed.body });
  let parsed; try { parsed = parseTravelTicketOptions(data); } catch (e) { e.receipt = receipt; throw e; }
  if (parsed.productId !== new URL(observed.url).pathname.split('/')[3]) fail('COUPANG_PRODUCT_MISMATCH', receipt);
  return wrap(parsed, receipt);
}
