import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ProtectedStore, FILE_PROVIDER_LABEL } from '../lib/protected-store.mjs';

test('file provider seals values at rest with 0600 files and name-bound AES-GCM', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pstore-'));
  const prev = process.env.PROTECTED_STORE_KEY;
  process.env.PROTECTED_STORE_KEY = randomBytes(32).toString('base64');
  try {
    const store = new ProtectedStore({ provider: 'file', directory: dir });
    assert.equal(store.read('x-web-state'), null);
    assert.deepEqual(store.status('x-web-state'), { available: false, provider: FILE_PROVIDER_LABEL, persistent: true });
    const value = JSON.stringify({ secret: 'plain-marker-123' });
    assert.deepEqual(store.write('x-web-state', value), { stored: true, provider: FILE_PROVIDER_LABEL, persistent: true });
    const file = path.join(dir, 'x-web-state.sealed');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!readFileSync(file, 'utf8').includes('plain-marker-123'));
    assert.equal(store.read('x-web-state'), value);
    assert.equal(new ProtectedStore({ provider: 'file', directory: dir }).status('x-web-state').available, true);
    writeFileSync(path.join(dir, 'other.sealed'), readFileSync(file, 'utf8'));
    assert.throws(() => store.read('other'), { code: 'PROTECTED_STORE_READ_FAILED' });
    process.env.PROTECTED_STORE_KEY = randomBytes(32).toString('base64');
    assert.throws(() => store.read('x-web-state'), { code: 'PROTECTED_STORE_READ_FAILED' });
  } finally {
    if (prev === undefined) delete process.env.PROTECTED_STORE_KEY; else process.env.PROTECTED_STORE_KEY = prev;
  }
});

test('non-Windows default still requires an explicit provider', { skip: process.platform === 'win32' }, () => {
  const prev = process.env.PROTECTED_STORE_PROVIDER;
  delete process.env.PROTECTED_STORE_PROVIDER;
  try { assert.throws(() => new ProtectedStore(), { code: 'PROTECTED_STORE_PROVIDER_REQUIRED' }); }
  finally { if (prev !== undefined) process.env.PROTECTED_STORE_PROVIDER = prev; }
});
