import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseOriginalImageDownloadOptions } from '../src/cli.mjs';

test('original-image-download CLI requires one in-memory envelope and owner', () => {
  assert.deepEqual(parseOriginalImageDownloadOptions([
    '--envelope-stdin', '--expect-owner', 'owner@example.test',
  ]), {
    envelopeStdin: true,
    contractPath: new URL('../discovery/observed-contract.json', import.meta.url).pathname,
    expectedOwner: 'owner@example.test',
  });
});

test('original-image-download CLI rejects missing envelope, owner, and unrelated flags', () => {
  assert.throws(() => parseOriginalImageDownloadOptions(['--expect-owner', 'owner@example.test']), {
    code: 'ORIGINAL_IMAGE_ENVELOPE_STDIN_REQUIRED',
  });
  assert.throws(() => parseOriginalImageDownloadOptions(['--envelope-stdin']), {
    code: 'OWNER_EXPECTATION_REQUIRED',
  });
  assert.throws(() => parseOriginalImageDownloadOptions([
    '--envelope-stdin', '--expect-owner', 'owner@example.test', '--confirm',
  ]), { code: 'CLI_ARGUMENT_INVALID' });
});

test('main CLI reports a structured sanitized failure before any request input is accepted', () => {
  const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cliPath, 'original-image-download', '--expect-owner', 'owner@example.test'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.operation, 'original_image_download');
  assert.equal(output.outcome, 'needs_review');
  assert.equal(output.failureCode, 'ORIGINAL_IMAGE_ENVELOPE_STDIN_REQUIRED');
  assert.equal(output.errorClass, 'GeminiClientError');
  assert.equal(output.requestOutcome, 'not_reported');
  assert.equal(output.rawValuesPersistedOrPrinted, false);
});
