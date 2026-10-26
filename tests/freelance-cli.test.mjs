import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { runFreelanceCli, runFreelanceCommand } from '../scripts/freelance.mjs';

const fixture = name => readFile(fileURLToPath(new URL(`./fixtures/freelance/${name}`, import.meta.url)), 'utf8');
const NOW = Date.parse('2026-10-23T10:00:00.000Z');
const response = (body, mime = 'text/html; charset=utf-8', status = 200) => new Response(body, {
  status, headers: { 'content-type': mime },
});

async function tempDirectory(t) {
  const root = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch/tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'freelance-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Kmong home command preserves sampled listings and incomplete browse coverage', async () => {
  const html = await fixture('kmong-home.html');
  let calls = 0;
  const result = await runFreelanceCommand(['kmong', 'home'], {
    now: () => NOW,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, 'https://kmong.com/');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'manual');
      assert.equal(new Headers(init.headers).get('cookie'), null);
      return response(html);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.result.service, 'kmong');
  assert.deepEqual(result.result.items.map(item => item.id), ['70001', '70002']);
  assert.equal(result.result.pagination.complete, false);
  assert.equal(result.result.items[0].startingPrice.basis, 'displayed_starting_price');
});

test('Kmong detail keeps displayed package prices distinct from checkout totals', async () => {
  const html = await fixture('kmong-detail.html');
  const result = await runFreelanceCommand(['kmong', 'detail', '--id=70001'], {
    now: () => NOW,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://kmong.com/gig/70001');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      return response(html);
    },
  });
  assert.equal(result.result.gig.id, '70001');
  assert.deepEqual(result.result.gig.packages.map(item => item.price.amount), [50_000, 90_000, 150_000]);
  assert.equal(result.result.gig.packages[0].price.finalCheckoutAmountVerified, false);
});

