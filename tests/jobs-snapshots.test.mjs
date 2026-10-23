import test from 'node:test';
import assert from 'node:assert/strict';
import { compareJobSnapshots, createJobSnapshot } from '../lib/jobs/snapshots.mjs';

const request = {
  method: 'GET', origin: 'https://boards-api.greenhouse.io', path: '/v1/boards/acme/jobs',
  httpStatus: 200, mime: 'application/json', responseBytes: 128, browserUsed: false,
  anonymous: true, credentialsUsed: false,
};
const job = (overrides = {}) => ({
  key: 'greenhouse:global:acme:1', provider: 'greenhouse', board: 'acme', id: '1',
  title: 'Engineer', company: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/1',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/1?gh_jid=1',
  location: 'Remote - United States', locations: ['United States'],
  workplaceType: 'Remote', employmentType: 'FullTime', department: 'Engineering', team: null,
  descriptionText: 'Build software',
  compensation: { minimum: 100000, maximum: 140000, currency: 'USD', interval: 'YEAR' },
  publishedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', deadlineAt: null,
  ...overrides,
});
const result = (jobs, overrides = {}) => ({
  schemaVersion: 1, provider: 'greenhouse', operation: 'list',
  scope: { provider: 'greenhouse', board: 'acme', region: 'global', filters: { department: 'Engineering' } },
  observedAt: '2026-10-10T00:00:00Z', jobs,
  coverage: { complete: true, reason: 'response_exhausted', returned: jobs.length, next: null, pages: 1 },
  requests: [request], ...overrides,
});

test('snapshots sort by identity and fingerprint canonical object property order', () => {
  const first = createJobSnapshot(result([job({ compensation: { currency: 'USD', interval: 'YEAR', maximum: 140000, minimum: 100000 } })]));
  const second = createJobSnapshot(result([job({ compensation: { minimum: 100000, maximum: 140000, interval: 'YEAR', currency: 'USD' } })]));
  assert.equal(first.jobs[0].fingerprint, second.jobs[0].fingerprint);
  assert.deepEqual(compareJobSnapshots(first, second).changed, []);
});

test('changed compensation, location, work mode and source dates identify exact fields', () => {
  const before = createJobSnapshot(result([job()]));
  const after = createJobSnapshot(result([job({
    location: 'Remote - Canada', locations: ['Canada'], workplaceType: 'Hybrid',
    compensation: { minimum: 110000, maximum: 150000, currency: 'CAD', interval: 'MONTH' },
    updatedAt: '2026-10-09T12:00:00Z',
  })], { observedAt: '2026-10-11T00:00:00Z' }));
  const diff = compareJobSnapshots(before, after);
  assert.deepEqual(diff.changed[0].fields.sort(), [
    'compensation', 'location', 'locations', 'updatedAt', 'workplaceType',
  ]);
  assert.equal(diff.missingInterpretation, 'not_proof_of_closure');
});

test('additions are visible on a partial page while missing checks stay suppressed', () => {
  const before = createJobSnapshot(result([job()]));
  const partialJob = job({ id: '2', key: 'greenhouse:global:acme:2', title: 'Designer' });
  const after = createJobSnapshot(result([partialJob], {
    observedAt: '2026-10-11T00:00:00Z',
    coverage: { complete: false, reason: 'page_limit_reached', returned: 1, next: { offset: 100 }, pages: 1 },
  }));
  const diff = compareJobSnapshots(before, after);
  assert.deepEqual(diff.added.map(item => item.key), [partialJob.key]);
  assert.deepEqual(diff.missingFromLatest, []);
  assert.equal(diff.missingCheck, 'skipped_incomplete_coverage');
});

test('incomplete filtered or unknown-total reads may have no continuation', () => {
  const before = createJobSnapshot(result([job()]));
  const after = createJobSnapshot(result([], {
    observedAt: '2026-10-11T00:00:00Z',
    coverage: { complete: false, reason: 'server_did_not_supply_total', returned: 0, next: null, pages: 1 },
  }));
  const diff = compareJobSnapshots(before, after);
  assert.deepEqual(diff.missingFromLatest, []);
  assert.equal(diff.missingCheck, 'skipped_incomplete_coverage');
});

test('complete empty response reports missing keys without labeling jobs closed', () => {
  const before = createJobSnapshot(result([job()]));
  const after = createJobSnapshot(result([], { observedAt: '2026-10-11T00:00:00Z' }));
  const diff = compareJobSnapshots(before, after);
  assert.deepEqual(diff.missingFromLatest, [job().key]);
  assert.equal(diff.missingInterpretation, 'not_proof_of_closure');
});

