import test from 'node:test';
import assert from 'node:assert/strict';
import { STORE_NAME, status } from '../lib/web-auth/toss/client.mjs';

test('Toss contracts import without acquiring a protected credential provider', () => {
  assert.equal(STORE_NAME, 'toss-sharelink-state');
});

test('legacy Toss storage still requires an explicit provider outside Windows', {
  skip: process.platform === 'win32' ? 'Would query the real Windows credential store' : false,
}, () => {
  assert.throws(() => status(), { code: 'PROTECTED_STORE_PROVIDER_REQUIRED' });
});
