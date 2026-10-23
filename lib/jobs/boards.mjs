import { createHash } from 'node:crypto';
import { commerceJsonRequest } from '../commerce/http.mjs';
import { jobEnvelope, jobScope, jobsFail, normalizeJob } from './model.mjs';

const REMOTIVE_ORIGIN = 'https://remotive.com';
const REED_ORIGIN = 'https://www.reed.co.uk';
const REED_FIELDS = Object.freeze({
  keywords: 'keywords',
  locationName: 'locationName',
  distanceFromLocation: 'distanceFromLocation',
  employerId: 'employerId',
  employerProfileId: 'employerProfileId',
  permanent: 'permanent',
  contract: 'contract',
  temp: 'temp',
  partTime: 'partTime',
  fullTime: 'fullTime',
  minimumSalary: 'minimumSalary',
  maximumSalary: 'maximumSalary',
  postedByRecruitmentAgency: 'postedByRecruitmentAgency',
  postedByDirectEmployer: 'postedByDirectEmployer',
  graduate: 'graduate',
});

function scalar(value, field, max = 500) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    jobsFail('JOB_BOARD_INPUT_INVALID', { field });
  }
  const clean = value.trim();
  return clean || null;
}

function boundedInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) jobsFail('JOB_BOARD_INPUT_INVALID', { field });
  return value;
}

function boundedOptionalText(value, field) {
  const result = scalar(value, field);
  if (result === null) return null;
  if (result !== value) jobsFail('JOB_BOARD_INPUT_INVALID', { field });
  return result;
}

function boolParam(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') jobsFail('JOB_BOARD_INPUT_INVALID', { field });
  return String(value);
}

function checkNow(now) {
  if (typeof now !== 'function') jobsFail('JOB_BOARD_CONFIGURATION_INVALID');
  const value = now();
  if (!Number.isFinite(value)) jobsFail('JOB_BOARD_CONFIGURATION_INVALID');
  return new Date(value).toISOString();
}

function remotiveFilters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) jobsFail('REMOTIVE_FILTERS_INVALID');
  if (Object.keys(input).some(field => !['search', 'category', 'companyName'].includes(field))) {
    jobsFail('REMOTIVE_FILTERS_INVALID');
  }
  const filters = {};
  for (const [field, queryName] of [['search', 'search'], ['category', 'category'], ['companyName', 'company_name']]) {
    const value = boundedOptionalText(input[field], field);
    if (value !== null) filters[queryName] = value;
  }
  return filters;
}

function remotiveSource() {
  return {
    name: 'Remotive',
    listingUrl: 'https://remotive.com/remote-jobs/api',
    apiDocumentation: 'https://github.com/remotive-com/remote-jobs-api',
    attributionRequired: true,
    freshnessDelayHours: 24,
    recommendedRequestsPerDay: 4,
  };
}

function validateRemotiveListing(value, receipt) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.url !== 'string') {
    jobsFail('REMOTIVE_SCHEMA_INVALID', receipt);
  }
  let url;
  try { url = new URL(value.url); } catch { jobsFail('REMOTIVE_SCHEMA_INVALID', receipt); }
  if (url.protocol !== 'https:' || url.hostname !== 'remotive.com' || url.port || url.username || url.password
    || url.hash || url.search || !url.pathname.startsWith('/remote-jobs/')) {
    jobsFail('REMOTIVE_SCHEMA_INVALID', receipt);
  }
  return value;
}

/**
 * Read Remotive's documented public API. The response covers its active public
 * dataset, which is deliberately delayed by 24 hours. Remotive asks callers to
 * attribute the source and link to each job's Remotive listing.
 */
