import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { agyRemoteRpc } from './checklist/agy-remote-rpc.mjs';
import { safeRelativePath } from './capability-checklist.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const root = new URL('../', import.meta.url);
export async function verifyAgyRecordedEvidence() {
  let proof, checklist;
  try {
    proof = JSON.parse(await readFile(new URL('sanitizedverification/agy-remote-live-2026-11-13.json', root), 'utf8'));
    checklist = JSON.parse(await readFile(new URL('checklists/services/agy-remote.json', root), 'utf8'));
  } catch { fail('AGY_RECORDED_EVIDENCE_MISSING'); }
  const ids = checklist.capabilities.filter(x => x.priority === 'required').map(x => x.id);
  if (Object.keys(proof.capabilities ?? {}).length !== ids.length) fail('AGY_RECORDED_EVIDENCE_INVALID');
  for (const id of ids) {
    const request = proof.capabilities[id]?.request;
    if (!agyRemoteRpc([proof], { origin: request?.origin, path: request?.path, nativeMethod: request?.nativeMethod }, { id })
      || proof.capabilities[id].status !== 'replay_verified') fail('AGY_RECORDED_EVIDENCE_INVALID');
  }
  if (!proof.implementation || Object.keys(proof.implementation).length < 8) fail('AGY_RECORDED_EVIDENCE_INVALID');
  for (const [file, expected] of Object.entries(proof.implementation)) {
    if (!safeRelativePath(file) || !/^[a-f0-9]{64}$/.test(expected)) fail('AGY_RECORDED_EVIDENCE_INVALID');
    let data; try { data = await readFile(fileURLToPath(new URL(file, root))); } catch { fail('AGY_RECORDED_EVIDENCE_MISSING'); }
    if (createHash('sha256').update(data).digest('hex') !== expected) fail('AGY_RECORDED_IMPLEMENTATION_CHANGED');
    if (!Object.values(proof.validationPhases ?? {}).some(phase => phase.verified === true && phase.implementation?.[file] === expected)) fail('AGY_RECORDED_PHASE_BINDING_INVALID');
  }
  return { ok: true, verification: 'recorded_rpc_evidence_revalidation', networkUsed: false, credentialsUsed: false,
    recordedLiveCapabilities: ids.length, recordedAt: proof.checkedAt, implementationMatched: true,
    currentAuthentication: 'not_probed', businessMode: proof.businessMode, engineFreeWorkflow: false };
}
