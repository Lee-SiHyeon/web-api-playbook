import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';
import {
  extractPublicPage,
  readPublicPage,
  readPublicResource,
  safeUrl,
} from '../../lib/cps-public-reader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB_ROOT = path.resolve(HERE, '../..');
const SOURCE_MAP_FILE = path.join(HUB_ROOT, 'references/linkprice-cps-source-map-2026-09-27.json');
const SUPPLEMENT_FILE = path.join(HUB_ROOT, 'references/cps-reverify/naver-shopping-public-supplement.json');

const SITE_URL = 'https://shopping.naver.com/';
const HOME_URL = 'https://shopping.naver.com/ns/home';
const HOME_LAYOUT_URL = 'https://vertical-api.shopping.naver.com/v3/web/v1/home/layouts';
const PRODUCT_HOSTS = ['shopping.naver.com', 'smartstore.naver.com', 'brand.naver.com'];

// This receipt is retained as a stop boundary. The adapter never retries or
// follows another smartstore product link after this observed 429.
const SMARTSTORE_DETAIL_STOP = Object.freeze({
  id: '304b189a-f2b2-4cab-b6f4-a77e8a9431db',
  requestMethod: 'GET',
  requestUrl: 'https://smartstore.naver.com/inflow/outlink/product?p=13269057589&tr=tdl',
  responseStatus: 429,
  contentType: 'text/html',
  bytes: 0,
  responseSha256: null,
  observedAt: '2026-09-27T10:38:54.028Z',
  browserUsed: false,
  cookiesSent: false,
  authorizationSent: false,
  stopReason: 'HTTP_ACCESS_BLOCKED',
  historicalObservation: true,
});

export const merchantIds = Object.freeze(['nbtnaver']);

function savedMerchantEvidence() {
  try {
    const sourceMap = JSON.parse(readFileSync(SOURCE_MAP_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return sourceMap.merchants.find(row => row.affiliateProgram?.merchantId === 'nbtnaver') ?? null;
  } catch {
    return null;
  }
}

function addReceipt(report, result, phase) {
  if (!result?.receipt) return null;
  const receipt = {
    ...result.receipt,
    checkedAt: result.receipt.observedAt ?? new Date().toISOString(),
    phase,
    stopReason: result.stopReason ?? null,
    blocked: result.blocked === true,
  };
  report.receipts.push(receipt);
  return receipt;
}

function findNextData(html) {
  let parsed = null;
  const root = parseFragment(html);
  const visit = node => {
    if (parsed) return;
    if (node?.tagName === 'script' && node.attrs?.some(attribute => attribute.name === 'id' && attribute.value === '__NEXT_DATA__')) {
      const source = (node.childNodes ?? []).map(child => child.value ?? '').join('');
      try { parsed = JSON.parse(source); } catch { parsed = null; }
      return;
    }
    for (const child of node?.childNodes ?? []) visit(child);
  };
  visit(root);
  return parsed;
}

function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function productOutlinks(links) {
  const byProductId = new Map();
  for (const link of links ?? []) {
    const safe = safeUrl(link.url);
    if (!safe) continue;
    try {
      const url = new URL(safe);
      if (url.hostname !== 'smartstore.naver.com' || !url.pathname.startsWith('/inflow/outlink/product')) continue;
      const productId = url.searchParams.get('p');
      if (productId && /^\d+$/.test(productId)) byProductId.set(productId, safe);
    } catch { /* Ignore malformed observed links. */ }
  }
  return byProductId;
}

function promotionRecords(nextData, links, receiptId) {
  const layers = nextData?.props?.pageProps?.waffleData?.pageData?.layers;
  if (!Array.isArray(layers)) return [];

  const outlinks = productOutlinks(links);
  const rows = [];
  let visited = 0;
  const walk = (value, locator, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 16 || visited >= 30_000) return;
    visited += 1;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length && index < 500; index += 1) {
        walk(value[index], `${locator}[${index}]`, depth + 1);
      }
      return;
    }

    const productId = value.productId == null ? null : String(value.productId);
    const title = typeof value.name === 'string' ? value.name.trim() : null;
    const outlink = productId ? outlinks.get(productId) : null;
    if (productId && /^\d+$/.test(productId) && title && title !== '[TRUNCATED]' && outlink) {
      const amount = numeric(value.dispDiscountedPrice)
        ?? numeric(value.discountedPrice)
        ?? numeric(value.dispSalePrice)
        ?? numeric(value.salePrice);
      const reviewCount = numeric(value.totalReviewCount);
      const averageReviewScore = numeric(value.averageReviewScore);
      const landingUrl = safeUrl(value.landingUrl);
      let recordUrl = outlink;
      if (landingUrl) {
        try {
          const detail = new URL(landingUrl);
          if (detail.hostname === 'smartstore.naver.com' && detail.pathname.endsWith(`/products/${productId}`)) {
            recordUrl = landingUrl;
          }
        } catch { /* Preserve the observed outlink when the embedded landing URL is malformed. */ }
      }

      const fields = ['sourceLocalId', 'title', 'url'];
      if (amount != null) fields.push('price.amount', 'price');
      if (reviewCount != null) fields.push('rating.reviewCount', 'rating');
      const hasRatedReviews = (reviewCount ?? 0) > 0 && averageReviewScore != null;
      if (hasRatedReviews) fields.push('rating.value', 'rating');

      rows.push({
        type: 'RetailProduct',
        sourceLocalId: productId,
        title,
        url: recordUrl,
        description: null,
        brand: null,
        price: {
          amount,
          currency: null,
          priceText: null,
        },
        rating: {
          value: hasRatedReviews ? averageReviewScore : null,
          best: null,
          worst: null,
          reviewCount,
          ratingCount: null,
        },
        variants: [],
        reviewSamples: [],
        evidence: [
          {
            receiptId,
            locator: `script#__NEXT_DATA__${locator}.{productId,name,dispDiscountedPrice,discountedPrice,averageReviewScore,totalReviewCount}`,
            fields,
          },
          {
            receiptId,
            locator: `script#__NEXT_DATA__${locator}.landingUrl; productId matched to DOM a[href*="/inflow/outlink/product"]?p=${productId}`,
            fields: ['url'],
          },
        ],
      });
    }

    for (const [key, child] of Object.entries(value)) {
      if (/cookie|token|session|auth|password|email|phone|account|reviewer|author/i.test(key)) continue;
      walk(child, `${locator}.${key}`, depth + 1);
    }
  };

  walk(layers, '$.props.pageProps.waffleData.pageData.layers');
  return rows;
}

