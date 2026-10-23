import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { runJobsCli, runJobsCommand } from '../scripts/jobs.mjs';

const NOW = Date.parse('2026-10-23T10:00:00.000Z');
const TOKYO_FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/jobs-japan');
const job = (id = 44) => ({ id, title: 'Platform Engineer', company_name: 'Example Co',
  absolute_url: `https://job-boards.greenhouse.io/example/jobs/${id}`, first_published: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-20T00:00:00Z', application_deadline: null,
  content: '<p>Build reliable services</p>', location: { name: 'London, United Kingdom' },
  offices: [], departments: [], });
const json = (value, { status = 200, mime = 'application/json' } = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': mime } });

async function tempDirectory(t) {
  const root = '/home/worker/.nad-scratch/tmp';
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'jobs-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Greenhouse command returns normalized public listings and completion evidence', async () => {
  let requests = 0;
  const result = await runJobsCommand(['greenhouse', 'list', '--board=example'], {
    now: () => NOW,
    fetchImpl: async (url, init) => {
      requests++;
      assert.equal(url.origin, 'https://boards-api.greenhouse.io');
      assert.equal(url.pathname, '/v1/boards/example/jobs');
      assert.equal(url.searchParams.get('content'), 'true');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.has('authorization'), false);
      return json({ jobs: [job()], meta: { total: 1 } });
    },
  });
  assert.equal(result.result.provider, 'greenhouse');
  assert.equal(result.result.jobs[0].key, 'greenhouse:global:example:44');
  assert.equal(result.result.jobs[0].title, 'Platform Engineer');
  assert.equal(result.result.jobs[0].compensation, null);
  assert.equal(result.result.coverage.complete, true);
  assert.equal(result.result.coverage.returned, 1);
  assert.equal(requests, 1);
});

test('argument and provider errors stop before making any request', async () => {
  let requests = 0;
  const context = { fetchImpl: async () => { requests++; throw new Error('should not request'); } };
  await assert.rejects(runJobsCommand(['greenhouse', 'list', '--board=example', '--max-pages=2'], context),
    { code: 'ARGUMENT_INVALID' });
  await assert.rejects(runJobsCommand(['greenhouse', 'unknown', '--board=example'], context),
    { code: 'OPERATION_INVALID' });
  await assert.rejects(runJobsCommand(['reed', 'list', '--credentials-stdin'], context),
    { code: 'CREDENTIALS_REQUIRED' });
  assert.equal(requests, 0);
});

test('Reed caller key stays out of the result and scopes only its Basic-auth request', async () => {
  const secret = 'caller-key-never-print-this';
  let authorization;
  const output = await runJobsCommand(['reed', 'list', '--credentials-stdin', '--query=engineer', '--page-size=2'], {
    now: () => NOW,
    credentials: { provider: 'reed', apiKey: secret },
    fetchImpl: async (url, init) => {
      assert.equal(url.origin, 'https://www.reed.co.uk');
      assert.equal(url.pathname, '/api/1.0/search');
      assert.equal(url.searchParams.get('keywords'), 'engineer');
      assert.equal(url.searchParams.get('resultsToTake'), '2');
      assert.equal(init.credentials, 'omit');
      authorization = init.headers.authorization;
      return json([{ jobId: 12, jobTitle: 'Engineer', employerName: 'Example', locationName: 'Leeds',
        category: 'Technology', jobDescription: 'Build software', minimumSalary: 40_000, maximumSalary: 50_000,
        date: '2026-10-01T00:00:00Z' }]);
    },
  });
  assert.equal(authorization, `Basic ${Buffer.from(`${secret}:`).toString('base64')}`);
  assert.equal(JSON.stringify(output.result).includes(secret), false);
  assert.equal(JSON.stringify(output.result).includes(authorization), false);
  assert.equal(output.result.jobs[0].compensation.components[0].currency, null);
  assert.equal(output.result.coverage.complete, true);
});

