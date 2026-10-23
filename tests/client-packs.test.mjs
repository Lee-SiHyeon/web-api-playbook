import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clientPacks, resolveClientPack, runClientPack } from '../lib/client-packs.mjs';
import { BUNDLED_PROVIDER_REPOS } from '../scripts/check-ai-providers.mjs';
import { automationCommand } from '../service-packs/automation/scripts/cli.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the checked-in catalog resolves bundled clients without opening a provider', async () => {
  const clients = await clientPacks();
  assert.equal(new Set(clients.map(client => client.id)).size, clients.length);
  for (const id of ['gemini', 'grok', 'chatgpt', 'flow', 'google-flow-bridge', 'adpick', 'whisk']) {
    const client = await resolveClientPack(id);
    assert.ok(client.directory.startsWith(path.join(root, 'service-packs') + path.sep));
  }
  assert.match(BUNDLED_PROVIDER_REPOS.gemini, /service-packs[/\\]gemini[/\\]$/);
  assert.match(BUNDLED_PROVIDER_REPOS.grok, /service-packs[/\\]grok[/\\]$/);
  const first = await clientPacks(); first[0].id = 'mutated';
  assert.notEqual((await clientPacks())[0].id, 'mutated');
});

test('the launcher forwards literal arguments and the native exit code without a shell', async () => {
  let invocation;
  const args = ['help', 'a b;$(example)', '--caller-intent', 'literal'];
  const result = await runClientPack('gemini', args, { cwd: root, spawnImpl: (command, argv, options) => {
    invocation = { command, argv, options };
    const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 7, null)); return child;
  } });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.argv.slice(1), args);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.cwd, root);
  assert.equal(invocation.options.stdio, 'inherit');
  assert.equal(result.exitCode, 7);
});

test('unknown, library-only and pre-cancelled requests never create a child', async () => {
  const spawnImpl = () => assert.fail('no child expected');
  await assert.rejects(runClientPack('../gemini', [], { spawnImpl }), { code: 'CLIENT_PACK_UNKNOWN' });
  await assert.rejects(runClientPack('whisk', [], { spawnImpl }), { code: 'CLIENT_LIBRARY_ONLY' });
  await assert.rejects(runClientPack('gemini', [], { spawnImpl, signal: AbortSignal.abort() }), { code: 'CLIENT_ABORTED' });
});

test('automation dispatch reaches its named native CLI and refuses arbitrary paths', () => {
  assert.deepEqual(automationCommand(['partners', '--help']), { file: 'partners.mjs', args: ['--help'] });
  assert.deepEqual(automationCommand([]), { file: 'help.mjs', args: [] });
  assert.throws(() => automationCommand(['../src/partners-client.mjs']), { code: 'AUTOMATION_COMMAND_UNKNOWN' });
});

test('native help works from a different working directory containing spaces', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'playbook-client-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'caller with spaces 한글'); await mkdir(cwd);
  for (const id of ['gemini', 'google-flow', 'google-flow-bridge', 'chatgpt', 'lifehack-readers']) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/client-packs.mjs'),
      'run', '--service=' + id, '--', 'help'], { cwd, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, id + ': ' + result.stderr);
    assert.match(result.stdout, /Commands|command|client|Flow|operation/i);
  }
});
