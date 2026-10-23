import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('model-selection CLI branch requires a session-stdin packet before any private read', () => {
  const result = spawnSync(process.execPath, [cliPath, 'model-selection', 'modes'], {
    encoding: 'utf8',
    input: '',
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'CLI_MODEL_SELECTION_SESSION_REQUIRED');
});

test('model-selection CLI branch rejects unexpected flags before reading credentials', () => {
  const result = spawnSync(process.execPath, [cliPath, 'model-selection', 'select', '--confirm'], {
    encoding: 'utf8',
    input: '',
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'CLI_MODEL_SELECTION_OPTIONS_INVALID');
});

test('model-selection text CLI requires explicit confirmation and a fresh intent before reading its envelope', () => {
  const result = spawnSync(process.execPath, [cliPath, 'model-selection', 'text', '--session-stdin'], {
    encoding: 'utf8',
    input: '',
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'CLI_MODEL_SELECTION_TEXT_OPTIONS_REQUIRED');
});

test('model-selection text CLI rejects unrecognized controls before reading credentials', () => {
  const result = spawnSync(process.execPath, [cliPath, 'model-selection', 'text', '--session-stdin', '--confirm',
    '--intent-id', 'fresh-test-intent', '--browser'], {
    encoding: 'utf8',
    input: '',
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'CLI_MODEL_SELECTION_TEXT_OPTIONS_INVALID');
});
