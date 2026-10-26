import { createKmongClient } from '../freelance/kmong.mjs';
import { createKmongCollector, validateKmongCollectionState } from '../freelance/kmong-collection.mjs';
import { createSoomgoClient } from '../freelance/soomgo.mjs';
import { createUpworkClient } from '../freelance/upwork.mjs';
import { validateOperationValue } from '../operation-registry.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const text = (max = 2_000, required = false) => ({ type: 'string', minLength: required ? 1 : 0, maxLength: max, ...(required ? { required: true } : {}) });
const integer = (max, value, min = 1) => ({ type: 'integer', minimum: min, maximum: max, ...(value === undefined ? {} : { default: value }) });
const bool = value => ({ type: 'boolean', default: value });
const boundedObject = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const boundedArray = (items, maxItems) => ({ type: 'array', items, maxItems });
const nullableJson = { type: 'json' };
const enumString = (...values) => ({ type: 'string', enum: values });

function collectionItemSchema(operation) {
  const textValue = (maxLength, minLength = 0) => ({ type: 'string', minLength, maxLength });
  if (operation === 'search') {
    return boundedObject({
      id: textValue(20, 1), title: textValue(1_000, 1), url: textValue(300, 1),
      startingPrice: boundedObject({
        amount: { type: 'integer', minimum: 0 }, currency: enumString('KRW'),
        basis: enumString('displayed_starting_price'), exactCheckoutAmount: { type: 'boolean' },
      }),
      reviewSummary: nullableJson,
      isPrime: nullableJson, isQualityGuaranteed: nullableJson,
      hasPackages: nullableJson, hasVideos: nullableJson,
      category: boundedObject({
        rootCategoryId: textValue(300), rootCategoryName: textValue(300),
        subCategoryId: textValue(300), subCategoryName: textValue(300),
        thirdCategoryId: textValue(300), thirdCategoryName: textValue(300),
      }, []),
      sellerDisplayName: textValue(500),
    }, ['id', 'title', 'url', 'startingPrice', 'reviewSummary', 'isPrime', 'isQualityGuaranteed', 'hasPackages', 'hasVideos']);
  }
  return boundedObject({
    rating: { type: 'number', minimum: 0, maximum: 5 },
    body: textValue(20_000), createdAt: nullableJson,
    sellerResponse: boundedObject({ body: textValue(20_000), createdAt: nullableJson }, ['body', 'createdAt']),
  }, ['rating', 'body', 'createdAt']);
}

function collectionStateSchema(operation) {
  const search = operation === 'search';
  const maxPages = search ? 30 : 100;
  const maxItems = search ? 1_200 : 500;
  const maxRequests = search ? 200 : 400;
  const textValue = (maxLength, minLength = 0) => ({ type: 'string', minLength, maxLength });
  const request = boundedObject({
    method: enumString('GET'), origin: enumString('https://kmong.com', 'https://api.kmong.com'),
    path: textValue(500, 1), queryFields: boundedArray(textValue(64, 1), 32),
    observedAt: nullableJson,
    browserUsed: nullableJson, authenticated: nullableJson, credentialsUsed: nullableJson,
    cookiesSent: nullableJson, readOnly: nullableJson,
    responseURL: textValue(600, 1), redirectFollowed: nullableJson,
    httpStatus: nullableJson, mime: textValue(100), responseBytes: nullableJson,
    responseSha256: textValue(64), causeCode: textValue(64),
    contractProvenance: boundedObject({
      kind: textValue(100, 1), sourceURL: textValue(1_000), runtimeConfigurationSource: textValue(1_000),
      discoveryBasis: textValue(200), routeRebase: textValue(500), method: textValue(20),
      queryFields: boundedArray(textValue(64, 1), 32),
    }, []),
  }, ['method', 'origin', 'path', 'queryFields', 'observedAt', 'browserUsed', 'authenticated',
    'credentialsUsed', 'cookiesSent', 'readOnly', 'responseURL', 'redirectFollowed']);
  const scope = search
    ? boundedObject({ keyword: textValue(120, 1), pageSize: { type: 'integer', enum: [40] } })
    : boundedObject({ gigId: textValue(20, 1), pageSize: { type: 'integer', enum: [5] } });
  const page = boundedObject({
    page: { type: 'integer', minimum: 1, maximum: 1_000 },
    pageSize: { type: 'integer', enum: [search ? 40 : 5] },
    totalItemCount: { type: 'integer', minimum: 0, maximum: search ? 48_000 : 500_000 },
    lastPage: { type: 'integer', minimum: 0, maximum: search ? 1_000 : 100_000 },
    itemCount: { type: 'integer', minimum: 0, maximum: search ? 40 : 5 },
    observedAt: textValue(40, 1),
    requestIndexes: boundedArray({ type: 'integer', minimum: 0, maximum: maxRequests }, 2),
  });
  const attempt = boundedObject({
    page: { type: 'integer', minimum: 1, maximum: 100_000 }, code: textValue(120, 1),
    observedAt: textValue(40, 1),
    requestIndexes: boundedArray({ type: 'integer', minimum: 0, maximum: maxRequests }, 4),
  });
  const issue = boundedObject({ code: textValue(120, 1), page: { type: 'integer', minimum: 1, maximum: 100_000 } });
  return boundedObject({
    schemaVersion: { type: 'integer', enum: [1] }, service: enumString('kmong'),
    operation: enumString(operation), scope,
    items: boundedArray(collectionItemSchema(operation), maxItems + (search ? 40 : 5)),
    pages: boundedArray(page, maxPages + 1), requests: boundedArray(request, maxRequests + 1),
    attempts: boundedArray(attempt, 101), issues: boundedArray(issue, 101),
    nextPage: nullableJson,
    totalItemCount: nullableJson, lastPage: nullableJson,
    complete: { type: 'boolean' }, resumeAllowed: { type: 'boolean' },
  });
}

