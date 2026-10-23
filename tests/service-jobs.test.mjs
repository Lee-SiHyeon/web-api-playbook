import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServiceRegistry, listServiceOperations, loadServiceDefinitions } from '../lib/service-operations/index.mjs';

const when = Date.parse('2026-10-23T00:00:00Z');
const rows = [
  { id: 40, title: 'Engineering Manager', absolute_url: 'https://boards.greenhouse.io/acme/jobs/40',
    updated_at: '2026-10-22T00:00:00Z', application_deadline: '2026-11-10T00:00:00Z',
    location: { name: 'Remote - US' }, departments: [{ name: 'Engineering' }],
    content: '<p>Build a <strong>safe</strong> hiring system.</p>' },
];
const response = (data, { status = 200, mime = 'application/json' } = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': mime },
});
const boardFixture = name => readFile(fileURLToPath(new URL(`./fixtures/jobs-boards/${name}`, import.meta.url)), 'utf8');
const japanFixture = name => readFile(fileURLToPath(new URL(`./fixtures/jobs-japan/${name}`, import.meta.url)), 'utf8');

test('jobs adapters appear in the metadata catalog without binding credentials or doing I/O', async () => {
  let calls = 0;
  const services = await listServiceOperations({ includeUnconnected: false });
  const found = services.services.find(item => item.id === 'jobs-public');
  assert.ok(found);
  assert.deepEqual(found.operations.sort(), ['collect', 'compare', 'detail', 'list', 'snapshot']);
  assert.equal(found.liveState, 'not_checked_by_listing');
  const noNetwork = await createServiceRegistry('jobs-public', {
    fetchImpl: () => { calls++; throw new Error('inventory must stay offline'); },
    credentialProvider: () => { calls++; throw new Error('inventory must not ask for credentials'); },
    bind: false,
  });
  await noNetwork.close();
  assert.equal(calls, 0);
});

test('common run reads and projects a validated public Greenhouse board', async () => {
  const calls = [];
  const registry = await createServiceRegistry('jobs-public', { now: () => when,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      assert.equal(new URL(String(url)).origin, 'https://boards-api.greenhouse.io');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'manual');
      return response({ jobs: rows, meta: { total: 1 } });
    } });
  try {
    const result = await registry.execute('list', { query: { provider: 'greenhouse', board: 'acme' } });
    assert.equal(result.data.provider, 'greenhouse');
    assert.equal(result.data.jobs.length, 1);
    assert.equal(result.data.jobs[0].key, 'greenhouse:global:acme:40');
    assert.equal(result.data.jobs[0].location, 'Remote - US');
    assert.match(result.data.jobs[0].descriptionText, /Build a safe hiring system/);
    assert.equal(result.data.jobs[0].deadlineAt, '2026-11-10T00:00:00Z');
    assert.equal(result.data.coverage.complete, true);
    assert.equal(result.receipt.networkUsed, false, 'a mocked response must not establish a live receipt');
    assert.equal(result.receipt.browserUsed, false);
    assert.equal(calls.length, 1);
  } finally { await registry.close(); }
});

test('local snapshots and comparisons work through the common CLI/MCP operation registry', async () => {
  const registry = await createServiceRegistry('jobs-public', { now: () => when,
    fetchImpl: async () => response({ jobs: rows, meta: { total: 1 } }) });
  try {
    const first = await registry.execute('list', { query: { provider: 'greenhouse', board: 'acme' } });
    const before = await registry.execute('snapshot', { body: { result: first.data } });
    const afterInput = structuredClone(first.data);
    afterInput.observedAt = '2026-10-24T00:00:00.000Z';
    afterInput.jobs[0].compensation = { summary: '$140k-$180k', components: [
      { type: 'salary', min: 140000, max: 180000, currency: 'USD', interval: 'YEAR', summary: null },
    ] };
    const after = await registry.execute('snapshot', { body: { result: afterInput } });
    const diff = await registry.execute('compare', { body: { before: before.data, after: after.data } });
    assert.deepEqual(diff.data.changed[0].fields, ['compensation']);
    assert.deepEqual(diff.data.added, []);
    assert.equal(diff.data.missingFromLatest.length, 0);
    assert.equal(diff.receipt.networkUsed, false);
  } finally { await registry.close(); }
});

