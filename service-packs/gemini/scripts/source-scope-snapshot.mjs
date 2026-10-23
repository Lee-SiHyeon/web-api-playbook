import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotFeatureSourceScope } from '../src/source-scope.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const featureId = process.argv[2];
  if (process.argv.length !== 3 || !/^[a-z][a-z0-9_]{0,63}$/.test(featureId ?? '')) {
    throw new Error('SOURCE_SCOPE_ARGUMENT_INVALID');
  }
  const [contract, checklist] = await Promise.all([
    readFile(path.join(ROOT, 'discovery/observed-contract.json'), 'utf8').then(JSON.parse),
    readFile(path.join(ROOT, 'discovery/feature-checklist.json'), 'utf8').then(JSON.parse),
  ]);
  const feature = checklist.features.find((item) => item.id === featureId);
  if (!feature) throw new Error('SOURCE_SCOPE_FEATURE_UNKNOWN');
  const scope = await snapshotFeatureSourceScope({
    root: ROOT,
    contract,
    featureId,
    operationNames: feature.contractOperations,
  });
  process.stdout.write(JSON.stringify(scope) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message)
      ? error.message : 'SOURCE_SCOPE_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
