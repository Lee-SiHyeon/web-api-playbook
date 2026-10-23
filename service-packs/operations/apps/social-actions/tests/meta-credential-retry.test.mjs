import test from 'node:test';
import assert from 'node:assert/strict';
import { retryMetaCredentialOperation } from '../lib/meta-bootstrap.mjs';
const failed = code => Object.assign(new Error(code), { code });

test('one local DPAPI failure retries only that operation and never repeats the preceding request', async () => {
  let requests = 0, localWrites = 0, sleeps = 0;
  const response = { accepted: true }; requests++;
  const result = await retryMetaCredentialOperation('threads', () => {
    assert.equal(response.accepted, true);
    if (++localWrites === 1) throw failed('CREDENTIAL_STORE_FAILED');
    return { stored: true };
  }, { sleep: async ms => { assert.equal(ms, 1000); sleeps++; } });
  assert.equal(result.stored, true); assert.equal(requests, 1); assert.equal(localWrites, 2); assert.equal(sleeps, 1);
});

test('an unreadable store remains blocked after exactly two local attempts', async () => {
  let reads = 0;
  await assert.rejects(retryMetaCredentialOperation('threads', () => {
    reads++; throw failed('CREDENTIAL_STORE_UNREADABLE');
  }, { sleep: async () => {} }), { code: 'CREDENTIAL_STORE_UNREADABLE' });
  assert.equal(reads, 2);
});

test('auth, HTTP, challenge and uncertain-write errors never enter credential retries', async () => {
  for (const code of ['META_REAUTH_REQUIRED', 'META_INTERACTION_REQUIRED', 'THREADS_REPLY_HTTP_400', 'META_GRAPHQL_HTTP_429', 'META_SESSION_BUSY', 'THREADS_REPLY_NEEDS_RECONCILIATION']) {
    let calls = 0;
    await assert.rejects(retryMetaCredentialOperation('threads', () => { calls++; throw failed(code); },
      { sleep: async () => { assert.fail('noncredential errors must not wait/retry'); } }), { code });
    assert.equal(calls, 1);
  }
});

test('credential retries stay scoped to Threads and successful calls need no wait', async () => {
  let calls = 0;
  await assert.rejects(retryMetaCredentialOperation('instagram', () => { calls++; throw failed('CREDENTIAL_STORE_UNREADABLE'); }), { code: 'CREDENTIAL_STORE_UNREADABLE' });
  assert.equal(calls, 1);
  assert.equal(await retryMetaCredentialOperation('threads', () => 'ready', { sleep: async () => assert.fail() }), 'ready');
});
