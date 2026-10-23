import { randomUUID } from 'node:crypto';
import { parseFragment } from 'parse5';
import { extractPublicPage, readPublicPage, readPublicResource, safeUrl, textContent, isStrongPublicChallenge } from '../../lib/cps-public-reader.mjs';

const HOMEPAGE_URL = 'https://www.mytheresa.com/';
const ALLOWED_HOSTS = ['mytheresa.com'];
const MAX_PAGE_BYTES = 6 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_CATEGORY_PAGES = 2;
const MAX_PRODUCT_PAGES = 2;
const MAX_PAGE_READS = 5;

function normalizedHost(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return null; }
}

function samePublicHost(value) {
  return normalizedHost(value) === 'mytheresa.com';
}

function pageReceipt(page, kind) {
  const receipt = page?.receipt ?? {};
  return {
    id: receipt.id ?? randomUUID(),
    requestMethod: receipt.requestMethod ?? 'GET',
    requestUrl: safeUrl(receipt.requestUrl ?? page?.url),
    finalUrl: safeUrl(page?.url),
    responseStatus: Number.isInteger(page?.status) ? page.status : Number.isInteger(receipt.responseStatus) ? receipt.responseStatus : null,
    contentType: page?.contentType ?? receipt.contentType ?? null,
    bytes: receipt.bytes ?? 0,
    responseSha256: receipt.responseSha256 ?? null,
    observedAt: receipt.observedAt ?? null,
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    secureTransport: String(receipt.requestUrl ?? page?.url ?? '').startsWith('https://'),
    ...(page?.blocked ? { blocked: true, retry: false } : {}),
    ...(page?.stopReason ? { stopReason: page.stopReason } : {}),
    kind,
  };
}

