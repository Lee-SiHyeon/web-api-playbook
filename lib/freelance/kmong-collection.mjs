import { createHash } from 'node:crypto';

const SEARCH_PAGE_SIZE = 40;
const REVIEW_PAGE_SIZE = 5;
const MAX_PAGES_PER_CALL = 5;
const KMONG_WEB_ORIGIN = 'https://kmong.com';
const KMONG_API_ORIGIN = 'https://api.kmong.com';
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const COLLECTION_SOURCE = Object.freeze({
  search: {
    kind: 'first_party_bundle',
    sourceURL: KMONG_WEB_ORIGIN + '/_next-market-desktop/_next/static/chunks/0g7pmw2wpij3i.js',
  },
  reviews: {
    kind: 'first_party_document',
    discoveryBasis: 'review_link_embedded_in_first_party_detail_document',
  },
});

const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max = 20_000) => typeof value === 'string' && value.length <= max && !CONTROL.test(value);
const isIsoDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const isPositiveId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);

export class KmongCollectionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'KmongCollectionError';
    this.code = code;
    this.service = 'kmong';
  }
}

const fail = code => { throw new KmongCollectionError('KMONG_COLLECTION_' + code); };

function checkedAt(now) {
  let value;
  try { value = now(); } catch { fail('CLOCK_INVALID'); }
  const millis = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(millis)) fail('CLOCK_INVALID');
  try { return new Date(millis).toISOString(); } catch { fail('CLOCK_INVALID'); }
}

function normalizeKeyword(value) {
  if (!isText(value, 120)) fail('SEARCH_KEYWORD_INVALID');
  const keyword = value.replace(/\s+/g, ' ').trim();
  if (!keyword) fail('SEARCH_KEYWORD_INVALID');
  return keyword;
}

function normalizeGigId(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (!isPositiveId(id)) fail('GIG_ID_INVALID');
  return id;
}

function validateMaxPages(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGES_PER_CALL) {
    fail('MAX_PAGES_INVALID');
  }
  return value;
}

function exactKeys(value, required, optional = []) {
  if (!object(value)) return false;
  const keys = Object.keys(value);
  return required.every(key => own(value, key)) && keys.every(key => required.includes(key) || optional.includes(key));
}

function safeContractProvenance(value) {
  if (!object(value)) return undefined;
  const result = {};
  for (const key of ['kind', 'sourceURL', 'runtimeConfigurationSource', 'discoveryBasis', 'routeRebase', 'method']) {
    if (isText(value[key], 1_000)) result[key] = value[key];
  }
  if (Array.isArray(value.queryFields) && value.queryFields.length <= 32 &&
      value.queryFields.every(field => typeof field === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field))) {
    result.queryFields = [...new Set(value.queryFields)].sort();
  }
  return Object.keys(result).length ? result : undefined;
}

function sanitizeReceipt(receipt) {
  if (!object(receipt)) return null;
  if (!['https://kmong.com', 'https://api.kmong.com'].includes(receipt.origin) ||
      typeof receipt.path !== 'string' || !/^\/[A-Za-z0-9_./-]{0,500}$/.test(receipt.path)) return null;
  const clean = {
    method: receipt.method === 'GET' ? 'GET' : null,
    origin: receipt.origin,
    path: receipt.path,
    queryFields: Array.isArray(receipt.queryFields) && receipt.queryFields.length <= 32 &&
      receipt.queryFields.every(field => typeof field === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field))
      ? [...new Set(receipt.queryFields)].sort() : [],
    observedAt: isIsoDate(receipt.observedAt) ? receipt.observedAt : null,
    browserUsed: receipt.browserUsed === false ? false : null,
    authenticated: receipt.authenticated === false ? false : null,
    credentialsUsed: receipt.credentialsUsed === false ? false : null,
    cookiesSent: receipt.cookiesSent === false ? false : null,
    readOnly: receipt.readOnly === true ? true : null,
    responseURL: receipt.responseURL === receipt.origin + receipt.path ? receipt.responseURL : receipt.origin + receipt.path,
    redirectFollowed: receipt.redirectFollowed === false ? false : null,
  };
  if (Number.isSafeInteger(receipt.httpStatus) && receipt.httpStatus >= 100 && receipt.httpStatus <= 599) {
    clean.httpStatus = receipt.httpStatus;
  }
  if (isText(receipt.mime, 100)) clean.mime = receipt.mime;
  if (Number.isSafeInteger(receipt.responseBytes) && receipt.responseBytes >= 0) clean.responseBytes = receipt.responseBytes;
  if (typeof receipt.responseSha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.responseSha256)) {
    clean.responseSha256 = receipt.responseSha256;
  }
  if (typeof receipt.causeCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(receipt.causeCode)) clean.causeCode = receipt.causeCode;
  const provenance = safeContractProvenance(receipt.contractProvenance);
  if (provenance) clean.contractProvenance = provenance;
  return clean;
}

