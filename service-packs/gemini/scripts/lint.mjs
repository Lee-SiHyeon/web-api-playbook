import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['src', 'test', 'scripts'];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(fullPath);
  }
  return files;
}

for (const target of TARGETS) {
  const directory = path.join(ROOT, target);
  const files = await collect(directory).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
process.stdout.write('JavaScript syntax checks passed.\n');