test('the jobs service rejects arbitrary providers and malformed public responses', async () => {
  let calls = 0;
  const registry = await createServiceRegistry('jobs-public', { fetchImpl: async () => {
    calls++; return response({ login: true });
  } });
  try {
    await assert.rejects(registry.execute('list', { query: { provider: 'linkedin', board: 'acme' } }),
      { code: 'OPERATION_INPUT_INVALID' });
    assert.equal(calls, 0);
    await assert.rejects(registry.execute('list', { query: { provider: 'greenhouse', board: 'acme' } }),
      { code: 'JOBS_SCHEMA_INVALID' });
    assert.equal(calls, 1);
    assert.deepEqual(Object.keys(await loadServiceDefinitions().then(definitions => {
      const entry = definitions.find(item => item.id === 'jobs-public');
      return entry.profile.operations;
    })).sort(), ['collect', 'compare', 'detail', 'list', 'snapshot']);
  } finally { await registry.close(); }
});

test('common job adapter keeps bounded provider auth and throttle codes on failures', async () => {
  for (const [status, expected] of [[403, 'JOBS-GREENHOUSE_AUTH_REJECTED'], [429, 'JOBS-GREENHOUSE_THROTTLED']]) {
    let calls = 0;
    const registry = await createServiceRegistry('jobs-public', { fetchImpl: async () => {
      calls++; return new Response('must not be echoed', { status,
        headers: { 'content-type': 'application/json' } });
    } });
    try {
      await assert.rejects(registry.execute('list', { query: { provider: 'greenhouse', board: 'acme' } }), error => {
        assert.equal(error.code, expected);
        assert.equal(JSON.stringify(error).includes('must not be echoed'), false);
        return true;
      });
      assert.equal(calls, 1, 'provider failures are not retried');
    } finally { await registry.close(); }
  }
});

test('common service exposes the documented Remotive public feed with its source freshness and attribution', async () => {
  const remotive = JSON.parse(await boardFixture('remotive-page.json'));
  const calls = [];
  const registry = await createServiceRegistry('jobs-public', { now: () => when,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(url.origin, 'https://remotive.com');
      assert.equal(url.pathname, '/api/remote-jobs');
      assert.equal(init.credentials, 'omit');
      return response(remotive);
    } });
  try {
    const result = await registry.execute('list', { query: { provider: 'remotive',
      filters: { search: 'staff engineer', category: 'software-dev' } } });
    assert.equal(result.data.source.name, 'Remotive');
    assert.equal(result.data.source.freshnessDelayHours, 24);
    assert.equal(result.data.jobs.length, 1);
    assert.equal(result.data.jobs[0].compensation.summary, '$150,000 - $190,000');
    assert.equal(result.data.requests[0].anonymous, true);
    assert.equal(calls.length, 1);
  } finally { await registry.close(); }
});

test('common service obtains Reed keys from one memory provider and never exposes Basic auth material', async () => {
  const reed = JSON.parse(await boardFixture('reed-page.json'));
  const key = 'fixture-reed-key-must-not-escape';
  let providerReads = 0;
  const registry = await createServiceRegistry('jobs-public', { now: () => when,
    credentialProvider: async service => {
      providerReads++; assert.equal(service, 'jobs-public'); return { reedApiKey: key };
    },
    fetchImpl: async (url, init) => {
      assert.equal(url.origin, 'https://www.reed.co.uk');
      const authorization = new Headers(init.headers).get('authorization');
      assert.equal(authorization, `Basic ${Buffer.from(`${key}:`).toString('base64')}`);
      return response(reed);
    } });
  try {
    const result = await registry.execute('list', { query: { provider: 'reed', region: 'gb',
      filters: { keywords: 'staff engineer', minimumSalary: 65000, maximumSalary: 190000 }, limit: 100 } });
    assert.equal(result.data.provider, 'reed');
    assert.equal(result.data.scope.region, 'gb');
    assert.equal(result.data.jobs.length, 1);
    assert.equal(result.data.requests[0].credentialsUsed, true);
    assert.equal(result.data.requests[0].authorizationSent, true);
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.equal(JSON.stringify(result).includes(Buffer.from(`${key}:`).toString('base64')), false);
    assert.equal(providerReads, 1);
  } finally { await registry.close(); }
});

