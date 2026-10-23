import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSafeFlowRecoveryDiagnostics,
  GOOGLE_FLOW_AUTH_CREDENTIAL,
  recoverFlowGoogleSession,
  validateGoogleFlowAuthBundle,
} from '../src/google-sso-recovery.mjs';
import { FLOW_CREDENTIAL } from '../src/session-name.mjs';

const FLOW_ORIGIN = 'https://flow.google.com';
const ACCOUNTS_ORIGIN = 'https://accounts.google.com';
const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000';
const OWNER = 'owner@example.com';
const NOW = 1_800_000_000_000;

function cookie(name, value, overrides = {}) {
  return {
    name,
    value,
    domain: '.google.com',
    hostOnly: false,
    path: '/',
    expires: NOW / 1000 + 7_200,
    session: false,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    ...overrides,
  };
}

function broker(overrides = {}) {
  return {
    version: 1,
    origin: ACCOUNTS_ORIGIN,
    serviceOrigin: FLOW_ORIGIN,
    projectId: PROJECT_ID,
    owner: OWNER,
    capturedAt: new Date(NOW - 1_000).toISOString(),
    observedServiceLoginUrl: 'https://accounts.google.com/ServiceLogin?stale=must-not-be-used',
    cookies: [
      cookie('SID', 'shared-session'),
      cookie('SIDCC', 'shared-cross-domain'),
      cookie('GAPSTS', 'account-host-cookie', { domain: 'accounts.google.com', hostOnly: true }),
    ],
    ...overrides,
  };
}

function staleFlow() {
  return {
    version: 1,
    origin: FLOW_ORIGIN,
    projectId: PROJECT_ID,
    capturedAt: new Date(NOW - 60_000).toISOString(),
    reauthRequired: true,
    cookies: [cookie('OSID', 'stale-flow-cookie', { domain: 'flow.google.com', hostOnly: true })],
  };
}

function response({ url, status = 200, location, mime = 'text/html; charset=utf-8', body = '', setCookies = [] }) {
  const values = new Map();
  if (location) values.set('location', location);
  if (mime) values.set('content-type', mime);
  values.set('content-length', String(Buffer.byteLength(body)));
  return {
    url,
    status,
    headers: {
      get(name) { return values.get(String(name).toLowerCase()) ?? null; },
      getSetCookie() { return setCookies; },
    },
    body: [Buffer.from(body)],
    async text() { return body; },
  };
}

function projectContinuation({ pli = false } = {}) {
  const url = new URL(`/project/${PROJECT_ID}`, FLOW_ORIGIN);
  if (pli) url.searchParams.set('pli', '1');
  return url.href;
}

function firstLocation({ extra = null } = {}) {
  const url = new URL('/ServiceLogin', ACCOUNTS_ORIGIN);
  url.searchParams.set('passive', '1209600');
  url.searchParams.set('osid', '1');
  url.searchParams.set('continue', projectContinuation());
  url.searchParams.set('followup', projectContinuation());
  url.searchParams.set('authuser', '0');
  if (extra) url.searchParams.set(extra[0], extra[1]);
  return url.href;
}

function setOsidLocation() {
  const url = new URL('/accounts/SetOSID', FLOW_ORIGIN);
  url.searchParams.set('authuser', '0');
  url.searchParams.set('continue', projectContinuation({ pli: true }));
  url.searchParams.set('osidt', 'ephemeral-osid-ticket');
  return url.href;
}

function html(owner = OWNER) {
  return `<script>{"oPEP7c":${JSON.stringify(owner)},"SNlM0e":"request-token","FdrFJe":"request-sid","cfb2h":"build-tag"}</script>`;
}

const projectRpcBody = JSON.stringify([
  ['wrb.fr', 'Zzl0ze', JSON.stringify([null, [], []]), null, null, null],
]);

