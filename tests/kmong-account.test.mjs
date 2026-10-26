import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ProtectedStore } from '../lib/protected-store.mjs';
import { createKmongAuth, KMONG_ACCOUNT_PATH, KMONG_ACCOUNT_URL, KMONG_ACCOUNT_STORE,
  KMONG_AUTH_COOKIE, validateKmongSessionImport } from '../lib/web-auth/kmong.mjs';

const EMAIL = 'owner.private@example.test';
const COOKIE_VALUE = 'sentinel-cookie-value-never-output';
const USERNAME = 'private_user_name';
const OWNER_ID = 712345;

function importInput(overrides = {}) {
  return {
    schemaVersion: 1,
    service: 'kmong',
    expectedEmail: EMAIL,
    cookies: [{
      name: KMONG_AUTH_COOKIE,
      value: COOKIE_VALUE,
      domain: '.kmong.com',
      path: '/',
      secure: true,
      httpOnly: true,
      expiresAt: null,
    }],
    ...overrides,
  };
}

function account(overrides = {}) {
  return {
    USERID: OWNER_ID,
    email: EMAIL,
    username: USERNAME,
    is_mobile_auth: false,
    social_provider: 'GOOGLE',
    privatePhone: '+1-555-0100',
    privateAddress: 'do not return this',
    ...overrides,
  };
}

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });

async function harness(t, fetchImpl, { now = Date.now } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kmong-account-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ProtectedStore({ provider: 'memory', directory });
  const calls = [];
  const auth = createKmongAuth({ store, now, fetchImpl: async (url, init) => {
    const target = new URL(String(url));
    const headers = new Headers(init.headers);
    const call = { url: target, method: init.method, redirect: init.redirect, cookie: headers.get('cookie'), headers };
    calls.push(call);
    return fetchImpl({ ...call, target, init, calls });
  } });
  return { auth, calls, store, directory };
}

test('cookie import contract accepts only the proven x-kmong authorization cookie with exact scope', () => {
  const value = validateKmongSessionImport(importInput());
  assert.equal(value.expectedEmail, EMAIL);
  assert.deepEqual(value.requiredCookieNames, [KMONG_AUTH_COOKIE]);
  assert.equal(value.cookies.length, 1);
  assert.equal(value.cookies[0].name, KMONG_AUTH_COOKIE);
  assert.equal(value.cookies[0].domain, '.kmong.com');
  assert.equal(value.cookies[0].secure, true);
  assert.equal(value.cookies[0].httpOnly, true);
  assert.equal(value.cookies[0].expires, undefined);

  assert.throws(() => validateKmongSessionImport({ ...importInput(), googlePassword: 'never accepted' }),
    { code: 'KMONG_AUTH_IMPORT_INVALID' });
  assert.throws(() => validateKmongSessionImport({ ...importInput(), cookies: [] }),
    { code: 'KMONG_AUTH_IMPORT_INVALID' });
  assert.throws(() => validateKmongSessionImport({ ...importInput(), cookies: [
    ...importInput().cookies,
    { name: 'kmong_session', value: 'not-required', domain: '.kmong.com', path: '/', secure: true, httpOnly: true, expiresAt: null },
  ] }), { code: 'KMONG_AUTH_IMPORT_INVALID' });
  assert.throws(() => validateKmongSessionImport({ ...importInput(), cookies: [
    { ...importInput().cookies[0], name: 'GoogleOAuth' },
  ] }), { code: 'KMONG_AUTH_COOKIE_INVALID' });
  assert.throws(() => validateKmongSessionImport({ ...importInput(), cookies: [
    { ...importInput().cookies[0], domain: 'evil.example' },
  ] }), { code: 'KMONG_AUTH_COOKIE_INVALID' });
  assert.throws(() => validateKmongSessionImport({ ...importInput(), cookies: [
    { ...importInput().cookies[0], secure: false },
  ] }), { code: 'KMONG_AUTH_COOKIE_INVALID' });
  assert.throws(() => validateKmongSessionImport({ ...importInput(), cookies: [
    { ...importInput().cookies[0], httpOnly: false },
  ] }), { code: 'KMONG_AUTH_COOKIE_INVALID' });
  assert.throws(() => validateKmongSessionImport({ ...importInput(), cookies: [
    { ...importInput().cookies[0], expiresAt: '2000-01-01T00:00:00.000Z' },
  ] }), { code: 'KMONG_AUTH_COOKIE_EXPIRED' });
  for (const value of ['embedded;bad', 'embedded,bad', '"quoted"', 'back\\slash']) {
    assert.throws(() => validateKmongSessionImport({ ...importInput(), cookies: [
      { ...importInput().cookies[0], value },
    ] }), { code: 'KMONG_AUTH_COOKIE_INVALID' });
  }
});

