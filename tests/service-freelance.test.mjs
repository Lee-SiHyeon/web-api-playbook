import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServiceRegistry, listServiceOperations } from '../lib/service-operations/index.mjs';

const at = Date.parse('2026-10-23T10:00:00Z');
const fixture = name => readFile(fileURLToPath(new URL(`./fixtures/freelance/${name}`, import.meta.url)), 'utf8');
const html = value => new Response(value, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

test('freelance operations are in the inventory without fetching or prompting for credentials', async () => {
  let calls = 0;
  const listing = await listServiceOperations({ includeUnconnected: false });
  const service = listing.services.find(item => item.id === 'freelance-public');
  assert.ok(service);
  assert.deepEqual(service.operations.sort(), [
    'kmong-categories', 'kmong-detail', 'kmong-home', 'kmong-reviews', 'kmong-search',
    'soomgo-categories', 'soomgo-pro-collect', 'soomgo-pro-search', 'soomgo-subcategories',
    'upwork-collect', 'upwork-job', 'upwork-search',
  ]);
  const metadata = await createServiceRegistry('freelance-public', {
    bind: false,
    fetchImpl: () => { calls++; throw new Error('inventory cannot make requests'); },
    credentialProvider: () => { calls++; throw new Error('inventory cannot request credentials'); },
  });
  await metadata.close();
  assert.equal(calls, 0);
});

test('Kmong detail uses the exact requested public gig and returns package prices with incomplete catalog scope', async () => {
  const page = await fixture('kmong-detail.html');
  const requests = [];
  const registry = await createServiceRegistry('freelance-public', { now: () => at,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.cookie, undefined);
      return html(page);
    } });
  try {
    const result = await registry.execute('kmong-detail', { path: { id: '70001' } });
    assert.equal(result.data.service, 'kmong');
    assert.equal(result.data.gig.id, '70001');
    assert.deepEqual(result.data.gig.packages.map(item => item.price.amount), [50_000, 90_000, 150_000]);
    assert.equal(result.data.gig.packages[0].price.currency, 'KRW');
    assert.equal(result.data.contractProvenance.kind, 'first_party_document');
    assert.equal(result.receipt.networkUsed, false, 'a fixture replay is not a live proof');
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).href, 'https://kmong.com/gig/70001');
    await assert.rejects(registry.execute('kmong-detail', { path: { id: '70002' } }),
      { code: 'KMONG_DETAIL_IDENTITY_MISMATCH' });
  } finally { await registry.close(); }
});

test('Kmong search keeps source price basis, exact IDs and one-page pagination', async () => {
  const page = JSON.parse(await fixture('kmong-search-page1.json'));
  let called = 0;
  const registry = await createServiceRegistry('freelance-public', { now: () => at,
    fetchImpl: async (url, init) => {
      called++;
      assert.equal(new URL(url).origin, 'https://api.kmong.com');
      assert.equal(new URL(url).pathname, '/gig-app/gig/v2/gigs/search');
      assert.equal(new URL(url).searchParams.get('keyword'), '상세페이지');
      assert.equal(new URL(url).searchParams.get('page'), '1');
      assert.equal(new URL(url).searchParams.get('perPage'), '40');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(new Headers(init.headers).get('cookie'), null);
      return json(page);
    } });
  try {
    const result = await registry.execute('kmong-search', { query: { keyword: '상세페이지' } });
    assert.equal(result.data.items.length, page.gigs.length);
    assert.equal(result.data.pagination.pageSize, 40);
    assert.equal(result.data.pagination.totalItemCount, 1200);
    assert.equal(result.data.pagination.complete, false);
    assert.equal(result.data.pagination.nextPage, 2);
    assert.equal(result.data.items[0].startingPrice.currency, 'KRW');
    assert.equal(result.receipt.networkUsed, false);
    assert.equal(called, 1);
  } finally { await registry.close(); }
});

