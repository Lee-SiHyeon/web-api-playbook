import { createHash } from 'node:crypto';

const API_ORIGIN = 'https://api.linksynergy.com';
const SEARCH_PATH = '/productsearch/1.0';
const PRODUCT_SEARCH_GUIDE = 'https://developers.rakutenadvertising.com/guides/product_search';
const PRODUCT_SEARCH_REFERENCE = 'https://developers.rakutenadvertising.com/guides/product_search/reference';
const MAX_XML_BYTES = 4 * 1024 * 1024;
const MAX_XML_NODES = 100_000;
const MAX_XML_DEPTH = 64;
const MAX_PAGE_SIZE = 100;
const MAX_CONSERVATIVE_RESULTS = 1_000;
const MAX_COLLECT_PAGES = 10;
const MIN_REQUEST_INTERVAL_MS = 600;
const MIME_XML = new Set(['application/xml', 'text/xml']);
const TERMS_UNSUPPORTED = /[&=?{}()~|$!><*%]/;
const CURRENCIES = /^[A-Z]{3}$/;
const AMOUNT = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,4})?$/;
const LANGUAGES = new Set(['en_US', 'fr_FR', 'de_DE', 'pt_BR']);
const SORT_FIELDS = new Set(['retailprice', 'productname', 'categoryname', 'mid']);

export class RakutenAdvertisingError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'RakutenAdvertisingError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt = {}) => { throw new RakutenAdvertisingError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, max = 10_000) => typeof value === 'string' && value.length <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const nonemptyText = (value, max = 10_000) => cleanText(value, max) && value.trim().length > 0;

function safeCheckedAt(now) {
  let instant;
  try { instant = new Date(now()); } catch { fail('RAKUTEN_CLOCK_INVALID'); }
  if (!Number.isFinite(instant.getTime())) fail('RAKUTEN_CLOCK_INVALID');
  return instant.toISOString();
}

function responseMime(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
}

function decodeXmlEntities(value) {
  if (typeof value !== 'string') fail('RAKUTEN_XML_INVALID');
  if (/&(?!(?:#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);)/.test(value)) {
    fail('RAKUTEN_XML_ENTITY_INVALID');
  }
  return value.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, entity) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const codePoint = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    const validXmlCodePoint = codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!validXmlCodePoint || !Number.isInteger(codePoint)) fail('RAKUTEN_XML_ENTITY_INVALID');
    return String.fromCodePoint(codePoint);
  });
}

function validateXmlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (!(codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff))) {
      fail('RAKUTEN_XML_INVALID');
    }
  }
}