function makeHarness({ owner = OWNER, conflictAtRpc = false, mutateAuthRaw = false, brokerInput = broker() } = {}) {
  const stored = new Map([
    [GOOGLE_FLOW_AUTH_CREDENTIAL, JSON.stringify(brokerInput)],
    [FLOW_CREDENTIAL, JSON.stringify(staleFlow())],
  ]);
  const writes = [];
  const calls = [];
  const readCredentialImpl = name => stored.get(name) ?? null;
  const writeCredentialImpl = (name, value) => {
    const parsed = JSON.parse(value);
    writes.push({ name, value: parsed, afterCalls: calls.length });
    stored.set(name, value);
    return { stored: true, plaintextPersisted: false, encryption: 'test memory' };
  };
  const fetchImpl = async (urlValue, init) => {
    const url = new URL(urlValue);
    calls.push({ url, init });
    assert.equal(init.redirect, 'manual');
    assert.equal(init.method, calls.length === 5 ? 'POST' : 'GET');
    if (calls.length === 1) {
      assert.equal(url.href, `${FLOW_ORIGIN}/project/${PROJECT_ID}`);
      assert.match(init.headers.cookie, /SID=shared-session/);
      assert.doesNotMatch(init.headers.cookie, /GAPSTS=|OSID=stale-flow-cookie/);
      return response({ url: url.href, status: 302, location: firstLocation() });
    }
    if (calls.length === 2) {
      assert.equal(url.origin, ACCOUNTS_ORIGIN);
      assert.equal(url.pathname, '/ServiceLogin');
      assert.match(init.headers.cookie, /GAPSTS=account-host-cookie/);
      assert.match(init.headers.cookie, /SID=shared-session/);
      assert.doesNotMatch(init.headers.cookie, /stale=must-not-be-used/);
      return response({
        url: url.href,
        status: 302,
        location: setOsidLocation(),
        setCookies: [
          'GAPSTS=rotated-account-cookie; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=7200',
          'SIDCC=rotated-shared-cookie; Domain=.google.com; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=7200',
        ],
      });
    }
    if (calls.length === 3) {
      assert.equal(url.pathname, '/accounts/SetOSID');
      assert.match(init.headers.cookie, /SIDCC=rotated-shared-cookie/);
      assert.doesNotMatch(init.headers.cookie, /GAPSTS=/);
      return response({
        url: url.href,
        status: 302,
        location: projectContinuation({ pli: true }),
        setCookies: [
          'OSID=new-flow-osid; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=7200',
          '__Secure-OSID=new-flow-secure-osid; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=7200',
        ],
      });
    }
    if (calls.length === 4) {
      assert.equal(url.href, projectContinuation({ pli: true }));
      assert.match(init.headers.cookie, /OSID=new-flow-osid/);
      assert.match(init.headers.cookie, /__Secure-OSID=new-flow-secure-osid/);
      assert.doesNotMatch(init.headers.cookie, /GAPSTS=|stale-flow-cookie/);
      return response({ url: url.href, body: html(owner) });
    }
    assert.equal(calls.length, 5);
    assert.equal(url.origin, FLOW_ORIGIN);
    assert.equal(url.pathname, '/_/AiSandboxAngularFrontend/data/batchexecute');
    assert.equal(url.searchParams.get('rpcids'), 'Zzl0ze');
    assert.match(init.headers.cookie, /OSID=new-flow-osid/);
    assert.doesNotMatch(init.headers.cookie, /GAPSTS=/);
    assert.equal(writes.length, 0, 'protected writes are deferred until the owner and RPC checks pass');
    if (conflictAtRpc) stored.set(FLOW_CREDENTIAL, JSON.stringify({ ...staleFlow(), projectId: '223e4567-e89b-42d3-a456-426614174000' }));
    if (mutateAuthRaw) stored.set(GOOGLE_FLOW_AUTH_CREDENTIAL, JSON.stringify({ ...brokerInput, owner: 'changed@example.com' }));
    return response({ url: url.href, mime: 'application/json; charset=utf-8', body: projectRpcBody });
  };
  return { stored, writes, calls, fetchImpl, readCredentialImpl, writeCredentialImpl };
}