function receiptIsSafe(receipt) {
  if (!object(receipt)) return false;
  const allowed = new Set([
    'method', 'origin', 'path', 'queryFields', 'observedAt', 'browserUsed', 'authenticated',
    'credentialsUsed', 'cookiesSent', 'readOnly', 'responseURL', 'redirectFollowed', 'httpStatus',
    'mime', 'responseBytes', 'responseSha256', 'causeCode', 'contractProvenance',
  ]);
  const normalized = sanitizeReceipt(receipt);
  const noResponse = receipt.httpStatus === undefined;
  return Object.keys(receipt).every(key => allowed.has(key)) && normalized !== null &&
    receipt.method === 'GET' && receipt.observedAt !== null &&
    receipt.browserUsed === false && receipt.authenticated === false &&
    receipt.credentialsUsed === false && receipt.cookiesSent === false && receipt.readOnly === true &&
    (receipt.redirectFollowed === false || noResponse && receipt.redirectFollowed === null) &&
    receipt.responseURL === receipt.origin + receipt.path &&
    Array.isArray(receipt.queryFields) && receipt.queryFields.length === normalized.queryFields.length &&
    receipt.queryFields.every((field, index) => field === normalized.queryFields[index]) &&
    (!noResponse || !own(receipt, 'mime') && !own(receipt, 'responseBytes') && !own(receipt, 'responseSha256')) &&
    (!own(receipt, 'contractProvenance') ||
      JSON.stringify(receipt.contractProvenance) === JSON.stringify(normalized.contractProvenance));
}

function normalizeSearchItem(item) {
  if (!exactKeys(item,
    ['id', 'title', 'url', 'startingPrice', 'reviewSummary', 'isPrime', 'isQualityGuaranteed', 'hasPackages', 'hasVideos'],
    ['category', 'sellerDisplayName'])) return null;
  if (!isPositiveId(item.id) || !isText(item.title, 1_000) ||
      item.url !== KMONG_WEB_ORIGIN + '/gig/' + item.id ||
      !exactKeys(item.startingPrice, ['amount', 'currency', 'basis', 'exactCheckoutAmount']) ||
      !Number.isSafeInteger(item.startingPrice.amount) || item.startingPrice.amount < 0 ||
      item.startingPrice.currency !== 'KRW' || item.startingPrice.basis !== 'displayed_starting_price' ||
      item.startingPrice.exactCheckoutAmount !== false ||
      ![null, true, false].includes(item.isPrime) || ![null, true, false].includes(item.isQualityGuaranteed) ||
      ![null, true, false].includes(item.hasPackages) || ![null, true, false].includes(item.hasVideos)) return null;
  if (item.reviewSummary !== null && (!exactKeys(item.reviewSummary, ['average', 'count', 'source']) ||
      typeof item.reviewSummary.average !== 'number' || item.reviewSummary.average < 0 || item.reviewSummary.average > 5 ||
      !Number.isSafeInteger(item.reviewSummary.count) || item.reviewSummary.count < 0 ||
      item.reviewSummary.source !== 'search_gig_review_summary')) return null;
  if (own(item, 'sellerDisplayName') && !isText(item.sellerDisplayName, 500)) return null;
  if (own(item, 'category')) {
    if (!object(item.category) || !Object.keys(item.category).length || Object.keys(item.category).some(key =>
      !['rootCategoryId', 'rootCategoryName', 'subCategoryId', 'subCategoryName', 'thirdCategoryId', 'thirdCategoryName'].includes(key)) ||
      Object.values(item.category).some(value => !isText(value, 300))) return null;
  }
  return item;
}