export function createRemotiveJobsClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  async function list({ filters: rawFilters = {}, query, category, companyName, ...extra } = {}) {
    if (Object.keys(extra).length) jobsFail('REMOTIVE_FILTERS_INVALID');
    if (!rawFilters || typeof rawFilters !== 'object' || Array.isArray(rawFilters)) jobsFail('REMOTIVE_FILTERS_INVALID');
    if (!rawFilters || typeof rawFilters !== 'object' || Array.isArray(rawFilters)) jobsFail('REMOTIVE_FILTERS_INVALID');
    const filtersInput = { ...rawFilters };
    for (const [target, value] of [['search', query], ['category', category], ['companyName', companyName]]) {
      if (value === undefined) continue;
      if (filtersInput[target] !== undefined && filtersInput[target] !== value) jobsFail('REMOTIVE_FILTERS_INVALID', { field: target });
      filtersInput[target] = value;
    }
    const filters = remotiveFilters(filtersInput);
    const params = Object.entries(filters);
    const response = await commerceJsonRequest({
      service: 'remotive', origin: REMOTIVE_ORIGIN, path: '/api/remote-jobs', method: 'GET',
      query: params, fetchImpl, now, maxBytes: 16 * 1024 * 1024, timeoutMs: 30_000,
    });
    const payload = response.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !Array.isArray(payload.jobs) || !Number.isSafeInteger(payload['job-count'])
      || payload['job-count'] !== payload.jobs.length) {
      jobsFail('REMOTIVE_SCHEMA_INVALID', { ...response.request, responseJobCount: Array.isArray(payload?.jobs) ? payload.jobs.length : null });
    }
    const jobs = payload.jobs.map(value => normalizeJob({ provider: 'remotive', board: 'public', region: 'global',
      value: validateRemotiveListing(value, response.request) }));
    if (new Set(jobs.map(job => job.key)).size !== jobs.length) jobsFail('REMOTIVE_SCHEMA_INVALID', response.request);
    const envelope = jobEnvelope({
      provider: 'remotive', operation: 'list', scope: jobScope('remotive', 'public', 'global', filters),
      jobs, complete: true, reason: 'documented_active_public_dataset', returned: jobs.length,
      sourceTotal: payload['job-count'], pages: 1, requests: [response.request], observedAt: checkNow(now),
    });
    envelope.source = remotiveSource();
    return envelope;
  }

  async function categories() {
    const result = await list();
    return {
      schemaVersion: 1,
      provider: 'remotive',
      operation: 'categories',
      observedAt: result.observedAt,
      categories: [...new Set(result.jobs.map(job => job.department).filter(Boolean))].sort(),
      categoryScope: 'categories_present_in_current_active_job_results_only',
      jobsCoverage: result.coverage,
      requests: result.requests,
      source: result.source,
    };
  }

  return Object.freeze({ list, categories });
}

function reedApiKey(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value !== value.trim()
    || !/^[A-Za-z0-9._~+/=-]+$/.test(value)) {
    jobsFail('REED_ACCESS_KEY_REQUIRED');
  }
  return value;
}

function reedQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) jobsFail('REED_FILTERS_INVALID');
  const params = [];
  const filters = {};
  for (const field of ['keywords', 'locationName', 'employerId', 'employerProfileId']) {
    const value = boundedOptionalText(input[field], field);
    if (value !== null) { params.push([REED_FIELDS[field], value]); filters[field] = value; }
  }
  if (input.employerId && input.employerProfileId) jobsFail('REED_FILTERS_INVALID', { field: 'employerId' });
  if (input.distanceFromLocation !== undefined && input.distanceFromLocation !== null) {
    const value = input.distanceFromLocation;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 500) {
      jobsFail('REED_FILTERS_INVALID', { field: 'distanceFromLocation' });
    }
    const text = String(value);
    params.push([REED_FIELDS.distanceFromLocation, text]); filters.distanceFromLocation = value;
  }
  for (const field of ['permanent', 'contract', 'temp', 'partTime', 'fullTime', 'postedByRecruitmentAgency',
    'postedByDirectEmployer', 'graduate']) {
    const value = boolParam(input[field], field);
    if (value !== null) { params.push([REED_FIELDS[field], value]); filters[field] = value === 'true'; }
  }
  for (const field of ['minimumSalary', 'maximumSalary']) {
    if (input[field] === undefined || input[field] === null) continue;
    const value = boundedInteger(input[field], field, { max: 10_000_000 });
    params.push([REED_FIELDS[field], String(value)]); filters[field] = value;
  }
  if (filters.minimumSalary !== undefined && filters.maximumSalary !== undefined
    && filters.minimumSalary > filters.maximumSalary) jobsFail('REED_FILTERS_INVALID', { field: 'salaryRange' });
  const pageSize = input.pageSize ?? 100;
  const offset = input.offset ?? 0;
  boundedInteger(pageSize, 'pageSize', { min: 1, max: 100 });
  boundedInteger(offset, 'offset', { max: 100_000 });
  params.push(['resultsToTake', String(pageSize)], ['resultsToSkip', String(offset)]);
  return { params, filters, pageSize, offset };
}