const kmongSearchState = {
  description: 'The common registry stops at 30 pages. Reaching the limit returns KMONG_COLLECTION_COMMON_PAGE_LIMIT_REACHED with the checkpoint; larger than the strict input-schema ceiling is rejected before a request.',
  schema: collectionStateSchema('search'),
};
const kmongReviewsState = {
  description: 'The common registry stops at 100 pages and 500 reviews. Reaching the limit returns KMONG_COLLECTION_COMMON_PAGE_LIMIT_REACHED with the checkpoint; larger than the strict input-schema ceiling is rejected before a request.',
  schema: collectionStateSchema('reviews'),
};

function collectionErrorReceipt(result) {
  return {
    collection: {
      status: result.status,
      state: result.state,
      pagination: result.pagination,
      newPages: result.newPages,
      currentRequests: result.currentRequests,
      networkUsed: result.networkUsed,
      observedAt: result.observedAt,
      checkpointProvenance: result.checkpointProvenance,
      checkpointAuthenticated: false,
      error: result.error,
      issues: result.issues,
      commonRegistry: result.commonRegistry,
    },
  };
}

const KMONG_COMMON_PAGE_LIMIT = Object.freeze({ search: 30, reviews: 100 });

function collectionScope(operation, keywordOrId) {
  return operation === 'search'
    ? { keyword: keywordOrId.replace(/\s+/g, ' ').trim(), pageSize: 40 }
    : { gigId: keywordOrId, pageSize: 5 };
}

function commonRegistryLimitResult(operation, state) {
  const search = operation === 'search';
  const pageLimit = KMONG_COMMON_PAGE_LIMIT[operation];
  const pageSize = search ? 40 : 5;
  const latestPage = state.pages.at(-1)?.page ?? null;
  const nativeCheckpointResumable = state.resumeAllowed === true && state.complete !== true;
  const pagination = {
    page: latestPage,
    pageSize,
    pagesWalked: state.pages.length,
    totalItemCount: state.totalItemCount,
    lastPage: state.lastPage,
    complete: false,
    sourceWindowComplete: false,
    ...(search ? { completeCatalog: false } : {}),
    nextPage: state.nextPage,
    pageWalked: true,
    resumable: false,
    canResumeInCommonRegistry: false,
    nativeCheckpointResumable,
    commonRegistryPageLimit: pageLimit,
  };
  return {
    schemaVersion: 1,
    service: 'kmong',
    operation,
    status: 'partial',
    observedAt: null,
    checkpointProvenance: 'caller_supplied',
    checkpointAuthenticated: false,
    networkUsed: false,
    canResumeInCommonRegistry: false,
    nativeCheckpointResumable,
    commonRegistryPageLimit: pageLimit,
    scope: state.scope,
    items: state.items,
    pages: state.pages,
    newPages: [],
    pagination,
    state,
    attempts: state.attempts,
    issues: state.issues,
    requests: state.requests,
    currentRequests: [],
    error: { code: 'KMONG_COLLECTION_COMMON_PAGE_LIMIT_REACHED', requestIndexes: [] },
    limitations: [`The common registry stops at ${pageLimit} pages; resume this checkpoint with the native Kmong collector.`],
    commonRegistry: {
      pageLimit,
      pagesWalked: state.pages.length,
      canResumeInCommonRegistry: false,
      nativeCheckpointResumable,
    },
  };
}

