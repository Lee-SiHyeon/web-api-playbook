import assert from 'node:assert/strict';
import { execPath } from 'node:process';
import { test } from 'node:test';
import { runNativeHelperProcess } from '../src/native-helper-process.mjs';

test('native helper closes unused stdin and the child observes EOF', () => {
  const source = "process.stdin.once('end', () => process.stdout.write('EOF')); process.stdin.resume();";
  assert.equal(runNativeHelperProcess(execPath, ['-e', source], { timeoutMs: 2_000 }), 'EOF');
});

test('native helper writes input then closes the pipe at EOF', () => {
  const source = "let value = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => process.stdout.write(String(value.length)));";
  assert.equal(runNativeHelperProcess(execPath, ['-e', source], { input: 'disposable-pipe-probe', timeoutMs: 2_000 }), '21');
});

test('native helper reports nonzero child exit separately from launch failure', () => {
  const source = "process.stderr.write('CREDENTIAL_STORE_FAILED:test:InvalidOperationException:EXPECTED_FAILURE\\n'); process.exit(7);";
  assert.throws(() => runNativeHelperProcess(execPath, ['-e', source], { timeoutMs: 2_000 }), (error) => {
    assert.equal(error.code, 'NATIVE_HELPER_EXIT');
    assert.equal(error.providerCause, 'HELPER_EXIT');
    assert.equal(error.exitStatus, 7);
    assert.match(error.stderr, /CREDENTIAL_STORE_FAILED:test:InvalidOperationException:EXPECTED_FAILURE/);
    return true;
  });
});

test('native helper timeout terminates a hung child within its configured bound', () => {
  const source = 'setInterval(() => {}, 1_000);';
  const started = Date.now();
  assert.throws(() => runNativeHelperProcess(execPath, ['-e', source], { timeoutMs: 150 }), (error) => {
    assert.equal(error.code, 'NATIVE_HELPER_TIMEOUT');
    assert.equal(error.providerCause, 'ETIMEDOUT');
    return true;
  });
  assert.ok(Date.now() - started < 3_000, 'timeout should not wait for the previous 60-second helper limit');
});

