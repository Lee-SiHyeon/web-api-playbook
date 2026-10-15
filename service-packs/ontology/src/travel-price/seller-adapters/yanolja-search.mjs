import { fetchYanoljaHotelSearch } from './yanolja-hotel.mjs';

const OBSERVED_ORIGIN = 'https://nol.yanolja.com';
const OBSERVED_PATH = '/discovery/list/search/PRODUCT_CATEGORY_KOREA_ACCOMMODATION';
const OBSERVED_DETAIL_PATH = /^\/stay\/domestic\/\d+\/?$/;

function fail(code, message, metadata) {
  return Object.assign(new Error(message), { code, ...(metadata ? { metadata } : {}) });
}

function itemSchemaFailure(item) {
  let detail;
  try {
    detail = new URL(item.detailUrl);
  } catch {
    return 'detail_url_invalid';
  }
  if (detail.origin !== OBSERVED_ORIGIN) return 'detail_url_origin_invalid';
  if (!OBSERVED_DETAIL_PATH.test(detail.pathname)) return 'detail_url_path_invalid';
  if (detail.pathname.split('/').filter(Boolean).at(-1) !== item.hotelId) return 'hotel_id_mismatch';
  if (item.sellerId !== 'yanolja-hotel') return 'seller_id_invalid';
  if (typeof item.title !== 'string' || !item.title.trim()) return 'title_missing';
  if (!Array.isArray(item.prices)) return 'prices_invalid';
  return null;
}

function validateItems(items) {
  const validItems = [];
  const invalidReasons = {};
  for (const item of items) {
    const reason = itemSchemaFailure(item);
    if (!reason) {
      validItems.push(item);
      continue;
    }
    invalidReasons[reason] = (invalidReasons[reason] ?? 0) + 1;
  }
  return {
    validItems,
    inputScope: 'parsed_product_cards_after_url_filter',
    sourceItemCount: items.length,
    validItemCount: validItems.length,
    excludedInvalidItemCount: items.length - validItems.length,
    invalidReasons,
  };
}

/**
 * Read one anonymous, server-rendered accommodation search Document using the
 * observed q-only URL. This intentionally does not submit dates, occupancy,
 * autocomplete, API-list, or page-number requests.
 */
