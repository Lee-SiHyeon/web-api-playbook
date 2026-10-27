import { commerceFail, commerceJsonRequest } from '../commerce/http.mjs';
import { SOOMGO_ORIGIN, SOOMGO_WEB_ORIGIN } from './soomgo.mjs';

const USER_AGENT = 'SoomgoFrontend-production/ef0d6196ed27a3515e4a3668af8c717132d52f61';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PROFILE_PAGE_SOURCE = Object.freeze({
  sourceUrl: 'https://assets.cdn.soomgo.com/vite/ef0d619/assets/client-bundle.BDHliGL-.js',
  sourceSha256: 'd5a51a8b02c81e31e9d8388b32c4237447adcc6c9003a248266576cc6c6dd331',
  sourceKind: 'first_party_bundle_contract',
});
const API_SOURCE = Object.freeze({
  sourceUrl: 'https://assets.cdn.soomgo.com/vite/ef0d619/assets/client-bundle.cqVbIhyw.js',
  sourceSha256: 'f104e06ba62e83b3ecaa5857dc8975f222b4232a6cf9c8b29b115c8e32227729',
  sourceKind: 'first_party_bundle_contract',
});
const PORTFOLIO_PAGE_SOURCE = Object.freeze({
  kind: 'browser_xhr_observed',
  sourceUrl: 'https://soomgo.com/profile/users/{userId}',
  origin: SOOMGO_ORIGIN,
  path: '/v2/users/{userId}/portfolios',
  firstPageQueryFields: ['size'],
  continuationQueryFields: ['size', 'next_cursor'],
  continuationSize: 8,
});
const REVIEW_PAGE_SOURCE = Object.freeze({
  kind: 'browser_xhr_observed',
  sourceUrl: 'https://soomgo.com/profile/users/{userId}',
  origin: SOOMGO_ORIGIN,
  path: '/v3/users/{userId}/reviews/received',
  firstPageQueryFields: ['size', 'role'],
  continuationQueryFields: ['next_cursor', 'is_photo_review', 'is_pay_verified', 'sort_type', 'size', 'role'],
});
const REVIEW_SIZE = 3;
const REVIEW_CONTINUATION_QUERY = Object.freeze([
  ['is_photo_review', 'false'],
  ['is_pay_verified', 'false'],
  ['sort_type', 'latest'],
  ['size', String(REVIEW_SIZE)],
  ['role', 'provider'],
]);

function fail(code, receipt = undefined) {
  commerceFail('soomgo', code, receipt);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numericId(value) {
  const candidate = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof candidate === 'string' && /^[1-9]\d{0,19}$/.test(candidate) ? candidate : null;
}

function opaqueId(value) {
  const candidate = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  return typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : null;
}

function safeText(value, max = 500) {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value === value.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

function redactedPublicText(value, maxLength = 500) {
  if (typeof value !== 'string' || value.length > maxLength || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return null;
  const normalized = value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!normalized || normalized.length > maxLength) return null;
  const dates = [];
  const dated = normalized.replace(/(?<!\d)(?:19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2}(?!\d)/g, match => {
    const index = dates.push(match) - 1;
    return `\uE000${index}\uE001`;
  });
  const redacted = dated
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
    .replace(/https?:\/\/\S+|\bwww\.\S+/gi, '[redacted]')
    .replace(/(?<!\d)\+\d{1,3}(?:[\s().-]+\d{1,4}){2,4}(?!\d)/g, match => {
      const digits = match.replace(/\D/g, '').length;
      return digits >= 8 && digits <= 15 ? '[redacted]' : match;
    })
    .replace(/(?<!\d)(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?!\d)/g, '[redacted]')
    .replace(/(?:\+?82[-.\s]?)?(?:0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4})/g, '[redacted]')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return redacted.replace(/\uE000(\d+)\uE001/g, (_match, index) => dates[Number(index)] ?? '');
}

function optionalPublicText(value, { maxLength, request, code }) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > maxLength || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    fail(code, requestReceipt(request));
  }
  return redactedPublicText(value, maxLength);
}

function finiteMetric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
}

function safeRating(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 5;
}

function safeReviewCursor(value) {
  return safeText(value, 500) ? value : null;
}

