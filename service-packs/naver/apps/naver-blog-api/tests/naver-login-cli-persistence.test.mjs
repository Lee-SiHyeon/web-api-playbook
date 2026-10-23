import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceCli = fileURLToPath(new URL('../scripts/naver-login-cli.mjs', import.meta.url));
const fixtureIdentity = JSON.stringify({ username: 'fixture-user', password: 'fixture-password' });

const stubs = {
  'naver-login-http.mjs': `
import { appendFileSync } from 'node:fs';
const log = (...event) => appendFileSync(process.env.CLI_TEST_EVENTS, JSON.stringify(event) + '\\n');
const failure = code => Object.assign(new Error('fixture failure'), { code });
export const NAVER_LOGIN_ACTOR = 'aicandoanything';
export function requestedLoginChallengeMode() { return null; }
export function validateLoginIdentity(input) {
  log('validateIdentity');
  if (!input || typeof input.username !== 'string' || !input.username.trim()
    || typeof input.password !== 'string' || !input.password) throw failure('LOGIN_IDENTITY_INVALID');
  return { username: input.username, password: input.password };
}
export async function loginWithNaverPassword(identity) {
  log('login', { usernamePresent: !!identity?.username, passwordPresent: !!identity?.password });
  const owner = process.env.CLI_TEST_OWNER === 'true';
  const receipt = { actor: NAVER_LOGIN_ACTOR, protectedOwnerRead: owner, freshAuthCookies: owner,
    loginPostCount: 1, code: owner ? null : 'AUTH_UNVERIFIED' };
  const session = {
    async persistVerifiedSession(options) {
      log('persistSession', options);
      if (process.env.CLI_TEST_SESSION_FAIL) throw failure(process.env.CLI_TEST_SESSION_FAIL);
      return { stored: true };
    },
    clear() { log('clearSession'); },
  };
  return { receipt, session };
}
`,
  'naver-login-identity.mjs': `
import { appendFileSync } from 'node:fs';
const log = (...event) => appendFileSync(process.env.CLI_TEST_EVENTS, JSON.stringify(event) + '\\n');
const failure = code => Object.assign(new Error('fixture failure'), { code });
export function loadNaverLoginIdentity() { throw failure('UNEXPECTED_IDENTITY_READ'); }
export function naverLoginIdentityReady() { return false; }
export function storeNaverLoginIdentity(identity) {
  log('storeIdentity', { usernamePresent: !!identity?.username, passwordPresent: !!identity?.password });
  if (process.env.CLI_TEST_IDENTITY_FAIL) throw failure(process.env.CLI_TEST_IDENTITY_FAIL);
  return { stored: true };
}
`,
  'naver-login-state.mjs': `
import { appendFileSync } from 'node:fs';
const log = (...event) => appendFileSync(process.env.CLI_TEST_EVENTS, JSON.stringify(event) + '\\n');
const failure = code => Object.assign(new Error('fixture failure'), { code });
export function loadLoginControl() {
  log('loadControl');
  const blocked = process.env.CLI_TEST_BLOCKED === 'true';
  return { blocked, code: blocked ? 'ACCOUNT_PROTECTION_REQUIRED' : null };
}
export function recordAccountProtection() { log('recordProtection'); return { stored: true }; }
export function acknowledgeAccountRecovery() { log('acknowledgeRecovery'); return { stored: true }; }
export function automaticReloginBlocked() { return false; }
export function recordLoginSuccess() {
  log('recordLoginSuccess');
  if (process.env.CLI_TEST_CONTROL_FAIL) throw failure(process.env.CLI_TEST_CONTROL_FAIL);
  return { stored: true };
}
`,
  'naver-session-reuse.mjs': `
export async function reuseStoredNaverSession() { throw new Error('UNEXPECTED_SESSION_REUSE'); }
`,
  'naver-session-lock.mjs': `
import { appendFileSync } from 'node:fs';
const log = (...event) => appendFileSync(process.env.CLI_TEST_EVENTS, JSON.stringify(event) + '\\n');
export async function acquireNaverSessionLock() {
  log('acquireLock');
  return () => log('releaseLock');
}
`,
};

