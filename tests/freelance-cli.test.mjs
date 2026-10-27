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

test('Soomgo form and address reads use the observed API; request preparation stays local', async t => {
  const formFixture = JSON.parse(await fixture('soomgo-request-form-20261027.json'));
  const addressFixture = JSON.parse(await fixture('soomgo-addresses-area3-first-record.json'));
  const directory = await tempDirectory(t);
  const formPath = path.join(directory, 'form.json');
  await writeFile(formPath, JSON.stringify({
    schemaVersion: 1, service: 'soomgo', operation: 'service_request_form',
    form: formFixture.form,
  }));
  const requests = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(String(url));
    requests.push({ target, init });
    assert.equal(target.origin, 'https://api.soomgo.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('cookie'), null);
    if (target.pathname === '/v2/services/%EA%B0%80%EC%A0%95-%EC%9D%B4%EC%82%AC-%ED%88%AC%EB%A3%B8-%EC%93%B0%EB%A6%AC%EB%A3%B8/form') {
      return new Response(JSON.stringify({ code: 0, response: formFixture.form }), {
        status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    if (target.pathname === '/v1/requests/forms/addresses') {
      assert.equal(target.searchParams.get('depth'), 'area3');
      return new Response(JSON.stringify({ code: 0, response: { addresses: addressFixture.items } }), {
        status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    throw new Error('unexpected Soomgo route');
  };

  const formResult = await runFreelanceCommand([
    'soomgo', 'request-form', '--service-id=729', '--service-slug=가정-이사-투룸-쓰리룸', '--service-name=가정이사(투룸 이상)',
  ], { fetchImpl, now: () => NOW });
  assert.equal(formResult.result.operation, 'service_request_form');
  assert.equal(formResult.result.form.id, formFixture.form.id);
  assert.equal(formResult.result.dispatch.supported, false);
  assert.equal(requests.length, 1);

  const addressesResult = await runFreelanceCommand(['soomgo', 'address-options', '--depth=3'], {
    fetchImpl, now: () => NOW,
  });
  assert.equal(addressesResult.result.operation, 'address_options');
  assert.equal(addressesResult.result.items[0].addressRowid, 3);
  assert.equal(requests.length, 2);
  await assert.rejects(runFreelanceCommand(['soomgo', 'address-options', '--depth=2'], {
    fetchImpl: async () => assert.fail('unobserved address depth must fail before fetch'),
  }), { code: 'ARGUMENT_INVALID' });

  const prepared = await runFreelanceCommand(['soomgo', 'request-prepare', `--form=${formPath}`], {
    fetchImpl: async () => { throw new Error('local preparation must not call the provider'); },
    now: () => NOW,
  });
  assert.equal(prepared.result.status, 'prepared_only');
  assert.equal(prepared.result.gates.requestSent, false);
  assert.equal(prepared.result.gates.externallySubmitted, false);
  assert.equal(prepared.result.networkUsed, false);
  assert.equal(prepared.result.writesSubmitted, 0);
  assert.equal(prepared.result.gates.dispatchSupported, false);

  const oversizedAnswers = path.join(directory, 'oversized-answers.json');
  await writeFile(oversizedAnswers, Buffer.alloc(128 * 1024 + 1, 0x20));
  await assert.rejects(runFreelanceCommand([
    'soomgo', 'request-prepare', `--form=${formPath}`, `--answers=${oversizedAnswers}`,
  ], { fetchImpl: async () => assert.fail('local preparation must not fetch'), now: () => NOW }), {
    code: 'SOOMGO_REQUEST_INPUT_TOO_LARGE',
  });

  await assert.rejects(runFreelanceCommand(['soomgo', 'request-form', '--service-id=729'], {
    fetchImpl: async () => assert.fail('incomplete service identity must fail before fetch'),
  }), { code: 'ARGUMENT_INVALID' });
});

test('Soomgo profile and portfolio CLI commands map to the new read-only profile client', async () => {
  const source = JSON.parse(await fixture('soomgo-profile.json'));
  const calls = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(String(url));
    calls.push(target);
    assert.equal(target.origin, 'https://api.soomgo.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    const response = target.pathname.endsWith('/profile') ? source.profile
      : target.pathname.endsWith('/profile-contents') ? source.contents
        : target.pathname.endsWith('/portfolios') ? source.portfolios : source.reviews;
    return new Response(JSON.stringify({ code: 0, reason: '', request: '', response }), {
      status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };
  const profile = await runFreelanceCommand(['soomgo', 'profile', '--user-id=7847767', '--expected-provider-id=993707'], {
    fetchImpl, now: () => NOW,
  });
  assert.equal(profile.result.identity.providerMatchVerified, true);
  assert.equal(profile.result.identity.ownerVerified, false);
  const portfolio = await runFreelanceCommand(['soomgo', 'portfolio', '--user-id=7847767', '--size=8'], {
    fetchImpl, now: () => NOW,
  });
  assert.equal(portfolio.result.operation, 'profile_portfolios');
  const contents = await runFreelanceCommand(['soomgo', 'profile-contents', '--user-id=7847767'], {
    fetchImpl, now: () => NOW,
  });
  assert.equal(contents.result.operation, 'profile_contents');
  const reviews = await runFreelanceCommand(['soomgo', 'profile-reviews', '--user-id=7847767'], {
    fetchImpl, now: () => NOW,
  });
  assert.equal(reviews.result.operation, 'profile_reviews');
  assert.deepEqual(calls.map(call => call.pathname), [
    '/v2/user/7847767/profile', '/v2/users/7847767/portfolios',
    '/v1/providers/7847767/profile-contents', '/v3/users/7847767/reviews/received',
  ]);
  await assert.rejects(runFreelanceCommand(['soomgo', 'portfolio', '--user-id=7847767', '--size=6'], {
    fetchImpl: async () => assert.fail('unsupported portfolio size must not fetch'),
  }), { code: 'SOOMGO_PROFILE_PORTFOLIO_SIZE_INVALID' });
});

test('Soomgo profile review CLI accepts only the observed cursor continuation and respects five-page cap', async () => {
  const source = JSON.parse(await fixture('soomgo-profile.json'));
  const requests = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(String(url));
    requests.push(target);
    assert.equal(target.origin, 'https://api.soomgo.com');
    assert.equal(target.pathname, '/v3/users/7847767/reviews/received');
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    const cursor = target.searchParams.get('next_cursor');
    if (cursor !== null) {
      assert.deepEqual([...target.searchParams], [
        ['next_cursor', 'fixture-cursor'], ['is_photo_review', 'false'], ['is_pay_verified', 'false'],
        ['sort_type', 'latest'], ['size', '3'], ['role', 'provider'],
      ]);
    } else assert.deepEqual([...target.searchParams], [['size', '3'], ['role', 'provider']]);
    const page = cursor === null ? 1 : 2;
    const response = structuredClone(source.reviews);
    response.items = Array.from({ length: 3 }, (_, index) => ({ ...structuredClone(source.reviews.items[0]),
      id: `cli-review-${page}-${index}` }));
    response.pagination = { ...response.pagination, currentCount: page * 3, totalCount: 6,
      hasNextPage: page === 1, nextCursor: page === 1 ? 'fixture-cursor' : '' };
    return new Response(JSON.stringify({ code: 0, response }), {
      status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };
  const direct = await runFreelanceCommand(['soomgo', 'profile-reviews', '--user-id=7847767', '--next-cursor=fixture-cursor'], {
    fetchImpl, now: () => NOW,
  });
  assert.equal(direct.result.pagination.resumedFromCursor, true);
  assert.equal(requests.length, 1);

  const collected = await runFreelanceCommand(['soomgo', 'profile-reviews-collect', '--user-id=7847767', '--max-pages=2'], {
    fetchImpl, now: () => NOW,
  });
  assert.equal(collected.result.operation, 'profile_reviews_collect');
  assert.equal(collected.result.pagination.pages, 2);
  assert.equal(collected.result.pagination.complete, true);
  assert.equal(requests.length, 3);

  await assert.rejects(runFreelanceCommand(['soomgo', 'profile-reviews-collect', '--user-id=7847767', '--max-pages=6'], {
    fetchImpl: async () => assert.fail('page limit must fail before a request'),
  }), { code: 'ARGUMENT_INVALID' });
});

test('Soomgo portfolio CLI passes only the observed size-8 cursor and collects within five pages', async () => {
  const source = JSON.parse(await fixture('soomgo-profile.json'));
  const requests = [];
  let collectionActive = false;
  const pageFor = pageNumber => {
    const page = structuredClone(source.portfolios);
    const returned = pageNumber === 3 ? 4 : 8;
    page.items = Array.from({ length: returned }, (_, index) => ({
      ...structuredClone(source.portfolios.items[0]), id: `cli-portfolio-${pageNumber}-${index}`,
    }));
    page.pagination = {
      ...page.pagination,
      size: 8,
      currentCount: Math.min(pageNumber * 8, 20),
      totalCount: 20,
      hasNextPage: pageNumber < 3,
      hasPrevPage: pageNumber > 1,
      nextCursor: pageNumber < 3 ? `cli-portfolio-page-${pageNumber + 1}` : '',
    };
    return page;
  };
  const fetchImpl = async (url, init) => {
    const target = new URL(String(url));
    requests.push(target);
    assert.equal(target.origin, 'https://api.soomgo.com');
    assert.equal(target.pathname, '/v2/users/7847767/portfolios');
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(target.searchParams.get('size'), '8');
    const cursor = target.searchParams.get('next_cursor');
    if (!collectionActive) {
      assert.equal(cursor, 'cli-direct-cursor');
      return new Response(JSON.stringify({ code: 0, reason: '', request: '', response: source.portfolios }), {
        status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    const pageNumber = cursor === null ? 1 : cursor === 'cli-portfolio-page-2' ? 2 : 3;
    if (cursor !== null) assert.deepEqual([...target.searchParams].map(([key]) => key), ['size', 'next_cursor']);
    return new Response(JSON.stringify({ code: 0, reason: '', request: '', response: pageFor(pageNumber) }), {
      status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };

  const direct = await runFreelanceCommand([
    'soomgo', 'portfolio', '--user-id=7847767', '--size=8', '--next-cursor=cli-direct-cursor',
  ], { fetchImpl, now: () => NOW });
  assert.equal(direct.result.pagination.resumedFromCursor, true);
  assert.deepEqual([...requests[0].searchParams], [['size', '8'], ['next_cursor', 'cli-direct-cursor']]);

  collectionActive = true;
  const collected = await runFreelanceCommand([
    'soomgo', 'portfolio-collect', '--user-id=7847767', '--size=8', '--max-pages=3',
  ], { fetchImpl, now: () => NOW });
  assert.equal(collected.result.operation, 'profile_portfolios_collect');
  assert.equal(collected.result.items.length, 20);
  assert.equal(collected.result.pagination.pages, 3);
  assert.equal(collected.result.pagination.complete, true);
  assert.deepEqual([...requests[1].searchParams], [['size', '8']]);
  assert.equal(requests.length, 4, 'one direct continuation plus three collected pages');

  await assert.rejects(runFreelanceCommand([
    'soomgo', 'portfolio-collect', '--user-id=7847767', '--max-pages=6',
  ], { fetchImpl: async () => assert.fail('page cap must reject before transport') }), { code: 'ARGUMENT_INVALID' });
  await assert.rejects(runFreelanceCommand([
    'soomgo', 'portfolio-collect', '--user-id=7847767', '--size=4', '--max-pages=2',
  ], { fetchImpl: async () => assert.fail('unobserved size-4 continuation must reject before transport') }), {
    code: 'SOOMGO_PROFILE_PORTFOLIO_CONTINUATION_UNVERIFIED',
  });
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
