import test from 'node:test';
import assert from 'node:assert/strict';
import { renewFlowGoogleCookies } from '../src/cookie-rotation.mjs';

const FLOW_ORIGIN = 'https://flow.google.com';
const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = 1_800_000_000_000;
const NOW_SECONDS = NOW / 1000;
const TARGET_NAMES = ['SIDCC', '__Secure-1PSIDCC', '__Secure-3PSIDCC'];

function cookie(name, value, overrides = {}) {
  return {
    name,
    value,
    domain: '.google.com',
    hostOnly: false,
    path: '/',
    expires: NOW_SECONDS + 7_200,
    session: false,
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    ...overrides,
  };
}

function bundle({ projectId = PROJECT_ID, cookies = null, ...extra } = {}) {
  return {
    version: 1,
    origin: FLOW_ORIGIN,
    projectId,
    capturedAt: new Date(NOW - 1_000).toISOString(),
    cookies: cookies ?? [
      cookie('SID', 'old-sid'),
      cookie('__Secure-1PSID', 'old-secure-sid'),
      cookie('SIDCC', 'old-sidcc'),
      cookie('__Secure-1PSIDCC', 'old-1psidcc'),
      cookie('__Secure-3PSIDCC', 'old-3psidcc'),
      cookie('NID', 'old-nid'),
      cookie('OSID', 'flow-host-cookie', { domain: 'flow.google.com', hostOnly: true }),
    ],
    ...extra,
  };
}

function rotatedHeaders({ overrides = {} } = {}) {
  const expires = [
    'SIDCC=fresh-sidcc; Domain=.google.com; Path=/; Max-Age=7200; HttpOnly; SameSite=Lax',
    '__Secure-1PSIDCC=fresh-1psidcc; Domain=.google.com; Path=/; Max-Age=7200; Secure; HttpOnly; SameSite=None',
    '__Secure-3PSIDCC=fresh-3psidcc; Domain=.google.com; Path=/; Max-Age=7200; Secure; HttpOnly; SameSite=None',
  ];
  return {
    get(name) {
      if (name.toLowerCase() === 'content-type') return overrides.contentType ?? 'text/html; charset=utf-8';
      if (name.toLowerCase() === 'location') return overrides.location ?? null;
      return null;
    },
    getSetCookie() { return overrides.setCookies ?? expires; },
  };
}

function response({ status = 200, headers = rotatedHeaders(), url = undefined } = {}) {
  return {
    status,
    headers,
    url,
    body: { cancel: async () => {} },
  };
}

function makeDependencies({ initialBundle = bundle(), latestBundle = initialBundle, responseValue = response() } = {}) {
  let reads = 0;
  const writes = [];
  const readCredentialImpl = () => {
    reads += 1;
    return JSON.stringify(reads === 1 ? initialBundle : latestBundle);
  };
  const writeCredentialImpl = (name, value) => {
    writes.push({ name, value: JSON.parse(value) });
    return { stored: true };
  };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: new URL(url), init });
    return { ...responseValue, url: responseValue.url ?? new URL(url).href };
  };
  return { readCredentialImpl, writeCredentialImpl, fetchImpl, requests, writes,
    get readCount() { return reads; } };
}

