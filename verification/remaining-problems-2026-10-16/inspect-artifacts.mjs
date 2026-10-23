import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const listing = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8', windowsHide: true,
});
if (listing.status !== 0) throw new Error('GIT_FILE_LIST_FAILED');
const staged = spawnSync('git', ['diff', '--cached', '--name-only', '-z'], {
  cwd: root, encoding: 'utf8', windowsHide: true,
});
if (staged.status !== 0) throw new Error('GIT_STAGED_LIST_FAILED');
const files = [...new Set([...listing.stdout.split('\0'), ...staged.stdout.split('\0')].filter(Boolean))];
const bulk = new Set(['public-feed.json', 'public-feed.csv', 'ulta-common-collector.json',
  'ulta-common-collector.csv', 'shopify-storefront.json', 'shopify-storefront.csv',
  'shopify-storefront-search.json', 'shopify-storefront-search.csv']);
const concerns = [], jsonErrors = [], large = [], unrelated = [];
let artifactCount = 0;
function inspect(value, file, keyPath = '') {
  if (Array.isArray(value)) return value.forEach((item, i) => inspect(item, file, `${keyPath}[${i}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const next = keyPath ? `${keyPath}.${key}` : key;
    if (/^(?:cookie|set-cookie|authorization|password|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key)$/i.test(key)
        && typeof item === 'string' && item) concerns.push({ file, field: next, type: 'nonempty_sensitive_field' });
    inspect(item, file, next);
  }
}
for (const file of files) {
  const info = await stat(path.join(root, file));
  const artifact = /^(?:service-packs\/ontology\/)?verification\/remaining-/.test(file);
  if (!artifact) {
    if (!/^(?:lib|scripts|tests|checklists)\//.test(file)) unrelated.push({ file, bytes: info.size });
    continue;
  }
  artifactCount++;
  if (info.size > 250000 || bulk.has(path.basename(file))) {
    large.push({ file, bytes: info.size, bulkOutput: bulk.has(path.basename(file)) });
  }
  if (file.endsWith('.json')) {
    try { inspect(JSON.parse(await readFile(path.join(root, file), 'utf8')), file); }
    catch { jsonErrors.push(file); }
  }
}
console.log(JSON.stringify({ artifactCount, jsonErrors, concerns, large, unrelated }, null, 2));
if (jsonErrors.length || concerns.length) process.exitCode = 1;