function normalizeReviewItem(item) {
  if (!exactKeys(item, ['rating', 'body', 'createdAt'], ['sellerResponse']) ||
      typeof item.rating !== 'number' || item.rating < 0 || item.rating > 5 ||
      !isText(item.body, 20_000) || !(item.createdAt === null || isText(item.createdAt, 100))) return null;
  if (own(item, 'sellerResponse') && (!exactKeys(item.sellerResponse, ['body', 'createdAt']) ||
      !isText(item.sellerResponse.body, 20_000) ||
      !(item.sellerResponse.createdAt === null || isText(item.sellerResponse.createdAt, 100)))) return null;
  return item;
}

function reviewFingerprint(item) {
  const body = item.body.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(JSON.stringify([item.rating, item.createdAt, body])).digest('hex');
}

function itemIdentity(operation, item) {
  return operation === 'search' ? item.id : reviewFingerprint(item);
}

function expectedScope(operation, input) {
  if (!object(input)) fail('STATE_SCOPE_INVALID');
  if (operation === 'search') {
    if (!exactKeys(input, ['keyword', 'pageSize']) || input.pageSize !== SEARCH_PAGE_SIZE) fail('STATE_SCOPE_INVALID');
    const keyword = normalizeKeyword(input.keyword);
    if (keyword !== input.keyword) fail('STATE_SCOPE_INVALID');
    return { keyword, pageSize: SEARCH_PAGE_SIZE };
  }
  if (operation === 'reviews') {
    if (!exactKeys(input, ['gigId', 'pageSize']) || input.pageSize !== REVIEW_PAGE_SIZE) fail('STATE_SCOPE_INVALID');
    const gigId = normalizeGigId(input.gigId);
    if (gigId !== input.gigId) fail('STATE_SCOPE_INVALID');
    return { gigId, pageSize: REVIEW_PAGE_SIZE };
  }
  fail('OPERATION_INVALID');
}

function stateEmpty(operation, scope) {
  return {
    schemaVersion: 1,
    service: 'kmong',
    operation,
    scope,
    items: [],
    pages: [],
    requests: [],
    attempts: [],
    issues: [],
    nextPage: 1,
    totalItemCount: null,
    lastPage: null,
    complete: false,
    resumeAllowed: true,
  };
}

