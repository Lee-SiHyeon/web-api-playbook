import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ProtectedStore } from '../lib/protected-store.mjs';
import { createInpockAuth } from '../lib/web-auth/inpock.mjs';

const API = 'https://link-rest.inpock.co.kr';
const PASSWORD = 'sentinel-password-not-real';
const TOKEN = 'sentinel-token-not-real';
const login = { username: 'owner_test', password: PASSWORD };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
});
const user = () => ({ id: 42, username: login.username, plan: 'FREE', email: 'private@example.invalid', phone: 'private-phone' });

async function harness(t, routes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpock-auth-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ProtectedStore({ directory, provider: 'memory' });
  const calls = [];
  const fetchImpl = async (url, init) => {
    const headers = new Headers(init.headers);
    const form = init.body ? Object.fromEntries(await new Request(url, init).formData()) : null;
    const call = { path: new URL(url).pathname, origin: new URL(url).origin, method: init.method, headers, form };
    calls.push(call);
    return routes(call);
  };
  const auth = createInpockAuth({ store, fetchImpl });
  await auth.importLogin({ ...login });
  return { store, auth, calls, directory };
}
const standard = ({ path: route }) => route === '/login' ? json({ username: login.username, token: TOKEN }, 201) : json(user());

test('password acquisition is multipart, token-only owner read is scoped, and receipts omit secrets and contact fields', async t => {
  const h = await harness(t, standard);
  const receipt = await h.auth.login();
  assert.equal(receipt.authenticated, true);
  assert.equal(receipt.ownerVerified, true);
  assert.equal(receipt.renewal, 'password_login');
  assert.equal(receipt.loginReceipt.httpStatus, 201);
  assert.deepEqual(receipt.user, { username: login.username, plan: 'FREE' });
  assert.deepEqual(h.calls.map(c => [c.method, c.path]), [['POST', '/login'], ['GET', '/v2/users']]);
  assert.deepEqual(h.calls[0].form, login);
  assert.match(h.calls[0].headers.get('content-type'), /^multipart\/form-data; boundary=/);
  assert.equal(h.calls[0].headers.get('cookie'), null);
  assert.equal(h.calls[1].headers.get('cookie'), 'token=' + TOKEN);
  assert.equal(h.calls[1].headers.get('authorization'), null);
  for (const secret of [PASSWORD, TOKEN, 'private@example.invalid', 'private-phone']) assert.equal(JSON.stringify(receipt).includes(secret), false);
  assert.equal(h.auth.status().session.provider, 'process-memory');
  assert.equal(h.auth.status().session.persistent, false);
  assert.equal(h.auth.status().authenticated, false);
  const cookie = JSON.parse(h.store.read('inpock-state')).session.cookieJar.cookies[0];
  assert.equal(cookie.hostOnly, true);
  assert.equal(cookie.domain, new URL(API).hostname);
  assert.deepEqual(await fs.readdir(h.directory), ['locks']);
});

test('a verified stored session is reused without posting the password again', async t => {
  const h = await harness(t, standard);
  await h.auth.login();
  const result = await h.auth.ensure();
  assert.equal(result.renewal, 'stored_session');
  assert.equal(h.calls.filter(c => c.path === '/login').length, 1);
  assert.equal(h.calls.filter(c => c.path === '/v2/users').length, 2);
});

test('wrong owner after a fresh login preserves the prior trusted session and never reports success', async t => {
  let wrong = false;
  const h = await harness(t, call => wrong
    ? call.path === '/login' ? json({ username: login.username, token: 'wrong-token' }, 201) : json({ ...user(), username: 'someone_else' })
    : standard(call));
  await h.auth.login();
  const before = h.store.read('inpock-state');
  wrong = true;
  await assert.rejects(h.auth.login(), { code: 'OWNER_MISMATCH' });
  assert.equal(h.store.read('inpock-state'), before);
});

test('login HTML and malformed JSON cannot establish authentication', async t => {
  for (const response of [
    () => new Response('<html>Login</html>', { status: 201, headers: { 'content-type': 'text/html' } }),
    () => new Response('{broken', { status: 201, headers: { 'content-type': 'application/json' } }),
    () => json({ username: login.username }, 201),
  ]) {
    const h = await harness(t, response);
    await assert.rejects(h.auth.login(), { code: 'AUTH_RESPONSE_INVALID' });
    assert.equal(h.store.status('inpock-state').available, false);
    assert.equal(h.calls.length, 1);
  }
});

test('health never acquires a missing session, and absent credentials never issue an HTTP request', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpock-empty-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const auth = createInpockAuth({ store: new ProtectedStore({ provider: 'memory', directory }), fetchImpl: async () => { calls++; } });
  await assert.rejects(auth.health(), { code: 'SESSION_MISSING' });
  await assert.rejects(auth.ensure(), { code: 'LOGIN_INPUT_MISSING' });
  assert.equal(calls, 0);
});

test('one server 401 permits one password reacquisition and a new owner verification', async t => {
  let rejectOld = false;
  const h = await harness(t, call => {
    if (call.path === '/login') return json({ username: login.username, token: rejectOld ? 'renewed-token' : TOKEN }, 201);
    if (rejectOld && call.headers.get('cookie') === 'token=' + TOKEN) return json({ detail: 'Not authenticated' }, 401);
    return json(user());
  });
  await h.auth.login();
  rejectOld = true;
  const result = await h.auth.ensure();
  assert.equal(result.reason, 'server_rejected_session');
  assert.equal(result.ownerVerified, true);
  assert.deepEqual(h.calls.slice(2).map(c => [c.method, c.path]), [['GET', '/v2/users'], ['POST', '/login'], ['GET', '/v2/users']]);
});

