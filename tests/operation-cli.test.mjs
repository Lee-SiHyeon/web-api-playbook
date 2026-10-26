import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { partialCollectionRunFailure, writePartialCollectionRunFailure } from '../scripts/playbook.mjs';

// Deliberately exercise the shipped entry point, not imported CLI/leaf functions.
// Each test owns an ephemeral loopback listener, profile, plans and checkpoints.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ROOT, 'scripts', 'playbook.mjs');
const TEMP_PREFIX = 'playbook-operation-cli-';
const TEST_OPTIONS = { timeout: 60000 };
const FIRST = { id: 'sku-1', title: 'One' };
const SECOND = { id: 'sku-2', title: 'Two' };
const THIRD = { id: 'sku-3', title: 'Three' };

test('common CLI keeps a validated read-only collection checkpoint on error and retains exit 1', async t => {
  const scope = { keyword: 'synthetic', pageSize: 40 };
  const state = {
    schemaVersion: 1, service: 'kmong', operation: 'search', scope,
    items: [], pages: [], requests: [],
    attempts: [{ page: 1, code: 'KMONG_HTTP_TIMEOUT', observedAt: '2026-10-26T08:00:00.000Z', requestIndexes: [] }],
    issues: [], nextPage: 1, totalItemCount: null, lastPage: null, complete: false, resumeAllowed: true,
  };
  const partialResult = {
    kind: 'kmong_read_only_collection', operation: 'kmong-search-collect',
    data: {
      schemaVersion: 1, service: 'kmong', operation: 'search', status: 'partial',
      observedAt: null, checkpointProvenance: 'collector_created', checkpointAuthenticated: false,
      networkUsed: true, scope, items: [], pages: [], newPages: [],
      pagination: { page: null, pageSize: 40, pagesWalked: 0, totalItemCount: null, lastPage: null,
        complete: false, sourceWindowComplete: false, completeCatalog: false, nextPage: 1,
        pageWalked: true, resumable: true },
      state, attempts: state.attempts, issues: [], requests: [], currentRequests: [],
      error: { code: 'KMONG_HTTP_TIMEOUT', requestIndexes: [] }, limitations: [],
      contractProvenance: { kind: 'first_party_bundle' },
    },
  };
  const error = Object.assign(new Error('private error text'), {
    code: 'KMONG_HTTP_TIMEOUT', receipt: { secret: 'do not serialize' }, partialResult,
  });
  const failure = partialCollectionRunFailure(error);
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.payload.ok, false);
  assert.equal(failure.payload.code, 'KMONG_HTTP_TIMEOUT');
  assert.equal(failure.payload.partialResult.data.state.nextPage, 1);
  assert.equal(JSON.stringify(failure).includes('do not serialize'), false);
  assert.equal(JSON.stringify(failure).includes('private error text'), false);

  const output = path.join(tmpdir(), `playbook-partial-${randomUUID()}.json`);
  const existingOutput = path.join(tmpdir(), `playbook-existing-${randomUUID()}.json`);
  t.after(async () => { await Promise.all([rm(output, { force: true }), rm(existingOutput, { force: true })]); });
  const stdoutChunks = [];
  const stdout = new Writable({ write(chunk, _encoding, done) { stdoutChunks.push(chunk.toString()); done(); } });
  assert.equal(await writePartialCollectionRunFailure(error, { output, stdout }), 1);
  const saved = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(saved.ok, false);
  assert.equal(saved.partialResult.data.state.nextPage, 1);
  const summary = JSON.parse(stdoutChunks.join(''));
  assert.equal(summary.ok, false);
  assert.equal(summary.status, 'partial');
  assert.equal(Object.hasOwn(summary, 'partialResult'), false);

  await writeFile(existingOutput, 'keep', { flag: 'wx' });
  await assert.rejects(writePartialCollectionRunFailure(error, { output: existingOutput, stdout }), { code: 'EEXIST' });
  assert.equal(await readFile(existingOutput, 'utf8'), 'keep');

  const ordinaryError = Object.assign(new Error('ordinary failure'), { code: 'KMONG_HTTP_TIMEOUT', receipt: partialResult });
  assert.equal(partialCollectionRunFailure(ordinaryError), null);
  assert.equal(await writePartialCollectionRunFailure(ordinaryError, { stdout }), null);
});