function mime(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
}

async function reedRead({ apiKey: rawKey, query, fetchImpl, now, maxBytes = 4 * 1024 * 1024 }) {
  const key = reedApiKey(rawKey);
  const url = new URL('/api/1.0/search', REED_ORIGIN);
  for (const [name, value] of query) url.searchParams.append(name, value);
  const checkedAt = checkNow(now);
  const baseReceipt = { checkedAt, method: 'GET', origin: REED_ORIGIN, path: url.pathname,
    queryFields: [...new Set(query.map(([name]) => name))], browserUsed: false, anonymous: false,
    credentialsUsed: true, cookieSent: false, cookiesSent: false, authorizationSent: true };
  let response;
  try {
    const authorization = Buffer.from(`${key}:`, 'utf8').toString('base64');
    response = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit',
      headers: { accept: 'application/json', authorization: `Basic ${authorization}` },
      signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    jobsFail('REED_TRANSPORT_FAILED', { ...baseReceipt,
      causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR' });
  }
  const receipt = { ...baseReceipt, httpStatus: response.status, mime: mime(response) };
  if ([301, 302, 303, 307, 308].includes(response.status) || response.redirected) {
    await response.body?.cancel().catch(() => {});
    jobsFail('REED_REDIRECT_REJECTED', { ...receipt, redirectFollowed: false });
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {}); jobsFail('REED_AUTH_REJECTED', receipt);
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {}); jobsFail('REED_THROTTLED', receipt);
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => {}); jobsFail('REED_HTTP_REJECTED', receipt);
  }
  if (receipt.mime !== 'application/json' && !receipt.mime?.endsWith('+json')) {
    await response.body?.cancel().catch(() => {}); jobsFail('REED_MIME_INVALID', receipt);
  }
  if (!response.body?.getReader) jobsFail('REED_BODY_UNREADABLE', receipt);
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); jobsFail('REED_RESPONSE_TOO_LARGE', { ...receipt, responseBytes: size }); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error?.code?.startsWith('REED_')) throw error;
    jobsFail('REED_BODY_READ_FAILED', receipt);
  } finally { reader.releaseLock(); }
  const raw = Buffer.concat(chunks, size);
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { jobsFail('REED_JSON_INVALID', { ...receipt, responseBytes: raw.byteLength }); }
  return { payload, request: { ...receipt, responseBytes: raw.byteLength,
    responseSha256: createHash('sha256').update(raw).digest('hex') } };
}

/**
 * Read the documented Reed Jobseeker search API. Reed requires a registered
 * caller key as the Basic-auth username and an empty password. A key is passed
 * per call or when this in-memory client is constructed; it is never persisted.
 */