test('forbidden, throttled, server errors and transport errors never trigger password retries', async t => {
  for (const [status, code] of [[403, 'AUTH_FORBIDDEN'], [429, 'AUTH_THROTTLED'], [503, 'AUTH_SERVER_ERROR'], [null, 'AUTH_TRANSPORT_FAILED']]) {
    let failure = false;
    const h = await harness(t, call => {
      if (!failure) return standard(call);
      if (status === null) throw new Error('private transport diagnostics');
      return json({ detail: 'unknown' }, status);
    });
    await h.auth.login();
    failure = true;
    await assert.rejects(h.auth.ensure(), { code });
    assert.equal(h.calls.filter(c => c.path === '/login').length, 1);
  }
});

test('password renewal cannot change the owner ID for the same username', async t => {
  let renewing = false;
  const h = await harness(t, call => {
    if (!renewing) return standard(call);
    if (call.path === '/login') return json({ username: login.username, token: 'renewed-token' }, 201);
    if (call.headers.get('cookie') === 'token=' + TOKEN) return json({ detail: 'Not authenticated' }, 401);
    return json({ ...user(), id: 43 });
  });
  await h.auth.login();
  renewing = true;
  await assert.rejects(h.auth.ensure(), { code: 'OWNER_MISMATCH' });
  const saved = JSON.parse(h.store.read('inpock-state'));
  assert.equal(saved.ownerId, 42);
  assert.equal(saved.session.cookieJar.cookies.find(c => c.key === 'token').value, TOKEN);
});

test('health rejects a configured account switch without acquiring a new session', async t => {
  const h = await harness(t, standard);
  await h.auth.login();
  await h.auth.importLogin({ username: 'another_owner', password: PASSWORD });
  const count = h.calls.length;
  await assert.rejects(h.auth.health(), { code: 'CONFIGURED_OWNER_MISMATCH' });
  assert.equal(h.calls.length, count);
});

test('a response deleting the token invalidates the saved session even with HTTP 200', async t => {
  let deleting = false;
  const h = await harness(t, call => deleting ? json(user(), 200, { 'set-cookie': 'token=; Max-Age=0; Path=/; Secure' }) : standard(call));
  await h.auth.login();
  deleting = true;
  await assert.rejects(h.auth.health(), { code: 'REAUTH_REQUIRED' });
  const calls = h.calls.length;
  await assert.rejects(h.auth.health(), { code: 'REAUTH_REQUIRED' });
  assert.equal(h.calls.length, calls);
  assert.equal(JSON.parse(h.store.read('inpock-state')).verified, false);
});

test('a redirected login is not replayed and no credentials are sent to another origin', async t => {
  const h = await harness(t, () => new Response(null, { status: 307, headers: { location: 'https://outside.example.invalid/login' } }));
  await assert.rejects(h.auth.login(), { code: 'AUTH_OUTCOME_UNKNOWN' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].origin, API);
});

test('changed origin scope and changed owner IDs are rejected before trust is renewed', async t => {
  let wrongId = false;
  const h = await harness(t, call => wrongId ? json({ ...user(), id: 43 }) : standard(call));
  await h.auth.login();
  wrongId = true;
  await assert.rejects(h.auth.health(), { code: 'OWNER_MISMATCH' });
  const state = JSON.parse(h.store.read('inpock-state'));
  state.session.allowedOrigins.push('https://outside.example.invalid');
  h.store.write('inpock-state', JSON.stringify(state));
  const calls = h.calls.length;
  await assert.rejects(h.auth.health(), { code: 'AUTH_STATE_INVALID' });
  assert.equal(h.calls.length, calls);
});

test('callback transport rejects unapproved origins before sending the token', async t => {
  const h = await harness(t, standard);
  await assert.rejects(h.auth.withSession(session => session.request('https://outside.example.invalid/data')), /SCOPED_SESSION_/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls.every(c => c.origin === API), true);
});

test('the real CLI consumes credentials on stdin and exposes only a sanitized receipt', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpock-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const hook = path.join(directory, 'mock-fetch.mjs');
  await fs.writeFile(hook, `globalThis.fetch = async (url, init) => {
    const u = new URL(url), h = new Headers(init.headers);
    if (u.origin !== 'https://link-rest.inpock.co.kr') throw Error('scope');
    if (u.pathname === '/login') {
      const form = Object.fromEntries(await new Request(url, init).formData());
      if (form.username !== 'owner_test' || form.password !== 'sentinel-password-not-real' || Object.keys(form).length !== 2) throw Error('input');
      return Response.json({username: form.username, token: 'sentinel-token-not-real'}, {status: 201});
    }
    if (u.pathname !== '/v2/users' || h.get('cookie') !== 'token=sentinel-token-not-real') throw Error('consumer');
    return Response.json({id: 42, username: 'owner_test', email: 'private@example.invalid'});
  };\n`);
  const result = spawnSync(process.execPath, ['--import', hook, 'scripts/inpock.mjs', 'ensure', '--credentials-stdin'], {
    input: JSON.stringify(login), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stderr, '');
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ownerVerified, true);
  assert.equal(receipt.credentialProvider, 'process-memory');
  assert.equal(receipt.persistent, false);
  assert.equal(result.stdout.includes(PASSWORD), false);
  assert.equal(result.stdout.includes(TOKEN), false);
  const invalid = spawnSync(process.execPath, ['--import', hook, 'scripts/inpock.mjs', 'ensure', '--credentials-stdin'], {
    input: JSON.stringify({ ...login, unrelatedSecret: 'not-for-this-service' }), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).code, 'LOGIN_INPUT_INVALID');
});
