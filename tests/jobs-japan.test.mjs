import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTokyoDevJobsClient, parseTokyoDevJobDetail, parseTokyoDevJobsPage,
} from '../lib/jobs/japan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/jobs-japan');
const listHtml = await readFile(path.join(root, 'tokyodev-list.html'), 'utf8');
const detailHtml = await readFile(path.join(root, 'tokyodev-detail.html'), 'utf8');
const response = (body, { status = 200, mime = 'text/html; charset=utf-8' } = {}) =>
  new Response(body, { status, headers: { 'content-type': mime } });

test('TokyoDev list parser binds official job URLs to the same company card', () => {
  const result = parseTokyoDevJobsPage(listHtml);
  assert.equal(result.jobs.length, 2);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.sourceTotal, 2);
  assert.equal(result.jobs[0].key, 'tokyodev:jp:jobs:example%3Aplatform-engineer-tokyo');
  assert.equal(result.jobs[0].id, 'example:platform-engineer-tokyo');
  assert.equal(result.jobs[0].url,
    'https://www.tokyodev.com/companies/example/jobs/platform-engineer-tokyo');
  assert.equal(result.jobs[0].company, 'Example Ltd');
  assert.equal(result.jobs[0].sourceFacts.japaneseSkillRequirement, 'No Japanese required');
  assert.equal(result.jobs[0].sourceFacts.canApplyFromAbroad, true);
  assert.equal(result.jobs[0].sourceFacts.residencyRequirement, null);
  assert.equal(result.jobs[0].sourceFacts.workplaceTypeLabel, 'Partially remote');
  assert.equal(result.jobs[0].sourceFacts.compensationLabel, '¥8M ~ ¥12M');
  assert.deepEqual(result.jobs[0].sourceFacts.categoryLabels, ['Kubernetes']);
  assert.equal(result.jobs[1].sourceFacts.canApplyFromAbroad, false);
  assert.equal(result.jobs[1].sourceFacts.residencyRequirement, 'Japan residents only');
  assert.equal(result.jobs[1].sourceFacts.japaneseSkillRequirement, 'Business Japanese');
  assert.equal(result.jobs[1].workplaceType, null, 'raw workplace label stays separate');
  assert.equal(result.jobs[1].compensation, null, 'an overview chip is not parsed as exact pay');
});

test('company namespacing prevents same role slug collisions across employer pages', () => {
  const card = (company, title) => `<li id="company_${company}"><h3><a href="/companies/${company}">${company} Ltd</a></h3>
    <div data-collapsable-list-target="item"><div><a href="/companies/${company}/jobs/senior-engineer">${title}</a></div></div></li>`;
  const html = `<!doctype html><html><body><main><h1>// 2 IT jobs for English speakers in Japan</h1><ul>
    ${card('one', 'Senior Engineer')} ${card('two', 'Senior Engineer')}</ul></main></body></html>`;
  const result = parseTokyoDevJobsPage(html);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.jobs.map(job => job.id), ['one:senior-engineer', 'two:senior-engineer']);
  assert.equal(new Set(result.jobs.map(job => job.key)).size, 2);
  assert.deepEqual(result.jobs.map(job => job.company), ['one Ltd', 'two Ltd']);
});

test('a source-confirmed zero-job listing is a complete empty snapshot', () => {
  const html = '<!doctype html><html><body><main><h1>// 0 IT jobs for English speakers in Japan</h1><ul></ul></main></body></html>';
  const result = parseTokyoDevJobsPage(html);
  assert.deepEqual(result.jobs, []);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.sourceTotal, 0);
});

test('a mismatched advertised total stays partial; empty HTML cannot become a valid zero-job result', () => {
  const changed = listHtml.replace('// 2 IT jobs', '// 3 IT jobs');
  const result = parseTokyoDevJobsPage(changed);
  assert.equal(result.jobs.length, 2);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'rendered_card_count_differs_from_advertised_total');
  assert.throws(() => parseTokyoDevJobsPage('<html><body><h1>Job board</h1></body></html>'),
    { code: 'TOKYO_DEV_LIST_SCHEMA_INVALID' });
});

