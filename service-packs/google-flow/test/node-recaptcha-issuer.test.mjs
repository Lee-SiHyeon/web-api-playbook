import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createNodeRecaptchaProvider } from '../src/node-recaptcha-issuer.mjs';

const NOW = 1_800_000_000_000;
const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000';
const SITE_KEY = 'flow-current-public-site-key';
const ISSUED_TOKEN = 'one-time-issued-token-secret';
const COOKIE_SECRET = 'active-google-cookie-secret';

function cookie(name, value, overrides = {}) {
  return {
    name,
    value,
    domain: '.google.com',
    hostOnly: false,
    path: '/',
    secure: true,
    httpOnly: true,
    expires: NOW / 1000 + 3_600,
    ...overrides,
  };
}

function makeTransport({ projectId = PROJECT_ID, siteKey = SITE_KEY, cookies = null } = {}) {
  return {
    started: false,
    bundle: {
      projectId,
      cookies: cookies ?? [
        cookie('SID', COOKIE_SECRET),
        cookie('__Secure-1PSID', 'active-google-cookie-2', { domain: 'google.com' }),
        cookie('FLOW', 'flow-only-cookie', { domain: 'flow.google.com', hostOnly: true }),
        cookie('HOST_ONLY', 'google-host-only-cookie', { hostOnly: true }),
        cookie('LOOKALIKE', 'wrong-domain-cookie', { domain: '.notgoogle.com' }),
        cookie('EXPIRED', 'expired-google-cookie', { expires: NOW / 1000 - 1 }),
        cookie('BAD_VALUE', 'bad;cookie=value'),
      ],
    },
    document: { siteKey },
    async start() { this.started = true; },
  };
}

function binding(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    promptHash: 'a'.repeat(64),
    aspect: '16:9',
    duration: 8,
    resolution: '720p',
    modelKey: 'abra_t2v_8s',
    clientIds: ['client-1', 'client-2'],
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    ...overrides,
  };
}

function verifiedReceipt(overrides = {}) {
  return {
    mode: 'node_jsdom_unmodified_sdk',
    nodeVersion: 'v24.10.0',
    jsdomVersion: '26.1.0',
    siteKeyFromCurrentFlowDocument: true,
    cookieValuesRecorded: false,
    tokenValuesRecorded: false,
    browserEngineUsed: false,
    browserSignalsOverridden: false,
    sdkSourceModified: false,
    anchor: { configuredKeyMatches: true, hiddenTokenPresent: true },
    execute: { callCount: 1, returnedNonemptyToken: true, matchesReloadReply: true },
    reload: { postCount: 1, status: 200, responseSchemaValid: true },
    ...overrides,
  };
}

function makeWorkerFactory({ packet, onConstruct, onTerminate } = {}) {
  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.terminated = false;
      workers.push(this);
      onConstruct?.(this);
      if (packet) queueMicrotask(() => packet(this));
    }

    terminate() {
      this.terminated = true;
      onTerminate?.(this);
      return Promise.resolve(1);
    }
  }
  return { WorkerImpl: FakeWorker, workers };
}

function issue(worker, receipt = verifiedReceipt(), { token = ISSUED_TOKEN, issuedAt = NOW } = {}) {
  worker.emit('message', { kind: 'receipt', receipt });
  worker.emit('message', { kind: 'issued', token, issuedAt, receipt });
}

