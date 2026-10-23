import { commerceJsonRequest } from '../commerce/http.mjs';
import {
  boardName, jobEnvelope, jobScope, jobsFail, normalizeJob,
  regionName, validateProvider,
} from './model.mjs';

const ORIGINS = Object.freeze({
  greenhouse: 'https://boards-api.greenhouse.io',
  lever: Object.freeze({ global: 'https://api.lever.co', eu: 'https://api.eu.lever.co' }),
  ashby: 'https://api.ashbyhq.com',
});
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MAX_OFFSET = 100_000_000;
const ATS_PROVIDERS = new Set(['greenhouse', 'lever', 'ashby']);

function validateAtsProvider(value) {
  const provider = validateProvider(value);
  if (!ATS_PROVIDERS.has(provider)) jobsFail('JOBS_PROVIDER_NOT_IN_ATS_CLIENT');
  return provider;
}

function positiveInteger(value, field, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) jobsFail(`JOBS_${field}_INVALID`);
  return value;
}

function offsetValue(value) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_OFFSET) jobsFail('JOBS_OFFSET_INVALID');
  return value;
}

function recordArray(value, field) {
  if (!Array.isArray(value)) jobsFail('JOBS_SCHEMA_INVALID', { field });
  return value;
}

function validateRowCount(length, count, field) {
  if (!Number.isSafeInteger(count) || count < 0) jobsFail('JOBS_SCHEMA_INVALID', { field: `${field}.meta.total` });
  if (count !== length) {
    return { complete: false, reason: 'provider_total_mismatch', sourceTotal: null, providerTotal: count };
  }
  return { complete: true, reason: 'provider_returned_all', sourceTotal: count, providerTotal: count };
}

function requestMeta(result) {
  return result.request;
}