function assertStateShape(state, operation, scope) {
  if (!exactKeys(state, [
    'schemaVersion', 'service', 'operation', 'scope', 'items', 'pages', 'requests', 'attempts',
    'issues', 'nextPage', 'totalItemCount', 'lastPage', 'complete', 'resumeAllowed',
  ])) fail('STATE_INVALID');
  if (state.schemaVersion !== 1 || state.service !== 'kmong' || state.operation !== operation) fail('STATE_INVALID');
  if (!object(state.scope)) fail('STATE_INVALID');
  const actualScope = expectedScope(operation, state.scope);
  if (JSON.stringify(actualScope) !== JSON.stringify(scope)) fail('STATE_SCOPE_MISMATCH');
  if (!Array.isArray(state.items) || !Array.isArray(state.pages) || !Array.isArray(state.requests) ||
      !Array.isArray(state.attempts) || !Array.isArray(state.issues)) fail('STATE_INVALID');
  if (!state.requests.every(receiptIsSafe)) fail('STATE_RECEIPTS_INVALID');
  const itemValidator = operation === 'search' ? normalizeSearchItem : normalizeReviewItem;
  if (!state.items.every(item => itemValidator(item) === item)) fail('STATE_ITEMS_INVALID');
  if (!(state.complete ? state.nextPage === null : Number.isSafeInteger(state.nextPage) && state.nextPage >= 1) ||
      !(state.totalItemCount === null || (Number.isSafeInteger(state.totalItemCount) && state.totalItemCount >= 0)) ||
      !(state.lastPage === null || (Number.isSafeInteger(state.lastPage) && state.lastPage >= 0)) ||
      typeof state.complete !== 'boolean' || typeof state.resumeAllowed !== 'boolean') fail('STATE_INVALID');
  if (state.pages.length === 0) {
    if (state.items.length || state.totalItemCount !== null || state.lastPage !== null || state.nextPage !== 1 || state.complete) {
      fail('STATE_PAGE_CONTINUITY_INVALID');
    }
  } else {
    if (state.totalItemCount === null || state.lastPage === null ||
        (!state.complete && state.nextPage !== state.pages.length + 1)) {
      fail('STATE_PAGE_CONTINUITY_INVALID');
    }
    let itemCount = 0;
    let baselineTotal = null;
    let baselineLast = null;
    for (let index = 0; index < state.pages.length; index++) {
      const page = state.pages[index];
      if (!exactKeys(page, ['page', 'pageSize', 'totalItemCount', 'lastPage', 'itemCount', 'observedAt', 'requestIndexes']) ||
          page.page !== index + 1 || page.pageSize !== (operation === 'search' ? SEARCH_PAGE_SIZE : REVIEW_PAGE_SIZE) ||
          !Number.isSafeInteger(page.totalItemCount) || page.totalItemCount < 0 ||
          !Number.isSafeInteger(page.lastPage) || page.lastPage < 0 ||
          !Number.isSafeInteger(page.itemCount) || page.itemCount < 0 ||
          !isIsoDate(page.observedAt) || !Array.isArray(page.requestIndexes) ||
          !page.requestIndexes.every(i => Number.isSafeInteger(i) && i >= 0 && i < state.requests.length)) {
        fail('STATE_PAGES_INVALID');
      }
      if (baselineTotal === null) { baselineTotal = page.totalItemCount; baselineLast = page.lastPage; }
      if ((page.totalItemCount !== baselineTotal || page.lastPage !== baselineLast) && state.resumeAllowed) {
        fail('STATE_PAGINATION_DRIFT');
      }
      itemCount += page.itemCount;
    }
    if (itemCount !== state.items.length) fail('STATE_ITEM_COUNT_INVALID');
    if (state.resumeAllowed && (state.totalItemCount !== baselineTotal || state.lastPage !== baselineLast)) {
      fail('STATE_PAGINATION_DRIFT');
    }
    if (state.complete) {
      const expectedLast = state.totalItemCount === 0 ? 1 : state.lastPage;
      const unique = new Set(state.items.map(item => itemIdentity(operation, item)));
      if (!state.resumeAllowed || state.pages.length !== expectedLast || state.items.length !== state.totalItemCount ||
          unique.size !== state.items.length) fail('STATE_COMPLETION_INVALID');
    } else if (state.resumeAllowed && state.nextPage !== state.pages.length + 1) {
      fail('STATE_PAGE_CONTINUITY_INVALID');
    }
  }
  for (const attempt of state.attempts) {
    if (!exactKeys(attempt, ['page', 'code', 'observedAt', 'requestIndexes']) ||
        !Number.isSafeInteger(attempt.page) || attempt.page < 1 ||
        typeof attempt.code !== 'string' || !/^KMONG_[A-Z0-9_]{1,100}$/.test(attempt.code) ||
        !isIsoDate(attempt.observedAt) || !Array.isArray(attempt.requestIndexes) ||
        !attempt.requestIndexes.every(i => Number.isSafeInteger(i) && i >= 0 && i < state.requests.length)) {
      fail('STATE_ATTEMPTS_INVALID');
    }
  }
  for (const issue of state.issues) {
    if (!exactKeys(issue, ['code', 'page']) || typeof issue.code !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,100}$/.test(issue.code) || !Number.isSafeInteger(issue.page) || issue.page < 1) {
      fail('STATE_ISSUES_INVALID');
    }
  }
  if (state.complete && (!state.resumeAllowed || state.issues.length)) fail('STATE_COMPLETION_INVALID');
  if (state.resumeAllowed && state.issues.length) fail('STATE_RESUMABILITY_INVALID');
  if (!state.resumeAllowed && !state.issues.length && !state.attempts.some(attempt => attempt.page === state.nextPage)) {
    fail('STATE_RESUMABILITY_INVALID');
  }
  const seen = new Set();
  let hasDuplicate = false;
  for (const item of state.items) {
    const identity = itemIdentity(operation, item);
    if (seen.has(identity)) hasDuplicate = true;
    seen.add(identity);
  }
  if (hasDuplicate && state.resumeAllowed) fail('STATE_DUPLICATE_ITEMS');
  return true;
}