function profilePageInfo(raw, { requestedSize = null, returned }) {
  if (!isRecord(raw) || !safeCount(raw.currentCount) || !safeCount(raw.size) ||
      typeof raw.hasNextPage !== 'boolean' || typeof raw.hasPrevPage !== 'boolean' ||
      !safeText(raw.paginationType, 80)) return null;
  const totalCount = raw.totalCount === null || raw.totalCount === undefined ? null
    : safeCount(raw.totalCount) ? raw.totalCount : null;
  if (raw.totalCount !== null && raw.totalCount !== undefined && totalCount === null) return null;
  const complete = raw.hasNextPage === false && totalCount !== null &&
    raw.currentCount === totalCount && returned === totalCount;
  return {
    paginationType: raw.paginationType,
    currentCount: raw.currentCount,
    size: raw.size,
    requestedSize,
    returned,
    totalCount,
    hasNextPage: raw.hasNextPage,
    hasPrevPage: raw.hasPrevPage,
    nextCursorAvailable: safeText(raw.nextCursor, 8192),
    previousCursorAvailable: safeText(raw.prevCursor, 8192),
    complete,
    reason: complete ? 'end_of_results' : raw.hasNextPage ? 'next_page_query_unverified' : 'coverage_not_proven',
  };
}

function reviewPageInfo(raw, { requestedCursor, returned }) {
  if (!isRecord(raw) || !safeCount(raw.currentCount) || raw.size !== 3 ||
      typeof raw.hasNextPage !== 'boolean' || typeof raw.hasPrevPage !== 'boolean' ||
      !safeText(raw.paginationType, 80)) return null;
  const totalCount = raw.totalCount === null || raw.totalCount === undefined ? null
    : safeCount(raw.totalCount) ? raw.totalCount : null;
  if (raw.totalCount !== null && raw.totalCount !== undefined && totalCount === null) return null;
    const nextCursor = safeReviewCursor(raw.nextCursor) ? raw.nextCursor : null;
    const prevCursor = safeReviewCursor(raw.prevCursor) ? raw.prevCursor : null;
  if (raw.hasNextPage && nextCursor === null) return null;
  const complete = requestedCursor === null && raw.hasNextPage === false && totalCount !== null &&
    raw.currentCount === totalCount && returned === totalCount;
  return {
    size: raw.size,
    currentCount: raw.currentCount,
    returned,
    totalCount,
    hasNextPage: raw.hasNextPage,
    hasPrevPage: raw.hasPrevPage,
    nextCursor,
    nextCursorAvailable: nextCursor !== null,
    previousCursorAvailable: prevCursor !== null,
    resumedFromCursor: requestedCursor !== null,
    complete,
    reason: complete ? 'end_of_results' : raw.hasNextPage ? 'more_pages_available' :
      requestedCursor !== null ? 'resumed_tail_only' : totalCount === null ? 'total_count_not_reported' : 'coverage_not_proven',
  };
}

function requestReceipt(request) {
  return {
    method: request.method,
    origin: request.origin,
    path: request.path,
    queryFields: [...request.queryFields],
    httpStatus: request.httpStatus,
    mime: request.mime,
    responseBytes: request.responseBytes,
    responseSha256: request.responseSha256,
    checkedAt: request.checkedAt,
    browserUsed: false,
    anonymous: true,
    credentialsUsed: false,
    cookiesSent: false,
  };
}

function responseData(payload, request, code) {
  if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.response)) {
    fail(`SOOMGO_${code}_SCHEMA_INVALID`, requestReceipt(request));
  }
  return payload.response;
}

function serviceSummary(value) {
  if (!isRecord(value)) return null;
  const id = numericId(value.id);
  const name = safeText(value.name ?? value.title, 160) ? (value.name ?? value.title) : null;
  if (!id || !name) return null;
  return {
    id,
    name,
    slug: safeText(value.slug, 200) ? value.slug : null,
  };
}