function findTagEnd(xml, from) {
  let quote = null;
  for (let index = from; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseStartTag(source) {
  let index = 0;
  while (/\s/.test(source[index] ?? '')) index += 1;
  const nameMatch = source.slice(index).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
  if (!nameMatch) fail('RAKUTEN_XML_INVALID');
  const name = nameMatch[1];
  index += name.length;
  const attributes = Object.create(null);
  while (index < source.length) {
    const beforeSpace = index;
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (index >= source.length) break;
    if (beforeSpace === index) fail('RAKUTEN_XML_INVALID');
    const attributeMatch = source.slice(index).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
    if (!attributeMatch) fail('RAKUTEN_XML_INVALID');
    const attributeName = attributeMatch[1];
    if (Object.hasOwn(attributes, attributeName)) fail('RAKUTEN_XML_INVALID');
    index += attributeName.length;
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (source[index] !== '=') fail('RAKUTEN_XML_INVALID');
    index += 1;
    while (/\s/.test(source[index] ?? '')) index += 1;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") fail('RAKUTEN_XML_INVALID');
    index += 1;
    const end = source.indexOf(quote, index);
    if (end < 0) fail('RAKUTEN_XML_INVALID');
    const raw = source.slice(index, end);
    if (raw.includes('<')) fail('RAKUTEN_XML_INVALID');
    attributes[attributeName] = decodeXmlEntities(raw);
    index = end + 1;
  }
  return { name, attributes };
}

// The documented response is a small XML subset. A bounded parser is used
// instead of a browser DOM so DTDs, external entities and entity expansion are
// rejected before any product fields are consumed.
function parseXmlDocument(xml) {
  if (typeof xml !== 'string' || !xml.length || Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) {
    fail('RAKUTEN_XML_INVALID');
  }
  validateXmlCharacters(xml);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('RAKUTEN_XML_DTD_REJECTED');

  const stack = [];
  let root = null;
  let cursor = 0;
  let nodes = 0;
  let declarationSeen = false;

  const appendText = (text, literal = false) => {
    if (!stack.length) {
      if (text.trim()) fail('RAKUTEN_XML_INVALID');
      return;
    }
    const decoded = literal ? text : decodeXmlEntities(text);
    const current = stack[stack.length - 1];
    current.text += decoded;
    if (current.text.length > MAX_XML_BYTES) fail('RAKUTEN_XML_INVALID');
  };

  while (cursor < xml.length) {
    const opening = xml.indexOf('<', cursor);
    const textEnd = opening < 0 ? xml.length : opening;
    if (textEnd > cursor) appendText(xml.slice(cursor, textEnd));
    if (opening < 0) {
      cursor = xml.length;
      break;
    }
    if (xml.startsWith('<!--', opening)) {
      const end = xml.indexOf('-->', opening + 4);
      if (end < 0 || xml.slice(opening + 4, end).includes('--')) fail('RAKUTEN_XML_INVALID');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', opening)) {
      if (!stack.length) fail('RAKUTEN_XML_INVALID');
      const end = xml.indexOf(']]>', opening + 9);
      if (end < 0) fail('RAKUTEN_XML_INVALID');
      appendText(xml.slice(opening + 9, end), true);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', opening)) {
      const end = xml.indexOf('?>', opening + 2);
      if (end < 0) fail('RAKUTEN_XML_INVALID');
      const instruction = xml.slice(opening + 2, end).trim();
      if (/^xml(?:\s|$)/.test(instruction)) {
        if (declarationSeen || opening !== 0 || stack.length || root) fail('RAKUTEN_XML_INVALID');
        declarationSeen = true;
      } else {
        fail('RAKUTEN_XML_PI_REJECTED');
      }
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith('<!', opening)) fail('RAKUTEN_XML_DECLARATION_REJECTED');

    const end = findTagEnd(xml, opening + 1);
    if (end < 0) fail('RAKUTEN_XML_INVALID');
    const body = xml.slice(opening + 1, end);
    if (body.startsWith('/')) {
      const closing = body.match(/^\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*$/);
      if (!closing || !stack.length || stack[stack.length - 1].name !== closing[1]) {
        fail('RAKUTEN_XML_INVALID');
      }
      stack.pop();
      cursor = end + 1;
      continue;
    }

    const selfClosing = /\/$/.test(body);
    const start = parseStartTag(selfClosing ? body.replace(/\/\s*$/, '') : body);
    const node = { name: start.name, attributes: start.attributes, children: [], text: '' };
    nodes += 1;
    if (nodes > MAX_XML_NODES || stack.length + 1 > MAX_XML_DEPTH) fail('RAKUTEN_XML_LIMIT_EXCEEDED');
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (root) fail('RAKUTEN_XML_INVALID');
    else root = node;
    if (!selfClosing) stack.push(node);
    cursor = end + 1;
  }

  if (stack.length || !root) fail('RAKUTEN_XML_INVALID');
  return root;
}

function child(parent, name, { required = false } = {}) {
  const found = parent.children.filter(node => node.name === name);
  if (found.length > 1 || (required && found.length !== 1)) fail('RAKUTEN_PRODUCT_SCHEMA_INVALID');
  return found[0] ?? null;
}

function textOf(node, { required = false, max = 100_000 } = {}) {
  if (!node) {
    if (required) fail('RAKUTEN_PRODUCT_SCHEMA_INVALID');
    return null;
  }
  if (node.children.length || !cleanText(node.text, max)) fail('RAKUTEN_PRODUCT_SCHEMA_INVALID');
  const value = node.text.trim();
  if (required && !value) fail('RAKUTEN_PRODUCT_SCHEMA_INVALID');
  return value || null;
}

function optionalText(parent, name, max = 100_000) {
  return textOf(child(parent, name), { max });
}

function amountNode(parent, name, { required = false } = {}) {
  const node = child(parent, name, { required });
  if (!node) return null;
  const amount = textOf(node, { required: true, max: 64 });
  const currency = node.attributes.currency;
  if (!AMOUNT.test(amount) || !CURRENCIES.test(currency ?? '')) fail('RAKUTEN_PRICE_SCHEMA_INVALID');
  return { amount, currency };
}

function safeHttpUrl(value, required) {
  if (!value) {
    if (required) fail('RAKUTEN_PRODUCT_URL_INVALID');
    return null;
  }
  if (value.length > 4_096) fail('RAKUTEN_PRODUCT_URL_INVALID');
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      fail('RAKUTEN_PRODUCT_URL_INVALID');
    }
    return url.href;
  } catch (error) {
    if (error instanceof RakutenAdvertisingError) throw error;
    fail('RAKUTEN_PRODUCT_URL_INVALID');
  }
}