export function createJobsClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') jobsFail('JOBS_CLIENT_CONFIGURATION_INVALID');

  async function request(provider, region, path, query = []) {
    const origin = provider === 'lever' ? ORIGINS.lever[region] : ORIGINS[provider];
    return commerceJsonRequest({
      service: `jobs-${provider}`, origin, path, query, method: 'GET',
      fetchImpl, now, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000,
    });
  }

  async function list({ provider: rawProvider, board: rawBoard, region: rawRegion = 'global',
    limit: rawLimit, offset: rawOffset, includeContent = true, includeCompensation = true } = {}) {
    const provider = validateAtsProvider(rawProvider);
    const board = boardName(rawBoard);
    const region = regionName(rawRegion);
    const limit = positiveInteger(rawLimit, 'LIMIT', MAX_LIMIT, DEFAULT_LIMIT);
    const offset = offsetValue(rawOffset);
    if (typeof includeContent !== 'boolean' || typeof includeCompensation !== 'boolean') {
      jobsFail('JOBS_OPTIONS_INVALID');
    }
    if (provider !== 'lever' && region !== 'global') jobsFail('JOBS_REGION_NOT_SUPPORTED');
    if (provider !== 'lever' && offset !== 0) jobsFail('JOBS_PAGINATION_NOT_SUPPORTED');

    let result;
    let sourceRows;
    let coverage;
    let filters;
    if (provider === 'greenhouse') {
      const query = includeContent ? [['content', 'true']] : [];
      result = await request(provider, region,
        `/v1/boards/${encodeURIComponent(board)}/jobs`, query);
      const payload = result.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) jobsFail('JOBS_SCHEMA_INVALID', requestMeta(result));
      sourceRows = recordArray(payload.jobs, 'jobs');
      const checked = validateRowCount(sourceRows.length, payload.meta?.total, 'greenhouse');
      coverage = { ...checked, next: null };
      filters = { includeContent };
    } else if (provider === 'lever') {
      const query = [
        ['mode', 'json'], ['limit', String(limit)], ['skip', String(offset)],
      ];
      result = await request(provider, region, `/v0/postings/${encodeURIComponent(board)}`, query);
      sourceRows = recordArray(result.payload, 'jobs');
      if (sourceRows.length > limit) jobsFail('JOBS_SCHEMA_INVALID', requestMeta(result));
      const exhausted = sourceRows.length < limit;
      coverage = {
        complete: exhausted && offset === 0,
        reason: exhausted ? (offset === 0 ? 'provider_page_exhausted' : 'starts_after_first_page') : 'more_pages_possible',
        sourceTotal: null,
        next: exhausted ? null : { offset: offset + sourceRows.length },
      };
      filters = { limit, offset };
    } else {
      const query = includeCompensation ? [['includeCompensation', 'true']] : [];
      result = await request(provider, region,
        `/posting-api/job-board/${encodeURIComponent(board)}`, query);
      const payload = result.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) jobsFail('JOBS_SCHEMA_INVALID', requestMeta(result));
      sourceRows = recordArray(payload.jobs, 'jobs');
      const visible = [];
      let filteredOut = 0;
      const totalRows = sourceRows.length;
      for (let i = 0; i < sourceRows.length; i++) {
        const row = sourceRows[i];
        if (!row || typeof row !== 'object' || Array.isArray(row)) jobsFail('JOBS_SCHEMA_INVALID', { ...requestMeta(result), field: `jobs.${i}` });
        if (typeof row.isListed !== 'boolean') jobsFail('JOBS_SCHEMA_INVALID', { ...requestMeta(result), field: `jobs.${i}.isListed` });
        if (!row.isListed) { filteredOut++; continue; }
        visible.push(row);
      }
      sourceRows = visible;
      coverage = { complete: true, reason: 'provider_returned_all_listed', sourceTotal: totalRows, next: null, filteredOut };
      filters = { includeCompensation, listedOnly: true };
    }

    const jobs = sourceRows.map(value => normalizeJob({ provider, board, region, value }));
    const observedAt = new Date(now()).toISOString();
    return jobEnvelope({ provider, operation: 'list', scope: jobScope(provider, board, region, filters),
      observedAt, jobs, complete: coverage.complete, reason: coverage.reason,
      returned: jobs.length, sourceTotal: coverage.sourceTotal, providerTotal: coverage.providerTotal ?? null,
      filteredOut: coverage.filteredOut ?? 0,
      next: coverage.next, pages: 1, requests: [requestMeta(result)] });
  }

  async function detail({ provider: rawProvider, board: rawBoard, id: rawId,
    region: rawRegion = 'global', includeContent = true, includeCompensation = true } = {}) {
    const provider = validateAtsProvider(rawProvider);
    const board = boardName(rawBoard);
    const region = regionName(rawRegion);
    if (provider !== 'lever' && region !== 'global') jobsFail('JOBS_REGION_NOT_SUPPORTED');
    if (typeof includeContent !== 'boolean' || typeof includeCompensation !== 'boolean') jobsFail('JOBS_OPTIONS_INVALID');
    if (typeof rawId !== 'string' && !(typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0)) {
      jobsFail('JOBS_ID_INVALID');
    }
    const id = String(rawId);
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,199}$/u.test(id)) jobsFail('JOBS_ID_INVALID');
    let raw;
    let receipt;
    if (provider === 'greenhouse') {
      const query = includeContent ? [['content', 'true']] : [];
      const response = await request(provider, region,
        `/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`, query);
      raw = response.payload;
      receipt = requestMeta(response);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) jobsFail('JOBS_SCHEMA_INVALID', receipt);
    } else if (provider === 'lever') {
      const response = await request(provider, region,
        `/v0/postings/${encodeURIComponent(board)}/${encodeURIComponent(id)}`);
      raw = response.payload;
      receipt = requestMeta(response);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) jobsFail('JOBS_SCHEMA_INVALID', receipt);
    } else {
      const response = await request(provider, region,
        `/posting-api/job-board/${encodeURIComponent(board)}`,
        includeCompensation ? [['includeCompensation', 'true']] : []);
      receipt = requestMeta(response);
      const payload = response.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) jobsFail('JOBS_SCHEMA_INVALID', receipt);
      const rows = recordArray(payload.jobs, 'jobs');
      const matching = rows.filter(row => row && row.isListed === true && String(row.id) === id);
      if (matching.length !== 1) jobsFail(matching.length ? 'JOBS_DUPLICATE_ID' : 'JOBS_NOT_FOUND', receipt);
      raw = matching[0];
    }
    const job = normalizeJob({ provider, board, region, value: raw });
    if (job.id !== id) jobsFail('JOBS_ID_MISMATCH', receipt);
    return jobEnvelope({ provider, operation: 'detail', scope: jobScope(provider, board, region,
      provider === 'greenhouse' ? { includeContent } : provider === 'ashby' ? { includeCompensation, listedOnly: true } : {}),
    observedAt: new Date(now()).toISOString(), jobs: [job], complete: true,
    reason: provider === 'ashby' ? 'selected_from_public_board_read' : 'provider_detail_read',
    returned: 1, sourceTotal: 1, next: null, pages: 1, requests: [receipt] });
  }

  async function collect(args, { maxPages = 10 } = {}) {
    args ??= {};
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) jobsFail('JOBS_MAX_PAGES_INVALID');
    const provider = validateAtsProvider(args?.provider);
    const board = boardName(args?.board);
    const region = regionName(args?.region ?? 'global');
    if (provider !== 'lever') {
      const one = await list({ ...args, provider, board, region });
      return { ...one, operation: 'collect', coverage: { ...one.coverage, pages: 1 } };
    }
    const limit = positiveInteger(args.limit, 'LIMIT', MAX_LIMIT, DEFAULT_LIMIT);
    const initialOffset = offsetValue(args.offset);
    const jobs = [];
    const requests = [];
    let offset = initialOffset;
    let pages = 0;
    let page;
    while (pages < maxPages) {
      page = await list({ ...args, provider, board, region, limit, offset });
      jobs.push(...page.jobs);
      requests.push(...page.requests);
      pages++;
      if (!page.coverage.next) break;
      offset = page.coverage.next.offset;
    }
    const complete = Boolean(page) && !page.coverage.next && page.jobs.length < limit && initialOffset === 0;
    const next = page?.coverage.next ?? null;
    const reason = complete ? 'provider_page_exhausted'
      : initialOffset > 0 ? 'starts_after_first_page'
        : next ? 'max_pages_reached' : 'provider_page_exhausted_from_offset';
    return jobEnvelope({ provider, operation: 'collect', scope: jobScope(provider, board, region, { limit, offset: initialOffset }),
      observedAt: new Date(now()).toISOString(), jobs, complete, reason, returned: jobs.length,
      sourceTotal: null, next, pages, requests });
  }

  return Object.freeze({ list, detail, collect });
}