test('missing source URLs stay null instead of being synthesized', () => {
  const snapshot = createJobSnapshot(result([job({ company: null, url: null, applyUrl: null })]));
  assert.equal(snapshot.jobs[0].company, null);
  assert.equal(snapshot.jobs[0].url, null);
  assert.equal(snapshot.jobs[0].applyUrl, null);
});

test('provider date-only and local wall-clock facts stay byte-for-byte without a timezone', () => {
  const snapshot = createJobSnapshot(result([job({
    publishedAt: '2020-02-15', updatedAt: '2020-02-15T10:23:26.123456',
    deadlineAt: '2026-10-23T18:00:00+09:00',
  })]));
  assert.equal(snapshot.jobs[0].publishedAt, '2020-02-15');
  assert.equal(snapshot.jobs[0].updatedAt, '2020-02-15T10:23:26.123456');
  assert.equal(snapshot.jobs[0].deadlineAt, '2026-10-23T18:00:00+09:00');
  assert.throws(() => createJobSnapshot(result([], { observedAt: '2026-10-23T10:00:00' })),
    { code: 'JOB_SNAPSHOT_DATE_INVALID' });
  assert.throws(() => createJobSnapshot(result([job({ publishedAt: '2026-02-31' })])),
    { code: 'JOB_SNAPSHOT_DATE_INVALID' });
});

test('source facts participate in the stored fingerprint and change report', () => {
  const before = createJobSnapshot(result([job({ sourceFacts: { remoteScope: 'Japan only' } })]));
  const after = createJobSnapshot(result([job({ sourceFacts: { remoteScope: 'Japan and Singapore' } })], {
    observedAt: '2026-10-11T00:00:00Z',
  }));
  const diff = compareJobSnapshots(before, after);
  assert.deepEqual(diff.changed[0].fields, ['sourceFacts']);
});

test('rejects duplicate identities, out-of-scope records and unsafe URLs', () => {
  assert.throws(() => createJobSnapshot(result([job(), job()])), { code: 'JOB_SNAPSHOT_DUPLICATE_IDENTITY' });
  assert.throws(() => createJobSnapshot(result([job({ board: 'elsewhere' })])), { code: 'JOB_SNAPSHOT_JOB_SCOPE_MISMATCH' });
  assert.throws(() => createJobSnapshot(result([job({ url: 'javascript:alert(1)' })])), { code: 'JOB_SNAPSHOT_URL_INVALID' });
  assert.throws(() => createJobSnapshot(result([job({ url: 'https://user:pass@example.com/job' })])), { code: 'JOB_SNAPSHOT_URL_INVALID' });
});

test('rejects cross-board, changed-filter, and reverse-time comparisons', () => {
  const before = createJobSnapshot(result([job()]));
  const changedBoard = createJobSnapshot(result([], {
    scope: { provider: 'greenhouse', board: 'other', region: 'global', filters: { department: 'Engineering' } },
  }));
  const changedFilters = createJobSnapshot(result([], {
    scope: { provider: 'greenhouse', board: 'acme', region: 'global', filters: { department: 'Design' } },
  }));
  assert.throws(() => compareJobSnapshots(before, changedBoard), { code: 'JOB_SNAPSHOT_SCOPE_MISMATCH' });
  assert.throws(() => compareJobSnapshots(before, changedFilters), { code: 'JOB_SNAPSHOT_SCOPE_MISMATCH' });
  const older = createJobSnapshot(result([], { observedAt: '2026-10-09T00:00:00Z' }));
  assert.throws(() => compareJobSnapshots(before, older), { code: 'JOB_SNAPSHOT_ORDER_INVALID' });
});

test('scope filters compare structurally independent of JSON object property order', () => {
  const before = createJobSnapshot(result([job()], {
    scope: { provider: 'greenhouse', board: 'acme', region: 'global', filters: { department: 'Engineering', level: 'senior' } },
  }));
  const reordered = createJobSnapshot(result([job()], {
    observedAt: '2026-10-11T00:00:00Z',
    scope: { provider: 'greenhouse', board: 'acme', region: 'global', filters: { level: 'senior', department: 'Engineering' } },
  }));
  assert.deepEqual(compareJobSnapshots(before, reordered).missingFromLatest, []);
  const changed = createJobSnapshot(result([job()], {
    observedAt: '2026-10-12T00:00:00Z',
    scope: { provider: 'greenhouse', board: 'acme', region: 'global', filters: { department: 'Design', level: 'senior' } },
  }));
  assert.throws(() => compareJobSnapshots(before, changed), { code: 'JOB_SNAPSHOT_SCOPE_MISMATCH' });
});