test('session import performs one exact HTTP owner read, pins USERID, and returns no identity or cookie values', async t => {
  const h = await harness(t, async ({ url, method, redirect, cookie }) => {
    assert.equal(url.href, KMONG_ACCOUNT_URL);
    assert.equal(url.pathname, KMONG_ACCOUNT_PATH);
    assert.equal(method, 'GET');
    assert.equal(redirect, 'manual');
    assert.equal(cookie, `${KMONG_AUTH_COOKIE}=${COOKIE_VALUE}`);
    return json(account());
  });
  const before = h.auth.status();
  assert.equal(before.configured, false);
  assert.equal(before.currentAuthentication, 'not_checked');

  const result = await h.auth.importSession(importInput());
  assert.equal(result.authenticated, true);
  assert.equal(result.ownerVerified, true);
  assert.equal(result.ownerIdPinned, true);
  assert.equal(result.importedCookieCount, 1);
  assert.equal(result.persistent, false);
  assert.equal(result.readMode, 'pure_http');
  assert.equal(result.bootstrapMode, 'manual_browser_cookie_import');
  assert.equal(h.calls.length, 1);
  assert.equal(h.auth.status().configured, true);
  assert.equal(h.calls.length, 1, 'status is configuration-only and does not issue an API read');
  const saved = JSON.parse(h.store.read(KMONG_ACCOUNT_STORE));
  assert.equal(saved.ownerId, OWNER_ID);
  assert.equal(saved.expectedEmail, EMAIL);
  assert.equal(saved.session.cookieJar.cookies[0].key, KMONG_AUTH_COOKIE);
  assert.equal(JSON.stringify(result).includes(COOKIE_VALUE), false);
  assert.equal(JSON.stringify(result).includes(EMAIL), false);
  assert.equal(JSON.stringify(result).includes(USERNAME), false);
  assert.equal(JSON.stringify(result).includes('privatePhone'), false);
  assert.equal(JSON.stringify(result).includes('privateAddress'), false);
});

test('owner, health and verify reuse the stored cookie with no login, refresh, or Google credential flow', async t => {
  const h = await harness(t, async () => json(account()));
  await h.auth.importSession(importInput());
  assert.equal((await h.auth.owner()).ownerVerified, true);
  assert.equal((await h.auth.health()).ownerVerified, true);
  assert.equal((await h.auth.verify()).ownerVerified, true);
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.calls.map(call => [call.method, new URL(call.url).pathname]), [
    ['GET', KMONG_ACCOUNT_PATH], ['GET', KMONG_ACCOUNT_PATH], ['GET', KMONG_ACCOUNT_PATH], ['GET', KMONG_ACCOUNT_PATH],
  ]);
  assert.ok(h.calls.every(call => call.cookie === `${KMONG_AUTH_COOKIE}=${COOKIE_VALUE}`));
  assert.equal(JSON.stringify(await h.auth.health()).includes(EMAIL), false);
});

test('wrong email or USERID never replaces a prior pinned owner', async t => {
  let current = account();
  const h = await harness(t, async () => json(current));
  await h.auth.importSession(importInput());
  const before = h.store.read(KMONG_ACCOUNT_STORE);
  current = account({ USERID: OWNER_ID + 1 });
  await assert.rejects(h.auth.health(), { code: 'KMONG_AUTH_OWNER_MISMATCH' });
  assert.equal(JSON.parse(h.store.read(KMONG_ACCOUNT_STORE)).ownerId, OWNER_ID);
  assert.equal(h.store.read(KMONG_ACCOUNT_STORE), before);

  current = account({ email: 'someone.else@example.test' });
  await assert.rejects(h.auth.importSession(importInput()), { code: 'KMONG_AUTH_OWNER_MISMATCH' });
  assert.equal(JSON.parse(h.store.read(KMONG_ACCOUNT_STORE)).ownerId, OWNER_ID);
});

