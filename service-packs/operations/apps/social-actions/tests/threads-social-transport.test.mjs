import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readThreadsFollowers, readThreadsProfilePosts } from '../threads-social.mjs';
import { recordThreadsGraphqlCooldown, readThreadsSharedCooldown, threadsThrottleRoot } from '../lib/threads-graphql-throttle.mjs';
import { reserveThreadsRead } from '../lib/threads-read-budget.mjs';
import { safeBotFailure } from '../lib/bot-diagnostics.mjs';
import { SOCIAL_REQUEST_TIMEOUTS } from '../lib/request-timeouts.mjs';

const OWNER = 'lifehack__ailab';
const OWNER_ID = '17824859444';
const OPERATION = 'BarcelonaFriendshipsFollowersTabQuery';
const payload = () => ({ data: { user: { id: OWNER_ID, followers: {
  edges: [], page_info: { has_next_page: false, end_cursor: null },
} } } });

function response(body, { status = 200, headers = {} } = {}) {
  const result = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
  Object.defineProperty(result, 'url', { value: 'https://www.threads.com/graphql/query' });
  return result;
}

function context(root, fetchImpl) {
  return {
    service: 'threads', handle: OWNER, url: `https://www.threads.com/@${OWNER}/`,
    createdAt: Date.now(), requestCount: 0, throttleRoot: root, readBudgetRoot: root,
    bundle: { service: 'threads', owner: OWNER, ownerId: OWNER_ID, origin: 'https://www.threads.com',
      cookies: [{ name: 'csrftoken', value: 'test-csrf', domain: '.threads.com', path: '/', secure: true }] },
    document: { modules: new Map([
      ['DTSGInitialData', { token: 'test-dtsg' }], ['LSD', { token: 'test-lsd' }],
      ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
      ['SiteData', { haste_session: 'h', pr: 1, client_revision: 2, hsi: 3, comet_env: 1,
        __spin_r: 4, __spin_b: 'trunk', __spin_t: 4 }],
      ['RelayAPIConfigDefaults', { actorID: OWNER_ID, graphURI: '/api/graphql', customHeaders: { 'x-ig-app-id': 'test-app' } }],
      ['CurrentUserInitialData', { USER_ID: '0' }],
    ]), route: { canonicalRouteName: 'comet.threads.BarcelonaProfileThreadsColumnRoute' } },
    sources: new Map([['DTSGUtils', { source: 'SprinkleConfig value.charCodeAt(i)' }]]), fetchImpl,
  };
}

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'threads-social-transport-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('followers with an existing context respect the shared cooldown without dispatch or budget consumption', async () => {
  await withRoot(async root => {
    const hold = await recordThreadsGraphqlCooldown({ response: response({}), operation: OPERATION, root });
    let calls = 0;
    const ctx = context(root, async () => { calls++; return response(payload()); });
    await assert.rejects(readThreadsFollowers({ context: ctx }), error => {
      assert.equal(error.code, 'META_GRAPHQL_THROTTLED');
      assert.equal(error.retryAt, hold.retryAt);
      assert.equal(error.dispatchStarted, false);
      assert.equal(error.writeSent, false);
      return true;
    });
    assert.equal(calls, 0);
    await assert.rejects(readFile(path.join(root, 'read-budget.json')), { code: 'ENOENT' });
  });
});

