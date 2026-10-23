import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateAdapterCandidate } from '../../../packages/contracts/src/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validProgramTypes = new Set([
  'direct_publisher_affiliate',
  'affiliate_network',
  'private_partnership',
  'private_or_network_campaign',
  'b2b_or_private_partnership',
  'supplier_portal',
  'corporate_or_b2b_partnership',
]);

export function validateDomesticTravelRegistry(record) {
  if (!record || record.schemaVersion !== 1) throw new TypeError('registry.schemaVersion must be 1');
  if (record.market !== 'KR') throw new TypeError('registry.market must be KR');
  if (!Array.isArray(record.adapters) || record.adapters.length === 0) {
    throw new TypeError('registry.adapters must not be empty');
  }
  const ids = new Set();
  for (const adapter of record.adapters) {
    validateAdapterCandidate(adapter);
    if (ids.has(adapter.id)) throw new TypeError(`duplicate adapter id: ${adapter.id}`);
    ids.add(adapter.id);
    if (!validProgramTypes.has(adapter.programType)) {
      throw new TypeError(`adapter ${adapter.id} has invalid programType`);
    }
    for (const field of ['publisherFit', 'domesticMarketFit', 'apiOnlyPotential', 'monetizationModel', 'nextAction']) {
      if (typeof adapter[field] !== 'string' || !adapter[field].trim()) {
        throw new TypeError(`adapter ${adapter.id} must define ${field}`);
      }
    }
    if (!Array.isArray(adapter.contentUseCases) || adapter.contentUseCases.length === 0) {
      throw new TypeError(`adapter ${adapter.id} must define contentUseCases`);
    }
    if (!Array.isArray(adapter.riskFlags)) {
      throw new TypeError(`adapter ${adapter.id} must define riskFlags`);
    }
    if (adapter.programType === 'supplier_portal' && adapter.priority !== 'EXCLUDE') {
      throw new TypeError(`supplier portal ${adapter.id} must be excluded from publisher workflows`);
    }
    if (adapter.observedPublicBundle) {
      if (adapter.observedPublicBundle.executable !== false) {
        throw new TypeError(`adapter ${adapter.id} public bundle evidence must remain non-executable`);
      }
      if (adapter.observedPublicBundle.credentialValuesCaptured !== false) {
        throw new TypeError(`adapter ${adapter.id} must not capture credential values`);
      }
    }
  }
  return true;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  const target = process.argv[2] || path.join(root, 'references', 'domestic-travel-adapters.json');
  const record = JSON.parse(await readFile(target, 'utf8'));
  validateDomesticTravelRegistry(record);
  const direct = record.adapters.filter(item => item.programType === 'direct_publisher_affiliate');
  console.log(JSON.stringify({
    completed: true,
    adapterCount: record.adapters.length,
    directPublisherPrograms: direct.map(item => item.id),
    p0: record.adapters.filter(item => item.priority === 'P0').map(item => item.id),
    excluded: record.adapters.filter(item => item.priority === 'EXCLUDE').map(item => item.id),
  }));
}