function profilePagination(raw, { requestedSize, returned }) {
  if (!isRecord(raw) || !safeCount(raw.currentCount) || !safeCount(raw.size) ||
      typeof raw.hasNextPage !== 'boolean' || typeof raw.hasPrevPage !== 'boolean' ||
      !safeText(raw.paginationType, 80)) return null;
  const totalCount = raw.totalCount === null || raw.totalCount === undefined ? null
    : safeCount(raw.totalCount) ? raw.totalCount : null;
  if (raw.totalCount !== null && raw.totalCount !== undefined && totalCount === null) return null;
  const nextCursor = safeText(raw.nextCursor, 8192) ? raw.nextCursor : null;
  const prevCursor = safeText(raw.prevCursor, 8192) ? raw.prevCursor : null;
  return {
    size: raw.size,
    requestedSize,
    returned,
    currentCount: raw.currentCount,
    totalCount,
    hasNextPage: raw.hasNextPage,
    hasPrevPage: raw.hasPrevPage,
    nextCursorAvailable: nextCursor !== null,
    previousCursorAvailable: prevCursor !== null,
    cursorReplayVerified: false,
    complete: raw.hasNextPage === false,
    reason: raw.hasNextPage ? 'next_page_query_unverified' : 'end_of_results',
  };
}