function normalizeProduct(node, { requestedMid, checkedAt }) {
  const advertiserId = textOf(child(node, 'mid', { required: true }), { required: true, max: 32 });
  const merchantName = textOf(child(node, 'merchantname', { required: true }), { required: true, max: 2_000 });
  const productLinkId = textOf(child(node, 'linkid', { required: true }), { required: true, max: 256 });
  const title = textOf(child(node, 'productname', { required: true }), { required: true, max: 5_000 });
  if (!/^\d{1,20}$/.test(advertiserId) || (requestedMid && advertiserId !== requestedMid) ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(productLinkId)) {
    fail('RAKUTEN_PRODUCT_IDENTITY_INVALID');
  }
  const retail = amountNode(node, 'price', { required: true });
  const sale = amountNode(node, 'saleprice');
  if (sale && sale.currency !== retail.currency) fail('RAKUTEN_PRICE_CURRENCY_MISMATCH');

  const categoryNode = child(node, 'category');
  let categories;
  if (categoryNode) {
    const primary = optionalText(categoryNode, 'primary', 2_000);
    const secondary = optionalText(categoryNode, 'secondary', 2_000);
    categories = { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
  }
  const descriptionNode = child(node, 'description');
  let description;
  if (descriptionNode) {
    const short = optionalText(descriptionNode, 'short', 20_000);
    const long = optionalText(descriptionNode, 'long', 100_000);
    description = { ...(short ? { short } : {}), ...(long ? { long } : {}) };
  }
  const sku = optionalText(node, 'sku', 1_000);
  const upc = optionalText(node, 'upccode', 128);
  const affiliateUrl = safeHttpUrl(optionalText(node, 'linkurl', 4_096), true);
  const imageUrl = safeHttpUrl(optionalText(node, 'imageurl', 4_096), false);
  const createdOn = optionalText(node, 'createdon', 128);
  const keywords = optionalText(node, 'keywords', 20_000);
  const productId = advertiserId + ':' + productLinkId;
  return {
    provider: 'rakuten-advertising',
    productId,
    variantId: sku,
    title,
    affiliateURL: affiliateUrl,
    canonicalURL: null,
    imageUrl,
    price: {
      amount: retail.amount,
      currency: retail.currency,
      kind: sale ? 'retail_list' : 'retail_current',
    },
    ...(sale ? { salePrice: { amount: sale.amount, currency: sale.currency, kind: 'retail_sale' } } : {}),
    availability: 'unknown',
    observedAt: checkedAt,
    source: {
      network: 'rakuten-advertising',
      advertiserId,
      advertiserName: merchantName,
      productLinkId,
      compositeProductKey: JSON.stringify([advertiserId, productLinkId]),
      sku,
      upc,
      ...(categories ? { categories } : {}),
      ...(description ? { description } : {}),
      ...(keywords ? { keywords } : {}),
      ...(createdOn ? { linkCreatedOn: createdOn } : {}),
      priceFieldSemantics: sale
        ? 'price and saleprice are reported separately; sale activity dates are not returned by Product Search'
        : 'price is the reported retail price',
      stockSemantics: 'Product Search does not expose an on-hand inventory quantity',
    },
  };
}

function parseSearchResponse(xml, { requestedPage, pageSize, requestedMid, checkedAt }) {
  const root = parseXmlDocument(xml);
  if (root.name !== 'result') fail('RAKUTEN_RESPONSE_SCHEMA_INVALID');
  const apiError = child(root, 'error');
  if (apiError) fail('RAKUTEN_API_ERROR');
  const totalMatchesText = textOf(child(root, 'TotalMatches', { required: true }), { required: true, max: 32 });
  const totalPagesText = textOf(child(root, 'TotalPages', { required: true }), { required: true, max: 32 });
  const pageNumberText = textOf(child(root, 'PageNumber', { required: true }), { required: true, max: 32 });
  if (![totalMatchesText, totalPagesText, pageNumberText].every(value => /^\d+$/.test(value))) {
    fail('RAKUTEN_PAGINATION_SCHEMA_INVALID');
  }
  const totalMatches = Number(totalMatchesText);
  const totalPages = Number(totalPagesText);
  const pageNumber = Number(pageNumberText);
  if (!Number.isSafeInteger(totalMatches) || totalMatches > 1_000_000_000 ||
      !Number.isSafeInteger(totalPages) || totalPages > 10_000_000 ||
      !Number.isSafeInteger(pageNumber) || pageNumber !== requestedPage ||
      (totalPages > 0 && requestedPage > totalPages)) fail('RAKUTEN_PAGINATION_SCHEMA_INVALID');

  const rows = root.children.filter(node => node.name === 'item');
  if (rows.length > pageSize || rows.length > 100) fail('RAKUTEN_PAGE_SIZE_EXCEEDED');
  if (totalMatches === 0 && rows.length !== 0) fail('RAKUTEN_PAGINATION_SCHEMA_INVALID');
  const items = rows.map(row => normalizeProduct(row, { requestedMid, checkedAt }));
  const keys = new Set();
  for (const item of items) {
    if (keys.has(item.productId)) fail('RAKUTEN_DUPLICATE_PRODUCT_ID');
    keys.add(item.productId);
  }
  return {
    items,
    pagination: {
      page: pageNumber,
      pageSize,
      totalMatches,
      totalPages,
      conservativeResultCap: MAX_CONSERVATIVE_RESULTS,
      resultSetMayBeTruncated: totalMatches > MAX_CONSERVATIVE_RESULTS,
    },
  };
}

function validateTerm(value, code, max = 400) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max ||
      /[\x00-\x1f\x7f]/.test(value) || TERMS_UNSUPPORTED.test(value) ||
      ['\\', '[', ']', ';', '-'].some(character => value.includes(character))) fail(code);
  return value;
}

