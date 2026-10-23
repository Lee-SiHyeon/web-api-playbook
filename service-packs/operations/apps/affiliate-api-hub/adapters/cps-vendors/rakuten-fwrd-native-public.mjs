import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';
import { extractPublicPage, isStrongPublicChallenge, safeUrl, textContent } from '../../lib/cps-public-reader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB_ROOT = path.resolve(HERE, '../..');
const REPORT_FILE = path.join(HUB_ROOT, 'references/cps-reverify/batch-04-rakuten-fwrd-followup.json');
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const LINK_CAP = 2;
const RECORD_CAP = 100;
const PROVIDERS = Object.freeze({
  rakutentr: { siteUrl: 'https://travel.rakuten.com/', providerRoot: 'rakuten.com', label: 'Rakuten Travel' },
  fwrd: { siteUrl: 'https://www.fwrd.com/', providerRoot: 'fwrd.com', label: 'FWRD' },
});

export const merchantIds = Object.freeze(Object.keys(PROVIDERS));

function checkpointDocument(report) {
  let document = null;
  try {
    document = JSON.parse(readFileSync(REPORT_FILE, 'utf8'));
    if (document?.batchId !== '04-rakuten-fwrd-native-followup' || !Array.isArray(document.merchants)) document = null;
  } catch { document = null; }
  if (!document) document = {
    schemaVersion: 1,
    batchId: '04-rakuten-fwrd-native-followup',
    checkedAt: new Date().toISOString(),
    method: 'bounded_anonymous_native_node_fetch_and_observed_html_extraction',
    browserUsed: false,
    credentialsUsed: false,
    limits: { maxRedirects: MAX_REDIRECTS, maxBytesPerPage: MAX_BYTES, observedLinksPerProvider: LINK_CAP, maxRecordsPerPage: RECORD_CAP },
    merchants: [],
    notes: [
      'Only exact first-party root URLs and up to two same-provider links observed in fetched markup were read per merchant.',
      'Full HTML/embedded state was not persisted; receipts retain response byte count and SHA-256 only.',
      'No guessed API routes, browser cookies, authorization, or user-agent override were used.',
    ],
  };
  document.checkedAt = new Date().toISOString();
  const previous = document.merchants.find(row => row.merchantId === report.merchantId);
  if (previous && previous.runId !== report.runId) {
    const historical = {
      runId: previous.runId ?? null,
      checkedAt: previous.checkedAt ?? null,
      status: previous.status ?? null,
      receipts: previous.receipts ?? [],
      pages: previous.pages ?? [],
      records: previous.records ?? [],
      operations: previous.operations ?? {},
      frontier: previous.frontier ?? [],
    };
    report.history = [...(previous.history ?? []), historical];
    report.frontierHistory = [...(previous.frontierHistory ?? []), ...(previous.frontier ?? [])];
    report.receipts = uniqueRows([...(previous.receipts ?? []), ...(report.receipts ?? [])], row => row.id);
    report.contracts = uniqueRows([...(previous.contracts ?? []), ...(report.contracts ?? [])], row => `${row.operation ?? ''}\0${row.receiptId ?? ''}`);
  }
  report.updatedAt = new Date().toISOString();
  document.merchants = document.merchants.filter(row => row.merchantId !== report.merchantId);
  document.merchants.push(report);
  const temporaryFile = `${REPORT_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryFile, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporaryFile, REPORT_FILE);
  } catch (error) {
    try { unlinkSync(temporaryFile); } catch { /* Cleanup best effort. */ }
    throw error;
  }
}

function uniqueRows(rows, keyOf) {
  const seen = new Set();
  return rows.filter(row => {
    const key = keyOf(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addReceiptCheckpoint(report, receiptRow) {
  if (receiptRow) report.receipts.push(receiptRow);
  report.status = 'receipt_checkpointed';
  checkpointDocument(report);
}

function normalizeProviderUrl(value, providerRoot) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host !== providerRoot && !host.endsWith(`.${providerRoot}`)) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}

function receipt(url, status, contentType, bytes, responseSha256, observedAt) {
  return {
    id: randomUUID(),
    method: 'GET',
    requestUrl: safeUrl(url),
    responseStatus: Number.isInteger(status) ? status : null,
    contentType: contentType ?? null,
    bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0,
    responseSha256: responseSha256 ?? null,
    observedAt,
    browserUsed: false,
    explicitHeaders: false,
    cookiesSent: false,
    authorizationSent: false,
  };
}

async function readBodyBounded(response, maxBytes) {
  if (!response.body) return { bytes: new Uint8Array(), error: null };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { bytes: null, error: 'RESPONSE_TOO_LARGE' };
      }
      chunks.push(value);
    }
  } catch {
    return { bytes: null, error: 'RESPONSE_BODY_FAILED' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, error: null };
}

async function readNativePage(value, providerRoot, options = {}, onReceipt = null) {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const redirects = [];
  const receipts = [];
  const capture = receiptRow => {
    if (!receiptRow) return;
    receipts.push(receiptRow);
    if (typeof onReceipt === 'function') onReceipt(receiptRow);
  };
  let current = value;

  for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
    const url = normalizeProviderUrl(current, providerRoot);
    if (!url) return { ok: false, blocked: true, stopReason: 'PROVIDER_HOST_OR_HTTPS_BOUNDARY', url: safeUrl(current), redirects };
    const observedAt = new Date().toISOString();
    let response;
    try {
      // Intentionally rely on Node's native defaults: no custom headers,
      // cookies, authorization, browser context, proxy, or fingerprint.
      response = await fetch(url.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const receiptRow = receipt(url.href, null, null, 0, null, observedAt);
      capture(receiptRow);
      return { ok: false, blocked: false, stopReason: error?.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'NATIVE_FETCH_TRANSPORT_FAILED', url: url.href, redirects, receipts, receipt: receiptRow };
    }

    const status = response.status;
    const contentType = response.headers.get('content-type');
    const observedReceipt = receipt(url.href, status, contentType, 0, null, observedAt);
    if ([401, 403, 418, 429].includes(status)) {
      try { await response.body?.cancel(); } catch { /* No further access attempt. */ }
      capture(observedReceipt);
      return {
        ok: false,
        blocked: true,
        stopReason: 'HTTP_ACCESS_BLOCKED',
        url: url.href,
        status,
        redirects,
        receipts,
        receipt: observedReceipt,
      };
    }

    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch { /* Redirect response body is not needed. */ }
      capture(observedReceipt);
      if (!location) return { ok: false, blocked: false, stopReason: 'REDIRECT_LOCATION_MISSING', url: url.href, status, redirects, receipts, receipt: observedReceipt };
      let target;
      try { target = new URL(location, url); } catch { return { ok: false, blocked: true, stopReason: 'REDIRECT_URL_INVALID', url: url.href, status, redirects, receipts, receipt: observedReceipt }; }
      if (target.protocol !== 'https:') return { ok: false, blocked: true, stopReason: 'REDIRECT_HTTPS_REQUIRED', url: url.href, status, redirects, receipts, receipt: observedReceipt };
      const safeTarget = normalizeProviderUrl(target.href, providerRoot);
      if (!safeTarget) return { ok: false, blocked: true, stopReason: 'REDIRECT_OUTSIDE_PROVIDER', url: url.href, status, redirects, receipts, receipt: observedReceipt };
      if (attempt >= maxRedirects) return { ok: false, blocked: false, stopReason: 'REDIRECT_LIMIT_REACHED', url: url.href, status, redirects, receipts, receipt: observedReceipt };
      redirects.push({ status, from: safeUrl(url.href), to: safeUrl(safeTarget.href) });
      current = safeTarget.href;
      continue;
    }

    if (status !== 200) {
      try { await response.body?.cancel(); } catch { /* Status receipt only. */ }
      capture(observedReceipt);
      return { ok: false, blocked: false, stopReason: `HTTP_STATUS_${status}`, url: url.href, status, redirects, receipts, receipt: observedReceipt };
    }
    const mime = (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
    if (!['text/html', 'application/xhtml+xml'].includes(mime)) {
      try { await response.body?.cancel(); } catch { /* MIME receipt only. */ }
      capture(observedReceipt);
      return { ok: false, blocked: false, stopReason: 'HTML_CONTENT_TYPE_REQUIRED', url: url.href, status, contentType, redirects, receipts, receipt: observedReceipt };
    }
    const body = await readBodyBounded(response, maxBytes);
    if (body.error) {
      capture(observedReceipt);
      return { ok: false, blocked: false, stopReason: body.error, url: url.href, status, redirects, receipts, receipt: observedReceipt };
    }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(body.bytes);
    const digest = createHash('sha256').update(body.bytes).digest('hex');
    const receiptRow = receipt(url.href, status, contentType, body.bytes.length, digest, observedAt);
    capture(receiptRow);
    if (isStrongPublicChallenge(response.headers, html)) {
      return { ok: false, blocked: true, stopReason: 'VISIBLE_CHALLENGE', url: url.href, status, redirects, receipts, receipt: receiptRow };
    }
    return { ok: true, blocked: false, stopReason: null, url: url.href, status, contentType, html, redirects, receipts, receipt: receiptRow };
  }
  return { ok: false, blocked: false, stopReason: 'REDIRECT_LIMIT_REACHED', url: safeUrl(current), redirects, receipts };
}

function walkNodes(root, predicate, results = [], cap = 10000) {
  if (!root || results.length >= cap) return results;
  if (predicate(root)) results.push(root);
  for (const child of root.childNodes ?? []) walkNodes(child, predicate, results, cap);
  return results;
}

function safeString(value, cap = 1000) {
  if (typeof value !== 'string') return null;
  const decoded = textContent(value, cap) ?? value;
  const cleaned = decoded.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일]')
    .replace(/(?:\+?82[\s-]?)?0\d{1,2}[\s-]?\d{3,4}[\s-]?\d{4}/g, '[전화번호]');
  return cleaned || null;
}

function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  const amount = Number(text.replaceAll(',', ''));
  return Number.isFinite(amount) ? amount : null;
}

function objectValue(value, keys) {
  for (const key of keys) {
    const child = value?.[key];
    if (child !== undefined && child !== null && child !== '') return child;
  }
  return null;
}

function objectNumeric(value, keys) {
  for (const key of keys) {
    const child = value?.[key];
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const nested = numeric(objectValue(child, ['amount', 'value', 'price', 'currentPrice', 'salePrice']));
      if (nested != null) return nested;
    }
    const amount = numeric(child);
    if (amount != null) return amount;
  }
  return null;
}

function recordUrlFor(value, pageUrl, providerRoot, links, sourceLocalId, title) {
  const raw = objectValue(value, ['url', 'href', 'link', 'detailUrl', 'productUrl', 'hotelUrl', 'landingUrl', 'canonicalUrl']);
  const embedded = typeof raw === 'string' ? safeUrl(raw, pageUrl) : null;
  if (embedded && normalizeProviderUrl(embedded, providerRoot)) return embedded;
  const id = String(sourceLocalId ?? '');
  const matching = links.find(link => {
    if (id && (() => {
      try {
        const observed = new URL(link.url);
        return [...observed.searchParams.values()].includes(id) || observed.pathname.split('/').includes(id);
      } catch { return false; }
    })()) return true;
    return Boolean(title && link.text?.trim() === title);
  });
  return matching?.url ?? null;
}

function makeEmbeddedRecord(value, locator, merchantId, pageUrl, providerRoot, links, receiptId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const typeText = String(value['@type'] ?? value.__typename ?? value.entityType ?? value.itemType ?? value.type ?? '').toLowerCase();
  const identityContext = /product|hotel|lodging|room|property|stay|accommodation|offer|item|sku/i.test(`${typeText} ${locator}`);
  const localId = objectValue(value, ['productId', 'productID', 'sku', 'skuId', 'goodsId', 'goodsNo', 'itemId', 'itemID', 'hotelId', 'hotelID', 'propertyId', 'lodgingId', 'roomId', 'roomPlanId', 'offerId'])
    ?? (identityContext ? objectValue(value, ['id']) : null);
  const title = safeString(objectValue(value, ['name', 'productName', 'title', 'displayName', 'hotelName', 'propertyName', 'roomName']), 1000);
  if (localId == null || !title || title === '[TRUNCATED]') return null;
  const context = locator.toLowerCase();
  const travelShape = merchantId === 'rakutentr' && /hotel|lodging|room|property|stay|accommodation/.test(`${typeText} ${context}`);
  const retailShape = merchantId === 'fwrd' && /product|catalog|item|sku|offer/.test(`${typeText} ${context}`);
  const explicitOffering = /product|hotel|lodgingbusiness|room|stay|accommodation|offer/.test(typeText);
  if (!explicitOffering && !travelShape && !retailShape) return null;

  const offerRows = Array.isArray(value.offers) ? value.offers : value.offers ? [value.offers] : [];
  const firstOffer = offerRows.find(row => row && typeof row === 'object') ?? {};
  const priceRaw = objectValue(value, ['dispDiscountedPrice', 'discountedPrice', 'salePrice', 'finalPrice', 'currentPrice', 'displayPrice', 'price', 'nightlyPrice', 'lowestPrice', 'amount'])
    ?? objectValue(firstOffer, ['price', 'lowPrice', 'highPrice']);
  const amount = numeric(priceRaw) ?? objectNumeric(priceRaw, ['amount', 'value', 'price', 'currentPrice', 'salePrice']);
  const priceObject = priceRaw && typeof priceRaw === 'object' ? priceRaw : firstOffer;
  const currencyRaw = objectValue(value, ['currency', 'currencyCode', 'priceCurrency'])
    ?? objectValue(priceObject, ['currency', 'currencyCode', 'priceCurrency'])
    ?? objectValue(firstOffer, ['priceCurrency', 'currencyCode', 'currency']);
  const currency = typeof currencyRaw === 'string' && /^[A-Za-z]{3}$/.test(currencyRaw) ? currencyRaw.toUpperCase() : null;
  const priceText = typeof priceRaw === 'string' ? safeString(priceRaw, 200) : null;
  const ratingRaw = objectValue(value, ['aggregateRating', 'rating', 'ratingSummary', 'reviewSummary']);
  const ratingObject = ratingRaw && typeof ratingRaw === 'object' ? ratingRaw : value;
  const ratingValue = numeric(objectValue(ratingObject, ['ratingValue', 'averageRating', 'average', 'value', 'score']));
  const reviewCount = numeric(objectValue(ratingObject, ['reviewCount', 'reviewsCount', 'totalReviewCount', 'numberOfReviews']));
  const ratingCount = numeric(objectValue(ratingObject, ['ratingCount', 'ratingsCount', 'totalRatingCount']));
  const url = recordUrlFor(value, pageUrl, providerRoot, links, localId, title);
  const fields = ['sourceLocalId', 'title'];
  if (url) fields.push('url');
  if (amount != null || priceText) fields.push('price.amount');
  if (currency) fields.push('price.currency');
  if (ratingValue != null) fields.push('rating.value');
  if (reviewCount != null) fields.push('rating.reviewCount');
  if (ratingCount != null) fields.push('rating.ratingCount');
  const description = safeString(objectValue(value, ['description', 'shortDescription', 'summary']), 4000);
  if (description) fields.push('description');
  const brand = safeString(typeof value.brand === 'object' ? value.brand.name : value.brand, 300);
  if (brand) fields.push('brand');
  return {
    type: travelShape ? 'TravelOffering' : 'RetailProduct',
    sourceLocalId: String(localId).slice(0, 200),
    title,
    url,
    description,
    brand,
    price: { amount, currency, priceText },
    rating: { value: ratingValue, best: numeric(objectValue(ratingObject, ['bestRating', 'maxRating'])), worst: numeric(objectValue(ratingObject, ['worstRating', 'minRating'])), reviewCount, ratingCount },
    variants: [],
    reviewSamples: [],
    evidence: [{ receiptId, locator, fields }],
  };
}

function scriptStateSummary(html, { merchantId, pageUrl, providerRoot, links, receiptId }) {
  const root = parseFragment(html);
  const scripts = walkNodes(root, node => node.tagName === 'script', [], 5000);
  const summary = { scriptCount: scripts.length, nextDataCount: 0, jsonLdCount: 0, embeddedJsonCount: 0, oversizeEmbeddedScripts: 0, embeddedNodeCount: 0, productLikeObjects: 0, scanTruncated: false };
  let nodes = 0;
  const records = [];
  const seenRecords = new Set();
  for (const [index, script] of scripts.entries()) {
    const id = script.attrs?.find(row => row.name === 'id')?.value ?? '';
    const type = (script.attrs?.find(row => row.name === 'type')?.value ?? '').toLowerCase().split(';')[0].trim();
    const raw = (script.childNodes ?? []).map(child => child.value ?? '').join('');
    if (id === '__NEXT_DATA__') summary.nextDataCount += 1;
    if (type === 'application/ld+json') summary.jsonLdCount += 1;
    const isJson = type === 'application/json' || id === '__NEXT_DATA__' || /(?:state|bootstrap|initial)[_-]?data/i.test(id);
    if (!isJson || !raw) continue;
    if (raw.length > 4 * 1024 * 1024) { summary.oversizeEmbeddedScripts += 1; continue; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    summary.embeddedJsonCount += 1;
    const scan = (value, depth = 0, locator = '$') => {
        nodes += 1;
        if (nodes > 80000) { summary.scanTruncated = true; return; }
        if (depth > 18) { summary.scanTruncated = true; return; }
        if (value == null || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          for (const [arrayIndex, item] of value.slice(0, 1000).entries()) scan(item, depth + 1, `${locator}[${arrayIndex}]`);
          return;
        }
        const keys = Object.keys(value);
        if (/product|hotel|lodging|room|offer|property|item/i.test(`${id} ${keys.join(' ')}`)) summary.productLikeObjects += 1;
        const candidate = makeEmbeddedRecord(value, `script[${index + 1}]#${id || 'json'}${locator}`, merchantId, pageUrl, providerRoot, links, receiptId);
      if (candidate && records.length < RECORD_CAP) {
        const key = `${candidate.type}\0${candidate.sourceLocalId}\0${candidate.title}`;
        if (!seenRecords.has(key)) {
          seenRecords.add(key);
          records.push(candidate);
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (/token|auth|cookie|session|password|email|phone|account|credential|reviewer|author/i.test(key)) continue;
        const childPath = `${locator}${/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`}`;
        scan(child, depth + 1, childPath);
      }
    };
    scan(parsed, 0, '$');
    if (nodes >= 80000) break;
    summary.embeddedNodeCount = nodes;
    // Keep this loop bounded even if a site includes many state scripts.
    if (index >= 200) break;
  }
  summary.embeddedNodeCount = nodes;
  return { summary, records };
}

function nodeAttr(node, name) {
  return node?.attrs?.find(row => row.name === name)?.value ?? null;
}

function hotelRecordFromSample(sample, receiptId) {
  const providerUrl = normalizeProviderUrl(safeUrl(sample?.url), 'rakuten.com');
  if (!providerUrl) return null;
  const path = providerUrl.pathname.toLowerCase();
  const params = providerUrl.searchParams;
  const detailPath = /hotel_(?:info|detail)_item|hotel_detail|hotel[-/]detail|property_detail|stay_detail/.test(path)
    || (/\/hotel(?:\/|$)/.test(path) && !/hotel_list|hotel-search|hotel_search/.test(path))
    || [...params.keys()].some(key => /^(?:hotel_?id|hotel_?no|property_?id|lodging_?id)$/i.test(key));
  if (!detailPath) return null;
  const idEntry = [...params.entries()].find(([key, value]) => /^(?:hotel_?id|hotel_?no|property_?id|lodging_?id)$/i.test(key) && value.trim());
  const pathSegments = providerUrl.pathname.split('/').filter(Boolean);
  const pathId = pathSegments.find(segment => /^\d{6,}$/.test(segment));
  const sourceLocalId = idEntry?.[1] ?? pathId ?? null;
  const visibleText = safeString(sample.text, 1800) ?? '';
  const titleBoundary = /\s+(?:예약(?=\s|$)|무료\s*취소(?=\s|$)|SUPER\s*SALE(?=\s|$)|조식(?=\s|\()|룸\s*온리(?=\s|\()|객실\s*&\s*숙박\s*상품\s*보기(?=\s|$))/i.exec(visibleText);
  const title = safeString(titleBoundary ? visibleText.slice(0, titleBoundary.index) : visibleText, 500);
  if (!title || title.length < 3 || /^(?:details?|book now|view hotel|more)$/i.test(title)) return null;

  const money = String.raw`(?:KRW|JPY|USD|EUR|GBP|AUD|CAD|₩|¥|￥|\$|€|£)\s*[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?\s*(?:JPY|USD|EUR|GBP|KRW|AUD|CAD|円|원)`;
  const priceMatch = new RegExp(`(${money})(?:\\s*(~|–|-|to)\\s*(${money})?)?`, 'i').exec(visibleText);
  const priceText = priceMatch ? safeString(priceMatch[0], 200) : null;
  const numericTokens = priceText ? [...priceText.matchAll(/[\d,]+(?:\.\d+)?/g)].map(match => numeric(match[0])).filter(value => value != null) : [];
  const lowAmount = numericTokens[0] ?? null;
  const highAmount = numericTokens[1] ?? null;
  const rangeOperator = priceMatch?.[2] ?? null;
  // A displayed range is not a single observed price. Preserve both bounds
  // and leave amount null so downstream consumers cannot mistake the low end
  // for an exact price.
  const amount = rangeOperator && lowAmount != null ? null : lowAmount;
  const explicitCode = [...(priceText ?? '').matchAll(/\b(KRW|JPY|USD|EUR|GBP|AUD|CAD)\b/gi)].map(match => match[1].toUpperCase());
  const currencyMarks = [
    ...(priceText?.includes('₩') || /원/.test(priceText ?? '') ? ['KRW'] : []),
    ...(priceText?.includes('¥') || priceText?.includes('￥') || /円/.test(priceText ?? '') ? ['JPY'] : []),
    ...(priceText?.includes('€') ? ['EUR'] : []),
    ...(priceText?.includes('£') ? ['GBP'] : []),
    ...explicitCode,
  ];
  const distinctCurrencies = [...new Set(currencyMarks)];
  const currency = distinctCurrencies.length === 1 ? distinctCurrencies[0] : null;
  const dateValue = value => /^\d{8}$/.test(value ?? '') ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : null;
  const conditions = {};
  const startDate = dateValue(params.get('startServiceDate'));
  const endDate = dateValue(params.get('endServiceDate'));
  const units = numeric(params.get('numberOfUnits'));
  const adultsByUnit = [...params.entries()]
    .filter(([key, value]) => /^numberOfAdults_\d+$/i.test(key) && /^\d+$/.test(value))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => Number(value));
  const adults = adultsByUnit.reduce((sum, value) => sum + value, 0);
  if (startDate) conditions.stayStartDate = startDate;
  if (endDate) conditions.stayEndDate = endDate;
  if (units != null) conditions.units = units;
  if (adultsByUnit.length) {
    conditions.adultsByUnit = adultsByUnit;
    conditions.adults = adults;
  }
  const dateConditioned = Boolean(startDate || endDate);
  const completeRange = rangeOperator != null && highAmount != null;
  const priceKind = rangeOperator != null
    ? (dateConditioned
      ? (completeRange ? 'date_conditioned_displayed_range' : 'date_conditioned_displayed_range_incomplete')
      : (completeRange ? 'displayed_range' : 'displayed_range_incomplete'))
    : (dateConditioned ? 'date_conditioned_displayed_amount' : 'displayed_amount');
  const ratingMatch = /([0-5](?:\.\d{1,2})?)\s*(?:매우\s*)?(?:훌륭함|좋음|excellent|very\s+good)/i.exec(visibleText);
  const reviewMatch = /이용\s*후기\s*([\d,]+)\s*건|([\d,]+)\s*(?:reviews?|ratings?|口コミ|件のレビュー)/i.exec(visibleText);
  const ratingValue = ratingMatch ? numeric(ratingMatch[1]) : null;
  const reviewCount = reviewMatch ? numeric(reviewMatch[1] ?? reviewMatch[2]) : null;
  const fields = ['type', 'typeEvidence', 'title', 'url'];
  if (sourceLocalId) fields.unshift('sourceLocalId');
  if (amount != null || lowAmount != null || highAmount != null || priceText) {
    fields.push('price');
    if (amount != null) fields.push('price.amount');
    if (lowAmount != null) fields.push('price.lowAmount');
    if (highAmount != null) fields.push('price.highAmount');
    if (priceText) fields.push('price.priceText');
    if (currency) fields.push('price.currency');
    if (priceText) fields.push('price.priceKind', 'price.qualifiers');
    if (Object.keys(conditions).length) fields.push('price.conditions');
  }
  if (ratingValue != null || reviewCount != null) {
    fields.push('rating');
    if (ratingValue != null) fields.push('rating.value');
    if (reviewCount != null) fields.push('rating.reviewCount');
  }
  const typeEvidence = {
    method: 'dom_path_and_listing_card_inference',
    basis: [
      'Observed source page is a Rakuten /hotel_list/ page.',
      'Observed anchor path contains /hotel_info_item/ and a numeric hotel identifier.',
      'The same anchor contains a visible lodging-card title and, where present, price, rating/review, and booking/room text.',
    ],
  };
  const priceQualifiers = ['nightly_vs_stay_total_not_established'];
  if (rangeOperator != null && highAmount == null) priceQualifiers.push('upper_bound_not_visible');
  return {
    type: 'TravelOffering',
    sourceSchemaType: null,
    typeEvidence,
    offeringTypeBasis: typeEvidence.basis.join(' '),
    sourceLocalId: sourceLocalId == null ? null : String(sourceLocalId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 200),
    title,
    url: providerUrl.href,
    description: null,
    brand: null,
    price: {
      amount,
      lowAmount,
      highAmount,
      currency,
      priceText,
      priceKind,
      ...(Object.keys(conditions).length ? { conditions } : {}),
      qualifiers: priceQualifiers,
    },
    rating: { value: ratingValue, best: null, worst: null, reviewCount, ratingCount: null },
    variants: [],
    reviewSamples: [],
    evidence: [{
      receiptId,
      locator: `DOM a[href^="${providerUrl.origin}${providerUrl.pathname}"] visible hotel-list card text; observed href query keys startServiceDate, endServiceDate, numberOfUnits, numberOfAdults_* supply search conditions`,
      fields,
    }],
  };
}

function domHotelRecords(html, pageUrl, receiptId) {
  const root = parseFragment(html);
  const anchors = walkNodes(root, node => node.tagName === 'a' && nodeAttr(node, 'href') != null, [], 20000);
  const summary = { anchorsScanned: anchors.length, hotelDetailLinks: 0, identifiedHotelIds: 0, visiblePrices: 0, extractedRecords: 0, observedHotelLinkSamples: [] };
  const records = [];
  const seen = new Set();
  for (const anchor of anchors) {
    const url = safeUrl(nodeAttr(anchor, 'href'), pageUrl);
    const providerUrl = normalizeProviderUrl(url, 'rakuten.com');
    if (!providerUrl) continue;
    const text = safeString(textContent(anchor, 1800), 1800);
    if (!/hotel|stay|property|lodging/i.test(`${providerUrl.pathname} ${text ?? ''}`)) continue;
    if (summary.observedHotelLinkSamples.length < RECORD_CAP) summary.observedHotelLinkSamples.push({ url: providerUrl.href, text });
    const record = hotelRecordFromSample({ url: providerUrl.href, text }, receiptId);
    if (!record) continue;
    summary.hotelDetailLinks += 1;
    if (record.sourceLocalId) summary.identifiedHotelIds += 1;
    if (record.price.amount != null) summary.visiblePrices += 1;
    const identity = `${record.sourceLocalId ?? record.url}\0${record.title}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    records.push(record);
    if (records.length >= RECORD_CAP) break;
  }
  summary.extractedRecords = records.length;
  return { summary, records };
}

function candidateLinks(page, pageUrl, providerRoot, merchantId) {
  const rows = [];
  for (const link of page.links) {
    const url = normalizeProviderUrl(link.url, providerRoot);
    if (!url) continue;
    if (url.pathname === '/' || url.pathname === new URL(pageUrl).pathname) continue;
    if (/\.(?:js|mjs|css|map|png|jpe?g|gif|webp|svg|woff2?|ttf|pdf|xml)$/i.test(url.pathname)) continue;
    if (/\/(?:login|logout|cart|checkout|account|register|write)(?:\/|\.|$)/i.test(url.pathname)) continue;
    const text = String(link.text ?? '').trim();
    if (!text && !url.search) continue;
    const path = `${url.pathname} ${url.search}`.toLowerCase();
    const isDetail = merchantId === 'fwrd'
      ? /(?:\/product[-/]|\bsku=|\bproductid=)/i.test(path)
      : /(?:\/hotel(?:[-/]|$)|\/stay(?:[-/]|$)|\/property(?:[-/]|$)|\bhotelid=|\bplanid=)/i.test(path);
    const isUsefulNav = /(?:search|category|categories|designer|brand|collection|new|sale|women|men|hotel|stay|destination)/i.test(`${path} ${text}`);
    if (!isDetail && !isUsefulNav) continue;
    rows.push({ url: url.href, text: text.slice(0, 200), priority: isDetail ? 0 : 1 });
  }
  const byUrl = new Map();
  for (const item of rows) if (!byUrl.has(item.url)) byUrl.set(item.url, item);
  return [...byUrl.values()].sort((a, b) => a.priority - b.priority).slice(0, LINK_CAP);
}

function mergeRecords(...lists) {
  const result = [];
  const seen = new Set();
  for (const row of lists.flat()) {
    const key = row.sourceLocalId != null
      ? `${row.type ?? ''}\0${row.sourceLocalId}\0${row.title ?? ''}`
      : `${row.type ?? ''}\0${row.url ?? ''}\0${row.title ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function pageReport(read, provider, requestedUrl, phase) {
  if (read.receipt) read.receipt.phase = phase;
  if (!read.ok) return {
    requestedUrl: safeUrl(requestedUrl),
    finalUrl: safeUrl(read.url),
    receiptId: read.receipt?.id ?? null,
    state: read.blocked ? 'blocked' : 'read_failed',
    status: read.status ?? read.receipt?.responseStatus ?? null,
    stopReason: read.stopReason ?? null,
    redirects: (read.redirects ?? []).map(row => ({ status: row.status, from: safeUrl(row.from), to: safeUrl(row.to) })),
  };
  const extracted = extractPublicPage({ url: read.url, html: read.html, receipt: read.receipt }, { merchantId: provider.merchantId });
  const state = scriptStateSummary(read.html, {
    merchantId: provider.merchantId,
    pageUrl: read.url,
    providerRoot: PROVIDERS[provider.merchantId].providerRoot,
    links: extracted.links,
    receiptId: read.receipt.id,
  });
  const domOffers = provider.merchantId === 'rakutentr'
    ? domHotelRecords(read.html, read.url, read.receipt.id)
    : { summary: null, records: [] };
  return {
    requestedUrl: safeUrl(requestedUrl),
    finalUrl: safeUrl(read.url),
    receiptId: read.receipt.id,
    state: 'live_replay_verified',
    status: read.status,
    title: extracted.title,
    description: extracted.description,
    jsonLdTypes: extracted.jsonLd.map(row => row?.['@type'] ?? null).filter(Boolean),
    extractedJsonLdRecords: extracted.records.map(record => ({
      ...record,
      title: safeString(record.title, 1000),
      description: safeString(record.description, 4000),
      brand: safeString(record.brand, 300),
      url: safeUrl(record.url),
      offers: (record.offers ?? []).map(offer => ({ ...offer, url: safeUrl(offer.url) })),
    })),
    linkCount: extracted.links.length,
    extractedEmbeddedRecords: state.records,
    embeddedStateScan: state.summary,
    domOfferingScan: domOffers.summary,
    extractedDomRecords: domOffers.records,
    redirects: (read.redirects ?? []).map(row => ({ status: row.status, from: safeUrl(row.from), to: safeUrl(row.to) })),
  };
}

function pageParseFailure(report, read, requestedUrl, phase, error) {
  const parseFailure = {
    requestedUrl: safeUrl(requestedUrl),
    finalUrl: safeUrl(read.url),
    receiptId: read.receipt?.id ?? null,
    phase,
    state: 'page_parse_failed',
    errorCode: typeof error?.code === 'string' ? error.code : 'PAGE_PARSE_FAILED',
    browserUsed: false,
  };
  report.pages.push(parseFailure);
  report.frontier.push(`Page parse failed after receipt checkpoint (${parseFailure.errorCode}) at ${safeUrl(requestedUrl)}; response body was not persisted.`);
  report.status = 'page_parse_failed';
  checkpointDocument(report);
}

async function collectProvider(merchantId, options = {}) {
  const base = PROVIDERS[merchantId];
  if (!base) throw Object.assign(new Error('MERCHANT_NOT_IN_NATIVE_FOLLOWUP'), { code: 'MERCHANT_NOT_IN_NATIVE_FOLLOWUP' });
  const provider = { ...base, merchantId };
  const report = {
    merchantId,
    siteUrl: base.siteUrl,
    runId: randomUUID(),
    checkedAt: new Date().toISOString(),
    transport: 'native_node_fetch_no_custom_headers_cookies_or_authorization',
    browserUsed: false,
    credentialsUsed: false,
    receipts: [],
    contracts: [],
    records: [],
    pages: [],
    operations: { root: 'not_started', observed_product_or_navigation_reads: 'not_started' },
    frontier: [],
    status: 'not_started',
  };

  const rootRead = await readNativePage(base.siteUrl, base.providerRoot, options, row => {
    row.phase = 'saved_root_recheck';
    addReceiptCheckpoint(report, row);
  });
  if (!rootRead.receipts?.length) checkpointDocument(report);
  let rootPage;
  try { rootPage = pageReport(rootRead, provider, base.siteUrl, 'saved_root_recheck'); }
  catch (error) {
    pageParseFailure(report, rootRead, base.siteUrl, 'saved_root_recheck', error);
    return report;
  }
  report.pages.push(rootPage);
  report.operations.root = rootPage.state;
  if (!rootRead.ok) {
    report.frontier.push(`Root read stopped: ${rootRead.stopReason ?? 'unknown'} (HTTP ${rootRead.status ?? 'none'}).`);
    report.status = rootRead.blocked ? 'blocked_root' : 'root_read_failed';
    report.operations.observed_product_or_navigation_reads = 'not_attempted_after_root_stop';
    checkpointDocument(report);
    return report;
  }

  report.records = mergeRecords(rootPage.extractedJsonLdRecords, rootPage.extractedEmbeddedRecords, rootPage.extractedDomRecords);
  let rootPublicPage;
  let observedLinks;
  try {
    rootPublicPage = extractPublicPage({ url: rootRead.url, html: rootRead.html, receipt: rootRead.receipt }, { merchantId });
    observedLinks = candidateLinks(rootPublicPage, rootRead.url, base.providerRoot, merchantId);
  } catch (error) {
    pageParseFailure(report, rootRead, base.siteUrl, 'saved_root_link_extraction', error);
    return report;
  }
  rootPage.observedLinkCandidates = observedLinks;
  report.status = 'root_markup_scanned';
  checkpointDocument(report);
  let attempted = 0;
  for (const candidate of observedLinks) {
    if (attempted >= LINK_CAP) break;
    const parsed = normalizeProviderUrl(candidate.url, base.providerRoot);
    if (!parsed) continue;
    attempted += 1;
    const read = await readNativePage(parsed.href, base.providerRoot, options, row => {
      row.phase = 'observed_product_or_navigation_link';
      addReceiptCheckpoint(report, row);
    });
    if (!read.receipts?.length) checkpointDocument(report);
    let page;
    try { page = pageReport(read, provider, parsed.href, 'observed_product_or_navigation_link'); }
    catch (error) {
      pageParseFailure(report, read, parsed.href, 'observed_product_or_navigation_link', error);
      return report;
    }
    page.anchorText = candidate.text;
    report.pages.push(page);
    if (!read.ok) {
      report.frontier.push(`Observed link stopped: ${read.stopReason ?? 'unknown'} (HTTP ${read.status ?? 'none'}) at ${safeUrl(parsed.href)}.`);
      report.operations.observed_product_or_navigation_reads = read.blocked ? 'blocked_observed_link' : 'observed_link_read_failed';
      checkpointDocument(report);
      if (read.blocked) break;
      continue;
    }
    report.records = mergeRecords(report.records, page.extractedJsonLdRecords, page.extractedEmbeddedRecords, page.extractedDomRecords);
    if (merchantId === 'fwrd') {
      // The root already exposes product detail links; spend both bounded
      // reads on those observed products instead of a generic nav from PDP.
      checkpointDocument(report);
      continue;
    }
    let childPage;
    let childLinks;
    try {
      childPage = extractPublicPage({ url: read.url, html: read.html, receipt: read.receipt }, { merchantId });
      childLinks = candidateLinks(childPage, read.url, base.providerRoot, merchantId);
    } catch (error) {
      pageParseFailure(report, read, parsed.href, 'observed_product_link_extraction', error);
      return report;
    }
    // Only follow links already exposed by the exact page just read, keeping
    // the total observed PDP/navigation reads to two per provider.
    for (const childCandidate of childLinks) {
      if (attempted >= LINK_CAP) break;
      const childUrl = normalizeProviderUrl(childCandidate.url, base.providerRoot);
      if (!childUrl || report.pages.some(saved => saved.finalUrl === childUrl.href || saved.requestedUrl === childUrl.href)) continue;
      attempted += 1;
      const childRead = await readNativePage(childUrl.href, base.providerRoot, options, row => {
        row.phase = 'observed_product_or_navigation_link';
        addReceiptCheckpoint(report, row);
      });
      if (!childRead.receipts?.length) checkpointDocument(report);
      let childReport;
      try { childReport = pageReport(childRead, provider, childUrl.href, 'observed_product_or_navigation_link'); }
      catch (error) {
        pageParseFailure(report, childRead, childUrl.href, 'observed_product_or_navigation_link', error);
        return report;
      }
      childReport.anchorText = childCandidate.text;
      report.pages.push(childReport);
      if (childRead.ok) report.records = mergeRecords(report.records, childReport.extractedJsonLdRecords, childReport.extractedEmbeddedRecords, childReport.extractedDomRecords);
      else {
        report.frontier.push(`Observed linked page stopped: ${childRead.stopReason ?? 'unknown'} (HTTP ${childRead.status ?? 'none'}) at ${safeUrl(childUrl.href)}.`);
        if (childRead.blocked) break;
      }
      checkpointDocument(report);
    }
    break;
  }
  if (!attempted) report.operations.observed_product_or_navigation_reads = 'no_observed_candidate_links';
  else if (report.operations.observed_product_or_navigation_reads === 'not_started') report.operations.observed_product_or_navigation_reads = 'completed_within_cap';

  report.frontier.push(`Root embedded-state scan: ${JSON.stringify(rootPage.embeddedStateScan)}.`);
  if (report.records.length === 0) report.frontier.push('No typed product/stay records were extracted from JSON-LD or structured embedded state on the root and up to two observed same-provider product/navigation pages.');
  report.status = report.records.length ? 'listing_or_detail_records_extracted' : 'transport_and_markup_scanned_no_typed_records';
  checkpointDocument(report);
  return report;
}

export async function collectMerchant(merchantId, options = {}) {
  return collectProvider(merchantId, options);
}

/** Re-read only a URL previously captured as an observed same-provider page. */
export async function recheckSavedObservedPage(merchantId, observedPageUrl, options = {}) {
  const provider = PROVIDERS[merchantId];
  if (!provider) throw Object.assign(new Error('MERCHANT_NOT_IN_NATIVE_FOLLOWUP'), { code: 'MERCHANT_NOT_IN_NATIVE_FOLLOWUP' });
  const document = JSON.parse(readFileSync(REPORT_FILE, 'utf8'));
  const previous = document.merchants?.find(row => row.merchantId === merchantId);
  const requestedSafeUrl = safeUrl(observedPageUrl);
  const savedPage = previous?.pages?.find(page => page.state === 'live_replay_verified'
    && (page.requestedUrl === requestedSafeUrl || page.finalUrl === requestedSafeUrl));
  const allowedUrl = savedPage?.finalUrl ?? savedPage?.requestedUrl;
  if (!allowedUrl || !normalizeProviderUrl(allowedUrl, provider.providerRoot)) {
    throw Object.assign(new Error('URL_NOT_IN_SAVED_OBSERVED_PAGES'), { code: 'URL_NOT_IN_SAVED_OBSERVED_PAGES' });
  }

  const report = {
    ...previous,
    runId: randomUUID(),
    checkedAt: new Date().toISOString(),
    status: 'targeted_observed_page_recheck',
    receipts: [...(previous.receipts ?? [])],
    contracts: [...(previous.contracts ?? [])],
    pages: [...(previous.pages ?? [])],
    records: [...(previous.records ?? [])],
    frontier: [...(previous.frontier ?? [])],
    operations: { ...(previous.operations ?? {}), observed_page_recheck: 'in_progress' },
  };
  const read = await readNativePage(allowedUrl, provider.providerRoot, options, row => {
    row.phase = 'targeted_saved_observed_page_recheck';
    addReceiptCheckpoint(report, row);
  });
  if (!read.receipts?.length) checkpointDocument(report);
  let page;
  try { page = pageReport(read, { ...provider, merchantId }, allowedUrl, 'targeted_saved_observed_page_recheck'); }
  catch (error) {
    pageParseFailure(report, read, allowedUrl, 'targeted_saved_observed_page_recheck', error);
    return report;
  }
  page.recheckOfReceiptId = savedPage.receiptId ?? null;
  report.pages.push(page);
  report.operations.observed_page_recheck = page.state;
  if (read.ok) report.records = mergeRecords(report.records, page.extractedJsonLdRecords, page.extractedEmbeddedRecords, page.extractedDomRecords);
  else report.frontier.push(`Saved observed-page recheck stopped: ${read.stopReason ?? 'unknown'} (HTTP ${read.status ?? 'none'}).`);
  report.status = report.records.length ? 'listing_or_detail_records_extracted' : read.blocked ? 'blocked_saved_observed_page' : 'saved_observed_page_scanned_no_records';
  checkpointDocument(report);
  return report;
}

/** Rebuild Rakuten stay records from already-saved observed DOM anchor samples. */
export function rebuildSavedHotelRecords() {
  const document = JSON.parse(readFileSync(REPORT_FILE, 'utf8'));
  const previous = document.merchants?.find(row => row.merchantId === 'rakutentr');
  if (!previous) throw Object.assign(new Error('RAKUTEN_REPORT_NOT_FOUND'), { code: 'RAKUTEN_REPORT_NOT_FOUND' });
  const page = [...(previous.pages ?? [])].reverse().find(row => row.domOfferingScan?.observedHotelLinkSamples?.length);
  if (!page || !page.receiptId || !safeUrl(page.finalUrl)) {
    throw Object.assign(new Error('SAVED_RAKUTEN_HOTEL_LINK_SAMPLES_NOT_FOUND'), { code: 'SAVED_RAKUTEN_HOTEL_LINK_SAMPLES_NOT_FOUND' });
  }
  const samples = page.domOfferingScan.observedHotelLinkSamples;
  const records = mergeRecords(samples.map(sample => hotelRecordFromSample(sample, page.receiptId)).filter(Boolean));
  page.extractedDomRecords = records;
  page.domOfferingScan = {
    ...page.domOfferingScan,
    sampledLinksReprocessed: samples.length,
    hotelDetailLinks: records.length,
    identifiedHotelIds: records.filter(row => row.sourceLocalId).length,
    visiblePrices: records.filter(row => row.price.amount != null || row.price.lowAmount != null || row.price.highAmount != null || row.price.priceText != null).length,
    extractedRecords: records.length,
    reprocessedFromSavedAnchorSamples: true,
  };
  const report = {
    ...previous,
    runId: randomUUID(),
    checkedAt: new Date().toISOString(),
    records: mergeRecords(
      records,
      (previous.records ?? []).filter(row => !String(row.sourceLocalId ?? '').includes('[전화번호]') && !records.some(next => next.sourceLocalId && next.sourceLocalId === row.sourceLocalId)),
    ),
    status: records.length ? 'listing_or_detail_records_extracted' : previous.status,
    operations: { ...(previous.operations ?? {}), saved_hotel_dom_samples: records.length ? 'parsed_records' : 'no_hotel_detail_card_records' },
  };
  report.frontier = [...(report.frontier ?? []).filter(value => !String(value).includes('No typed product/stay records')), ...(records.length ? [] : ['Saved hotel-list DOM anchor samples were reprocessed; no hotel detail record met the evidence fields.'])];
  checkpointDocument(report);
  return report;
}

export async function collectAll(options = {}) {
  for (const merchantId of merchantIds) await collectProvider(merchantId, options);
  return JSON.parse(readFileSync(REPORT_FILE, 'utf8'));
}
