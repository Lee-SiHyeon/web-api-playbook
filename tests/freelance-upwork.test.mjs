import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createUpworkClient, UPWORK_PENDING_LIVE } from '../lib/freelance/upwork.mjs';

const TOKEN = 'oauth2v2_fixture-token-never-persist';
const JOB_ID = '2056488576136638272';
const fixedNow = () => Date.parse('2026-10-23T12:00:00.000Z');
const body = async name => JSON.parse(await readFile(new URL(`./fixtures/freelance/${name}`, import.meta.url), 'utf8'));
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

test('Upwork client requires caller supplied OAuth token before sending any request', async () => {
  let calls = 0;
  assert.throws(() => createUpworkClient({ fetchImpl: async () => { calls++; } }),
    { code: 'UPWORK_ACCESS_TOKEN_REQUIRED' });
  assert.equal(calls, 0);
  for (const token of ['', 'contains whitespace', `x${'x'.repeat(8192)}`]) {
    assert.throws(() => createUpworkClient({ accessToken: token, fetchImpl: async () => { calls++; } }),
      { code: 'UPWORK_ACCESS_TOKEN_REQUIRED' });
  }
  assert.equal(calls, 0);
  assert.equal(UPWORK_PENDING_LIVE.status, 'pending_live');
  assert.equal(UPWORK_PENDING_LIVE.credentialsPersisted, false);
});

test('search sends only the documented read GraphQL operation, OAuth header and bounded filters', async () => {
  const fixture = await body('upwork-search.json');
  let calls = 0;
  const client = createUpworkClient({ accessToken: TOKEN, tenantId: '470123456789', now: fixedNow,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.upwork.com/graphql');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.get('authorization'), `Bearer ${TOKEN}`);
      assert.equal(init.headers.get('X-Upwork-API-TenantId'), '470123456789');
      assert.equal(init.headers.get('cookie'), null);
      const request = JSON.parse(init.body);
      assert.equal(request.operationName, 'SearchJobs');
      assert.match(request.query, /marketplaceJobPostingsSearch/);
      assert.match(request.query, /searchType: USER_JOBS_SEARCH/);
      assert.match(request.query, /amount \{ displayValue currency \}/);
      assert.deepEqual(request.variables.filter, {
        searchExpression_eq: 'GraphQL migration',
        pagination_eq: { after: '0', first: 5 },
      });
      return json(fixture);
    } });

  const result = await client.searchJobs({ query: 'GraphQL migration', limit: 5 });
  assert.equal(calls, 1);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.operation, 'search');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].id, JOB_ID);
  assert.equal(result.jobs[0].url, null, 'the documented search contract provides no canonical job URL');
  assert.equal(result.jobs[0].source.ciphertext, '~fixtureJobCiphertext');
  assert.deepEqual(result.jobs[0].source.amount, { displayValue: '$250.00', currency: 'USD' });
  assert.deepEqual(result.jobs[0].source.skills, ['GraphQL', 'API Development']);
  assert.equal(result.jobs[0].source.clientFeedback, 7);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.nextCursor, 'fixture-cursor-2');
  assert.equal(result.access.liveVerification, 'pending_live');
  assert.equal(result.access.ownerVerified, false);
  assert.equal(result.requests[0].credentialsUsed, true);
  assert.equal(result.requests[0].ownerVerified, false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes('470123456789'), false);
});