test('detail, partial failures, malformed coverage and tampered fingerprints cannot create snapshots', () => {
  assert.throws(() => createJobSnapshot(result([], { operation: 'detail' })), { code: 'JOB_SNAPSHOT_OPERATION_INVALID' });
  assert.throws(() => createJobSnapshot(result([], {
    coverage: { complete: false, reason: 'truncated', returned: 0, next: {}, pages: 1 },
  })), { code: 'JOB_SNAPSHOT_COVERAGE_INVALID' });
  const valid = createJobSnapshot(result([job()]));
  assert.throws(() => compareJobSnapshots({ ...valid, jobs: [{ ...valid.jobs[0], title: 'tampered' }] }, valid),
    { code: 'JOB_SNAPSHOT_FINGERPRINT_INVALID' });
});

test('request receipts are allowlisted and snapshot data remains bounded', () => {
  const snap = createJobSnapshot(result([job()], {
    requests: [{ ...request, accessToken: 'must-not-be-retained', cookie: 'must-not-be-retained', responseSha256: 'a'.repeat(64) }],
  }));
  assert.equal('accessToken' in snap.requests[0], false);
  assert.equal('cookie' in snap.requests[0], false);
  assert.equal(JSON.stringify(snap).includes('must-not-be-retained'), false);
  assert.throws(() => createJobSnapshot(result([job()], {
    scope: { provider: 'greenhouse', board: 'acme', region: 'global', filters: { nested: JSON.parse('{"constructor":{"x":1}}') } },
  })), { code: 'JOB_SNAPSHOT_JSON_INVALID' });
});

test('credentialed read receipts retain auth mode but strip credentials and never claim a browser or cookie', () => {
  const snapshot = createJobSnapshot(result([job()], {
    requests: [{ ...request, anonymous: false, credentialsUsed: true, authorizationSent: true,
      apiKey: 'must-not-be-retained', authorization: 'Basic secret' }],
  }));
  assert.equal(snapshot.requests[0].anonymous, false);
  assert.equal(snapshot.requests[0].credentialsUsed, true);
  assert.equal(snapshot.requests[0].authorizationSent, true);
  assert.equal('apiKey' in snapshot.requests[0], false);
  assert.equal('authorization' in snapshot.requests[0], false);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  assert.throws(() => createJobSnapshot(result([job()], {
    requests: [{ ...request, anonymous: true, credentialsUsed: true }],
  })), { code: 'JOB_SNAPSHOT_REQUESTS_INVALID' });
  assert.throws(() => createJobSnapshot(result([job()], {
    requests: [{ ...request, anonymous: false, credentialsUsed: true, cookieSent: true }],
  })), { code: 'JOB_SNAPSHOT_REQUESTS_INVALID' });
});

test('Reed public catalog fixture preserves authenticated provenance and absent canonical URLs', () => {
  const reed = createJobSnapshot({
    schemaVersion: 1,
    provider: 'reed',
    operation: 'list',
    scope: { provider: 'reed', board: 'reed', region: 'gb', filters: { keywords: 'developer' } },
    observedAt: '2026-10-23T10:00:00Z',
    jobs: [{
      key: 'reed:gb:reed:1234', provider: 'reed', board: 'reed', id: '1234',
      title: 'Software Developer', company: null, url: null, applyUrl: null,
      location: 'London', locations: ['London'], workplaceType: 'unknown',
      employmentType: 'Permanent', department: null, team: null,
      descriptionText: 'Source-reported role description.',
      compensation: { minimum: 45000, maximum: 60000, currency: 'GBP', interval: 'YEAR' },
      publishedAt: null, updatedAt: null, deadlineAt: null,
    }],
    coverage: { complete: true, reason: 'response_exhausted', returned: 1, next: null, pages: 1 },
    requests: [{ ...request, origin: 'https://www.reed.co.uk', path: '/api/1/search',
      anonymous: false, credentialsUsed: true, authorizationSent: true }],
  });
  assert.equal(reed.scope.region, 'gb');
  assert.equal(reed.jobs[0].url, null);
  assert.equal(reed.jobs[0].company, null);
  assert.equal(reed.requests[0].anonymous, false);
  assert.equal(reed.requests[0].credentialsUsed, true);
});