function scriptUrls(html, baseUrl) {
  const output = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(['"])(.*?)\1[^>]*>/gi)) {
    const url = safeUrl(match[2], baseUrl);
    if (url && samePublicHost(url) && url.startsWith('https://')) output.push(url);
  }
  return [...new Set(output)];
}

function anchorsFromHtml(html, baseUrl) {
  let root;
  try { root = parseFragment(html); }
  catch { return []; }
  const anchors = [];
  const visit = node => {
    if (node?.tagName === 'a') {
      const href = node.attrs?.find(attribute => attribute.name === 'href')?.value;
      const url = safeUrl(href, baseUrl);
      if (url && samePublicHost(url) && url.startsWith('https://')) {
        anchors.push({ url, text: textContent(node, 300) });
      }
    }
    for (const child of node?.childNodes ?? []) visit(child);
  };
  visit(root);
  return [...new Map(anchors.map(row => [row.url, row])).values()];
}

function classifyObservedAnchor(anchor) {
  let url;
  try { url = new URL(anchor.url); }
  catch { return null; }
  const words = `${anchor.text ?? ''} ${url.pathname} ${url.search}`.toLowerCase();
  if (/(?:^|[^a-z])(?:product|item|goods|sku|pdp|detail)(?:[^a-z]|$)|(?:product_id|item_id|sku)=/i.test(words)) {
    return { ...anchor, kind: 'product_detail' };
  }
  if (/(?:^|[^a-z])(?:women|woman|men|man|kids|clothing|shoes|bags|designer|designers|new arrivals|sale|beauty|accessories|여성|남성|아동|의류|신발|가방|디자이너|신상품|세일|뷰티)(?:[^a-z]|$)/i.test(words)) {
    return { ...anchor, kind: 'category' };
  }
  return null;
}

function inspectScriptWithoutExecution(source, scriptUrl) {
  const declarations = new Map();
  const declarationPattern = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(https?:\/\/[^"']+|\/[A-Za-z0-9_./?=&%-]+)\2/g;
  for (const match of source.matchAll(declarationPattern)) declarations.set(match[1], match[3]);
  const calls = [...source.matchAll(/\.open\(\s*(["'])(GET|POST|PUT|PATCH|DELETE)\1\s*,\s*([A-Za-z_$][\w$]*|["'][^"']+["'])/gi)];
  let firstParty = 0;
  let crossOrigin = 0;
  let unresolved = 0;
  const methods = new Set();
  for (const match of calls) {
    methods.add(match[2].toUpperCase());
    const rawTarget = match[3].startsWith('"') || match[3].startsWith("'")
      ? match[3].slice(1, -1) : declarations.get(match[3]);
    if (!rawTarget) { unresolved += 1; continue; }
    try {
      const target = new URL(rawTarget, scriptUrl);
      if (samePublicHost(target.href)) firstParty += 1;
      else crossOrigin += 1;
    } catch { unresolved += 1; }
  }
  return {
    executed: false,
    bodyPersisted: false,
    xhrCallsiteCount: calls.length,
    xhrMethods: [...methods],
    firstPartyXhrCallsiteCount: firstParty,
    crossOriginXhrCallsiteCount: crossOrigin,
    unresolvedXhrCallsiteCount: unresolved,
    firstPartyCatalogRequestObserved: false,
    publicCatalogContractObserved: false,
    observedStaticPathMention: source.includes('/search/') ? '/search/' : null,
    pathMentionUsedAsRequest: false,
    note: 'Static inspection only; cross-origin XHR callsites were not followed and no first-party catalog request contract was established.',
  };
}

function isStopForOrigin(page) {
  return Boolean(page?.blocked)
    || [401, 403, 418, 429].includes(Number(page?.status))
    || (typeof page?.html === 'string' && isStrongPublicChallenge(page.headers ?? {}, page.html))
    || (typeof page?.body === 'string' && isStrongPublicChallenge(page.headers ?? {}, page.body));
}

function uniqueRecords(records) {
  const output = [];
  const seen = new Set();
  for (const record of records) {
    if (!record?.title || !record?.type) continue;
    const key = `${record.sourceLocalId ?? ''}\0${record.url ?? ''}\0${record.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(record);
  }
  return output;
}

function operation(state, evidenceReceiptIds = [], note = null, extra = {}) {
  return { state, evidenceReceiptIds: [...new Set(evidenceReceiptIds.filter(Boolean))], ...(note ? { note } : {}), ...extra };
}

function fieldCounts(records) {
  return {
    productRecords: records.length,
    recordsWithId: records.filter(record => record.sourceLocalId != null).length,
    recordsWithType: records.filter(record => record.type != null).length,
    recordsWithTitle: records.filter(record => record.title != null).length,
    recordsWithPrice: records.filter(record => record.price?.amount != null || record.price?.priceText != null).length,
    recordsWithRatingSummary: records.filter(record => record.rating && (record.rating.value != null || record.rating.reviewCount != null || record.rating.ratingCount != null)).length,
    recordsWithReviewSamples: records.filter(record => (record.reviewSamples ?? []).length > 0).length,
    recordsWithOptions: records.filter(record => (record.variants ?? []).length > 0).length,
  };
}

function currenciesFor(records) {
  return [...new Set(records.map(record => record.price?.currency).filter(value => typeof value === 'string' && /^[A-Z]{3}$/.test(value)))].sort();
}

/** Collect only publicly linked Mytheresa HTML and same-origin static resources; never executes scripts. */
export async function collectMytheresaPublic() {
  const checkedAt = new Date().toISOString();
  const receipts = [];
  const records = [];
  const contracts = [];
  const frontier = [];
  const report = {
    schemaVersion: 1,
    merchantId: 'mytheresa',
    merchantName: '마이테레사',
    siteUrl: HOMEPAGE_URL,
    verticalHint: 'fashion',
    checkedAt,
    transport: { browserUsed: false, cookiesSent: false, authorizationSent: false, authenticated: false },
    receipts,
    records,
    contracts,
    frontier,
    operations: {},
    sourceCurrency: { state: 'not_observed', currency: null, observedCurrencies: [] },
    observedCounts: {
      pageReads: 0, linkedScripts: 0, observedNavigationAnchors: 0, observedCategoryLinks: 0,
      observedProductLinks: 0, catalogTotal: null, productRecords: 0, recordsWithId: 0,
      recordsWithType: 0, recordsWithTitle: 0, recordsWithPrice: 0,
      recordsWithRatingSummary: 0, recordsWithReviewSamples: 0, recordsWithOptions: 0,
    },
    blocked: false,
    status: 'attempt_without_response',
  };

  let stopOrigin = false;
  let pageReadCount = 0;
  let productPagesRead = 0;
  const visited = new Set();
  const categoryQueue = [];
  const productQueue = [];

  async function readPage(url, kind, discoveredFromReceiptId = null) {
    if (pageReadCount >= MAX_PAGE_READS || visited.has(url) || stopOrigin) return null;
    visited.add(url);
    pageReadCount += 1;
    const page = await readPublicPage(url, {
      allowedHosts: ALLOWED_HOSTS,
      maxRedirects: 3,
      maxBytes: MAX_PAGE_BYTES,
      timeoutMs: TIMEOUT_MS,
    });
    const receipt = pageReceipt(page, kind);
    receipts.push(receipt);
    const extraction = page.ok
      ? extractPublicPage(page, { merchantId: 'mytheresa', typeHint: 'fashion' })
      : { title: null, description: null, links: [], forms: [], jsonLd: [], embeddedJson: [], records: [] };
    const anchors = page.ok ? anchorsFromHtml(page.html, page.url) : [];
    const rawCandidates = anchors.map(classifyObservedAnchor).filter(Boolean);
    const categoryLinks = rawCandidates.filter(item => item.kind === 'category');
    const productLinks = rawCandidates.filter(item => item.kind === 'product_detail');
    const observedAt = receipt.observedAt;
    contracts.push({
      operation: kind,
      requestUrl: safeUrl(url),
      finalUrl: safeUrl(page.url),
      status: page.status ?? null,
      contentType: page.contentType ?? null,
      observedAt,
      browserUsed: false,
      cookiesSent: false,
      authorizationSent: false,
      secureTransport: true,
      stopReason: page.stopReason ?? null,
      title: extraction.title,
      jsonLdBlocks: extraction.jsonLd.length,
      embeddedJsonBlocks: extraction.embeddedJson.length,
      formCount: extraction.forms.length,
      observedAnchorCount: anchors.length,
      observedCategoryLinkCount: categoryLinks.length,
      observedProductLinkCount: productLinks.length,
      offeringRecordCount: extraction.records.length,
      evidenceReceiptId: receipt.id,
      ...(discoveredFromReceiptId ? { discoveredFromReceiptId } : {}),
    });
    records.push(...extraction.records);
    frontier.push({
      operation: kind,
      url: safeUrl(url),
      state: page.ok ? 'read' : page.blocked ? 'blocked' : 'attempt_without_response',
      retry: false,
      evidenceReceiptId: receipt.id,
      discoveredFromReceiptId,
      observedCounts: {
        jsonLdBlocks: extraction.jsonLd.length,
        embeddedJsonBlocks: extraction.embeddedJson.length,
        observedAnchors: anchors.length,
        categoryLinks: categoryLinks.length,
        productLinks: productLinks.length,
        offeringRecords: extraction.records.length,
      },
      ...(page.stopReason ? { stopReason: page.stopReason } : {}),
    });
    if (isStopForOrigin(page)) stopOrigin = true;
    categoryQueue.push(...categoryLinks);
    productQueue.push(...productLinks);
    return { page, extraction, receipt, anchors, categoryLinks, productLinks };
  }

  const home = await readPage(HOMEPAGE_URL, 'anonymous_homepage_GET');
  if (!home || stopOrigin || !home.page.ok) {
    report.blocked = stopOrigin;
    report.observedCounts.pageReads = pageReadCount;
    report.operations = {
      publicPageRead: operation(stopOrigin ? 'blocked_stop' : 'attempt_without_response', home ? [home.receipt.id] : [], home?.page.stopReason ?? 'Homepage was not readable.'),
      productSearch: operation('not_observed', [], 'No catalog request was attempted.'),
      productDetail: operation('not_observed', [], 'No product detail page was publicly linked and read.'),
      price: operation('not_observed'), ratingSummary: operation('not_observed'),
      reviewsList: operation('not_observed'), productOptions: operation('not_observed'),
    };
    report.observedCounts = { ...report.observedCounts, pageReads: pageReadCount };
    report.status = stopOrigin ? 'blocked_stopped' : 'attempt_without_response';
    return report;
  }

  const linkedScripts = scriptUrls(home.page.html, home.page.url);
  report.observedCounts.observedNavigationAnchors = home.anchors.length;
  report.observedCounts.observedCategoryLinks = home.categoryLinks.length;
  report.observedCounts.observedProductLinks = home.productLinks.length;
  const scriptFrontier = [];
  for (const url of linkedScripts.slice(0, 3)) {
    if (stopOrigin) break;
    const resource = await readPublicResource(url, {
      allowedHosts: ALLOWED_HOSTS,
      maxRedirects: 3,
      maxBytes: MAX_SCRIPT_BYTES,
      timeoutMs: TIMEOUT_MS,
    });
    const receipt = pageReceipt(resource, 'observed_same_origin_script_GET');
    receipts.push(receipt);
    const inspection = resource.ok && typeof resource.body === 'string'
      ? inspectScriptWithoutExecution(resource.body, resource.url ?? url)
      : null;
    contracts.push({
      operation: 'observed_same_origin_script_GET',
      requestUrl: safeUrl(url),
      finalUrl: safeUrl(resource.url),
      status: resource.status ?? null,
      contentType: resource.contentType ?? null,
      observedAt: receipt.observedAt,
      browserUsed: false,
      cookiesSent: false,
      authorizationSent: false,
      secureTransport: true,
      stopReason: resource.stopReason ?? null,
      bodyPersisted: false,
      evidenceReceiptId: receipt.id,
      ...(inspection ? { staticInspection: inspection } : {}),
    });
    scriptFrontier.push({
      operation: 'observed_same_origin_script_GET',
      url: safeUrl(url),
      state: resource.ok ? 'read_static_only' : resource.blocked ? 'blocked' : 'attempt_without_response',
      retry: false,
      evidenceReceiptId: receipt.id,
      ...(resource.stopReason ? { stopReason: resource.stopReason } : {}),
      ...(inspection ? { staticInspection: inspection } : {}),
    });
    frontier.push(scriptFrontier.at(-1));
    if (resource.blocked || [401, 403, 418, 429].includes(Number(resource.status))) stopOrigin = true;
  }
  report.observedCounts.linkedScripts = scriptFrontier.length;

  const readProductPage = async (candidate, fromReceiptId) => {
    if (productPagesRead >= MAX_PRODUCT_PAGES || stopOrigin || pageReadCount >= MAX_PAGE_READS) return;
    productPagesRead += 1;
    await readPage(candidate.url, 'observed_linked_product_page_GET', fromReceiptId);
  };

  if (!stopOrigin) {
    for (const candidate of categoryQueue.slice(0, MAX_CATEGORY_PAGES)) {
      if (stopOrigin || pageReadCount >= MAX_PAGE_READS) break;
      const category = await readPage(candidate.url, 'observed_linked_category_GET', home.receipt.id);
      if (!category || stopOrigin) break;
      for (const product of category.productLinks) {
        if (stopOrigin || productQueue.filter(item => item.selected).length >= MAX_PRODUCT_PAGES) break;
        if (!productQueue.some(item => item.url === product.url && item.selected)) {
          product.selected = true;
          product.discoveredFromReceiptId = category.receipt.id;
        }
      }
    }
    const productCandidates = [...new Map(
      [...productQueue.filter(item => !item.selected), ...productQueue.filter(item => item.selected)]
        .map(item => [item.url, item]),
    ).values()].slice(0, MAX_PRODUCT_PAGES);
    for (const candidate of productCandidates) {
      if (stopOrigin || pageReadCount >= MAX_PAGE_READS) break;
      const fromReceiptId = candidate.discoveredFromReceiptId ?? home.receipt.id;
      await readProductPage(candidate, fromReceiptId);
    }
  }

  const normalizedRecords = uniqueRecords(records);
  report.records = normalizedRecords;
  const counts = fieldCounts(normalizedRecords);
  const currencies = currenciesFor(normalizedRecords);
  report.observedCounts = {
    ...report.observedCounts,
    pageReads: pageReadCount,
    catalogTotal: null,
    ...counts,
  };
  report.sourceCurrency = {
    state: currencies.length ? (currencies.length === 1 ? 'observed' : 'multiple_observed') : 'not_observed',
    currency: currencies.length === 1 ? currencies[0] : null,
    observedCurrencies: currencies,
  };
  const recordReceiptIds = normalizedRecords.flatMap(record => (record.evidence ?? []).map(item => item.receiptId));
  const priceRecords = normalizedRecords.filter(record => record.price?.amount != null || record.price?.priceText != null);
  const ratingRecords = normalizedRecords.filter(record => record.rating && (record.rating.value != null || record.rating.reviewCount != null || record.rating.ratingCount != null));
  const reviewRecords = normalizedRecords.filter(record => (record.reviewSamples ?? []).length > 0);
  const optionRecords = normalizedRecords.filter(record => (record.variants ?? []).length > 0);
  const searchContractObserved = contracts.some(contract => contract.operation === 'observed_search_form_or_catalog_api' && contract.status && contract.status < 400);
  const staticInspection = contracts.find(contract => contract.staticInspection)?.staticInspection;
  const discoveryIds = contracts.filter(contract => contract.operation === 'anonymous_homepage_GET' || contract.operation.startsWith('observed_same_origin_script_GET'))
    .map(contract => contract.evidenceReceiptId).filter(Boolean);

  report.operations = {
    publicPageRead: operation(stopOrigin ? 'blocked_stop' : 'live_replay', discoveryIds, stopOrigin ? 'Stopped further reads after an origin access block or challenge.' : null),
    publicCatalogNavigation: operation(home.categoryLinks.length || home.productLinks.length ? 'observed_link_candidates' : 'no_public_product_or_category_anchors_observed', [home.receipt.id], null, {
      categoryLinkCount: home.categoryLinks.length,
      productLinkCount: home.productLinks.length,
    }),
    productSearch: operation(searchContractObserved ? 'live_replay' : 'catalog_contract_not_observed_in_public_bootstrap', discoveryIds, staticInspection?.firstPartyXhrCallsiteCount === 0
      ? 'Page-linked script inspection found no first-party XHR callsite. Its cross-origin XHRs were not followed; the static /search/ string was not treated as a request.'
      : 'No public catalog form or exact first-party search request was observed.'),
    productOrServiceRecord: operation(normalizedRecords.length ? 'live_replay' : 'not_observed', recordReceiptIds, normalizedRecords.length ? null : 'No page-linked product offering data was observed.' , { recordCount: normalizedRecords.length }),
    price: operation(priceRecords.length ? 'live_replay' : 'not_observed', priceRecords.flatMap(record => (record.evidence ?? []).map(item => item.receiptId)), null, { recordCount: priceRecords.length }),
    ratingSummary: operation(ratingRecords.length ? 'live_replay' : 'not_observed', ratingRecords.flatMap(record => (record.evidence ?? []).map(item => item.receiptId)), null, { recordCount: ratingRecords.length }),
    reviewsList: operation(reviewRecords.length ? 'partial_schema_samples' : 'not_observed', reviewRecords.flatMap(record => (record.evidence ?? []).map(item => item.receiptId)), null, { sampleCount: reviewRecords.reduce((sum, record) => sum + record.reviewSamples.length, 0), complete: false }),
    productOptions: operation(optionRecords.length ? 'variant_schema_observed' : 'not_observed', optionRecords.flatMap(record => (record.evidence ?? []).map(item => item.receiptId)), null, { variantCount: optionRecords.reduce((sum, record) => sum + record.variants.length, 0) }),
  };
  for (const candidate of categoryQueue.slice(MAX_CATEGORY_PAGES)) {
    frontier.push({ operation: 'observed_linked_category_GET', url: candidate.url, state: 'pending_budget_frontier', retry: false, discoveredFromReceiptId: home.receipt.id });
  }
  report.blocked = stopOrigin;
  report.status = stopOrigin ? 'blocked_stopped' : normalizedRecords.length ? 'reachable_with_ontology_records' : 'reachable_without_offering_record';
  return report;
}
