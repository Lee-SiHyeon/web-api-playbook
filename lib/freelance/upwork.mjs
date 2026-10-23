import { createHash } from 'node:crypto';
import { validateAccessToken } from '../commerce/http.mjs';

const ORIGIN = 'https://api.upwork.com';
const ENDPOINT = `${ORIGIN}/graphql`;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_PAGES = 20;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CONTROL = /[\u0000-\u0008\u000b\u000c-\u001f\u007f]/;

const SEARCH_QUERY = `query SearchJobs($filter: MarketplaceJobPostingsSearchFilter) {
  marketplaceJobPostingsSearch(
    marketPlaceJobFilter: $filter
    searchType: USER_JOBS_SEARCH
    sortAttributes: [{ field: RECENCY }]
  ) {
    totalCount
    edges {
      node {
        id
        title
        description
        ciphertext
        amount { displayValue currency }
        skills { name }
        client { totalFeedback }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const DETAIL_QUERY = `query JobDetails($id: ID!) {
  marketplaceJobPosting(id: $id) {
    id
    content { title description }
    contractTerms { contractType }
  }
}`;

function fail(code, receipt = undefined) {
  const error = new Error(code);
  error.name = 'UpworkApiError';
  error.code = code;
  if (receipt !== undefined) error.receipt = receipt;
  throw error;
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, field, max = 20_000, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('UPWORK_SCHEMA_INVALID', { field });
    return null;
  }
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) {
    fail('UPWORK_SCHEMA_INVALID', { field });
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (required && !normalized) fail('UPWORK_SCHEMA_INVALID', { field });
  return normalized || null;
}

function identifier(value, field) {
  let result = value;
  if (typeof result === 'number' && Number.isSafeInteger(result) && result >= 0) result = String(result);
  result = text(result, field, 200, { required: true });
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,199}$/u.test(result)) {
    fail('UPWORK_SCHEMA_INVALID', { field });
  }
  return result;
}

function positiveInteger(value, field, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(`UPWORK_${field}_INVALID`);
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail('UPWORK_SCHEMA_INVALID', { field });
  return value;
}

function checkedCursor(value, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    fail('UPWORK_CURSOR_INVALID');
  }
  if (typeof value !== 'string' || !value.length || value.length > 8192 || CONTROL.test(value)) {
    fail('UPWORK_CURSOR_INVALID');
  }
  return value;
}

function normalizedSkills(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) fail('UPWORK_SCHEMA_INVALID', { field: 'skills' });
  return [...new Set(value.map((skill, index) => {
    if (!isRecord(skill)) fail('UPWORK_SCHEMA_INVALID', { field: `skills.${index}` });
    return text(skill.name, `skills.${index}.name`, 200, { required: true });
  }))];
}

function normalizedAmount(value) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail('UPWORK_SCHEMA_INVALID', { field: 'amount' });
  return {
    displayValue: text(value.displayValue, 'amount.displayValue', 500),
    currency: text(value.currency, 'amount.currency', 20),
  };
}

function normalizedFeedback(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) {
    fail('UPWORK_SCHEMA_INVALID', { field: 'client.totalFeedback' });
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail('UPWORK_SCHEMA_INVALID', { field: 'client.totalFeedback' });
  return number;
}

function publicJob(node, field = 'job') {
  if (!isRecord(node)) fail('UPWORK_SCHEMA_INVALID', { field });
  const id = identifier(node.id, `${field}.id`);
  const title = text(node.title, `${field}.title`, 1_000, { required: true });
  const description = text(node.description, `${field}.description`, 300_000);
  const ciphertext = text(node.ciphertext, `${field}.ciphertext`, 2_000);
  const amount = normalizedAmount(node.amount);
  const skills = normalizedSkills(node.skills);
  const clientFeedback = isRecord(node.client)
    ? normalizedFeedback(node.client.totalFeedback) : null;
  return {
    key: `upwork:global:marketplace:${encodeURIComponent(id)}`,
    provider: 'upwork',
    board: 'marketplace',
    id,
    title,
    company: null,
    // The public search contract returns ciphertext, not a canonical detail URL.
    // Keep it as its own opaque source field instead of synthesizing a URL.
    url: null,
    applyUrl: null,
    location: null,
    locations: [],
    workplaceType: 'unknown',
    employmentType: null,
    department: null,
    team: null,
    descriptionText: description,
    compensation: null,
    publishedAt: null,
    updatedAt: null,
    deadlineAt: null,
    source: {
      ciphertext,
      amount,
      skills,
      clientFeedback,
      fieldSet: 'marketplaceJobPostingsSearch documented selection set',
    },
  };
}

function detailJob(raw, expectedId) {
  if (!isRecord(raw)) fail('UPWORK_SCHEMA_INVALID', { field: 'marketplaceJobPosting' });
  const id = identifier(raw.id, 'marketplaceJobPosting.id');
  if (id !== expectedId) fail('UPWORK_DETAIL_ID_MISMATCH');
  const content = raw.content;
  const terms = raw.contractTerms;
  if (content !== null && content !== undefined && !isRecord(content)) {
    fail('UPWORK_SCHEMA_INVALID', { field: 'marketplaceJobPosting.content' });
  }
  if (terms !== null && terms !== undefined && !isRecord(terms)) {
    fail('UPWORK_SCHEMA_INVALID', { field: 'marketplaceJobPosting.contractTerms' });
  }
  const title = text(content?.title, 'marketplaceJobPosting.content.title', 1_000, { required: true });
  return {
    ...publicJob({ id, title, description: content?.description }),
    source: {
      ...publicJob({ id, title, description: content?.description }).source,
      fieldSet: 'marketplaceJobPosting documented selection set',
      contractType: text(terms?.contractType, 'marketplaceJobPosting.contractTerms.contractType', 100),
    },
  };
}

async function readBounded(response) {
  if (!response.body?.getReader) fail('UPWORK_BODY_UNREADABLE');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        fail('UPWORK_RESPONSE_TOO_LARGE', { responseBytes: bytes });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

export function createUpworkClient({ accessToken, tenantId, fetchImpl = globalThis.fetch,
  now = Date.now } = {}) {
  validateAccessToken('upwork', accessToken);
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('UPWORK_CLIENT_CONFIGURATION_INVALID');
  let tenant = null;
  if (tenantId !== undefined && tenantId !== null) {
    tenant = identifier(tenantId, 'tenantId');
  }

  async function execute(query, variables, operationName) {
    const checkedAt = new Date(now()).toISOString();
    if (!Number.isFinite(Date.parse(checkedAt))) fail('UPWORK_CLIENT_CONFIGURATION_INVALID');
    const base = {
      operationName,
      method: 'POST',
      origin: ORIGIN,
      path: '/graphql',
      checkedAt,
      browserUsed: false,
      anonymous: false,
      credentialsUsed: true,
      ownerVerified: false,
      requiredPermission: 'Read marketplace Job Postings',
      oauthApprovalVerified: false,
      tenantHeaderPresent: tenant !== null,
      requestFields: ['query', 'variables', 'operationName'],
    };
    const headers = new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    });
    if (tenant !== null) headers.set('X-Upwork-API-TenantId', tenant);
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables, operationName }),
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (cause) {
      fail('UPWORK_TRANSPORT_FAILED', { ...base,
        causeCode: cause?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR' });
    }
    const mime = response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
    const receipt = { ...base, httpStatus: response.status, mime };
    if (response.redirected || [301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      fail('UPWORK_REDIRECT_REJECTED', { ...receipt, redirectFollowed: false });
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      fail('UPWORK_AUTH_OR_PERMISSION_REJECTED', receipt);
    }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      fail('UPWORK_THROTTLED', receipt);
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      fail('UPWORK_HTTP_REJECTED', receipt);
    }
    if (mime !== 'application/json') {
      await response.body?.cancel().catch(() => {});
      fail('UPWORK_MIME_INVALID', receipt);
    }
    const raw = await readBounded(response);
    const checked = { ...receipt,
      responseBytes: raw.byteLength,
      responseSha256: createHash('sha256').update(raw).digest('hex'),
    };
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch { fail('UPWORK_JSON_INVALID', checked); }
    if (!isRecord(payload)) fail('UPWORK_GRAPHQL_SCHEMA_INVALID', checked);
    if (Array.isArray(payload.errors) && payload.errors.length) {
      fail('UPWORK_GRAPHQL_ERROR', { ...checked, errorCount: payload.errors.length });
    }
    if (!isRecord(payload.data)) fail('UPWORK_GRAPHQL_SCHEMA_INVALID', checked);
    return { data: payload.data, request: checked };
  }

  async function searchJobs({ query, cursor = null, limit: rawLimit } = {}) {
    const search = text(query, 'query', 250, { required: true });
    const limit = positiveInteger(rawLimit, 'LIMIT', DEFAULT_LIMIT, MAX_LIMIT);
    const after = checkedCursor(cursor, { optional: true });
    const filter = {
      searchExpression_eq: search,
      pagination_eq: { after: after ?? '0', first: limit },
    };
    const result = await execute(SEARCH_QUERY, { filter }, 'SearchJobs');
    const connection = result.data.marketplaceJobPostingsSearch;
    if (!isRecord(connection) || !Array.isArray(connection.edges) || !isRecord(connection.pageInfo)) {
      fail('UPWORK_GRAPHQL_SCHEMA_INVALID', result.request);
    }
    if (connection.edges.length > limit) fail('UPWORK_GRAPHQL_SCHEMA_INVALID', result.request);
    const totalCount = nonNegativeInteger(connection.totalCount, 'totalCount');
    const hasNextPage = connection.pageInfo.hasNextPage;
    if (typeof hasNextPage !== 'boolean') fail('UPWORK_GRAPHQL_SCHEMA_INVALID', result.request);
    const endCursor = checkedCursor(connection.pageInfo.endCursor, { optional: true });
    if (hasNextPage && !endCursor) fail('UPWORK_NEXT_CURSOR_MISSING', result.request);
    const jobs = connection.edges.map((edge, index) => {
      if (!isRecord(edge) || !isRecord(edge.node)) fail('UPWORK_GRAPHQL_SCHEMA_INVALID', result.request);
      return publicJob(edge.node, `edges.${index}.node`);
    });
    const firstPage = after === null;
    const complete = firstPage && !hasNextPage;
    const observedAt = new Date(now()).toISOString();
    return {
      schemaVersion: 1,
      provider: 'upwork',
      operation: 'search',
      observedAt,
      scope: { provider: 'upwork', board: 'marketplace', region: 'global', filters: {
        searchExpression_eq: search, limit, after,
      } },
      jobs,
      coverage: {
        complete,
        reason: complete ? 'provider_has_no_next_page' : hasNextPage ? 'more_pages_available' : 'cursor_page_only',
        returned: jobs.length,
        totalCount,
        hasNextPage,
        cursor: after,
        nextCursor: hasNextPage ? endCursor : null,
        pages: 1,
      },
      requests: [result.request],
      access: {
        approvalRequired: true,
        requiredPermission: 'Read marketplace Job Postings',
        oauth2TokenSuppliedByCaller: true,
        approvedUseCaseVerified: false,
        ownerVerified: false,
        liveVerification: 'pending_live',
      },
    };
  }

  async function getJob({ id } = {}) {
    const jobId = identifier(id, 'id');
    const result = await execute(DETAIL_QUERY, { id: jobId }, 'JobDetails');
    const raw = result.data.marketplaceJobPosting;
    if (raw === null) fail('UPWORK_JOB_NOT_FOUND', result.request);
    const job = detailJob(raw, jobId);
    return {
      schemaVersion: 1,
      provider: 'upwork',
      operation: 'detail',
      observedAt: new Date(now()).toISOString(),
      scope: { provider: 'upwork', board: 'marketplace', region: 'global', filters: { id: jobId } },
      jobs: [job],
      coverage: { complete: true, reason: 'provider_detail_returned', returned: 1, totalCount: 1, pages: 1 },
      requests: [result.request],
      access: {
        approvalRequired: true,
        requiredPermission: 'Read marketplace Job Postings',
        oauth2TokenSuppliedByCaller: true,
        approvedUseCaseVerified: false,
        ownerVerified: false,
        liveVerification: 'pending_live',
      },
    };
  }

  async function collectJobs({ query, limit: rawLimit, cursor = null } = {}, { maxPages = MAX_PAGES } = {}) {
    const search = text(query, 'query', 250, { required: true });
    const limit = positiveInteger(rawLimit, 'LIMIT', DEFAULT_LIMIT, MAX_LIMIT);
    const initialCursor = checkedCursor(cursor, { optional: true });
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) fail('UPWORK_MAX_PAGES_INVALID');
    const jobs = [];
    const requests = [];
    const seenCursors = new Set(initialCursor ? [initialCursor] : []);
    const seenIds = new Set();
    let next = initialCursor;
    let page;
    let pages = 0;
    while (pages < maxPages) {
      page = await searchJobs({ query: search, cursor: next, limit });
      pages++;
      requests.push(...page.requests);
      for (const job of page.jobs) {
        if (seenIds.has(job.id)) fail('UPWORK_DUPLICATE_ID', page.requests[0]);
        seenIds.add(job.id);
        jobs.push(job);
      }
      if (!page.coverage.hasNextPage) break;
      next = page.coverage.nextCursor;
      if (seenCursors.has(next)) fail('UPWORK_CURSOR_CYCLE', page.requests[0]);
      seenCursors.add(next);
    }
    const complete = initialCursor === null && !page.coverage.hasNextPage;
    return {
      ...page,
      operation: 'collect',
      scope: { ...page.scope, filters: { ...page.scope.filters, cursor: initialCursor, maxPages } },
      jobs,
      coverage: {
        ...page.coverage,
        complete,
        reason: complete ? 'provider_has_no_next_page'
          : initialCursor !== null ? 'started_from_cursor'
            : page.coverage.hasNextPage ? 'page_budget_reached' : 'provider_page_only',
        returned: jobs.length,
        cursor: initialCursor,
        nextCursor: page.coverage.hasNextPage ? page.coverage.nextCursor : null,
        pages,
      },
      requests,
    };
  }

  return Object.freeze({ searchJobs, getJob, collectJobs });
}

export const UPWORK_PENDING_LIVE = Object.freeze({
  status: 'pending_live',
  reason: 'Approved Upwork OAuth 2.0 client credentials, the required API scope, and an approved use case have not been supplied or verified.',
  officialApi: ENDPOINT,
  requiredPermission: 'Read marketplace Job Postings',
  credentialsPersisted: false,
});
