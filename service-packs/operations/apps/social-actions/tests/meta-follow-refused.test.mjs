import test from 'node:test';
import assert from 'node:assert/strict';
import { safeReceipt } from '../lib/journal.mjs';

test('journal keeps the provider rejection code, scrubbed summary and rejectedVerified, nothing else new', () => {
  const r = safeReceipt({ status: 'rejected', code: 'META_GRAPHQL_REJECTED', providerErrorCode: 1545012, providerErrorSummary: 'Not allowed',
    rejectedVerified: true, writeSent: false, mutationCount: 0, cookie: 'x', fb_dtsg: 'y' });
  assert.deepEqual(r, { status: 'rejected', code: 'META_GRAPHQL_REJECTED', providerErrorCode: 1545012, providerErrorSummary: 'Not allowed',
    rejectedVerified: true, writeSent: false, mutationCount: 0 });
});
