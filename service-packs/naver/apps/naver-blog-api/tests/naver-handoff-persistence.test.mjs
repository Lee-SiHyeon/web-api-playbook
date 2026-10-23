import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { persistVerifiedNaverHandoff } from '../scripts/naver-handoff-persistence.mjs';

const actor = 'aicandoanything';
const observedUserAgent = 'SyntheticBrowser/1.0';
const cookies = [{ name: 'NID_AUT', value: 'fixture-aut', domain: '.naver.com', path: '/', secure: true, expires: -1 }];
const verifiedProof = Object.freeze({ actor, verified: true, actorMatched: true, adminShell: true, userAgentApplied: true });

function harness(options = {}) {
  const proof = Object.hasOwn(options, 'proof') ? options.proof : verifiedProof;
  const { stored = true, persistError = null, lockError = null, lockResult = 'release',
    controlResult = { stored: true }, controlError = null } = options;
  const events = [];
  let clientOptions;
  const dependencies = {
    acquireSessionLock: async () => {
      events.push('acquire-lock');
      if (lockError) throw lockError;
      if (lockResult === 'release') return () => events.push('release-lock');
      return lockResult;
    },
    createSessionClient: options => {
      events.push('create-client');
      clientOptions = options;
      return {
        persistVerifiedSession: async () => {
          events.push('persist-session');
          if (persistError) throw persistError;
          return { stored, verification: proof };
        },
        clear: () => events.push('clear-client'),
      };
    },
    recordLoginSuccess: async () => {
      events.push('record-login-success');
      if (controlError) throw controlError;
      return controlResult;
    },
  };
  return { events, dependencies, getClientOptions: () => clientOptions };
}

const persist = (dependencies, options = {}) => persistVerifiedNaverHandoff({
  cookies, userAgent: observedUserAgent, ...dependencies, ...options,
});

test('verified handoff holds shared lock through owner proof, session save, and success-control write', async () => {
  const fake = harness();
  const receipt = await persist(fake.dependencies);

  assert.deepEqual(fake.events, [
    'acquire-lock', 'create-client', 'persist-session', 'record-login-success', 'clear-client', 'release-lock',
  ]);
  assert.equal(fake.getClientOptions().ownerBlogId, actor);
  assert.equal(fake.getClientOptions().persistRotation, false);
  assert.deepEqual(fake.getClientOptions().defaultHeaders, { 'user-agent': observedUserAgent });
  assert.deepEqual(receipt, { stored: true, protectedOwnerRead: true, loginControlStored: true });
});

test('owner mismatch, missing proof, or an unapplied observed UA never clears account protection', async t => {
  const cases = [
    ['unverified owner', { ...verifiedProof, verified: false }],
    ['wrong actor', { ...verifiedProof, actor: 'other-account' }],
    ['actor mismatch', { ...verifiedProof, actorMatched: false }],
    ['missing admin shell', { ...verifiedProof, adminShell: false }],
    ['UA not applied', { ...verifiedProof, userAgentApplied: false }, 'HANDOFF_USER_AGENT_UNVERIFIED'],
    ['missing verification report', undefined],
  ];
  for (const [name, proof, expectedCode = 'HANDOFF_OWNER_UNVERIFIED'] of cases) await t.test(name, async () => {
    const fake = harness({ proof });
    await assert.rejects(persist(fake.dependencies), { code: expectedCode, message: expectedCode });
    assert.deepEqual(fake.events, ['acquire-lock', 'create-client', 'persist-session', 'clear-client', 'release-lock']);
  });
});

test('missing or invalid user agent fails before lock, owner read, or storage', async t => {
  for (const [name, userAgent, expected] of [
    ['missing', undefined, 'HANDOFF_USER_AGENT_REQUIRED'],
    ['invalid', 'bad\nheader', 'HANDOFF_USER_AGENT_INVALID'],
  ]) await t.test(name, async () => {
    const fake = harness();
    await assert.rejects(persist(fake.dependencies, { userAgent }), { code: expected, message: expected });
    assert.deepEqual(fake.events, []);
  });
});

test('lock failure or absent release handle stops before constructing the session client', async t => {
  await t.test('lock acquisition error', async () => {
    const fake = harness({ lockError: Object.assign(new Error('NAVER_SESSION_BUSY'), { code: 'NAVER_SESSION_BUSY' }) });
    await assert.rejects(persist(fake.dependencies), { code: 'NAVER_SESSION_BUSY', message: 'NAVER_SESSION_BUSY' });
    assert.deepEqual(fake.events, ['acquire-lock']);
  });
  await t.test('no lock release handle', async () => {
    const fake = harness({ lockResult: null });
    await assert.rejects(persist(fake.dependencies), {
      code: 'NAVER_SESSION_LOCK_NOT_ACQUIRED', message: 'NAVER_SESSION_LOCK_NOT_ACQUIRED',
    });
    assert.deepEqual(fake.events, ['acquire-lock']);
  });
});

test('session-store failure or a safe owner-read error releases lock without success-control write', async t => {
  for (const [name, settings, expected] of [
    ['store not confirmed', { stored: false }, 'HANDOFF_CREDENTIAL_STORE_UNVERIFIED'],
    ['protected owner read rejected', { persistError: Object.assign(new Error('AUTH_UNVERIFIED'), { code: 'AUTH_UNVERIFIED' }) }, 'AUTH_UNVERIFIED'],
  ]) await t.test(name, async () => {
    const fake = harness(settings);
    await assert.rejects(persist(fake.dependencies), { code: expected, message: expected });
    assert.deepEqual(fake.events, ['acquire-lock', 'create-client', 'persist-session', 'clear-client', 'release-lock']);
  });
});

test('success-control persistence failure is reported without hiding the saved owner-verified session', async () => {
  const fake = harness({ controlError: new Error('private low-level failure') });
  const receipt = await persist(fake.dependencies);
  assert.deepEqual(receipt, { stored: true, protectedOwnerRead: true,
    loginControlStored: false, code: 'LOGIN_CONTROL_STORE_FAILED' });
  assert.deepEqual(fake.events, [
    'acquire-lock', 'create-client', 'persist-session', 'record-login-success', 'clear-client', 'release-lock',
  ]);
  assert.doesNotMatch(JSON.stringify(receipt), /private low-level failure/);
});

test('both encrypted-handoff ingress paths use the verification gate, with no direct cookie-store bypass', async () => {
  const source = await readFile(new URL('../tools/discovery/naver-encrypted-handoff.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/persistVerifiedNaverHandoff\(/g) || []).length, 2);
  assert.doesNotMatch(source, /storeNaverCookies\s*\(/);
});