test('Kmong search binds keyword, observed page, and the fixed page size without fetching another page', async () => {
  const payload = JSON.parse(await fixture('kmong-search-page1.json'));
  let calls = 0;
  const result = await runFreelanceCommand(['kmong', 'search', '--keyword=상세페이지', '--page=2', '--per-page=40'], {
    now: () => NOW,
    fetchImpl: async (url, init) => {
      calls++;
      const target = new URL(url);
      assert.equal(target.origin, 'https://api.kmong.com');
      assert.equal(target.pathname, '/gig-app/gig/v2/gigs/search');
      assert.equal(target.searchParams.get('keyword'), '상세페이지');
      assert.equal(target.searchParams.get('page'), '2');
      assert.equal(target.searchParams.get('perPage'), '40');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      return new Response(JSON.stringify({ ...payload, currentPage: 2 }), { status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.result.keyword, '상세페이지');
  assert.equal(result.result.pagination.page, 2);
  assert.equal(result.result.pagination.pageWalked, false);
  assert.equal(result.result.pagination.nextPage, 3);
  assert.equal(result.result.items.length, 2);
});

test('Soomgo command calls the matching public route and keeps provider private fields out', async () => {
  let url;
  const result = await runFreelanceCommand(['soomgo', 'search', '--category-1=이사-청소A',
    '--category-2=이사A', '--service-slug=원룸-소형-이사', '--address1=서울특별시', '--limit=5'], {
    now: () => NOW,
    fetchImpl: async (target, init) => {
      url = target;
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(new Headers(init.headers).get('authorization'), null);
      assert.equal(new Headers(init.headers).get('cookie'), null);
      return new Response(JSON.stringify({ code: 0, reason: '', request: '', response: {
        cursor: '', totalCount: 1, sortBy: 'review_count', results: [{ id: 1234,
          mainService: { id: 728, name: '원룸 이사', slug: '원룸-소형-이사' },
          services: [{ id: 728, name: '원룸 이사', slug: '원룸-소형-이사' }],
          address: '서울 강남구', avgResponseTime: 300, career: 2, isSafePayment: true,
          hasApprovedLicenseBadge: false, canReserve: false, adDisplay: false,
          user: { id: 991, name: 'must not be included' },
          recentReview: { id: 4, contents: 'must not be included either', rate: 5 },
        }],
      } }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    },
  });
  assert.equal(url.origin, 'https://api.soomgo.com');
  assert.equal(url.pathname, '/v2/search/pro');
  assert.equal(url.searchParams.get('category1'), '이사-청소A');
  assert.equal(url.searchParams.get('category2'), '이사A');
  assert.equal(url.searchParams.get('service_slug'), '원룸-소형-이사');
  assert.equal(url.searchParams.get('address1'), '서울특별시');
  assert.equal(result.result.items.length, 1);
  assert.equal(result.result.items[0].providerId, '1234');
  assert.equal(result.result.items[0].location, '서울 강남구');
  assert.equal(JSON.stringify(result.result).includes('must not be included'), false);
});

test('Soomgo input and pagination limit errors are rejected before transport', async () => {
  let calls = 0;
  const context = { fetchImpl: async () => { calls++; throw new Error('unexpected request'); } };
  await assert.rejects(runFreelanceCommand(['soomgo', 'subcategories'], context), { code: 'ARGUMENT_INVALID' });
  await assert.rejects(runFreelanceCommand(['soomgo', 'collect', '--max-pages=20'], context), { code: 'ARGUMENT_INVALID' });
  await assert.rejects(runFreelanceCommand(['kmong', 'reviews', '--id=1', '--page=100001'], context), { code: 'ARGUMENT_INVALID' });
  assert.equal(calls, 0);
});

test('Upwork can only run with a caller-tagged OAuth token, kept out of its output', async () => {
  const secret = 'oauth2v2_fixture-token-never-persist';
  const fixtureValue = JSON.parse(await fixture('upwork-search.json'));
  const result = await runFreelanceCommand(['upwork', 'search', '--credentials-stdin', '--query=GraphQL migration', '--limit=5'], {
    now: () => NOW,
    credentials: { provider: 'upwork', accessToken: secret },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.upwork.com/graphql');
      assert.equal(init.method, 'POST');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.get('authorization'), `Bearer ${secret}`);
      assert.equal(init.headers.get('cookie'), null);
      return new Response(JSON.stringify(fixtureValue), { status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' } });
    },
  });
  assert.equal(result.result.provider, 'upwork');
  assert.equal(result.result.access.liveVerification, 'pending_live');
  assert.equal(JSON.stringify(result.result).includes(secret), false);
});

test('existing output is preserved and rejected before the public provider is called', async t => {
  const directory = await tempDirectory(t);
  const output = path.join(directory, 'original.json');
  await (await import('node:fs/promises')).writeFile(output, 'keep');
  let calls = 0;
  let stdout = '';
  const sink = new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); } });
  const exitCode = await runFreelanceCli(['kmong', 'home', `--output=${output}`], {
    stdout: sink, fetchImpl: async () => { calls++; return response('<html></html>'); },
  });
  assert.equal(exitCode, 1);
  assert.equal(calls, 0);
  assert.match(stdout, /EEXIST/);
  assert.equal(await readFile(output, 'utf8'), 'keep');
  assert.equal((await stat(output)).size, 4);
});

test('Kmong challenge response keeps a provider error code and removes the newly reserved empty output', async t => {
  const directory = await tempDirectory(t);
  const output = path.join(directory, 'failed.json');
  let stdout = '';
  const sink = new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); } });
  const exitCode = await runFreelanceCli(['kmong', 'home', `--output=${output}`], {
    stdout: sink, fetchImpl: async () => response('Access denied', 'text/html', 403),
  });
  assert.equal(exitCode, 1);
  assert.match(stdout, /KMONG_HTTP_STATUS_INVALID/);
  assert.equal(stdout.includes('Access denied'), false);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('Kmong collection resumes only the matching keyword and keeps complete imported checkpoints offline', async t => {
  const directory = await tempDirectory(t);
  const template = JSON.parse(await fixture('kmong-search-page1.json'));
  const calls = [];
  const context = { now: () => NOW, fetchImpl: async target => {
    const page = Number(new URL(target).searchParams.get('page'));
    calls.push(page);
    return response(JSON.stringify({ ...template, currentPage: page, totalItemCount: 41, lastPage: 2,
      gigs: Array.from({ length: page === 1 ? 40 : 1 }, (_, i) => ({ ...template.gigs[0], gigId: 1000 + (page - 1) * 40 + i })),
    }), 'application/json');
  } };
  const first = (await runFreelanceCommand(['kmong', 'search-collect', '--keyword=상세페이지'], context)).result;
  assert.equal(first.status, 'partial');
  assert.equal(first.ok, true);
  assert.equal(first.pagination.nextPage, 2);
  const checkpoint = path.join(directory, 'checkpoint.json');
  await writeFile(checkpoint, JSON.stringify(first));
  await assert.rejects(runFreelanceCommand(['kmong', 'search-collect', '--keyword=다른검색', `--input=${checkpoint}`], context),
    { code: 'KMONG_COLLECTION_STATE_SCOPE_MISMATCH' });
  const second = (await runFreelanceCommand(['kmong', 'search-collect', '--keyword=상세페이지', `--input=${checkpoint}`], context)).result;
  assert.deepEqual(calls, [1, 2]);
  assert.equal(second.status, 'complete');
  assert.equal(second.items.length, 41);
  assert.equal(second.pagination.completeCatalog, false);
  await writeFile(checkpoint, JSON.stringify(second.state));
  const cached = (await runFreelanceCommand(['kmong', 'search-collect', '--keyword=상세페이지', `--input=${checkpoint}`], context)).result;
  assert.deepEqual(calls, [1, 2]);
  assert.equal(cached.networkUsed, false);
  assert.equal(cached.observedAt, null);
  assert.equal(cached.checkpointProvenance, 'caller_supplied');
});