test('acquires lazily from the started transport and returns a fresh one-time input only after verified SDK/reload agreement', async () => {
  const transport = makeTransport();
  const calls = [];
  const fake = makeWorkerFactory({
    onConstruct(worker) {
      calls.push('worker');
      assert.equal(transport.started, true, 'the caller completed the transport bootstrap before issuance');
      assert.equal(String(worker.url), new URL('../src/recaptcha-node-issuer-worker.mjs', import.meta.url).href);
    },
    packet(worker) { issue(worker); },
  });
  const provider = createNodeRecaptchaProvider({ transport, WorkerImpl: fake.WorkerImpl, clock: () => NOW });

  assert.equal(fake.workers.length, 0, 'constructing the provider performs no issuer work');
  assert.equal(provider.mode, 'pure_http');
  await transport.start();
  const expectedBinding = binding();
  const result = await provider.acquire({
    mode: 'pure_http', issuerOrigin: 'https://www.google.com', action: 'VIDEO_GENERATION', binding: expectedBinding,
  });

  assert.deepEqual(calls, ['worker']);
  assert.equal(fake.workers.length, 1);
  const { workerData } = fake.workers[0].options;
  assert.deepEqual(Object.keys(workerData).sort(), ['cookies', 'projectId', 'siteKey']);
  assert.equal(workerData.projectId, PROJECT_ID);
  assert.equal(workerData.siteKey, SITE_KEY, 'only the key parsed from the active Flow document is passed');
  assert.deepEqual(workerData.cookies.map(value => value.name), ['SID', '__Secure-1PSID']);
  assert.equal(workerData.cookies[0].value, COOKIE_SECRET);
  assert.equal(JSON.stringify(workerData).includes('flow-only-cookie'), false);
  assert.equal(JSON.stringify(workerData).includes('google-host-only-cookie'), false);
  assert.equal(JSON.stringify(workerData).includes('wrong-domain-cookie'), false);
  assert.equal(JSON.stringify(workerData).includes('expired-google-cookie'), false);
  assert.equal(JSON.stringify(workerData).includes('bad;cookie=value'), false);

  assert.deepEqual(result, {
    mode: 'pure_http',
    issuerOrigin: 'https://www.google.com',
    action: 'VIDEO_GENERATION',
    binding: expectedBinding,
    token: ISSUED_TOKEN,
    issuedAt: NOW,
    expiresAt: NOW + 120_000,
    oneTime: true,
  });
  assert.equal(result.expiresAt - result.issuedAt, 120_000);
  assert.equal(fake.workers[0].terminated, true);
  assert.equal(JSON.stringify(provider.getLastReceipt()).includes(ISSUED_TOKEN), false);
  assert.equal(JSON.stringify(provider.getLastReceipt()).includes(COOKIE_SECRET), false);

  await assert.rejects(provider.acquire({
    mode: 'pure_http', issuerOrigin: 'https://www.google.com', action: 'VIDEO_GENERATION', binding: expectedBinding,
  }), error => error.code === 'FLOW_NODE_ISSUER_ALREADY_USED');
  assert.equal(fake.workers.length, 1, 'one provider instance cannot issue a second token');
});

test('rejects a token unless its worker receipt proves one HTTP 200 reload, valid response schema, and SDK equality', async t => {
  const cases = [
    ['no reload POST', { reload: { postCount: 0, status: 200, responseSchemaValid: true } }],
    ['non-200 reload', { reload: { postCount: 1, status: 403, responseSchemaValid: true } }],
    ['invalid reload schema', { reload: { postCount: 1, status: 200, responseSchemaValid: false } }],
    ['SDK token differs from reload reply', { execute: { callCount: 1, returnedNonemptyToken: true, matchesReloadReply: false } }],
    ['anchor key does not match the active document', { anchor: { configuredKeyMatches: false, hiddenTokenPresent: true } }],
  ];

  for (const [name, override] of cases) {
    await t.test(name, async () => {
      const fake = makeWorkerFactory({ packet(worker) { issue(worker, verifiedReceipt(override)); } });
      const provider = createNodeRecaptchaProvider({ transport: makeTransport(), WorkerImpl: fake.WorkerImpl, clock: () => NOW });
      await assert.rejects(provider.acquire({
        mode: 'pure_http', issuerOrigin: 'https://www.google.com', action: 'VIDEO_GENERATION', binding: binding(),
      }), error => {
        assert.equal(error.code, 'FLOW_NODE_ISSUER_RECEIPT_UNVERIFIED');
        assert.doesNotMatch(error.message, new RegExp(ISSUED_TOKEN));
        return true;
      });
      assert.equal(fake.workers.length, 1);
      assert.equal(fake.workers[0].terminated, true);
      assert.equal(JSON.stringify(provider.getLastReceipt()).includes(ISSUED_TOKEN), false);
    });
  }
});