export function validateKmongCollectionState(state, { operation, scope } = {}) {
  const normalizedScope = expectedScope(operation, scope);
  assertStateShape(state, operation, normalizedScope);
  if (!state.resumeAllowed) fail('RESUME_DISABLED');
  return true;
}

function responseShape(result, operation, page, scope) {
  if (!object(result) || result.service !== 'kmong' || result.operation !== operation ||
      !Array.isArray(result.items) || !object(result.pagination)) return null;
  if (operation === 'search' && result.keyword !== scope.keyword) return null;
  if (operation === 'reviews' && result.gigId !== scope.gigId) return null;
  const pagination = result.pagination;
  const expectedPageSize = operation === 'search' ? SEARCH_PAGE_SIZE : REVIEW_PAGE_SIZE;
  if (pagination.page !== page || pagination.pageSize !== expectedPageSize ||
      !Number.isSafeInteger(pagination.totalItemCount) || pagination.totalItemCount < 0 ||
      !Number.isSafeInteger(pagination.lastPage) || pagination.lastPage < 0 ||
      typeof pagination.endReached !== 'boolean' ||
      pagination.nextPage !== (pagination.endReached ? null : page + 1) ||
      !isIsoDate(result.observedAt) || !Array.isArray(result.requests)) return null;
  const empty = pagination.totalItemCount === 0 && result.items.length === 0;
  if ((empty ? page !== 1 || pagination.lastPage > 1 || !pagination.endReached :
      pagination.lastPage < 1 || page > pagination.lastPage || pagination.endReached !== (page === pagination.lastPage))) return null;
  if (result.items.length > expectedPageSize || result.items.length > pagination.totalItemCount) return null;
  const validateItem = operation === 'search' ? normalizeSearchItem : normalizeReviewItem;
  if (!result.items.every(item => validateItem(item) === item)) return null;
  if (!result.requests.every(receipt => sanitizeReceipt(receipt) !== null)) return null;
  return {
    totalItemCount: pagination.totalItemCount,
    lastPage: pagination.lastPage,
    pageSize: expectedPageSize,
    items: result.items,
    observedAt: result.observedAt,
    requests: result.requests.map(sanitizeReceipt),
  };
}

function codeForError(error) {
  if (typeof error?.code === 'string' && /^KMONG_[A-Z0-9_]{1,100}$/.test(error.code)) return error.code;
  return 'KMONG_COLLECTION_READ_FAILED';
}

function canResumeAfter(error) {
  const code = codeForError(error);
  if (code === 'KMONG_HTTP_TIMEOUT' || code === 'KMONG_HTTP_TRANSPORT_FAILED') return true;
  if (code === 'KMONG_HTTP_STATUS_INVALID') {
    const status = error?.receipt?.httpStatus;
    return status === 429 || (Number.isSafeInteger(status) && status >= 500 && status <= 599);
  }
  return false;
}

function snapshotState(state) {
  return JSON.parse(JSON.stringify(state));
}

function makeEnvelope(state, currentError = null, run = {}) {
  const status = state.complete ? 'complete' : state.issues.length ? 'unstable' : 'partial';
  const pageSize = state.operation === 'search' ? SEARCH_PAGE_SIZE : REVIEW_PAGE_SIZE;
  const latestPage = state.pages.at(-1)?.page ?? null;
  const pagination = {
    page: latestPage,
    pageSize,
    pagesWalked: state.pages.length,
    totalItemCount: state.totalItemCount,
    lastPage: state.lastPage,
    complete: state.complete,
    sourceWindowComplete: state.complete,
    ...(state.operation === 'search' ? { completeCatalog: false } : {}),
    nextPage: state.complete ? null : state.nextPage,
    pageWalked: true,
    resumable: state.resumeAllowed,
  };
  const limitations = state.operation === 'reviews'
    ? [
      'Review fingerprints use sanitized text, rating, and date; they cannot prove global uniqueness or identify reviewers.',
    ]
    : [];
  if (state.operation === 'search') {
    limitations.push('Kmong source pagination may expose a capped search window; completeCatalog is always false.');
  }
  return {
    schemaVersion: 1,
    service: 'kmong',
    operation: state.operation,
    status,
    // This timestamp belongs only to responses fetched during this invocation.
    // A completed imported checkpoint does not receive a new live-observation time.
    observedAt: run.lastObservedAt ?? null,
    checkpointProvenance: run.checkpointProvenance ?? 'collector_created',
    checkpointAuthenticated: false,
    networkUsed: run.networkUsed === true,
    scope: state.scope,
    items: state.items,
    pages: state.pages,
    newPages: state.pages.slice(run.pageStart ?? state.pages.length),
    pagination,
    state: snapshotState(state),
    attempts: state.attempts,
    issues: state.issues,
    requests: state.requests,
    currentRequests: state.requests.slice(run.requestStart ?? state.requests.length),
    error: currentError,
    limitations,
    contractProvenance: COLLECTION_SOURCE[state.operation],
  };
}

