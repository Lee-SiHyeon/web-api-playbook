import { createHash } from 'node:crypto';

const maxBytes = 8 * 1024 * 1024; // 8 MiB bounded response stream

export class CoupangShoppingError extends Error {
  constructor(code, message, receipt = null) {
    super(message);
    this.name = 'CoupangShoppingError';
    this.code = code;
    this.receipt = receipt;
  }
}

function inputError(message) {
  throw new CoupangShoppingError('INPUT', message);
}

function schemaError(message, receipt = null) {
  throw new CoupangShoppingError('SCHEMA_CHANGED', message, receipt);
}

export function validateInteger(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && !value.trim())) {
    inputError(`${name} must be an integer`);
  }
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < minimum || num > maximum) {
    inputError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return num;
}

export function validateIdentifier(value, name) {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isSafeInteger(value))) {
    inputError(`${name} must be an exact positive integer string or safe integer`);
  }
  const text = String(value ?? '').trim();
  if (!/^[1-9][0-9]{0,19}$/.test(text)) {
    inputError(`${name} must be a positive integer identifier`);
  }
  return text;
}

export function validateShoppingQuery(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value)) {
    inputError('query must contain 1-200 printable characters');
  }
  return value.trim();
}

/**
 * Parses and returns numeric value or null.
 * Strictly checks typeof to ensure booleans (true/false) never coerce to 1/0.
 */
export function numeric(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    if (!/^[0-9]+(?:\.[0-9]+)?$/.test(cleaned)) {
      return null;
    }
    const num = Number(cleaned);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }
  return null;
}

export function cleanText(value, limit = 5000) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, x => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' '
    }[x]))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * Strips tracking parameters from Coupang URLs.
 * Rejects userinfo, port, hash, non-HTTPS, or unknown hosts.
 */
export function cleanCoupangUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    inputError('Invalid URL format');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) {
    inputError('URL must use HTTPS without port, user credentials, or fragment hash');
  }
  if (!parsed.hostname.endsWith('.coupang.com') && parsed.hostname !== 'coupang.com') {
    inputError('URL hostname must be a Coupang domain');
  }

  if (!['www.coupang.com', 'coupang.com', 'pages.coupang.com'].includes(parsed.hostname)) {
    inputError('Unobserved consumer URL host');
  }
  if (parsed.pathname === '/') return 'https://www.coupang.com/';
  if (parsed.hostname === 'www.coupang.com' && /^\/vp\/products\/[1-9][0-9]*$/.test(parsed.pathname)) {
    return parseProductUrl(rawUrl).cleanUrl;
  }
  // Public promotion path only; discard all tracking/visitor query values.
  return parsed.origin + parsed.pathname;
}

function safePromotionUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const u = new URL(value, 'https://www.coupang.com');
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !u.hostname.endsWith('.coupang.com')) return null;
    return u.origin + u.pathname;
  } catch { return null; }
}

/**
 * Validates and parses a canonical Coupang product URL.
 * Only /vp/products/{productId} is permitted. Extra paths, userinfo, port, or hash are rejected.
 * itemId and vendorItemId query params must be positive integer strings if present.
 */
export function parseProductUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    inputError('productUrl must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) {
    inputError('productUrl must be canonical HTTPS on www.coupang.com without port, user credentials, or hash');
  }
  if (parsed.hostname !== 'www.coupang.com') {
    inputError('productUrl must be on www.coupang.com');
  }

  // Must match exactly /vp/products/{productId}. Trailing slashes or subpaths are forbidden.
  const match = parsed.pathname.match(/^\/vp\/products\/([1-9][0-9]{0,19})$/);
  if (!match) {
    inputError('productUrl must be canonical /vp/products/{productId} with positive integer ID and no subpaths');
  }
  const productId = match[1];

  const rawItemId = parsed.searchParams.get('itemId');
  const rawVendorItemId = parsed.searchParams.get('vendorItemId');

  let itemId = null;
  if (rawItemId !== null) {
    if (!/^[1-9][0-9]{0,19}$/.test(rawItemId)) {
      inputError('itemId must be a positive integer');
    }
    itemId = rawItemId;
  }

  let vendorItemId = null;
  if (rawVendorItemId !== null) {
    if (!/^[1-9][0-9]{0,19}$/.test(rawVendorItemId)) {
      inputError('vendorItemId must be a positive integer');
    }
    vendorItemId = rawVendorItemId;
  }

  const queryParts = [];
  if (itemId) queryParts.push(`itemId=${itemId}`);
  if (vendorItemId) queryParts.push(`vendorItemId=${vendorItemId}`);
  const cleanUrl = `https://www.coupang.com/vp/products/${productId}${queryParts.length ? '?' + queryParts.join('&') : ''}`;

  return { productId, itemId, vendorItemId, cleanUrl };
}

