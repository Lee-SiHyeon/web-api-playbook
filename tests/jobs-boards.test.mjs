import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compareJobSnapshots, createJobSnapshot } from '../lib/jobs/snapshots.mjs';
import { createReedJobsClient, createRemotiveJobsClient } from '../lib/jobs/boards.mjs';

const at = Date.parse('2026-10-23T10:00:00Z');
const fixedNow = () => at;
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/jobs-boards/${name}`, import.meta.url), 'utf8'));

test('Remotive list preserves source attribution and source-defined salary/location', async () => {
  const payload = await fixture('remotive-page.json');
  let calls = 0;
  const result = await createRemotiveJobsClient({ fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url.origin, 'https://remotive.com');
    assert.equal(url.pathname, '/api/remote-jobs');
    assert.deepEqual([...url.searchParams], [['search', 'staff engineer'], ['category', 'software-dev']]);
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('cookie'), null);
    return json(payload);
  }, now: fixedNow }).list({ query: 'staff engineer', category: 'software-dev' });

  assert.equal(calls, 1);
  assert.equal(result.provider, 'remotive');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].id, '7420131');
  assert.equal(result.jobs[0].company, 'Example Company');
  assert.equal(result.jobs[0].location, 'USA Only');
  assert.deepEqual(result.jobs[0].locations, ['USA Only']);
  assert.equal(result.jobs[0].compensation.summary, '$150,000 - $190,000');
  assert.equal(result.jobs[0].compensation.components.length, 0);
  assert.equal(result.jobs[0].descriptionText, 'Build reliable services.');
  assert.equal(result.source.name, 'Remotive');
  assert.equal(result.source.freshnessDelayHours, 24);
  assert.equal(result.source.recommendedRequestsPerDay, 4);
  assert.equal(result.requests[0].anonymous, true);
  assert.equal(result.requests[0].credentialsUsed, false);
  assert.deepEqual(result.requests[0].queryFields, ['search', 'category']);
  assert.equal(JSON.stringify(result.requests[0]).includes('staff engineer'), false);
  assert.equal(createJobSnapshot(result).jobs.length, 1);
});

test('Remotive rejects unsupported/conflicting filters and malformed data before success', async () => {
  const payload = await fixture('remotive-page.json');
  let calls = 0;
  const client = createRemotiveJobsClient({ fetchImpl: async () => { calls++; return json(payload); }, now: fixedNow });
  await assert.rejects(client.list({ filters: { location: 'USA' } }), { code: 'REMOTIVE_FILTERS_INVALID' });
  await assert.rejects(client.list({ query: 'x', filters: { search: 'y' } }), { code: 'REMOTIVE_FILTERS_INVALID' });
  assert.equal(calls, 0);
  for (const invalid of [
    { 'job-count': 2, jobs: payload.jobs },
    { 'job-count': 1, jobs: [{ ...payload.jobs[0], url: 'https://evil.example/job/1' }] },
    { 'job-count': 2, jobs: [payload.jobs[0], payload.jobs[0]] },
  ]) {
    await assert.rejects(createRemotiveJobsClient({ fetchImpl: async () => json(invalid), now: fixedNow })
      .list(), { code: 'REMOTIVE_SCHEMA_INVALID' });
  }
});

test('Remotive category command derives observed categories from one bounded active-job read', async () => {
  const payload = await fixture('remotive-page.json');
  let calls = 0;
  const result = await createRemotiveJobsClient({ fetchImpl: async url => {
    calls++;
    assert.equal(url.pathname, '/api/remote-jobs');
    assert.equal(url.search, '');
    return json({ ...payload, 'job-count': 2, jobs: [payload.jobs[0],
      { ...payload.jobs[0], id: 7420132, category: 'Writing' }] });
  }, now: fixedNow }).categories();
  assert.equal(calls, 1);
  assert.equal(result.operation, 'categories');
  assert.deepEqual(result.categories, ['Software Development', 'Writing']);
  assert.equal(result.categoryScope, 'categories_present_in_current_active_job_results_only');
});

test('Remotive rejects redirects, throttling and challenge HTML without following them', async () => {
  const replies = [
    [new Response(null, { status: 302, headers: { location: 'https://other.example/jobs' } }), 'REMOTIVE_REDIRECT_REJECTED'],
    [json({}, 429), 'REMOTIVE_THROTTLED'],
    [new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } }), 'REMOTIVE_MIME_INVALID'],
  ];
  for (const [reply, code] of replies) {
    let calls = 0;
    await assert.rejects(createRemotiveJobsClient({ fetchImpl: async () => { calls++; return reply; }, now: fixedNow })
      .list(), error => {
      assert.equal(error.code, code);
      assert.equal(error.receipt.browserUsed, false);
      assert.equal(JSON.stringify(error.receipt).includes('challenge'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('Reed needs its caller API key and sends it only as a Basic-auth username', async () => {
  const payload = await fixture('reed-page.json');
  const key = 'caller-owned-reed-key-42';
  const result = await createReedJobsClient({ apiKey: key, fetchImpl: async (url, init) => {
    assert.equal(url.origin, 'https://www.reed.co.uk');
    assert.equal(url.pathname, '/api/1.0/search');
    assert.deepEqual([...url.searchParams], [
      ['keywords', 'platform engineer'], ['locationName', 'Manchester'],
      ['resultsToTake', '100'], ['resultsToSkip', '0'],
    ]);
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).get('authorization'), `Basic ${Buffer.from(`${key}:`).toString('base64')}`);
    assert.equal(url.href.includes(key), false);
    return json(payload);
  }, now: fixedNow }).list({ filters: { keywords: 'platform engineer', locationName: 'Manchester' } });

  assert.equal(result.provider, 'reed');
  assert.equal(result.scope.region, 'gb');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.jobs[0].company, 'Example UK Ltd');
  assert.equal(result.jobs[0].url, null);
  assert.equal(result.jobs[0].location, 'Manchester');
  assert.equal(result.jobs[0].compensation.components[0].min, 65000);
  assert.equal(result.jobs[0].compensation.components[0].currency, null);
  assert.equal(result.jobs[0].compensation.components[0].interval, null);
  assert.equal(result.jobs[0].deadlineAt, '2026-11-20T23:59:00');
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(result.requests[0].credentialsUsed, true);
  assert.equal(result.requests[0].queryFields.includes('keywords'), true);
  assert.equal(createJobSnapshot(result).jobs.length, 1);
});

test('Reed rejects absent or malformed keys before sending a request', async () => {
  let calls = 0;
  const client = createReedJobsClient({ fetchImpl: async () => { calls++; return json([]); }, now: fixedNow });
  await assert.rejects(client.list(), { code: 'REED_ACCESS_KEY_REQUIRED' });
  await assert.rejects(client.list({ apiKey: 'bad key with spaces' }), { code: 'REED_ACCESS_KEY_REQUIRED' });
  await assert.rejects(client.list({ apiKey: 'user:password' }), { code: 'REED_ACCESS_KEY_REQUIRED' });
  assert.equal(calls, 0);
});

test('Reed pagination distinguishes complete first pages from continuations', async () => {
  const payload = await fixture('reed-page.json');
  const short = await createReedJobsClient({ apiKey: 'abc123', fetchImpl: async () => json(payload), now: fixedNow })
    .list({ pageSize: 2 });
  assert.equal(short.coverage.complete, true);
  assert.equal(short.coverage.next, null);

  const fullPayload = Array.from({ length: 2 }, (_, index) => ({ ...payload[0], jobId: payload[0].jobId + index }));
  let called = null;
  const full = await createReedJobsClient({ apiKey: 'abc123', fetchImpl: async url => {
    called = Number(url.searchParams.get('resultsToSkip'));
    return json(fullPayload);
  }, now: fixedNow }).list({ pageSize: 2, offset: 20 });
  assert.equal(called, 20);
  assert.equal(full.coverage.complete, false);
  assert.deepEqual(full.coverage.next, { offset: 22 });
});

test('Reed collection advances offsets until a short page and keeps one search scope', async () => {
  const payload = await fixture('reed-page.json');
  const offsets = [];
  const result = await createReedJobsClient({ apiKey: 'abc123', fetchImpl: async url => {
    const offset = Number(url.searchParams.get('resultsToSkip'));
    offsets.push(offset);
    return json(offset === 0
      ? Array.from({ length: 2 }, (_, index) => ({ ...payload[0], jobId: payload[0].jobId + index }))
      : [{ ...payload[0], jobId: payload[0].jobId + 2 }]);
  }, now: fixedNow }).collect({ filters: { keywords: 'platform engineer' }, pageSize: 2, maxPages: 3 });
  assert.deepEqual(offsets, [0, 2]);
  assert.equal(result.operation, 'collect');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.returned, 3);
  assert.equal(result.coverage.pages, 2);
  assert.equal(result.requests.length, 2);
  assert.equal(result.scope.filters.keywords, 'platform engineer');
});

test('Reed collection stops at an overlapping offset page and suppresses missing comparisons', async () => {
  const payload = await fixture('reed-page.json');
  const firstPage = Array.from({ length: 2 }, (_, index) => ({ ...payload[0], jobId: payload[0].jobId + index }));
  const secondPage = [{ ...payload[0], jobId: payload[0].jobId + 1 },
    { ...payload[0], jobId: payload[0].jobId + 2 }];
  const offsets = [];
  const result = await createReedJobsClient({ apiKey: 'abc123', fetchImpl: async url => {
    const offset = Number(url.searchParams.get('resultsToSkip'));
    offsets.push(offset);
    return json(offset === 0 ? firstPage : offset === 2 ? secondPage : []);
  }, now: fixedNow }).collect({ pageSize: 2, maxPages: 4 });

  assert.deepEqual(offsets, [0, 2]);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'duplicate_or_unstable_page');
  assert.equal(result.coverage.next, null);
  assert.equal(result.coverage.pages, 2);
  assert.equal(result.jobs.length, 3);
  const before = createJobSnapshot({ ...result, coverage: {
    complete: true, reason: 'fixture_complete_scope', returned: 3, next: null, pages: 1,
  } });
  const after = createJobSnapshot(result);
  assert.deepEqual(compareJobSnapshots(before, after).missingFromLatest, []);
  assert.equal(compareJobSnapshots(before, after).missingCheck, 'skipped_incomplete_coverage');
});

test('Reed stops on redirects, throttling and invalid response shapes without retries', async () => {
  const key = 'abc123';
  const replies = [
    [new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), 'REED_REDIRECT_REJECTED'],
    [json({}, 429), 'REED_THROTTLED'],
    [new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } }), 'REED_MIME_INVALID'],
    [json({ results: [] }), 'REED_SCHEMA_INVALID'],
  ];
  for (const [reply, code] of replies) {
    let calls = 0;
    await assert.rejects(createReedJobsClient({ apiKey: key, fetchImpl: async () => { calls++; return reply; }, now: fixedNow })
      .list(), error => {
      assert.equal(error.code, code);
      assert.equal(error.receipt.credentialsUsed, true);
      assert.equal(JSON.stringify(error.receipt).includes(key), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});