test('snapshot and diff commands work offline from bounded JSON inputs', async t => {
  const directory = await tempDirectory(t);
  const firstInput = path.join(directory, 'first-live-envelope.json');
  const secondInput = path.join(directory, 'second-live-envelope.json');
  const firstPath = path.join(directory, 'first.json');
  const secondPath = path.join(directory, 'second.json');
  const live = await runJobsCommand(['greenhouse', 'list', '--board=example'], {
    now: () => NOW,
    fetchImpl: async () => json({ jobs: [job()], meta: { total: 1 } }),
  });
  const after = structuredClone(live.result);
  after.observedAt = new Date(NOW + 1_000).toISOString();
  after.jobs[0].title = 'Senior Platform Engineer';
  await Promise.all([
    writeFile(firstInput, JSON.stringify(live.result)), writeFile(secondInput, JSON.stringify(after)),
  ]);
  const first = await runJobsCommand(['snapshot', `--input=${firstInput}`]);
  const second = await runJobsCommand(['snapshot', `--input=${secondInput}`]);
  await Promise.all([writeFile(firstPath, JSON.stringify(first.result)), writeFile(secondPath, JSON.stringify(second.result))]);
  const diff = await runJobsCommand(['diff', `--before=${firstPath}`, `--after=${secondPath}`]);
  assert.equal(diff.result.changed.length, 1);
  assert.deepEqual(diff.result.changed[0].fields, ['title']);
  assert.equal(diff.result.missingFromLatest.length, 0);
  assert.equal(diff.output, null);
});

test('existing output file is preserved and the service is not contacted', async t => {
  const directory = await tempDirectory(t);
  const file = path.join(directory, 'already-there.json');
  await writeFile(file, 'keep this original');
  let requests = 0;
  let stdout = '';
  const sink = new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); } });
  const exitCode = await runJobsCli(['greenhouse', 'list', '--board=example', `--output=${file}`], {
    stdout: sink, fetchImpl: async () => { requests++; return json({ jobs: [], meta: { total: 0 } }); },
  });
  assert.equal(exitCode, 1);
  assert.equal(requests, 0);
  assert.match(stdout, /EEXIST|OPERATION_FAILED/);
  assert.equal(await readFile(file, 'utf8'), 'keep this original');
  assert.equal((await stat(file)).size, 'keep this original'.length);
});

test('failed public HTTP request retains its specific safe code and cleans a newly reserved empty output', async t => {
  const directory = await tempDirectory(t);
  const file = path.join(directory, 'not-created-on-failure.json');
  let stdout = '';
  const sink = new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); } });
  const exitCode = await runJobsCli(['greenhouse', 'list', '--board=example', `--output=${file}`], {
    stdout: sink, fetchImpl: async () => json({ message: 'throttle details stay out' }, { status: 429 }),
  });
  assert.equal(exitCode, 1);
  assert.match(stdout, /JOBS-GREENHOUSE_THROTTLED/);
  assert.equal(stdout.includes('throttle details'), false);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('Remotive preserves the source link and attribution metadata', async () => {
  const result = await runJobsCommand(['remotive', 'list', '--query=platform engineer'], {
    now: () => NOW,
    fetchImpl: async (url, init) => {
      assert.equal(url.origin, 'https://remotive.com');
      assert.equal(url.pathname, '/api/remote-jobs');
      assert.equal(url.searchParams.get('search'), 'platform engineer');
      assert.equal(init.credentials, 'omit');
      return json({ 'job-count': 1, jobs: [{ id: 909, title: 'Platform Engineer', company_name: 'Example',
        url: 'https://remotive.com/remote-jobs/example/909', candidate_required_location: 'Worldwide',
        job_type: 'full_time', category: 'Software Development', description: '<p>Build systems</p>',
        salary: '$120k-$150k', publication_date: '2026-10-23T09:00:00' }] });
    },
  });
  assert.equal(result.result.jobs[0].url, 'https://remotive.com/remote-jobs/example/909');
  assert.equal(result.result.jobs[0].compensation.summary, '$120k-$150k');
  assert.equal(result.result.source.attributionRequired, true);
});