function makeFixture(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = path.resolve(mkdtempSync(path.join(tempRoot, 'naver-login-cli-persistence-')));
  const relative = path.relative(tempRoot, root);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('TEST_FIXTURE_PATH_INVALID');
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const scripts = path.join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  const cli = path.join(scripts, 'naver-login-cli.mjs');
  copyFileSync(sourceCli, cli);
  for (const [name, contents] of Object.entries(stubs)) writeFileSync(path.join(scripts, name), contents, 'utf8');

  function run({ name, owner = true, blocked = false, sessionFailure = '', identityFailure = '', controlFailure = '', input = fixtureIdentity }) {
    const eventsPath = path.join(root, `${name}.events.jsonl`);
    writeFileSync(eventsPath, '', 'utf8');
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
      if (typeof process.env[key] === 'string') env[key] = process.env[key];
    }
    Object.assign(env, {
      TEMP: root,
      TMP: root,
      NODE_ENV: 'test',
      CLI_TEST_EVENTS: eventsPath,
      CLI_TEST_OWNER: String(owner),
      CLI_TEST_BLOCKED: String(blocked),
      CLI_TEST_SESSION_FAIL: sessionFailure,
      CLI_TEST_IDENTITY_FAIL: identityFailure,
      CLI_TEST_CONTROL_FAIL: controlFailure,
    });
    const child = spawnSync(process.execPath, [cli, '--identity-stdin', '--remember-session', '--remember-identity'], {
      cwd: root, env, input, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, `${name}: child was signaled`);
    const outputLines = child.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.ok(outputLines.length, `${name}: CLI emitted no receipt`);
    const receipt = JSON.parse(outputLines.at(-1));
    const eventBody = readFileSync(eventsPath, 'utf8');
    const events = eventBody.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    assert.doesNotMatch(child.stdout + child.stderr + eventBody, /fixture-user|fixture-password/);
    return { exitCode: child.status, receipt, events };
  }

  return { run };
}

const eventNames = events => events.map(event => event[0]);

