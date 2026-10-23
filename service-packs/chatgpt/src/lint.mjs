import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
for (const directory of ['src', 'tests']) {
  const folder = path.join(root, directory);
  let names;
  try { names = await readdir(folder, { withFileTypes: true }); }
  catch { continue; }
  for (const item of names) {
    if (item.isFile() && item.name.endsWith('.mjs') && item.name !== 'lint.mjs') files.push(path.join(folder, item.name));
  }
}
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(JSON.stringify({ lint: 'passed', files: files.length, checker: 'node --check' }));