function operation(state, receiptIds = [], extra = {}) {
  return {
    state,
    captured: false,
    clientExists: false,
    remnantFree: true,
    credentialPropagated: null,
    liveReplay: false,
    evidenceReceiptIds: receiptIds,
    ...extra,
  };
}

/**
 * Collect the anonymous, server-delivered public promotion cards for Naver
 * Shopping. It deliberately does not call saved rejected search/review
 * contracts or a smartstore product-detail host that returned HTTP 429.
 */
export async function collectMerchant(merchantId, options = {}) {
  if (!merchantIds.includes(merchantId)) {
    throw Object.assign(new Error('MERCHANT_NOT_IN_NAVER_SHOPPING_PUBLIC'), { code: 'MERCHANT_NOT_IN_NAVER_SHOPPING_PUBLIC' });
  }

  const report = {
    merchantId,
    siteUrl: SITE_URL,
    receipts: [{ ...SMARTSTORE_DETAIL_STOP }],
    records: [],
    contracts: [],
    operations: {},
    frontier: [],
    status: 'not_started',
    browserUsed: false,
    credentialsUsed: false,
  };
  const readOptions = {
    maxRedirects: options.maxRedirects ?? 3,
    maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 20_000,
  };

  const home = await readPublicPage(HOME_URL, { ...readOptions, allowedHosts: ['shopping.naver.com'] });
  const homeReceipt = addReceipt(report, home, 'public_home_document');
  if (!home.ok) {
    report.operations = {
      public_home_document: operation(home.blocked ? 'blocked_http' : 'transport_or_mime_failure', homeReceipt ? [homeReceipt.id] : [], {
        clientExists: true,
        liveReplay: false,
        stopReason: home.stopReason,
        responseStatus: home.status,
      }),
      product_search: operation('blocked_prior_http_418'),
      product_detail: operation('blocked_http_429', [SMARTSTORE_DETAIL_STOP.id]),
      price: operation('not_exposed'),
      rating_summary: operation('not_exposed'),
      reviews_list: operation('blocked_prior_http_rejection'),
    };
    report.frontier.push({ operation: 'public_home_document', state: home.stopReason ?? 'failed', noRetry: home.blocked === true });
    report.status = home.blocked ? 'blocked_home_host' : 'home_read_failed';
    return report;
  }

  const homePage = extractPublicPage(home, { merchantId, typeHint: 'RetailProduct' });
  report.contracts.push({
    operation: 'public_home_document',
    state: 'live_replay_verified',
    receiptId: homeReceipt?.id ?? null,
    requestedUrl: HOME_URL,
    finalUrl: home.url,
    title: homePage.title,
    jsonLdTypes: homePage.jsonLd.map(row => row?.['@type'] ?? null).filter(Boolean),
    recordCount: homePage.records.length,
    parser: 'shared_public_page_extractor',
  });

  const layout = await readPublicResource(HOME_LAYOUT_URL, { ...readOptions, allowedHosts: ['shopping.naver.com'] });
  const layoutReceipt = addReceipt(report, layout, 'observed_home_layout_json_get');
  let layoutRows = [];
  let layoutMimeValid = false;
  if (layout.ok && /^application\/json(?:\s*;|$)/i.test(layout.contentType ?? '')) {
    try {
      const parsed = JSON.parse(layout.body);
      if (Array.isArray(parsed)) {
        layoutRows = parsed;
        layoutMimeValid = true;
      }
    } catch { /* Keep only a bounded receipt when the source JSON is malformed. */ }
  }
  report.contracts.push({
    operation: 'observed_home_layout_json_get',
    state: layoutMimeValid ? 'live_replay_verified_metadata_only' : layout.blocked ? 'blocked_http' : 'response_unverified',
    receiptId: layoutReceipt?.id ?? null,
    requestedUrl: HOME_LAYOUT_URL,
    finalUrl: layout.url,
    contentType: layout.contentType,
    layoutCount: layoutRows.length,
    productRecordCount: 0,
    sourceContract: 'page-bundle GET /v3/web/v1/home/layouts; default call has no query parameters',
  });

  if (!layout.ok && layout.blocked) {
    report.operations = {
      public_home_document: operation('live_replay_verified', homeReceipt ? [homeReceipt.id] : [], { clientExists: true, liveReplay: true, recordCount: 0 }),
      home_layout: operation('blocked_http', layoutReceipt ? [layoutReceipt.id] : [], { clientExists: true, liveReplay: false, responseStatus: layout.status }),
      product_search: operation('blocked_prior_http_418'),
      product_detail: operation('blocked_http_429', [SMARTSTORE_DETAIL_STOP.id]),
      price: operation('not_reached_after_host_stop'),
      rating_summary: operation('not_reached_after_host_stop'),
      reviews_list: operation('blocked_prior_http_rejection'),
    };
    report.frontier.push({ operation: 'home_layout', state: 'blocked_http', responseStatus: layout.status, noRetry: true });
    report.status = 'blocked_home_layout_host';
    return report;
  }

  const promotionLink = homePage.links.find(link => {
    if (!link?.url || !String(link.text ?? '').includes('오늘끝딜')) return false;
    try {
      const url = new URL(link.url);
      return url.hostname === 'shopping.naver.com' && url.pathname === '/promotion';
    } catch { return false; }
  }) ?? homePage.links.find(link => {
    try { return new URL(link.url).hostname === 'shopping.naver.com' && new URL(link.url).pathname === '/promotion'; }
    catch { return false; }
  });

  if (!promotionLink?.url) {
    report.operations = {
      public_home_document: operation('live_replay_verified', homeReceipt ? [homeReceipt.id] : [], { clientExists: true, liveReplay: true, recordCount: 0 }),
      home_layout: operation(layoutMimeValid ? 'live_replay_verified_metadata_only' : 'response_unverified', layoutReceipt ? [layoutReceipt.id] : [], { clientExists: true, liveReplay: layoutMimeValid, layoutCount: layoutRows.length }),
      product_search: operation('blocked_prior_http_418'),
      product_detail: operation('blocked_http_429', [SMARTSTORE_DETAIL_STOP.id]),
      price: operation('not_exposed'),
      rating_summary: operation('not_exposed'),
      reviews_list: operation('blocked_prior_http_rejection'),
    };
    report.frontier.push({ operation: 'promotion_product_cards', state: 'homepage_did_not_expose_promotion_link' });
    report.status = 'reachable_no_observed_product_listing';
    return report;
  }

  const promotionUrl = safeUrl(promotionLink.url, home.url);
  const promotion = await readPublicPage(promotionUrl, { ...readOptions, allowedHosts: ['shopping.naver.com'] });
  const promotionReceipt = addReceipt(report, promotion, 'observed_promotion_product_document');
  if (!promotion.ok) {
    report.operations = {
      public_home_document: operation('live_replay_verified', homeReceipt ? [homeReceipt.id] : [], { clientExists: true, liveReplay: true, recordCount: 0 }),
      home_layout: operation(layoutMimeValid ? 'live_replay_verified_metadata_only' : 'response_unverified', layoutReceipt ? [layoutReceipt.id] : [], { clientExists: true, liveReplay: layoutMimeValid, layoutCount: layoutRows.length }),
      product_search: operation('blocked_prior_http_418'),
      product_detail: operation('blocked_http_429', [SMARTSTORE_DETAIL_STOP.id]),
      price: operation(promotion.blocked ? 'blocked_http' : 'not_reached', promotionReceipt ? [promotionReceipt.id] : [], { clientExists: true, responseStatus: promotion.status, liveReplay: false }),
      rating_summary: operation('not_reached', promotionReceipt ? [promotionReceipt.id] : []),
      reviews_list: operation('blocked_prior_http_rejection'),
    };
    report.frontier.push({ operation: 'promotion_product_cards', requestedUrl: promotionUrl, state: promotion.stopReason ?? 'failed', responseStatus: promotion.status, noRetry: promotion.blocked === true });
    report.status = promotion.blocked ? 'blocked_promotion_host' : 'promotion_read_failed';
    return report;
  }

  const promotionPage = extractPublicPage(promotion, { merchantId, typeHint: 'RetailProduct' });
  const nextData = findNextData(promotion.html);
  report.records = promotionRecords(nextData, promotionPage.links, promotionReceipt?.id ?? null);

  const sourceMapRow = savedMerchantEvidence();
  const savedSearchEvidence = sourceMapRow?.capabilityProfile?.product_search?.evidence?.evidence ?? null;
  const savedReviewEvidence = sourceMapRow?.capabilityProfile?.reviews_list?.evidence?.evidence ?? null;
  const detailId = SMARTSTORE_DETAIL_STOP.id;
  const homeLayoutCount = layoutMimeValid ? layoutRows.length : null;
  report.operations = {
    public_home_document: operation('live_replay_verified', homeReceipt ? [homeReceipt.id] : [], { clientExists: true, liveReplay: true, recordCount: 0 }),
    home_layout: operation(layoutMimeValid ? 'live_replay_verified_metadata_only' : 'response_unverified', layoutReceipt ? [layoutReceipt.id] : [], {
      clientExists: true,
      liveReplay: layoutMimeValid,
      layoutCount: homeLayoutCount,
      productRecordCount: 0,
    }),
    promotion_product_cards: operation(report.records.length ? 'live_replay_verified_listing_data' : 'live_replay_verified_no_records', promotionReceipt ? [promotionReceipt.id] : [], {
      clientExists: true,
      liveReplay: true,
      recordCount: report.records.length,
      parser: 'raw public __NEXT_DATA__ product cards cross-checked against observed DOM outlinks',
    }),
    product_search: operation('blocked_prior_http_418', [], {
      liveReplay: false,
      evidence: 'Saved consumer-source map records HTTP 418 on search.shopping.naver.com/search/all and earlier /ns/v1 search XHR. No retry performed.',
    }),
    product_detail: operation('blocked_http_429', [detailId], {
      liveReplay: false,
      responseStatus: 429,
      blockedHost: 'smartstore.naver.com',
      detailRequestsAttemptedThisRun: 0,
    }),
    price: operation(report.records.some(record => record.price.amount != null) ? 'live_replay_verified_listing_price_only' : 'not_exposed', promotionReceipt ? [promotionReceipt.id] : [], {
      clientExists: true,
      liveReplay: report.records.some(record => record.price.amount != null),
      recordCount: report.records.filter(record => record.price.amount != null).length,
      currency: null,
    }),
    rating_summary: operation(report.records.some(record => record.rating.value != null || record.rating.reviewCount != null) ? 'live_replay_verified_listing_summary_only' : 'not_exposed', promotionReceipt ? [promotionReceipt.id] : [], {
      clientExists: true,
      liveReplay: report.records.some(record => record.rating.value != null || record.rating.reviewCount != null),
      ratingCount: null,
      reviewBodiesCollected: false,
    }),
    reviews_list: operation('blocked_prior_http_rejection', [], {
      liveReplay: false,
      evidence: savedReviewEvidence ?? 'Saved source map records brand.naver.com query pages HTTP 429 and catalog reviews HTTP 418. No retry performed.',
    }),
    product_options: operation('not_captured'),
    graphql_product_query: operation('source_observed_not_replayed_no_observed_variables', [], {
      liveReplay: false,
      endpoint: 'https://shopping.naver.com/responsive/api/shopv/graphql',
      observedQuery: 'FetchPagedCurationProducts(panelId, contentId, listParam)',
      requiredInputsPresentInHomeLayout: false,
      note: 'No panelId/contentId/listParam tuple was present in the home layout response; no GraphQL payload was invented.',
    }),
  };

  report.contracts.push({
    operation: 'observed_promotion_product_document',
    state: 'live_replay_verified',
    receiptId: promotionReceipt?.id ?? null,
    requestedUrl: promotionUrl,
    finalUrl: promotion.url,
    title: promotionPage.title,
    jsonLdTypes: promotionPage.jsonLd.map(row => row?.['@type'] ?? null).filter(Boolean),
    rawNextDataPath: '$.props.pageProps.waffleData.pageData.layers[*].blocks[*].items[*].contents[*]',
    productCount: report.records.length,
    productFields: ['productId', 'name', 'dispDiscountedPrice', 'discountedPrice', 'averageReviewScore', 'totalReviewCount', 'landingUrl'],
    productDetailReplay: 'blocked_http_429_on_observed_smartstore_outlink',
  });

  report.frontier.push(
    { operation: 'product_search', state: 'blocked_prior_http_418', source: 'saved consumer-source map', noRetry: true },
    { operation: 'product_detail', state: 'blocked_http_429', host: 'smartstore.naver.com', receiptId: detailId, noRetry: true },
    { operation: 'reviews_list', state: 'blocked_prior_http_rejection', evidence: savedReviewEvidence, noRetry: true },
    { operation: 'graphql_product_query', state: 'not_replayed_missing_observed_variables', requiredInputs: ['panelId', 'contentId', 'listParam'], noGuessing: true },
  );
  report.status = report.records.length ? 'partial_listing_data_detail_blocked' : 'reachable_no_normalized_records';
  return report;
}

/** Collect and persist a reproducible, sanitized one-merchant supplement. */
export async function collectAndSaveSupplement(options = {}) {
  const merchant = await collectMerchant('nbtnaver', options);
  const document = {
    schemaVersion: 2,
    batchId: 'naver-shopping-public-supplement',
    checkedAt: new Date().toISOString(),
    method: 'anonymous_public_first_party_http_reads',
    browserUsed: false,
    credentialsUsed: false,
    scope: {
      merchantIds: ['nbtnaver'],
      reviewBodiesPersisted: false,
      reviewerIdentityPersisted: false,
      detailHostStopPolicy: 'smartstore.naver.com returned HTTP 429; no further requests to that host',
    },
    merchants: [merchant],
    notes: [
      'Records are derived from the live promotion page __NEXT_DATA__ and require a matching productId in an observed DOM outlink.',
      'Search, brand-review, catalog-review, smartstore-detail, cookie, authorization, protected-token and account-mutation requests are not made by this adapter.',
    ],
  };
  writeFileSync(SUPPLEMENT_FILE, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return document;
}
