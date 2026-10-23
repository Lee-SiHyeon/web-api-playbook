import { createHash } from 'node:crypto';

export const JOB_SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_JOBS = 10_000;
const MAX_REQUESTS = 500;
const MAX_SNAPSHOT_JSON_BYTES = 32 * 1024 * 1024;
const URL_MAX_LENGTH = 4096;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeJson(value, { maxNodes = 100_000, maxStringBytes = 2 * 1024 * 1024 } = {}) {
  let nodes = 0;
  let bytes = 0;
  const active = new Set();

  function visit(item, depth) {
    if (++nodes > maxNodes || depth > 32) fail('JOB_SNAPSHOT_INPUT_TOO_COMPLEX');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item, 'utf8');
      if (bytes > maxStringBytes) fail('JOB_SNAPSHOT_INPUT_TOO_LARGE');
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('JOB_SNAPSHOT_JSON_INVALID');
      return item;
    }
    if (typeof item !== 'object') fail('JOB_SNAPSHOT_JSON_INVALID');
    if (active.has(item)) fail('JOB_SNAPSHOT_JSON_INVALID');
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      result = item.map(child => visit(child, depth + 1));
    } else {
      if (!isRecord(item)) fail('JOB_SNAPSHOT_JSON_INVALID');
      result = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        if (FORBIDDEN_KEYS.has(key) || key.length > 256) fail('JOB_SNAPSHOT_JSON_INVALID');
        result[key] = visit(item[key], depth + 1);
      }
    }
    active.delete(item);
    return result;
  }

  return visit(value, 0);
}

function requiredText(value, code, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    fail(code);
  }
  return value.trim();
}

function sourceUrl(value, field, { optional = false } = {}) {
  if (value === null && optional) return null;
  const text = requiredText(value, 'JOB_SNAPSHOT_URL_INVALID', URL_MAX_LENGTH);
  let url;
  try { url = new URL(text); } catch { fail('JOB_SNAPSHOT_URL_INVALID'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.port) {
    fail('JOB_SNAPSHOT_URL_INVALID');
  }
  for (const key of url.searchParams.keys()) {
    if (/(?:token|secret|session|auth|credential|password|cookie|signature)/i.test(key)) {
      fail('JOB_SNAPSHOT_URL_INVALID');
    }
  }
  return url.href;
}

function sourceDate(value, field, { timezoneRequired = false } = {}) {
  if (value === null) return null;
  const text = requiredText(value, 'JOB_SNAPSHOT_DATE_INVALID', 64);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  const parts = dateOnly ?? timestamp;
  if (!parts || timezoneRequired && (!timestamp || !timestamp[8])) fail('JOB_SNAPSHOT_DATE_INVALID');

  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) fail('JOB_SNAPSHOT_DATE_INVALID');
  if (timestamp) {
    const [, , , , rawHour, rawMinute, rawSecond, , zone] = timestamp;
    const hour = Number(rawHour), minute = Number(rawMinute), second = Number(rawSecond);
    if (hour > 23 || minute > 59 || second > 59) fail('JOB_SNAPSHOT_DATE_INVALID');
    if (zone && zone !== 'Z') {
      const offset = /[+-](\d{2}):(\d{2})$/.exec(zone);
      if (!offset || Number(offset[1]) > 23 || Number(offset[2]) > 59) fail('JOB_SNAPSHOT_DATE_INVALID');
    }
  }
  return text;
}

function checkedScope(scope, provider) {
  if (!isRecord(scope)) fail('JOB_SNAPSHOT_SCOPE_INVALID');
  const checked = safeJson(scope, { maxNodes: 2_000, maxStringBytes: 16_000 });
  if (checked.provider !== provider) fail('JOB_SNAPSHOT_SCOPE_MISMATCH');
  checked.provider = requiredText(checked.provider, 'JOB_SNAPSHOT_SCOPE_INVALID', 64);
  checked.board = requiredText(checked.board, 'JOB_SNAPSHOT_SCOPE_INVALID', 256);
  checked.region = requiredText(checked.region, 'JOB_SNAPSHOT_SCOPE_INVALID', 64);
  if (!isRecord(checked.filters)) fail('JOB_SNAPSHOT_SCOPE_INVALID');
  return checked;
}