test('job detail binds visible title, canonical URL and structured employer identity', () => {
  const url = 'https://www.tokyodev.com/companies/example/jobs/platform-engineer-tokyo';
  const job = parseTokyoDevJobDetail(detailHtml, { url });
  assert.equal(job.key, 'tokyodev:jp:jobs:example%3Aplatform-engineer-tokyo');
  assert.equal(job.id, 'example:platform-engineer-tokyo');
  assert.equal(job.sourceFacts.sourceId, '3421');
  assert.equal(job.company, 'Example Ltd');
  assert.equal(job.url, url);
  assert.equal(job.applyUrl, null, 'the detail page button is not an independently verified application endpoint');
  assert.equal(job.location, 'Shibuya-ku, Tokyo, JP');
  assert.deepEqual(job.locations, ['Shibuya-ku, Tokyo, JP']);
  assert.equal(job.employmentType, 'FULL_TIME');
  assert.deepEqual(job.compensation, {
    summary: '¥8,000,000 ~ ¥12,000,000 annually',
    components: [{ type: 'baseSalary', min: 8000000, max: 12000000, currency: 'JPY', interval: 'YEAR' }],
  });
  assert.match(job.descriptionText, /Build platform services/);
  assert.equal(job.descriptionText.includes('leak()'), false);
  assert.equal(job.sourceFacts.canApplyFromAbroad, true);
  assert.equal(job.sourceFacts.japaneseSkillRequirement, null,
    'a detail row combining a skill level and another language note is not a standalone Japanese requirement');
  assert.equal(job.sourceFacts.japaneseSkillRequirementRaw, 'No Japanese required Business English');
  assert.equal(Object.hasOwn(job.sourceFacts, 'visaSponsorship'), false);
  assert.equal(job.publishedAt, '2026-10-21T11:26:04.286+09:00');
  const underscoredUrl = 'https://www.tokyodev.com/companies/example_co/jobs/platform_engineer_tokyo';
  const underscoredHtml = detailHtml.replaceAll(
    'https://www.tokyodev.com/companies/example/jobs/platform-engineer-tokyo', underscoredUrl);
  assert.equal(parseTokyoDevJobDetail(underscoredHtml, { url: underscoredUrl }).id,
    'example_co:platform_engineer_tokyo');
  assert.throws(() => parseTokyoDevJobDetail(detailHtml,
    { url: 'https://evil.invalid/companies/example/jobs/platform-engineer-tokyo' }),
  { code: 'TOKYODEV_JOB_URL_INVALID' });
  assert.throws(() => parseTokyoDevJobDetail(detailHtml,
    { url: 'https://www.tokyodev.com/companies/example/jobs/another-role' }),
  { code: 'TOKYO_DEV_DETAIL_IDENTITY_MISMATCH' });
  assert.throws(() => parseTokyoDevJobDetail(detailHtml.replace('Platform Engineer, Tokyo</h1>', 'Other role</h1>'), { url }),
    { code: 'TOKYO_DEV_DETAIL_IDENTITY_MISMATCH' });
  const slash = String.fromCharCode(92);
  const encodedScript = `${slash}u003cscript${slash}u003eprivate text${slash}u003c/script${slash}u003e`;
  const withScript = parseTokyoDevJobDetail(detailHtml.replace('Build platform services.',
    'Build platform services.' + encodedScript), { url });
  assert.equal(withScript.descriptionText.includes('private text'), false);
});

test('client sends one anonymous bounded list GET to the observed origin', async () => {
  let calls = 0;
  const client = createTokyoDevJobsClient({ fetchImpl: async (url, init) => {
    calls++;
    assert.equal(new URL(url).href, 'https://www.tokyodev.com/jobs');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual([...new Headers(init.headers)], [['accept', 'text/html,application/xhtml+xml']]);
    assert.equal(init.headers.cookie, undefined);
    assert.equal(init.headers.authorization, undefined);
    return response(listHtml);
  }, now: () => Date.parse('2026-10-23T10:00:00.000Z') });
  const result = await client.list();
  assert.equal(calls, 1);
  assert.equal(result.jobs.length, 2);
  assert.equal(result.provider, 'tokyodev');
  assert.equal(result.scope.region, 'jp');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.requests[0].httpStatus, 200);
  assert.equal(result.requests[0].browserUsed, false);
  assert.equal(result.requests[0].anonymous, true);
  assert.equal(result.requests[0].credentialsUsed, false);
  assert.equal(Object.hasOwn(result.requests[0], 'html'), false);
  assert.equal(JSON.stringify(result.requests).includes('leak()'), false);
  assert.equal(result.requests[0].responseSha256.length, 64);
});

test('client returns one bounded, incomplete detail result from a first-party link', async () => {
  const requested = [];
  const client = createTokyoDevJobsClient({ fetchImpl: async (url, init) => {
    requested.push({ url: new URL(url).href, method: init.method });
    return response(detailHtml);
  } });
  const result = await client.detail({ url: 'https://www.tokyodev.com/companies/example/jobs/platform-engineer-tokyo' });
  assert.deepEqual(requested, [{
    url: 'https://www.tokyodev.com/companies/example/jobs/platform-engineer-tokyo', method: 'GET',
  }]);
  assert.equal(result.operation, 'detail');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'single_job_detail_not_a_board_snapshot');
});

test('invalid detail destinations fail before fetching and error responses remain explicit', async () => {
  let calls = 0;
  const client = createTokyoDevJobsClient({ fetchImpl: async (_url, _init) => {
    calls++;
    return response('<html>verify you are human · challenge-platform</html>');
  } });
  await assert.rejects(client.detail({ url: 'https://evil.invalid/jobs/fake' }),
    { code: 'TOKYODEV_JOB_URL_INVALID' });
  assert.equal(calls, 0);
  await assert.rejects(client.list(), { code: 'TOKYODEV_ACCESS_CHALLENGE' });
  for (const [reply, code] of [
    [response('denied', { status: 403 }), 'TOKYO_DEV_ACCESS_REJECTED'],
    [new Response(null, { status: 302, headers: { location: 'https://login.tokyodev.com/' } }), 'TOKYO_DEV_REDIRECT_REJECTED'],
    [response('{}', { mime: 'application/json' }), 'TOKYO_DEV_RESPONSE_INVALID'],
    [response('<html>rate-limited</html>', { status: 429 }), 'TOKYO_DEV_THROTTLED'],
  ]) {
    const current = createTokyoDevJobsClient({ fetchImpl: async () => reply });
    await assert.rejects(current.list(), { code });
  }
});
