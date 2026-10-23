import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as setImmediatePromise } from 'node:timers/promises';
import { createSelfProcessIdentityResolver, requireWriterIdentity, writerIdentityIsAlive } from '../lib/self-process-identity.mjs';

const VALID = `win32:${'1'.repeat(15)}`;

test('self identity uses a bounded retry after a transient unavailable probe', async () => {
  let probes = 0;
  const timeoutValues = [];
  const resolve = createSelfProcessIdentityResolver({ pidProvider: () => 71, maxAttempts: 2, retryDelayMs: 0,
    probe: async (_pid, options) => { probes++; timeoutValues.push(options.timeoutMs); return probes === 1 ? null : VALID; } });
  assert.equal(await resolve(), VALID);
  assert.equal(probes, 2);
  assert.deepEqual(timeoutValues, [15_000, 15_000]);
});

test('successful self identity is cached only for the current process PID', async () => {
  let probes = 0, pid = 71;
  const resolve = createSelfProcessIdentityResolver({ pidProvider: () => pid,
    probe: async () => { probes++; return VALID; } });
  assert.equal(await resolve(), VALID);
  assert.equal(await resolve(), VALID);
  assert.equal(probes, 1);
  pid = 72;
  assert.equal(await resolve(), null);
  assert.equal(probes, 1);
});

test('concurrent first-use checks share one in-flight self identity probe', async () => {
  let probes = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  const resolve = createSelfProcessIdentityResolver({ pidProvider: () => 71,
    probe: async () => { probes++; await ready; return VALID; } });
  const first = resolve(), second = resolve();
  await setImmediatePromise();
  release();
  assert.deepEqual(await Promise.all([first, second]), [VALID, VALID]);
  assert.equal(probes, 1);
});

test('invalid process identity output is retried and never cached', async () => {
  let probes = 0;
  const resolve = createSelfProcessIdentityResolver({ pidProvider: () => 71, maxAttempts: 2, retryDelayMs: 0,
    probe: async () => (++probes === 1 ? 'win32:not-start-time' : VALID) });
  assert.equal(await resolve(), VALID);
  assert.equal(probes, 2);
});

test('exhausted unknown identity remains fail-closed and a later call probes afresh', async () => {
  let probes = 0;
  const resolve = createSelfProcessIdentityResolver({ pidProvider: () => 71, maxAttempts: 2, retryDelayMs: 0,
    probe: async () => { probes++; return null; } });
  await assert.rejects(requireWriterIdentity(resolve), { code: 'SOCIAL_WRITER_IDENTITY_UNAVAILABLE' });
  await assert.rejects(requireWriterIdentity(resolve), { code: 'SOCIAL_WRITER_IDENTITY_UNAVAILABLE' });
  assert.equal(probes, 4);
  await assert.rejects(requireWriterIdentity(async () => 'win32:invalid'), { code: 'SOCIAL_WRITER_IDENTITY_UNAVAILABLE' });
});

test('a thrown initial identity probe is retried instead of poisoning the process cache', async () => {
  let probes = 0;
  const resolve = createSelfProcessIdentityResolver({ pidProvider: () => 71, maxAttempts: 2, retryDelayMs: 0,
    probe: async () => { probes++; if (probes === 1) throw new Error('temporary local process query failure'); return VALID; } });
  assert.equal(await resolve(), VALID);
  assert.equal(probes, 2);
});

test('self PID lookup failures fail closed without probing another PID', async () => {
  let probes = 0;
  const resolve = createSelfProcessIdentityResolver({ pidProvider: () => { throw new Error('PID unavailable'); },
    probe: async () => { probes++; return VALID; } });
  assert.equal(await resolve(), null);
  assert.equal(probes, 0);
});

test('external writer checks always use a fresh identity probe and unknown is conservatively alive', async () => {
  let probes = 0;
  const options = { processAlive: async () => true, probeIdentity: async () => (++probes === 1 ? VALID : null) };
  assert.equal(await writerIdentityIsAlive(99, VALID, options), true);
  assert.equal(await writerIdentityIsAlive(99, VALID, options), true);
  assert.equal(probes, 2);
  assert.equal(await writerIdentityIsAlive(99, VALID, { processAlive: async () => true, probeIdentity: async () => 'win32:invalid' }), true);
});

test('a confirmed PID start-time mismatch is not treated as the original writer', async () => {
  let probes = 0;
  const result = await writerIdentityIsAlive(99, VALID, {
    processAlive: async () => true, probeIdentity: async () => { probes++; return `win32:${'2'.repeat(15)}`; },
  });
  assert.equal(result, false);
  assert.equal(probes, 1);
});

test('a confirmed-dead PID skips identity lookup', async () => {
  let probes = 0;
  const result = await writerIdentityIsAlive(99, VALID, {
    processAlive: async () => false, probeIdentity: async () => { probes++; return VALID; },
  });
  assert.equal(result, false);
  assert.equal(probes, 0);
});