test('uses a fresh observed ServiceLogin redirect, verifies owner and project RPC, then persists scoped records', async () => {
  const harness = makeHarness();
  const result = await recoverFlowGoogleSession({
    ...harness,
    clock: () => NOW,
  });

  assert.equal(harness.calls.length, 5);
  assert.deepEqual(harness.calls.map(({ url }) => `${url.origin}${url.pathname}`), [
    `${FLOW_ORIGIN}/project/${PROJECT_ID}`,
    `${ACCOUNTS_ORIGIN}/ServiceLogin`,
    `${FLOW_ORIGIN}/accounts/SetOSID`,
    `${FLOW_ORIGIN}/project/${PROJECT_ID}`,
    `${FLOW_ORIGIN}/_/AiSandboxAngularFrontend/data/batchexecute`,
  ]);
  assert.deepEqual(harness.writes.map(write => write.name), [FLOW_CREDENTIAL, GOOGLE_FLOW_AUTH_CREDENTIAL]);
  assert.equal(harness.writes.every(write => write.afterCalls === 5), true);
  const savedFlow = harness.writes[0].value;
  assert.equal(savedFlow.projectId, PROJECT_ID);
  assert.equal(savedFlow.cookies.find(value => value.name === 'OSID').value, 'new-flow-osid');
  assert.equal(savedFlow.cookies.find(value => value.name === '__Secure-OSID').httpOnly, true);
  assert.equal(savedFlow.cookies.some(value => value.domain === 'accounts.google.com'), false);
  const savedBroker = harness.writes[1].value;
  assert.equal(Object.hasOwn(savedBroker, 'observedServiceLoginUrl'), false);
  assert.equal(savedBroker.cookies.find(value => value.name === 'GAPSTS').value, 'rotated-account-cookie');
  assert.equal(savedBroker.cookies.find(value => value.name === 'SIDCC').value, 'rotated-shared-cookie');
  assert.deepEqual(result.hops.map(hop => hop.path), [
    'project', 'servicelogin', 'set_osid', 'project', 'protected_project_rpc',
  ]);
  assert.equal(result.projectVerified, true);
  assert.equal(result.ownerVerified, true);
  assert.equal(result.protectedRpcVerified, true);
  assert.equal(result.listedMediaCount, 0);
  const safe = JSON.stringify(result);
  for (const secret of [OWNER, 'shared-session', 'new-flow-osid', 'ephemeral-osid-ticket', 'request-token', 'request-sid']) {
    assert.equal(safe.includes(secret), false);
  }
});

test('rejects login-route query changes without following or persisting them', async () => {
  const harness = makeHarness();
  harness.fetchImpl = async (urlValue, init) => {
    const url = new URL(urlValue);
    harness.calls.push({ url, init });
    return response({ url: url.href, status: 302, location: firstLocation({ extra: ['unexpected', 'value'] }) });
  };
  await assert.rejects(recoverFlowGoogleSession({ ...harness, clock: () => NOW }), error => {
    assert.equal(error.code, 'FLOW_SSO_RECOVERY_REDIRECT_UNEXPECTED');
    assert.equal(error.message.includes('unexpected'), false);
    return true;
  });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.writes.length, 0);
});