test('rejects mismatched issuer binding, missing current site key, and absent active Google cookies before starting a worker', async t => {
  const cases = [
    ['binding targets another project', {
      transport: makeTransport(),
      request: { mode: 'pure_http', issuerOrigin: 'https://www.google.com', action: 'VIDEO_GENERATION', binding: binding({ projectId: '223e4567-e89b-42d3-a456-426614174000' }) },
      code: 'FLOW_NODE_ISSUER_BINDING_INVALID',
    }],
    ['wrong action', {
      transport: makeTransport(),
      request: { mode: 'pure_http', issuerOrigin: 'https://www.google.com', action: 'OTHER_ACTION', binding: binding() },
      code: 'FLOW_NODE_ISSUER_BINDING_INVALID',
    }],
    ['site key is absent from the active document', {
      transport: makeTransport({ siteKey: '' }),
      request: { mode: 'pure_http', issuerOrigin: 'https://www.google.com', action: 'VIDEO_GENERATION', binding: binding() },
      code: 'FLOW_NODE_ISSUER_SITE_KEY_UNAVAILABLE',
    }],
    ['no unexpired shared Google cookies remain', {
      transport: makeTransport({ cookies: [cookie('SID', 'expired', { expires: NOW / 1000 - 1 })] }),
      request: { mode: 'pure_http', issuerOrigin: 'https://www.google.com', action: 'VIDEO_GENERATION', binding: binding() },
      code: 'FLOW_NODE_ISSUER_COOKIE_SCOPE',
    }],
  ];

  for (const [name, scenario] of cases) {
    await t.test(name, async () => {
      const fake = makeWorkerFactory();
      const provider = createNodeRecaptchaProvider({ transport: scenario.transport, WorkerImpl: fake.WorkerImpl, clock: () => NOW });
      await assert.rejects(provider.acquire(scenario.request), error => error.code === scenario.code);
      assert.equal(fake.workers.length, 0, 'no issuer worker means no Google POST can be attempted');
    });
  }
});

test('rejects stale and future-dated worker tokens and terminates the worker', async t => {
  const cases = [
    ['stale token', NOW - 120_001],
    ['future token beyond clock skew', NOW + 5_001],
  ];
  for (const [name, issuedAt] of cases) {
    await t.test(name, async () => {
      const fake = makeWorkerFactory({ packet(worker) { issue(worker, verifiedReceipt(), { issuedAt }); } });
      const provider = createNodeRecaptchaProvider({ transport: makeTransport(), WorkerImpl: fake.WorkerImpl, clock: () => NOW });
      await assert.rejects(provider.acquire({
        mode: 'pure_http', issuerOrigin: 'https://www.google.com', action: 'VIDEO_GENERATION', binding: binding(),
      }), error => error.code === 'FLOW_NODE_ISSUER_RESULT_INVALID');
      assert.equal(fake.workers[0].terminated, true);
      assert.equal(JSON.stringify(provider.getLastReceipt()).includes(ISSUED_TOKEN), false);
    });
  }
});

test('worker failure and timeout expose only safe errors and keep tokens out of the receipt', async t => {
  await t.test('worker-reported failure', async () => {
    const fake = makeWorkerFactory({ packet(worker) {
      worker.emit('message', { kind: 'receipt', receipt: {
        ...verifiedReceipt(), rawToken: ISSUED_TOKEN, cookieHeader: COOKIE_SECRET,
        reload: { postCount: 1, status: 200, responseSchemaValid: true, secret: ISSUED_TOKEN },
      } });
      worker.emit('message', { kind: 'failed', code: 'FLOW_NODE_ISSUER_CONTRACT_UNVERIFIED', detail: ISSUED_TOKEN });
    } });
    const provider = createNodeRecaptchaProvider({ transport: makeTransport(), WorkerImpl: fake.WorkerImpl, clock: () => NOW });
    await assert.rejects(provider.acquire({
      mode: 'pure_http', issuerOrigin: 'https://www.google.com', action: 'VIDEO_GENERATION', binding: binding(),
    }), error => {
      assert.equal(error.code, 'FLOW_NODE_ISSUER_CONTRACT_UNVERIFIED');
      assert.doesNotMatch(error.message, /one-time-issued-token-secret|active-google-cookie-secret/);
      return true;
    });
    const serialized = JSON.stringify(provider.getLastReceipt());
    assert.equal(serialized.includes(ISSUED_TOKEN), false);
    assert.equal(serialized.includes(COOKIE_SECRET), false);
    assert.equal(fake.workers[0].terminated, true);
  });

  await t.test('bounded timeout', async () => {
    const fake = makeWorkerFactory();
    const provider = createNodeRecaptchaProvider({
      transport: makeTransport(), WorkerImpl: fake.WorkerImpl, clock: () => NOW, timeoutMs: 1_000,
    });
    await assert.rejects(provider.acquire({
      mode: 'pure_http', issuerOrigin: 'https://www.google.com', action: 'VIDEO_GENERATION', binding: binding(),
    }), error => {
      assert.equal(error.code, 'FLOW_NODE_ISSUER_TIMEOUT');
      assert.doesNotMatch(error.message, /one-time-issued-token-secret|active-google-cookie-secret/);
      return true;
    });
    assert.equal(fake.workers[0].terminated, true);
    const serialized = JSON.stringify(provider.getLastReceipt());
    assert.equal(serialized.includes(ISSUED_TOKEN), false);
    assert.equal(serialized.includes(COOKIE_SECRET), false);
  });
});
