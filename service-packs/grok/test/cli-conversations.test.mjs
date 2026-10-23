import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const cliPath = path.resolve('src/cli.mjs');

function runCli(args, packet = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: path.dirname(cliPath),
    input: JSON.stringify(packet),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

test('conversation CLI requires an explicit target for owner-scoped update and delete', () => {
  const packet = { sessionBundle: {}, expectedIdentity: 'test@example.invalid', input: {} };
  const update = runCli(['conversation', 'update', '--session-stdin', '--confirm', '--intent-id', 'rename-once'], packet);
  assert.equal(update.status, 1);
  assert.match(update.stderr, /CLI_CONVERSATION_TARGET_INVALID/);

  const remove = runCli(['conversation', 'delete', '--session-stdin', '--confirm', '--intent-id', 'delete-once'], packet);
  assert.equal(remove.status, 1);
  assert.match(remove.stderr, /CLI_CONVERSATION_TARGET_INVALID/);
});

test('conversation CLI requires explicit confirmation and stable intent before reading mutation input', () => {
  const missingConfirm = runCli(['conversation', 'delete', 'conversation-example-0123456789', '--session-stdin', '--intent-id', 'delete-once']);
  assert.equal(missingConfirm.status, 1);
  assert.match(missingConfirm.stderr, /CLI_CONVERSATION_MUTATION_OPTIONS_REQUIRED/);

  const missingIntent = runCli(['conversation', 'update', 'conversation-example-0123456789', '--session-stdin', '--confirm']);
  assert.equal(missingIntent.status, 1);
  assert.match(missingIntent.stderr, /CLI_CONVERSATION_MUTATION_OPTIONS_REQUIRED/);
});

test('conversation delete accepts the one-time first-live source permit before session preflight', () => {
  const packet = { sessionBundle: {}, expectedIdentity: 'test@example.invalid', input: {} };
  const result = runCli([
    'conversation', 'delete', 'conversation-example-0123456789', '--session-stdin', '--confirm',
    '--intent-id', 'task-cleanup-once', '--first-live-source-permit',
  ], packet);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /CLI_CONVERSATION_OPTIONS_INVALID/);
});

test('conversation create accepts the one-time first-live source permit before session preflight', () => {
  const packet = { sessionBundle: {}, expectedIdentity: 'test@example.invalid', input: { body: { systemPromptName: '', temporary: false } } };
  const result = runCli([
    'conversation', 'create', '--session-stdin', '--confirm', '--intent-id', 'task-create-once',
    '--first-live-source-permit',
  ], packet);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /CLI_CONVERSATION_OPTIONS_INVALID/);
});

test('conversation CLI rejects confirmation flags on read-only commands', () => {
  const result = runCli(['conversation', 'list', '--session-stdin', '--confirm', '--intent-id', 'not-a-write']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLI_CONVERSATION_OPTIONS_INVALID/);
});

test('restore CLI requires an explicit target and confirmation before session acquisition', () => {
  const missingTarget = runCli(['conversation', 'restore', '--session-stdin', '--confirm', '--intent-id', 'restore-once'],
    { sessionBundle: {}, expectedIdentity: 'test@example.invalid', input: {} });
  assert.equal(missingTarget.status, 1);
  assert.match(missingTarget.stderr, /CLI_CONVERSATION_TARGET_INVALID/);
  const missingConfirm = runCli(['conversation', 'restore', 'conversation-example-0123456789',
    '--session-stdin', '--intent-id', 'restore-once']);
  assert.equal(missingConfirm.status, 1);
  assert.match(missingConfirm.stderr, /CLI_CONVERSATION_MUTATION_OPTIONS_REQUIRED/);
});

test('conversation list-pages is an explicit read-only CLI command', () => {
  const result = runCli(['conversation', 'list-pages', '--session-stdin'], {
    sessionBundle: {}, expectedIdentity: 'test@example.invalid', input: { pageSize: 20 },
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /CLI_CONVERSATION_COMMAND_INVALID/);
});