function annotateCommonCoverage(result, operation) {
  const pageLimit = KMONG_COMMON_PAGE_LIMIT[operation];
  const nativeCheckpointResumable = result.state.resumeAllowed === true && result.status !== 'unstable';
  const canResumeInCommonRegistry = result.status === 'complete' ||
    nativeCheckpointResumable && result.state.pages.length < pageLimit;
  result.pagination = {
    ...result.pagination,
    resumable: canResumeInCommonRegistry,
    canResumeInCommonRegistry,
    nativeCheckpointResumable,
    commonRegistryPageLimit: pageLimit,
  };
  result.commonRegistry = {
    pageLimit,
    pagesWalked: result.state.pages.length,
    canResumeInCommonRegistry,
    nativeCheckpointResumable,
  };
  result.canResumeInCommonRegistry = canResumeInCommonRegistry;
  result.nativeCheckpointResumable = nativeCheckpointResumable;
  result.commonRegistryPageLimit = pageLimit;
  return result;
}

function throwCollectionError(operationName, result, code) {
  if (!result.error) result.error = { code, requestIndexes: [] };
  const error = Object.assign(new Error(code), {
    code,
    receipt: collectionErrorReceipt(result),
    partialResult: {
      kind: 'kmong_read_only_collection',
      operation: operationName,
      data: result,
    },
  });
  throw error;
}

async function collectKmongCommon(operation, { keyword, id, maxPages, state }, options) {
  const limit = KMONG_COMMON_PAGE_LIMIT[operation];
  const identity = operation === 'search' ? keyword : id;
  const scope = collectionScope(operation, identity);
  if (state !== undefined) validateKmongCollectionState(state, { operation, scope });
  const walked = state?.pages?.length ?? 0;
  if (state && state.complete !== true && walked >= limit) {
    const result = commonRegistryLimitResult(operation, state);
    const operationName = operation === 'search' ? 'kmong-search-collect' : 'kmong-reviews-collect';
    throwCollectionError(operationName, result, 'KMONG_COLLECTION_COMMON_PAGE_LIMIT_REACHED');
  }

  const remaining = Math.max(1, limit - walked);
  const boundedMaxPages = state?.complete === true ? maxPages : Math.min(maxPages, remaining);
  const collector = createKmongCollector({
    client: createKmongClient(options), now: options.now, sleepImpl: options.sleepImpl,
  });
  const result = operation === 'search'
    ? await collector.collectSearch({ keyword, maxPages: boundedMaxPages, ...(state === undefined ? {} : { state }) })
    : await collector.collectReviews({ id, maxPages: boundedMaxPages, ...(state === undefined ? {} : { state }) });
  annotateCommonCoverage(result, operation);
  const operationName = operation === 'search' ? 'kmong-search-collect' : 'kmong-reviews-collect';
  if (result.error || result.status === 'unstable') {
    throwCollectionError(operationName, result, result.error?.code ?? 'KMONG_COLLECTION_UNSTABLE');
  }
  if (result.status !== 'complete' && result.state.pages.length >= limit) {
    result.pagination.canResumeInCommonRegistry = false;
    result.pagination.resumable = false;
    result.commonRegistry.canResumeInCommonRegistry = false;
    result.error = { code: 'KMONG_COLLECTION_COMMON_PAGE_LIMIT_REACHED', requestIndexes: [] };
    throwCollectionError(operationName, result, 'KMONG_COLLECTION_COMMON_PAGE_LIMIT_REACHED');
  }
  return result;
}

