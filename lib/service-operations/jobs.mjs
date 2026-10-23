import { createJobsClient } from '../jobs/providers.mjs';
import { createRemotiveJobsClient, createReedJobsClient } from '../jobs/boards.mjs';
import { createTokyoDevJobsClient } from '../jobs/japan.mjs';
import { createJobSnapshot, compareJobSnapshots } from '../jobs/snapshots.mjs';
import { validateOperationValue } from '../operation-registry.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const provider = { type: 'string', enum: ['greenhouse', 'lever', 'ashby', 'remotive', 'reed', 'tokyodev'], required: true };
const board = { type: 'string', minLength: 1, maxLength: 120 };
const region = { type: 'string', enum: ['global', 'eu', 'gb', 'jp'] };
const boolean = (defaultValue) => ({ type: 'boolean', default: defaultValue });
const pageLimit = { type: 'integer', minimum: 1, maximum: 1000, default: 100 };
const offset = { type: 'integer', minimum: 0, maximum: 100_000_000, default: 0 };
const maxPages = { type: 'integer', minimum: 1, maximum: 20, default: 5 };
const bodyJson = { type: 'json', required: true };
const safeBooleanProvenance = new Set(['cookieSent', 'cookiesSent', 'authorizationSent']);
const remotiveFilters = { type: 'object', additionalProperties: false, properties: {
  search: { type: 'string', maxLength: 500 }, category: { type: 'string', maxLength: 500 },
  companyName: { type: 'string', maxLength: 500 },
} };
const reedFilters = { type: 'object', additionalProperties: false, properties: {
  keywords: { type: 'string', maxLength: 500 }, locationName: { type: 'string', maxLength: 500 },
  employerId: { type: 'string', maxLength: 500 }, employerProfileId: { type: 'string', maxLength: 500 },
  distanceFromLocation: { type: 'number', minimum: 0, maximum: 500 },
  permanent: { type: 'boolean' }, contract: { type: 'boolean' }, temp: { type: 'boolean' },
  partTime: { type: 'boolean' }, fullTime: { type: 'boolean' },
  minimumSalary: { type: 'integer', minimum: 0, maximum: 10_000_000 },
  maximumSalary: { type: 'integer', minimum: 0, maximum: 10_000_000 },
  postedByRecruitmentAgency: { type: 'boolean' }, postedByDirectEmployer: { type: 'boolean' }, graduate: { type: 'boolean' },
} };

function ensurePublicFeedScope({ provider, board, region }) {
  if (board !== undefined && board !== 'public') fail('JOBS_BOARD_NOT_SUPPORTED');
  if (provider === 'remotive' && region !== undefined && region !== 'global') fail('JOBS_REGION_NOT_SUPPORTED');
  if (provider === 'reed' && region !== undefined && region !== 'gb') fail('JOBS_REGION_NOT_SUPPORTED');
}

async function reedClient(options) {
  if (typeof options.credentialProvider !== 'function') fail('REED_ACCESS_KEY_REQUIRED');
  let credentials;
  try { credentials = await options.credentialProvider('jobs-public'); } catch { fail('REED_ACCESS_KEY_REQUIRED'); }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
      Object.keys(credentials).some(key => key !== 'reedApiKey') || typeof credentials.reedApiKey !== 'string') {
    fail('REED_ACCESS_KEY_REQUIRED');
  }
  return createReedJobsClient({ apiKey: credentials.reedApiKey, fetchImpl: options.fetchImpl, now: options.now });
}

