import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('verified official Coupang Open API signer and deeplink client use one bounded server request', () => {
  const result = spawnSync(process.execPath, [
    '--conditions=react-server', '--import', 'tsx', 'tests/fixtures/coupang-openapi-client-regression.mjs',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: process.env.NODE_ENV ?? 'test',
      TZ: 'UTC',
    },
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