function makeProfile(origin) {
  const read = (route, extra = {}) => ({ origin, path: route, method: 'GET', semantics: 'read',
    evidence: 'task-created local HTTP fixture; no live service',
    expected: { status: 200, mime: 'application/json' }, response: { format: 'json' }, ...extra });
  return { schemaVersion: 2, serviceId: 'cli-fixture', allowedOrigins: [origin],
    cookieOrigins: [], allowLoopbackHttp: true,
    // Supplying --plan to check must override this deliberately unusable default.
    health: { checks: [{ operation: 'not_configured' }] },
    operations: {
      search: read('/search', {
        description: 'Search fixture records',
        inputs: { query: { q: { type: 'string', required: true, minLength: 1 },
          page: { type: 'integer', default: 1, minimum: 1 },
          enabled: { type: 'boolean', default: true },
          filters: { type: 'object' }, tags: { type: 'array', items: { type: 'string' } } } },
        response: { format: 'json', requiredPointers: ['/items', '/next'] },
        outputSchema: { type: 'object', required: ['items', 'next'], properties: { items: { type: 'array' } } },
      }),
      detail: read('/items/{id}', {
        inputs: { path: { id: { type: 'string', required: true } },
          query: { verbose: { type: 'boolean', default: false } } },
        response: { format: 'json', requiredPointers: ['/id', '/title'] },
      }),
      echo: read('/echo/{id}', { method: 'POST',
        inputs: { path: { id: { type: 'integer', required: true } },
          query: { preview: { type: 'boolean', default: true } }, body: {
            count: { type: 'integer', required: true }, active: { type: 'boolean', required: true },
            labels: { type: 'array', items: { type: 'string' }, required: true },
            metadata: { required: true, schema: { type: 'object', required: ['sku', 'rank'],
              properties: { sku: { type: 'string' }, rank: { type: 'integer' } }, additionalProperties: false } },
          } },
      }),
      html: read('/html', { expected: { status: 200, mime: 'text/html' }, response: {
        format: 'html', html: { items: '.item', fields: {
          id: { selector: ':scope', attribute: 'data-id', required: true },
          title: { selector: '.title', required: true },
          href: { selector: 'a', attribute: 'href', absoluteUrl: true, required: true },
        }, page: { next: { selector: 'a.next', attribute: 'href', absoluteUrl: true } } },
      } }),
      limited: read('/limited'), denied: read('/denied'),
      drift: read('/drift', { response: { format: 'json', requiredPointers: ['/items'] } }),
      write: read('/write', { method: 'POST', semantics: 'write' }),
    } };
}