function checkedJob(job, scope) {
  if (!isRecord(job)) fail('JOB_SNAPSHOT_JOB_INVALID');
  const identity = {
    key: requiredText(job.key, 'JOB_SNAPSHOT_JOB_INVALID', 1024),
    provider: requiredText(job.provider, 'JOB_SNAPSHOT_JOB_INVALID', 64),
    board: requiredText(job.board, 'JOB_SNAPSHOT_JOB_INVALID', 256),
    id: requiredText(job.id, 'JOB_SNAPSHOT_JOB_INVALID', 256),
  };
  if (identity.provider !== scope.provider || identity.board !== scope.board) fail('JOB_SNAPSHOT_JOB_SCOPE_MISMATCH');
  const canonicalKey = [identity.provider, scope.region, identity.board, identity.id]
    .map(segment => encodeURIComponent(segment)).join(':');
  if (identity.key !== canonicalKey) fail('JOB_SNAPSHOT_JOB_KEY_INVALID');

  const checked = safeJson(job, { maxNodes: 4_000, maxStringBytes: 2 * 1024 * 1024 });
  const fields = {
    key: identity.key,
    provider: identity.provider,
    board: identity.board,
    id: identity.id,
    title: requiredText(checked.title, 'JOB_SNAPSHOT_JOB_INVALID', 2_000),
    company: checked.company ?? null,
    url: sourceUrl(checked.url, 'url', { optional: true }),
    applyUrl: sourceUrl(checked.applyUrl, 'applyUrl', { optional: true }),
    location: checked.location === null ? null : requiredText(checked.location, 'JOB_SNAPSHOT_JOB_INVALID', 2_000),
    locations: checked.locations ?? [],
    workplaceType: checked.workplaceType ?? 'unknown',
    employmentType: checked.employmentType ?? null,
    department: checked.department ?? null,
    team: checked.team ?? null,
    descriptionText: checked.descriptionText ?? null,
    compensation: checked.compensation ?? null,
    publishedAt: sourceDate(checked.publishedAt ?? null, 'publishedAt'),
    updatedAt: sourceDate(checked.updatedAt ?? null, 'updatedAt'),
    deadlineAt: sourceDate(checked.deadlineAt ?? null, 'deadlineAt'),
    sourceFacts: checked.sourceFacts ?? null,
  };
  for (const field of ['locations']) {
    if (!Array.isArray(fields[field])) fail('JOB_SNAPSHOT_JOB_INVALID');
  }
  for (const field of ['workplaceType', 'employmentType', 'department', 'team']) {
    if (fields[field] !== null) fields[field] = requiredText(fields[field], 'JOB_SNAPSHOT_JOB_INVALID', 512);
  }
  if (fields.company !== null) fields.company = requiredText(fields.company, 'JOB_SNAPSHOT_JOB_INVALID', 512);
  if (fields.descriptionText !== null && typeof fields.descriptionText !== 'string') fail('JOB_SNAPSHOT_JOB_INVALID');
  fields.locations = safeJson(fields.locations, { maxNodes: 1_000, maxStringBytes: 64_000 });
  fields.compensation = safeJson(fields.compensation, { maxNodes: 2_000, maxStringBytes: 32_000 });
  fields.sourceFacts = safeJson(fields.sourceFacts, { maxNodes: 4_000, maxStringBytes: 128_000 });
  if (fields.descriptionText !== null && Buffer.byteLength(fields.descriptionText, 'utf8') > 1_000_000) {
    fail('JOB_SNAPSHOT_JOB_INVALID');
  }
  return fields;
}

function checkedRequests(requests) {
  if (!Array.isArray(requests) || requests.length > MAX_REQUESTS) fail('JOB_SNAPSHOT_REQUESTS_INVALID');
  const allowed = ['checkedAt', 'method', 'origin', 'path', 'httpStatus', 'mime', 'responseBytes',
    'responseSha256', 'browserUsed', 'anonymous', 'credentialsUsed', 'cookieSent', 'cookiesSent', 'authorizationSent'];
  return requests.map(request => {
    if (!isRecord(request)) fail('JOB_SNAPSHOT_REQUESTS_INVALID');
    const receipt = Object.create(null);
    for (const field of allowed) {
      if (Object.hasOwn(request, field)) receipt[field] = safeJson(request[field], { maxNodes: 100, maxStringBytes: 4_096 });
    }
    if (receipt.method !== 'GET' || typeof receipt.origin !== 'string'
      || !Number.isSafeInteger(receipt.httpStatus) || receipt.httpStatus < 200 || receipt.httpStatus >= 300) {
      fail('JOB_SNAPSHOT_REQUESTS_INVALID');
    }
    if (typeof receipt.mime !== 'string' || !/^(?:application\/(?:[\w.+-]+\+)?json|text\/json)$/i.test(receipt.mime)) {
      fail('JOB_SNAPSHOT_REQUESTS_INVALID');
    }
    if (Object.hasOwn(receipt, 'checkedAt')) sourceDate(receipt.checkedAt, 'checkedAt', { timezoneRequired: true });
    if (typeof receipt.anonymous !== 'boolean' || typeof receipt.credentialsUsed !== 'boolean'
      || receipt.anonymous === receipt.credentialsUsed || receipt.browserUsed !== false
      || receipt.cookieSent === true || receipt.cookiesSent === true
      || (receipt.authorizationSent === true && !receipt.credentialsUsed)) {
      fail('JOB_SNAPSHOT_REQUESTS_INVALID');
    }
    const origin = sourceUrl(receipt.origin, 'origin');
    if (new URL(origin).pathname !== '/' || new URL(origin).search) fail('JOB_SNAPSHOT_REQUESTS_INVALID');
    if (Object.hasOwn(receipt, 'path')) {
      const path = requiredText(receipt.path, 'JOB_SNAPSHOT_REQUESTS_INVALID', 2_048);
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) {
        fail('JOB_SNAPSHOT_REQUESTS_INVALID');
      }
      let parsed;
      try { parsed = new URL(path, origin); } catch { fail('JOB_SNAPSHOT_REQUESTS_INVALID'); }
      if (parsed.origin !== new URL(origin).origin || parsed.username || parsed.password) {
        fail('JOB_SNAPSHOT_REQUESTS_INVALID');
      }
      receipt.path = parsed.pathname;
    }
    if (receipt.responseBytes !== undefined && (!Number.isSafeInteger(receipt.responseBytes) || receipt.responseBytes < 0)) {
      fail('JOB_SNAPSHOT_REQUESTS_INVALID');
    }
    if (receipt.responseSha256 !== undefined && !/^[a-f\d]{64}$/i.test(receipt.responseSha256)) {
      fail('JOB_SNAPSHOT_REQUESTS_INVALID');
    }
    return receipt;
  });
}