export function createReedJobsClient({ apiKey: clientKey, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  async function list({ apiKey = clientKey, filters = {}, ...options } = {}) {
    const input = { ...filters, ...options };
    const { params, filters: normalizedFilters, pageSize, offset } = reedQuery(input);
    const result = await reedRead({ apiKey, query: params, fetchImpl, now });
    if (!Array.isArray(result.payload)) jobsFail('REED_SCHEMA_INVALID', result.request);
    if (result.payload.length > pageSize) jobsFail('REED_SCHEMA_INVALID', result.request);
    const jobs = result.payload.map(value => normalizeJob({ provider: 'reed', board: 'public', region: 'gb', value }));
    if (new Set(jobs.map(job => job.key)).size !== jobs.length) jobsFail('REED_SCHEMA_INVALID', result.request);
    const exhausted = result.payload.length < pageSize;
    const complete = offset === 0 && exhausted;
    const envelope = jobEnvelope({
      provider: 'reed', operation: 'list', scope: jobScope('reed', 'public', 'gb', normalizedFilters),
      jobs, complete, reason: complete ? 'provider_returned_short_final_page'
        : exhausted ? 'page_started_after_first_page' : 'page_limit_reached',
      returned: jobs.length, sourceTotal: null, next: exhausted ? null : { offset: offset + jobs.length },
      pages: 1, requests: [result.request], observedAt: checkNow(now),
    });
    envelope.source = { name: 'Reed', listingUrl: 'https://www.reed.co.uk/developers/jobseeker',
      apiDocumentation: 'https://www.reed.co.uk/developers/jobseeker', attributionRequired: null };
    return envelope;
  }

  async function collect({ apiKey = clientKey, filters = {}, maxPages = 10, ...options } = {}) {
    boundedInteger(maxPages, 'maxPages', { min: 1, max: 20 });
    const requested = { ...filters, ...options, pageSize: options.pageSize ?? 100 };
    const { params: firstParams, filters: normalizedFilters, pageSize } = reedQuery({ ...requested, offset: 0 });
    // Validate the key before entering the page loop, without placing it in scope or diagnostics.
    reedApiKey(apiKey);
    const jobsByKey = new Map();
    const requests = [];
    const seenKeys = new Set();
    let offset = 0;
    let pages = 0;
    let complete = false;
    let reason = 'maximum_page_budget_reached';
    let next = null;
    while (pages < maxPages) {
      const { params } = pages === 0 ? { params: firstParams } : reedQuery({ ...requested, offset });
      const result = await reedRead({ apiKey, query: params, fetchImpl, now });
      if (!Array.isArray(result.payload) || result.payload.length > pageSize) {
        jobsFail('REED_SCHEMA_INVALID', result.request);
      }
      const jobs = result.payload.map(value => normalizeJob({ provider: 'reed', board: 'public', region: 'gb', value }));
      requests.push(result.request);
      pages++;
      let repeatedIdentity = false;
      for (const job of jobs) {
        if (seenKeys.has(job.key)) repeatedIdentity = true;
        else seenKeys.add(job.key);
        jobsByKey.set(job.key, job);
      }
      if (repeatedIdentity) {
        complete = false;
        reason = 'duplicate_or_unstable_page';
        next = null;
        break;
      }
      if (result.payload.length < pageSize) {
        complete = true;
        reason = 'provider_returned_short_final_page';
        next = null;
        break;
      }
      offset += result.payload.length;
      next = { offset };
    }
    const jobs = [...jobsByKey.values()];
    const envelope = jobEnvelope({
      provider: 'reed', operation: 'collect', scope: jobScope('reed', 'public', 'gb', normalizedFilters),
      jobs, complete, reason, returned: jobs.length, sourceTotal: null, next, pages, requests, observedAt: checkNow(now),
    });
    envelope.source = { name: 'Reed', listingUrl: 'https://www.reed.co.uk/developers/jobseeker',
      apiDocumentation: 'https://www.reed.co.uk/developers/jobseeker', attributionRequired: null };
    return envelope;
  }

  return Object.freeze({ list, collect });
}

