import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';
import { extractPublicPage, readPublicPage, readPublicResource, safeUrl, textContent } from '../../lib/cps-public-reader.mjs';
import { observedCount } from '../../lib/cps-values.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../..');
const BATCH06_PATH = path.join(APP_ROOT, 'references/cps-reverify/batch-06.json');
const RESULT_PATH = path.join(APP_ROOT, 'references/cps-reverify/lenovo-public-supplement.json');
const PAGE_HOSTS = ['www.lenovo.com'];
const OBSERVED_RESOURCE_HOSTS = ['www.lenovo.com', 'ap-ss.static.pub'];
const MAX_CATEGORY_READS = 6;
const MAX_DETAIL_READS = 1;
const MAX_RESOURCE_READS = 1;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 3 * 1024 * 1024;
const PRIOR_OBSERVED_PRODUCT_DETAIL_URL = 'https://www.lenovo.com/kr/ko/p/laptops/thinkpad/thinkpadx1/lenovo-thinkpad-x1-carbon-gen-14-aura-edition-14-inch-intel/len101t0159?ipromoID=Megamenu_Laptop_ThinkPad-X1-Carbon-Gen-14';

const PRIOR_PUBLIC_ASSETS = new Set([
  'https://ap-ss.static.pub/s/SystemFragment/header/header-component/searchBox/pc.js',
  'https://ap-ss.static.pub/s/2026/09/16/files.20260916103808409651.js',
]);
const PREFERRED_OBSERVED_PATHS = [
  '/kr/ko/laptops/',
  '/kr/ko/c/laptops/ideapad/ideapad-5/',
  '/kr/ko/c/laptops/thinkpad/thinkpadt/',
  '/kr/ko/c/laptops/thinkpad/thinkpade/',
  '/kr/ko/c/laptops/thinkpad/thinkpadl/',
  '/kr/ko/desktops/',
  '/kr/ko/tablets/',
  '/kr/ko/d/gaming-pcs/',
];

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function receiptFromPage(page, kind) {
  const receipt = page.receipt;
  if (!receipt) return null;
  return {
    receiptId: receipt.id,
    kind,
    method: receipt.requestMethod ?? 'GET',
    requestedUrl: safeUrl(receipt.requestUrl),
    finalUrl: safeUrl(page.url ?? receipt.requestUrl),
    status: receipt.responseStatus ?? page.status ?? null,
    mime: receipt.contentType ?? page.contentType ?? null,
    bytes: receipt.bytes ?? 0,
    sha256: receipt.responseSha256 ?? null,
    checkedAt: receipt.observedAt ?? null,
    redirects: (page.redirects ?? []).map(row => ({ status: row.status, from: safeUrl(row.from), to: safeUrl(row.to) })),
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    secureTransport: true,
    stopReason: page.stopReason ?? null,
  };
}

function observedCategorySeeds(previous) {
  const row = previous?.merchants?.find(item => item.merchantId === 'lenovo');
  const priorUrls = new Set((row?.receipts ?? []).map(item => safeUrl(item.requestedUrl ?? item.requestUrl)).filter(Boolean));
  const pending = (row?.frontier ?? []).filter(item => item.state === 'pending_budget_frontier' && typeof item.url === 'string')
    .map(item => ({ ...item, url: safeUrl(item.url) }))
    .filter(item => item.url && !priorUrls.has(item.url));
  const byPath = new Map(pending.map(item => [new URL(item.url).pathname, item]));
  return PREFERRED_OBSERVED_PATHS.map(item => byPath.get(item)).filter(Boolean).slice(0, MAX_CATEGORY_READS);
}

function isInScopeProductUrl(value) {
  const url = safeUrl(value);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'www.lenovo.com' || parsed.protocol !== 'https:' || !/^\/kr\/ko(?:\/|$)/i.test(parsed.pathname)) return false;
    if (/\/(?:login|account|business|lenovopro|cart|checkout|trackmyorder|warranty|support)(?:\/|$)/i.test(parsed.pathname)) return false;
    return /(?:^|\/)(?:p|product|products|model|machine-type)(?:\/|$)/i.test(parsed.pathname)
      || /(?:productnumber|productid|machineType|modelNumber)=/i.test(parsed.search);
  } catch { return false; }
}

function observedScriptResources(html, baseUrl) {
  const root = parseFragment(html ?? '');
  const result = [];
  const visit = node => {
    if (node?.tagName === 'script') {
      const src = (node.attrs ?? []).find(item => item.name === 'src')?.value;
      const url = safeUrl(src, baseUrl);
      if (url) {
        try {
          const parsed = new URL(url);
          if (OBSERVED_RESOURCE_HOSTS.includes(parsed.hostname) && parsed.protocol === 'https:' && !PRIOR_PUBLIC_ASSETS.has(url)) result.push(url);
        } catch { /* Ignore invalid observed script references. */ }
      }
    }
    for (const child of node?.childNodes ?? []) visit(child);
  };
  visit(root);
  return [...new Set(result)];
}

function visibleProductLinks(extraction) {
  return [...new Map((extraction.links ?? []).map(link => safeUrl(link.url)).filter(isInScopeProductUrl)
    .map(url => [url, { url, text: (extraction.links ?? []).find(link => safeUrl(link.url) === url)?.text ?? null }])).values()];
}