const operations = {
  list: {
    evidence: 'lib/jobs/providers.mjs#createJobsClient.list; first-party Greenhouse, Lever, and Ashby public job-board contracts',
    description: 'Read one page or complete public board listing. Does not read candidate/application records.',
    inputs: { query: { provider, board, region, limit: pageLimit, offset,
      filters: { type: 'object', additionalProperties: false, properties: {
        ...remotiveFilters.properties, ...reedFilters.properties,
      } }, includeContent: boolean(true), includeCompensation: boolean(true) } },
    async run({ query }, options) {
      if (query.provider === 'remotive') {
        ensurePublicFeedScope(query);
        if (query.offset !== 0 || query.limit !== 100) fail('JOBS_LIMIT_NOT_SUPPORTED');
        return createRemotiveJobsClient(options).list({ filters: query.filters ?? {} });
      }
      if (query.provider === 'reed') {
        ensurePublicFeedScope(query);
        const client = await reedClient(options);
        return client.list({ filters: query.filters ?? {}, pageSize: query.limit ?? 100, offset: query.offset ?? 0 });
      }
      if (query.provider === 'tokyodev') {
        if (query.board !== undefined && query.board !== 'jobs' || query.region !== undefined && query.region !== 'jp') {
          fail('JOBS_SCOPE_INVALID');
        }
        if (Object.keys(query.filters ?? {}).length || query.offset !== 0 || query.limit !== 100 ||
            query.includeContent !== true || query.includeCompensation !== true) fail('JOBS_FILTERS_NOT_SUPPORTED');
        return createTokyoDevJobsClient(options).list();
      }
      if (typeof query.board !== 'string') fail('JOBS_BOARD_REQUIRED');
      if (Object.keys(query.filters ?? {}).length) fail('JOBS_FILTERS_NOT_SUPPORTED');
      if (query.provider !== 'lever' && (query.offset !== 0 || query.limit !== 100)) fail('JOBS_LIMIT_NOT_SUPPORTED');
      const { filters: _filters, ...atsQuery } = query;
      return createJobsClient(options).list({ provider: query.provider, board: query.board,
        region: query.region ?? 'global', limit: atsQuery.limit, offset: atsQuery.offset,
        includeContent: atsQuery.includeContent, includeCompensation: atsQuery.includeCompensation });
    },
  },
  detail: {
    evidence: 'lib/jobs/providers.mjs#createJobsClient.detail; exact public job identity on the named provider board',
    description: 'Read one exact public job by source ID; never guesses from a title.',
    inputs: { path: { provider, board, id: { type: 'string', minLength: 1, maxLength: 200 },
      url: { type: 'string', minLength: 1, maxLength: 2_000 } },
      query: { region } },
    async run(input, options) {
      if (input.path.provider === 'remotive' || input.path.provider === 'reed') fail('JOBS_DETAIL_NOT_SUPPORTED');
      if (input.path.provider === 'tokyodev') {
        if (input.path.board !== undefined && input.path.board !== 'jobs' || input.query?.region !== undefined && input.query.region !== 'jp') {
          fail('JOBS_SCOPE_INVALID');
        }
        if (typeof input.path.url !== 'string' || input.path.id !== undefined) fail('JOBS_URL_REQUIRED');
        return createTokyoDevJobsClient(options).detail({ url: input.path.url });
      }
      if (typeof input.path.board !== 'string') fail('JOBS_BOARD_REQUIRED');
      if (typeof input.path.id !== 'string' || input.path.url !== undefined) fail('JOBS_ID_REQUIRED');
      return createJobsClient(options).detail({ ...input.path, ...(input.query ?? {}) });
    },
  },
  collect: {
    evidence: 'lib/jobs/providers.mjs#createJobsClient.collect; provider pagination and completeness metadata',
    description: 'Collect the complete documented Remotive dataset or a bounded number of other provider pages.',
    inputs: { query: { provider, board, region, limit: pageLimit, maxPages,
      filters: { type: 'object', additionalProperties: false, properties: {
        ...remotiveFilters.properties, ...reedFilters.properties,
      } },
      includeContent: boolean(true), includeCompensation: boolean(true) } },
    async run({ query }, options) {
      if (query.provider === 'remotive') {
        ensurePublicFeedScope(query);
        if (query.limit !== 100 || query.maxPages !== 5) fail('JOBS_LIMIT_NOT_SUPPORTED');
        return createRemotiveJobsClient(options).list({ filters: query.filters ?? {} });
      }
      if (query.provider === 'reed') {
        ensurePublicFeedScope(query);
        const client = await reedClient(options);
        return client.collect({ filters: query.filters ?? {}, pageSize: query.limit ?? 100, maxPages: query.maxPages ?? 5 });
      }
      if (query.provider === 'tokyodev') {
        if (query.board !== undefined && query.board !== 'jobs' || query.region !== undefined && query.region !== 'jp') {
          fail('JOBS_SCOPE_INVALID');
        }
        if (Object.keys(query.filters ?? {}).length || query.limit !== 100 || query.maxPages !== 5 ||
            query.includeContent !== true || query.includeCompensation !== true) fail('JOBS_FILTERS_NOT_SUPPORTED');
        const result = await createTokyoDevJobsClient(options).list();
        return { ...result, operation: 'collect' };
      }
      if (typeof query.board !== 'string') fail('JOBS_BOARD_REQUIRED');
      if (Object.keys(query.filters ?? {}).length) fail('JOBS_FILTERS_NOT_SUPPORTED');
      if (query.provider !== 'lever' && (query.limit !== 100 || query.maxPages !== 5)) {
        fail('JOBS_LIMIT_NOT_SUPPORTED');
      }
      return createJobsClient(options).collect(query);
    },
  },
  snapshot: {
    evidence: 'lib/jobs/snapshots.mjs#createJobSnapshot; offline projection of caller-supplied public listing evidence',
    description: 'Build a local snapshot from a prior public list/collect response. Makes no network request.',
    inputs: { body: { result: bodyJson } },
    run({ body }) { return createJobSnapshot(body.result); },
  },
  compare: {
    evidence: 'lib/jobs/snapshots.mjs#compareJobSnapshots; offline comparison of same-board snapshots',
    description: 'Compare snapshots with identical scope and report additions/changes; missing roles are not declared closed.',
    inputs: { body: { before: bodyJson, after: bodyJson } },
    run({ body }) { return compareJobSnapshots(body.before, body.after); },
  },
};