test('uses the observed GET and merges only three cookies into the freshest protected bundle', async () => {
  const initial = bundle();
  delete initial.cookies.find(value => value.name === 'NID').hostOnly;
  initial.cookies.find(value => value.name === 'NID').secure = false;
  initial.cookies.splice(2, 0, cookie('RTS', 'expired-rts', { expires: NOW_SECONDS - 60 }));
  const latest = bundle({ cookies: initial.cookies.map(value => value.name === 'NID'
    ? { ...value, value: 'concurrent-fresh-nid' }
    : value) });
  const dependencies = makeDependencies({ initialBundle: initial, latestBundle: latest });

  const result = await renewFlowGoogleCookies({ ...dependencies, clock: () => NOW });

  assert.equal(dependencies.requests.length, 1);
  const [{ url, init }] = dependencies.requests;
  assert.equal(url.href,
    'https://accounts.google.com/RotateCookiesPage?og_pid=749&rot=3&origin=https%3A%2F%2Fflow.google.com&exp_id=0');
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.accept, 'text/html');
  assert.match(init.headers.cookie, /SID=old-sid/);
  assert.match(init.headers.cookie, /NID=old-nid/);
  assert.doesNotMatch(init.headers.cookie, /OSID=flow-host-cookie/);
  assert.doesNotMatch(init.headers.cookie, /RTS=expired-rts/);
  assert.equal(dependencies.readCount, 2, 'the store is reread after the network response before merging');
  assert.equal(dependencies.writes.length, 1);
  assert.equal(dependencies.writes[0].name, 'google-flow-session-v1');

  const saved = dependencies.writes[0].value;
  assert.equal(saved.cookieCount, latest.cookies.length);
  assert.equal(saved.cookies.find(value => value.name === 'NID').value, 'concurrent-fresh-nid');
  assert.equal(saved.cookies.find(value => value.name === 'RTS').value, 'expired-rts',
    'expired unrelated entries remain in the latest raw bundle instead of shifting merge indices');
  assert.equal(saved.cookies.find(value => value.name === 'OSID').value, 'flow-host-cookie');
  for (const name of TARGET_NAMES) {
    const stored = saved.cookies.find(value => value.name === name);
    assert.match(stored.value, /^fresh-/);
    assert.equal(stored.domain, 'google.com');
    assert.equal(stored.hostOnly, false);
    assert.equal(stored.path, '/');
    assert.equal(stored.secure, name !== 'SIDCC');
    assert.equal(stored.expires, NOW_SECONDS + 7_200);
  }

  assert.deepEqual(result, {
    operation: 'normal_observed_cookie_rotation',
    method: 'GET',
    host: 'accounts.google.com',
    path: '/RotateCookiesPage',
    httpStatus: 200,
    requestCookieCount: 6,
    rotatedCookieNames: TARGET_NAMES,
    stored: true,
    capturedAt: new Date(NOW).toISOString(),
  });
  const safeResult = JSON.stringify(result);
  for (const secret of ['old-sid', 'fresh-sidcc', 'old-nid', 'concurrent-fresh-nid']) {
    assert.equal(safeResult.includes(secret), false);
  }
});

test('does not store redirects, unexpected MIME, or cookies outside the observed scope', async t => {
  const cases = [
    ['redirect', response({ status: 302 })],
    ['wrong mime', response({ headers: rotatedHeaders({ overrides: { contentType: 'application/json' } }) })],
    ['wrong cookie domain', response({ headers: rotatedHeaders({ overrides: {
      setCookies: [
        'SIDCC=fresh-sidcc; Domain=.accounts.google.com; Path=/; Max-Age=7200; HttpOnly',
        '__Secure-1PSIDCC=fresh-1psidcc; Domain=.google.com; Path=/; Max-Age=7200; Secure; HttpOnly',
        '__Secure-3PSIDCC=fresh-3psidcc; Domain=.google.com; Path=/; Max-Age=7200; Secure; HttpOnly',
      ],
    } }) })],
    ['wrong cookie path', response({ headers: rotatedHeaders({ overrides: {
      setCookies: [
        'SIDCC=fresh-sidcc; Domain=.google.com; Path=/RotateCookiesPage; Max-Age=7200; HttpOnly',
        '__Secure-1PSIDCC=fresh-1psidcc; Domain=.google.com; Path=/; Max-Age=7200; Secure; HttpOnly',
        '__Secure-3PSIDCC=fresh-3psidcc; Domain=.google.com; Path=/; Max-Age=7200; Secure; HttpOnly',
      ],
    } }) })],
  ];

  for (const [name, responseValue] of cases) {
    await t.test(name, async () => {
      const dependencies = makeDependencies({ responseValue });
      await assert.rejects(renewFlowGoogleCookies({ ...dependencies, clock: () => NOW }), error => {
        assert.match(error.code, /^FLOW_SESSION_ROTATION_/);
        assert.doesNotMatch(error.message, /old-sid|fresh-sidcc|accounts\.google\.com\/RotateCookiesPage\?/);
        return true;
      });
      assert.equal(dependencies.requests.length, 1);
      assert.equal(dependencies.writes.length, 0);
    });
  }
});