const operations = {
  'kmong-home': {
    evidence: 'lib/freelance/kmong.mjs#createKmongClient.home; public first-party homepage document',
    description: 'Read the bounded homepage service/category links. Coverage remains partial.',
    inputs: {},
    async run(_input, options) { return createKmongClient(options).home(); },
  },
  'kmong-categories': {
    evidence: 'lib/freelance/kmong.mjs#createKmongClient.categories; homepage first-party document links',
    description: 'Read categories linked from the public homepage; this does not claim full search coverage.',
    inputs: {},
    async run(_input, options) { return createKmongClient(options).categories(); },
  },
  'kmong-search': {
    evidence: 'lib/freelance/kmong.mjs#createKmongClient.search; first-party search contract read from current public frontend bundle',
    description: 'Search one bounded public gig-result page. Pagination remains one page until separately requested.',
    inputs: { query: { keyword: text(300, true), page: integer(1_000, 1),
      perPage: { type: 'integer', enum: [40], default: 40 } } },
    async run({ query }, options) { return createKmongClient(options).search(query); },
  },
  'kmong-search-collect': {
    evidence: 'lib/freelance/kmong-collection.mjs#createKmongCollector.collectSearch; bounded sequential public search pages',
    description: 'Collect up to five pages per call and 30 pages total through the common registry for one explicit public search keyword. Retain a checkpoint and distinguish source-window coverage from catalogue coverage.',
    inputs: { query: { keyword: text(120, true), maxPages: integer(5, 1) }, body: { state: kmongSearchState } },
    async run({ query, body = {} }, options) {
      return collectKmongCommon('search', {
        keyword: query.keyword, maxPages: query.maxPages, ...(body.state === undefined ? {} : { state: body.state }),
      }, options);
    },
  },
  'kmong-detail': {
    evidence: 'lib/freelance/kmong.mjs#createKmongClient.detail; bounded, exact public /gig/{id} document read',
    description: 'Read one exact, caller-selected public service page and its provider-listed packages.',
    inputs: { path: { id: text(20, true) } },
    async run({ path }, options) { return createKmongClient(options).detail({ id: path.id }); },
  },
  'kmong-reviews': {
    evidence: 'lib/freelance/kmong.mjs#createKmongClient.reviews; one page linked by the exact detail document',
    description: 'Read one bounded review page for the selected service; no review-text crawler.',
    inputs: { path: { id: text(20, true) }, query: {
      page: integer(100_000, 1), pageSize: { type: 'integer', enum: [5], default: 5 },
    } },
    async run({ path, query = {} }, options) { return createKmongClient(options).reviews({ id: path.id, ...query }); },
  },
  'kmong-reviews-collect': {
    evidence: 'lib/freelance/kmong-collection.mjs#createKmongCollector.collectReviews; bounded review pages linked by the exact gig detail document',
    description: 'Collect up to five review pages per call and 100 pages total through the common registry for one explicit public gig ID; preserve bounded checkpoints without reviewer identifiers.',
    inputs: { path: { id: text(20, true) }, query: { maxPages: integer(5, 1) }, body: { state: kmongReviewsState } },
    async run({ path, query = {}, body = {} }, options) {
      return collectKmongCommon('reviews', {
        id: path.id, maxPages: query.maxPages, ...(body.state === undefined ? {} : { state: body.state }),
      }, options);
    },
  },
  'soomgo-categories': {
    evidence: 'lib/freelance/soomgo.mjs#createSoomgoClient.listCategories; public categories and subcategories',
    description: 'Read the public service category tree.',
    inputs: {},
    async run(_input, options) { return createSoomgoClient(options).listCategories(); },
  },
  'soomgo-subcategories': {
    evidence: 'lib/freelance/soomgo.mjs#createSoomgoClient.listSubcategories; public subcategory lookup',
    description: 'Read public subcategories for an exact first-party category slug.',
    inputs: { path: { category1Slug: text(120, true) } },
    async run({ path }, options) { return createSoomgoClient(options).listSubcategories({ category1Slug: path.category1Slug }); },
  },
  'soomgo-pro-search': {
    evidence: 'lib/freelance/soomgo.mjs#createSoomgoClient.searchPros; bounded public pro-search read',
    description: 'Search public provider summaries. Empty results remain empty; no quote or contact request is submitted.',
    inputs: { query: {
      category1: text(120), category2: text(120), serviceSlug: text(120), address1: text(120),
      address2: text(120), keyword: text(160), sort: text(64), cursor: text(1_024), limit: integer(20, 5),
    } },
    async run({ query = {} }, options) { return createSoomgoClient(options).searchPros(query); },
  },
  'soomgo-pro-collect': {
    evidence: 'lib/freelance/soomgo.mjs#createSoomgoClient.collectPros; bounded, resumable public pro-search pages',
    description: 'Collect at most five public pro-search pages while retaining partial coverage and continuation.',
    inputs: { query: {
      category1: text(120), category2: text(120), serviceSlug: text(120), address1: text(120),
      address2: text(120), keyword: text(160), sort: text(64), cursor: text(1_024),
      limit: integer(20, 5), maxPages: integer(5, 1),
    } },
    async run({ query = {} }, options) {
      const { maxPages = 1, ...filters } = query;
      return createSoomgoClient(options).collectPros(filters, { maxPages });
    },
  },
  'upwork-search': {
    evidence: 'lib/freelance/upwork.mjs#createUpworkClient.searchJobs; official OAuth marketplace Job Postings API',
    description: 'Search public marketplace job postings using a caller-supplied, approved API token and use case.',
    inputs: { query: { query: text(250, true), cursor: text(1_024), limit: integer(100, 20) } },
    async run({ query }, options) { return (await upwork(options)).searchJobs(query); },
  },
  'upwork-job': {
    evidence: 'lib/freelance/upwork.mjs#createUpworkClient.getJob; official OAuth marketplace Job Postings API',
    description: 'Read one exact public job by ID with a caller-supplied, approved API token and use case.',
    inputs: { path: { id: text(200, true) } },
    async run({ path }, options) { return (await upwork(options)).getJob({ id: path.id }); },
  },
  'upwork-collect': {
    evidence: 'lib/freelance/upwork.mjs#createUpworkClient.collectJobs; bounded official API pagination',
    description: 'Collect at most five official API pages using a caller-supplied, approved token and use case.',
    inputs: { query: { query: text(250, true), cursor: text(1_024), limit: integer(100, 20), maxPages: integer(5, 1) } },
    async run({ query }, options) {
      const { maxPages = 1, ...filters } = query;
      return (await upwork(options)).collectJobs(filters, { maxPages });
    },
  },
};