async function fixture(t) {
  const tempParent = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(tempParent, TEMP_PREFIX));
  const owner = randomUUID();
  const marker = path.join(directory, '.test-owner');
  const requests = [], children = new Set(), faults = new Map();
  await writeFile(marker, owner, { flag: 'wx' });
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url, 'http://127.0.0.1');
      const entry = { method: request.method, pathname: url.pathname,
        query: Object.fromEntries(url.searchParams), rawBody, headers: { ...request.headers } };
      requests.push(entry);
      const send = (status, value, mime = 'application/json') => {
        entry.responseRaw = mime === 'application/json' ? JSON.stringify(value) : value;
        response.writeHead(status, { 'content-type': `${mime}; charset=utf-8` });
        response.end(entry.responseRaw);
      };
      const faultKey = url.pathname === '/search' ? `/search:${url.searchParams.get('page')}` : url.pathname;
      if (faults.has(faultKey)) { send(faults.get(faultKey), { error: 'fixture failure' }); return; }
      if (url.pathname === '/search' && request.method === 'GET') {
        const page = Number(url.searchParams.get('page'));
        send(200, { items: page === 1 ? [FIRST, SECOND]
          : page === 2 ? [{ id: SECOND.id, title: 'Later duplicate must lose' }, THIRD] : [],
        next: page === 1 ? 2 : null, query: entry.query });
      } else if (url.pathname.startsWith('/items/') && request.method === 'GET') {
        const id = decodeURIComponent(url.pathname.slice('/items/'.length));
        send(200, { id, title: `Detail ${id}`, verbose: url.searchParams.get('verbose') });
      } else if (url.pathname.startsWith('/echo/') && request.method === 'POST') {
        send(200, { id: url.pathname.slice('/echo/'.length), query: entry.query, body: JSON.parse(rawBody) });
      } else if (url.pathname === '/html') {
        send(200, '<!doctype html><article class="item" data-id="sku-1"><b class="title"> One  item </b>'
          + '<a href="/items/sku-1">details</a></article><a class="next" href="?page=2">Next</a>', 'text/html');
      } else if (url.pathname === '/limited') send(429, { error: 'fixture rate limit' });
      else if (url.pathname === '/denied') send(403, { error: 'fixture access denied' });
      else if (url.pathname === '/drift') send(200, { changed: true });
      else send(404, { error: 'unexpected fixture request' });
    })().catch(error => { response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ fixtureError: error.message })); });
  });

  t.after(async () => {
    for (const process of children) process.child.kill();
    await Promise.all([...children].map(process => process.closed));
    if (server.listening) {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    }
    // Never recursively delete a computed Windows path without proving it is
    // this test's real, direct child of the OS temp directory and owns its marker.
    assert.equal((await lstat(directory)).isSymbolicLink(), false);
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), tempParent);
    assert.ok(path.basename(resolved).startsWith(TEMP_PREFIX));
    assert.equal(await readFile(path.join(resolved, '.test-owner'), 'utf8'), owner);
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const json = async (name, value) => {
    assert.equal(path.basename(name), name);
    const file = path.join(directory, name);
    await writeFile(file, `${JSON.stringify(value)}\n`);
    return file;
  };
  const profile = makeProfile(origin);
  const profileFile = await json('profile v2.json', profile);
  return { directory, origin, requests, children, faults, json, profile, profileFile };
}

function startCli(f, command, options = {}) {
  const args = [CLI, command, `--profile=${f.profileFile}`,
    ...Object.entries(options).map(([key, value]) => `--${key}=${value}`)];
  const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true,
    env: { ...process.env, NODE_USE_ENV_PROXY: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', spawnError, timedOut = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', error => { spawnError = error; });
  // EPIPE is diagnosed through the process result, never an uncaught event.
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
  const running = { child, closed: null };
  running.closed = new Promise(resolve => child.once('close', (code, signal) => {
    clearTimeout(timer); f.children.delete(running);
    resolve({ code, signal, stdout, stderr, spawnError, timedOut });
  }));
  f.children.add(running);
  return running;
}

async function runCli(f, command, options = {}) {
  const process = startCli(f, command, options);
  process.child.stdin.end();
  return process.closed;
}