function cleanJson(value, secrets, ancestors = new Set(), depth = 0) {
  if (depth > 32) fail('OPERATION_ADAPTER_RESULT_INVALID');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('OPERATION_ADAPTER_RESULT_INVALID');
    return value;
  }
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret && value.includes(secret)) return '[redacted]';
    return value;
  }
  if (!value || typeof value !== 'object' || ancestors.has(value) ||
      !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('OPERATION_ADAPTER_RESULT_INVALID');
  }
  ancestors.add(value);
  const out = Array.isArray(value)
    ? value.map(item => cleanJson(item, secrets, ancestors, depth + 1))
    : Object.fromEntries(Object.entries(value)
      .filter(([key, child]) => child !== undefined &&
        (!/(?:accessToken|apiKey|authorization|cookie|password|secret|token)/i.test(key) ||
          safeBooleanProvenance.has(key) && typeof child === 'boolean'))
      .map(([key, child]) => [key, cleanJson(child, secrets, ancestors, depth + 1)]));
  ancestors.delete(value);
  return out;
}

function checkedInput(operation, supplied = {}) {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) fail('OPERATION_INPUT_INVALID');
  const input = {};
  for (const [group, definitions] of Object.entries(operation.inputs ?? {})) {
    const fields = supplied[group] ?? {};
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) ||
        Object.keys(fields).some(key => !Object.hasOwn(definitions, key))) fail('OPERATION_INPUT_INVALID');
    const values = {};
    for (const [key, definition] of Object.entries(definitions)) {
      const value = fields[key] === undefined ? definition.default : fields[key];
      if (value === undefined) { if (definition.required) fail('OPERATION_INPUT_REQUIRED'); continue; }
      values[key] = validateOperationValue(value, definition);
    }
    if (Object.keys(values).length || Object.hasOwn(supplied, group)) input[group] = values;
  }
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) ||
      Object.keys(supplied).some(group => !Object.hasOwn(operation.inputs ?? {}, group))) fail('OPERATION_INPUT_INVALID');
  return input;
}