async function upwork(options) {
  if (typeof options.credentialProvider !== 'function') fail('UPWORK_APPROVED_API_CREDENTIALS_REQUIRED');
  let credentials;
  try { credentials = await options.credentialProvider('freelance-public'); } catch { fail('UPWORK_APPROVED_API_CREDENTIALS_REQUIRED'); }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
      Object.keys(credentials).some(key => !['upworkAccessToken', 'upworkTenantId'].includes(key)) ||
      typeof credentials.upworkAccessToken !== 'string') fail('UPWORK_APPROVED_API_CREDENTIALS_REQUIRED');
  return createUpworkClient({ accessToken: credentials.upworkAccessToken,
    ...(credentials.upworkTenantId ? { tenantId: credentials.upworkTenantId } : {}),
    fetchImpl: options.fetchImpl, now: options.now });
}

function validateInputs(operation, supplied = {}) {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) fail('OPERATION_INPUT_INVALID');
  const result = {};
  for (const [group, definitions] of Object.entries(operation.inputs ?? {})) {
    const fields = supplied[group] ?? {};
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) ||
        Object.keys(fields).some(key => !Object.hasOwn(definitions, key))) fail('OPERATION_INPUT_INVALID');
    const values = {};
    for (const [key, schema] of Object.entries(definitions)) {
      const value = fields[key] === undefined ? schema.default : fields[key];
      if (value === undefined) { if (schema.required) fail('OPERATION_INPUT_REQUIRED'); continue; }
      values[key] = validateOperationValue(value, schema.schema ?? schema);
    }
    if (Object.keys(values).length || Object.hasOwn(supplied, group)) result[group] = values;
  }
  if (Object.keys(supplied).some(key => !Object.hasOwn(operation.inputs ?? {}, key))) fail('OPERATION_INPUT_INVALID');
  return result;
}

function safeValue(value, ancestors = new Set(), depth = 0) {
  if (depth > 32) fail('OPERATION_ADAPTER_RESULT_INVALID');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('OPERATION_ADAPTER_RESULT_INVALID'); return value; }
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || ancestors.has(value) ||
      !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('OPERATION_ADAPTER_RESULT_INVALID');
  ancestors.add(value);
  const result = Array.isArray(value) ? value.map(item => safeValue(item, ancestors, depth + 1))
    : Object.fromEntries(Object.entries(value).filter(([key, item]) => item !== undefined &&
      (!/(?:email|phone|mobile|cookie|password|authorization|accessToken|apiKey|secret|buyer|reviewer|contact)/i.test(key) ||
        key === 'cookiesSent' && item === false))
      .map(([key, item]) => [key, safeValue(item, ancestors, depth + 1)]));
  ancestors.delete(value);
  return result;
}