test('search can follow only the documented cursor and records it in scope', async () => {
  let calls = 0;
  const client = createUpworkClient({ accessToken: TOKEN, fetchImpl: async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body);
    assert.deepEqual(request.variables.filter, {
      searchExpression_eq: 'GraphQL',
      pagination_eq: { after: 'fixture-cursor-2', first: 20 },
    });
    return json({ data: { marketplaceJobPostingsSearch: {
      totalCount: 3,
      edges: [{ node: { id: 'job-2', title: 'Second page', description: null,
        ciphertext: 'opaque-2', amount: null, skills: [], client: null } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } });
  } });
  const result = await client.searchJobs({ query: 'GraphQL', cursor: 'fixture-cursor-2' });
  assert.equal(calls, 1);
  assert.equal(result.scope.filters.after, 'fixture-cursor-2');
  assert.equal(result.coverage.cursor, 'fixture-cursor-2');
  assert.equal(result.coverage.complete, false, 'one tail page does not prove the first page was read');
  assert.equal(result.coverage.reason, 'cursor_page_only');
});

test('collectJobs walks bounded result cursors and requires the first page to claim completeness', async () => {
  let calls = 0;
  const client = createUpworkClient({ accessToken: TOKEN, fetchImpl: async (_url, init) => {
    calls++;
    const { variables } = JSON.parse(init.body);
    const after = variables.filter.pagination_eq.after;
    const itemId = after === '0' ? 'first' : 'second';
    return json({ data: { marketplaceJobPostingsSearch: {
      totalCount: 2,
      edges: [{ node: { id: itemId, title: `Job ${itemId}`, description: null,
        ciphertext: `opaque-${itemId}`, amount: null, skills: [], client: null } }],
      pageInfo: after === '0'
        ? { hasNextPage: true, endCursor: 'cursor-2' }
        : { hasNextPage: false, endCursor: null },
    } } });
  } });

  const result = await client.collectJobs({ query: 'node js', limit: 1 }, { maxPages: 3 });
  assert.equal(calls, 2);
  assert.equal(result.operation, 'collect');
  assert.deepEqual(result.jobs.map(job => job.id), ['first', 'second']);
  assert.equal(result.coverage.pages, 2);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.returned, 2);
});

test('collectJobs stops at the caller page budget and reports a partial result', async () => {
  let calls = 0;
  const client = createUpworkClient({ accessToken: TOKEN, fetchImpl: async () => {
    calls++;
    return json({ data: { marketplaceJobPostingsSearch: {
      totalCount: 100,
      edges: [{ node: { id: `job-${calls}`, title: `Job ${calls}`, description: null,
        ciphertext: null, amount: null, skills: [], client: null } }],
      pageInfo: { hasNextPage: true, endCursor: `cursor-${calls + 1}` },
    } } });
  } });
  const result = await client.collectJobs({ query: 'design', limit: 1 }, { maxPages: 1 });
  assert.equal(calls, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'page_budget_reached');
  assert.equal(result.coverage.nextCursor, 'cursor-2');
});

test('collectJobs rejects cursor cycles and duplicate job identities', async () => {
  let calls = 0;
  const client = createUpworkClient({ accessToken: TOKEN, fetchImpl: async () => {
    calls++;
    const node = { id: `job-${calls}`, title: `Job ${calls}`, description: null,
      ciphertext: null, amount: null, skills: [], client: null };
    return json({ data: { marketplaceJobPostingsSearch: {
      totalCount: 2, edges: [{ node }],
      pageInfo: { hasNextPage: true, endCursor: 'same-cursor' },
    } } });
  } });
  await assert.rejects(client.collectJobs({ query: 'one' }, { maxPages: 3 }), { code: 'UPWORK_CURSOR_CYCLE' });
  assert.equal(calls, 2);
});

test('detail uses the documented marketplaceJobPosting id and selected fields', async () => {
  const fixture = await body('upwork-detail.json');
  const client = createUpworkClient({ accessToken: TOKEN, now: fixedNow,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      assert.equal(request.operationName, 'JobDetails');
      assert.match(request.query, /marketplaceJobPosting\(id: \$id\)/);
      assert.match(request.query, /contractTerms \{ contractType \}/);
      assert.deepEqual(request.variables, { id: JOB_ID });
      return json(fixture);
    } });
  const result = await client.getJob({ id: JOB_ID });
  assert.equal(result.operation, 'detail');
  assert.equal(result.jobs[0].id, JOB_ID);
  assert.equal(result.jobs[0].title, 'Fixture API migration review');
  assert.equal(result.jobs[0].source.contractType, 'FIXED');
  assert.equal(result.access.liveVerification, 'pending_live');
});

test('detail rejects a response bound to a different ID', async () => {
  const client = createUpworkClient({ accessToken: TOKEN, fetchImpl: async () => json({ data: {
    marketplaceJobPosting: { id: 'other-id', content: { title: 'Wrong posting', description: null }, contractTerms: null },
  } }) });
  await assert.rejects(client.getJob({ id: JOB_ID }), { code: 'UPWORK_DETAIL_ID_MISMATCH' });
});

