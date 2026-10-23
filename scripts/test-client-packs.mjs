import { spawn } from 'node:child_process';
import { glob, readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientPacks, resolveClientPack } from '../lib/client-packs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args.length === 1 && !/^--service=[a-z][a-z0-9-]*$/.test(args[0])) throw Error('CLIENT_TEST_ARGUMENT_INVALID');
const selected = args[0]?.slice('--service='.length);
const all = await clientPacks();
const scratch = process.env.TMPDIR || path.join(homedir(), '.nad-scratch', 'tmp');
await mkdir(scratch, { recursive: true });
if (selected && !all.some(client => client.id === selected)) throw Error('CLIENT_PACK_UNKNOWN');
let failed = false, tested = 0;
for (const client of all.filter(client => !selected || client.id === selected)) {
  if (!client.testManifest && !client.testGlobs?.length) continue;
  const { directory } = await resolveClientPack(client.id);
  const files = new Set();
  for (const pattern of client.testGlobs ?? []) for await (const file of glob(pattern, { cwd: directory })) files.add(file);
  if (client.testManifest) {
    const manifest = JSON.parse(await readFile(path.join(root, client.testManifest), 'utf8'));
    for (const file of manifest.testFiles) {
      if (typeof file !== 'string' || file.startsWith('/') || file.split('/').includes('..')) throw Error('CLIENT_TEST_SCOPE');
      files.add(file);
    }
  }
  if (!files.size) throw Error('CLIENT_TEST_FILES_MISSING');
  process.stdout.write(JSON.stringify({ client: client.id, testFiles: files.size, networkScope: 'original offline fixtures' }) + '\n');
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'COMSPEC']
    .filter(name => typeof process.env[name] === 'string').map(name => [name, process.env[name]]));
  env.TMPDIR = scratch;
  const exit = await new Promise(resolve => {
    const child = spawn(process.execPath, [...(client.testNodeArgs ?? []), '--test', '--test-reporter=spec', ...[...files].sort()],
      { cwd: directory, env, stdio: 'inherit', shell: false });
    child.once('error', () => resolve(1)); child.once('close', code => resolve(code ?? 1));
  });
  tested++; failed ||= exit !== 0;
}
if (!tested && selected) throw Error('CLIENT_TESTS_NOT_PROVIDED');
process.stdout.write(JSON.stringify({ testedPacks: tested, ok: !failed, liveServiceVerification: false }) + '\n');
process.exitCode = failed ? 1 : 0;