test('followers do not open an authenticated bootstrap during a shared cooldown', async () => {
  const root = threadsThrottleRoot();
  try {
    await recordThreadsGraphqlCooldown({ response: response({}), operation: OPERATION, root });
    let bootstraps = 0, calls = 0;
    await assert.rejects(readThreadsFollowers({ contextLoader: async () => {
      bootstraps++; return context(root, async () => { calls++; return response(payload()); });
    } }), { code: 'META_GRAPHQL_THROTTLED' });
    assert.equal(bootstraps, 0);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('followers cannot escape the shared read budget through their separate endpoint', async () => {
  await withRoot(async root => {
    const limits = { perMinute: 1, perHour: 1 };
    await reserveThreadsRead({ root, limits, operation: OPERATION });
    let calls = 0;
    const ctx = context(root, async () => { calls++; return response(payload()); });
    ctx.readBudgetLimits = limits;
    await assert.rejects(readThreadsFollowers({ context: ctx }), error => {
      assert.equal(error.code, 'THREADS_READ_BUDGET_WAIT');
      assert.equal(error.dispatchStarted, false);
      assert.equal(error.writeSent, false);
      return true;
    });
    assert.equal(calls, 0);
  });
});

test('concurrent follower reads serialize the refusal and gate the second dispatch', async () => {
  await withRoot(async root => {
    let calls = 0;
    const ctx = context(root, async () => {
      calls++; await new Promise(resolve => setTimeout(resolve, 40));
      return response({ errors: [{ code: 1675004, message: 'rate limit SECRET_SENTINEL' }] });
    });
    const results = await Promise.allSettled([
      readThreadsFollowers({ context: ctx }), readThreadsFollowers({ context: ctx }),
    ]);
    assert.equal(calls, 1);
    assert.ok(results.every(result => result.status === 'rejected'
      && result.reason.code === 'META_GRAPHQL_THROTTLED' && result.reason.httpStatus === 200));
    assert.equal(results.filter(result => result.reason.dispatchStarted === false).length, 1);
    const saved = await readFile(path.join(root, 'graphql-cooldown.json'), 'utf8');
    assert.equal(saved.includes('SECRET_SENTINEL'), false);
    assert.ok(await readThreadsSharedCooldown({ root }));
  });
});

test('a follower challenge takes precedence over numeric throttling and is not retried', async () => {
  await withRoot(async root => {
    let calls = 0;
    const ctx = context(root, async () => {
      calls++; return response({ errors: [{ code: 1675004, message: 'checkpoint challenge SECRET_SENTINEL' }] });
    });
    await assert.rejects(readThreadsFollowers({ context: ctx }), error => {
      assert.equal(error.code, 'META_INTERACTION_REQUIRED');
      assert.equal(error.httpStatus, 200);
      assert.equal(JSON.stringify(safeBotFailure(error)).includes('SECRET_SENTINEL'), false);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(await readThreadsSharedCooldown({ root }), null);
  });
});

test('HTTP 200 non-JSON remains blocked and records only the actual safe read phase', async () => {
  await withRoot(async root => {
    let calls = 0;
    const body = 'SECRET_SENTINEL invalid json';
    const ctx = context(root, async () => { calls++; return response(body, { headers: { 'content-type': 'text/javascript' } }); });
    await assert.rejects(readThreadsFollowers({ context: ctx }), error => {
      assert.equal(error.code, 'THREADS_SOCIAL_NOT_JSON');
      assert.equal(error.httpStatus, 200);
      assert.deepEqual({ ...error.requestDiagnostic, elapsedMs: 0 }, {
        method: 'POST', path: '/graphql/query', operation: OPERATION, stage: 'decode',
        timeoutMs: SOCIAL_REQUEST_TIMEOUTS.read, writeSent: false, httpStatus: 200, mime: 'text/javascript',
        bytes: Buffer.byteLength(body), elapsedMs: 0,
      });
      assert.equal(JSON.stringify(safeBotFailure(error)).includes('SECRET_SENTINEL'), false);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(await readThreadsSharedCooldown({ root }), null);
  });
});

test('follower HTTP 429 retains retry metadata and performs one request', async () => {
  await withRoot(async root => {
    let calls = 0;
    const ctx = context(root, async () => { calls++; return response('unread', { status: 429, headers: { 'retry-after': '120' } }); });
    await assert.rejects(readThreadsFollowers({ context: ctx }), error => {
      assert.equal(error.code, 'THREADS_SOCIAL_HTTP_429');
      assert.equal(error.httpStatus, 429);
      assert.equal(error.retryAfterSeconds, 120);
      assert.equal(error.cooldownCode, 'META_HTTP_429_COOLDOWN');
      assert.equal(error.deadlineSource, 'server_hint');
      assert.equal(error.requestDiagnostic.httpStatus, 429);
      return true;
    });
    const shared = await readThreadsSharedCooldown({ root });
    assert.equal(shared.code, 'META_HTTP_429_COOLDOWN'); assert.equal(shared.httpStatus, 429);
    await assert.rejects(readThreadsFollowers({ context: ctx }), error => {
      assert.equal(error.code, 'META_HTTP_429_COOLDOWN'); assert.equal(error.httpStatus, 429);
      assert.equal(error.requestDiagnostic.stage, 'cooldown_gate');
      assert.equal(error.requestDiagnostic.httpStatus, 429); assert.equal(error.dispatchStarted, false);
      assert.equal(error.writeSent, false); return true;
    });
    assert.equal(calls, 1);
    const budget = JSON.parse(await readFile(path.join(root, 'read-budget.json'), 'utf8'));
    assert.equal(budget.events.length, 1, 'the shared cooldown is checked before reserving another read');
  });
});

test('successful followers retain the existing receipt and consume one shared read slot', async () => {
  await withRoot(async root => {
    const result = await readThreadsFollowers({ context: context(root, async () => response(payload())) });
    assert.equal(result.receipt.operation, OPERATION);
    assert.equal(result.receipt.path, '/graphql/query');
    assert.equal(result.receipt.httpStatus, 200);
    assert.equal(result.receipt.ownerVerified, true);
    assert.match(result.receipt.responseSha256, /^[0-9a-f]{64}$/);
    const budget = JSON.parse(await readFile(path.join(root, 'read-budget.json'), 'utf8'));
    assert.equal(budget.events.length, 1);
  });
});

test('an existing profile context cannot open an authenticated document during a shared cooldown', async () => {
  await withRoot(async root => {
    await recordThreadsGraphqlCooldown({ response: response({}), operation: OPERATION, root });
    let calls = 0;
    const ctx = context(root, async () => { calls++; return response('unread'); });
    await assert.rejects(readThreadsProfilePosts({}, { context: ctx }), { code: 'META_GRAPHQL_THROTTLED' });
    assert.equal(calls, 0);
  });
});