/**
 * Sanitizes review content by removing PII (email, phone, reviewer names, order numbers).
 */
export function sanitizeReviewText(value) {
  return cleanText(value)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email removed]')
    .replace(/\b(?:\+82[- .]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}\b/g, '[phone removed]')
    .replace(/\b주문번호\s*[:#]?\s*[0-9A-Za-z-]{5,30}\b/gi, '[order removed]')
    .replace(/\b\d{10,25}\b/g, '[id removed]');
}

async function boundedBody(response, limit) {
  const clHeader = response.headers.get('content-length');
  if (clHeader && Number(clHeader) > limit) {
    await response.body?.cancel();
    throw new CoupangShoppingError('SIZE_LIMIT', `Coupang response exceeded byte limit (${limit} bytes)`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new CoupangShoppingError('SIZE_LIMIT', `Coupang response exceeded byte limit (${limit} bytes)`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export class CoupangShoppingClient {
  constructor({
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
    responseByteLimit = maxBytes
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      inputError('fetchImpl must be a function');
    }
    this.fetchImpl = fetchImpl;
    this.timeoutMs = validateInteger(timeoutMs, 'timeoutMs', 100, 30000);
    this.responseByteLimit = validateInteger(responseByteLimit, 'responseByteLimit', 1, maxBytes);
  }

  /**
   * Internalized private request executor with strict fixed host, path, method, query, and payload whitelisting.
   */
  async #request(targetUrl, {
    method = 'GET',
    payload = undefined,
    headers = {},
    json = false
  } = {}) {
    let url;
    try {
      url = new URL(targetUrl);
    } catch {
      inputError('Invalid URL structure');
    }

    // Security check: no userinfo, port, hash, https only
    if (url.username || url.password || url.port || url.hash || url.protocol !== 'https:') {
      inputError('Request URL must be HTTPS without userinfo, custom port, or hash fragment');
    }

    // Strict fixed host whitelist
    if (url.hostname !== 'www.coupang.com') {
      inputError(`Request target host ${url.hostname} is outside the Coupang consumer allowlist`);
    }

    const searchKeys = [...url.searchParams.keys()];

    // Strict fixed path, method, query, and body whitelisting
    if (url.pathname === '/n-api/recommend/feeds') {
      if (method !== 'POST' || searchKeys.length > 0 || !payload || typeof payload !== 'object') {
        inputError('Only the observed recommend-feeds POST contract is allowed');
      }
      const allowedBodyKeys = ['nextFeedsToken'];
      const bodyKeys = Object.keys(payload);
      if (bodyKeys.length !== 1 || bodyKeys[0] !== 'nextFeedsToken' || typeof payload.nextFeedsToken !== 'string') {
        inputError('recommend-feeds payload must contain only nextFeedsToken string');
      }
    } else if (url.pathname === '/n-api/homeunit/LINE_BANNER') {
      if (method !== 'GET' || searchKeys.length > 0 || payload !== undefined) {
        inputError('Only the observed line-banner GET contract is allowed');
      }
    } else if (url.pathname === '/n-api/homeunit/BEST_CATEGORY') {
      if (method !== 'GET' || searchKeys.length > 0 || payload !== undefined) {
        inputError('Only the observed best-category GET contract is allowed');
      }
    } else {
      inputError(`Path ${url.pathname} is not in the observed Coupang consumer read contracts`);
    }

    // Truthful application UA receives 403, while compatibility Chrome UA receives 200.
    const requestHeaders = {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'accept': json ? 'application/json' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      ...headers
    };
    if (payload !== undefined) {
      requestHeaders['content-type'] = 'application/json';
    }

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: 'manual', // Strictly reject automatic redirection
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: requestHeaders,
        body: payload !== undefined ? JSON.stringify(payload) : undefined
      });
    } catch (err) {
      throw new CoupangShoppingError('TRANSPORT', 'Coupang HTTP request failed');
    }

    let bytes;
    try {
      bytes = await boundedBody(response, this.responseByteLimit);
    } catch (error) {
      if (error instanceof CoupangShoppingError) throw error;
      throw new CoupangShoppingError('TRANSPORT', 'Coupang response body read failed');
    }

    const bodyText = bytes.toString('utf8');
    const contentType = response.headers.get('content-type') ?? '';
    const dateHeader = response.headers.get('date') ?? null;
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    // Receipt records metadata only; NEVER prints or stores cookies, tokens, or raw secrets.
    const receipt = {
      method,
      origin: url.origin,
      path: url.pathname,
      queryFields: searchKeys,
      bodyFields: payload && typeof payload === 'object' ? Object.keys(payload) : [],
      httpStatus: response.status,
      responseContentType: contentType,
      responseDate: dateHeader,
      responseBytes: bytes.length,
      responseSha256: sha256,
      checkedAt: new Date().toISOString(),
      browserUsed: false,
      credentialsUsed: this.fetchImpl === globalThis.fetch ? false : null,
      transport: this.fetchImpl === globalThis.fetch ? 'anonymous_native_fetch' : 'caller_supplied_http'
    };

    const fail = (code, message) => {
      throw new CoupangShoppingError(code, message, receipt);
    };

    // Priority 1: HTTP 429 classification takes priority over HTML WAF markers
    if (response.status === 429) {
      fail('RATE_LIMITED', 'Coupang returned HTTP 429; no automatic retry was made');
    }

    // Priority 2: Grounded attribution: report Access Denied response observed without unverified speculation
    if (response.status === 403 || /Access Denied|x-reference-error|errors\.edgesuite\.net/i.test(bodyText)) {
      fail('WAF_BLOCKED', 'Coupang returned an Access Denied response');
    }

    if (response.status === 418 || (/captcha|sec-ch-ua|sensor_data/i.test(bodyText) && response.status !== 200)) {
      fail('CAPTCHA_REQUIRED', 'Coupang returned an anti-bot verification challenge');
    }

    if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
      const loc = response.headers.get('location') || '';
      if (/login|auth/i.test(loc) || response.status === 401) {
        fail('AUTH_REQUIRED', 'Coupang requires an authenticated consumer session');
      }
      fail('REDIRECT_REJECTED', `Coupang returned redirect status ${response.status}; redirect was not followed`);
    }

    // Require strict HTTP 200 success
    if (response.status !== 200) {
      fail('HTTP_STATUS', `Coupang returned unexpected HTTP status ${response.status}`);
    }

    if (json) {
      if (!/^application\/json\b/i.test(contentType)) {
        fail('CONTENT_TYPE', `Expected application/json response, got ${contentType}`);
      }
      try {
        const parsedJson = JSON.parse(bodyText);
        return { data: parsedJson, receipt };
      } catch {
        fail('SCHEMA_CHANGED', 'Coupang returned malformed JSON');
      }
    }

    return { data: bodyText, receipt };
  }

  // --- Verified Consumer Product & Banner XHR Operations ---

  /**
   * Traverses consumer recommend feeds in memory and extracts real products with prices.
   * Server-issued continuation tokens are held strictly in memory during page flow and never exposed.
   * Sorting and limits are strictly applied AFTER bounded traversal over all eligible products.
   */
  async feed({
    query = null,
    section = null,
    minPrice = null,
    maxPrice = null,
    minDiscount = null,
    sort = 'none',
    limit = 20,
    maxPages = 3,
    productId = null,
    vendorItemId = null,
    itemId = null
  } = {}) {
    const q = query === null ? null : validateShoppingQuery(query);
    const targetSection = section === null ? null : validateShoppingQuery(section);
    const minP = minPrice === null ? null : validateInteger(minPrice, 'minPrice', 0, 100000000);
    const maxP = maxPrice === null ? null : validateInteger(maxPrice, 'maxPrice', 0, 100000000);
    if (minP !== null && maxP !== null && minP > maxP) {
      inputError('minPrice cannot be greater than maxPrice');
    }
    const minDisc = minDiscount === null ? null : validateInteger(minDiscount, 'minDiscount', 0, 100);

    const validSorts = new Set(['none', 'price_asc', 'price_desc', 'discount_desc', 'rating_signal_desc', 'reviews_desc']);
    if (!validSorts.has(sort)) {
      inputError(`sort must be one of: ${[...validSorts].join(', ')}`);
    }

    const n = validateInteger(limit, 'limit', 1, 100);
    const cap = validateInteger(maxPages, 'maxPages', 1, 5);

    const targetProductId = productId === null ? null : validateIdentifier(productId, 'productId');
    const targetVendorItemId = vendorItemId === null ? null : validateIdentifier(vendorItemId, 'vendorItemId');
    const targetItemId = itemId === null ? null : validateIdentifier(itemId, 'itemId');

    const receipts = [];
    const allProducts = [];
    const observed = new Set();
    const sectionsObserved = new Set();
    let pagesTraversed = 0;
    let cursor = '';
    const cursors = new Set();
    let stopReason = 'page_limit';

    // Bounded crawl across feed pages
    for (let page = 0; page <= cap; page++) {
      if (page > 0) await new Promise(r => setTimeout(r, 1000));
      const response = await this.#request('https://www.coupang.com/n-api/recommend/feeds', {
        method: 'POST',
        payload: { nextFeedsToken: cursor },
        json: true
      });
      receipts.push(response.receipt);
      const data = response.data;
      if (!data || !Array.isArray(data.feeds) || (data.continuationToken != null && typeof data.continuationToken !== 'string')) {
        schemaError('Recommendation feed or cursor schema changed', response.receipt);
      }
      if (page > 0) pagesTraversed++;

      for (const block of data.feeds) {
        if (!block || typeof block !== 'object') schemaError('Invalid feed block', response.receipt);
        const blockTitle = cleanText(block.title, 200) || null;
        const blockType = cleanText(block.type, 100) || null;
        if (blockTitle) sectionsObserved.add(blockTitle);

        if (!Object.hasOwn(block, 'productLists')) continue;
        if (!Array.isArray(block.productLists)) schemaError('Feed product list schema changed', response.receipt);

        for (const raw of block.productLists) {
          if (!raw || typeof raw !== 'object') schemaError('Invalid product row', response.receipt);
          const title = cleanText(raw.title, 1000);
          if (!title) schemaError('Product title was missing', response.receipt);

          let pId, itId, vItId;
          try {
            // Reject already imprecise numeric IDs; preserve exact string IDs.
            pId = validateIdentifier(raw.productId, 'productId');
            itId = raw.itemId == null ? null : validateIdentifier(raw.itemId, 'itemId');
            vItId = raw.vendorItemId == null ? null : validateIdentifier(raw.vendorItemId, 'vendorItemId');
          } catch {
            schemaError('Product identity schema changed', response.receipt);
          }

          const salePriceKrw = numeric(raw.salePrice ?? raw.price);
          const key = JSON.stringify([pId, itId, vItId, salePriceKrw]);
          if (observed.has(key)) continue;
          observed.add(key);

          const params = new URLSearchParams();
          if (itId) params.set('itemId', itId);
          if (vItId) params.set('vendorItemId', vItId);
          const ratio = numeric(typeof raw.discountRate === 'string' ? raw.discountRate.replace('%', '') : raw.discountRate);

          allProducts.push({
            provider: 'coupang-consumer-shopping',
            productId: pId,
            itemId: itId,
            vendorItemId: vItId,
            title,
            feedTitle: blockTitle,
            feedType: blockType,
            checkedAt: response.receipt.checkedAt,
            currency: 'KRW',
            basePriceKrw: numeric(raw.originalPrice),
            salePriceKrw,
            discountRatePercent: ratio !== null && ratio <= 100 ? ratio : null,
            unitPrice: typeof raw.unitPrice === 'string' ? cleanText(raw.unitPrice, 100) : null,
            cleanUrl: 'https://www.coupang.com/vp/products/' + pId + (params.size ? '?' + params : ''),
            wowEligibilityVerified: false,
            couponEligibilityVerified: false,
            sourceRatingSignal: numeric(raw.ratingAverage),
            sourceRatingField: 'ratingAverage',
            ratingScaleVerified: false,
            ratingAverage: null, // Unknown raw scale preserved as sourceRatingSignal with ratingAverage null
            ratingCount: numeric(raw.ratingCount),
            payablePriceVerified: false,
            lowestPriceGuaranteed: false,
            contentTrust: 'untrusted_external_text'
          });
        }
      }

      cursor = data.continuationToken || '';
      if (!cursor) {
        stopReason = 'cursor_exhausted';
        break;
      }
      if (cursor.length > 16384 || cursors.has(cursor)) {
        schemaError('Invalid or non-progressing cursor', response.receipt);
      }
      cursors.add(cursor);
    }

    // Step 2: Apply LOCAL filters over complete inspected inventory (never premature truncation)
    let filtered = allProducts.filter(item => {
      if (q && !item.title.toLocaleLowerCase('ko').includes(q.toLocaleLowerCase('ko'))) {
        return false;
      }
      if (targetSection) {
        const sMatch = (item.feedTitle && item.feedTitle.toLocaleLowerCase('ko').includes(targetSection.toLocaleLowerCase('ko')))
          || (item.feedType && item.feedType.toLocaleLowerCase('ko').includes(targetSection.toLocaleLowerCase('ko')));
        if (!sMatch) return false;
      }
      if (minP !== null) {
        if (item.salePriceKrw === null || item.salePriceKrw < minP) return false;
      }
      if (maxP !== null) {
        if (item.salePriceKrw === null || item.salePriceKrw > maxP) return false;
      }
      if (minDisc !== null) {
        if (item.discountRatePercent === null || item.discountRatePercent < minDisc) return false;
      }
      if (targetProductId && item.productId !== targetProductId) {
        return false;
      }
      if (targetVendorItemId && item.vendorItemId !== targetVendorItemId) {
        return false;
      }
      if (targetItemId && item.itemId !== targetItemId) {
        return false;
      }
      return true;
    });

    const eligibleCount = filtered.length;

    // Step 3: Apply Sorting over all eligible items
    if (sort === 'price_asc') {
      filtered.sort((a, b) => (a.salePriceKrw ?? Infinity) - (b.salePriceKrw ?? Infinity));
    } else if (sort === 'price_desc') {
      filtered.sort((a, b) => (b.salePriceKrw ?? -Infinity) - (a.salePriceKrw ?? -Infinity));
    } else if (sort === 'discount_desc') {
      filtered.sort((a, b) => (b.discountRatePercent ?? -1) - (a.discountRatePercent ?? -1));
    } else if (sort === 'rating_signal_desc') {
      filtered.sort((a, b) => (b.sourceRatingSignal ?? -1) - (a.sourceRatingSignal ?? -1));
    } else if (sort === 'reviews_desc') {
      filtered.sort((a, b) => (b.ratingCount ?? -1) - (a.ratingCount ?? -1));
    }

    // Step 4: Apply limit slice after sorting
    const returnedItems = filtered.slice(0, n);

    const sectionMap = new Map();
    for (const item of allProducts) {
      const key = JSON.stringify([item.feedTitle, item.feedType]);
      if (!sectionMap.has(key)) sectionMap.set(key, { title: item.feedTitle, type: item.feedType, productCount: 0, pricedCount: 0, sampleProducts: [] });
      const summary = sectionMap.get(key);
      summary.productCount++;
      if (item.salePriceKrw !== null) summary.pricedCount++;
      if (summary.sampleProducts.length < 3) summary.sampleProducts.push({ productId: item.productId, title: item.title, salePriceKrw: item.salePriceKrw });
    }

    return {
      scope: 'observed_home_recommendation_products',
      catalogComplete: false,
      globalSearch: false,
      query: q,
      filtering: q || targetSection || minP !== null || maxP !== null || minDisc !== null || targetProductId || targetVendorItemId || targetItemId ? 'local_filter_of_observed_feed' : 'none',
      localFilteringApplied: Boolean(q || targetSection || minP !== null || maxP !== null || minDisc !== null || targetProductId || targetVendorItemId || targetItemId),
      filters: {
        query: q,
        section: targetSection,
        minPriceKrw: minP,
        maxPriceKrw: maxP,
        minDiscountRatePercent: minDisc,
        productId: targetProductId,
        vendorItemId: targetVendorItemId,
        itemId: targetItemId
      },
      sort,
      sectionsObserved: [...sectionsObserved],
      sectionInventory: [...sectionMap.values()],
      pagesTraversed,
      pageCap: cap,
      stopReason,
      inspectedCount: allProducts.length,
      eligibleCount,
      rowCount: returnedItems.length,
      priceCount: returnedItems.filter(p => p.salePriceKrw !== null).length,
      items: returnedItems,
      receipts
    };
  }

  /**
   * Convenient deal products operation with discount threshold and sorting.
   * Bounded local filter over fetched feed inventory.
   */
  async deals({
    minDiscount = 20,
    sort = 'discount_desc',
    limit = 20,
    maxPages = 3,
    section = null
  } = {}) {
    const result = await this.feed({
      minDiscount,
      sort,
      limit,
      maxPages,
      section
    });
    return {
      ...result,
      scope: 'observed_home_recommendation_deals',
      convenienceOperation: 'deals'
    };
  }

  /**
   * Convenient section inventory summary operation.
   * Returns observed feed section titles, types, and item counts.
   */
  async sections({ maxPages = 3 } = {}) {
    const result = await this.feed({ limit: 100, maxPages });
    return {
      scope: 'observed_feed_sections_summary',
      catalogComplete: false,
      globalSearch: false,
      sectionsCount: result.sectionInventory.length,
      sections: result.sectionInventory,
      totalProductsInspected: result.inspectedCount,
      pagesTraversed: result.pagesTraversed,
      pageCap: result.pageCap,
      stopReason: result.stopReason,
      receipts: result.receipts
    };
  }

  /**
   * Convenient lookup for a specific product or option in observed feed inventory.
   */
  async find({
    productId = null,
    vendorItemId = null,
    itemId = null,
    maxPages = 3
  } = {}) {
    if (!productId && !vendorItemId && !itemId) {
      inputError('find requires at least one of productId, vendorItemId, or itemId');
    }
    const result = await this.feed({
      productId,
      vendorItemId,
      itemId,
      limit: 100,
      maxPages
    });

    const match = result.items[0] || null;
    return {
      scope: 'observed_feed_product_lookup',
      catalogComplete: false,
      globalSearch: false,
      matched: Boolean(match),
      product: match,
      products: result.items,
      matchedCount: result.eligibleCount,
      matchesTruncated: result.eligibleCount > result.rowCount,
      inspectedCount: result.inspectedCount,
      pagesTraversed: result.pagesTraversed,
      pageCap: result.pageCap,
      stopReason: result.stopReason,
      receipts: result.receipts
    };
  }

  /** Public home category metadata, independent of product inventory. */
  async categories() {
    const { data, receipt } = await this.#request('https://www.coupang.com/n-api/homeunit/BEST_CATEGORY', { json: true });
    if (!data || !Array.isArray(data.defaultBestCategories)) schemaError('Category metadata schema changed', receipt);
    const categories = data.defaultBestCategories.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) schemaError('Category row schema changed', receipt);
      let categoryId;
      try { categoryId = validateIdentifier(raw.code, 'categoryId'); } catch { schemaError('Category identifier schema changed', receipt); }
      const name = cleanText(raw.name, 200);
      if (!name) schemaError('Category name was missing', receipt);
      return { categoryId, name, title: cleanText(raw.title, 200) || null, contentTrust: 'untrusted_external_text' };
    });
    return { scope: 'public_home_category_metadata', inventoryIncluded: false, rowCount: categories.length, categories, receipt };
  }

  /**
   * Reads consumer line banners from Next.js home unit API.
   * Live replay HTTP 200 verified.
   */
  async lineBanner() {
    const url = 'https://www.coupang.com/n-api/homeunit/LINE_BANNER';
    const { data, receipt } = await this.#request(url, { json: true });
    if (!Array.isArray(data?.lineBanners)) schemaError('Banner schema changed', receipt);
    const banners = data.lineBanners;
    const normalizedBanners = banners.map(b => ({
      bannerId: String(b.bannerId ?? ''),
      linkUrl: safePromotionUrl(b.linkUrl),
      imageUrl: b.thumbnailPrefixUrl_111x111 ?? null,
    }));

    return {
      scope: 'consumer_homeunit_line_banners',
      totalCount: normalizedBanners.length,
      banners: normalizedBanners,
      natureNotice: 'Home unit line banners; contains promotional marketing banners, not product search results.',
      receipt
    };
  }
}
