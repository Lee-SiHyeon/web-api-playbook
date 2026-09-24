import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateAdapterCandidate } from '../../../packages/contracts/src/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function validateTravelRegistry(record) {
  if (!record || record.schemaVersion !== 1) throw new TypeError('registry.schemaVersion must be 1');
  if (!Array.isArray(record.adapters) || record.adapters.length === 0) {
    throw new TypeError('registry.adapters must not be empty');
  }
  const ids = new Set();
  for (const adapter of record.adapters) {
    validateAdapterCandidate(adapter);
    if (ids.has(adapter.id)) throw new TypeError(`duplicate adapter id: ${adapter.id}`);
    ids.add(adapter.id);
    if (!Array.isArray(adapter.contentUseCases) || adapter.contentUseCases.length === 0) {
      throw new TypeError(`adapter ${adapter.id} must define contentUseCases`);
    }
    if (typeof adapter.nextAction !== 'string' || !adapter.nextAction.trim()) {
      throw new TypeError(`adapter ${adapter.id} must define nextAction`);
    }
    if (!Array.isArray(adapter.riskFlags)) {
      throw new TypeError(`adapter ${adapter.id} must define riskFlags`);
    }
  }
  return true;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  const target = process.argv[2] || path.join(root, 'references', 'travel-adapters.json');
  const record = JSON.parse(await readFile(target, 'utf8'));
  validateTravelRegistry(record);
  const byPriority = Object.fromEntries(
    [...new Set(record.adapters.map(item => item.priority))]
      .sort()
      .map(priority => [priority, record.adapters.filter(item => item.priority === priority).length]),
  );
  console.log(JSON.stringify({ completed: true, adapterCount: record.adapters.length, byPriority }));
}
