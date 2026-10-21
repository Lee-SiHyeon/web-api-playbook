import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { checkOperations } from '../operation-health.mjs';
import { createServiceRegistry, loadServiceDefinitions, listServiceOperations } from './index.mjs';

const code = error => /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'SERVICE_EXECUTION_FAILED';
async function fingerprint(entries) {
  const sources = new Set(['scripts/playbook.mjs', 'lib/operation-registry.mjs', 'lib/operation-health.mjs',
    'lib/service-operations/index.mjs', 'lib/service-operations/verify.mjs',
    ...['commerce', 'retail', 'native', 'travel', 'extras'].map(name => `lib/service-operations/${name}.mjs`)]);
  for (const entry of entries) for (const operation of Object.values(entry.profile.operations)) {
    for (const match of operation.evidence.matchAll(/(?:lib|scripts|service-packs)\/[A-Za-z0-9_./-]+\.(?:mjs|js|py)\b/g)) {
      if (!match[0].split('/').includes('..')) sources.add(match[0]);
    }
  }
  const hashes = {}, unavailable = [];
  for (const source of [...sources].sort()) {
    try { hashes[source] = createHash('sha256').update(await readFile(new URL(`../../${source}`, import.meta.url))).digest('hex'); }
    catch { unavailable.push(source); }
  }
  return { scope: 'Common runtime plus source files explicitly named by operation evidence; not every transitive dependency', sourceSha256: hashes, unavailableSources: unavailable };
}
function describeData(data) {
  const counts = {};
  const countLists = (value, prefix = '') => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, items] of Object.entries(value)) if (Array.isArray(items)) counts[`${prefix}${key}`] = items.length;
  };
  if (Array.isArray(data)) counts.records = data.length;
  else if (data && typeof data === 'object') {
    countLists(data); countLists(data.data, 'data.');
    for (const key of ['items', 'offers', 'products', 'records', 'reviews', 'domains', 'posts', 'results', 'categories', 'feeds']) {
      if (Array.isArray(data[key])) counts[key] = data[key].length;
    }
  }
  return { shape: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data,
    counts, sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
}

/** Current bounded read evidence, never a whole-service or whole-site completion claim. */
export async function verifyServiceOperations({ services, definitions, timeoutMs = 30000, signal, onResult,
  includeUnconnected = false, ...bindingOptions } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw Object.assign(new Error('SERVICE_TIMEOUT_INVALID'), { code: 'SERVICE_TIMEOUT_INVALID' });
  const entries = definitions ?? await loadServiceDefinitions();
  const ids = services ?? entries.map(entry => entry.id);
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw Object.assign(new Error('SERVICE_SELECTION_INVALID'), { code: 'SERVICE_SELECTION_INVALID' });
  const results = [];
  const implementation = await fingerprint(entries);
  for (const id of ids) {
    const startedAt = new Date().toISOString(), started = Date.now();
    let registry, result;
    const calls = [];
    let sharedFailure;
    try {
      registry = await createServiceRegistry(id, { definitions: entries, ...bindingOptions });
      const checks = registry.verificationChecks;
      const deadline = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const health = await checkOperations(registry.profile, { checks, signal: combined,
        execute: async (operation, input, context) => {
          if (sharedFailure) throw Object.assign(new Error(sharedFailure.code), sharedFailure);
          let read;
          try { read = await registry.execute(operation, input, context); }
          catch (error) {
            const status = error?.status ?? error?.httpStatus;
            if ([403, 429].includes(status) || ['ACCESS_DENIED', 'RATE_LIMITED'].includes(error?.code)) {
              sharedFailure = { code: code(error), ...(status ? { status } : {}) };
            }
            throw error;
          }
          const evidence = { operation, data: describeData(read.data) };
          // Receipts are not copied verbatim: keep only operation-level proof.
          for (const field of ['executionMode', 'httpStatus', 'networkUsed', 'browserUsed']) {
            const value = read.receipt?.[field];
            if (['string', 'number', 'boolean'].includes(typeof value)) evidence[field] = value;
          }
          calls.push(evidence); return read;
        } });
      const unused = [...calls];
      result = { serviceId: registry.profile.serviceId, requestedServiceId: id, startedAt, durationMs: Date.now() - started,
        verdict: health.verdict, checks: health.checks.map((check, index) => {
          const found = check.outcome === 'ok' ? unused.findIndex(call => call.operation === check.operation) : -1;
          const observation = found >= 0 ? unused.splice(found, 1)[0] : undefined;
          return { ...check, evidenceScope: checks[index]?.kind ?? 'adapter_execution',
            ...(check.outcome === 'ok' ? { liveReadVerified: checks[index]?.kind === 'live_read' && observation?.networkUsed === true } : {}) };
        }),
        observations: calls, next: health.next };
    } catch (error) {
      result = { serviceId: id, startedAt, durationMs: Date.now() - started, verdict: 'not_verified', code: code(error), checks: [], observations: [] };
    } finally {
      try { await registry?.close(); }
      catch (error) { if (result) { result.cleanupError = code(error); if (result.verdict === 'ok') result.verdict = 'partial'; } }
    }
    results.push(result);
    if (onResult) await onResult(structuredClone(result));
    if (signal?.aborted) break;
  }
  const inventory = includeUnconnected ? await listServiceOperations({ definitions: entries }) : undefined;
  const finalImplementation = await fingerprint(entries);
  return { schema: 'playbook-service-verification-v1', checkedAt: new Date().toISOString(),
    scope: 'Only the exact named read checks shown; no login, write or whole-site completeness proof',
    implementation: { ...implementation, unchangedDuringRun: JSON.stringify(implementation) === JSON.stringify(finalImplementation) },
    results, ...(inventory ? { unconnected: inventory.services.filter(service => service.connection === 'not_connected') } : {}),
    summary: { selected: ids.length, checked: results.length, ok: results.filter(result => result.verdict === 'ok').length,
      notFullyVerified: results.filter(result => result.verdict !== 'ok').length,
      liveReadChecksPassed: results.flatMap(result => result.checks).filter(check => check.liveReadVerified === true).length,
      noWritesExecuted: true } };
}