test('server sign-in redirect keeps the original startup context and only safe observed hop metadata', async () => {
  const harness = makeHarness();
  const privateOwner = 'private-owner@example.invalid';
  const privateQuery = 'private-query-secret';
  const privateCookie = 'synthetic-cookie-value-secret';
  const privateHash = 'A'.repeat(64);
  harness.fetchImpl = async urlValue => {
    const url = new URL(urlValue);
    harness.calls.push({ url });
    if (harness.calls.length === 1) {
      return response({ url: url.href, status: 302, location: firstLocation() });
    }
    const signIn = new URL('/v3/signin/identifier', ACCOUNTS_ORIGIN);
    signIn.searchParams.set('continue', `${FLOW_ORIGIN}/project/${PROJECT_ID}?${privateQuery}=${privateHash}`);
    return response({
      url: url.href,
      status: 302,
      location: signIn.href,
      setCookies: [`GAPS=${privateCookie}; Path=/; Secure; HttpOnly; Max-Age=7200`],
    });
  };

  await assert.rejects(recoverFlowGoogleSession({ ...harness, clock: () => NOW }), error => {
    assert.equal(error.code, 'FLOW_SSO_RECOVERY_LOGIN_REQUIRED');
    const summary = formatSafeFlowRecoveryDiagnostics(error.recoveryDiagnostics);
    assert.match(summary, /flow\.google\.com\/project:status=302/);
    assert.match(summary, /accounts\.google\.com\/servicelogin:status=302/);
    assert.match(summary, /responseCookieNames=GAPS/);
    assert.doesNotMatch(summary, /https?:\/\/|owner@example|private-query|synthetic-cookie|A{64}/i);
    assert.equal(formatSafeFlowRecoveryDiagnostics({
      ...error.recoveryDiagnostics,
      hops: [{ ...error.recoveryDiagnostics.hops[0], rawUrl: `https://accounts.google.com/signin?token=${privateHash}` }],
    }), null);
    assert.equal(harness.calls.length, 2);
    assert.equal(harness.writes.length, 0);
    assert.doesNotMatch(JSON.stringify({ code: error.code, recovery: error.recoveryDiagnostics, summary }),
      new RegExp(`${privateOwner}|${privateQuery}|${privateCookie}|${privateHash}`));
    return true;
  });
});

test('protected-store read timeout is classified separately from rejected Google authentication', async () => {
  const harness = makeHarness();
  const privateStoreText = 'synthetic-store-timeout-secret';
  await assert.rejects(recoverFlowGoogleSession({
    ...harness,
    readCredentialImpl(name) {
      if (name === GOOGLE_FLOW_AUTH_CREDENTIAL) {
        throw Object.assign(new Error(privateStoreText), { code: 'CREDENTIAL_STORE_TIMEOUT' });
      }
      return harness.stored.get(name) ?? null;
    },
    clock: () => NOW,
  }), error => {
    assert.equal(error.code, 'FLOW_SSO_RECOVERY_CREDENTIAL_STORE_READ_TIMEOUT');
    assert.equal(formatSafeFlowRecoveryDiagnostics(error.recoveryDiagnostics), 'recoveryHops=none');
    assert.doesNotMatch(JSON.stringify({ code: error.code, diagnostics: error.recoveryDiagnostics }), /synthetic-store-timeout-secret/);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.writes.length, 0);
    return true;
  });
});

test('owner mismatch blocks the protected RPC and all protected writes', async () => {
  const harness = makeHarness({ owner: 'different@example.com' });
  await assert.rejects(recoverFlowGoogleSession({ ...harness, clock: () => NOW }), error => {
    assert.equal(error.code, 'FLOW_SSO_RECOVERY_OWNER_MISMATCH');
    assert.equal(error.message.includes('different@example.com'), false);
    return true;
  });
  assert.equal(harness.calls.length, 4);
  assert.equal(harness.writes.length, 0);
});

test('project-store replacement during the RPC prevents a stale commit', async () => {
  const harness = makeHarness({ conflictAtRpc: true });
  await assert.rejects(recoverFlowGoogleSession({ ...harness, clock: () => NOW }), error => {
    assert.equal(error.code, 'FLOW_SSO_RECOVERY_STORE_CONFLICT');
    return true;
  });
  assert.equal(harness.calls.length, 5);
  assert.equal(harness.writes.length, 0);
});

test('Google broker replacement during the RPC prevents a stale commit', async () => {
  const harness = makeHarness({ mutateAuthRaw: true });
  await assert.rejects(recoverFlowGoogleSession({ ...harness, clock: () => NOW }), error => {
    assert.equal(error.code, 'FLOW_SSO_RECOVERY_STORE_CONFLICT');
    return true;
  });
  assert.equal(harness.calls.length, 5);
  assert.equal(harness.writes.length, 0);
});