test('Soomgo category and public pro-search operations use fixed origins and preserve partial search coverage', async () => {
  const requests = [];
  const registry = await createServiceRegistry('freelance-public', { now: () => at,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      const target = new URL(String(url));
      assert.equal(target.origin, 'https://api.soomgo.com');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      if (target.pathname === '/api2/categories/') {
        return json([{ id: 1, slug: 'design', title: '디자인' }]);
      }
      if (target.pathname === '/api2/categories/design') {
        return json([{ id: 11, slug: 'logo', title: '로고', services: [{ id: 111, slug: 'logo', title: '로고 디자인' }] }]);
      }
      if (target.pathname === '/v2/search/pro') return json({ code: 0, reason: '', request: '',
        response: { cursor: 'next-secret-free', results: [{ id: 42,
          mainService: { id: 1, slug: 'design', name: '디자인' },
          services: [{ id: 11, slug: 'logo', title: '로고' }], address: '서울 마포구',
          avgResponseTime: 3600, career: 4, isSafePayment: true, hasApprovedLicenseBadge: false, canReserve: true,
        }], sortBy: 'review_rate', totalCount: 21 } });
      throw new Error('unexpected path');
    } });
  try {
    const categories = await registry.execute('soomgo-categories', {});
    assert.equal(categories.data.items[0].slug, 'design');
    const children = await registry.execute('soomgo-subcategories', { path: { category1Slug: 'design' } });
    assert.equal(children.data.items[0].services[0].name, '로고 디자인');
    const result = await registry.execute('soomgo-pro-search', { query: { serviceSlug: 'logo', limit: 1 } });
    assert.equal(result.data.items[0].providerId, '42');
    assert.equal(result.data.items[0].location, '서울 마포구');
    assert.equal(result.data.pagination.complete, false);
    assert.equal(result.receipt.networkUsed, false);
    assert.equal(requests.length, 3);
    assert.equal(new URL(requests[2].url).searchParams.get('service_slug'), 'logo');
  } finally { await registry.close(); }
});

test('Upwork reads require a caller token, use only the official API, and keep token values out of result receipts', async () => {
  const token = 'fixture-oauth-token-must-not-escape';
  const fixtureSearch = JSON.parse(await fixture('upwork-search.json'));
  const requests = [];
  let credentialReads = 0;
  const registry = await createServiceRegistry('freelance-public', { now: () => at,
    credentialProvider: async service => {
      credentialReads++;
      assert.equal(service, 'freelance-public');
      return { upworkAccessToken: token };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      assert.equal(url, 'https://api.upwork.com/graphql');
      assert.equal(init.method, 'POST');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.get('authorization'), `Bearer ${token}`);
      return json(fixtureSearch);
    } });
  try {
    const result = await registry.execute('upwork-search', { query: { query: 'GraphQL migration', limit: 5 } });
    assert.equal(result.data.operation, 'search');
    assert.equal(result.data.access.liveVerification, 'pending_live');
    assert.equal(result.data.access.ownerVerified, false);
    assert.equal(result.data.jobs.length, 1);
    assert.equal(result.receipt.httpStatus, 200);
    assert.equal(result.receipt.networkUsed, false, 'an injected fetch mock is not external verification');
    assert.equal(credentialReads, 1);
    assert.equal(requests.length, 1);
    assert.equal(JSON.stringify(result).includes(token), false);
  } finally { await registry.close(); }
});

test('Upwork missing credentials fails before a request and abort signals reach public readers', async () => {
  let calls = 0;
  const registry = await createServiceRegistry('freelance-public', { fetchImpl: async () => {
    calls++; return json({ code: 0, reason: '', response: { cursor: '', results: [], totalCount: 0 } });
  } });
  try {
    await assert.rejects(registry.execute('upwork-search', { query: { query: 'design' } }),
      { code: 'UPWORK_APPROVED_API_CREDENTIALS_REQUIRED' });
    assert.equal(calls, 0);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(registry.execute('soomgo-categories', {}, { signal: controller.signal }),
      { code: 'OPERATION_ABORTED' });
    assert.equal(calls, 0);
  } finally { await registry.close(); }
});