function status(result) {
  if (result && Number.isInteger(result.httpStatus)) return result.httpStatus;
  const calls = Array.isArray(result?.currentRequests) ? result.currentRequests
    : Array.isArray(result?.requests) ? result.requests : result?.request ? [result.request] : [];
  return calls.map(request => request?.httpStatus).filter(Number.isInteger).at(-1);
}

const knownError = error => /^(?:KMONG|SOOMGO|UPWORK|OPERATION)_[A-Z0-9_]{1,100}$/.test(error?.code ?? '')
  ? error.code : 'FREELANCE_READ_FAILED';

function makeDefinition() {
  const profileOperations = Object.fromEntries(Object.entries(operations).map(([name, spec]) => [name, {
    adapter: `freelance-public.${name}`, semantics: 'read', evidence: spec.evidence,
    description: spec.description, inputs: spec.inputs,
  }]));
  return {
    id: 'freelance-public', title: 'Public freelance marketplaces', aliases: [], checklistIds: ['kmong', 'soomgo', 'upwork'],
    requires: ['Kmong public pages have documented scraping restrictions; service-specific use must stay within provider permission.',
      'Upwork requires an approved OAuth application/token and approved marketplace-search use case.'],
    verificationChecks: [],
    profile: { schemaVersion: 2, serviceId: 'freelance-public', allowedOrigins: [], operations: profileOperations },
    createAdapters(options = {}) {
      let closed = false;
      const fetchBase = options.fetchImpl ?? globalThis.fetch;
      const nativeNetwork = fetchBase === globalThis.fetch;
      const adapters = Object.fromEntries(Object.entries(operations).map(([name, spec]) => [`freelance-public.${name}`,
        async (supplied = {}, { signal } = {}) => {
          if (closed) fail('FREELANCE_ADAPTER_CLOSED');
          if (signal?.aborted) fail('OPERATION_ABORTED');
          let input;
          try { input = validateInputs(profileOperations[name], supplied); }
          catch (error) { throw Object.assign(new Error(knownError(error)), { code: knownError(error) }); }
          const fetchImpl = signal ? (url, init = {}) => {
            if (signal.aborted) fail('OPERATION_ABORTED');
            return fetchBase(url, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
          } : fetchBase;
          try {
            const result = await spec.run(input, { ...options, fetchImpl });
            if (signal?.aborted) fail('OPERATION_ABORTED');
            const data = safeValue(result);
            const collectorResult = name === 'kmong-search-collect' || name === 'kmong-reviews-collect';
            return { data, receipt: { operation: name,
              networkUsed: nativeNetwork && (!collectorResult || result.networkUsed === true),
              browserUsed: false, writesSubmitted: 0,
              ...(status(result) === undefined ? {} : { httpStatus: status(result) }),
              ...(collectorResult
                ? { currentRequests: safeValue(Array.isArray(result?.currentRequests) ? result.currentRequests : []) }
                : Array.isArray(result?.requests) ? { requests: safeValue(result.requests) } : {}) } };
          } catch (error) {
            const code = signal?.aborted ? 'OPERATION_ABORTED' : knownError(error);
            if (error?.receipt?.collection) {
              const collection = safeValue(error.receipt.collection);
              throw Object.assign(new Error(code), { code, receipt: {
                browserUsed: false,
                writesSubmitted: 0,
                networkUsed: nativeNetwork && collection.networkUsed === true,
                collection,
              }, ...(error?.partialResult?.kind === 'kmong_read_only_collection'
                ? { partialResult: safeValue(error.partialResult) } : {}) });
            }
            const requests = Array.isArray(error?.receipt) ? error.receipt
              : Array.isArray(error?.receipt?.requests) ? error.receipt.requests
                : error?.receipt ? [error.receipt] : [];
            throw Object.assign(new Error(code), { code, ...(requests.length ? { receipt: {
              browserUsed: false, writesSubmitted: 0,
              networkUsed: nativeNetwork, requests: safeValue(requests) } } : {}) });
          }
        }]));
      return { adapters, close() { closed = true; } };
    },
  };
}

export const definitions = [makeDefinition()];