test('first protected write failure leaves both original protected records untouched', async () => {
  const harness = makeHarness();
  const originalFlow = harness.stored.get(FLOW_CREDENTIAL);
  const originalBroker = harness.stored.get(GOOGLE_FLOW_AUTH_CREDENTIAL);
  await assert.rejects(recoverFlowGoogleSession({
    ...harness,
    writeCredentialImpl: () => {
      assert.equal(harness.calls.length, 5, 'the first protected write follows owner and RPC verification');
      throw new Error('synthetic protected write failure');
    },
    clock: () => NOW,
  }), error => {
    assert.equal(error.code, 'FLOW_SSO_RECOVERY_CREDENTIAL_STORE_WRITE_FAILED');
    return true;
  });
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.stored.get(FLOW_CREDENTIAL), originalFlow);
  assert.equal(harness.stored.get(GOOGLE_FLOW_AUTH_CREDENTIAL), originalBroker);
});

test('second protected write timeout reports partial commit and preserves the verified Flow session', async () => {
  const harness = makeHarness();
  const originalBroker = harness.stored.get(GOOGLE_FLOW_AUTH_CREDENTIAL);
  let attempts = 0;
  await assert.rejects(recoverFlowGoogleSession({
    ...harness,
    writeCredentialImpl: (name, value) => {
      attempts += 1;
      if (attempts === 2) throw Object.assign(new Error('synthetic second protected-store timeout'), {
        code: 'CREDENTIAL_STORE_TIMEOUT',
      });
      return harness.writeCredentialImpl(name, value);
    },
    clock: () => NOW,
  }), error => {
    assert.equal(error.code, 'FLOW_SSO_RECOVERY_PARTIAL_COMMIT');
    assert.equal(error.flowStored, true);
    assert.equal(error.googleAuthStored, false);
    assert.equal(error.storeFailureCode, 'FLOW_SSO_RECOVERY_CREDENTIAL_STORE_WRITE_TIMEOUT');
    assert.match(formatSafeFlowRecoveryDiagnostics(error.recoveryDiagnostics), /protected_project_rpc:status=200/);
    return true;
  });
  assert.equal(harness.calls.length, 5);
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].name, FLOW_CREDENTIAL);
  const preservedFlow = JSON.parse(harness.stored.get(FLOW_CREDENTIAL));
  assert.equal(preservedFlow.projectId, PROJECT_ID);
  assert.equal(preservedFlow.cookies.find(value => value.name === 'OSID').value, 'new-flow-osid');
  assert.equal(harness.stored.get(GOOGLE_FLOW_AUTH_CREDENTIAL), originalBroker);
});

test('broker validation rejects Flow-host cookies and unsupported broker origins', () => {
  assert.throws(() => validateGoogleFlowAuthBundle(broker({ cookies: [
    cookie('OSID', 'not-allowed', { domain: 'flow.google.com', hostOnly: true }),
  ] }), { now: NOW }), error => error.code === 'FLOW_SSO_RECOVERY_BROKER_SCOPE');
  assert.throws(() => validateGoogleFlowAuthBundle(broker({ origin: 'https://example.com' }), { now: NOW }),
    error => error.code === 'FLOW_SSO_RECOVERY_BROKER_INVALID');
});

test('a login or challenge HTML response is held without parsing tokens, RPC, or persistence', async () => {
  const harness = makeHarness();
  harness.fetchImpl = async (urlValue, init) => {
    const url = new URL(urlValue);
    harness.calls.push({ url, init });
    return response({ url: url.href, body: '<html>identifier challenge</html>' });
  };
  await assert.rejects(recoverFlowGoogleSession({ ...harness, clock: () => NOW }), error => {
    assert.equal(error.code, 'FLOW_SSO_RECOVERY_LOGIN_OR_CHALLENGE');
    assert.equal(error.message.includes('identifier challenge'), false);
    return true;
  });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.writes.length, 0);
});