function validateSearchInput(input) {
  if (!object(input)) fail('RAKUTEN_SEARCH_INPUT_INVALID');
  const allowed = new Set(['query', 'keyword', 'exact', 'one', 'none', 'category', 'language', 'page',
    'pageSize', 'advertiserMid', 'merchantId', 'sort', 'sortType']);
  if (Object.keys(input).some(key => !allowed.has(key)) ||
      (input.query !== undefined && input.keyword !== undefined) ||
      (input.merchantId !== undefined && input.advertiserMid !== undefined)) fail('RAKUTEN_SEARCH_INPUT_INVALID');
  const query = input.query === undefined ? input.keyword : input.query;
  const advertiserMidInput = input.merchantId === undefined ? input.advertiserMid : input.merchantId;
  const normalized = { ...input, keyword: query, advertiserMid: advertiserMidInput };
  const termNames = ['keyword', 'exact', 'one', 'none'];
  const selectedTerms = termNames.filter(name => normalized[name] !== undefined && normalized[name] !== null);
  if (selectedTerms.length > 1) fail('RAKUTEN_SEARCH_INPUT_INVALID');
  const params = [];
  const queryFields = [];
  for (const name of selectedTerms) {
    params.push([name, validateTerm(normalized[name], 'RAKUTEN_SEARCH_INPUT_INVALID')]);
    queryFields.push(name);
  }
  if (normalized.category !== undefined && normalized.category !== null) {
    params.push(['cat', validateTerm(normalized.category, 'RAKUTEN_SEARCH_INPUT_INVALID')]);
    queryFields.push('cat');
  }
  if (normalized.language !== undefined && normalized.language !== null) {
    if (!LANGUAGES.has(normalized.language)) fail('RAKUTEN_LANGUAGE_UNSUPPORTED');
    params.push(['language', normalized.language]);
    queryFields.push('language');
  }
  const page = normalized.page ?? 1;
  const pageSize = normalized.pageSize ?? 20;
  if (!Number.isSafeInteger(page) || page < 1 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE ||
      (page - 1) * pageSize >= MAX_CONSERVATIVE_RESULTS) fail('RAKUTEN_PAGE_INVALID');
  params.push(['max', String(pageSize)], ['pagenumber', String(page)]);
  queryFields.push('max', 'pagenumber');
  let advertiserMid = null;
  if (normalized.advertiserMid !== undefined && normalized.advertiserMid !== null) {
    if (typeof normalized.advertiserMid !== 'string' || !/^\d{1,20}$/.test(normalized.advertiserMid)) {
      fail('RAKUTEN_ADVERTISER_MID_INVALID');
    }
    advertiserMid = normalized.advertiserMid;
    params.push(['mid', advertiserMid]);
    queryFields.push('mid');
  }
  if (normalized.sort !== undefined && normalized.sort !== null) {
    if (!SORT_FIELDS.has(normalized.sort) || !['asc', 'dsc'].includes(normalized.sortType)) {
      fail('RAKUTEN_SORT_INVALID');
    }
    params.push(['sort', normalized.sort], ['sorttype', normalized.sortType]);
    queryFields.push('sort', 'sorttype');
  } else if (normalized.sortType !== undefined && normalized.sortType !== null) {
    fail('RAKUTEN_SORT_INVALID');
  }
  if (!selectedTerms.length && normalized.category == null && advertiserMid === null) {
    fail('RAKUTEN_SEARCH_FILTER_REQUIRED');
  }
  const queryFingerprint = createHash('sha256').update(JSON.stringify(params
    .filter(([name]) => termNames.includes(name) || name === 'cat')
    .map(([name, value]) => [name, value]))).digest('hex');
  return { params, queryFields, page, pageSize, advertiserMid, queryFingerprint };
}