test('expired stored authorization requires reauth and an explicit fresh same-owner import can replace it', async t => {
  let clock = Date.now();
  const h = await harness(t, async () => json(account()), { now: () => clock });
  const shortCookie = () => ({ ...importInput().cookies[0], expiresAt: new Date(clock + 60_000).toISOString() });
  await h.auth.importSession({ ...importInput(), cookies: [shortCookie()] });
  assert.equal(h.calls.length, 1);
  clock += 120_000;
  await assert.rejects(h.auth.health(), { code: 'KMONG_AUTH_REAUTH_REQUIRED' });
  assert.equal(h.calls.length, 1, 'expired credentials stop before HTTP');
  const expiredState = JSON.parse(h.store.read(KMONG_ACCOUNT_STORE));
  assert.equal(expiredState.verified, false);
  assert.equal(expiredState.ownerId, OWNER_ID);

  await h.auth.importSession({ ...importInput(), cookies: [shortCookie()] });
  assert.equal(h.calls.length, 2, 'only the explicit import performs the new owner GET');
  const renewedState = JSON.parse(h.store.read(KMONG_ACCOUNT_STORE));
  assert.equal(renewedState.verified, true);
  assert.equal(renewedState.ownerId, OWNER_ID);
});

test('204 and 401 require reauthentication; 403 remains forbidden without retries', async t => {
  for (const status of [204, 401]) {
    const h = await harness(t, async () => new Response(null, { status }));
    await assert.rejects(h.auth.importSession(importInput()), { code: 'KMONG_AUTH_REAUTH_REQUIRED' });
    assert.equal(h.calls.length, 1);
    assert.equal(h.store.status(KMONG_ACCOUNT_STORE).available, false);
  }

  let deny = false;
  const h = await harness(t, async () => deny
    ? new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain' } })
    : json(account()));
  await h.auth.importSession(importInput());
  deny = true;
  const before = h.calls.length;
  await assert.rejects(h.auth.health(), error => {
    assert.equal(error.code, 'KMONG_AUTH_FORBIDDEN');
    assert.equal(JSON.stringify(error.receipt).includes(COOKIE_VALUE), false);
    return true;
  });
  assert.equal(h.calls.length - before, 1);
});

test('unexpected transport error details are reduced to a fixed receipt code', async t => {
  const secretErrorCode = 'PRIVATE_TOKEN_VALUE_MUST_NOT_ESCAPE';
  const h = await harness(t, async () => { throw Object.assign(new Error('private transport details'), { code: secretErrorCode }); });
  await assert.rejects(h.auth.importSession(importInput()), error => {
    assert.equal(error.code, 'KMONG_AUTH_TRANSPORT_FAILED');
    assert.equal(error.receipt.causeCode, 'SCOPED_SESSION_TRANSPORT_FAILED');
    assert.equal(JSON.stringify(error.receipt).includes(secretErrorCode), false);
    assert.equal(JSON.stringify(error.receipt).includes('private transport details'), false);
    return true;
  });
  assert.equal(h.store.status(KMONG_ACCOUNT_STORE).available, false);
});

test('challenge HTML and malformed owner schemas fail without exposing the response', async t => {
  const html = await harness(t, async () => new Response('<!doctype html><title>Verify you are human</title>', {
    status: 200, headers: { 'content-type': 'text/html' },
  }));
  await assert.rejects(html.auth.importSession(importInput()), { code: 'KMONG_AUTH_CHALLENGE_HTML' });

  const schema = await harness(t, async () => json({ ...account(), USERID: 'not-a-number' }));
  await assert.rejects(schema.auth.importSession(importInput()), { code: 'KMONG_AUTH_OWNER_SCHEMA_INVALID' });
  assert.equal(schema.store.status(KMONG_ACCOUNT_STORE).available, false);
});

test('a response deleting the authorization cookie invalidates a 200 and prevents future reads', async t => {
  let deleteCookie = false;
  const h = await harness(t, async () => json(account(), 200, deleteCookie
    ? { 'set-cookie': `${KMONG_AUTH_COOKIE}=; Max-Age=0; Domain=.kmong.com; Path=/; Secure; HttpOnly` }
    : {}));
  await h.auth.importSession(importInput());
  deleteCookie = true;
  await assert.rejects(h.auth.health(), { code: 'KMONG_AUTH_REAUTH_REQUIRED' });
  const saved = JSON.parse(h.store.read(KMONG_ACCOUNT_STORE));
  assert.equal(saved.verified, false);
  assert.equal(saved.session.cookieJar.cookies.length, 0);
  const callsAfterDelete = h.calls.length;
  await assert.rejects(h.auth.health(), { code: 'KMONG_AUTH_REAUTH_REQUIRED' });
  assert.equal(h.calls.length, callsAfterDelete, 'missing required cookie prevents another request');
});