test('fresh owner proof saves cookies, identity, and cooldown in order before cleanup', t => {
  const { run } = makeFixture(t);
  const result = run({ name: 'owner-success' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.receipt.protectedOwnerRead, true);
  assert.equal(result.receipt.sessionStored, true);
  assert.equal(result.receipt.cookiesPersisted, true);
  assert.equal(result.receipt.identityStored, true);
  assert.equal(result.receipt.loginControlStored, true);

  const names = eventNames(result.events);
  assert.deepEqual(names, ['acquireLock', 'loadControl', 'validateIdentity', 'login', 'persistSession',
    'storeIdentity', 'recordLoginSuccess', 'clearSession', 'releaseLock']);
  assert.deepEqual(result.events.find(event => event[0] === 'persistSession')[1], {
    reuseFreshOwnerVerification: true,
  });
  assert.deepEqual(result.events.find(event => event[0] === 'login')[1], {
    usernamePresent: true, passwordPresent: true,
  });
});

test('owner verification failure stores neither cookies, identity, nor cooldown', t => {
  const { run } = makeFixture(t);
  const result = run({ name: 'owner-failure', owner: false });
  assert.equal(result.exitCode, 2);
  assert.equal(result.receipt.protectedOwnerRead, false);
  assert.equal(result.receipt.code, 'AUTH_UNVERIFIED');
  assert.ok(!eventNames(result.events).some(name => ['persistSession', 'storeIdentity', 'recordLoginSuccess'].includes(name)));
  assert.ok(eventNames(result.events).includes('clearSession'));
  assert.equal(eventNames(result.events).at(-1), 'releaseLock');
});

test('session-save failure still attempts identity and cooldown and keeps its first safe code', t => {
  const { run } = makeFixture(t);
  const result = run({ name: 'session-save-failure', sessionFailure: 'CREDENTIAL_STORE_WRITE_FAILED' });
  assert.equal(result.exitCode, 2);
  assert.equal(result.receipt.code, 'CREDENTIAL_STORE_WRITE_FAILED');
  assert.equal(result.receipt.sessionStored, false);
  assert.equal(result.receipt.cookiesPersisted, false);
  assert.equal(result.receipt.identityStored, true);
  assert.equal(result.receipt.loginControlStored, true);
  assert.deepEqual(result.receipt.persistenceFailures, ['CREDENTIAL_STORE_WRITE_FAILED']);
  const names = eventNames(result.events);
  assert.deepEqual(names.slice(-5), ['persistSession', 'storeIdentity', 'recordLoginSuccess', 'clearSession', 'releaseLock']);
});

test('identity and cooldown failures preserve the first persistence code and still clean up', t => {
  const { run } = makeFixture(t);
  const result = run({ name: 'identity-and-control-failure',
    identityFailure: 'LOGIN_IDENTITY_STORE_FAILED', controlFailure: 'LOGIN_CONTROL_WRITE_FAILED' });
  assert.equal(result.exitCode, 2);
  assert.equal(result.receipt.code, 'LOGIN_IDENTITY_STORE_FAILED');
  assert.equal(result.receipt.sessionStored, true);
  assert.equal(result.receipt.identityStored, false);
  assert.equal(result.receipt.loginControlStored, false);
  assert.deepEqual(result.receipt.persistenceFailures, ['LOGIN_IDENTITY_STORE_FAILED', 'LOGIN_CONTROL_WRITE_FAILED']);
  const names = eventNames(result.events);
  assert.ok(names.indexOf('storeIdentity') < names.indexOf('recordLoginSuccess'));
  assert.deepEqual(names.slice(-3), ['recordLoginSuccess', 'clearSession', 'releaseLock']);
});

test('a cooldown-write failure becomes primary only when earlier persistence steps succeeded', t => {
  const { run } = makeFixture(t);
  const result = run({ name: 'control-only-failure', controlFailure: 'LOGIN_CONTROL_WRITE_FAILED' });
  assert.equal(result.exitCode, 2);
  assert.equal(result.receipt.code, 'LOGIN_CONTROL_WRITE_FAILED');
  assert.equal(result.receipt.sessionStored, true);
  assert.equal(result.receipt.identityStored, true);
  assert.equal(result.receipt.loginControlStored, false);
  assert.deepEqual(result.receipt.persistenceFailures, ['LOGIN_CONTROL_WRITE_FAILED']);
  assert.deepEqual(eventNames(result.events).slice(-3), ['recordLoginSuccess', 'clearSession', 'releaseLock']);
});

test('account guard and invalid stdin identity stop before any persistence or login call', t => {
  const { run } = makeFixture(t);
  const guarded = run({ name: 'guarded', blocked: true });
  assert.equal(guarded.exitCode, 2);
  assert.equal(guarded.receipt.code, 'ACCOUNT_PROTECTION_REQUIRED');
  assert.equal(guarded.receipt.loginPostCount, 0);
  assert.ok(!eventNames(guarded.events).some(name => ['validateIdentity', 'login', 'persistSession', 'storeIdentity', 'recordLoginSuccess'].includes(name)));
  assert.deepEqual(eventNames(guarded.events), ['acquireLock', 'loadControl', 'releaseLock']);

  const invalidJson = run({ name: 'invalid-json', input: '{not-json' });
  assert.equal(invalidJson.exitCode, 2);
  assert.ok(!eventNames(invalidJson.events).some(name => ['login', 'persistSession', 'storeIdentity', 'recordLoginSuccess'].includes(name)));

  const invalidIdentity = run({ name: 'invalid-identity', input: JSON.stringify({ username: 'fixture-user', password: '' }) });
  assert.equal(invalidIdentity.exitCode, 2);
  assert.equal(invalidIdentity.receipt.code, 'LOGIN_IDENTITY_INVALID');
  assert.ok(!eventNames(invalidIdentity.events).some(name => ['login', 'persistSession', 'storeIdentity', 'recordLoginSuccess'].includes(name)));
  for (const result of [invalidJson, invalidIdentity]) assert.equal(eventNames(result.events).at(-1), 'releaseLock');
});
