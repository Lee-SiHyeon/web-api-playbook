import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';
import { extractPublicPage, readPublicPage, readPublicResource, safeUrl, textContent } from '../../lib/cps-public-reader.mjs';
import { collectMytheresaPublicNative } from './mytheresa-native.mjs';
import { collectFailurePathMerchant } from './failure-path-supplement.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../..');
const TAXONOMY_PATH = path.join(APP_ROOT, 'references/linkprice-cps-vertical-taxonomy.v1.json');
const RESULT_PATH = path.join(APP_ROOT, 'references/cps-reverify/batch-07.json');
const MYTHERESA_SUPPLEMENT_PATH = path.join(APP_ROOT, 'references/cps-reverify/mytheresa-native-supplement.json');
const MAX_PAGE_READS = 6;
const MAX_REQUESTS_PER_SOURCE = 8;
const MAX_PAGE_BYTES = 6 * 1024 * 1024;

export const merchantIds = Object.freeze([
  'mytheresa', 'hotelskr', 'netaporter', 'farfetch', 'ashford1', 'eyoumall', 'aliexpress',
  'shutter', 'finishline', 're4akor', 'mycredit1', 'yoox', 'expedia', 'cappstory',
]);

const taxonomy = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8').replace(/^\uFEFF/, ''));
const merchantById = new Map(merchantIds.map(id => {
  const merchant = taxonomy.merchants.find(row => row.merchantId === id);
  if (!merchant) throw new Error(`TAXONOMY_MERCHANT_MISSING:${id}`);
  return [id, merchant];
}));
const priorResult = readJsonIfPresent(RESULT_PATH);