test('Kmong collection errors keep a checkpoint but return nonzero and disable challenge retries', async t => {
  const directory = await tempDirectory(t);
  const output = path.join(directory, 'partial.json');
  let stdout = '';
  const context = { now: () => NOW,
    stdout: new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); } }),
    fetchImpl: async () => response('Access denied', 'text/html', 403),
  };
  const exit = await runFreelanceCli(['kmong', 'search-collect', '--keyword=번역', `--output=${output}`], context);
  assert.equal(exit, 1);
  assert.equal(JSON.parse(stdout).ok, false);
  const result = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.error.code, 'KMONG_HTTP_STATUS_INVALID');
  assert.equal(result.state.resumeAllowed, false);
  assert.equal(result.state.nextPage, 1);
  assert.equal(JSON.stringify(result).includes('Access denied'), false);
  await assert.rejects(runFreelanceCommand(['kmong', 'search-collect', '--keyword=번역', `--input=${output}`], context),
    { code: 'KMONG_COLLECTION_RESUME_DISABLED' });
});

test('Kmong malformed checkpoints and invalid page bounds fail before transport', async t => {
  const directory = await tempDirectory(t);
  const checkpoint = path.join(directory, 'malformed.json');
  let calls = 0;
  const context = { fetchImpl: async () => { calls++; throw new Error('unexpected request'); } };
  await writeFile(checkpoint, JSON.stringify({ schemaVersion: 1, service: 'kmong', state: null }));
  await assert.rejects(runFreelanceCommand(['kmong', 'reviews-collect', '--id=466087', `--input=${checkpoint}`], context),
    { code: 'KMONG_COLLECTION_INPUT_INVALID' });
  await assert.rejects(runFreelanceCommand(['kmong', 'search-collect', '--keyword=번역', '--max-pages=0'], context),
    { code: 'KMONG_COLLECTION_MAX_PAGES_INVALID' });
  await assert.rejects(runFreelanceCommand(['kmong', 'reviews-collect', '--id=466087', '--max-pages=6'], context),
    { code: 'ARGUMENT_INVALID' });
  assert.equal(calls, 0);
});
