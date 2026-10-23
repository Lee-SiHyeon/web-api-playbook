import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webApiPlaybookRoot } from './web-auth-provider.mjs';
import { coupangSearchStatus } from './coupang-products.mjs';

const PARTNER_ORIGIN = 'https://partners.coupang.com';
const PRODUCT_SEARCH_URL = `${PARTNER_ORIGIN}/api/v1/search`;
const OUTPUT_URL = new URL('../references/cps-reverify/coupang-web-supplement.json', import.meta.url);
const SAFE_QUERY = '무선 마우스';

const cleanErrorCode = error => /^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '')
  ? error.code : 'COUPANG_PARTNER_READ_FAILED';

function normalizeProduct(product, receiptId, index) {
  const ratingCount = Number.isSafeInteger(product.reviewCount) && product.reviewCount >= 0
    ? product.reviewCount : null;
  const observedRating = typeof product.rating === 'number' && Number.isFinite(product.rating)
    ? product.rating : null;
  const ratingValue = observedRating === 0 && ratingCount === 0 ? null : observedRating;
  const offers = [];
  if (typeof product.price === 'number' && Number.isFinite(product.price)) {
    offers.push({ amount: product.price, currency: null, priceText: null,
      type: 'PortalDisplayedSalesPrice', priceKind: 'portal_displayed_sales_price', availability: null, seller: null,
      validFrom: null, validUntil: null, condition: null, url: product.url });
  }
  if (typeof product.listPrice === 'number' && Number.isFinite(product.listPrice)) {
    offers.push({ amount: product.listPrice, currency: null, priceText: null,
      type: 'PortalOriginPrice', priceKind: 'original_price', availability: null, seller: null,
      validFrom: null, validUntil: null, condition: null, url: product.url });
  }

  return {
    type: 'RetailProduct',
    sourceLocalId: `${product.productId}:${product.itemId}:${product.vendorItemId}`,
    title: product.title,
    url: product.url,
    description: null,
    brand: null,
    price: {
      amount: typeof product.price === 'number' && Number.isFinite(product.price) ? product.price : null,
      currency: null,
      priceText: null,
    },
    rating: {
      value: ratingValue,
      best: null,
      worst: null,
      reviewCount: null,
      ratingCount,
      sourceMetrics: { ratingAverage: observedRating, ratingCount, countMeaning: 'Source ratingCount; reviewCount semantics not established' },
    },
    variants: [],
    offers,
    reviewSamples: [],
    sourceMetrics: {
      ratingAverage: observedRating,
      ratingCount,
      salesPrice: typeof product.price === 'number' ? product.price : null,
      originPrice: typeof product.listPrice === 'number' ? product.listPrice : null,
      discountedPrice: typeof product.discountedPrice === 'number' ? product.discountedPrice : null,
      currencyHint: 'KRW',
      currencyHintBasis: 'maintained client default; not independently verified from this response',
      soldOut: typeof product.soldOut === 'boolean' ? product.soldOut : null,
      freeShipping: typeof product.freeShipping === 'boolean' ? product.freeShipping : null,
    },
    evidence: [{
      receiptId,
      locator: `body.data.products[*] (sample ${index + 1}; normalized by maintained adapter)`,
      fields: ['type', 'sourceLocalId', 'title', 'url', 'price', 'rating', 'offers', 'sourceMetrics'],
    }],
  };
}

function baseRow() {
  return {
    merchantId: 'coupang',
    sourceId: 'coupang',
    merchantName: 'Coupang',
    siteUrl: 'https://www.coupang.com/',
    verticalHint: 'general_retail',
    authMode: 'protected_first_party_session',
    authenticationMode: 'protected_first_party_session',
    credentialProvider: 'windows_dpapi',
    credentialValuesCaptured: false,
    receipts: [],
    records: [],
    contracts: [{
      kind: 'authenticated_first_party_partner_web_search',
      sourceId: 'coupang',
      endpoint: PRODUCT_SEARCH_URL,
      method: 'POST',
      sourceScope: 'partners_web_catalog_first_page',
      officialOpenApiUsed: false,
      browserUsed: false,
      note: 'Uses the maintained owner-verified Partners web client. Consumer product URLs are emitted by the client but are not requested in this run.',
    }],
    operations: {},
    frontier: [],
    status: 'not_run',
  };
}

/**
 * Reads a small sample through the maintained, owner-verified Coupang Partners
 * web client. The wrapper observes only Cookie/Authorization header presence;
 * header values and response bodies never leave the existing client's memory.
 */