function responseStatus(result) {
  if (!result || typeof result !== 'object') return undefined;
  if (Number.isInteger(result.httpStatus)) return result.httpStatus;
  for (const child of [result.requests, result.request]) {
    const list = Array.isArray(child) ? child : child ? [child] : [];
    const status = list.map(responseStatus).filter(Number.isInteger).at(-1);
    if (status !== undefined) return status;
  }
  return undefined;
}

const failureCode = error => {
  const code = error?.code ?? '';
  if (/^(?:JOBS|JOB_SNAPSHOT|JOB_BOARD|REMOTIVE|REED|TOKYODEV|TOKYO_DEV|OPERATION)_[A-Z0-9_]{1,100}$/.test(code) ||
      /^JOBS-(?:GREENHOUSE|LEVER|ASHBY|REMOTIVE)_[A-Z0-9_]{1,100}$/.test(code)) return code;
  return 'JOBS_OPERATION_FAILED';
};

function definition(id = 'jobs-public', title = 'Public job boards and offline snapshots', checklistIds = ['jobs-public']) {
  const profileOperations = Object.fromEntries(Object.entries(operations).map(([name, spec]) => [name, {
    adapter: `${id}.${name}`, semantics: 'read', evidence: spec.evidence,
    description: spec.description, inputs: spec.inputs,
  }]));
  return {
    id, title, checklistIds, aliases: [], requires: ['public job-board board slug supplied by caller; provider-specific public scope'],
    verificationChecks: [],
    profile: { schemaVersion: 2, serviceId: id, allowedOrigins: [], operations: profileOperations },
    createAdapters(options = {}) {
      let closed = false;
      const fetchBase = options.fetchImpl ?? globalThis.fetch;
      const adapters = Object.fromEntries(Object.entries(operations).map(([name, spec]) => [`${id}.${name}`,
        async (supplied = {}, { signal } = {}) => {
          if (closed) fail('JOBS_ADAPTER_CLOSED');
          if (signal?.aborted) fail('OPERATION_ABORTED');
          let params;
          try { params = checkedInput(profileOperations[name], supplied); }
          catch (error) { throw Object.assign(new Error(failureCode(error)), { code: failureCode(error) }); }
          const secrets = new Set();
          const nativeNetwork = fetchBase === globalThis.fetch;
          const fetchImpl = signal ? async (url, init = {}) => {
            if (signal.aborted) fail('OPERATION_ABORTED');
            const combined = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
            return fetchBase(url, { ...init, signal: combined });
          } : fetchBase;
          try {
            const result = await spec.run(params, { ...options, fetchImpl, ...(options.now ? { now: options.now } : {}) });
            if (signal?.aborted) fail('OPERATION_ABORTED');
            const data = cleanJson(result, secrets);
            return { data, receipt: {
              operation: name, networkUsed: nativeNetwork && ['list', 'detail', 'collect'].includes(name),
              browserUsed: false, writesSubmitted: 0,
              ...(responseStatus(result) === undefined ? {} : { httpStatus: responseStatus(result) }),
              ...(Array.isArray(result?.requests) ? { requests: cleanJson(result.requests, secrets) } : {}),
            } };
          } catch (error) {
            const code = signal?.aborted ? 'OPERATION_ABORTED' : failureCode(error);
            const requests = Array.isArray(error?.receipt) ? error.receipt
              : Array.isArray(error?.receipt?.requests) ? error.receipt.requests
                : error?.receipt ? [error.receipt] : [];
            throw Object.assign(new Error(code), { code, ...(requests.length ? { receipt: {
              browserUsed: false, writesSubmitted: 0, networkUsed: nativeNetwork,
              requests: cleanJson(requests, secrets) } } : {}) });
          }
        }]));
      return { adapters, close() { closed = true; } };
    },
  };
}

export const definitions = [definition()];

