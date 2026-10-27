import { commerceFail, commerceJsonRequest } from '../commerce/http.mjs';

export const SOOMGO_ORIGIN = 'https://api.soomgo.com';
export const SOOMGO_WEB_ORIGIN = 'https://soomgo.com';
export const SOOMGO_CONTRACT = Object.freeze({
  sourceUrl: 'https://assets.cdn.soomgo.com/vite/ef0d619/assets/client-bundle.cqVbIhyw.js',
  sourceSha256: 'f104e06ba62e83b3ecaa5857dc8975f222b4232a6cf9c8b29b115c8e32227729',
  sourceKind: 'first_party_bundle_contract',
});

const DEFAULT_USER_AGENT = 'SoomgoFrontend-production/ef0d6196ed27a3515e4a3668af8c717132d52f61';
const ALLOWED_SORTS = new Set(['review_count', 'last_login', 'review_rate', 'hired_count']);
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_LIMIT = 20;
const MAX_CURSOR_LENGTH = 8192;

function fail(code, receipt) {
  commerceFail('soomgo', code, receipt);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validInteger(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function safeText(value, { max = 300, allowEmpty = false } = {}) {
  return typeof value === 'string' && value.length <= max &&
    value === value.trim() && (allowEmpty || value.length > 0) &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

function nonEmptyText(value, max = 300) {
  return safeText(value, { max }) ? value : null;
}

function safeSlug(value) {
  return safeText(value, { max: 200 }) && !/[/?#\\]/.test(value);
}

function receiptRequest(request) {
  return {
    method: request.method,
    origin: request.origin,
    path: request.path,
    httpStatus: request.httpStatus,
    mime: request.mime,
    responseBytes: request.responseBytes,
    responseSha256: request.responseSha256,
    checkedAt: request.checkedAt,
    browserUsed: false,
    anonymous: true,
    credentialsUsed: false,
    cookiesSent: false,
    queryFields: [...request.queryFields],
  };
}

function pageEnvelope(operation, filters, payload, request, items, limit) {
  const response = payload.response;
  const nextCursor = response.cursor || null;
  const totalCount = response.totalCount;
  const firstPage = filters.cursor === undefined;
  const complete = firstPage && nextCursor === null && items.length === totalCount;
  return {
    schemaVersion: 1,
    service: 'soomgo',
    operation,
    observedAt: request.checkedAt,
    filters,
    items,
    pagination: {
      limit,
      returned: items.length,
      totalCount,
      sort: response.sortBy,
      nextCursor,
      pages: 1,
      complete,
      reason: complete ? 'end_of_results' : nextCursor ? 'more_pages_available' : 'partial_result',
    },
    requests: [receiptRequest(request)],
    contractProvenance: { ...SOOMGO_CONTRACT },
  };
}

function categoryItem(raw) {
  if (!isRecord(raw) || !validInteger(raw.id, 1, 2_147_483_647) ||
    (raw.slug !== null && raw.slug !== undefined && !safeSlug(raw.slug)) ||
    !safeText(raw.title, { max: 120 })) return null;
  return { id: raw.id, slug: raw.slug ?? null, name: raw.title };
}

function serviceItem(raw) {
  const name = isRecord(raw) ? raw.name ?? raw.title : undefined;
  if (!isRecord(raw) || !validInteger(raw.id, 1, 2_147_483_647) ||
    (raw.slug !== null && raw.slug !== undefined && !safeSlug(raw.slug)) ||
    !safeText(name, { max: 160 })) return null;
  return { id: raw.id, slug: raw.slug ?? null, name };
}

function subcategoryItem(raw) {
  const base = categoryItem(raw);
  if (!base || !Array.isArray(raw.services)) return null;
  const services = raw.services.map(categoryItem).map((item) => item ? { id: item.id, slug: item.slug, name: item.name } : null);
  if (services.some((service) => service === null)) return null;
  return { ...base, services };
}

function normalizeProvider(raw) {
  if (!isRecord(raw) || !validInteger(raw.id, 1, Number.MAX_SAFE_INTEGER) ||
    !isRecord(raw.mainService) || !validInteger(raw.mainService.id, 1, 2_147_483_647) ||
    !safeSlug(raw.mainService.slug) || !safeText(raw.mainService.name, { max: 160 }) ||
    !Array.isArray(raw.services)) return null;

  const services = raw.services.map(serviceItem);
  if (services.some((service) => service === null)) return null;
  const location = raw.address === null || raw.address === undefined || raw.address === ''
    ? null : safeText(raw.address, { max: 180 }) ? raw.address : null;
  if (raw.address !== null && raw.address !== undefined && raw.address !== '' && location === null) return null;
  const avgResponseTimeSeconds = raw.avgResponseTime === null || raw.avgResponseTime === undefined || raw.avgResponseTime === -1
    ? null : validInteger(raw.avgResponseTime, 0, 31_536_000) ? raw.avgResponseTime : null;
  if (raw.avgResponseTime !== null && raw.avgResponseTime !== undefined && raw.avgResponseTime !== -1 && avgResponseTimeSeconds === null) return null;
  const careerValue = raw.career === null || raw.career === undefined
    ? null : validInteger(raw.career, 0, 1000) ? raw.career : null;
  if (raw.career !== null && raw.career !== undefined && careerValue === null) return null;

  for (const key of ['isSafePayment', 'hasApprovedLicenseBadge', 'canReserve']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') return null;
  }
  if (raw.user !== undefined && raw.user !== null && !isRecord(raw.user)) return null;
  if (raw.user && raw.user.id !== undefined && raw.user.id !== null &&
      !validInteger(raw.user.id, 1, Number.MAX_SAFE_INTEGER)) return null;
  const profileUserId = raw.user && validInteger(raw.user.id, 1, Number.MAX_SAFE_INTEGER)
    ? String(raw.user.id) : null;

  return {
    providerId: String(raw.id),
    // The first-party route is /profile/users/:userId; it is not the search-result provider id.
    profileUrl: profileUserId ? `${SOOMGO_WEB_ORIGIN}/profile/users/${profileUserId}` : null,
    mainService: serviceItem(raw.mainService),
    services,
    location,
    avgResponseTimeSeconds,
    careerValue,
    isSafePayment: raw.isSafePayment ?? null,
    hasApprovedLicenseBadge: raw.hasApprovedLicenseBadge ?? null,
    canReserve: raw.canReserve ?? null,
    hasAdDisplay: raw.adDisplay !== null && raw.adDisplay !== undefined,
  };
}

function validateSearchFilters(input) {
  if (!isRecord(input)) fail('SOOMGO_INPUT_INVALID');
  const filters = {};
  for (const key of ['category1', 'category2', 'serviceSlug']) {
    if (input[key] !== undefined && input[key] !== null) {
      if (!safeSlug(input[key])) fail('SOOMGO_FILTER_INVALID');
      filters[key] = input[key];
    }
  }
  if (filters.category2 && !filters.category1) fail('SOOMGO_CATEGORY_PARENT_REQUIRED');
  for (const key of ['address1', 'address2', 'keyword']) {
    if (input[key] !== undefined && input[key] !== null) {
      if (!safeText(input[key], { max: key === 'keyword' ? 120 : 100 })) fail('SOOMGO_FILTER_INVALID');
      filters[key] = input[key];
    }
  }
  if (filters.address2 && !filters.address1) fail('SOOMGO_ADDRESS_PARENT_REQUIRED');
  if (input.sort !== undefined && input.sort !== null) {
    if (!safeText(input.sort, { max: 40 }) || !ALLOWED_SORTS.has(input.sort)) fail('SOOMGO_SORT_INVALID');
    filters.sort = input.sort;
  }
  if (input.cursor !== undefined && input.cursor !== null) {
    if (!safeText(input.cursor, { max: MAX_CURSOR_LENGTH }) || /\s/.test(input.cursor)) fail('SOOMGO_CURSOR_INVALID');
    filters.cursor = input.cursor;
  }
  const limit = input.limit ?? 5;
  if (!validInteger(limit, 1, MAX_LIMIT)) fail('SOOMGO_LIMIT_INVALID');
  return { filters, limit };
}

function validateCategoryList(payload, request, operation) {
  if (!Array.isArray(payload) || payload.length > 2000) fail('SOOMGO_CATEGORY_SCHEMA_INVALID', receiptRequest(request));
  const items = payload.map(categoryItem);
  if (items.some((item) => item === null)) fail('SOOMGO_CATEGORY_SCHEMA_INVALID', receiptRequest(request));
  const ids = new Set();
  const slugs = new Set();
  for (const item of items) {
    if (ids.has(item.id) || slugs.has(item.slug)) fail('SOOMGO_CATEGORY_SCHEMA_INVALID', receiptRequest(request));
    ids.add(item.id);
    slugs.add(item.slug);
  }
  return {
    schemaVersion: 1,
    service: 'soomgo',
    operation,
    observedAt: request.checkedAt,
    items,
    pagination: { returned: items.length, totalCount: items.length, complete: true, nextCursor: null },
    requests: [receiptRequest(request)],
    contractProvenance: { ...SOOMGO_CONTRACT },
  };
}

export function createSoomgoClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('SOOMGO_CONFIGURATION_INVALID');

  async function requestJson(path, query = []) {
    return commerceJsonRequest({
      service: 'soomgo',
      origin: SOOMGO_ORIGIN,
      path,
      query,
      fetchImpl,
      now,
      userAgent: DEFAULT_USER_AGENT,
      maxBytes: MAX_RESPONSE_BYTES,
      timeoutMs: 20_000,
    });
  }

  return Object.freeze({
    async listCategories() {
      const { payload, request } = await requestJson('/api2/categories/');
      return validateCategoryList(payload, request, 'categories');
    },

    async listSubcategories({ category1Slug } = {}) {
      if (!safeSlug(category1Slug)) fail('SOOMGO_CATEGORY_SLUG_INVALID');
      const { payload, request } = await requestJson(`/api2/categories/${encodeURIComponent(category1Slug)}`);
      if (!Array.isArray(payload) || payload.length > 2000) fail('SOOMGO_SUBCATEGORY_SCHEMA_INVALID', receiptRequest(request));
      const items = payload.map(subcategoryItem);
      if (items.some((item) => item === null)) fail('SOOMGO_SUBCATEGORY_SCHEMA_INVALID', receiptRequest(request));
      const ids = new Set();
      const slugs = new Set();
      for (const item of items) {
        if (ids.has(item.id) || slugs.has(item.slug)) fail('SOOMGO_SUBCATEGORY_SCHEMA_INVALID', receiptRequest(request));
        ids.add(item.id);
        slugs.add(item.slug);
      }
      return {
        schemaVersion: 1,
        service: 'soomgo',
        operation: 'subcategories',
        observedAt: request.checkedAt,
        category1: category1Slug,
        items,
        pagination: { returned: items.length, totalCount: items.length, complete: true, nextCursor: null },
        requests: [receiptRequest(request)],
        contractProvenance: { ...SOOMGO_CONTRACT },
      };
    },

    async searchPros(input = {}) {
      const { filters, limit } = validateSearchFilters(input);
      const query = [];
      for (const key of ['category1', 'category2', 'serviceSlug', 'address1', 'address2', 'sort', 'cursor']) {
        if (filters[key] !== undefined) query.push([key === 'serviceSlug' ? 'service_slug' : key, filters[key]]);
      }
      if (filters.keyword !== undefined) query.push(['keyword', filters.keyword]);
      query.push(['limit', String(limit)]);
      const { payload, request } = await requestJson('/v2/search/pro', query);
      if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.response) ||
        !Array.isArray(payload.response.results) || payload.response.results.length > limit ||
        !validInteger(payload.response.totalCount, 0, 100_000_000) ||
        !Object.hasOwn(payload.response, 'cursor') ||
        (payload.response.cursor !== null &&
          payload.response.cursor !== '' &&
          !safeText(payload.response.cursor, { max: MAX_CURSOR_LENGTH })) ||
        (payload.response.sortBy !== undefined && payload.response.sortBy !== null &&
          !safeText(payload.response.sortBy, { max: 40 }))) {
        fail('SOOMGO_SEARCH_SCHEMA_INVALID', receiptRequest(request));
      }
      const items = payload.response.results.map(normalizeProvider);
      if (items.some((item) => item === null)) fail('SOOMGO_PROVIDER_SCHEMA_INVALID', receiptRequest(request));
      const providerIds = new Set(items.map((item) => item.providerId));
      if (providerIds.size !== items.length) fail('SOOMGO_PROVIDER_SCHEMA_INVALID', receiptRequest(request));
      const normalizedFilters = Object.fromEntries(Object.entries(filters).filter(([key]) => key !== 'cursor'));
      const result = pageEnvelope('search_pros', filters, payload, request, items, limit);
      result.filters = normalizedFilters;
      result.pagination.requestedCursor = filters.cursor ?? null;
      return result;
    },

    async collectPros(input = {}, options = {}) {
      if (!isRecord(input)) fail('SOOMGO_INPUT_INVALID');
      if (!isRecord(options)) fail('SOOMGO_INPUT_INVALID');
      const { maxPages = options.maxPages ?? 2, ...searchInput } = input;
      if (!validInteger(maxPages, 1, 5)) fail('SOOMGO_PAGE_LIMIT_INVALID');
      const firstPageFilters = validateSearchFilters(searchInput).filters;
      const items = [];
      const requests = [];
      const providerIds = new Set();
      const seenCursors = new Set(firstPageFilters.cursor ? [firstPageFilters.cursor] : []);
      let totalCount = null;
      let nextCursor = firstPageFilters.cursor ?? null;
      let lastPage = null;
      let pages = 0;

      while (pages < maxPages) {
        const pageInput = { ...searchInput, ...(nextCursor ? { cursor: nextCursor } : {}) };
        lastPage = await this.searchPros(pageInput);
        pages++;
        requests.push(...lastPage.requests);
        if (totalCount === null) totalCount = lastPage.pagination.totalCount;
        else if (totalCount !== lastPage.pagination.totalCount) {
          fail('SOOMGO_RESULT_COUNT_CHANGED', requests.at(-1));
        }
        for (const item of lastPage.items) {
          if (providerIds.has(item.providerId)) fail('SOOMGO_PROVIDER_PAGE_DUPLICATE', requests.at(-1));
          providerIds.add(item.providerId);
          items.push(item);
        }
        nextCursor = lastPage.pagination.nextCursor;
        if (!nextCursor) break;
        if (seenCursors.has(nextCursor)) fail('SOOMGO_CURSOR_REPEATED', requests.at(-1));
        seenCursors.add(nextCursor);
      }

      const complete = firstPageFilters.cursor === undefined && nextCursor === null && items.length === totalCount;
      return {
        schemaVersion: 1,
        service: 'soomgo',
        operation: 'collect_pros',
        observedAt: lastPage?.observedAt ?? new Date(now()).toISOString(),
        filters: Object.fromEntries(Object.entries(firstPageFilters).filter(([key]) => key !== 'cursor')),
        items,
        pagination: {
          limit: lastPage?.pagination.limit ?? searchInput.limit ?? 5,
          returned: items.length,
          totalCount: totalCount ?? 0,
          pages,
          nextCursor,
          complete,
          reason: complete ? 'end_of_results' : nextCursor ? 'page_limit_reached' : firstPageFilters.cursor ? 'resumed_window_only' : 'count_mismatch',
        },
        requests,
        contractProvenance: { ...SOOMGO_CONTRACT },
      };
    },
  });
}