export async function searchYanoljaAccommodation(options = {}) {
  const allowedOptions = new Set(['keyword', 'fetchImpl', 'timeoutMs']);
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !allowedOptions.has(key))) {
    throw fail('YANOLJA_SEARCH_OPTION_UNSUPPORTED', 'Only keyword, fetchImpl, and timeoutMs are supported by the observed Document search');
  }
  const { keyword, fetchImpl = fetch, timeoutMs } = options;
  if (typeof fetchImpl !== 'function' || (timeoutMs !== undefined
    && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000))) {
    throw fail('YANOLJA_SEARCH_OPTION_INVALID', 'fetchImpl must be callable and timeoutMs must be between 1 and 30000');
  }
  if (typeof keyword !== 'string' || !keyword.trim()) {
    throw fail('YANOLJA_SEARCH_KEYWORD_REQUIRED', 'keyword is required');
  }
  const query = keyword.trim();
  // The currently observed search form advertises maxlength=50.
  if (query.length > 50) {
    throw fail('YANOLJA_SEARCH_KEYWORD_TOO_LONG', 'keyword exceeds the observed 50-character search input');
  }

  const { metadata, result } = await fetchYanoljaHotelSearch({ keyword: query, fetchImpl, timeoutMs });
  if (metadata.origin !== OBSERVED_ORIGIN || metadata.path !== OBSERVED_PATH || metadata.method !== 'GET'
    || metadata.status !== 200 || !/text\/html/i.test(metadata.contentType)) {
    throw fail('YANOLJA_SEARCH_CONTRACT_CHANGED', 'Yanolja search response does not match the observed public Document contract', metadata);
  }
  if (result.search.category !== 'PRODUCT_CATEGORY_KOREA_ACCOMMODATION'
    || result.search.keyword !== query || !Array.isArray(result.cards)) {
    throw fail('YANOLJA_SEARCH_SCHEMA_INVALID', 'Yanolja search Document did not match the observed keyword result schema', {
      ...metadata,
      schemaValidation: {
        reason: result.search.category !== 'PRODUCT_CATEGORY_KOREA_ACCOMMODATION' ? 'category_mismatch'
          : result.search.keyword !== query ? 'keyword_mismatch' : 'cards_missing',
        sourceItemCount: Array.isArray(result.cards) ? result.cards.length : null,
        validItemCount: 0,
        excludedInvalidItemCount: Array.isArray(result.cards) ? result.cards.length : null,
      },
    });
  }
  if (result.cards.length === 0) {
    throw fail('YANOLJA_SEARCH_EMPTY_RESULT', 'Yanolja search returned no product cards', {
      ...metadata,
      schemaValidation: { sourceItemCount: 0, validItemCount: 0, excludedInvalidItemCount: 0, invalidReasons: {} },
    });
  }
  const { validItems, ...schemaValidation } = validateItems(result.cards);
  if (schemaValidation.validItemCount === 0) {
    throw fail('YANOLJA_SEARCH_SCHEMA_INVALID', 'Yanolja search returned no cards matching the observed public accommodation schema', {
      ...metadata,
      schemaValidation,
    });
  }
  const hasExcludedItems = schemaValidation.excludedInvalidItemCount > 0;
  const pricedItemCount = validItems.filter(item => item.prices.some(price => price.salePriceKrw != null)).length;
  const discountedItemCount = validItems.filter(item => item.prices.some(price => price.discountRatePercent != null)).length;

  const page = result.page;
  const checkedAt = metadata.checkedAt;
  const source = {
    sourceId: 'yanolja-accommodation-search-document',
    sellerId: 'yanolja-hotel',
    origin: OBSERVED_ORIGIN,
    path: OBSERVED_PATH,
    operation: 'public-keyword-search-document',
    method: 'GET',
    representation: 'server-rendered HTML Document',
    authentication: 'anonymous',
  };
  const receipt = {
    checkedAt,
    status: hasExcludedItems ? 'partial' : 'usable_html',
    execution: { mode: 'pure_http', browserUsed: false, authentication: 'anonymous' },
    request: {
      method: 'GET',
      origin: metadata.origin,
      path: metadata.path,
      query: { q: query },
      queryNames: ['q'],
      explicitDates: false,
      explicitTravellerCounts: false,
      requestedPage: 1,
    },
    response: {
      status: metadata.status,
      contentType: metadata.contentType,
      bytes: metadata.bytes,
      sha256: metadata.sha256,
    },
    counts: {
      totalResultCount: result.totalResultCount,
      sourceItemCount: schemaValidation.sourceItemCount,
      returnedItemCount: schemaValidation.validItemCount,
      excludedInvalidItemCount: schemaValidation.excludedInvalidItemCount,
      invalidItemReasons: schemaValidation.invalidReasons,
      pricedItemCount,
      discountedItemCount,
    },
    observedResultContext: {
      source: 'date and occupancy values parsed from returned product links; not caller-supplied request options',
      checkInDate: result.search.checkInDate,
      checkOutDate: result.search.checkOutDate,
      adultCount: result.search.adultCount,
      childCount: result.search.childCount,
    },
    coverage: {
      page: page?.currentPage ?? null,
      totalPages: page?.totalPages ?? null,
      isLastPage: page?.isLast ?? null,
      fetchedPages: [1],
      paginationReplayed: false,
      pageTwoStatus: 'not requested; page request contract not captured',
      sourceItemCount: schemaValidation.sourceItemCount,
      returnedValidItemCount: schemaValidation.validItemCount,
      excludedInvalidItemCount: schemaValidation.excludedInvalidItemCount,
      schemaPartial: hasExcludedItems,
      schemaPartialReasons: hasExcludedItems ? ['invalid_cards_excluded'] : [],
      completeCatalog: false,
    },
    schemaValidation: {
      inputScope: schemaValidation.inputScope,
      sourceItemCount: schemaValidation.sourceItemCount,
      validItemCount: schemaValidation.validItemCount,
      excludedInvalidItemCount: schemaValidation.excludedInvalidItemCount,
      invalidReasons: schemaValidation.invalidReasons,
    },
    priceSemantics: {
      basis: 'listing labels only',
      totalVsNightly: 'unknown',
      taxesIncluded: null,
      feesIncluded: null,
    },
    apiCandidates: {
      accommodationListV2: {
        status: 'unresolved',
        callerObservedInCurrentBundle: true,
        xhrCaptured: false,
        replay: { method: 'POST', origin: OBSERVED_ORIGIN, path: '/api/list/universal-search/v2/list', status: 404, challengeDetected: false },
      },
      autocomplete: { status: 'unverified', usableEndpointCaptured: false },
    },
    challengeScan: metadata.challengeScan ?? { performed: false, reason: 'scan metadata unavailable' },
    challengeSignals: metadata.challengeScan?.performed === true && metadata.challengeScan.detected === false
      ? 'none detected in the scanned title and bounded body prefix'
      : 'not scanned',
  };

  return { source, items: validItems, receipt };
}
