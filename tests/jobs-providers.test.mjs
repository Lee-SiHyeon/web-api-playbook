import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createJobsClient } from '../lib/jobs/providers.mjs';
import { normalizeJob } from '../lib/jobs/model.mjs';

const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/jobs/${name}.json`, import.meta.url), 'utf8'));
const response = (value, status = 200, headers = { 'content-type': 'application/json; charset=utf-8' }) =>
  new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers });
const NOW = () => Date.parse('2026-10-23T10:00:00.000Z');

test('Greenhouse public board read validates schema, preserves raw identity, and parses HTML as text', async () => {
  const payload = await fixture('greenhouse-board');
  let calls = 0;
  const client = createJobsClient({ now: NOW, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url.origin, 'https://boards-api.greenhouse.io');
    assert.equal(url.pathname, '/v1/boards/example/jobs');
    assert.deepEqual([...url.searchParams], [['content', 'true']]);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('accept'), 'application/json');
    return response(payload);
  } });
  const result = await client.list({ provider: 'greenhouse', board: 'example' });
  assert.equal(calls, 1);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.provider, 'greenhouse');
  assert.deepEqual(result.scope, {
    provider: 'greenhouse', board: 'example', region: 'global', filters: { includeContent: true },
  });
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.returned, 1);
  assert.equal(result.coverage.sourceTotal, 1);
  const [job] = result.jobs;
  assert.equal(job.key, 'greenhouse:global:example:8126988');
  assert.equal(job.title, 'Commercial Counsel');
  assert.equal(job.company, null);
  assert.equal(job.location, 'Eastern Timezone');
  assert.deepEqual(job.locations, ['Eastern Timezone', 'United States']);
  assert.equal(job.department, 'Legal');
  assert.match(job.descriptionText, /Support our legal team/);
  assert.match(job.descriptionText, /Coordinate reviews with business teams/);
  assert.doesNotMatch(job.descriptionText, /&lt;|<p>/);
  assert.doesNotMatch(job.descriptionText, /unsafe/);
  assert.equal(job.compensation, null);
  assert.equal(job.deadlineAt, '2026-12-01T00:00:00Z');
  assert.equal(result.requests[0].anonymous, true);
  assert.equal(result.requests[0].credentialsUsed, false);
  assert.equal(result.requests[0].browserUsed, false);
  assert.equal(result.requests[0].cookieSent, false);
});

test('Greenhouse empty public board is a complete snapshot', async () => {
  const result = await createJobsClient({ fetchImpl: async () => response({ jobs: [], meta: { total: 0 } }) })
    .list({ provider: 'greenhouse', board: 'empty' });
  assert.deepEqual(result.jobs, []);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.sourceTotal, 0);
});

test('Greenhouse count mismatch is explicitly partial and has no guessed continuation', async () => {
  const payload = await fixture('greenhouse-board');
  payload.meta.total = 2;
  const result = await createJobsClient({ fetchImpl: async () => response(payload) })
    .list({ provider: 'greenhouse', board: 'example' });
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'provider_total_mismatch');
  assert.equal(result.coverage.sourceTotal, null);
  assert.equal(result.coverage.providerTotal, 2);
  assert.equal(result.coverage.next, null);
});

test('Greenhouse detail uses the exact documented path and requires an exact returned id', async () => {
  const payload = (await fixture('greenhouse-board')).jobs[0];
  const result = await createJobsClient({ fetchImpl: async url => {
    assert.equal(url.pathname, '/v1/boards/example/jobs/8126988');
    assert.deepEqual([...url.searchParams], [['content', 'true']]);
    return response(payload);
  } }).detail({ provider: 'greenhouse', board: 'example', id: 8126988 });
  assert.equal(result.operation, 'detail');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.jobs[0].id, '8126988');
  await assert.rejects(createJobsClient({ fetchImpl: async () => response({ ...payload, id: 77 }) })
    .detail({ provider: 'greenhouse', board: 'example', id: 8126988 }), { code: 'JOBS_ID_MISMATCH' });
});

test('Lever paging uses only the selected regional public origin and stops at the provider end', async () => {
  const job = (await fixture('lever-page'))[0];
  const payloads = [[job], [{ ...job, id: 'f7eb82ce-b57e-4dc0-b84a-7f7ec05bf671', text: 'Second role' }], []];
  const calls = [];
  const result = await createJobsClient({ fetchImpl: async (url, init) => {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.method, 'GET');
    assert.equal(url.origin, 'https://api.eu.lever.co');
    assert.equal(url.pathname, '/v0/postings/board-name');
    calls.push([...url.searchParams]);
    return response(payloads[calls.length - 1]);
  }, now: NOW }).collect({ provider: 'lever', board: 'board-name', region: 'eu', limit: 1 });
  assert.equal(result.scope.region, 'eu');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.pages, 3);
  assert.equal(result.coverage.returned, 2);
  assert.equal(result.coverage.next, null);
  assert.equal(result.jobs[0].company, null);
  assert.equal(result.jobs[0].department, 'Advertising');
  assert.equal(result.jobs[0].team, 'Automation and Agency Teams');
  assert.equal(result.jobs[0].workplaceType, 'on-site');
  assert.deepEqual(result.jobs[0].compensation.components[0], {
    type: 'salary', min: 64000, max: 80000, currency: 'EUR', interval: 'yearly', summary: null,
  });
  assert.deepEqual(calls.map(q => q.find(([key]) => key === 'skip')[1]), ['0', '1', '2']);
  assert.ok(calls.every(q => q.some(([key, value]) => key === 'mode' && value === 'json')));
  assert.equal(result.requests.length, 3);
  assert.ok(result.requests.every(receipt => receipt.anonymous && !receipt.credentialsUsed && !receipt.browserUsed));
});

test('Lever max-page bound returns a resumable partial frontier', async () => {
  const job = (await fixture('lever-page'))[0];
  let calls = 0;
  const result = await createJobsClient({ fetchImpl: async () => { calls++; return response([job]); } })
    .collect({ provider: 'lever', board: 'example', limit: 1 }, { maxPages: 2 });
  assert.equal(calls, 2);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'max_pages_reached');
  assert.deepEqual(result.coverage.next, { offset: 2 });
  assert.equal(result.coverage.pages, 2);
});

test('Lever starting after the first page never claims a complete collection', async () => {
  const result = await createJobsClient({ fetchImpl: async () => response([]) })
    .collect({ provider: 'lever', board: 'example', limit: 10, offset: 10 });
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'starts_after_first_page');
});

test('Lever detail reads a single exact posting without credentials', async () => {
  const job = (await fixture('lever-page'))[0];
  const result = await createJobsClient({ fetchImpl: async url => {
    assert.equal(url.pathname, `/v0/postings/example/${job.id}`);
    return response(job);
  } }).detail({ provider: 'lever', board: 'example', id: job.id });
  assert.equal(result.jobs[0].url, job.hostedUrl);
  assert.equal(result.requests[0].anonymous, true);
  await assert.rejects(createJobsClient({ fetchImpl: async () => response({ ...job, id: 'different-id' }) })
    .detail({ provider: 'lever', board: 'example', id: job.id }), { code: 'JOBS_ID_MISMATCH' });
});

test('Ashby returns listed jobs only and keeps tier-specific compensation conditions', async () => {
  const payload = await fixture('ashby-board');
  const result = await createJobsClient({ fetchImpl: async (url, init) => {
    assert.equal(url.origin, 'https://api.ashbyhq.com');
    assert.equal(url.pathname, '/posting-api/job-board/example');
    assert.deepEqual([...url.searchParams], [['includeCompensation', 'true']]);
    assert.equal(init.credentials, 'omit');
    return response(payload);
  } }).list({ provider: 'ashby', board: 'example' });
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.returned, 1);
  assert.equal(result.coverage.sourceTotal, 2);
  assert.equal(result.coverage.filteredOut, 1);
  const job = result.jobs[0];
  assert.equal(job.company, null);
  assert.deepEqual(job.locations, ['Remote - European Union', 'Berlin, Germany']);
  assert.equal(job.department, 'Engineering');
  assert.equal(job.team, 'Platform');
  assert.equal(job.workplaceType, 'Remote');
  assert.equal(job.compensation.summary, '€95K - €130K');
  assert.equal(job.compensation.components.length, 2);
  assert.equal(job.compensation.components[0].tierTitle, 'EU');
  assert.equal(job.compensation.components[0].tierSummary, 'Estimated based on experience');
  assert.equal(job.compensation.components[1].type, 'Bonus');
  assert.equal(job.compensation.components[1].interval, '1 YEAR');
  assert.equal(result.requests[0].anonymous, true);
  assert.equal(result.requests[0].credentialsUsed, false);
});

test('Ashby detail selects the exact listed id from a board read', async () => {
  const payload = await fixture('ashby-board');
  const result = await createJobsClient({ fetchImpl: async url => {
    assert.equal(url.pathname, '/posting-api/job-board/example');
    return response(payload);
  } }).detail({ provider: 'ashby', board: 'example', id: '7458d4e9-da2e-47bd-98cb-adfda43d42b2' });
  assert.equal(result.coverage.reason, 'selected_from_public_board_read');
  assert.equal(result.jobs.length, 1);
  await assert.rejects(createJobsClient({ fetchImpl: async () => response(payload) })
    .detail({ provider: 'ashby', board: 'example', id: 'b99cf164-0c44-4b51-b7b2-aec21e2b6555' }),
  { code: 'JOBS_NOT_FOUND' });
});

test('normalization supports Remotive source salary text and Reed local ranges without invented currency', async () => {
  const remotive = normalizeJob({ provider: 'remotive', board: 'remotive', value: {
    id: 1, title: 'Designer', company_name: 'Example', url: 'https://remotive.com/remote-jobs/design/1',
    candidate_required_location: 'Remote - Europe', salary: 'Competitive, based on experience',
    description: '<p>Ship <b>products</b></p>', publication_date: '2026-10-01T10:00:00Z',
  } });
  assert.equal(remotive.company, 'Example');
  assert.equal(remotive.compensation.summary, 'Competitive, based on experience');
  assert.deepEqual(remotive.compensation.components, []);
  const reed = normalizeJob({ provider: 'reed', board: 'reed', region: 'gb', value: {
    jobId: 42, employerName: 'Example UK', jobTitle: 'Developer', locationName: 'London',
    minimumSalary: 42000, maximumSalary: 55000, jobDescription: 'Build software.',
    expirationDate: '2026-12-01T00:00:00Z',
  } });
  assert.equal(reed.url, null);
  assert.equal(reed.compensation.components[0].currency, null);
  assert.equal(reed.compensation.components[0].interval, null);
  assert.equal(reed.deadlineAt, '2026-12-01T00:00:00Z');
  const lever = (await fixture('lever-page'))[0];
  assert.throws(() => normalizeJob({ provider: 'lever', board: 'example', value: { ...lever, createdAt: 9e15 } }),
    { code: 'JOBS_SCHEMA_INVALID' });
});

test('TokyoDev source facts remain explicit and do not imply remote work or visa sponsorship', () => {
  const job = normalizeJob({ provider: 'tokyodev', board: 'jobs', region: 'jp', value: {
    id: 'moneyforward:enterprise-architect-tokyo',
    url: 'https://www.tokyodev.com/companies/moneyforward/jobs/enterprise-architect-tokyo',
    title: 'Enterprise Architect',
    hiringOrganization: { name: 'Money Forward' },
    employmentType: 'FULL_TIME',
    jobLocation: { address: { addressLocality: 'Tokyo', addressRegion: 'Tokyo', addressCountry: 'JP' } },
    datePosted: '2026-10-20T09:00:00Z',
    description: '<p>Architect enterprise services.</p>',
    baseSalary: { currency: 'JPY', value: { minValue: 13008000, maxValue: 18000000, unitText: 'YEAR' } },
    sourceFacts: {
      japaneseSkillRequirement: 'No Japanese required',
      residencyRequirement: null,
      canApplyFromAbroad: true,
      workplaceTypeLabel: 'Partially remote',
      skillLabels: ['English', 'TypeScript'],
      sourceId: '2350',
    },
  } });
  assert.equal(job.provider, 'tokyodev');
  assert.equal(job.location, 'Tokyo, Tokyo, JP');
  assert.equal(job.workplaceType, null);
  assert.equal(job.compensation.components[0].currency, 'JPY');
  assert.equal(job.compensation.components[0].interval, 'YEAR');
  assert.deepEqual(job.sourceFacts, {
    japaneseSkillRequirement: 'No Japanese required', japaneseSkillRequirementRaw: 'No Japanese required',
    residencyRequirement: null,
    canApplyFromAbroad: true, workplaceTypeLabel: 'Partially remote', skillLabels: ['English', 'TypeScript'],
    sourceId: '2350',
  });
  assert.equal(JSON.stringify(job).includes('visa'), false);
  const mixed = normalizeJob({ provider: 'tokyodev', board: 'jobs', region: 'jp', value: {
    id: 'mixed-role', url: 'https://www.tokyodev.com/jobs/mixed-role', title: 'Mixed role',
    sourceFacts: { japaneseSkillRequirement: 'No Japanese required Business English' },
  } });
  assert.equal(mixed.sourceFacts.japaneseSkillRequirement, null);
  assert.equal(mixed.sourceFacts.japaneseSkillRequirementRaw, 'No Japanese required Business English');
});

test('invalid service input and non-ATS adapters never send a request', async () => {
  const client = createJobsClient({ fetchImpl: () => assert.fail('must not request') });
  await assert.rejects(client.list({ provider: 'linkedin', board: 'example' }), { code: 'JOBS_PROVIDER_INVALID' });
  await assert.rejects(client.list({ provider: 'remotive', board: 'remotive' }), { code: 'JOBS_PROVIDER_NOT_IN_ATS_CLIENT' });
  await assert.rejects(client.list({ provider: 'lever', board: '../x' }), { code: 'JOBS_BOARD_INVALID' });
  await assert.rejects(client.detail({ provider: 'greenhouse', board: 'example', id: '../1' }), { code: 'JOBS_ID_INVALID' });
  await assert.rejects(client.list({ provider: 'greenhouse', board: 'example', offset: 1 }),
    { code: 'JOBS_PAGINATION_NOT_SUPPORTED' });
});

test('HTTP challenges, redirects, rate limits, invalid MIME and transport failures stop after one request', async () => {
  const cases = [
    [response({ error: 'blocked' }, 403), 'JOBS-GREENHOUSE_AUTH_REJECTED'],
    [response({ error: 'slow down' }, 429), 'JOBS-GREENHOUSE_THROTTLED'],
    [response('<html>challenge</html>', 200, { 'content-type': 'text/html' }), 'JOBS-GREENHOUSE_MIME_INVALID'],
    [new Response(null, { status: 302, headers: { location: 'https://signin.example/' } }), 'JOBS-GREENHOUSE_REDIRECT_REJECTED'],
  ];
  for (const [reply, code] of cases) {
    let calls = 0;
    await assert.rejects(createJobsClient({ fetchImpl: async () => { calls++; return reply; } })
      .list({ provider: 'greenhouse', board: 'example' }), error => {
      assert.equal(error.code, code);
      assert.equal(calls, 1);
      assert.equal(error.receipt.credentialsUsed, false);
      assert.equal(JSON.stringify(error.receipt).includes('challenge'), false);
      return true;
    });
  }
  await assert.rejects(createJobsClient({ fetchImpl: async () => { throw new Error('secret network detail'); } })
    .list({ provider: 'ashby', board: 'example' }), error => {
    assert.equal(error.code, 'JOBS-ASHBY_TRANSPORT_FAILED');
    assert.equal(JSON.stringify(error.receipt).includes('secret network detail'), false);
    return true;
  });
});

test('HTTP success does not accept malformed JSON envelopes, rows, or arbitrary job URLs', async () => {
  await assert.rejects(createJobsClient({ fetchImpl: async () => response({ jobs: {}, meta: { total: 0 } }) })
    .list({ provider: 'greenhouse', board: 'example' }), { code: 'JOBS_SCHEMA_INVALID' });
  const fixturePayload = await fixture('greenhouse-board');
  fixturePayload.jobs[0].absolute_url = 'https://user:pass@example.com/job/1';
  await assert.rejects(createJobsClient({ fetchImpl: async () => response(fixturePayload) })
    .list({ provider: 'greenhouse', board: 'example' }), { code: 'JOBS_SCHEMA_INVALID' });
  await assert.rejects(createJobsClient({ fetchImpl: async () => new Response('{', {
    headers: { 'content-type': 'application/json' },
  }) }).list({ provider: 'greenhouse', board: 'example' }), { code: 'JOBS-GREENHOUSE_JSON_INVALID' });
});