export async function collectCoupangWebSupplement({ query = SAFE_QUERY } = {}) {
  const row = baseRow();
  const availability = await coupangSearchStatus();
  if (!availability.usableForAttempt) {
    row.status = 'blocked_protected_session_not_ready';
    row.operations.productSearch = { state: 'blocked', evidenceReceiptIds: [], note: 'The maintained session is not ready; no login was attempted.' };
    return row;
  }
  const playbookRoot = webApiPlaybookRoot();
  const { ProtectedStore } = await import(pathToFileURL(join(playbookRoot, 'lib', 'protected-store.mjs')).href);
  const { createCoupangAuth } = await import(pathToFileURL(join(playbookRoot, 'lib', 'web-auth', 'coupang.mjs')).href);
  const protectedStore = new ProtectedStore().status('coupang-web-state');
  if (!availability.usableForAttempt || protectedStore.available !== true || protectedStore.persistent !== true) {
    row.status = 'blocked_protected_session_not_ready';
    row.operations.productSearch = {
      state: 'blocked', evidenceReceiptIds: [],
      note: 'The existing protected partner session is not available; no login or renewal was attempted.',
    };
    return row;
  }

  const requestObservations = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    requestObservations.push({
      requestUrl: `${url.origin}${url.pathname}`,
      requestMethod: String(init.method ?? 'GET').toUpperCase(),
      cookiesSent: headers.has('cookie'),
      authorizationSent: headers.has('authorization'),
    });
    return globalThis.fetch(input, init);
  };

  try {
    const auth = createCoupangAuth({ fetchImpl });
    // The maintained web client always requests the observed first page (36).
    // Only five distinct product groups are retained in the supplement.
    const result = await auth.search({ query, limit: 36 });
    const sourceReceipt = result.receipt;
    const searchObservation = [...requestObservations].reverse().find(request =>
      request.requestUrl === PRODUCT_SEARCH_URL && request.requestMethod === 'POST');
    if (!searchObservation || sourceReceipt?.httpStatus !== 200
      || sourceReceipt?.ownerVerified !== true || sourceReceipt?.browserUsed !== false) {
      throw Object.assign(new Error('COUPANG_OWNER_VERIFIED_SEARCH_RECEIPT_INVALID'), {
        code: 'COUPANG_OWNER_VERIFIED_SEARCH_RECEIPT_INVALID',
      });
    }

    const seenProductIds = new Set();
    const sample = [];
    for (const product of result.products) {
      if (seenProductIds.has(product.productId)) continue;
      seenProductIds.add(product.productId);
      sample.push(product);
      if (sample.length === 5) break;
    }
    const receiptId = randomUUID();
    row.receipts.push({
      receiptId,
      kind: 'authenticated_partner_web_search',
      sourceId: 'coupang',
      authMode: 'protected_first_party_session',
      authenticationMode: 'protected_first_party_session',
      requestMethod: sourceReceipt.method,
      requestUrl: PRODUCT_SEARCH_URL,
      finalUrl: PRODUCT_SEARCH_URL,
      status: sourceReceipt.httpStatus,
      contentType: sourceReceipt.contentType,
      bytes: null,
      sha256: sourceReceipt.responseSha256,
      checkedAt: sourceReceipt.checkedAt,
      browserUsed: false,
      cookiesSent: searchObservation.cookiesSent,
      authorizationSent: searchObservation.authorizationSent,
      authenticated: sourceReceipt.authenticated === true,
      ownerReadbackVerified: sourceReceipt.ownerVerified === true,
      credentialPropagated: sourceReceipt.credentialPropagated === true,
      credentialProvider: 'windows_dpapi',
      credentialPersistence: protectedStore.provider,
      officialOpenApiUsed: false,
      sourceScope: sourceReceipt.sourceScope,
      observedCount: sourceReceipt.observedCount,
      sampledCount: sample.length,
      pagination: sourceReceipt.pagination,
      stopReason: null,
    });
    row.records = sample.map((product, index) => normalizeProduct(product, receiptId, index));
    row.checkedAt = sourceReceipt.checkedAt;
    row.query = query;
    row.total = result.total;
    row.operations.productSearch = {
      state: sample.length === 5 ? 'live_replay' : 'live_replay_partial',
      evidenceReceiptIds: [receiptId],
      note: 'One owner-verified first-page search; five distinct product IDs retained when available. The source ratingCount is not labeled as a review count.',
    };
    row.operations.price = { state: sample.some(product => product.price != null) ? 'live_replay' : 'not_observed', evidenceReceiptIds: [receiptId], note: null };
    row.operations.ratingSummary = { state: sample.some(product => product.rating != null) ? 'live_replay_partial' : 'not_observed', evidenceReceiptIds: [receiptId], note: 'Rating averages and ratingCount only; reviewCount and review text were not established.' };
    row.status = sample.length === 5 ? 'reachable_with_ontology_records' : sample.length ? 'reachable_with_partial_ontology_records' : 'reachable_without_records';
    return row;
  } catch (error) {
    row.status = 'read_failed';
    row.operations.productSearch = {
      state: 'blocked_or_failed', evidenceReceiptIds: [], note: cleanErrorCode(error),
    };
    return row;
  }
}

async function main() {
  const row = await collectCoupangWebSupplement();
  await writeFile(OUTPUT_URL, `${JSON.stringify(row, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ status: row.status, recordCount: row.records.length, receiptCount: row.receipts.length })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