function exited(result, code) {
  assert.equal(result.spawnError, undefined, `spawn failed: ${result.spawnError}`);
  assert.equal(result.timedOut, false, `CLI timed out: ${result.stderr}`);
  assert.equal(result.signal, null, `CLI killed by ${result.signal}: ${result.stderr}`);
  assert.equal(result.code, code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function output(result, code = 0) {
  exited(result, code);
  assert.equal(result.stderr, '', `unexpected stderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function failure(result, code) {
  exited(result, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, code });
}

function receipt(value, operation, request) {
  assert.deepEqual(value, { serviceId: 'cli-fixture', operation, semantics: 'read', executionMode: 'pure_http',
    httpStatus: 200, responseSha256: createHash('sha256').update(request.responseRaw).digest('hex') });
}

function collectionPlan(extra = {}) {
  return { operation: 'search', input: { query: { q: 'collect & preserve' } },
    pagination: { kind: 'page', inputPath: '/query/page', itemsPointer: '/items', nextPointer: '/next', idPointer: '/id' },
    budget: { maxPages: 10, maxItems: 10, deadlineMs: 10000 }, ...extra };
}

const reference = (step, pointer) => ({ $result: { step, pointer } });
const lookupSteps = () => [
  { id: 'lookup', operation: 'search', input: { query: { q: 'workflow' } } },
  { id: 'selected', operation: 'detail', input: { path: { id: reference('lookup', '/items/0/id') }, query: { verbose: true } } },
];

test('playbook describe and tools expose the same typed v2 definitions without HTTP', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'description output.json');
  const result = await runCli(f, 'describe', { output: file });
  const described = output(result);
  assert.equal(await readFile(file, 'utf8'), result.stdout);
  assert.equal(described.serviceId, f.profile.serviceId);
  assert.deepEqual(described.operations.map(op => op.id), Object.keys(f.profile.operations));
  const search = described.operations.find(op => op.id === 'search');
  assert.equal(search.semantics, 'read');
  assert.equal(search.description, 'Search fixture records');
  assert.equal(search.evidence, f.profile.operations.search.evidence);
  assert.deepEqual(search.outputSchema, f.profile.operations.search.outputSchema);
  assert.deepEqual(search.inputSchema.required, ['query']);
  assert.deepEqual(search.inputSchema.properties.query.required, ['q']);
  assert.deepEqual(search.inputSchema.properties.query.properties.page, { type: 'integer', default: 1, minimum: 1 });
  assert.equal(search.inputSchema.additionalProperties, false);
  assert.equal(search.inputSchema.properties.query.additionalProperties, false);
  assert.deepEqual(output(await runCli(f, 'describe', { operation: 'search' })), search);
  const { tools } = output(await runCli(f, 'tools'));
  assert.deepEqual(tools, described.operations.map(op => ({ name: `cli-fixture__${op.id}`, description: op.description,
    inputSchema: op.inputSchema, annotations: { readOnlyHint: op.semantics === 'read' },
    ...(op.outputSchema ? { outputSchema: { type: 'object', properties: {
      data: op.outputSchema, pageInfo: { type: 'object' }, receipt: { type: 'object' },
    }, required: ['data', 'pageInfo', 'receipt'] } } : {}) })));
  assert.deepEqual(f.requests, []);
});

test('playbook run preserves typed query inputs, Unicode, JSON query values and defaults', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const input = await f.json('typed query.json', { query: { q: '노트북 & case? #1', page: 2, enabled: false,
    filters: { price: 0, inStock: true }, tags: ['a&b', '한글'] } });
  const result = output(await runCli(f, 'run', { operation: 'search', input }));
  assert.deepEqual(Object.keys(result).sort(), ['data', 'pageInfo', 'receipt']);
  assert.deepEqual(result.data.items, [{ id: SECOND.id, title: 'Later duplicate must lose' }, THIRD]);
  assert.equal(result.data.next, null);
  assert.deepEqual(result.data.query, { q: '노트북 & case? #1', page: '2', enabled: 'false',
    filters: '{"price":0,"inStock":true}', tags: '["a&b","한글"]' });
  assert.deepEqual(result.pageInfo, {});
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, 'GET');
  assert.equal(f.requests[0].rawBody, '');
  receipt(result.receipt, 'search', f.requests[0]);
  const defaults = await f.json('default query.json', { query: { q: 'defaults' } });
  output(await runCli(f, 'run', { operation: 'search', input: defaults }));
  assert.deepEqual(f.requests[1].query, { q: 'defaults', page: '1', enabled: 'true' });
});

test('playbook run encodes typed path and nested JSON body through a real HTTP POST read', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const supplied = { path: { id: 17 }, query: { preview: false },
    body: { count: 0, active: false, labels: ['a & b', '한글'], metadata: { sku: 'sku-1', rank: 2 } } };
  const input = await f.json('typed body.json', supplied);
  const result = output(await runCli(f, 'run', { operation: 'echo', input }));
  assert.deepEqual(result.data, { id: '17', query: { preview: 'false' }, body: supplied.body });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].pathname, '/echo/17');
  assert.equal(f.requests[0].method, 'POST');
  assert.match(f.requests[0].headers['content-type'], /^application\/json/);
  assert.deepEqual(JSON.parse(f.requests[0].rawBody), supplied.body);
  receipt(result.receipt, 'echo', f.requests[0]);
});

test('playbook run rejects untyped, missing, undeclared and unsafe inputs before dispatch', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const cases = [
    ['search', {}, 'OPERATION_INPUT_REQUIRED'],
    ['search', { query: { q: 'x', page: '2' } }, 'OPERATION_INPUT_INVALID'],
    ['search', { query: { q: 'x', enabled: 'false' } }, 'OPERATION_INPUT_INVALID'],
    ['search', { query: { q: 'x', undeclared: 1 } }, 'OPERATION_INPUT_INVALID'],
    ['detail', { path: { id: '..' } }, 'PATH_PARAMETER_INVALID'],
    ['echo', { path: { id: 17 }, body: { count: 1, active: false, labels: [], metadata: { sku: 'x', rank: '2' } } }, 'OPERATION_INPUT_INVALID'],
    ['not_configured', {}, 'OPERATION_UNKNOWN'],
    ['write', {}, 'WRITE_ADAPTER_REQUIRED'],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [operation, value, code] = cases[i];
    const input = await f.json(`invalid-${i}.json`, value);
    failure(await runCli(f, 'run', { operation, input }), code);
  }
  assert.deepEqual(f.requests, [], 'invalid input and unbound writes must never hit HTTP');
});

test('playbook run integrates HTML extraction and resolves links against the actual request URL', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const result = output(await runCli(f, 'run', { operation: 'html' }));
  assert.deepEqual(result.data, [{ id: 'sku-1', title: 'One item', href: `${f.origin}/items/sku-1` }]);
  assert.deepEqual(result.pageInfo, { next: `${f.origin}/html?page=2` });
  assert.equal(f.requests.length, 1);
  receipt(result.receipt, 'html', f.requests[0]);
});

test('playbook check accepts supplied checks and binds earlier unwrapped data', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const plan = await f.json('health checks.json', [
    { operation: 'search', input: { query: { q: 'health' } } },
    { operation: 'detail', input: { path: { id: { $result: { operation: 'search', pointer: '/items/0/id' } } } } },
  ]);
  const result = output(await runCli(f, 'check', { plan }));
  assert.deepEqual(result, { serviceId: 'cli-fixture', verdict: 'ok',
    checks: [{ operation: 'search', outcome: 'ok' }, { operation: 'detail', outcome: 'ok' }], next: [] });
  assert.deepEqual(f.requests.map(request => request.pathname), ['/search', '/items/sku-1']);
  assert.deepEqual(f.requests[1].query, { verbose: 'false' });
});

test('playbook check reports contract drift, 429, 403 and skipped writes without retries', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const plan = await f.json('failing health checks.json', [
    { operation: 'drift' }, { operation: 'limited' }, { operation: 'denied' }, { operation: 'write' },
    { operation: 'search', input: { query: { q: 'bad', page: '2' } } },
  ]);
  const result = output(await runCli(f, 'check', { plan }), 1);
  assert.deepEqual(result, { serviceId: 'cli-fixture', verdict: 'partial', checks: [
    { operation: 'drift', outcome: 'site_changed', code: 'EXTRACT_REQUIRED_MISSING' },
    { operation: 'limited', outcome: 'rate_limited', code: 'RATE_LIMITED' },
    { operation: 'denied', outcome: 'unreachable', code: 'ACCESS_DENIED' },
    { operation: 'write', outcome: 'skipped', code: 'WRITE_OPERATION_SKIPPED' },
    { operation: 'search', outcome: 'skipped', code: 'OPERATION_INPUT_INVALID' },
  ], next: ['review_operation_contract', 'retry_later', 'check_availability', 'review_checks'] });
  assert.deepEqual(f.requests.map(request => request.pathname), ['/drift', '/limited', '/denied']);
});

test('playbook collect persists a mid-page checkpoint and resumes without refetching or losing dedupe', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const checkpoint = path.join(f.directory, 'collection checkpoint.json');
  const plan = await f.json('collection plan.json', collectionPlan({ budget: { maxPages: 10, maxItems: 1, deadlineMs: 10000 } }));
  const first = output(await runCli(f, 'collect', { plan, checkpoint }), 1);
  assert.equal(first.ok, false); assert.equal(first.complete, false); assert.equal(first.partial, true);
  assert.equal(first.terminal, false); assert.equal(first.reason, 'max_items');
  assert.deepEqual(first.records, [FIRST]);
  assert.deepEqual(first.counters, { requests: 1, pages: 1, items: 1, duplicates: 0 });
  assert.deepEqual(first.checkpoint.pending, [SECOND]);
  assert.deepEqual(first.checkpoint.nextInput, { query: { q: 'collect & preserve', page: 2 } });
  assert.deepEqual(JSON.parse(await readFile(checkpoint, 'utf8')), first.checkpoint);
  receipt(first.receipts[0], 'search', f.requests[0]);

  // Budgets are per invocation, not part of the traversal identity.
  await f.json('collection plan.json', collectionPlan({ budget: { maxPages: 1, maxItems: 10, deadlineMs: 10000 } }));
  const resumed = output(await runCli(f, 'collect', { plan, checkpoint }));
  assert.equal(resumed.ok, true); assert.equal(resumed.complete, true); assert.equal(resumed.partial, false);
  assert.equal(resumed.terminal, true); assert.equal(resumed.reason, 'missing_continuation');
  assert.deepEqual(resumed.records, [FIRST, SECOND, THIRD]);
  assert.deepEqual(resumed.counters, { requests: 2, pages: 2, items: 3, duplicates: 1 });
  assert.equal(resumed.receipts.length, 2);
  receipt(resumed.receipts[1], 'search', f.requests[1]);
  assert.deepEqual(f.requests.map(request => request.query), [
    { q: 'collect & preserve', page: '1', enabled: 'true' },
    { q: 'collect & preserve', page: '2', enabled: 'true' },
  ]);
  assert.deepEqual(JSON.parse(await readFile(checkpoint, 'utf8')), resumed.checkpoint);
  assert.deepEqual(output(await runCli(f, 'collect', { plan, checkpoint })), resumed);
  assert.equal(f.requests.length, 2, 'a terminal checkpoint must not dispatch again');
  assert.deepEqual((await readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
});

test('playbook collect checkpoints rate limits and resumes only the failed page', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  f.faults.set('/search:2', 429);
  const plan = await f.json('limited collection.json', collectionPlan());
  const checkpoint = path.join(f.directory, 'limited checkpoint.json');
  const first = output(await runCli(f, 'collect', { plan, checkpoint }), 1);
  assert.equal(first.reason, 'rate_limited');
  assert.equal(first.partial, true); assert.equal(first.terminal, false);
  assert.deepEqual(first.error, { code: 'RATE_LIMITED', status: 429 });
  assert.deepEqual(first.records, [FIRST, SECOND]);
  assert.deepEqual(first.counters, { requests: 2, pages: 1, items: 2, duplicates: 0 });
  assert.deepEqual(JSON.parse(await readFile(checkpoint, 'utf8')), first.checkpoint);
  f.faults.delete('/search:2');
  const resumed = output(await runCli(f, 'collect', { plan, checkpoint }));
  assert.equal(resumed.complete, true);
  assert.deepEqual(resumed.records, [FIRST, SECOND, THIRD]);
  assert.deepEqual(resumed.counters, { requests: 3, pages: 2, items: 3, duplicates: 1 });
  assert.deepEqual(f.requests.map(request => request.query.page), ['1', '2', '2']);
});

test('playbook collect rejects mismatched and malformed checkpoints without HTTP', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const plan = await f.json('checkpoint plan.json', collectionPlan({ budget: { maxPages: 0 } }));
  const checkpoint = path.join(f.directory, 'invalid checkpoint.json');
  output(await runCli(f, 'collect', { plan, checkpoint }), 1);
  const before = await readFile(checkpoint, 'utf8');
  await f.json('checkpoint plan.json', collectionPlan({ input: { query: { q: 'different traversal' } } }));
  failure(await runCli(f, 'collect', { plan, checkpoint }), 'CHECKPOINT_MISMATCH');
  assert.equal(await readFile(checkpoint, 'utf8'), before, 'rejected resume must not rewrite the saved state');
  await writeFile(checkpoint, '{bad json');
  failure(await runCli(f, 'collect', { plan, checkpoint }), 'CHECKPOINT_INVALID');
  assert.deepEqual(f.requests, []);
});

test('playbook flow binds result data into typed inputs and saves metadata separately', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const plan = await f.json('workflow plan.json', { steps: [...lookupSteps(),
    { id: 'inspect', operation: 'echo', input: { path: { id: 17 }, query: { preview: false }, body: {
      count: reference('lookup', '/next'), active: false, labels: ['literal', '$result'],
      metadata: { sku: reference('selected', '/id'), rank: 2 },
    } } },
  ] });
  const checkpoint = path.join(f.directory, 'workflow checkpoint.json');
  const result = output(await runCli(f, 'flow', { plan, checkpoint }));
  assert.equal(result.ok, true); assert.equal(result.complete, true); assert.equal(result.partial, false);
  assert.equal(result.reason, 'completed'); assert.equal(result.terminal, true);
  assert.deepEqual(result.counters, { requests: 3, completed: 3, skipped: 0 });
  assert.deepEqual(result.results.selected, { id: 'sku-1', title: 'Detail sku-1', verbose: 'true' });
  assert.deepEqual(result.results.inspect.body, { count: 2, active: false, labels: ['literal', '$result'],
    metadata: { sku: 'sku-1', rank: 2 } });
  assert.equal(Object.hasOwn(result.results.lookup, 'receipt'), false, 'bindings address data, not envelopes');
  assert.deepEqual(result.steps, [
    { id: 'lookup', operation: 'search', status: 'completed' },
    { id: 'selected', operation: 'detail', status: 'completed' },
    { id: 'inspect', operation: 'echo', status: 'completed' },
  ]);
  for (const [index, id, operation] of [[0, 'lookup', 'search'], [1, 'selected', 'detail'], [2, 'inspect', 'echo']]) {
    assert.deepEqual(result.metadata[id].pageInfo, {});
    receipt(result.metadata[id].receipt, operation, f.requests[index]);
  }
  assert.deepEqual(JSON.parse(await readFile(checkpoint, 'utf8')), result.checkpoint);
  assert.deepEqual(output(await runCli(f, 'flow', { plan, checkpoint })), result);
  assert.equal(f.requests.length, 3, 'completed workflow steps must not replay');
});

test('playbook flow resumes after an HTTP failure without repeating completed steps', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  f.faults.set('/items/sku-1', 403);
  const plan = await f.json('resume workflow.json', { steps: lookupSteps() });
  const checkpoint = path.join(f.directory, 'resume workflow checkpoint.json');
  const first = output(await runCli(f, 'flow', { plan, checkpoint }), 1);
  assert.equal(first.reason, 'access_denied'); assert.equal(first.partial, true); assert.equal(first.terminal, false);
  assert.deepEqual(first.error, { code: 'ACCESS_DENIED', status: 403 });
  assert.deepEqual(first.counters, { requests: 2, completed: 1, skipped: 0 });
  assert.equal(first.checkpoint.nextStep, 1);
  assert.deepEqual(Object.keys(first.results), ['lookup']);
  assert.deepEqual(JSON.parse(await readFile(checkpoint, 'utf8')), first.checkpoint);
  f.faults.delete('/items/sku-1');
  const resumed = output(await runCli(f, 'flow', { plan, checkpoint }));
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.counters, { requests: 3, completed: 2, skipped: 0 });
  assert.deepEqual(resumed.results.lookup, first.results.lookup);
  assert.deepEqual(f.requests.map(request => request.pathname), ['/search', '/items/sku-1', '/items/sku-1']);
});

test('playbook stdio MCP initializes, lists and calls generated tools in a real process', TEST_OPTIONS, async t => {
  const f = await fixture(t);
  const expectedTools = output(await runCli(f, 'tools')).tools;
  const process = startCli(f, 'mcp');
  const pending = new Map(), unsolicited = [];
  const lines = createInterface({ input: process.child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch {
      for (const waiter of pending.values()) waiter.reject(new Error(`Non-JSON MCP stdout: ${line}`));
      pending.clear(); unsolicited.push(line); return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) unsolicited.push(message);
    else { pending.delete(message.id); waiter.resolve(message); }
  });
  process.closed.then(result => {
    lines.close();
    for (const waiter of pending.values()) waiter.reject(new Error(`MCP closed before replying: ${JSON.stringify(result)}`));
    pending.clear();
  });
  const send = value => process.child.stdin.write(`${JSON.stringify(value)}\n`);
  const request = (id, method, params) => new Promise((resolve, reject) => {
    assert.equal(pending.has(id), false);
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  });
  assert.deepEqual(await request(1, 'tools/list'), { jsonrpc: '2.0', id: 1,
    error: { code: -32000, message: 'Initialize first' } });
  const initialized = await request(2, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'operation-cli-test', version: '1.0.0' } });
  assert.deepEqual(initialized, { jsonrpc: '2.0', id: 2, result: { protocolVersion: '2025-06-18',
    capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'web-api-playbook', version: '1.0.0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual(await request(3, 'tools/list'), { jsonrpc: '2.0', id: 3, result: { tools: expectedTools } });
  const called = await request('read-1', 'tools/call', { name: 'cli-fixture__detail', arguments: { path: { id: 'sku-2' } } });
  assert.equal(called.jsonrpc, '2.0'); assert.equal(called.id, 'read-1');
  assert.equal(called.result.isError, false);
  assert.deepEqual(called.result.structuredContent.data, { id: 'sku-2', title: 'Detail sku-2', verbose: 'false' });
  assert.deepEqual(called.result.content, [{ type: 'text', text: JSON.stringify(called.result.structuredContent) }]);
  receipt(called.result.structuredContent.receipt, 'detail', f.requests[0]);
  const badInput = await request(5, 'tools/call', { name: 'cli-fixture__detail', arguments: { path: { id: 123 } } });
  assert.deepEqual(badInput, { jsonrpc: '2.0', id: 5, result: { isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'OPERATION_INPUT_INVALID' }) }] } });
  assert.deepEqual(await request(6, 'tools/call', { name: 'not_a_tool', arguments: {} }),
    { jsonrpc: '2.0', id: 6, error: { code: -32602, message: 'Unknown tool' } });
  assert.deepEqual(await request(7, 'ping'), { jsonrpc: '2.0', id: 7, result: {} });
  process.child.stdin.end();
  const result = await process.closed;
  exited(result, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(unsolicited, [], 'stdout must contain only correlated JSON-RPC replies, not notification responses or banners');
  assert.equal(f.requests.length, 1, 'tool validation failures must not dispatch HTTP');
});