function readJsonIfPresent(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function providerRoot(hostname) {
  const labels = hostname.toLowerCase().replace(/^www\./, '').split('.');
  const multiLabelSuffixes = new Set(['co.kr', 'or.kr', 'go.kr', 'ac.kr', 'ne.kr', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.uk']);
  const lastTwo = labels.slice(-2).join('.');
  return labels.slice(-(multiLabelSuffixes.has(lastTwo) ? 3 : 2)).join('.');
}

function allowedHostsFor(merchant) {
  const host = new URL(merchant.siteUrl).hostname.toLowerCase();
  return [...new Set([host, providerRoot(host)])];
}

function priorMerchant(id, supplied) {
  const prior = supplied ?? priorResult;
  return prior?.merchants?.find(row => row.merchantId === id) ?? null;
}

function normalizeOldReceipt(row, index) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id ?? row.receiptId ?? `batch-07-old-${index + 1}`,
    requestMethod: row.requestMethod ?? row.method ?? 'GET',
    requestUrl: safeUrl(row.requestUrl),
    responseStatus: Number.isInteger(row.responseStatus) ? row.responseStatus : Number.isInteger(row.httpStatus) ? row.httpStatus : null,
    contentType: row.contentType ?? null,
    bytes: Number.isSafeInteger(row.bytes) ? row.bytes : 0,
    responseSha256: row.responseSha256 ?? null,
    observedAt: row.observedAt ?? row.checkedAt ?? null,
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    secureTransport: typeof row.secureTransport === 'boolean' ? row.secureTransport : safeUrl(row.requestUrl)?.startsWith('https://') ?? null,
    ...(row.redirectTo ? { redirectTo: safeUrl(row.redirectTo) } : {}),
    ...(row.blocked ? { blocked: true, retry: false } : {}),
  };
}

function observedHttpsStart(merchant, prior) {
  const initial = new URL(merchant.siteUrl);
  if (initial.protocol === 'https:') return initial.href;
  const oldReceipts = prior?.receipts ?? [];
  const redirect = oldReceipts.find(row => safeUrl(row.requestUrl) === safeUrl(merchant.siteUrl)
    && Number(row.responseStatus ?? row.httpStatus) >= 300 && Number(row.responseStatus ?? row.httpStatus) < 400
    && typeof row.redirectTo === 'string' && row.redirectTo.startsWith('https://'));
  return redirect ? safeUrl(redirect.redirectTo) : null;
}

function typeOfSchema(row, vertical) {
  const values = Array.isArray(row?.['@type']) ? row['@type'] : row?.['@type'] ? [row['@type']] : [];
  const types = values.map(value => String(value).split(/[\/#]/).at(-1).toLowerCase());
  if (types.some(type => ['hotel', 'lodgingbusiness', 'touristtrip', 'trip', 'flight', 'traintrip', 'touristdestination'].includes(type))) return 'TravelOffering';
  if (types.some(type => ['service', 'financialproduct', 'course'].includes(type))) return 'ServiceOffering';
  if (types.some(type => ['softwareapplication', 'creativework'].includes(type))) return 'DigitalContent';
  if (types.some(type => ['product', 'productgroup', 'productcollection', 'book'].includes(type))) return vertical === 'travel' ? 'TravelOffering' : 'RetailProduct';
  return null;
}

function asList(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function first(...values) { return values.find(value => value !== undefined && value !== null && value !== '') ?? null; }
function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string' || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value.trim())) return null;
  const result = Number(value.replaceAll(',', ''));
  return Number.isFinite(result) ? result : null;
}
function integerValue(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}
function jsonLdPrice(row) {
  const offer = asList(row.offers).find(value => value && typeof value === 'object') ?? {};
  const spec = offer.priceSpecification && typeof offer.priceSpecification === 'object' ? offer.priceSpecification : {};
  const rawPrice = first(row.price, offer.price, spec.price, offer.lowPrice);
  const currencyRaw = first(row.priceCurrency, offer.priceCurrency, spec.priceCurrency);
  return rawPrice == null && currencyRaw == null ? null : {
    amount: numberValue(rawPrice),
    currency: typeof currencyRaw === 'string' && /^[A-Za-z]{3}$/.test(currencyRaw) ? currencyRaw.toUpperCase() : null,
    priceText: rawPrice == null ? null : String(rawPrice),
  };
}
function jsonLdOffers(row, baseUrl) {
  return asList(row.offers).filter(offer => offer && typeof offer === 'object').slice(0, 20).map(offer => {
    const specs = asList(offer.priceSpecification).filter(spec => spec && typeof spec === 'object');
    const exact = first(offer.price, ...specs.map(spec => spec.price));
    const low = first(offer.lowPrice, ...specs.map(spec => spec.minPrice));
    const high = first(offer.highPrice, ...specs.map(spec => spec.maxPrice));
    const rawCurrency = first(offer.priceCurrency, ...specs.map(spec => spec.priceCurrency));
    const currency = typeof rawCurrency === 'string' && /^[A-Za-z]{3}$/.test(rawCurrency) ? rawCurrency.toUpperCase() : null;
    const rawAvailability = String(offer.availability ?? '').split(/[\/#]/).at(-1);
    const availability = ({ InStock: 'in_stock', OutOfStock: 'out_of_stock', PreOrder: 'preorder', BackOrder: 'backorder', LimitedAvailability: 'limited' })[rawAvailability] ?? 'unknown';
    const rawUrl = first(offer.url);
    let url = null;
    if (typeof rawUrl === 'string') { try { const parsed = new URL(rawUrl, baseUrl); if (providerRoot(parsed.hostname) === providerRoot(new URL(baseUrl).hostname)) url = safeUrl(parsed.href); } catch {} }
    return { amount: numberValue(exact), currency, priceText: exact == null && (low != null || high != null) ? `${low ?? ''}${low != null && high != null && low !== high ? '–' : ''}${high ?? ''}${currency ? ` ${currency}` : ''}` : exact == null ? null : String(exact), lowPrice: numberValue(low), highPrice: numberValue(high), availability, seller: typeof offer.seller === 'string' ? offer.seller : offer.seller?.name ?? null, validUntil: offer.priceValidUntil ?? null, url };
  });
}
function jsonLdRating(row) {
  const aggregate = row.aggregateRating;
  if (!aggregate || typeof aggregate !== 'object') return null;
  const value = numberValue(aggregate.ratingValue), best = numberValue(aggregate.bestRating), worst = numberValue(aggregate.worstRating);
  const reviewCount = integerValue(aggregate.reviewCount), ratingCount = integerValue(aggregate.ratingCount);
  return value == null && best == null && worst == null && reviewCount == null && ratingCount == null ? null : { value, best, worst, reviewCount, ratingCount };
}

function productMeasuresFromTitle(title) {
  const measures = [];
  const pattern = /(\d+(?:\.\d+)?)\s*(ml|mL|l|L|kg|g|개입|개|매|정|포|캡슐|입|장|세트)/g;
  for (const match of String(title ?? '').matchAll(pattern)) {
    const prefix = String(title ?? '').slice(Math.max(0, match.index - 12), match.index);
    const qualifier = prefix.match(/(?:건조\s*후|개봉\s*후|조리\s*후)\s*$/)?.[0]?.trim() ?? null;
    measures.push({ amount: Number(match[1]), unit: match[2].toLowerCase(), sourceText: match[0].replace(/\s+/g, ''), ...(qualifier ? { qualifier } : {}) });
  }
  return measures;
}

function visitDom(node, callback) {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const child of node.childNodes ?? []) visitDom(child, callback);
}

function classText(node) {
  return (node?.attrs ?? []).find(attr => attr.name === 'class')?.value ?? '';
}

function parseWon(text) {
  const match = String(text ?? '').replace(/\s+/g, ' ').match(/(?<![\d*])([\d,]+)\s*원/);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ''));
  return Number.isSafeInteger(amount) && amount > 0 ? { amount, currency: 'KRW', priceText: `${match[1]}원` } : null;
}

function observedEyoumallPrice(page) {
  const root = parseFragment(page.html ?? '');
  const matches = [];
  visitDom(root, node => {
    if (node.tagName !== 'div') return;
    const text = String(textContent(node, 500) ?? '').replace(/\s+/g, ' ').trim();
    if (/(?:^|\s)goods_price(?:\s|$)/.test(classText(node))) {
      const price = parseWon(text);
      if (price) matches.push({ ...price, locator: 'HTML div.goods_price', text });
    }
  });
  // Product pages can also contain recommendation cards. Only attach a
  // current price when exactly one positive primary-price node is present.
  if (matches.length !== 1) return null;

  const conditionNodes = [];
  visitDom(root, node => {
    if (node.tagName !== 'div' || !/(?:^|\s)goods_price_item(?:\s|$)/.test(classText(node))) return;
    const text = String(textContent(node, 500) ?? '').replace(/\s+/g, ' ').trim();
    if (text && /최초판매가|할인|%/.test(text)) conditionNodes.push(text);
  });
  const conditionText = conditionNodes.find(text => parseWon(text)?.amount !== matches[0].amount)
    ?? conditionNodes[0] ?? null;
  let condition = null;
  if (conditionText) {
    const discount = conditionText.match(/(\d{1,3})\s*%/);
    const reference = conditionText.match(/([\d,]+)\s*원\s*최초판매가/);
    condition = [discount ? `${discount[1]}% discounted` : null, reference ? `${reference[1]}원 최초판매가` : null]
      .filter(Boolean).join('; ') || conditionText;
  }
  return { ...matches[0], condition, conditionLocator: conditionText ? 'HTML div.goods_price_item' : null };
}

function eyoumallPriceAbsence(page) {
  const root = parseFragment(page.html ?? '');
  const primaryPriceTexts = [], zeroCartTotal = [];
  visitDom(root, node => {
    if (node.tagName !== 'div') return;
    const text = String(textContent(node, 500) ?? '').replace(/\s+/g, ' ').trim();
    if (/(?:^|\s)goods_price(?:\s|$)/.test(classText(node))) primaryPriceTexts.push(text);
    if (/(?:^|\s)tot_price(?:\s|$)/.test(classText(node)) && /^0\s*원?$/.test(text)) zeroCartTotal.push(text);
  });
  const masked = primaryPriceTexts.some(text => /\*[,*]*/.test(text));
  return { masked, zeroCartTotalObserved: zeroCartTotal.length > 0 };
}

function observedEyoumallListingPrices(page) {
  const root = parseFragment(page.html ?? '');
  const output = [];
  const classValue = (node, name) => {
    const found = [];
    visitDom(node, child => {
      if (child.tagName && classText(child).split(/\s+/).includes(name)) {
        const text = String(textContent(child, 250) ?? '').replace(/\s+/g, ' ').trim();
        if (text) found.push(text);
      }
    });
    return found[0] ?? null;
  };
  const visitLinks = (node, ancestors = []) => {
    if (node?.tagName === 'a') {
      const href = (node.attrs ?? []).find(attr => attr.name === 'href')?.value ?? '';
      const target = safeUrl(href, page.url);
      let parsed;
      try { parsed = new URL(target); } catch { parsed = null; }
      if (parsed && parsed.origin === new URL(page.url).origin && /\/shop\/goods\/item_view\.php$/i.test(parsed.pathname)) {
        const sourceLocalId = parsed.searchParams.get('no');
        const card = [...ancestors, node].reverse().find(item => item.tagName === 'li');
        if (sourceLocalId && card) {
          const currentText = classValue(card, 'dc_price_price');
          const strikeText = classValue(card, 'dc_price_strike');
          const discountText = classValue(card, 'dc_price');
          const price = parseWon(currentText);
          if (price) {
            const discount = discountText?.match(/\d{1,3}/)?.[0] ?? null;
            const reference = parseWon(strikeText);
            const condition = [discount ? `${discount}% discounted` : null,
              reference ? `reference price ${reference.priceText} (struck through)` : null].filter(Boolean).join('; ') || null;
            output.push({ sourceLocalId, url: safeUrl(parsed.href), ...price, condition,
              locator: 'HTML linked item_view card li .dc_price_price + .dc_price_strike + .dc_price' });
          }
        }
      }
    }
    const next = [...ancestors, node];
    for (const child of node?.childNodes ?? []) visitLinks(child, next);
  };
  visitLinks(root);
  return [...new Map(output.map(item => [item.sourceLocalId, item])).values()];
}

function jsonLdFallbackRecords(extraction, page, merchant, kind) {
  const pathname = new URL(page.url).pathname.toLowerCase();
  const pageCopy = `${extraction.title ?? ''} ${extraction.description ?? ''}`;
  if (/(?:\b(?:about|promotion|promotions|promo|press|news|release)\b|소개|프.?모로션|프모션|보도자료|유럽소식)/i.test(pageCopy)) return [];
  if (/\/(?:search|catalog|category|collection|items?|list|new-arrivals|current-week|sitemap|promotions?|about)(?:\/|\.|$)/i.test(pathname)
    || /deliverycommitment|campaign|manifest/i.test(pathname)) return [];
  const commercialType = row => typeOfSchema(row, merchant.verticalHint);
  const hasLocalIdentity = row => first(row.sku, row.gtin, row.gtin8, row.gtin12, row.gtin13, row.gtin14, row.isbn, row.mpn, row.productID);
  const hasConditionEvidence = row => row.price != null || row.offers != null || row.aggregateRating != null
    || row.serviceType != null || row.category != null;
  return (extraction.jsonLd ?? []).filter(row => commercialType(row) && first(row.name, row.headline)
    && hasLocalIdentity(row) && hasConditionEvidence(row))
    .slice(0, 15).map((row, index) => {
      const type = typeOfSchema(row, merchant.verticalHint);
      const sourceLocalId = first(row.sku, row.gtin, row.gtin8, row.gtin12, row.gtin13, row.gtin14, row.isbn, row.mpn, row.productID);
      const rating = jsonLdRating(row);
      const price = jsonLdPrice(row);
      const reviews = asList(first(row.review, row.reviews)).filter(item => item && typeof item === 'object').slice(0, 8).map(review => ({
        title: first(review.name, review.headline) ?? null,
        rating: numberValue(review.reviewRating?.ratingValue),
        publishedAt: typeof review.datePublished === 'string' ? review.datePublished.slice(0, 40) : null,
        optionText: null,
        helpfulCount: null,
        hasMedia: review.image == null ? null : Boolean(review.image),
        reviewerIdentity: null,
      }));
      const variants = asList(row.hasVariant).filter(item => item && typeof item === 'object').slice(0, 30).map(item => ({
        sourceLocalId: first(item.sku, item.gtin, item.mpn) ?? null,
        title: item.name ?? null,
        attributes: Object.fromEntries(['color', 'size', 'material'].filter(key => item[key] != null).map(key => [key, typeof item[key] === 'object' ? item[key].name ?? null : item[key]])),
        offers: jsonLdOffers(item, page.url),
      }));
      const offers = jsonLdOffers(row, page.url);
      const title = first(row.name, row.headline);
      const description = first(row.description, row.disambiguatingDescription);
      const brandRaw = typeof row.brand === 'string' ? row.brand : row.brand?.name;
      const locator = `JSON-LD ${Array.isArray(row['@type']) ? row['@type'].join('|') : row['@type'] ?? 'Thing'}:${index + 1}`;
      const fields = ['type', 'title', 'url'];
      if (sourceLocalId != null) fields.push('sourceLocalId');
      if (description != null) fields.push('description');
      if (brandRaw != null) fields.push('brand');
      if (price != null) fields.push('price');
      if (offers.length) fields.push('offers');
      if (rating != null) fields.push('rating');
      if (variants.length) fields.push('variants');
      if (reviews.length) fields.push('reviewSamples');
      return {
        type, sourceLocalId: sourceLocalId == null ? null : String(sourceLocalId), title, url: safeUrl(page.url),
        description, brand: brandRaw ?? null, price, offers, rating, variants, reviewSamples: reviews,
        evidence: [{ receiptId: page.receipt.id, locator, fields }],
      };
    });
}

function normalizeExtractedRecords(extraction, page, merchant, kind) {
  const records = (extraction.records ?? []).map(record => ({
    ...record,
    type: merchant.verticalHint === 'travel' && record.type === 'RetailProduct' ? 'TravelOffering' : record.type,
    url: safeUrl(record.url) ?? safeUrl(page.url),
    ...(merchant.merchantId === 'eyoumall' ? { productMeasures: productMeasuresFromTitle(record.title) } : {}),
    reviewSamples: (record.reviewSamples ?? []).map(review => ({
      title: review.title ?? null, rating: review.rating ?? null, publishedAt: review.publishedAt ?? null,
      optionText: null, helpfulCount: null, hasMedia: null, reviewerIdentity: null,
    })),
  })).map(record => {
    const fields = ['type'];
    for (const [field, value] of Object.entries({ sourceLocalId: record.sourceLocalId, title: record.title, url: record.url,
      description: record.description, brand: record.brand,
      price: record.price && (record.price.amount != null || record.price.priceText != null) ? record.price : null,
      productMeasures: record.productMeasures?.length ? record.productMeasures : null,
      condition: record.condition ?? null,
      offers: record.offers?.length ? record.offers : null,
      rating: record.rating && (record.rating.value != null || record.rating.reviewCount != null || record.rating.ratingCount != null) ? record.rating : null,
      variants: record.variants?.length ? record.variants : null,
      reviewSamples: record.reviewSamples?.length ? record.reviewSamples : null })) if (value != null) fields.push(field);
    return { ...record, evidence: (record.evidence?.length ? record.evidence : [{ receiptId: page.receipt.id, locator: 'JSON-LD offering' }]).map(item => ({ ...item, fields })) };
  });
  const concrete = records.filter(record => {
    const pageCopy = `${extraction.title ?? ''} ${extraction.description ?? ''}`;
    if (/(?:\b(?:about|promotion|promotions|promo|press|news|release)\b|소개|프.?모로션|프모션|보도자료|유럽소식)/i.test(pageCopy)) return false;
    if (merchant.verticalHint !== 'travel') return true;
    const offeringCopy = `${record.title ?? ''} ${record.description ?? ''} ${record.brand ?? ''}`;
    return /\b(?:hotel|lodging|flight|train|railway pass|rail pass|train ticket|eurail|interrail|swiss travel pass)\b|호텔|숙박|항공|열차|기차|철도|패스|승차권|기차표/i.test(offeringCopy);
  });
  if (concrete.length) return concrete;
  return jsonLdFallbackRecords(extraction, page, merchant, kind).filter(record => {
    if (merchant.verticalHint !== 'travel') return true;
    const offeringCopy = `${record.title ?? ''} ${record.description ?? ''} ${record.brand ?? ''}`;
    return /\b(?:hotel|lodging|flight|train|railway pass|rail pass|train ticket|eurail|interrail|swiss travel pass)\b|호텔|숙박|항공|열차|기차|철도|패스|승차권|기차표/i.test(offeringCopy);
  });
}

function isSensitiveLink(raw) {
  try { return [...new URL(raw).searchParams.keys()].some(key => /token|auth|session|password|secret|csrf|email|phone|account|credential|api[_-]?key/i.test(key)); }
  catch { return true; }
}

function classifyLink(link, merchant) {
  let url;
  try { url = new URL(link.url); } catch { return null; }
  if (url.protocol !== 'https:' || isSensitiveLink(url.href)) return null;
  if (providerRoot(url.hostname) !== providerRoot(new URL(merchant.siteUrl).hostname)) return null;
  const excluded = /\/(?:login|signin|sign-in|signup|account|cart|checkout|wishlist|help|faq|privacy|terms|contact|support|sitemap|press|news|release|about|promotions?|campaigns?)(?:\/|\.|$)/i;
  if (excluded.test(url.pathname) || /\.(?:css|js|png|jpe?g|gif|svg|webp|ico|woff2?)(?:$|\?)/i.test(url.pathname)) return null;
  const text = String(link.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 260) return null;
  const combined = `${text} ${url.pathname} ${url.search}`.toLowerCase();
  if (/deliverycommitment|sitemap|manifest/i.test(combined)) return null;
  if (/\b(?:about|promotion|promotions|promo|press|news|release)\b|소개|프.?모로션|프모션|보도자료|유럽소식/i.test(combined)) return null;
  if (/\.(?:pdf|docx?|xlsx?|pptx?)(?:$|\?)/i.test(url.pathname)) return null;
  const isListing = /\/(?:plp|items?\.aspx|item_list|search|category|collection|shoponline|new-arrivals)(?:\/|\.|$)/i.test(url.pathname);
  const detail = !isListing && /(?:item_view|goods_view|\/product\/[^/]+|\/dp\/[^/]+|\/p\/[^/]+|\/sku\/[^/]+|goods_no\s*=|product_id\s*=|sku_id\s*=|hotel\/[^/]+|property\/[^/]+|train\/[^/]+|ticket\/[^/]+|stay\/[^/]+|room\/[^/]+)/i.test(combined);
  const verticalPattern = merchant.verticalHint === 'travel'
    ? /hotel|flight|train|rail|ticket|stay|room|destination|route|eurail|swiss travel|pass|호텔|항공|열차|기차|여행|노선|패스|승차권|철도/i
    : merchant.verticalHint === 'financial_or_professional_service'
      ? /price|pricing|plan|service|credit|score|monitor|package|상품|서비스|신용|요금|가격/i
      : merchant.verticalHint === 'digital_software'
        ? /plan|license|subscription|pricing|download|asset|service|요금|가격|구독|서비스/i
        : /shop|women|men|product|item|goods|sale|new|collection|category|catalog|상품|여성|남성|신상품|할인/i;
  const category = verticalPattern.test(combined) || isListing;
  if (!detail && !category) return null;
  const productLike = detail && merchant.verticalHint !== 'travel' && merchant.verticalHint !== 'financial_or_professional_service';
  return { url: safeUrl(url.href), text, kind: detail && productLike ? 'observed_product_detail' : merchant.verticalHint === 'travel' || merchant.verticalHint === 'financial_or_professional_service' ? 'observed_service_detail' : isListing ? 'observed_category' : 'observed_category', productLike };
}

function rankCandidate(candidate, merchant) {
  const text = `${candidate.text} ${candidate.url}`.toLowerCase();
  const retailBias = /item_view|product|products|goods|detail|sku|\/dp\/|\/p\/|product_id|goods_no/i;
  const serviceBias = merchant.verticalHint === 'financial_or_professional_service'
    ? /price|pricing|plan|service|credit|score|subscription|요금|가격|서비스|신용/i
    : merchant.verticalHint === 'travel' ? /hotel|flight|train|rail|ticket|stay|route|eurail|swiss travel|pass|호텔|항공|열차|기차|여행|노선|철도패스|유레일 패스|스위스 트래블 패스|승차권/i
      : merchant.verticalHint === 'digital_software' ? /plan|license|subscription|pricing|download|요금|구독|가격/i : retailBias;
  const depth = new URL(candidate.url).pathname.split('/').filter(Boolean).length;
  const topicalLeaf = depth >= 3 && !/\/kr\/(?:여성|남성)\/?$/i.test(new URL(candidate.url).pathname);
  const nonOfferingBias = /(?:sitemap|deliverycommitment|press|release|news|about|promotion|promo|보도자료|유럽소식|프로모션|소개)/i.test(text) ? -100 : 0;
  return (candidate.kind === 'observed_product_detail' ? 10 : 0) + (serviceBias.test(text) ? 8 : 0) + (candidate.productLike ? 5 : 0) + (topicalLeaf ? 4 : 0) + nonOfferingBias;
}

function observedScriptResources(html, baseUrl, merchant) {
  const root = parseFragment(html);
  const output = [];
  const visit = node => {
    if (node?.tagName === 'script') {
      const raw = node.attrs?.find(attribute => attribute.name === 'src')?.value;
      if (raw) {
        const url = safeUrl(raw, baseUrl);
        if (url) {
          try {
            const parsed = new URL(url);
            if (parsed.protocol === 'https:' && providerRoot(parsed.hostname) === providerRoot(new URL(merchant.siteUrl).hostname)
              && /\.(?:m?js|json)(?:$|\?)/i.test(parsed.pathname) && !isSensitiveLink(parsed.href)) output.push(url);
          } catch { /* Ignore malformed public resource links. */ }
        }
      }
    }
    for (const child of node?.childNodes ?? []) visit(child);
  };
  visit(root);
  return [...new Set(output)].sort((a, b) => Number(/\.json(?:$|\?)/i.test(b)) - Number(/\.json(?:$|\?)/i.test(a))).slice(0, 20);
}

function inspectMytheresaScriptWithoutExecution(source, scriptUrl) {
  const declarations = new Map();
  const declarationPattern = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(https?:\/\/[^"']+|\/[A-Za-z0-9_./?=&%-]+)\2/g;
  for (const match of source.matchAll(declarationPattern)) declarations.set(match[1], match[3]);
  const callSites = [...source.matchAll(/\.open\(\s*(["'])(GET|POST|PUT|PATCH|DELETE)\1\s*,\s*([A-Za-z_$][\w$]*|["'][^"']+["'])/gi)];
  let firstParty = 0, crossOrigin = 0, unresolved = 0;
  const methods = new Set();
  for (const match of callSites) {
    const method = match[2].toUpperCase();
    methods.add(method);
    const rawTarget = match[3].startsWith('"') || match[3].startsWith("'") ? match[3].slice(1, -1) : declarations.get(match[3]);
    if (!rawTarget) { unresolved += 1; continue; }
    try {
      const target = new URL(rawTarget, scriptUrl);
      const script = new URL(scriptUrl);
      if (target.origin === script.origin || target.hostname === 'mytheresa.com' || target.hostname.endsWith('.mytheresa.com')) firstParty += 1;
      else crossOrigin += 1;
    } catch { unresolved += 1; }
  }
  return {
    executed: false,
    bodyPersisted: false,
    xhrCallsiteCount: callSites.length,
    xhrMethods: [...methods],
    firstPartyXhrCallsiteCount: firstParty,
    crossOriginXhrCallsiteCount: crossOrigin,
    unresolvedXhrCallsiteCount: unresolved,
    firstPartyCatalogRequestObserved: false,
    publicCatalogContractObserved: false,
    observedStaticPathMention: source.includes('/search/') ? '/search/' : null,
    pathMentionUsedAsRequest: false,
    note: 'Static code inspection only: the observed XHR call sites are cross-origin telemetry; no first-party catalog request contract was present in this resource.',
  };
}

async function readObservedPublicResource(merchant, page, report) {
  if (!page?.ok || !page.html) return { attempted: false, blocked: false, candidates: [] };
  const resources = observedScriptResources(page.html, page.url, merchant);
  if (!resources.length) return { attempted: false, blocked: false, candidates: [] };
  const url = resources[0];
  const observedAt = new Date().toISOString();
  const resource = await readPublicResource(url, {
    allowedHosts: allowedHostsFor(merchant), maxRedirects: 3, maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000,
  });
  makeReceiptPage(resource, merchant.merchantId, report);
  const resourceType = /.json(?:$|\?)/i.test(new URL(url).pathname)
    || /(?:application|text)\/(?:[^;]+\+)?json/i.test(resource.contentType ?? '');
  report.contracts.push({
    operation: 'observed_public_resource_GET', requestUrl: safeUrl(url), finalUrl: resource.url ?? null,
    status: resource.status ?? null, contentType: resource.contentType ?? null,
    observedAt: resource.receipt?.observedAt ?? observedAt,
    browserUsed: false, cookiesSent: false, authorizationSent: false, secureTransport: true,
    stopReason: resource.stopReason ?? null,
    resourceKind: resourceType ? 'observed_json_resource' : 'observed_javascript_resource',
    bodyParsed: false, bodyPersisted: false, evidenceReceiptId: resource.receipt?.id ?? null,
  });
  if (merchant.merchantId === 'mytheresa' && resource.ok && !resourceType) {
    report.contracts.at(-1).staticInspection = inspectMytheresaScriptWithoutExecution(resource.body ?? '', resource.url ?? url);
  }
  const candidates = [];
  if (resource.ok && resourceType && typeof resource.body === 'string') {
    try {
      const parsed = JSON.parse(resource.body);
      const scriptHtml = `<script type="application/ld+json">${JSON.stringify(parsed).replace(/</g, '\\u003c')}</script>`;
      const structuredRead = { ok: true, url: page.url, html: scriptHtml, receipt: resource.receipt };
      const extraction = extractPublicPage(structuredRead, { merchantId: merchant.merchantId, typeHint: merchant.verticalHint });
      const records = normalizeExtractedRecords(extraction, structuredRead, merchant, 'observed_json_public_resource');
      report.records.push(...records);
      const seen = new Set();
      const collectLinkedRows = (value, depth = 0) => {
        if (depth > 12 || !value || typeof value !== 'object') return;
        if (Array.isArray(value)) { for (const item of value.slice(0, 500)) collectLinkedRows(item, depth + 1); return; }
        const types = asList(value['@type']).map(item => String(item).split(/[\/#]/).at(-1).toLowerCase());
        if (types.some(type => ['product', 'productgroup', 'service', 'hotel', 'lodgingbusiness', 'touristtrip', 'trip'].includes(type))) {
          for (const raw of [value.url, value['@id'], value.mainEntityOfPage?.url, value.mainEntityOfPage?.['@id']]) {
            if (typeof raw !== 'string') continue;
            const target = safeUrl(raw, page.url);
            if (!target || target === safeUrl(page.url) || seen.has(target)) continue;
            try {
              const parsedTarget = new URL(target);
              if (parsedTarget.protocol === 'https:' && providerRoot(parsedTarget.hostname) === providerRoot(new URL(merchant.siteUrl).hostname)) {
                seen.add(target);
                candidates.push({ url: target, text: first(value.name, value.headline) ?? 'observed structured public offering link', kind: 'observed_product_detail', productLike: true });
              }
            } catch { /* Ignore malformed structured URLs. */ }
          }
        }
        for (const child of Object.values(value).slice(0, 200)) collectLinkedRows(child, depth + 1);
      };
      collectLinkedRows(parsed);
      report.contracts.at(-1).bodyParsed = true;
    } catch { /* Public resources are retained as receipts unless valid JSON is observed. */ }
  }
  const blocked = Boolean(resource.blocked || ['HEADER_CHALLENGE', 'HTTP_ACCESS_BLOCKED'].includes(resource.stopReason));
  report.frontier.push({ operation: 'observed_public_resource_GET', url: safeUrl(url), state: resource.ok ? 'read' : resource.stopReason,
    retry: false, ...(blocked ? { stopHost: true } : {}), evidenceReceiptId: resource.receipt?.id ?? null });
  return { attempted: true, blocked, candidates };
}

function receiptForRedirect(merchantId, redirect, index, observedAt) {
  return {
    id: `b07-${merchantId}-redirect-${index + 1}`,
    requestMethod: 'GET', requestUrl: safeUrl(redirect.from), responseStatus: redirect.status,
    contentType: null, bytes: 0, responseSha256: null, observedAt,
    browserUsed: false, cookiesSent: false, authorizationSent: false, redirectTo: safeUrl(redirect.to),
  };
}

function makeReceiptPage(page, merchantId, collected) {
  const observedAt = page.receipt?.observedAt ?? new Date().toISOString();
  for (const [index, redirect] of (page.redirects ?? []).entries()) collected.receipts.push({
    ...receiptForRedirect(merchantId, redirect, collected.receipts.length + index, observedAt),
    secureTransport: String(redirect.from ?? '').startsWith('https://'),
  });
  if (page.receipt) collected.receipts.push({ ...page.receipt,
    secureTransport: String(page.receipt.requestUrl ?? page.url ?? '').startsWith('https://') });
}

function recordOperation(report, operation, state, fields = {}) {
  if (Array.isArray(fields.evidenceReceiptIds)) fields = { ...fields, evidenceReceiptIds: [...new Set(fields.evidenceReceiptIds.filter(Boolean))] };
  report.operations[operation] = { state, ...fields };
}

function priorBlockedReport(merchant, prior) {
  const normalized = (prior?.receipts ?? []).map(normalizeOldReceipt).filter(Boolean);
  const priorStatus = Number((prior?.contracts ?? []).find(row => [401, 403, 418, 429].includes(Number(row.status)) || Number(row.status) >= 500)?.status ?? 0);
  const terminalStatus = prior?.state === 'challenge' || prior?.status === 'challenge_stopped' ? 'challenge_stopped'
    : priorStatus >= 500 ? 'server_error_stopped' : 'blocked_stopped';
  return {
    merchantId: merchant.merchantId,
    siteUrl: safeUrl(merchant.siteUrl),
    receipts: normalized,
    records: [],
    contracts: normalized.map(receipt => ({ operation: 'anonymous_public_page_GET', requestUrl: receipt.requestUrl,
      status: receipt.responseStatus, contentType: receipt.contentType, observedAt: receipt.observedAt,
      browserUsed: false, cookiesSent: false, authorizationSent: false, secureTransport: receipt.requestUrl?.startsWith('https://') ?? null,
      evidenceReceiptId: receipt.id, retry: false })),
    operations: {
      productSearch: { state: 'blocked_or_challenge', attempted: false, reason: 'prior_live_response_stop_no_retry' },
      productDetail: { state: 'blocked_or_challenge', attempted: false, reason: 'prior_live_response_stop_no_retry' },
      price: { state: 'not_captured' }, ratingSummary: { state: 'not_captured' }, reviewsList: { state: 'not_captured' },
    },
    frontier: [{ operation: 'public_page_read', url: safeUrl(merchant.siteUrl), state: prior?.code ?? prior?.state ?? 'blocked', retry: false }],
    status: terminalStatus,
    transport: { browserUsed: false, cookiesSent: false, authorizationSent: false, secureTransport: null, reusedPriorReceipt: true },
  };
}

function mergeMytheresaReports(previous, supplement) {
  if (!supplement?.merchantId || supplement.merchantId !== 'mytheresa') return previous;
  const unique = (rows, keyOf) => [...new Map((rows ?? []).map(row => [keyOf(row), row])).values()];
  const records = new Map();
  for (const row of [...(previous?.records ?? []), ...(supplement.records ?? [])]) {
    const key = `${row.sourceLocalId ?? ''}|${row.url ?? ''}|${row.title ?? ''}`;
    const old = records.get(key);
    records.set(key, old ? { ...old, ...row,
      evidence: unique([...(old.evidence ?? []), ...(row.evidence ?? [])], item => `${item.receiptId}|${item.locator}`) } : row);
  }
  const receipts = unique([...(previous?.receipts ?? []), ...(supplement.receipts ?? [])], row => row.id ?? row.receiptId ?? JSON.stringify(row));
  return {
    ...previous, ...supplement,
    siteUrl: safeUrl(supplement.siteUrl) ?? safeUrl(previous?.siteUrl),
    receipts,
    records: [...records.values()],
    contracts: unique([...(previous?.contracts ?? []), ...(supplement.contracts ?? [])], row =>
      row.evidenceReceiptId ? `${row.operation}|${row.evidenceReceiptId}` : JSON.stringify(row)),
    frontier: unique([...(previous?.frontier ?? []), ...(supplement.frontier ?? [])], row =>
      `${row.operation ?? ''}|${row.url ?? ''}|${row.state ?? ''}|${row.evidenceReceiptId ?? ''}`),
    operations: supplement.operations ?? previous?.operations ?? {},
    transport: {
      ...(previous?.transport ?? {}), ...(supplement.transport ?? {}),
      browserUsed: false, cookiesSent: false, authorizationSent: false, authenticated: false,
      secureTransport: receipts.length > 0 && receipts.every(row => row.secureTransport === true),
      latestReadSecureTransport: (supplement.receipts ?? []).length > 0
        && (supplement.receipts ?? []).every(row => row.secureTransport === true),
      helper: 'lib/cps-public-reader.mjs',
    },
    supplementSource: 'references/cps-reverify/mytheresa-public-supplement.json',
    status: supplement.status ?? previous?.status ?? 'reachable_without_offering_record',
  };
}

function retainedCappstoryRecords(records, receipts) {
  const receiptById = new Map((receipts ?? []).map(row => [row.id ?? row.receiptId, row]));
  return (records ?? []).map(record => {
    const ids = (record.evidence ?? []).map(item => item.receiptId).filter(Boolean);
    const times = ids.map(id => receiptById.get(id)?.observedAt).filter(Boolean).sort();
    return { ...record, secureTransport: false,
      retainedEvidence: { state: 'historical_unreverified', originalReceiptIds: ids, originalObservedAt: times.at(-1) ?? null } };
  });
}

function markCappstoryHistorical(report, state, note) {
  const ids = report.records.flatMap(record => record.retainedEvidence?.originalReceiptIds ?? []);
  report.operations = {
    productSearch: { state: 'prior_form_observed_not_submitted', formsSubmitted: 0, evidenceReceiptIds: ids },
    productDetail: { state, recordCount: report.records.length, evidenceReceiptIds: ids, note },
    price: { state: report.records.some(record => record.price?.amount != null) ? 'historical_price_retained_unverified' : 'not_captured',
      recordCount: report.records.filter(record => record.price?.amount != null).length, evidenceReceiptIds: ids },
    ratingSummary: { state: 'not_captured', recordCount: 0, evidenceReceiptIds: [] },
    reviewsList: { state: 'not_captured', sampleCount: 0, complete: false, evidenceReceiptIds: [] },
    productOptions: { state: 'not_captured', variantCount: 0, evidenceReceiptIds: [] },
  };
}

async function collectCappstoryHttp(merchant, previous, priorReceipts) {
  const oldRecords = previous?.records?.length ? previous.records
    : (previous?.quarantinedObservations ?? []).map(item => item.record).filter(Boolean);
  const legacyDetail = oldRecords.find(row => /audio5374/.test(row.url ?? ''))?.url
    ?? previous?.pages?.find(page => /audio5374/.test(page.url ?? ''))?.url
    ?? 'http://c.appstory.co.kr/audio5374';
  const observedDetail = safeUrl(legacyDetail);
  const report = {
    merchantId: 'cappstory', siteUrl: safeUrl(merchant.siteUrl), receipts: [...priorReceipts],
    records: [], contracts: [...(previous?.contracts ?? [])], operations: {}, frontier: [...(previous?.frontier ?? [])],
    status: 'pending', transport: { browserUsed: false, cookiesSent: false, authorizationSent: false,
      secureTransport: false, helper: 'lib/cps-public-reader.mjs', refreshAttempted: false },
  };
  if (!observedDetail) {
    report.records = retainedCappstoryRecords(oldRecords, priorReceipts);
    report.status = 'http_only_detail_url_not_observed';
    report.frontier.push({ operation: 'public_http_product_detail_GET', state: 'no_observed_detail_url', retry: false });
    markCappstoryHistorical(report, 'detail_url_unavailable_historical_record_retained', 'No prior public detail URL was available; preserved old record and receipt time only.');
    return report;
  }

  const page = await readPublicPage(observedDetail, {
    allowedHosts: allowedHostsFor(merchant), maxRedirects: 3, maxBytes: MAX_PAGE_BYTES, timeoutMs: 20_000,
  });
  makeReceiptPage(page, merchant.merchantId, report);
  report.transport.refreshAttempted = true;
  const secureTransport = observedDetail.startsWith('https://');
  report.transport.secureTransport = secureTransport;
  report.transport.latestReadSecureTransport = String(page.url ?? '').startsWith('https://');
  const extraction = page.ok ? extractPublicPage(page, { merchantId: merchant.merchantId, typeHint: merchant.verticalHint })
    : { title: null, description: null, links: [], forms: [], jsonLd: [], embeddedJson: [], records: [] };
  report.contracts.push({ operation: 'anonymous_public_product_detail_GET', requestUrl: observedDetail,
    finalUrl: safeUrl(page.url), status: page.status ?? null, contentType: page.contentType ?? null,
    observedAt: page.receipt?.observedAt ?? new Date().toISOString(), browserUsed: false, cookiesSent: false,
    authorizationSent: false, secureTransport, finalSecureTransport: String(page.url ?? '').startsWith('https://'),
    stopReason: page.stopReason ?? null, title: extraction.title, description: extraction.description,
    jsonLdBlocks: extraction.jsonLd.length, embeddedJsonBlocks: extraction.embeddedJson.length,
    formsObserved: extraction.forms.length, formsSubmitted: false, evidenceReceiptId: page.receipt?.id ?? null,
  });
  const blocked = Boolean(page.blocked || [401, 403, 418, 429].includes(Number(page.status)) || /CHALLENGE/i.test(page.stopReason ?? ''));
  const failed = !page.ok;
  report.frontier.push({ operation: 'public_http_product_detail_GET', url: observedDetail,
    finalUrl: safeUrl(page.url), state: page.ok ? 'read' : page.stopReason ?? 'attempt_without_response', retry: false,
    ...(blocked ? { stopHost: true } : {}), secureTransport, evidenceReceiptId: page.receipt?.id ?? null,
    normalizedProductSchemaRows: page.ok ? extraction.records.length : 0 });
  if (page.ok) {
    const records = normalizeExtractedRecords(extraction, page, merchant, 'public_http_product_detail')
      .map(record => ({ ...record, secureTransport: String(page.url ?? '').startsWith('https://') }));
    if (records.length) {
      report.records = [...new Map(records.map(record => [`${record.type}|${record.sourceLocalId ?? ''}|${record.url}|${record.title}`, record])).values()];
      report.status = String(page.url ?? '').startsWith('https://') ? 'ontology_records_observed' : 'ontology_records_observed_http_only';
      deriveOperations(report);
      return report;
    }
  }

  report.records = retainedCappstoryRecords(oldRecords, priorReceipts);
  if (blocked) report.status = 'blocked_stopped';
  else if (failed) report.status = 'http_refresh_failed_historical_record_retained';
  else report.status = 'reachable_no_current_offering_record_historical_record_retained';
  const historicalState = blocked ? 'blocked_refresh_historical_record_retained'
    : failed ? 'refresh_failed_historical_record_retained' : 'current_product_record_not_observed_historical_record_retained';
  markCappstoryHistorical(report, historicalState,
    failed ? `Live anonymous refresh stopped at ${page.stopReason ?? `HTTP ${page.status ?? 'transport failure'}`}; the prior record remains tied to its original receipt.`
      : 'Refresh was readable but did not return a page-linked product record; the prior record remains tied to its original receipt.');
  return report;
}

const FINISHLINE_BLOCKER = {
  id: '39c7994e-3d3d-4e08-b406-be7f6af7a6ec', requestMethod: 'GET',
  requestUrl: 'https://www.finishline.com/plp/top-trending-products', responseStatus: 403,
  contentType: 'text/html', bytes: 0, responseSha256: null, observedAt: '2026-09-27T09:30:19.249Z',
  browserUsed: false, cookiesSent: false, authorizationSent: false, secureTransport: true, blocked: true, retry: false,
};

async function readHttpsPage(merchant, url, report) {
  const startedAt = new Date().toISOString();
  const page = await readPublicPage(url, {
    allowedHosts: allowedHostsFor(merchant), maxRedirects: 3, maxBytes: MAX_PAGE_BYTES, timeoutMs: 20_000,
  });
  makeReceiptPage(page, merchant.merchantId, report);
  const providerChallenge = merchant.merchantId === 'aliexpress' && typeof page.html === 'string'
    && /(?:\/_____tmd_____\/punish\b|\bx5secdata\s*=|_config_\s*=\s*\{[^}]{0,500}"action"\s*:\s*"captcha"|rgv587_flag\s*:)/i.test(page.html);
  if (providerChallenge) {
    page.ok = false;
    page.blocked = true;
    page.stopReason = 'VISIBLE_CHALLENGE';
  }
  const extraction = page.ok ? extractPublicPage(page, { merchantId: merchant.merchantId, typeHint: merchant.verticalHint })
    : { title: null, description: null, links: [], forms: [], jsonLd: [], embeddedJson: [], records: [] };
  const contract = {
    operation: 'anonymous_public_page_GET', requestUrl: safeUrl(url),
    finalUrl: page.url ?? null, status: page.status ?? null, contentType: page.contentType ?? null,
    observedAt: page.receipt?.observedAt ?? startedAt, browserUsed: false, cookiesSent: false, authorizationSent: false,
    secureTransport: true, stopReason: page.stopReason ?? null,
    ...(providerChallenge ? { challengeSignal: 'first_party_captcha_redirect_script' } : {}),
    title: extraction.title, description: extraction.description,
    jsonLdBlocks: extraction.jsonLd.length, embeddedJsonBlocks: extraction.embeddedJson.length,
    forms: extraction.forms, linkCount: extraction.links.length,
    evidenceReceiptId: page.receipt?.id ?? null,
  };
  report.contracts.push(contract);
  return { page, extraction, contract };
}

function observedVisibleHeadings(html) {
  const root = parseFragment(html);
  const output = [];
  const visit = node => {
    if (['h1', 'h2'].includes(node?.tagName)) {
      const value = textContent(node, 500);
      if (value) output.push({ tag: node.tagName, text: value });
    }
    for (const child of node?.childNodes ?? []) visit(child);
  };
  visit(root);
  return output;
}

function observedRailPassRecord(read) {
  const heading = observedVisibleHeadings(read.page.html).find(row => /^(?:유레일 패스|스위스 트래블 패스)$/i.test(row.text));
  const title = heading?.text ?? null;
  const description = read.extraction.description;
  if (!title || !description) return null;
  return {
    type: 'TravelOffering', sourceLocalId: null, title, url: safeUrl(read.page.url), description, brand: null,
    price: { amount: null, currency: null, priceText: null },
    rating: { value: null, best: null, worst: null, reviewCount: null, ratingCount: null },
    variants: [], reviewSamples: [],
    evidence: [{ receiptId: read.page.receipt.id, locator: `HTML <${heading.tag}> + <meta name="description">`, fields: ['type', 'title', 'url', 'description'] }],
  };
}

function addPageRecords(report, merchant, read, kind) {
  if (!read?.page?.ok) return;
  let records = normalizeExtractedRecords(read.extraction, read.page, merchant, kind);
  if (merchant.merchantId === 'eyoumall' && kind === 'homepage') {
    for (const card of observedEyoumallListingPrices(read.page)) {
      report.frontier.push({ operation: 'observed_product_listing_card', sourceLocalId: card.sourceLocalId,
        url: card.url, amount: card.amount, currency: card.currency, priceText: card.priceText,
        condition: card.condition, locator: card.locator, retry: false, evidenceReceiptId: read.page.receipt.id });
    }
  }
  if (merchant.merchantId === 'eyoumall' && /\/shop\/goods\/item_view\.php/i.test(new URL(read.page.url).pathname)) {
    const itemId = new URL(read.page.url).searchParams.get('no');
    const product = records.find(record => String(record.sourceLocalId ?? '') === String(itemId ?? '')) ?? records[0];
    for (const record of records) {
      const measures = productMeasuresFromTitle(record.title);
      if (measures.length) {
        record.productMeasures = measures;
        for (const item of record.evidence ?? []) {
          if (!(item.fields ?? []).includes('productMeasures')) item.fields = [...(item.fields ?? []), 'productMeasures'];
        }
      }
    }
    const observedPrice = observedEyoumallPrice(read.page);
    const listingPrice = report.frontier.findLast(item => item.operation === 'observed_product_listing_card' && item.sourceLocalId === itemId);
    const selectedPrice = observedPrice ?? (listingPrice ? { ...listingPrice, locator: listingPrice.locator,
      receiptId: listingPrice.evidenceReceiptId, source: 'observed linked homepage card' } : null);
    if (product && selectedPrice) {
      product.price = { amount: selectedPrice.amount, currency: selectedPrice.currency, priceText: selectedPrice.priceText };
      product.offers = [{ type: 'Offer', amount: selectedPrice.amount, currency: selectedPrice.currency,
        priceText: selectedPrice.priceText, availability: 'unknown', condition: selectedPrice.condition, url: safeUrl(read.page.url) }];
      if (selectedPrice.condition) product.condition = selectedPrice.condition;
      const evidenceReceiptId = selectedPrice.receiptId ?? read.page.receipt.id;
      const conditionLocator = selectedPrice.conditionLocator ? ` + ${selectedPrice.conditionLocator}` : '';
      product.evidence.push({ receiptId: evidenceReceiptId,
        locator: `${selectedPrice.locator}${conditionLocator}`,
        fields: ['price', 'offers', ...(selectedPrice.condition ? ['condition'] : [])] });
      report.frontier.push({ operation: 'visible_html_product_price', url: safeUrl(read.page.url),
        state: observedPrice ? 'observed_on_product_detail' : 'observed_on_linked_homepage_card',
        amount: selectedPrice.amount, currency: selectedPrice.currency, condition: selectedPrice.condition,
        retry: false, evidenceReceiptId, detailReceiptId: read.page.receipt.id });
    } else {
      const absence = eyoumallPriceAbsence(read.page);
      report.frontier.push({ operation: 'visible_html_product_price', url: safeUrl(read.page.url),
        state: absence.masked ? 'unit_price_masked' : 'unit_price_not_observed',
        note: absence.masked ? 'The primary price node masks the amount; no amount inferred.'
          : absence.zeroCartTotalObserved ? 'The page shows a zero cart total before selection; it is not treated as the unit price.'
            : 'No exact primary unit-price amount was visible; no amount inferred.',
        cartTotalZeroObserved: absence.zeroCartTotalObserved,
        retry: false, evidenceReceiptId: read.page.receipt.id });
    }
    const reviewReadLinks = (read.extraction.links ?? []).filter(link =>
      /(?:review|comment|후기|리뷰)/i.test(`${link.text ?? ''} ${link.url ?? ''}`)
      && !/[#](?:review|comment|후기|리뷰)/i.test(link.url ?? '')
      && safeUrl(link.url, read.page.url) !== safeUrl(read.page.url));
    const reviewWriteForms = (read.extraction.forms ?? []).filter(form =>
      String(form.method ?? '').toUpperCase() === 'POST'
      && /(?:review|comment|후기|리뷰)/i.test(`${form.id ?? ''} ${form.action ?? ''}`));
    report.frontier.push({ operation: 'review_read_route_probe', url: safeUrl(read.page.url),
      state: reviewReadLinks.length ? 'observed_linked_GET_candidates' : 'no_linked_public_review_GET_observed',
      linkedGetCandidateCount: reviewReadLinks.length, reviewWriteFormsObserved: reviewWriteForms.length,
      reviewWriteFormsSubmitted: 0, retry: false, evidenceReceiptId: read.page.receipt.id });
  }
  if (merchant.merchantId === 're4akor') {
    const passRecord = observedRailPassRecord(read);
    if (passRecord) records.push(passRecord);
    if (read.extraction.title === '철도패스 예매하기') {
      report.frontier.push({ operation: 'observed_pass_booking_route', url: safeUrl(read.page.url),
        state: 'contact_instructions_only', note: 'The visible page directs travelers to contact a distributor; no fare, booking-date control, or form observed.',
        retry: false, evidenceReceiptId: read.page.receipt.id });
    }
  }
  report.records.push(...records);
}

function chooseNextLinks(extraction, merchant, visited) {
  const candidates = (extraction.links ?? []).map(link => classifyLink(link, merchant)).filter(Boolean)
    .filter(item => item.url && !visited.has(item.url));
  return [...new Map(candidates.map(row => [row.url, row])).values()].sort((a, b) => rankCandidate(b, merchant) - rankCandidate(a, merchant));
}

function priorObservedDetail(prior, merchant) {
  const fromPages = (prior?.pages ?? []).map(page => page.url);
  const fromContracts = (prior?.contracts ?? []).flatMap(contract => (contract.discoveredCandidates ?? []).map(item => item.url));
  const candidates = [...fromPages, ...fromContracts].map(raw => safeUrl(raw)).filter(Boolean).filter(raw => {
    try {
      const url = new URL(raw);
      const root = providerRoot(new URL(merchant.siteUrl).hostname);
      const same = url.hostname === root || url.hostname.endsWith(`.${root}`);
      return same && (/(?:item_view|goods_view|\/product\/|\/p\/|\/dp\/|goods_no=|product_id=)/i.test(`${url.pathname}${url.search}`)) && !/(?:sitemap|deliverycommitment|promotion|about)/i.test(url.pathname);
    } catch { return false; }
  });
  return [...new Set(candidates)].map(url => ({ url, kind: 'observed_product_detail', label: 'prior_observed_product_detail', discoveredFromReceiptId: null }));
}

function deriveOperations(report) {
  const evidenceIds = new Set(report.receipts.map(receipt => receipt.id));
  const observedRecords = report.records.filter(record => record && record.title);
  const prices = observedRecords.filter(record => record.price && (record.price.amount != null || record.price.priceText != null));
  const ratings = observedRecords.filter(record => record.rating && (record.rating.value != null || record.rating.reviewCount != null || record.rating.ratingCount != null));
  const reviews = observedRecords.flatMap(record => record.reviewSamples ?? []);
  const variants = observedRecords.flatMap(record => record.variants ?? []);
  const detailReceipts = report.contracts.filter(contract => contract.operation === 'anonymous_public_page_GET' && contract.status === 200).map(contract => contract.evidenceReceiptId).filter(Boolean);
  const forms = report.contracts.flatMap(contract => contract.forms ?? []);
  recordOperation(report, 'productSearch', forms.length ? 'observed_form_not_submitted' : 'not_captured', { formsObserved: forms.length, evidenceReceiptIds: detailReceipts });
  recordOperation(report, 'productDetail', observedRecords.length ? 'verified_public_page' : 'reachable_without_offering_record', { recordCount: observedRecords.length, evidenceReceiptIds: observedRecords.flatMap(record => record.evidence.map(item => item.receiptId)).filter(Boolean) });
  recordOperation(report, 'price', prices.length ? 'verified_public_page' : 'not_captured', { recordCount: prices.length, evidenceReceiptIds: prices.flatMap(record => record.evidence.map(item => item.receiptId)) });
  recordOperation(report, 'ratingSummary', ratings.length ? 'verified_aggregate_only' : 'not_captured', { recordCount: ratings.length, evidenceReceiptIds: ratings.flatMap(record => record.evidence.map(item => item.receiptId)) });
  recordOperation(report, 'reviewsList', reviews.length ? 'partial_schema_samples' : 'not_captured', { sampleCount: reviews.length, complete: false, evidenceReceiptIds: observedRecords.filter(record => (record.reviewSamples ?? []).length).flatMap(record => record.evidence.map(item => item.receiptId)) });
  recordOperation(report, 'productOptions', variants.length ? 'variant_schema_observed' : 'not_captured', { variantCount: variants.length, evidenceReceiptIds: observedRecords.filter(record => (record.variants ?? []).length).flatMap(record => record.evidence.map(item => item.receiptId)) });
  if (!evidenceIds.size && report.receipts.length) recordOperation(report, 'publicPageRead', 'blocked_or_incomplete', { evidenceReceiptIds: report.receipts.map(receipt => receipt.id) });
  const mytheresaStatic = report.merchantId === 'mytheresa'
    ? report.contracts.find(contract => contract.operation === 'observed_public_resource_GET' && contract.staticInspection)?.staticInspection
    : null;
  if (mytheresaStatic) recordOperation(report, 'productSearch', 'catalog_contract_not_observed_in_public_bootstrap', {
    formsObserved: forms.length,
    firstPartyXhrCallsiteCount: mytheresaStatic.firstPartyXhrCallsiteCount,
    crossOriginXhrCallsiteCount: mytheresaStatic.crossOriginXhrCallsiteCount,
    observedStaticPathMention: mytheresaStatic.observedStaticPathMention,
    evidenceReceiptIds: report.contracts.filter(contract => ['anonymous_public_page_GET', 'observed_public_resource_GET'].includes(contract.operation)).map(contract => contract.evidenceReceiptId).filter(Boolean),
  });
  if (report.merchantId === 'eyoumall') {
    const reviewProbes = report.frontier.filter(item => item.operation === 'review_read_route_probe');
    const linkedGetCandidateCount = reviewProbes.reduce((sum, item) => sum + (item.linkedGetCandidateCount ?? 0), 0);
    const writeForms = reviewProbes.reduce((sum, item) => sum + (item.reviewWriteFormsObserved ?? 0), 0);
    report.operations.reviewsList = {
      state: linkedGetCandidateCount ? 'linked_public_GET_candidate_observed_not_replayed' : 'aggregate_only_no_linked_public_review_GET_observed',
      sampleCount: reviews.length, complete: false, linkedGetCandidateCount,
      reviewWriteFormsObserved: writeForms, reviewWriteFormsSubmitted: 0,
      evidenceReceiptIds: reviewProbes.map(item => item.evidenceReceiptId).filter(Boolean),
    };
  }
  if (report.merchantId === 're4akor') {
    const passReceipts = observedRecords.filter(record => record.type === 'TravelOffering')
      .flatMap(record => record.evidence.map(item => item.receiptId)).filter(Boolean);
    const bookingProbe = report.frontier.find(item => item.operation === 'observed_pass_booking_route');
    report.operations.price = { state: 'no_public_fare_observed_on_pass_pages', recordCount: 0,
      evidenceReceiptIds: [...new Set([...passReceipts, ...(bookingProbe?.evidenceReceiptId ? [bookingProbe.evidenceReceiptId] : [])])] };
    report.operations.bookingAvailability = { state: bookingProbe?.state ?? 'not_observed',
      fareOrDateControlsObserved: false, formsObserved: 0,
      evidenceReceiptIds: bookingProbe?.evidenceReceiptId ? [bookingProbe.evidenceReceiptId] : [] };
  }
}

export async function collectMerchant(merchantId, options = {}) {
  const merchant = merchantById.get(merchantId);
  if (!merchant) throw new Error(`MERCHANT_NOT_IN_BATCH_07:${merchantId}`);
  const previous = priorMerchant(merchantId, options.previousEvidence);
  const previousAccessRejected = [...(previous?.receipts ?? []), ...(previous?.contracts ?? [])].some(row => [401, 403, 418, 429].includes(Number(row.responseStatus ?? row.status ?? row.httpStatus)) || /challenge/i.test(String(row.stopReason ?? '')));
  if (merchantId === 'mycredit1' && !previousAccessRejected) return collectFailurePathMerchant(merchantId);
  const previousHardStop = (previous?.contracts ?? []).some(row => [401, 403, 418, 429].includes(Number(row.status))
    || Number(row.status) >= 500 || ['HTTP_ACCESS_BLOCKED', 'VISIBLE_CHALLENGE', 'HEADER_CHALLENGE'].includes(row.stopReason));
  if (!options.recheckBlocked && previous && (['blocked', 'challenge', 'blocked_stopped', 'challenge_stopped', 'server_error_stopped'].includes(previous.state ?? previous.status) || previousHardStop)) return priorBlockedReport(merchant, previous);
  const priorReceipts = (previous?.receipts ?? []).map(normalizeOldReceipt).filter(Boolean);
  const report = {
    merchantId,
    siteUrl: safeUrl(merchant.siteUrl),
    receipts: [], records: [], contracts: [], operations: {}, frontier: [],
    status: 'pending', transport: { browserUsed: false, cookiesSent: false, authorizationSent: false, secureTransport: true, helper: 'lib/cps-public-reader.mjs' },
  };

  if (merchantId === 'mytheresa') {
    const storedSupplement = readJsonIfPresent(MYTHERESA_SUPPLEMENT_PATH);
    const supplement = options.useStoredMytheresaSupplement === true
      ? storedSupplement : await collectMytheresaPublicNative();
    if (!supplement) return previous ?? report;
    return mergeMytheresaReports(previous, supplement);
  }

  if (merchantId === 'finishline') {
    report.receipts.push(...priorReceipts.filter(row => row.responseStatus === 301 || row.responseStatus === 302), FINISHLINE_BLOCKER);
    report.contracts.push({ operation: 'observed_product_category_GET', requestUrl: FINISHLINE_BLOCKER.requestUrl, status: 403, contentType: FINISHLINE_BLOCKER.contentType, observedAt: FINISHLINE_BLOCKER.observedAt, browserUsed: false, cookiesSent: false, authorizationSent: false, secureTransport: true, evidenceReceiptId: FINISHLINE_BLOCKER.id });
    report.frontier.push({ operation: 'product_category_or_detail', url: FINISHLINE_BLOCKER.requestUrl, state: 'HTTP_403', retry: false, stopHost: true });
    report.status = 'blocked_stopped';
    deriveOperations(report);
    return report;
  }

  const redirectReceipts = priorReceipts.filter(row => row.responseStatus >= 300 && row.responseStatus < 400 && row.redirectTo);
  if (merchantId === 'cappstory') {
    return collectCappstoryHttp(merchant, previous, priorReceipts);
  }

  const startUrl = observedHttpsStart(merchant, previous);

  report.receipts.push(...redirectReceipts);
  if (!startUrl) {
    report.status = 'https_destination_not_observed';
    report.frontier.push({ operation: 'homepage_GET', url: safeUrl(merchant.siteUrl), state: 'no_observed_same_provider_https_redirect' });
    deriveOperations(report);
    return report;
  }

  const visited = new Set();
  const queue = [{ url: startUrl, kind: 'homepage', discoveredFromReceiptId: redirectReceipts.at(-1)?.id ?? null, label: null }];
  let requestCount = report.receipts.length;
  let stopped = false;
  while (queue.length && report.contracts.filter(row => row.operation === 'anonymous_public_page_GET').length < MAX_PAGE_READS && requestCount < MAX_REQUESTS_PER_SOURCE && !stopped) {
    const current = queue.shift();
    if (!current?.url || visited.has(current.url)) continue;
    visited.add(current.url);
    const read = await readHttpsPage(merchant, current.url, report);
    requestCount += (read.page.redirects?.length ?? 0) + (read.page.receipt ? 1 : 0);
    report.frontier.push({ operation: current.kind, url: safeUrl(current.url), label: current.label, discoveredFromReceiptId: current.discoveredFromReceiptId, state: read.page.ok ? 'read' : read.page.stopReason, retry: false });
    if (!read.page.ok) {
      if (read.page.blocked || ['HTTP_ACCESS_BLOCKED', 'VISIBLE_CHALLENGE'].includes(read.page.stopReason)) {
        report.frontier.at(-1).stopHost = true;
        report.status = read.page.stopReason === 'VISIBLE_CHALLENGE' ? 'challenge_stopped' : 'blocked_stopped';
        stopped = true;
      }
      if (merchantId === 'mycredit1' && read.page.stopReason === 'HTTP_STATUS_REJECTED' && !visited.has('https://www.credit.co.kr/ib20/mnu/BZWMAN00001')) {
        queue.unshift({ url: 'https://www.credit.co.kr/ib20/mnu/BZWMAN00001', kind: 'observed_service_detail', label: 'prior observed public NICE service page', discoveredFromReceiptId: read.page.receipt?.id ?? null });
      }
      continue;
    }
    addPageRecords(report, merchant, read, current.kind);
    if (report.records.length && current.kind !== 'homepage') {
      const recordsHere = normalizeExtractedRecords(read.extraction, read.page, merchant, current.kind);
      if (recordsHere.length) continue;
    }
    const candidates = chooseNextLinks(read.extraction, merchant, visited);
    const next = candidates.slice(0, 4).map(candidate => ({
      url: candidate.url, kind: candidate.kind, label: candidate.text,
      discoveredFromReceiptId: read.page.receipt?.id ?? null,
    }));
    if (current.kind === 'homepage' && !next.length && !report.contracts.some(item => item.operation === 'observed_public_resource_GET')) {
      const resourceAttempt = await readObservedPublicResource(merchant, read.page, report);
      if (resourceAttempt.attempted) requestCount += 1;
      if (resourceAttempt.blocked) {
        report.status = 'blocked_stopped';
        stopped = true;
      }
      next.push(...resourceAttempt.candidates.slice(0, 4).map(candidate => ({
        url: candidate.url, kind: candidate.kind, label: candidate.text,
        discoveredFromReceiptId: report.contracts.at(-1)?.evidenceReceiptId ?? read.page.receipt?.id ?? null,
      })));
    }
    if (current.kind === 'homepage') next.push(...priorObservedDetail(previous, merchant).filter(candidate => !visited.has(candidate.url)
      && !next.some(item => item.url === candidate.url)).slice(0, 2).map(candidate => ({ ...candidate, discoveredFromReceiptId: read.page.receipt?.id ?? null })));
    for (const candidate of next) if (!queue.some(item => item.url === candidate.url)) queue.push(candidate);
    report.contracts.at(-1).discoveredCandidates = next.map(item => ({ url: item.url, label: item.label, kind: item.kind, discoveredFromReceiptId: item.discoveredFromReceiptId }));
    if (!next.length && !report.records.length) report.frontier.push({ operation: 'observed_detail_or_service_link', sourcePage: safeUrl(read.page.url), state: 'none_observed' });
  }
  for (const pending of queue) report.frontier.push({ operation: pending.kind, url: safeUrl(pending.url), label: pending.label, discoveredFromReceiptId: pending.discoveredFromReceiptId, state: requestCount >= MAX_REQUESTS_PER_SOURCE ? 'request_budget_pending' : 'page_budget_pending' });
  const deduped = new Map(report.records.map(record => [`${record.type}|${record.sourceLocalId ?? ''}|${record.url}|${record.title}`, record]));
  report.records = [...deduped.values()];
  if (!stopped) report.status = report.records.length ? 'ontology_records_observed' : report.contracts.some(row => row.status === 200) ? 'reachable_without_offering_record' : 'no_public_page_record';
  deriveOperations(report);
  return report;
}

export async function collectBatch(options = {}) {
  const results = [];
  for (const merchantId of merchantIds) {
    const result = await collectMerchant(merchantId, options);
    results.push(result);
    process.stdout.write(`${JSON.stringify({ merchantId, status: result.status, records: result.records.length, pages: result.contracts.length, requests: result.receipts.length })}\n`);
  }
  const output = {
    schemaVersion: 2,
    batchId: '07',
    checkedAt: new Date().toISOString(),
    ontologyId: 'acada:cps-commerce',
    merchantCount: results.length,
    ontologyRecordCount: results.reduce((sum, result) => sum + result.records.length, 0),
    merchants: results,
  };
  mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  const tempPath = `${RESULT_PATH}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  renameSync(tempPath, RESULT_PATH);
  process.stdout.write(`WROTE ${RESULT_PATH}\n`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  collectBatch().catch(error => { process.stderr.write(`${error.code ?? error.message}\n`); process.exitCode = 1; });
}