function collectEmbeddedProductCandidates(extraction, page, receiptId) {
  const records = [];
  let nodesVisited = 0;
  const walk = (value, jsonId, jsonPath, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 14 || nodesVisited > 20_000) return;
    nodesVisited += 1;
    if (Array.isArray(value)) {
      value.slice(0, 1_000).forEach((item, index) => walk(item, jsonId, `${jsonPath}[${index}]`, depth + 1));
      return;
    }
    const title = [value.productName, value.productTitle, value.modelName, value.name, value.title]
      .find(item => typeof item === 'string' && item.trim().length > 2) ?? null;
    const localId = [value.productNumber, value.productNo, value.productId, value.modelNumber, value.machineType, value.sku, value.partNumber]
      .find(item => (typeof item === 'string' && item.trim()) || (typeof item === 'number' && Number.isFinite(item))) ?? null;
    const rawUrl = [value.productUrl, value.productLink, value.url, value.pdpUrl]
      .find(item => typeof item === 'string' && item.trim()) ?? null;
    const linkedUrl = rawUrl ? safeUrl(rawUrl, page.url) : null;
    const priceValue = [value.currentPrice, value.finalPrice, value.webPrice, value.productPrice, value.price]
      .find(item => (typeof item === 'number' && Number.isFinite(item)) || (typeof item === 'string' && /\d/.test(item))) ?? null;
    const hasProductIdentity = localId != null && title && /(?:product|model|machine|sku|part|series)/i.test(`${jsonPath} ${Object.keys(value).join(' ')}`);
    if (hasProductIdentity) {
      let amount = null, priceText = null;
      if (typeof priceValue === 'number' && priceValue >= 0) amount = priceValue;
      else if (typeof priceValue === 'string') {
        const match = priceValue.replace(/,/g, '').match(/(?:₩|KRW\s*)?\s*(\d+(?:\.\d+)?)(?:\s*(?:원|KRW))?/i);
        if (match) amount = Number(match[1]);
        priceText = priceValue.slice(0, 100);
      }
      const currency = value.currency === 'KRW' || value.priceCurrency === 'KRW' || /₩|원/.test(String(priceValue ?? '')) ? 'KRW' : null;
      const price = amount == null ? null : { amount, currency, priceText };
      const detailUrl = linkedUrl && isInScopeProductUrl(linkedUrl) ? linkedUrl : safeUrl(page.url);
      const fields = ['type', 'title', 'url', 'sourceLocalId'];
      if (value.description || value.shortDescription || value.summary) fields.push('description');
      if (value.brand?.name || value.brandName) fields.push('brand');
      if (price) fields.push('price');
      records.push({
        type: 'RetailProduct', sourceLocalId: String(localId), title: title.trim(), url: detailUrl,
        description: value.description ?? value.shortDescription ?? value.summary ?? null,
        brand: value.brand?.name ?? value.brandName ?? null,
        price,
        rating: { value: null, best: null, worst: null, reviewCount: null, ratingCount: null },
        variants: [], reviewSamples: [],
        evidence: [{ receiptId, locator: `Embedded JSON ${jsonId}:${jsonPath}`, fields }],
      });
    }
    for (const [key, child] of Object.entries(value).slice(0, 500)) walk(child, jsonId, `${jsonPath}.${String(key).slice(0, 100)}`, depth + 1);
  };
  for (const block of extraction.embeddedJson ?? []) walk(block.value, block.id, '$');
  return [...new Map(records.map(record => [`${record.sourceLocalId}|${record.url}|${record.title}`, record])).values()].slice(0, 60);
}

