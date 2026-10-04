import test from 'node:test';
import assert from 'node:assert/strict';
import { safeCoupangProviderFailure } from '../scripts/coupang-partners-check.mjs';

test('provider failure preserves only bounded timeout and helper stage metadata', () => {
  const projected = safeCoupangProviderFailure({ code: 'PROTECTED_STORE_OPERATION_FAILED', detail: {
    stage: 'write-file', timedOut: true, exitStatus: null, stdout: 'synthetic-secret',
    stderr: 'synthetic-secret', input: 'synthetic-secret', cookie: 'synthetic-secret',
  } });
  assert.deepEqual(projected, { stage: 'write-file', timedOut: true, exitStatus: null });
  assert.equal(JSON.stringify(projected).includes('synthetic-secret'), false);
});

test('provider failure drops untrusted stage and exit values and ignores other errors', () => {
  assert.deepEqual(safeCoupangProviderFailure({ code: 'PROTECTED_STORE_READ_FAILED', detail: {
    stage: 'synthetic-secret=value', timedOut: 'true', exitStatus: -1,
  } }), { stage: null, timedOut: false, exitStatus: null });
  assert.equal(safeCoupangProviderFailure({ code: 'COUPANG_OWNER_BINDING_INVALID', detail: { timedOut: true } }), null);
});
