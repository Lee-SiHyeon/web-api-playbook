import test from 'node:test';
import assert from 'node:assert/strict';
import { readWindowsJevKey, jevSecretPath } from '../workflows/affiliate-content-e2e/jev-auth.mjs';

test('unsupported host or absent local store does not start a credential subprocess', () => {
  const execute = () => assert.fail('Must not read a credential');
  assert.equal(readWindowsJevKey({ platform: 'linux', execute }), '');
  assert.equal(readWindowsJevKey({ platform: 'win32', exists: () => false, execute }), '');
});

test('DPAPI loader captures the key privately, without a plaintext argv or environment', () => {
  const secret = 'fixture-only-key-not-real';
  const sentinel = 'unrelated-process-secret-sentinel';
  const previous = process.env.JEV_TEST_SECRET_SENTINEL;
  process.env.JEV_TEST_SECRET_SENTINEL = sentinel;
  try {
    const value = readWindowsJevKey({
      platform: 'win32', filename: 'C:/fixture/key.dpapi', exists: () => true,
      execute(command, args, options) {
        assert.equal(command, 'powershell.exe');
        assert.equal(JSON.stringify(args).includes(secret), false);
        assert.equal(JSON.stringify(options.env).includes(secret), false);
        assert.equal(JSON.stringify(options.env).includes(sentinel), false);
        assert.equal(options.env.JEV_LOCAL_SECRET_PATH, 'C:/fixture/key.dpapi');
        assert.equal(Object.keys(options.env).some(name => name.toLowerCase() === 'psmodulepath'), false);
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
        assert.equal(options.windowsHide, true);
        return secret;
      },
    });
    assert.equal(value, secret);
  } finally {
    if (previous === undefined) delete process.env.JEV_TEST_SECRET_SENTINEL;
    else process.env.JEV_TEST_SECRET_SENTINEL = previous;
  }
});

test('decryption failure is redacted and not interpreted as an authenticated key', () => {
  assert.throws(() => readWindowsJevKey({
    platform: 'win32', exists: () => true,
    execute() { throw new Error('secret stderr must not escape'); },
  }), error => error.message === 'JEV_LOCAL_SECRET_UNREADABLE' && error.cause === undefined);
});

test('Vercel and TypeSafe keys have separate stores and unknown providers are rejected', () => {
  assert.notEqual(jevSecretPath('C:/fixture', 'vercel'), jevSecretPath('C:/fixture', 'typesafe'));
  assert.throws(() => jevSecretPath('C:/fixture', '../other'), /PROVIDER_INVALID/);
});