test('GraphQL application errors on HTTP 200 are failures and do not leak server text', async () => {
  const client = createUpworkClient({ accessToken: TOKEN, fetchImpl: async () => json({
    data: null,
    errors: [{ message: `Authorization token ${TOKEN} is not permitted`, path: ['marketplaceJobPostingsSearch'] }],
  }) });
  await assert.rejects(client.searchJobs({ query: 'design' }), error => {
    assert.equal(error.code, 'UPWORK_GRAPHQL_ERROR');
    assert.equal(error.receipt.errorCount, 1);
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
    assert.equal(JSON.stringify(error).includes('not permitted'), false);
    return true;
  });
});

test('HTTP permission, throttle, redirect and response type failures stay distinct', async () => {
  const cases = [
    [new Response('denied', { status: 403, headers: { 'content-type': 'text/plain' } }), 'UPWORK_AUTH_OR_PERMISSION_REJECTED'],
    [new Response('slow', { status: 429, headers: { 'content-type': 'text/plain' } }), 'UPWORK_THROTTLED'],
    [new Response(null, { status: 302, headers: { location: 'https://www.upwork.com/' } }), 'UPWORK_REDIRECT_REJECTED'],
    [new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } }), 'UPWORK_MIME_INVALID'],
    [new Response('{malformed', { headers: { 'content-type': 'application/json' } }), 'UPWORK_JSON_INVALID'],
  ];
  for (const [response, code] of cases) {
    const client = createUpworkClient({ accessToken: TOKEN, fetchImpl: async () => response });
    await assert.rejects(client.searchJobs({ query: 'design' }), error => {
      assert.equal(error.code, code);
      assert.equal(JSON.stringify(error).includes(TOKEN), false);
      return true;
    });
  }
});

test('GraphQL response shape and pagination metadata are validated before declaring coverage', async () => {
  const cases = [
    [{ data: {} }, 'UPWORK_GRAPHQL_SCHEMA_INVALID'],
    [{ data: { marketplaceJobPostingsSearch: { edges: [], totalCount: 0 } } }, 'UPWORK_GRAPHQL_SCHEMA_INVALID'],
    [{ data: { marketplaceJobPostingsSearch: { edges: [], totalCount: 0,
      pageInfo: { hasNextPage: true, endCursor: null } } } }, 'UPWORK_NEXT_CURSOR_MISSING'],
    [{ data: { marketplaceJobPostingsSearch: { edges: [{ node: { id: 'x' } }], totalCount: 1,
      pageInfo: { hasNextPage: false, endCursor: null } } } }, 'UPWORK_SCHEMA_INVALID'],
  ];
  for (const [payload, code] of cases) {
    await assert.rejects(createUpworkClient({ accessToken: TOKEN, fetchImpl: async () => json(payload) })
      .searchJobs({ query: 'design' }), { code });
  }
});

test('input limits reject invalid queries, cursors, IDs and page budgets before sending requests', async () => {
  let calls = 0;
  const client = createUpworkClient({ accessToken: TOKEN, fetchImpl: async () => { calls++; return json({}); } });
  for (const query of ['', ' '.repeat(2), 'x'.repeat(251), null]) {
    await assert.rejects(client.searchJobs({ query }), { code: 'UPWORK_SCHEMA_INVALID' });
  }
  await assert.rejects(client.searchJobs({ query: 'design', limit: 0 }), { code: 'UPWORK_LIMIT_INVALID' });
  await assert.rejects(client.searchJobs({ query: 'design', cursor: `x${'x'.repeat(8192)}` }), { code: 'UPWORK_CURSOR_INVALID' });
  await assert.rejects(client.getJob({ id: 'bad id' }), { code: 'UPWORK_SCHEMA_INVALID' });
  await assert.rejects(client.collectJobs({ query: 'design' }, { maxPages: 0 }), { code: 'UPWORK_MAX_PAGES_INVALID' });
  assert.equal(calls, 0);
});

test('network failures do not expose token, raw exception text or API secrets', async () => {
  const client = createUpworkClient({ accessToken: TOKEN,
    fetchImpl: async () => { throw new Error(`server diagnostic with ${TOKEN}`); } });
  await assert.rejects(client.searchJobs({ query: 'design' }), error => {
    assert.equal(error.code, 'UPWORK_TRANSPORT_FAILED');
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
    assert.equal(JSON.stringify(error).includes('server diagnostic'), false);
    return true;
  });
});