function unstable(state, code, page) {
  state.issues.push({ code, page });
  state.resumeAllowed = false;
  state.complete = false;
}

function markCompleteIfProven(state) {
  if (!state.pages.length || state.issues.length || !state.resumeAllowed) return;
  if (state.lastPage === 0 && state.totalItemCount === 0) {
    if (state.pages.length === 1 && state.pages[0].page === 1 && state.items.length === 0) {
      state.complete = true;
      state.nextPage = null;
    }
    return;
  }
  if (state.lastPage < 1 || state.pages.length !== state.lastPage || state.nextPage !== state.lastPage + 1) return;
  if (state.items.length !== state.totalItemCount) {
    unstable(state, 'TOTAL_ITEM_COUNT_MISMATCH', state.lastPage);
    return;
  }
  const unique = new Set(state.items.map(item => itemIdentity(state.operation, item)));
  if (unique.size !== state.items.length) {
    unstable(state, state.operation === 'search' ? 'DUPLICATE_GIG_ID' : 'DUPLICATE_REVIEW_FINGERPRINT', state.lastPage);
    return;
  }
  state.complete = true;
  state.nextPage = null;
}

function failureEnvelope(state, error, page, now, run) {
  const code = codeForError(error);
  const startedAt = checkedAt(now);
  const requestIndexes = [];
  const receipt = sanitizeReceipt(error?.receipt);
  if (receipt) {
    requestIndexes.push(state.requests.length);
    state.requests.push(receipt);
  }
  state.attempts.push({ page, code, observedAt: startedAt, requestIndexes });
  if (!canResumeAfter(error)) state.resumeAllowed = false;
  return makeEnvelope(state, { code, requestIndexes }, run);
}

function resultEnvelope(state, result, page, now, run) {
  const normalized = responseShape(result, state.operation, page, state.scope);
  if (!normalized) {
    const synthetic = new KmongCollectionError('KMONG_COLLECTION_RESPONSE_SHAPE_INVALID');
    const envelope = failureEnvelope(state, synthetic, page, now, run);
    state.resumeAllowed = false;
    state.issues.push({ code: 'RESPONSE_SHAPE_INVALID', page });
    envelope.status = 'unstable';
    envelope.pagination.resumable = false;
    envelope.state = snapshotState(state);
    envelope.issues = state.issues;
    return envelope;
  }

  const requestIndexes = [];
  for (const receipt of normalized.requests) {
    requestIndexes.push(state.requests.length);
    state.requests.push(receipt);
  }
  run.lastObservedAt = normalized.observedAt;
  const previousTotal = state.totalItemCount;
  const previousLast = state.lastPage;
  if (previousTotal !== null && (previousTotal !== normalized.totalItemCount || previousLast !== normalized.lastPage)) {
    state.pages.push({
      page, pageSize: normalized.pageSize, totalItemCount: normalized.totalItemCount,
      lastPage: normalized.lastPage, itemCount: normalized.items.length,
      observedAt: normalized.observedAt, requestIndexes,
    });
    state.items.push(...normalized.items);
    state.nextPage = page + 1;
    unstable(state, 'SOURCE_PAGINATION_DRIFT', page);
    return makeEnvelope(state, null, run);
  }
  if (previousTotal === null) {
    state.totalItemCount = normalized.totalItemCount;
    state.lastPage = normalized.lastPage;
  }

  const isFinalPage = normalized.totalItemCount === 0 || page === normalized.lastPage;
  if (!isFinalPage && normalized.items.length !== normalized.pageSize) {
    state.pages.push({
      page, pageSize: normalized.pageSize, totalItemCount: normalized.totalItemCount,
      lastPage: normalized.lastPage, itemCount: normalized.items.length,
      observedAt: normalized.observedAt, requestIndexes,
    });
    state.items.push(...normalized.items);
    state.nextPage = page + 1;
    unstable(state, 'SHORT_NONFINAL_PAGE', page);
    return makeEnvelope(state, null, run);
  }

  const identities = new Set(state.items.map(item => itemIdentity(state.operation, item)));
  const pageIdentities = new Set();
  let duplicate = false;
  for (const item of normalized.items) {
    const identity = itemIdentity(state.operation, item);
    if (identities.has(identity) || pageIdentities.has(identity)) duplicate = true;
    pageIdentities.add(identity);
  }
  state.pages.push({
    page, pageSize: normalized.pageSize, totalItemCount: normalized.totalItemCount,
    lastPage: normalized.lastPage, itemCount: normalized.items.length,
    observedAt: normalized.observedAt, requestIndexes,
  });
  state.items.push(...normalized.items);
  state.nextPage = page + 1;
  if (duplicate) {
    unstable(state, state.operation === 'search' ? 'DUPLICATE_GIG_ID' : 'DUPLICATE_REVIEW_FINGERPRINT', page);
    return makeEnvelope(state, null, run);
  }
  markCompleteIfProven(state);
  return makeEnvelope(state, null, run);
}