test('requires an observed shared-cookie bundle and refuses store scope changes before writing', async t => {
  await t.test('legacy flat header is not sent to accounts.google.com', async () => {
    const legacy = { version: 1, origin: FLOW_ORIGIN, projectId: PROJECT_ID,
      cookieHeader: 'SID=old; __Secure-1PSID=old-secure' };
    const dependencies = makeDependencies({ initialBundle: legacy, latestBundle: legacy });
    await assert.rejects(renewFlowGoogleCookies({ ...dependencies, clock: () => NOW }),
      error => error.code === 'FLOW_SESSION_ROTATION_SESSION_SCOPE');
    assert.equal(dependencies.requests.length, 0);
    assert.equal(dependencies.writes.length, 0);
  });

  await t.test('project change during request prevents merge', async () => {
    const initial = bundle();
    const latest = bundle({ projectId: '223e4567-e89b-42d3-a456-426614174000' });
    const dependencies = makeDependencies({ initialBundle: initial, latestBundle: latest });
    await assert.rejects(renewFlowGoogleCookies({ ...dependencies, clock: () => NOW }),
      error => error.code === 'FLOW_SESSION_ROTATION_STORE_CONFLICT');
    assert.equal(dependencies.requests.length, 1);
    assert.equal(dependencies.writes.length, 0);
  });
});

test('preserves protected-store timeout and unreadable classifications without starting another operation', async t => {
  await t.test('initial DPAPI helper timeout is not mislabeled as missing login', async () => {
    const dependencies = makeDependencies();
    const timeout = Object.assign(new Error('CREDENTIAL_STORE_TIMEOUT'), {
      code: 'CREDENTIAL_STORE_TIMEOUT', operation: 'read', timeoutMs: 120_000,
    });
    await assert.rejects(renewFlowGoogleCookies({
      ...dependencies, readCredentialImpl: () => { throw timeout; }, clock: () => NOW,
    }), error => {
      assert.equal(error.code, 'FLOW_SESSION_ROTATION_CREDENTIAL_STORE_TIMEOUT');
      assert.equal(error.credentialStoreCode, 'CREDENTIAL_STORE_TIMEOUT');
      assert.equal(error.operation, 'read');
      assert.equal(error.timeoutMs, 120_000);
      return true;
    });
    assert.equal(dependencies.requests.length, 0);
    assert.equal(dependencies.writes.length, 0);
  });

  await t.test('protected-store reread failure keeps its safe class and does not write a stale merge', async () => {
    const dependencies = makeDependencies();
    let reads = 0;
    const unreadable = Object.assign(new Error('CREDENTIAL_STORE_UNREADABLE'), { code: 'CREDENTIAL_STORE_UNREADABLE' });
    await assert.rejects(renewFlowGoogleCookies({
      ...dependencies,
      readCredentialImpl: () => {
        reads += 1;
        if (reads === 1) return JSON.stringify(bundle());
        throw unreadable;
      },
      clock: () => NOW,
    }), error => {
      assert.equal(error.code, 'FLOW_SESSION_ROTATION_CREDENTIAL_STORE_UNREADABLE');
      assert.equal(error.credentialStoreCode, 'CREDENTIAL_STORE_UNREADABLE');
      assert.equal(error.operation, 'reread');
      return true;
    });
    assert.equal(dependencies.requests.length, 1);
    assert.equal(dependencies.writes.length, 0);
  });
});