test('common collect works for ATS boards, public feeds and Reed callers without synthetic offset defaults', async () => {
  const cases = [
    { provider: 'greenhouse', board: 'acme', payload: JSON.parse(await readFile(fileURLToPath(new URL('./fixtures/jobs/greenhouse-board.json', import.meta.url)), 'utf8')) },
    { provider: 'ashby', board: 'Ashby', payload: JSON.parse(await readFile(fileURLToPath(new URL('./fixtures/jobs/ashby-board.json', import.meta.url)), 'utf8')) },
    { provider: 'remotive', payload: JSON.parse(await boardFixture('remotive-page.json')) },
    { provider: 'reed', region: 'gb', payload: JSON.parse(await boardFixture('reed-page.json')), credentials: { reedApiKey: 'fixture-reed-collect-key' } },
  ];
  for (const item of cases) {
    let calls = 0;
    const registry = await createServiceRegistry('jobs-public', {
      now: () => when,
      ...(item.credentials ? { credentialProvider: async service => {
        assert.equal(service, 'jobs-public'); return item.credentials;
      } } : {}),
      fetchImpl: async url => {
        calls++;
        const target = new URL(String(url));
        if (item.provider === 'greenhouse') assert.equal(target.origin, 'https://boards-api.greenhouse.io');
        if (item.provider === 'ashby') assert.equal(target.origin, 'https://api.ashbyhq.com');
        if (item.provider === 'remotive') assert.equal(target.origin, 'https://remotive.com');
        if (item.provider === 'reed') assert.equal(target.origin, 'https://www.reed.co.uk');
        return response(item.payload);
      },
    });
    try {
      const result = await registry.execute('collect', { query: {
        provider: item.provider, ...(item.board ? { board: item.board } : {}),
        ...(item.region ? { region: item.region } : {}),
      } });
      assert.ok(result.data.jobs.length > 0, item.provider);
      assert.equal(result.data.coverage.complete, true, item.provider);
      assert.equal(calls, 1, item.provider);
    } finally { await registry.close(); }
  }
});

test('TokyoDev job list keeps Japan-specific source eligibility facts through the service registry', async () => {
  const listPage = await japanFixture('tokyodev-list.html');
  let called = 0;
  const registry = await createServiceRegistry('jobs-public', { now: () => when,
    fetchImpl: async (url, init) => {
      called++;
      assert.equal(url, 'https://www.tokyodev.com/jobs');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      return new Response(listPage, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    } });
  try {
    const result = await registry.execute('list', { query: { provider: 'tokyodev', region: 'jp' } });
    assert.equal(result.data.provider, 'tokyodev');
    assert.equal(result.data.scope.region, 'jp');
    assert.equal(result.data.coverage.complete, true);
    assert.equal(result.data.jobs.length, 2);
    assert.equal(result.data.jobs[0].sourceFacts.japaneseSkillRequirement, 'No Japanese required');
    assert.equal(result.data.jobs[0].sourceFacts.canApplyFromAbroad, true);
    assert.equal(result.data.jobs[0].sourceFacts.residencyRequirement, null);
    assert.equal(Object.hasOwn(result.data.jobs[0].sourceFacts, 'visaSponsorship'), false);
    assert.equal(called, 1);
  } finally { await registry.close(); }
});

test('TokyoDev detail accepts a selected canonical URL and preserves explicit Japan work facts', async () => {
  const page = await japanFixture('tokyodev-detail.html');
  const url = 'https://www.tokyodev.com/companies/example/jobs/platform-engineer-tokyo';
  const registry = await createServiceRegistry('jobs-public', { now: () => when,
    fetchImpl: async (target, init) => {
      assert.equal(String(target), url);
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    } });
  try {
    const result = await registry.execute('detail', { path: { provider: 'tokyodev', url }, query: { region: 'jp' } });
    assert.equal(result.data.jobs[0].id, 'example:platform-engineer-tokyo');
    assert.equal(result.data.jobs[0].sourceFacts.japaneseSkillRequirement, null,
      'the parser does not split the mixed detail-page label into an inferred requirement');
    assert.equal(result.data.jobs[0].sourceFacts.canApplyFromAbroad, true);
    assert.equal(Object.hasOwn(result.data.jobs[0].sourceFacts, 'visaSponsorship'), false);
    await assert.rejects(registry.execute('detail', { path: {
      provider: 'tokyodev', url: 'https://evil.example/companies/example/jobs/platform-engineer-tokyo' }, query: { region: 'jp' } }),
    { code: 'TOKYODEV_JOB_URL_INVALID' });
  } finally { await registry.close(); }
});

