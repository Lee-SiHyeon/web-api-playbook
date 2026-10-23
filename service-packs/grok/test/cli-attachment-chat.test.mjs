import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');

function run(args, input = '{}') {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
  });
}

test('attachment chat CLI requires explicit session, confirmation, and stable intent before reading data', () => {
  const result = run(['attachment', 'attach-chat']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLI_ATTACHMENT_CHAT_OPTIONS_REQUIRED/);
  assert.doesNotMatch(result.stdout + result.stderr, /sso=|cookie|conversationId|fileAttachment/);
});

test('attachment chat CLI rejects malformed session packet before client creation', () => {
  const result = run([
    'attachment', 'attach-chat', '--session-stdin', '--confirm',
    '--intent-id', 'grok-retained-20b-attachment-chat-20261006-v1',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLI_ATTACHMENT_CHAT_PACKET_INVALID/);
  assert.doesNotMatch(result.stdout + result.stderr, /sso=|cookie|conversationId|fileAttachment/);
});