test('CLI session import reads hidden stdin, memory mode is explicitly nonpersistent, and outputs are sanitized', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kmong-account-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hook = path.join(directory, 'mock-fetch.mjs');
  await writeFile(hook, `globalThis.fetch = async (url, init) => {
    const u = new URL(url), h = new Headers(init.headers);
    if (u.href !== '${KMONG_ACCOUNT_URL}' || init.method !== 'GET') throw Error('scope');
    if (h.get('cookie') !== '${KMONG_AUTH_COOKIE}=${COOKIE_VALUE}') throw Error('cookie');
    return Response.json({USERID:${OWNER_ID},email:'${EMAIL}',username:'${USERNAME}',is_mobile_auth:false,social_provider:'GOOGLE',privateField:'not-output'});
  };\n`);
  const script = path.resolve('scripts/kmong-account.mjs');
  const status = spawnSync(process.execPath, [script, 'status'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(status.status, 0, status.stdout);
  assert.equal(JSON.parse(status.stdout).credentialProvider, 'process-memory');
  assert.equal(JSON.parse(status.stdout).persistent, false);
  assert.equal(status.stdout.includes(COOKIE_VALUE), false);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, script, 'session-import', '--memory'], {
    input: JSON.stringify(importInput()), encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.persistent, false);
  assert.equal(output.credentialProvider, 'process-memory');
  for (const secret of [COOKIE_VALUE, EMAIL, USERNAME, 'privateField']) assert.equal(result.stdout.includes(secret), false);
  const invalidSecret = 'rejected-google-credential-never-output';
  const rejected = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, script, 'session-import', '--memory'], {
    input: JSON.stringify({ ...importInput(), googlePassword: invalidSecret }), encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(rejected.status, 2);
  assert.equal(JSON.parse(rejected.stdout).code, 'KMONG_AUTH_IMPORT_INVALID');
  assert.equal(rejected.stdout.includes(invalidSecret), false);
});

test('persistent CLI import is verified before storage and a fresh process health reuses the task-owned store', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kmong-account-dpapi-style-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hook = path.join(directory, 'mock-fetch.mjs');
  await writeFile(hook, `globalThis.fetch = async (url, init) => {
    const u = new URL(url), h = new Headers(init.headers);
    if (u.href !== '${KMONG_ACCOUNT_URL}' || init.method !== 'GET') throw Error('scope');
    if (h.get('cookie') !== '${KMONG_AUTH_COOKIE}=${COOKIE_VALUE}') throw Error('cookie');
    return Response.json({USERID:${OWNER_ID},email:'${EMAIL}',username:'${USERNAME}',is_mobile_auth:false,social_provider:'GOOGLE'});
  };\n`);
  const script = path.resolve('scripts/kmong-account.mjs');
  const env = { ...process.env, PROTECTED_STORE_PROVIDER: 'file', PROTECTED_STORE_KEY: Buffer.alloc(32, 7).toString('base64') };
  const imported = spawnSync(process.execPath,
    ['--import', pathToFileURL(hook).href, script, 'session-import', '--persist', `--store-dir=${directory}`],
    { input: JSON.stringify(importInput()), encoding: 'utf8', timeout: 15_000, env });
  assert.equal(imported.status, 0, imported.stdout);
  assert.equal(JSON.parse(imported.stdout).persistent, true);

  const health = spawnSync(process.execPath,
    ['--import', pathToFileURL(hook).href, script, 'health', `--store-dir=${directory}`],
    { encoding: 'utf8', timeout: 15_000, env });
  assert.equal(health.status, 0, health.stdout);
  const output = JSON.parse(health.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.ownerVerified, true);
  assert.equal(output.persistent, true);
  for (const secret of [COOKIE_VALUE, EMAIL, USERNAME]) assert.equal(health.stdout.includes(secret), false);
  const storedFile = path.join(directory, `${KMONG_ACCOUNT_STORE}.sealed`);
  const sealed = await readFile(storedFile, 'utf8');
  assert.equal(sealed.includes(COOKIE_VALUE), false);
  assert.equal(sealed.includes(EMAIL), false);
});