function checkedCoverage(coverage, jobCount) {
  if (!isRecord(coverage) || typeof coverage.complete !== 'boolean') fail('JOB_SNAPSHOT_COVERAGE_INVALID');
  const result = {
    complete: coverage.complete,
    reason: requiredText(coverage.reason, 'JOB_SNAPSHOT_COVERAGE_INVALID', 256),
    returned: coverage.returned,
    sourceTotal: coverage.sourceTotal ?? null,
    filteredOut: coverage.filteredOut ?? 0,
    next: coverage.next ?? null,
    pages: coverage.pages,
  };
  if (!Number.isSafeInteger(result.returned) || result.returned < 0 || result.returned !== jobCount
    || !Number.isSafeInteger(result.pages) || result.pages < 1 || result.pages > MAX_REQUESTS) {
    fail('JOB_SNAPSHOT_COVERAGE_INVALID');
  }
  if (result.sourceTotal !== null && (!Number.isSafeInteger(result.sourceTotal) || result.sourceTotal < 0)) {
    fail('JOB_SNAPSHOT_COVERAGE_INVALID');
  }
  if (!Number.isSafeInteger(result.filteredOut) || result.filteredOut < 0
    || (result.sourceTotal !== null && result.returned + result.filteredOut > result.sourceTotal)) {
    fail('JOB_SNAPSHOT_COVERAGE_INVALID');
  }
  if (result.next !== null) {
    if (!isRecord(result.next) || !Number.isSafeInteger(result.next.offset) || result.next.offset < 0) {
      fail('JOB_SNAPSHOT_COVERAGE_INVALID');
    }
    result.next = { offset: result.next.offset };
  }
  if (result.complete && result.next !== null) fail('JOB_SNAPSHOT_COVERAGE_INVALID');
  return result;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createJobSnapshot(result) {
  if (!isRecord(result) || !['list', 'collect'].includes(result.operation)) fail('JOB_SNAPSHOT_OPERATION_INVALID');
  if (result.schemaVersion !== 1) fail('JOB_SNAPSHOT_SCHEMA_VERSION_UNSUPPORTED');
  const provider = requiredText(result.provider, 'JOB_SNAPSHOT_PROVIDER_INVALID', 64);
  const scope = checkedScope(result.scope, provider);
  const observedAt = new Date(sourceDate(result.observedAt, 'observedAt', { timezoneRequired: true })).toISOString();
  if (!Array.isArray(result.jobs) || result.jobs.length > MAX_JOBS) fail('JOB_SNAPSHOT_JOBS_INVALID');
  const identities = new Set();
  let jobBytes = 0;
  const jobs = result.jobs.map(job => {
    if (isRecord(job) && typeof job.key === 'string' && identities.has(job.key)) {
      fail('JOB_SNAPSHOT_DUPLICATE_IDENTITY');
    }
    const checked = checkedJob(job, scope);
    identities.add(checked.key);
    jobBytes += Buffer.byteLength(JSON.stringify(checked), 'utf8');
    if (jobBytes > MAX_SNAPSHOT_JSON_BYTES) fail('JOB_SNAPSHOT_INPUT_TOO_LARGE');
    return checked;
  });
  jobs.sort((a, b) => compareText(a.key, b.key));
  for (let i = 1; i < jobs.length; i++) if (jobs[i - 1].key === jobs[i].key) fail('JOB_SNAPSHOT_DUPLICATE_IDENTITY');
  const coverage = checkedCoverage(result.coverage, jobs.length);
  const requests = checkedRequests(result.requests);
  if (coverage.complete && !requests.length) fail('JOB_SNAPSHOT_REQUESTS_INVALID');

  const core = {
    schemaVersion: JOB_SNAPSHOT_SCHEMA_VERSION,
    normalizationVersion: 1,
    provider,
    operation: result.operation,
    scope,
    observedAt,
    coverage,
    requests,
    jobs: jobs.map(job => ({ ...job, fingerprint: sha256(job) })),
  };
  if (Buffer.byteLength(JSON.stringify(core), 'utf8') > MAX_SNAPSHOT_JSON_BYTES) fail('JOB_SNAPSHOT_INPUT_TOO_LARGE');
  return core;
}

function canonicalEqual(left, right) {
  return JSON.stringify(safeJson(left)) === JSON.stringify(safeJson(right));
}

function checkedSnapshot(snapshot) {
  if (!isRecord(snapshot) || snapshot.schemaVersion !== JOB_SNAPSHOT_SCHEMA_VERSION
    || snapshot.normalizationVersion !== 1) fail('JOB_SNAPSHOT_VERSION_UNSUPPORTED');
  if (!['list', 'collect'].includes(snapshot.operation) || !isRecord(snapshot.coverage)
    || !Array.isArray(snapshot.jobs)) fail('JOB_SNAPSHOT_INVALID');
  const provider = requiredText(snapshot.provider, 'JOB_SNAPSHOT_INVALID', 64);
  const scope = checkedScope(snapshot.scope, provider);
  const observedAt = new Date(sourceDate(snapshot.observedAt, 'observedAt', { timezoneRequired: true }));
  if (snapshot.jobs.length > MAX_JOBS) fail('JOB_SNAPSHOT_JOBS_INVALID');
  const jobs = new Map();
  for (const raw of snapshot.jobs) {
    if (!isRecord(raw)) fail('JOB_SNAPSHOT_INVALID');
    const { fingerprint, ...candidate } = raw;
    const job = checkedJob(candidate, scope);
    const actual = sha256(job);
    if (fingerprint !== actual || jobs.has(job.key)) fail('JOB_SNAPSHOT_FINGERPRINT_INVALID');
    jobs.set(job.key, job);
  }
  const coverage = checkedCoverage(snapshot.coverage, jobs.size);
  const requests = checkedRequests(snapshot.requests);
  if (coverage.complete && !requests.length) fail('JOB_SNAPSHOT_REQUESTS_INVALID');
  return { provider, scope, observedAt: observedAt.getTime(), coverage, jobs, requests };
}

export function compareJobSnapshots(before, after) {
  const oldSnapshot = checkedSnapshot(before);
  const newSnapshot = checkedSnapshot(after);
  if (newSnapshot.observedAt < oldSnapshot.observedAt) fail('JOB_SNAPSHOT_ORDER_INVALID');
  if (oldSnapshot.provider !== newSnapshot.provider || !canonicalEqual(oldSnapshot.scope, newSnapshot.scope)) {
    fail('JOB_SNAPSHOT_SCOPE_MISMATCH');
  }

  const added = [];
  const changed = [];
  for (const [key, latest] of newSnapshot.jobs) {
    const previous = oldSnapshot.jobs.get(key);
    if (!previous) {
      added.push({ key, job: latest });
      continue;
    }
    const fields = Object.keys(latest).filter(field => !canonicalEqual(previous[field], latest[field]));
    if (fields.length) changed.push({ key, fields, before: previous, after: latest });
  }
  const comparableRemoval = oldSnapshot.coverage.complete && newSnapshot.coverage.complete;
  const missingFromLatest = comparableRemoval
    ? [...oldSnapshot.jobs.keys()].filter(key => !newSnapshot.jobs.has(key)).sort()
    : [];

  return {
    schemaVersion: 1,
    normalizationVersion: 1,
    provider: oldSnapshot.provider,
    scope: oldSnapshot.scope,
    beforeObservedAt: new Date(oldSnapshot.observedAt).toISOString(),
    afterObservedAt: new Date(newSnapshot.observedAt).toISOString(),
    added: added.sort((a, b) => compareText(a.key, b.key)),
    changed: changed.sort((a, b) => compareText(a.key, b.key)),
    missingFromLatest: missingFromLatest.sort(compareText),
    missingCheck: comparableRemoval ? 'complete_scopes_compared' : 'skipped_incomplete_coverage',
    missingInterpretation: 'not_proof_of_closure',
  };
}
