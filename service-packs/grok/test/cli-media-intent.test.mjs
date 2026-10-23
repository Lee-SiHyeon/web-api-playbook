import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src', 'cli.mjs');

async function makeHome() {
  const base = path.join(homedir(), '.nad-scratch', 'tmp');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(path.join(base, 'grok-cli-media-intent-'));
  await chmod(home, 0o700);
  return home;
}

function invoke(home, packet) {
  return spawnSync(process.execPath, [CLI, 'media', 'intent-prepare', '--session-stdin'], {
    cwd: REPO,
    input: JSON.stringify(packet),
    encoding: 'utf8',
    env: {
      HOME: home,
      PATH: process.env.PATH ?? '',
      TMPDIR: process.env.TMPDIR ?? path.join(home, '.nad-scratch', 'tmp'),
      LANG: 'C.UTF-8',
    },
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

test('media intent prepare refuses an unverified caller before writing the journal', async t => {
  const home = await makeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const prompt = 'A neutral pastel scene with slow camera movement.';
  const result = invoke(home, { operation: 'media.video.create', prompt });
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.error.code, 'CLI_MEDIA_INTENT_INPUT_INVALID');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes(prompt), false);
  await assert.rejects(readFile(path.join(home, '.nad-scratch', 'grok-web-xhr-client', 'media-intents.json')),
    { code: 'ENOENT' });
});
