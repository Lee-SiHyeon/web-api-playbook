import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const NODE = process.execPath;

test('conversation file CLI rejects invalid source operations and packet shapes before network use', () => {
  const invalidOperation = spawnSync(NODE, ['src/cli.mjs', 'conversation-files', 'unknown', '--session-stdin'], {
    encoding: 'utf8', env: {}, input: '{}',
  });
  assert.equal(invalidOperation.status, 1);
  assert.equal(invalidOperation.stdout, '');
  assert.match(invalidOperation.stderr, /CLI_CONVERSATION_FILES_COMMAND_INVALID/);

  const invalidPacket = spawnSync(NODE, ['src/cli.mjs', 'conversation-files', 'list', '--session-stdin'], {
    encoding: 'utf8', env: {}, input: '{}',
  });
  assert.equal(invalidPacket.status, 1);
  assert.equal(invalidPacket.stdout, '');
  assert.match(invalidPacket.stderr, /CLI_CONVERSATION_FILES_PACKET_INVALID/);
});
