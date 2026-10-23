import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import test from 'node:test';
import { createNodeRecaptchaProvider } from '../src/node-recaptcha-issuer.mjs';
import { isObservedNativeAgent, readIssuerRequest } from '../src/recaptcha-http-guard.mjs';

function observedRequest(overrides = {}) {
  return readIssuerRequest({
    protocol: 'https:',
    hostname: 'www.google.com',
    path: '/recaptcha/enterprise/anchor?render=must-not-escape',
    method: 'GET',
    headers: {},
    ...overrides,
  }, 'https:');
}

test('accepts the exact native Node HTTPS agent shape used by JSDOM XHR', () => {
  const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: true });
  try {
    const descriptor = observedRequest({ agent });
    assert.equal(isObservedNativeAgent(agent, 'https:'), true);
    assert.equal(descriptor.hasCustomAgent, false);
    assert.equal(descriptor.hasCustomTransport, false);
    assert.equal(descriptor.pathname, '/recaptcha/enterprise/anchor');
    assert.equal(Object.hasOwn(descriptor, 'search'), false);
    assert.equal(descriptor.agentSummary.className, 'https.Agent');
    assert.deepEqual(descriptor.agentSummary.optionKeys,
      ['defaultPort', 'keepAlive', 'noDelay', 'path', 'protocol', 'rejectUnauthorized']);
    assert.equal(descriptor.agentSummary.optionsNullPrototype, true);
    assert.equal(descriptor.agentSummary.createConnectionNative, true);
  } finally {
    agent.destroy();
  }
});

test('rejects proxy-like, modified, and insecure agents', () => {
  const insecure = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
  class ProxyLikeAgent extends https.Agent {}
  const proxyLike = new ProxyLikeAgent({ keepAlive: true, rejectUnauthorized: true });
  const modified = new https.Agent({ keepAlive: true, rejectUnauthorized: true });
  modified.createConnection = () => { throw new Error('must not be called'); };
  try {
    for (const agent of [insecure, proxyLike, modified, { options: { keepAlive: true, rejectUnauthorized: true } }]) {
      assert.equal(isObservedNativeAgent(agent, 'https:'), false);
      assert.equal(observedRequest({ agent }).hasCustomAgent, true);
    }
    assert.equal(isObservedNativeAgent(insecure, 'http:'), false);
  } finally {
    insecure.destroy();
    proxyLike.destroy();
    modified.destroy();
  }
});

test('rejects custom routing, TLS identity, auth, and non-default ports', () => {
  const cases = [
    [{ lookup() {} }, 'hasCustomLookup'],
    [{ createConnection() {} }, 'hasCustomConnection'],
    [{ socketPath: 'named-pipe' }, 'hasCustomSocketPath'],
    [{ rejectUnauthorized: false }, 'hasCustomTlsIdentity'],
    [{ servername: 'elsewhere.example' }, 'hasUnexpectedServername'],
    [{ port: 444 }, 'port'],
    [{ auth: 'sensitive' }, 'hasAuth'],
  ];
  for (const [overrides, field] of cases) {
    const descriptor = observedRequest(overrides);
    assert.ok(descriptor[field], `${field} should be marked`);
    assert.equal(descriptor.hasCustomTransport || descriptor.hasAuth || Boolean(descriptor.port), true);
  }
});

test('keeps blocked-request diagnostics useful while stripping query values and arbitrary fields', async () => {
  class FixtureWorker extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => {
        this.emit('online');
        this.emit('message', { kind: 'receipt', receipt: {
          mode: 'node_jsdom_unmodified_sdk', stage: 'request_blocked', blockedRequests: [{
            host: 'www.google.com', path: '/recaptcha/enterprise/reload?token=do-not-store', method: 'POST',
            reason: 'nonstandard_agent',
            reasons: { nonstandardAgent: true, hasAuth: 'private', pathNotAllowlisted: false },
            agent: { className: 'https.Agent', optionKeys: ['keepAlive', 'private_cookie'], optionKeyCount: 2,
              prototypeNative: true, createConnectionNative: true, ownCreateConnection: false,
              optionsNullPrototype: true, keepAlive: true, rejectUnauthorized: true,
              defaultPortExpected: true, protocolHttps: true, noDelay: true, pathNull: true, raw: 'private' },
            rawUrl: 'https://www.google.com/recaptcha/enterprise/reload?token=do-not-store',
          }],
        } });
        this.emit('message', { kind: 'failed', code: 'FLOW_NODE_ISSUER_WORKER_FAILED' });
      });
    }
    terminate() { return Promise.resolve(0); }
  }
  const projectId = 'a8ae183d-74d6-4314-98f4-3e853539f22c';
  const provider = createNodeRecaptchaProvider({
    transport: {
      bundle: { projectId, cookies: [{ domain: '.google.com', hostOnly: false, name: 'SID', value: 'fixture', path: '/', secure: true, session: true }] },
      document: { siteKey: 'observed-public-key' },
    },
    WorkerImpl: FixtureWorker,
  });
  await assert.rejects(provider.acquire({
    mode: 'pure_http', issuerOrigin: 'https://www.google.com', action: 'VIDEO_GENERATION', binding: { projectId },
  }));
  const receipt = provider.getLastReceipt();
  assert.equal(receipt.blockedRequests[0].host, 'www.google.com');
  assert.equal(receipt.blockedRequests[0].path, '/other');
  assert.equal(receipt.blockedRequests[0].reason, 'nonstandard_agent');
  assert.equal(receipt.blockedRequests[0].reasons.nonstandardAgent, true);
  assert.equal(Object.hasOwn(receipt.blockedRequests[0].reasons, 'hasAuth'), false);
  assert.ok(receipt.blockedRequests[0].agent.optionKeys.includes('other'));
  assert.equal(Object.hasOwn(receipt.blockedRequests[0].agent, 'raw'), false);
  assert.equal(JSON.stringify(receipt).includes('do-not-store'), false);
  assert.equal(JSON.stringify(receipt).includes('private_cookie'), false);
});