function inspectProductApiRouteLiterals(source, resourceUrl, receiptId) {
  const routes = [];
  const pattern = /(["'`])((?:\/ofp\/|\/product\/|\/online\/product\/|\/catalog\/|\/api\/)[^"'`\r\n]{2,300})\1/g;
  for (const match of source.matchAll(pattern)) {
    const rawPath = match[2].replace(/\s+/g, '').slice(0, 300);
    if (/token|authorization|cookie|csrf|session|password|secret/i.test(rawPath)) continue;
    const index = match.index ?? 0;
    const nearby = source.slice(Math.max(0, index - 180), Math.min(source.length, index + match[0].length + 100));
    const method = /\.get\s*\(|method\s*:\s*["']GET["']|\.open\s*\(\s*["']GET["']/i.test(nearby) ? 'GET'
      : /\.post\s*\(|method\s*:\s*["']POST["']|\.open\s*\(\s*["']POST["']/i.test(nearby) ? 'POST' : null;
    const queryFields = [...new Set([...rawPath.matchAll(/[?&]([A-Za-z0-9_-]+)=/g)].map(item => item[1]))];
    routes.push({ method, routeTemplate: rawPath, queryFieldNames: queryFields, methodObserved: method != null,
      replayed: false, receiptId, sourceUrl: safeUrl(resourceUrl) });
  }
  return [...new Map(routes.map(row => [`${row.method}|${row.routeTemplate}`, row])).values()].slice(0, 100);
}

function publicRecordFromSchema(record) {
  return {
    ...record,
    rating: record.rating ?? { value: null, best: null, worst: null, reviewCount: null, ratingCount: null },
    variants: record.variants ?? [], reviewSamples: record.reviewSamples ?? [],
    evidence: (record.evidence ?? []).map(item => ({ ...item, reviewerIdentity: undefined })),
  };
}

function schemaTypes(row) {
  return (Array.isArray(row?.['@type']) ? row['@type'] : [row?.['@type']]).filter(Boolean)
    .map(value => String(value).split(/[\/#]/).at(-1).toLowerCase());
}

function schemaNumeric(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(?:₩\s*)?(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?(?:\s*(?:원|KRW))?$/i);
  return match ? Number(match[1].replaceAll(',', '') + (value.match(/\.\d+/)?.[0] ?? '')) : null;
}

function safeLenovoSchemaUrl(value, pageUrl) {
  if (typeof value !== 'string' || /^\[.*\]$/.test(value)) return null;
  const safe = safeUrl(value, pageUrl);
  if (!safe) return null;
  try {
    const parsed = new URL(safe);
    return parsed.protocol === 'https:' && parsed.hostname === 'www.lenovo.com' && /^\/kr\/ko(?:\/|$)/i.test(parsed.pathname) ? safe : null;
  } catch { return null; }
}

function schemaOffers(value, pageUrl) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.filter(row => row && typeof row === 'object').slice(0, 30).map(row => {
    const amount = schemaNumeric(row.price);
    const lowPrice = schemaNumeric(row.lowPrice);
    const highPrice = schemaNumeric(row.highPrice);
    const currency = typeof row.priceCurrency === 'string' && /^[A-Z]{3}$/i.test(row.priceCurrency)
      ? row.priceCurrency.toUpperCase() : /₩|원/.test(String(row.price ?? '')) ? 'KRW' : null;
    const availability = String(row.availability ?? '').split(/[\/#]/).at(-1);
    const rawOfferUrl = typeof row.url === 'string' && !/^\[.*\]$/.test(row.url) ? row.url
      : typeof row['@id'] === 'string' && !/^\[.*\]$/.test(row['@id']) ? row['@id'] : null;
    const offerUrl = safeLenovoSchemaUrl(rawOfferUrl, pageUrl);
    return {
      amount, currency,
      priceText: row.price == null ? (lowPrice == null && highPrice == null ? null : `${lowPrice ?? ''}${lowPrice != null && highPrice != null && lowPrice !== highPrice ? '–' : ''}${highPrice ?? ''}${currency ? ` ${currency}` : ''}`) : String(row.price).slice(0, 200),
      lowPrice, highPrice,
      type: schemaTypes(row).includes('aggregateoffer') ? 'AggregateOffer' : 'Offer',
      availability: ({ InStock: 'in_stock', OutOfStock: 'out_of_stock', PreOrder: 'preorder', BackOrder: 'backorder', LimitedAvailability: 'limited' })[availability] ?? 'unknown',
      seller: typeof row.seller === 'string' ? row.seller.slice(0, 300) : row.seller?.name?.slice?.(0, 300) ?? null,
      validFrom: typeof row.validFrom === 'string' ? row.validFrom.slice(0, 40) : null,
      validUntil: typeof row.priceValidUntil === 'string' ? row.priceValidUntil.slice(0, 40) : null,
      condition: typeof row.itemCondition === 'string' && !/^\[.*\]$/.test(row.itemCondition) ? row.itemCondition.slice(0, 300) : null,
      url: offerUrl,
    };
  });
}

function recordFromObservedProductSchema(row, page, receiptId, index) {
  if (!schemaTypes(row).some(type => ['product', 'productgroup', 'productmodel'].includes(type))) return null;
  const title = typeof row.name === 'string' && row.name.trim().length > 2 ? row.name.trim().slice(0, 1000) : null;
  if (!title) return null;
  const pageUrl = safeUrl(page.url);
  const offers = schemaOffers(row.offers, pageUrl);
  const exactOffer = offers.find(offer => offer.amount != null || offer.priceText != null);
  const ratingRow = row.aggregateRating && typeof row.aggregateRating === 'object' ? row.aggregateRating : {};
  const ratingValue = schemaNumeric(ratingRow.ratingValue);
  const best = schemaNumeric(ratingRow.bestRating), worst = schemaNumeric(ratingRow.worstRating);
  const reviewCount = observedCount(ratingRow.reviewCount);
  const ratingCount = observedCount(ratingRow.ratingCount);
  const rating = ratingValue == null && best == null && worst == null && reviewCount == null && ratingCount == null
    ? { value: null, best: null, worst: null, reviewCount: null, ratingCount: null }
    : { value: ratingValue, best, worst, reviewCount, ratingCount };
  const variants = (Array.isArray(row.hasVariant) ? row.hasVariant : row.hasVariant ? [row.hasVariant] : [])
    .filter(item => item && typeof item === 'object' && typeof item.name === 'string').slice(0, 30).map(item => {
      const variantOffers = schemaOffers(item.offers, pageUrl);
      return {
        sourceLocalId: item.sku == null && item.mpn == null ? null : String(item.sku ?? item.mpn),
        title: item.name.slice(0, 500), url: safeUrl(item.url ?? item['@id'] ?? pageUrl, pageUrl),
        price: { amount: schemaNumeric(item.price) ?? variantOffers.find(offer => offer.amount != null)?.amount ?? null,
          currency: item.priceCurrency ?? variantOffers.find(offer => offer.currency)?.currency ?? null,
          priceText: item.price == null ? variantOffers.find(offer => offer.priceText)?.priceText ?? null : String(item.price).slice(0, 200) },
        offers: variantOffers,
      };
    });
  const pathnameId = new URL(pageUrl).pathname.split('/').filter(Boolean).at(-1) ?? null;
  const sourceLocalId = row.sku ?? row.mpn ?? row.productID ?? row.productGroupID
    ?? (typeof row.identifier === 'string' ? row.identifier : row.identifier?.value) ?? pathnameId;
  const priceAmount = schemaNumeric(row.price) ?? exactOffer?.amount ?? null;
  const priceCurrency = (typeof row.priceCurrency === 'string' && /^[A-Z]{3}$/i.test(row.priceCurrency) ? row.priceCurrency.toUpperCase() : null)
    ?? exactOffer?.currency ?? (/₩|원/.test(String(row.price ?? '')) ? 'KRW' : null);
  const price = { amount: priceAmount, currency: priceCurrency,
    priceText: row.price == null ? exactOffer?.priceText ?? null : String(row.price).slice(0, 200) };
  const description = typeof row.description === 'string' ? row.description.replace(/\s+/g, ' ').trim().slice(0, 4000) : null;
  const brand = typeof row.brand === 'string' ? row.brand.slice(0, 300) : row.brand?.name?.slice?.(0, 300) ?? null;
  const fields = ['type', 'sourceLocalId', 'title', 'url'];
  if (description) fields.push('description');
  if (brand) fields.push('brand');
  if (price.amount != null || price.priceText != null) fields.push('price');
  if (offers.length) fields.push('offers');
  if (rating.value != null || rating.reviewCount != null || rating.ratingCount != null) fields.push('rating');
  if (variants.length) fields.push('variants');
  return {
    type: 'RetailProduct', sourceSchemaType: schemaTypes(row).join('|'),
    sourceLocalId: String(sourceLocalId), title, url: pageUrl, description, brand, price, offers, rating,
    variants, reviewSamples: [],
    evidence: [{ receiptId, locator: `observed product-detail JSON-LD row ${index + 1}`, fields }],
  };
}

function rawProductJsonLdUrlAudit(html, pageUrl) {
  let root;
  try { root = parseFragment(html ?? ''); } catch { return []; }
  const results = [];
  const scanValue = (value, blockIndex, pathLabel, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 12 || results.length >= 50) return;
    if (Array.isArray(value)) {
      value.slice(0, 500).forEach((child, index) => scanValue(child, blockIndex, `${pathLabel}[${index}]`, depth + 1));
      return;
    }
    const rawTypes = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    const types = rawTypes.filter(Boolean).map(item => String(item).split(/[\/#]/).at(-1).toLowerCase());
    if (types.some(type => ['product', 'productgroup', 'productmodel'].includes(type))) {
      const rawUrl = typeof value.url === 'string' ? value.url : null;
      const rawId = typeof value['@id'] === 'string' ? value['@id'] : null;
      const safeUrlValue = safeLenovoSchemaUrl(rawUrl, pageUrl);
      const safeIdValue = safeLenovoSchemaUrl(rawId, pageUrl);
      const chosen = safeUrlValue ?? safeIdValue;
      let matchesObservedPath = null;
      try {
        if (chosen) {
          const candidate = new URL(chosen), observed = new URL(pageUrl);
          matchesObservedPath = candidate.origin === observed.origin && candidate.pathname.replace(/\/$/, '') === observed.pathname.replace(/\/$/, '');
        }
      } catch { /* Keep unknown when URL parsing fails. */ }
      results.push({ locator: `script[type="application/ld+json"]:${blockIndex} ${pathLabel}`,
        schemaTypes: types, title: typeof value.name === 'string' ? value.name.slice(0, 500) : null,
        sourceLocalId: value.sku ?? value.mpn ?? value.productID ?? null,
        rawUrlFieldPresent: rawUrl != null, rawIdFieldPresent: rawId != null,
        safeUrl: safeUrlValue, safeId: safeIdValue, matchesObservedDetailPath: matchesObservedPath });
    }
    for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'hasVariant']) {
      if (Object.hasOwn(value, key)) scanValue(value[key], blockIndex, `${pathLabel}.${key}`, depth + 1);
    }
  };
  let scriptIndex = 0;
  const visit = node => {
    if (!node) return;
    if (node.tagName === 'script' && (node.attrs ?? []).some(attr => attr.name === 'type' && attr.value.split(';', 1)[0].trim().toLowerCase() === 'application/ld+json')) {
      scriptIndex += 1;
      const raw = (node.childNodes ?? []).map(child => child.value ?? '').join('').trim();
      try { scanValue(JSON.parse(raw), scriptIndex, '$'); } catch { /* Ignore invalid source JSON. */ }
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return results.slice(0, 50);
}

async function auditRawProductJsonLdLinks(prior) {
  const previousContract = prior.contracts?.find(item => item.operation === 'observed_product_detail_jsonld_normalization');
  const detailUrl = safeUrl(previousContract?.requestUrl ?? PRIOR_OBSERVED_PRODUCT_DETAIL_URL);
  if (!detailUrl || prior.contracts?.some(item => item.operation === 'observed_product_detail_raw_jsonld_link_audit_GET')) return prior;
  const page = await readPublicPage(detailUrl, { allowedHosts: PAGE_HOSTS, maxRedirects: 2, maxBytes: MAX_BYTES, timeoutMs: 20_000 });
  const receipt = receiptFromPage(page, 'observed_product_detail_raw_jsonld_link_audit_GET');
  if (receipt) prior.receipts.push(receipt);
  const rows = page.ok ? rawProductJsonLdUrlAudit(page.html, page.url) : [];
  prior.contracts.push({ operation: 'observed_product_detail_raw_jsonld_link_audit_GET', method: 'GET', requestUrl: detailUrl,
    finalUrl: safeUrl(page.url), status: page.status ?? null, mime: page.contentType ?? null, observedAt: receipt?.checkedAt ?? null,
    browserUsed: false, cookiesSent: false, authorizationSent: false, publicClientHeaderSent: false,
    productSchemaRows: rows, rawValuesPersisted: false, evidenceReceiptId: receipt?.receiptId ?? null,
    stopReason: page.stopReason ?? null });
  prior.frontier.push({ operation: 'observed_product_detail_raw_jsonld_link_audit_GET', url: detailUrl,
    state: page.ok ? 'raw_jsonld_inspected_safe_link_metadata_saved' : page.stopReason, retry: false,
    evidenceReceiptId: receipt?.receiptId ?? null });
  if (page.blocked || [401, 403, 418, 429].includes(Number(page.status)) || /CHALLENGE/i.test(page.stopReason ?? '')) prior.blocked = true;
  prior.operations.productJsonLdLinkAudit = { state: page.ok ? 'live_replay' : 'blocked_or_not_observed',
    productSchemaRows: rows.length, evidenceReceiptIds: receipt?.receiptId ? [receipt.receiptId] : [] };
  prior.checkedAt = new Date().toISOString();
  prior.status = prior.blocked ? 'blocked_stopped' : prior.records?.length ? 'ontology_records_observed' : 'reachable_no_public_product_record';
  return prior;
}

async function enrichPreviouslyObservedProduct(prior) {
  const detail = prior.frontier?.find(item => item.operation === 'observed_consumer_product_detail_GET' && item.state === 'read' && typeof item.url === 'string')
    ?? { url: PRIOR_OBSERVED_PRODUCT_DETAIL_URL, sourceText: 'ThinkPad X1 Carbon Gen 14 Aura Edition (14″ Intel) 초경량. 초강력. 단연코 X1.',
      discovery: 'Exact consumer detail URL surfaced in the prior public category read; no route was guessed.' };
  const page = await readPublicPage(detail.url, { allowedHosts: PAGE_HOSTS, maxRedirects: 2, maxBytes: MAX_BYTES, timeoutMs: 20_000 });
  const receipt = receiptFromPage(page, 'observed_consumer_product_detail_jsonld_enrichment_GET');
  if (receipt) prior.receipts.push(receipt);
  const extraction = page.ok ? extractPublicPage(page, { merchantId: 'lenovo', typeHint: 'physical_retail' })
    : { title: null, description: null, links: [], forms: [], jsonLd: [], embeddedJson: [], records: [] };
  const products = extraction.jsonLd.map((row, index) => recordFromObservedProductSchema(row, page, receipt?.receiptId ?? null, index)).filter(Boolean);
  prior.contracts.push({ operation: 'observed_product_detail_jsonld_normalization', method: 'GET', requestUrl: detail.url,
    finalUrl: safeUrl(page.url), status: page.status ?? null, mime: page.contentType ?? null, observedAt: receipt?.checkedAt ?? null,
    browserUsed: false, cookiesSent: false, authorizationSent: false, publicClientHeaderSent: false,
    title: extraction.title, jsonLdBlocks: extraction.jsonLd.length, productSchemaRows: products.length,
    evidenceReceiptId: receipt?.receiptId ?? null, replayed: true,
    ...(detail.discovery ? { discovery: detail.discovery } : {}) });
  prior.frontier.push({ operation: 'observed_product_detail_jsonld_normalization', url: detail.url,
    state: page.ok ? (products.length ? 'normalized' : 'html_read_no_product_schema_record') : page.stopReason,
    retry: false, evidenceReceiptId: receipt?.receiptId ?? null });
  if (page.blocked || [401, 403, 418, 429].includes(Number(page.status)) || /CHALLENGE/i.test(page.stopReason ?? '')) prior.blocked = true;
  const recordsByIdentity = new Map((prior.records ?? []).map(row => [`${row.sourceLocalId ?? ''}|${row.url}|${row.title}`, row]));
  for (const record of products) recordsByIdentity.set(`${record.sourceLocalId ?? ''}|${record.url}|${record.title}`, record);
  prior.records = [...recordsByIdentity.values()];
  prior.checkedAt = new Date().toISOString();
  const evidenceIds = [...new Set(prior.records.flatMap(row => (row.evidence ?? []).map(item => item.receiptId).filter(Boolean)))];
  prior.lastRefresh = { attempted: true, observedAt: receipt?.checkedAt ?? null, httpStatus: page.status ?? null,
    recordsObserved: products.length, priorEvidenceRetained: true };
  prior.operations.productOrServiceRecord = { state: products.length ? 'live_replay' : prior.records.length ? 'prior_observation_retained_after_refresh' : 'not_observed', recordCount: prior.records.length, evidenceReceiptIds: evidenceIds };
  prior.operations.productDetailJsonLd = { state: products.length ? 'live_replay' : page.ok ? 'html_read_no_product_schema_record' : 'blocked_or_not_observed',
    recordCount: products.length, evidenceReceiptIds: receipt?.receiptId ? [receipt.receiptId] : [] };
  prior.operations.price = { state: products.some(row => row.price?.amount != null || row.price?.priceText != null) ? 'live_replay' : prior.records.length ? 'prior_observation_retained_after_refresh' : 'not_observed',
    recordCount: prior.records.filter(row => row.price?.amount != null || row.price?.priceText != null).length,
    evidenceReceiptIds: [...new Set(prior.records.filter(row => row.price?.amount != null || row.price?.priceText != null)
      .flatMap(row => row.evidence.map(item => item.receiptId).filter(Boolean)))] };
  prior.status = prior.blocked ? 'blocked_stopped' : prior.records.length ? 'ontology_records_observed' : 'reachable_no_public_product_record';
  return prior;
}

export async function collectLenovoPublic(options = {}) {
  const previous = readJson(BATCH06_PATH);
  const priorSupplement = readJson(RESULT_PATH);
  if (priorSupplement?.blocked || priorSupplement?.receipts?.some(row => [401, 403, 418, 429].includes(row.status) || /CHALLENGE/i.test(row.stopReason ?? ''))) {
    return { ...priorSupplement, status: 'blocked_stopped', retry: false };
  }
  if (options.inspectRawJsonLdLinks && priorSupplement?.merchantId === 'lenovo') {
    return save(await auditRawProductJsonLdLinks(priorSupplement));
  }
  if (priorSupplement?.merchantId === 'lenovo' && priorSupplement.contracts?.some(item => item.operation === 'observed_product_detail_jsonld_normalization')) {
    return save(await enrichPreviouslyObservedProduct(priorSupplement));
  }
  if (priorSupplement?.merchantId === 'lenovo' && !(priorSupplement.records?.length)) {
    return save(await enrichPreviouslyObservedProduct(priorSupplement));
  }
  const priorRequests = new Set([
    ...((previous?.merchants?.find(row => row.merchantId === 'lenovo')?.receipts ?? []).map(row => safeUrl(row.requestedUrl ?? row.requestUrl)).filter(Boolean)),
    ...((priorSupplement?.receipts ?? []).map(row => safeUrl(row.requestedUrl)).filter(Boolean)),
  ]);
  const report = {
    schemaVersion: 1,
    merchantId: 'lenovo',
    merchantName: '레노버코리아',
    siteUrl: 'https://www.lenovo.com/kr/ko/',
    checkedAt: new Date().toISOString(),
    sourceBatch: { path: 'references/cps-reverify/batch-06.json', merchantId: 'lenovo' },
    transport: { browserUsed: false, cookiesSent: false, authorizationSent: false, publicClientHeaderSent: false },
    priorScope: {
      previousReceiptsUsedWithoutRepeating: true,
      knownLoginBoundary: { url: 'https://account.lenovo.com/', state: 'observed_on_B2B_link_not_revisited', authAttempted: false },
      knownSavingsRoute: { route: '/ofp/search/dlp/cache/maxSave/get/_tsc', state: 'savings_only_not_product_catalog', replayedHere: false },
      knownMarketingRoutes: ['/product/subseriespdp/get?productNumber=', '/online/product/bottomContent?productNumber='],
    },
    receipts: [], records: [], contracts: [], frontier: [], operations: {}, blocked: false,
  };
  const seeds = observedCategorySeeds(previous);
  if (!seeds.length) {
    report.status = 'no_unvisited_observed_consumer_category_frontier';
    report.frontier.push({ state: report.status, source: 'batch-06.json observed frontier only' });
    return save(report);
  }

  const visited = new Set(priorRequests);
  const pageQueue = seeds.map(seed => ({ url: seed.url, sourceText: seed.text ?? null, kind: 'observed_public_category', priorFrontierState: seed.state }));
  const observedDetails = new Map();
  const observedResources = new Map();
  const pageHtmls = [];
  let categoryReads = 0;
  let detailReads = 0;
  let resourceReads = 0;
  let stopHost = false;

  while (pageQueue.length && !stopHost && categoryReads < MAX_CATEGORY_READS) {
    const current = pageQueue.shift();
    const requestUrl = safeUrl(current.url);
    if (!requestUrl || visited.has(requestUrl)) {
      report.frontier.push({ operation: current.kind, url: requestUrl, state: 'already_read_in_batch06_or_supplement', retry: false });
      continue;
    }
    visited.add(requestUrl);
    const page = await readPublicPage(requestUrl, { allowedHosts: PAGE_HOSTS, maxRedirects: 2, maxBytes: MAX_BYTES, timeoutMs: 20_000 });
    const receipt = receiptFromPage(page, current.kind);
    if (receipt) report.receipts.push(receipt);
    categoryReads += 1;
    const extraction = page.ok ? extractPublicPage(page, { merchantId: 'lenovo', typeHint: 'physical_retail' })
      : { title: null, description: null, links: [], forms: [], jsonLd: [], embeddedJson: [], records: [] };
    report.contracts.push({ operation: 'anonymous_public_category_GET', method: 'GET', requestUrl,
      finalUrl: safeUrl(page.url), status: page.status ?? null, mime: page.contentType ?? null,
      observedAt: receipt?.checkedAt ?? null, browserUsed: false, cookiesSent: false, authorizationSent: false,
      publicClientHeaderSent: false, stopReason: page.stopReason ?? null, title: extraction.title,
      description: extraction.description, forms: extraction.forms, jsonLdBlocks: extraction.jsonLd.length,
      embeddedJsonBlocks: extraction.embeddedJson.length, linkedRecords: extraction.records.length,
      discoveredFromBatch06Frontier: true, priorFrontierState: current.priorFrontierState, sourceText: current.sourceText,
      evidenceReceiptId: receipt?.receiptId ?? null,
    });
    report.frontier.push({ operation: current.kind, url: requestUrl,
      state: page.ok ? 'read' : page.stopReason, retry: false,
      ...(receipt?.receiptId ? { evidenceReceiptId: receipt.receiptId } : {}) });
    if (page.blocked || [401, 403, 418, 429].includes(Number(page.status)) || /CHALLENGE/i.test(page.stopReason ?? '')) {
      report.blocked = true;
      report.frontier.at(-1).stopHost = true;
      stopHost = true;
      break;
    }
    if (!page.ok) continue;

    pageHtmls.push({ page, extraction, receipt });
    const linkedRecords = extraction.records.map(publicRecordFromSchema);
    const embeddedRecords = collectEmbeddedProductCandidates(extraction, page, receipt?.receiptId ?? null);
    report.records.push(...linkedRecords, ...embeddedRecords);
    for (const link of visibleProductLinks(extraction)) {
      if (!observedDetails.has(link.url) && !visited.has(link.url)) observedDetails.set(link.url, { ...link, discoveredFromReceiptId: receipt?.receiptId ?? null });
    }
    for (const resourceUrl of observedScriptResources(page.html, page.url)) {
      if (!priorRequests.has(resourceUrl) && !observedResources.has(resourceUrl)) observedResources.set(resourceUrl, { url: resourceUrl, discoveredFromReceiptId: receipt?.receiptId ?? null });
    }
    report.frontier.at(-1).counts = { jsonLdBlocks: extraction.jsonLd.length, embeddedJsonBlocks: extraction.embeddedJson.length,
      schemaOfferingRecords: linkedRecords.length, embeddedProductCandidates: embeddedRecords.length,
      observedProductDetailLinks: visibleProductLinks(extraction).length };
  }

  for (const detail of [...observedDetails.values()].slice(0, MAX_DETAIL_READS)) {
    if (stopHost || detailReads >= MAX_DETAIL_READS) break;
    if (visited.has(detail.url)) continue;
    visited.add(detail.url);
    const page = await readPublicPage(detail.url, { allowedHosts: PAGE_HOSTS, maxRedirects: 2, maxBytes: MAX_BYTES, timeoutMs: 20_000 });
    const receipt = receiptFromPage(page, 'observed_consumer_product_detail_GET');
    if (receipt) report.receipts.push(receipt);
    detailReads += 1;
    const extraction = page.ok ? extractPublicPage(page, { merchantId: 'lenovo', typeHint: 'physical_retail' })
      : { title: null, description: null, links: [], forms: [], jsonLd: [], embeddedJson: [], records: [] };
    report.contracts.push({ operation: 'observed_consumer_product_detail_GET', method: 'GET', requestUrl: detail.url,
      finalUrl: safeUrl(page.url), status: page.status ?? null, mime: page.contentType ?? null,
      observedAt: receipt?.checkedAt ?? null, browserUsed: false, cookiesSent: false, authorizationSent: false,
      publicClientHeaderSent: false, stopReason: page.stopReason ?? null, title: extraction.title,
      description: extraction.description, jsonLdBlocks: extraction.jsonLd.length,
      embeddedJsonBlocks: extraction.embeddedJson.length, forms: extraction.forms,
      discoveredFromReceiptId: detail.discoveredFromReceiptId, evidenceReceiptId: receipt?.receiptId ?? null,
    });
    report.frontier.push({ operation: 'observed_consumer_product_detail_GET', url: detail.url,
      sourceText: detail.text, state: page.ok ? 'read' : page.stopReason, retry: false,
      ...(receipt?.receiptId ? { evidenceReceiptId: receipt.receiptId } : {}) });
    if (page.blocked || [401, 403, 418, 429].includes(Number(page.status)) || /CHALLENGE/i.test(page.stopReason ?? '')) {
      report.blocked = true;
      report.frontier.at(-1).stopHost = true;
      stopHost = true;
      break;
    }
    if (page.ok) {
      const schemaRecords = extraction.records.map(publicRecordFromSchema);
      const embeddedRecords = collectEmbeddedProductCandidates(extraction, page, receipt?.receiptId ?? null);
      report.records.push(...schemaRecords, ...embeddedRecords);
      pageHtmls.push({ page, extraction, receipt });
    }
  }

  if (!stopHost) {
    for (const resource of [...observedResources.values()].slice(0, MAX_RESOURCE_READS)) {
      if (resourceReads >= MAX_RESOURCE_READS || visited.has(resource.url)) continue;
      visited.add(resource.url);
      const result = await readPublicResource(resource.url, { allowedHosts: OBSERVED_RESOURCE_HOSTS, maxRedirects: 2,
        maxBytes: MAX_RESOURCE_BYTES, timeoutMs: 20_000 });
      const receipt = receiptFromPage(result, 'observed_public_page_script_GET');
      if (receipt) report.receipts.push(receipt);
      resourceReads += 1;
      const routes = result.ok && typeof result.body === 'string'
        ? inspectProductApiRouteLiterals(result.body, result.url, receipt?.receiptId ?? null) : [];
      report.contracts.push({ operation: 'observed_public_page_script_GET', method: 'GET', requestUrl: resource.url,
        finalUrl: safeUrl(result.url), status: result.status ?? null, mime: result.contentType ?? null,
        observedAt: receipt?.checkedAt ?? null, browserUsed: false, cookiesSent: false, authorizationSent: false,
        publicClientHeaderSent: false, stopReason: result.stopReason ?? null, bodyExecuted: false,
        routeLiteralCount: routes.length, routeLiterals: routes, evidenceReceiptId: receipt?.receiptId ?? null,
        discoveredFromReceiptId: resource.discoveredFromReceiptId });
      report.frontier.push({ operation: 'observed_public_page_script_GET', url: resource.url,
        state: result.ok ? 'read_static_only' : result.stopReason, retry: false,
        ...(receipt?.receiptId ? { evidenceReceiptId: receipt.receiptId } : {}) });
      if (result.blocked || [401, 403, 418, 429].includes(Number(result.status)) || /CHALLENGE/i.test(result.stopReason ?? '')) {
        report.blocked = true;
        report.frontier.at(-1).stopHost = true;
        stopHost = true;
        break;
      }
    }
  }

  for (const pageRow of pageHtmls) {
    const { page, extraction, receipt } = pageRow;
    const scripts = observedScriptResources(page.html, page.url);
    report.frontier.push({ operation: 'observed_script_source_inventory', sourceUrl: safeUrl(page.url),
      scriptCount: scripts.length, scriptUrls: scripts.slice(0, 30), evidenceReceiptId: receipt?.receiptId ?? null });
  }
  const deduped = new Map();
  for (const record of report.records) {
    if (!record.title || !record.url || !record.evidence?.length) continue;
    deduped.set(`${record.sourceLocalId ?? ''}|${record.url}|${record.title}`, record);
  }
  report.records = [...deduped.values()];
  const pageContracts = report.contracts.filter(item => item.operation === 'anonymous_public_category_GET');
  const detailContracts = report.contracts.filter(item => item.operation === 'observed_consumer_product_detail_GET');
  const scriptContracts = report.contracts.filter(item => item.operation === 'observed_public_page_script_GET');
  report.operations = {
    publicCategoryPages: { state: pageContracts.some(item => item.status === 200) ? 'live_replay' : 'blocked_or_not_observed', count: pageContracts.length,
      evidenceReceiptIds: pageContracts.map(item => item.evidenceReceiptId).filter(Boolean) },
    productOrServiceRecord: { state: report.records.length ? 'live_replay' : 'not_observed', recordCount: report.records.length,
      evidenceReceiptIds: [...new Set(report.records.flatMap(item => item.evidence.map(e => e.receiptId)).filter(Boolean))] },
    productDetail: { state: detailContracts.some(item => item.status === 200 && item.jsonLdBlocks > 0) ? 'live_replay' : detailContracts.some(item => item.status === 200) ? 'detail_html_read_no_schema_record' : 'not_observed',
      evidenceReceiptIds: detailContracts.map(item => item.evidenceReceiptId).filter(Boolean) },
    price: { state: report.records.some(item => item.price?.amount != null) ? 'live_replay' : 'not_observed',
      recordCount: report.records.filter(item => item.price?.amount != null).length,
      evidenceReceiptIds: [...new Set(report.records.filter(item => item.price?.amount != null).flatMap(item => item.evidence.map(e => e.receiptId)).filter(Boolean))] },
    ratingSummary: { state: report.records.some(item => item.rating?.value != null || item.rating?.ratingCount != null) ? 'live_replay' : 'not_observed',
      recordCount: report.records.filter(item => item.rating?.value != null || item.rating?.ratingCount != null).length },
    variants: { state: report.records.some(item => item.variants?.length) ? 'live_replay' : 'not_observed' },
    reviewSamples: { state: report.records.some(item => item.reviewSamples?.length) ? 'live_replay' : 'not_observed',
      sampleCount: report.records.reduce((sum, item) => sum + (item.reviewSamples?.length ?? 0), 0) },
    publicScriptSource: { state: scriptContracts.some(item => item.status === 200) ? 'static_inspection_only' : 'not_observed',
      evidenceReceiptIds: scriptContracts.map(item => item.evidenceReceiptId).filter(Boolean) },
  };
  report.status = report.blocked ? 'blocked_stopped' : report.records.length ? 'ontology_records_observed' : 'reachable_no_public_product_record';
  report.frontier.push(...(pageQueue.map(item => ({ operation: item.kind, url: safeUrl(item.url), state: 'not_read_budget_exhausted', retry: false }))));
  return save(report);
}

function save(report) {
  if (!existsSync(path.dirname(RESULT_PATH))) mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  const existing = readJson(RESULT_PATH);
  if (existing?.merchantId === report.merchantId && existing !== report) {
    const uniqueRows = (rows, keyOf) => [...new Map((rows ?? []).map(row => [keyOf(row), row])).values()];
    report.receipts = uniqueRows([...(existing.receipts ?? []), ...(report.receipts ?? [])], row => row.receiptId ?? JSON.stringify(row));
    report.contracts = uniqueRows([...(existing.contracts ?? []), ...(report.contracts ?? [])], row =>
      row.evidenceReceiptId ? `${row.operation}|${row.evidenceReceiptId}` : JSON.stringify(row));
    const records = new Map();
    for (const row of [...(existing.records ?? []), ...(report.records ?? [])]) {
      const identity = `${row.sourceLocalId ?? ''}|${row.url ?? ''}|${row.title ?? ''}`;
      const prior = records.get(identity);
      records.set(identity, prior ? { ...prior, ...row,
        evidence: uniqueRows([...(prior.evidence ?? []), ...(row.evidence ?? [])], item => `${item.receiptId}|${item.locator}`) } : row);
    }
    report.records = [...records.values()];
    report.frontier = uniqueRows([...(existing.frontier ?? []), ...(report.frontier ?? [])], row =>
      `${row.operation ?? ''}|${row.url ?? ''}|${row.state ?? ''}|${row.evidenceReceiptId ?? ''}|${row.sourceUrl ?? ''}`);
  }
  const tempPath = `${RESULT_PATH}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  renameSync(tempPath, RESULT_PATH);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  collectLenovoPublic({ inspectRawJsonLdLinks: process.argv.includes('--inspect-raw-jsonld-links') })
    .catch(error => { process.stderr.write(`${error.code ?? error.message}\n`); process.exitCode = 1; });
}
