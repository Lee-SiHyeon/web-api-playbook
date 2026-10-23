import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const cliPath = path.resolve('src/cli.mjs');

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: path.dirname(cliPath),
    input: '{}',
    encoding: 'utf8',
    timeout: 15_000,
  });
}

test('workspace CLI requires a target ID for read/update/delete', () => {
  const result = runCli(['workspace', 'delete', '--session-stdin', '--confirm', '--intent-id', 'delete-once']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLI_WORKSPACE_TARGET_INVALID/);
});

test('workspace CLI requires confirmation and a stable intent before mutation input is read', () => {
  const missingConfirm = runCli(['workspace', 'create', '--session-stdin', '--intent-id', 'create-once']);
  assert.equal(missingConfirm.status, 1);
  assert.match(missingConfirm.stderr, /CLI_WORKSPACE_MUTATION_OPTIONS_REQUIRED/);

  const missingIntent = runCli(['workspace', 'delete', 'workspace-example-0123456789', '--session-stdin', '--confirm']);
  assert.equal(missingIntent.status, 1);
  assert.match(missingIntent.stderr, /CLI_WORKSPACE_MUTATION_OPTIONS_REQUIRED/);
});

test('workspace CLI rejects mutation flags on read-only commands', () => {
  const result = runCli(['workspace', 'list', '--session-stdin', '--confirm', '--intent-id', 'not-a-write']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLI_WORKSPACE_OPTIONS_INVALID/);
});