export function rakutenAdvertisingContract() {
  return Object.freeze({
    apiOrigin: API_ORIGIN,
    productSearchPath: SEARCH_PATH,
    maxPageSize: MAX_PAGE_SIZE,
    conservativeResultCap: MAX_CONSERVATIVE_RESULTS,
    maxCollectPages: MAX_COLLECT_PAGES,
    allowedLanguages: [...LANGUAGES],
    productSearchGuide: PRODUCT_SEARCH_GUIDE,
    productSearchReference: PRODUCT_SEARCH_REFERENCE,
  });
}

export function createRakutenAdvertisingProductSearchClient({
  accessToken,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleepImpl = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  timeoutMs = 15_000,
  maxResponseBytes = MAX_XML_BYTES,
} = {}) {
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 8_192 ||
      accessToken !== accessToken.trim() || /[\s\x00-\x1f\x7f]/.test(accessToken)) {
    fail('RAKUTEN_ACCESS_TOKEN_REQUIRED');
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof sleepImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_XML_BYTES) {
    fail('RAKUTEN_CLIENT_OPTIONS_INVALID');
  }

  const limiter = { lastRequestAt: null, tail: Promise.resolve() };

  async function withRequestSlot(operation) {
    const previous = limiter.tail;
    let release;
    limiter.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (limiter.lastRequestAt !== null) {
        const delay = limiter.lastRequestAt + MIN_REQUEST_INTERVAL_MS - Number(now());
        if (delay > 0) await sleepImpl(delay);
      }
      limiter.lastRequestAt = Number(now());
      return await operation();
    } finally {
      release();
    }
  }

  async function readXmlResponse(response, receipt) {
    const status = response.status;
    const mime = responseMime(response);
    const current = { ...receipt, httpStatus: status, mime };
    if ([301, 302, 303, 307, 308].includes(status) || response.redirected) {
      await response.body?.cancel().catch(() => {});
      fail('RAKUTEN_REDIRECT_REJECTED', { ...current, redirectFollowed: false });
    }
    if (status === 401) fail('RAKUTEN_AUTH_REQUIRED', current);
    if (status === 403) fail('RAKUTEN_ACCESS_DENIED', current);
    if (status === 429) fail('RAKUTEN_RATE_LIMITED', current);
    if (status >= 500) fail('RAKUTEN_UPSTREAM_FAILED', current);
    if (status !== 200 || !MIME_XML.has(mime)) {
      await response.body?.cancel().catch(() => {});
      fail('RAKUTEN_RESPONSE_INVALID', current);
    }
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      await response.body?.cancel().catch(() => {});
      fail('RAKUTEN_RESPONSE_TOO_LARGE', { ...current, responseBytes: declaredLength });
    }
    if (!response.body?.getReader) fail('RAKUTEN_RESPONSE_INVALID', current);
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxResponseBytes) {
          await reader.cancel().catch(() => {});
          fail('RAKUTEN_RESPONSE_TOO_LARGE', { ...current, responseBytes: bytes });
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const raw = Buffer.concat(chunks, bytes);
    let xml;
    try { xml = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
    catch { fail('RAKUTEN_RESPONSE_ENCODING_INVALID', { ...current, responseBytes: bytes }); }
    return {
      xml,
      request: { ...current, responseBytes: bytes, responseSha256: createHash('sha256').update(raw).digest('hex') },
    };
  }

  async function searchProducts(input) {
    const search = validateSearchInput(input);
    const url = new URL(SEARCH_PATH, API_ORIGIN);
    for (const [name, value] of search.params) url.searchParams.append(name, value);
    return withRequestSlot(async () => {
      const checkedAt = safeCheckedAt(now);
      const baseRequest = {
        method: 'GET',
        origin: API_ORIGIN,
        path: SEARCH_PATH,
        checkedAt,
        browserUsed: false,
        anonymous: false,
        credentialsUsed: true,
        cookieSent: false,
        authHeader: 'authorization',
        queryFields: search.queryFields,
        queryFingerprint: search.queryFingerprint,
        ...(search.advertiserMid ? { advertiserMid: search.advertiserMid } : {}),
      };
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/xml', authorization: 'Bearer ' + accessToken },
          redirect: 'manual',
          credentials: 'omit',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        fail('RAKUTEN_TRANSPORT_FAILED', {
          ...baseRequest,
          causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR',
        });
      }
      const { xml, request } = await readXmlResponse(response, baseRequest);
      const parsed = parseSearchResponse(xml, {
        requestedPage: search.page,
        pageSize: search.pageSize,
        requestedMid: search.advertiserMid,
        checkedAt,
      });
      const receipt = {
        schema: 'web-api-credentialed-read-receipt-v1',
        service: 'rakuten-advertising',
        capabilityId: 'catalog.product_search',
        checkedAt,
        secretsPersistedInEvidence: false,
        authenticated: true,
        credentialsUsed: true,
        anonymous: false,
        credentialBindingVerified: true,
        credentialBinding: {
          source: 'process-memory',
          serviceMatched: true,
          originMatched: true,
          persisted: false,
        },
        schemaVerified: true,
        expectedResultVerified: true,
        contractProvenance: {
          kind: 'first_party_documented_api',
          sourceURL: PRODUCT_SEARCH_GUIDE,
        },
        request: {
          ...request,
          ...(parsed.items.length ? { productCount: parsed.items.length } : {}),
          page: parsed.pagination.page,
          pageSize: parsed.pagination.pageSize,
          totalMatches: parsed.pagination.totalMatches,
          totalPages: parsed.pagination.totalPages,
          identityMatched: true,
        },
      };
      return { provider: 'rakuten-advertising', items: parsed.items, pagination: parsed.pagination, receipt };
    });
  }

  async function collectProducts({ maxResults = MAX_CONSERVATIVE_RESULTS, ...filters } = {}) {
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_CONSERVATIVE_RESULTS ||
        (filters.page !== undefined && filters.page !== 1) ||
        (filters.pageSize !== undefined && filters.pageSize !== MAX_PAGE_SIZE)) {
      fail('RAKUTEN_COLLECTION_LIMIT_INVALID');
    }
    const pageSize = MAX_PAGE_SIZE;
    const pageLimit = Math.min(MAX_COLLECT_PAGES, Math.ceil(maxResults / pageSize));
    const items = [];
    const receipts = [];
    const seen = new Set();
    let firstPagination = null;
    let complete = false;
    let completionReason = null;
    for (let page = 1; page <= pageLimit; page += 1) {
      const result = await searchProducts({ ...filters, page, pageSize });
      receipts.push(result.receipt);
      if (firstPagination && (result.pagination.totalMatches !== firstPagination.totalMatches ||
          result.pagination.totalPages !== firstPagination.totalPages)) {
        completionReason = 'result_set_changed_during_pagination';
        break;
      }
      firstPagination ??= result.pagination;
      for (const item of result.items) {
        if (seen.has(item.productId)) fail('RAKUTEN_DUPLICATE_PRODUCT_ID_ACROSS_PAGES', {
          pagesRead: receipts.length,
        });
        seen.add(item.productId);
        items.push(item);
        if (items.length >= maxResults) break;
      }
      if (items.length >= maxResults) {
        completionReason = firstPagination.totalMatches > maxResults ? 'caller_result_limit' : null;
        complete = firstPagination.totalMatches <= maxResults && firstPagination.totalMatches <= MAX_CONSERVATIVE_RESULTS;
        break;
      }
      if (page >= firstPagination.totalPages || firstPagination.totalPages === 0) {
        complete = items.length === firstPagination.totalMatches;
        completionReason = complete ? null : 'pagination_ended_before_reported_total';
        break;
      }
      if (result.items.length === 0) {
        completionReason = 'empty_page_before_reported_end';
        break;
      }
    }
    if (!firstPagination) fail('RAKUTEN_COLLECTION_EMPTY');
    if (!complete && !completionReason) {
      completionReason = firstPagination.totalMatches > MAX_CONSERVATIVE_RESULTS
        ? 'official_result_limit_discrepancy_conservative_cap'
        : 'collection_page_bound_reached';
    }
    if (firstPagination.totalMatches > MAX_CONSERVATIVE_RESULTS) {
      complete = false;
      completionReason = 'official_result_limit_discrepancy_conservative_cap';
    }
    return {
      provider: 'rakuten-advertising',
      items,
      pagination: {
        ...firstPagination,
        pagesRead: receipts.length,
        complete,
        ...(completionReason ? { incompleteReason: completionReason } : {}),
        ...(firstPagination.totalMatches > MAX_CONSERVATIVE_RESULTS ? { sourceResultCapApplied: true } : {}),
      },
      receipts,
    };
  }

  return Object.freeze({ searchProducts, collectProducts });
}
