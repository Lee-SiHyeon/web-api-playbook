import { createKmongClient } from '../freelance/kmong.mjs';
import { createSoomgoClient } from '../freelance/soomgo.mjs';
import { createUpworkClient } from '../freelance/upwork.mjs';
import { validateOperationValue } from '../operation-registry.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const text = (max = 2_000, required = false) => ({ type: 'string', minLength: required ? 1 : 0, maxLength: max, ...(required ? { required: true } : {}) });
const integer = (max, value, min = 1) => ({ type: 'integer', minimum: min, maximum: max, ...(value === undefined ? {} : { default: value }) });
const bool = value => ({ type: 'boolean', default: value });

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
      values[key] = validateOperationValue(value, schema);
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
      !/(?:email|phone|mobile|cookie|password|authorization|accessToken|apiKey|secret|buyer|reviewer|contact)/i.test(key))
      .map(([key, item]) => [key, safeValue(item, ancestors, depth + 1)]));
  ancestors.delete(value);
  return result;
}

function status(result) {
  if (result && Number.isInteger(result.httpStatus)) return result.httpStatus;
  const calls = Array.isArray(result?.requests) ? result.requests : result?.request ? [result.request] : [];
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
            return { data, receipt: { operation: name,
              networkUsed: nativeNetwork,
              browserUsed: false, writesSubmitted: 0,
              ...(status(result) === undefined ? {} : { httpStatus: status(result) }),
              ...(Array.isArray(result?.requests) ? { requests: safeValue(result.requests) } : {}) } };
          } catch (error) {
            const code = signal?.aborted ? 'OPERATION_ABORTED' : knownError(error);
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