test('TokyoDev CLI keeps Japan-specific work eligibility source facts intact', async () => {
  const html = await readFile(path.join(TOKYO_FIXTURES, 'tokyodev-list.html'), 'utf8');
  const result = await runJobsCommand(['tokyodev', 'list'], {
    now: () => NOW,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://www.tokyodev.com/jobs');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'manual');
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  assert.equal(result.result.provider, 'tokyodev');
  assert.equal(result.result.jobs[0].sourceFacts.japaneseSkillRequirement, 'No Japanese required');
  assert.equal(result.result.jobs[0].sourceFacts.canApplyFromAbroad, true);
  assert.equal(result.result.coverage.complete, true);
});

test('TokyoDev offline list parser consumes a bounded user file and never performs a request', async t => {
  const directory = await tempDirectory(t);
  const html = await readFile(path.join(TOKYO_FIXTURES, 'tokyodev-list.html'), 'utf8');
  const input = path.join(directory, 'saved-tokyodev-jobs.html');
  await writeFile(input, html);
  let requests = 0;
  const result = await runJobsCommand(['tokyodev', 'parse', `--input=${input}`, '--url=https://www.tokyodev.com/jobs'], {
    now: () => NOW,
    fetchImpl: async () => { requests++; throw new Error('offline parsing must not request'); },
  });
  assert.equal(requests, 0);
  assert.equal(result.result.operation, 'parse-list');
  assert.equal(result.result.executionMode, 'offline');
  assert.equal(result.result.networkUsed, false);
  assert.equal(result.result.provenance, 'caller_supplied_document');
  assert.equal(result.result.liveReplay, false);
  assert.equal(result.result.liveCurrentness, 'unknown');
  assert.equal(result.result.checkedAt, new Date(NOW).toISOString());
  assert.equal(result.result.coverage.complete, true);
  assert.equal(result.result.jobs[0].sourceFacts.canApplyFromAbroad, true);
  assert.deepEqual(result.result.requests, []);
  assert.equal(Object.hasOwn(result.result, 'httpStatus'), false);
  assert.match(result.result.sourceDocument.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result.result.sourceDocument, 'body'), false);
});

test('TokyoDev offline detail parser requires the canonical source URL and exact saved page', async t => {
  const directory = await tempDirectory(t);
  const html = await readFile(path.join(TOKYO_FIXTURES, 'tokyodev-detail.html'), 'utf8');
  const input = path.join(directory, 'saved-detail.html');
  await writeFile(input, html);
  let requests = 0;
  const detailUrl = 'https://www.tokyodev.com/companies/example/jobs/platform-engineer-tokyo';
  const result = await runJobsCommand(['tokyodev', 'parse', `--input=${input}`, `--url=${detailUrl}`], {
    now: () => NOW,
    fetchImpl: async () => { requests++; throw new Error('offline parsing must not request'); },
  });
  assert.equal(requests, 0);
  assert.equal(result.result.operation, 'parse-detail');
  assert.equal(result.result.scope.filters.id, 'example:platform-engineer-tokyo');
  assert.equal(result.result.jobs[0].url, detailUrl);
  assert.equal(result.result.jobs[0].sourceFacts.canApplyFromAbroad, true);
  await assert.rejects(runJobsCommand(['tokyodev', 'parse', `--input=${input}`]), { code: 'ARGUMENT_INVALID' });
  await assert.rejects(runJobsCommand(['tokyodev', 'parse', `--input=${input}`,
    '--url=https://www.tokyodev.com/companies/example/jobs/other-role']), { code: 'TOKYO_DEV_DETAIL_IDENTITY_MISMATCH' });
});

test('TokyoDev offline parser rejects a saved challenge document and cleans its empty output file', async t => {
  const directory = await tempDirectory(t);
  const input = path.join(directory, 'challenge.html');
  const output = path.join(directory, 'projection.json');
  await writeFile(input, '<html><body>Verify you are human</body></html>');
  let stdout = '';
  const sink = new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); } });
  const code = await runJobsCli(['tokyodev', 'parse', `--input=${input}`, '--url=https://www.tokyodev.com/jobs', `--output=${output}`], {
    stdout: sink, fetchImpl: async () => assert.fail('must remain offline'),
  });
  assert.equal(code, 1);
  assert.match(stdout, /TOKYODEV_ACCESS_CHALLENGE/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});