export function createSoomgoProfileClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('SOOMGO_PROFILE_CONFIGURATION_INVALID');

  async function request(path, query = []) {
    return commerceJsonRequest({
      service: 'soomgo',
      origin: SOOMGO_ORIGIN,
      path,
      query,
      fetchImpl,
      now,
      userAgent: USER_AGENT,
      maxBytes: MAX_RESPONSE_BYTES,
      timeoutMs: 20_000,
    });
  }

  async function readReviewPage({ userId, nextCursor = null }) {
    const normalizedUserId = numericId(userId);
    const cursor = nextCursor === null || nextCursor === undefined ? null : safeReviewCursor(nextCursor);
    if (!normalizedUserId) fail('SOOMGO_PROFILE_USER_ID_INVALID');
    if (nextCursor !== null && nextCursor !== undefined && cursor === null) fail('SOOMGO_PROFILE_REVIEW_CURSOR_INVALID');
    const query = cursor === null
      ? [['size', String(REVIEW_SIZE)], ['role', 'provider']]
      : [['next_cursor', cursor], ...REVIEW_CONTINUATION_QUERY];
    const { payload, request: rawRequest } = await request(`/v3/users/${normalizedUserId}/reviews/received`, query);
    const raw = responseData(payload, rawRequest, 'PROFILE_REVIEWS');
    if (!Array.isArray(raw.items) || raw.items.length > REVIEW_SIZE || !isRecord(raw.pagination)) {
      fail('SOOMGO_PROFILE_REVIEWS_SCHEMA_INVALID', requestReceipt(rawRequest));
    }
    const reviewIds = raw.items.map((item) => isRecord(item) ? opaqueId(item.id) : null);
    if (reviewIds.some((id) => id === null)) fail('SOOMGO_PROFILE_REVIEWS_SCHEMA_INVALID', requestReceipt(rawRequest));
    const items = raw.items.map((item) => {
      if (!isRecord(item) || !safeRating(item.rating) || !safeText(item.createdAt, 64) ||
          typeof item.soomgopayVerified !== 'boolean' || typeof item.singleMatchPayVerified !== 'boolean' ||
          !Array.isArray(item.imageInfos)) return null;
      const service = item.service === null || item.service === undefined ? null : serviceSummary(item.service);
      if (item.service !== null && item.service !== undefined && !service) return null;
      const reviewText = optionalPublicText(item.content, {
        maxLength: 12_000, request: rawRequest, code: 'SOOMGO_PROFILE_REVIEWS_SCHEMA_INVALID',
      });
      return {
        rating: item.rating,
        createdAt: item.createdAt,
        reviewText,
        service,
        verifiedPayment: { soomgoPay: item.soomgopayVerified, singleMatch: item.singleMatchPayVerified },
        imageCount: item.imageInfos.length,
      };
    });
    if (items.some((item) => item === null)) fail('SOOMGO_PROFILE_REVIEWS_SCHEMA_INVALID', requestReceipt(rawRequest));

    const pagination = raw.pagination;
    if (pagination.size !== REVIEW_SIZE || typeof pagination.hasNextPage !== 'boolean' ||
        typeof pagination.hasPrevPage !== 'boolean' || !safeCount(pagination.currentCount) ||
        !safeText(pagination.paginationType, 80)) {
      fail('SOOMGO_PROFILE_REVIEWS_SCHEMA_INVALID', requestReceipt(rawRequest));
    }
    const responseCursor = safeReviewCursor(pagination.nextCursor);
    if (pagination.hasNextPage && responseCursor === null) {
      fail('SOOMGO_PROFILE_REVIEWS_SCHEMA_INVALID', requestReceipt(rawRequest));
    }
    const totalCount = pagination.totalCount === null || pagination.totalCount === undefined ? null
      : safeCount(pagination.totalCount) ? pagination.totalCount : null;
    if (pagination.totalCount !== null && pagination.totalCount !== undefined && totalCount === null) {
      fail('SOOMGO_PROFILE_REVIEWS_SCHEMA_INVALID', requestReceipt(rawRequest));
    }

    return {
      page: {
        schemaVersion: 1,
        service: 'soomgo',
        operation: 'profile_reviews',
        observedAt: rawRequest.checkedAt,
        identity: { userId: normalizedUserId, pathBound: true, authenticated: false, ownerVerified: false },
        filters: {
          size: REVIEW_SIZE,
          role: 'provider',
          ...(cursor === null ? {} : {
            isPhotoReview: false,
            isPayVerified: false,
            sortType: 'latest',
          }),
        },
        items,
        pagination: {
          size: REVIEW_SIZE,
          currentCount: pagination.currentCount,
          returned: items.length,
          totalCount,
          hasNextPage: pagination.hasNextPage,
          hasPrevPage: pagination.hasPrevPage,
          nextCursor: pagination.hasNextPage ? responseCursor : null,
          nextCursorAvailable: pagination.hasNextPage && responseCursor !== null,
          resumedFromCursor: cursor !== null,
          complete: cursor === null && pagination.hasNextPage === false && totalCount !== null &&
            pagination.currentCount === totalCount && items.length === totalCount,
          reason: pagination.hasNextPage ? 'more_pages_available' :
            cursor !== null ? 'resumed_tail_only' : totalCount === null ? 'total_count_not_reported' : 'coverage_not_proven',
        },
        requests: [requestReceipt(rawRequest)],
        contractProvenance: [API_SOURCE, REVIEW_PAGE_SOURCE],
      },
      reviewIds,
    };
  }

  return Object.freeze({
    async getProfile({ userId, expectedProviderId } = {}) {
      const normalizedUserId = numericId(userId);
      const normalizedExpectedProviderId = expectedProviderId === undefined || expectedProviderId === null
        ? null : numericId(expectedProviderId);
      if (!normalizedUserId || (expectedProviderId !== undefined && expectedProviderId !== null && !normalizedExpectedProviderId)) {
        fail('SOOMGO_PROFILE_USER_ID_INVALID');
      }
      const { payload, request: rawRequest } = await request(
        `/v2/user/${normalizedUserId}/profile`, [['role', 'provider']],
      );
      const raw = responseData(payload, rawRequest, 'PROFILE');
      const providerId = numericId(raw.providerId);
      if (!providerId || (raw.nickName !== null && raw.nickName !== undefined && !safeText(raw.nickName, 200)) ||
          (raw.role !== null && raw.role !== undefined && !safeText(raw.role, 40)) ||
          !Array.isArray(raw.services)) fail('SOOMGO_PROFILE_SCHEMA_INVALID', requestReceipt(rawRequest));
      if (normalizedExpectedProviderId && providerId !== normalizedExpectedProviderId) {
        fail('SOOMGO_PROFILE_PROVIDER_MISMATCH', requestReceipt(rawRequest));
      }
      const services = raw.services.map(serviceSummary);
      if (services.some((service) => service === null)) fail('SOOMGO_PROFILE_SCHEMA_INVALID', requestReceipt(rawRequest));
      const mainService = raw.mainService === null || raw.mainService === undefined ? null : serviceSummary(raw.mainService);
      if (raw.mainService !== null && raw.mainService !== undefined && mainService === null) {
        fail('SOOMGO_PROFILE_SCHEMA_INVALID', requestReceipt(rawRequest));
      }
      const nullableCount = (key) => {
        const value = raw[key];
        return value === null || value === undefined ? null : safeCount(value) ? value : undefined;
      };
      const reviewCount = nullableCount('reviewCount');
      const hireCount = nullableCount('hireCount');
      const recentHireCount = nullableCount('recentHireCount');
      if (reviewCount === undefined || hireCount === undefined || recentHireCount === undefined) {
        fail('SOOMGO_PROFILE_SCHEMA_INVALID', requestReceipt(rawRequest));
      }
      if (raw.reviewTotalRating !== null && raw.reviewTotalRating !== undefined && !finiteMetric(raw.reviewTotalRating)) {
        fail('SOOMGO_PROFILE_SCHEMA_INVALID', requestReceipt(rawRequest));
      }
      if (raw.avgResponseTime !== null && raw.avgResponseTime !== undefined && raw.avgResponseTime !== -1 &&
          !safeCount(raw.avgResponseTime)) fail('SOOMGO_PROFILE_SCHEMA_INVALID', requestReceipt(rawRequest));
      if (raw.hasApprovedLicenseBadge !== null && raw.hasApprovedLicenseBadge !== undefined &&
          typeof raw.hasApprovedLicenseBadge !== 'boolean') fail('SOOMGO_PROFILE_SCHEMA_INVALID', requestReceipt(rawRequest));
      const introduction = optionalPublicText(raw.intro, {
        maxLength: 12_000, request: rawRequest, code: 'SOOMGO_PROFILE_SCHEMA_INVALID',
      });
      const serviceDescription = optionalPublicText(raw.serviceDescription, {
        maxLength: 24_000, request: rawRequest, code: 'SOOMGO_PROFILE_SCHEMA_INVALID',
      });

      return {
        schemaVersion: 1,
        service: 'soomgo',
        operation: 'profile',
        observedAt: rawRequest.checkedAt,
        identity: {
          userId: normalizedUserId,
          providerId,
          expectedProviderId: normalizedExpectedProviderId,
          providerMatchVerified: normalizedExpectedProviderId !== null && providerId === normalizedExpectedProviderId,
          authenticated: false,
          ownerVerified: false,
        },
        profile: {
          displayName: redactedPublicText(raw.nickName),
          role: raw.role ?? null,
          introduction,
          serviceDescription,
          mainService,
          services,
          avgResponseTimeSeconds: raw.avgResponseTime === -1 ? null : raw.avgResponseTime ?? null,
          reviewCount,
          reviewTotalRatingSourceValue: raw.reviewTotalRating ?? null,
          hireCount,
          recentHireCount,
          hasApprovedLicenseBadge: raw.hasApprovedLicenseBadge ?? null,
        },
        requests: [requestReceipt(rawRequest)],
        contractProvenance: [PROFILE_PAGE_SOURCE, API_SOURCE],
      };
    },

    async getProfileContents({ userId } = {}) {
      const normalizedUserId = numericId(userId);
      if (!normalizedUserId) fail('SOOMGO_PROFILE_USER_ID_INVALID');
      const { payload, request: rawRequest } = await request(`/v1/providers/${normalizedUserId}/profile-contents`);
      const raw = responseData(payload, rawRequest, 'PROFILE_CONTENTS');
      if (!Array.isArray(raw.items) || raw.items.length > 500) {
        fail('SOOMGO_PROFILE_CONTENTS_SCHEMA_INVALID', requestReceipt(rawRequest));
      }
      const items = raw.items.map((item) => {
        if (!isRecord(item) || !opaqueId(item.contentId) || !safeText(item.contentType, 60) ||
            !safeCount(item.sequence) || typeof item.contentUrl !== 'string' || typeof item.thumbnailUrl !== 'string') return null;
        return {
          contentId: String(item.contentId),
          contentType: item.contentType,
          sequence: item.sequence,
          hasContent: item.contentUrl.length > 0,
          hasThumbnail: item.thumbnailUrl.length > 0,
        };
      });
      if (items.some((item) => item === null)) fail('SOOMGO_PROFILE_CONTENTS_SCHEMA_INVALID', requestReceipt(rawRequest));
      return {
        schemaVersion: 1,
        service: 'soomgo',
        operation: 'profile_contents',
        observedAt: rawRequest.checkedAt,
        identity: { userId: normalizedUserId, pathBound: true, authenticated: false, ownerVerified: false },
        items,
        coverage: { returned: items.length, totalCount: null, complete: false, reason: 'pagination_not_reported' },
        requests: [requestReceipt(rawRequest)],
        contractProvenance: [PROFILE_PAGE_SOURCE, API_SOURCE],
      };
    },

    async getProfilePortfolios({ userId, size = 8, nextCursor = null } = {}) {
      const normalizedUserId = numericId(userId);
      const cursor = nextCursor === null || nextCursor === undefined ? null : safeReviewCursor(nextCursor);
      if (!normalizedUserId) fail('SOOMGO_PROFILE_USER_ID_INVALID');
      if (![4, 8].includes(size)) fail('SOOMGO_PROFILE_PORTFOLIO_SIZE_INVALID');
      if (nextCursor !== null && nextCursor !== undefined && cursor === null) fail('SOOMGO_PROFILE_PORTFOLIO_CURSOR_INVALID');
      if (cursor !== null && size !== PORTFOLIO_PAGE_SOURCE.continuationSize) {
        fail('SOOMGO_PROFILE_PORTFOLIO_CONTINUATION_UNVERIFIED');
      }
      const query = [['size', String(size)], ...(cursor === null ? [] : [['next_cursor', cursor]])];
      const { payload, request: rawRequest } = await request(`/v2/users/${normalizedUserId}/portfolios`, query);
      const raw = responseData(payload, rawRequest, 'PROFILE_PORTFOLIOS');
      if (!Array.isArray(raw.items) || raw.items.length > size || !isRecord(raw.pagination)) {
        fail('SOOMGO_PROFILE_PORTFOLIOS_SCHEMA_INVALID', requestReceipt(rawRequest));
      }
      const items = raw.items.map((item) => {
        if (!isRecord(item) || !opaqueId(item.id) || !Array.isArray(item.images)) return null;
        if ((item.title !== null && item.title !== undefined && !safeText(item.title, 500)) ||
            (item.mediaType !== null && item.mediaType !== undefined && !safeText(item.mediaType, 60)) ||
            (item.serviceInfo !== null && item.serviceInfo !== undefined && !serviceSummary(item.serviceInfo))) return null;
        for (const key of ['likeCount', 'viewCount']) {
          if (item[key] !== null && item[key] !== undefined && !safeCount(item[key])) return null;
        }
        for (const key of ['createdAt', 'updatedAt']) {
          if (item[key] !== null && item[key] !== undefined && !safeText(item[key], 64)) return null;
        }
        return {
          portfolioId: String(item.id),
          title: redactedPublicText(item.title),
          mediaType: item.mediaType ?? null,
          createdAt: item.createdAt ?? null,
          updatedAt: item.updatedAt ?? null,
          service: item.serviceInfo ? serviceSummary(item.serviceInfo) : null,
          imageCount: item.images.length,
          hasMainImage: item.mainImage !== null && item.mainImage !== undefined,
          hasVideo: item.video !== null && item.video !== undefined,
          likeCount: item.likeCount ?? null,
          viewCount: item.viewCount ?? null,
        };
      });
      if (items.some((item) => item === null)) fail('SOOMGO_PROFILE_PORTFOLIOS_SCHEMA_INVALID', requestReceipt(rawRequest));
      const pagination = profilePageInfo(raw.pagination, { requestedSize: size, returned: items.length });
      if (!pagination) fail('SOOMGO_PROFILE_PORTFOLIOS_SCHEMA_INVALID', requestReceipt(rawRequest));
      const responseCursor = safeReviewCursor(raw.pagination.nextCursor);
      if (raw.pagination.hasNextPage && responseCursor === null) {
        fail('SOOMGO_PROFILE_PORTFOLIOS_SCHEMA_INVALID', requestReceipt(rawRequest));
      }
      pagination.nextCursorAvailable = raw.pagination.hasNextPage && responseCursor !== null;
      pagination.nextCursor = size === PORTFOLIO_PAGE_SOURCE.continuationSize && raw.pagination.hasNextPage
        ? responseCursor : null;
      pagination.resumedFromCursor = cursor !== null;
      pagination.cursorReplayVerified = size === PORTFOLIO_PAGE_SOURCE.continuationSize;
      pagination.complete = cursor === null && raw.pagination.hasNextPage === false &&
        pagination.totalCount !== null && items.length === pagination.totalCount;
      pagination.reason = pagination.complete ? 'end_of_results' : raw.pagination.hasNextPage
        ? size === PORTFOLIO_PAGE_SOURCE.continuationSize ? 'more_pages_available' : 'portfolio_cursor_requires_size_8'
        : cursor !== null ? 'resumed_tail_only' : pagination.totalCount === null ? 'total_count_not_reported' : 'count_mismatch';
      return {
        schemaVersion: 1,
        service: 'soomgo',
        operation: 'profile_portfolios',
        observedAt: rawRequest.checkedAt,
        identity: { userId: normalizedUserId, pathBound: true, authenticated: false, ownerVerified: false },
        items,
        pagination,
        requests: [requestReceipt(rawRequest)],
        contractProvenance: [PROFILE_PAGE_SOURCE, API_SOURCE, PORTFOLIO_PAGE_SOURCE],
      };
    },

    async collectProfilePortfolios({ userId, size = 8, maxPages = 2, nextCursor = null } = {}) {
      const normalizedUserId = numericId(userId);
      const startingCursor = nextCursor === null || nextCursor === undefined ? null : safeReviewCursor(nextCursor);
      if (!normalizedUserId) fail('SOOMGO_PROFILE_USER_ID_INVALID');
      if (![4, 8].includes(size)) fail('SOOMGO_PROFILE_PORTFOLIO_SIZE_INVALID');
      if (!safeCount(maxPages) || maxPages < 1 || maxPages > 5) fail('SOOMGO_PROFILE_PORTFOLIO_PAGE_LIMIT_INVALID');
      if (nextCursor !== null && nextCursor !== undefined && startingCursor === null) {
        fail('SOOMGO_PROFILE_PORTFOLIO_CURSOR_INVALID');
      }
      if (size !== PORTFOLIO_PAGE_SOURCE.continuationSize && (maxPages > 1 || startingCursor !== null)) {
        fail('SOOMGO_PROFILE_PORTFOLIO_CONTINUATION_UNVERIFIED');
      }

      const pages = [];
      const requests = [];
      const items = [];
      const portfolioIds = new Set();
      const seenCursors = new Set(startingCursor === null ? [] : [startingCursor]);
      let totalCount = null;
      let totalCountKnown = null;
      let currentCursor = startingCursor;
      let sourceHasNextPage = false;

      for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
        const page = await this.getProfilePortfolios({ userId: normalizedUserId, size,
          ...(currentCursor === null ? {} : { nextCursor: currentCursor }) });
        pages.push({ observedAt: page.observedAt, returned: page.items.length,
          cursorUsed: currentCursor !== null, hasNextPage: page.pagination.hasNextPage });
        requests.push(...page.requests);
        const pageTotal = page.pagination.totalCount;
        if (totalCountKnown === null) {
          totalCountKnown = pageTotal !== null;
          totalCount = pageTotal;
        } else if (totalCountKnown !== (pageTotal !== null) || (pageTotal !== null && totalCount !== pageTotal)) {
          fail('SOOMGO_PROFILE_PORTFOLIO_TOTAL_CHANGED', requests.at(-1));
        }
        for (const item of page.items) {
          if (portfolioIds.has(item.portfolioId)) fail('SOOMGO_PROFILE_PORTFOLIO_DUPLICATE', requests.at(-1));
          portfolioIds.add(item.portfolioId);
          items.push(item);
        }
        sourceHasNextPage = page.pagination.hasNextPage;
        if (!sourceHasNextPage) { currentCursor = null; break; }
        const returnedCursor = page.pagination.nextCursor;
        if (!returnedCursor && size !== PORTFOLIO_PAGE_SOURCE.continuationSize) {
          currentCursor = null;
          break;
        }
        if (!returnedCursor || seenCursors.has(returnedCursor)) {
          fail('SOOMGO_PROFILE_PORTFOLIO_CURSOR_REPEATED', requests.at(-1));
        }
        seenCursors.add(returnedCursor);
        currentCursor = returnedCursor;
      }

      const hasNextPage = sourceHasNextPage;
      const resumedFromCursor = startingCursor !== null;
      const complete = !resumedFromCursor && !hasNextPage && totalCount !== null && items.length === totalCount;
      return {
        schemaVersion: 1,
        service: 'soomgo',
        operation: 'profile_portfolios_collect',
        observedAt: pages.at(-1)?.observedAt ?? new Date(now()).toISOString(),
        identity: { userId: normalizedUserId, pathBound: true, authenticated: false, ownerVerified: false },
        filters: { size },
        items,
        pagination: {
          size,
          pages: pages.length,
          returned: items.length,
          totalCount,
          hasNextPage,
          nextCursor: currentCursor,
          nextCursorAvailable: currentCursor !== null,
          resumedFromCursor,
          complete,
          reason: complete ? 'end_of_results' : hasNextPage && currentCursor === null ? 'portfolio_cursor_requires_size_8' : hasNextPage ? 'page_limit_reached' :
            resumedFromCursor ? 'resumed_tail_only' : totalCount === null ? 'total_count_not_reported' : 'count_mismatch',
        },
        pages,
        requests,
        contractProvenance: [PROFILE_PAGE_SOURCE, API_SOURCE, PORTFOLIO_PAGE_SOURCE],
      };
    },

    async getProfileReviews({ userId, nextCursor } = {}) {
      return (await readReviewPage({ userId, nextCursor })).page;
    },

    async collectProfileReviews({ userId, maxPages = 2, nextCursor = null } = {}) {
      const normalizedUserId = numericId(userId);
      const startingCursor = nextCursor === null || nextCursor === undefined ? null : safeReviewCursor(nextCursor);
      if (!normalizedUserId) fail('SOOMGO_PROFILE_USER_ID_INVALID');
      if (nextCursor !== null && nextCursor !== undefined && startingCursor === null) {
        fail('SOOMGO_PROFILE_REVIEW_CURSOR_INVALID');
      }
      if (!safeCount(maxPages) || maxPages < 1 || maxPages > 5) fail('SOOMGO_PROFILE_REVIEW_PAGE_LIMIT_INVALID');

      const pages = [];
      const requests = [];
      const items = [];
      const reviewIds = new Set();
      const seenCursors = new Set(startingCursor === null ? [] : [startingCursor]);
      let totalCount = null;
      let totalCountKnown = null;
      let currentCursor = startingCursor;

      for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
        const { page, reviewIds: rawIds } = await readReviewPage({ userId: normalizedUserId, nextCursor: currentCursor });
        pages.push({
          observedAt: page.observedAt,
          returned: page.items.length,
          cursorUsed: currentCursor !== null,
          hasNextPage: page.pagination.hasNextPage,
        });
        requests.push(...page.requests);
        const pageTotal = page.pagination.totalCount;
        if (totalCountKnown === null) {
          totalCountKnown = pageTotal !== null;
          totalCount = pageTotal;
        } else if (totalCountKnown !== (pageTotal !== null) ||
          (pageTotal !== null && totalCount !== pageTotal)) {
          fail('SOOMGO_PROFILE_REVIEW_TOTAL_CHANGED', requests.at(-1));
        }

        for (const [index, item] of page.items.entries()) {
          const reviewId = rawIds[index];
          if (reviewIds.has(reviewId)) fail('SOOMGO_PROFILE_REVIEW_DUPLICATE', requests.at(-1));
          reviewIds.add(reviewId);
          items.push(item);
        }

        const returnedCursor = page.pagination.nextCursor;
        if (!page.pagination.hasNextPage) { currentCursor = null; break; }
        if (!returnedCursor || seenCursors.has(returnedCursor)) {
          fail('SOOMGO_PROFILE_REVIEW_CURSOR_REPEATED', requests.at(-1));
        }
        seenCursors.add(returnedCursor);
        currentCursor = returnedCursor;
      }

      const hasNextPage = currentCursor !== null;
      const resumedFromCursor = startingCursor !== null;
      const complete = !resumedFromCursor && !hasNextPage && totalCount !== null && items.length === totalCount;
      return {
        schemaVersion: 1,
        service: 'soomgo',
        operation: 'profile_reviews_collect',
        observedAt: pages.at(-1)?.observedAt ?? new Date(now()).toISOString(),
        identity: { userId: normalizedUserId, pathBound: true, authenticated: false, ownerVerified: false },
        filters: { size: REVIEW_SIZE, role: 'provider', sortType: 'latest', isPhotoReview: false, isPayVerified: false },
        items,
        pagination: {
          size: REVIEW_SIZE,
          pages: pages.length,
          returned: items.length,
          totalCount,
          hasNextPage,
          nextCursor: currentCursor,
          nextCursorAvailable: currentCursor !== null,
          resumedFromCursor,
          complete,
          reason: complete ? 'end_of_results' : hasNextPage ? 'page_limit_reached' :
            resumedFromCursor ? 'resumed_tail_only' : totalCount === null ? 'total_count_not_reported' : 'count_mismatch',
        },
        pages,
        requests,
        contractProvenance: [API_SOURCE, REVIEW_PAGE_SOURCE],
      };
    },
  });
}