export function createKmongCollector({ client, now = Date.now, sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!object(client) || typeof client.search !== 'function' || typeof client.reviews !== 'function' ||
      typeof now !== 'function' || typeof sleepImpl !== 'function') fail('CLIENT_CONFIGURATION_INVALID');

  async function collect({ operation, scope, maxPages = MAX_PAGES_PER_CALL, state: priorState }) {
    const pageLimit = validateMaxPages(maxPages);
    const normalizedScope = expectedScope(operation, scope);
    let state;
    if (priorState === undefined || priorState === null) {
      state = stateEmpty(operation, normalizedScope);
    } else {
      assertStateShape(priorState, operation, normalizedScope);
      if (!priorState.resumeAllowed) fail('RESUME_DISABLED');
      state = snapshotState(priorState);
    }

    const run = {
      requestStart: state.requests.length,
      pageStart: state.pages.length,
      networkUsed: false,
      lastObservedAt: null,
      checkpointProvenance: priorState === undefined || priorState === null ? 'collector_created' : 'caller_supplied',
    };
    let fetchedPages = 0;
    while (!state.complete && state.resumeAllowed && fetchedPages < pageLimit) {
      const page = state.nextPage;
      if (!Number.isSafeInteger(page) || page < 1 || (state.lastPage !== null && state.lastPage > 0 && page > state.lastPage)) {
        unstable(state, 'PAGE_CURSOR_OUT_OF_RANGE', Math.max(1, page || 1));
        break;
      }
      if (fetchedPages > 0) await sleepImpl(1_000);
      try {
        run.networkUsed = true;
        const result = operation === 'search'
          ? await client.search({ keyword: normalizedScope.keyword, page, perPage: SEARCH_PAGE_SIZE })
          : await client.reviews({ id: normalizedScope.gigId, page, pageSize: REVIEW_PAGE_SIZE });
        const envelope = resultEnvelope(state, result, page, now, run);
        fetchedPages++;
        if (envelope.status === 'unstable') return envelope;
      } catch (error) {
        return failureEnvelope(state, error, page, now, run);
      }
    }
    return makeEnvelope(state, null, run);
  }

  return Object.freeze({
    collectSearch: async ({ keyword, maxPages = MAX_PAGES_PER_CALL, state } = {}) =>
      collect({ operation: 'search', scope: { keyword: normalizeKeyword(keyword), pageSize: SEARCH_PAGE_SIZE }, maxPages, state }),
    collectReviews: async ({ id, maxPages = MAX_PAGES_PER_CALL, state } = {}) =>
      collect({ operation: 'reviews', scope: { gigId: normalizeGigId(id), pageSize: REVIEW_PAGE_SIZE }, maxPages, state }),
  });
}
