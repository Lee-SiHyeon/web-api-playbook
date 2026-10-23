import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const JOB_DIR = path.join(APP_DIR, '.runtime', 'jobs');
const FINISHED_STATES = new Set(['downloaded', 'rejected', 'preflight_failed']);
const KNOWN_STATES = new Set(['intent_logged', 'accepted', 'needs_reconciliation', 'needs_download', 'downloaded', 'rejected', 'preflight_failed']);
const FLOW_ID = /^[A-Fa-f0-9-]{16,64}$/;
// Recorded provenance only: accepting a diagnostic journal does not allow its
// SDK input mode through the production HTTP generation/provider guards.
const INPUT_MODES = new Set(['verified_pure_http', 'absent_probe', 'browser_sdk_diagnostic', 'gflow_browser']);


function generationFencePath(job) {
  const projectKey = createHash('sha256').update(job.projectId.toLowerCase()).digest('hex').slice(0, 32);
  return path.join(path.dirname(job.jobPath), '.flow-generation-' + projectKey + '.lock');
}

async function withGenerationFenceClaim(job, operation) {
  const fencePath = generationFencePath(job);
  const claimPath = fencePath + '.claim';
  let handle;
  try { handle = await open(claimPath, 'wx', 0o600); } catch (error) {
    if (error?.code === 'EEXIST') return { busy: true };
    throw error;
  }
  const claimId = randomUUID();
  try {
    await handle.writeFile(JSON.stringify({ version: 1, claimId }) + '\n');
    await handle.sync();
    return { busy: false, value: await operation(fencePath) };
  } finally {
    await handle.close();
    let claim;
    try { claim = JSON.parse(await readFile(claimPath, 'utf8')); } catch { claim = null; }
    if (claim?.claimId === claimId) await rm(claimPath, { force: true });
  }
}

export async function acquireGenerationFence(job) {
  if (job?.operation !== 'generate_video') throw new Error('Invalid Flow generation fence target.');
  await mkdir(path.dirname(job.jobPath), { recursive: true, mode: 0o700 });
  const claim = await withGenerationFenceClaim(job, async fencePath => {
    let handle;
    try { handle = await open(fencePath, 'wx', 0o600); } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({
        version: 1, projectId: job.projectId, jobId: job.jobId, jobPath: job.jobPath,
      }) + '\n');
      await handle.sync();
      return true;
    } catch (error) {
      await rm(fencePath, { force: true }).catch(() => {});
      throw error;
    } finally {
      await handle.close();
    }
  });
  return { acquired: claim.busy ? false : claim.value === true, busy: claim.busy, fencePath: generationFencePath(job) };
}

export async function releaseGenerationFence(job) {
  if (job?.operation !== 'generate_video') return false;
  const fencePath = generationFencePath(job);
  const claim = await withGenerationFenceClaim(job, async claimedPath => {
    let lock;
    try { lock = JSON.parse(await readFile(claimedPath, 'utf8')); } catch { return false; }
    if (lock?.version !== 1 || lock.jobId !== job.jobId || lock.projectId !== job.projectId) return false;
    await rm(claimedPath, { force: true });
    return true;
  });
  return claim.busy ? false : claim.value === true;
}

async function writeAtomic(job) {
  await mkdir(path.dirname(job.jobPath), { recursive: true, mode: 0o700 });
  const tempPath = job.jobPath + '.' + randomUUID() + '.tmp';
  const { jobPath, ...publicJob } = job;
  try {
    await writeFile(tempPath, JSON.stringify(publicJob, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(tempPath, jobPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function makeGenerationJob({ projectId, promptHash, clientIds, requestId, aspect, duration, resolution, outputPath, inputMode }, jobDir) {
  if (inputMode !== undefined && !INPUT_MODES.has(inputMode)) {
    throw new TypeError('Invalid Flow generation input mode.');
  }
  if (requestId !== undefined && (typeof requestId !== 'string' || !FLOW_ID.test(requestId))) {
    throw new TypeError('Invalid Flow generation request id.');
  }
  const jobId = randomUUID();
  return {
    version: 1,
    jobId,
    jobPath: path.join(path.resolve(jobDir), jobId + '.json'),
    operation: 'generate_video',
    state: 'intent_logged',
    projectId,
    promptHash,
    clientIds,
    ...(requestId === undefined ? {} : { requestId }),
    aspect,
    duration,
    resolution,
    outputPath,
    ...(inputMode === undefined ? {} : { inputMode }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createJournal(fields, { jobDir = JOB_DIR } = {}) {
  const job = makeGenerationJob(fields, jobDir);
  await writeAtomic(job);
  return job;
}

export async function createGenerationIntent(fields, { jobDir = JOB_DIR } = {}) {
  const job = makeGenerationJob(fields, jobDir);
  await mkdir(path.dirname(job.jobPath), { recursive: true, mode: 0o700 });
  const claim = await withGenerationFenceClaim(job, async fencePath => {
    let fenceHandle;
    try { fenceHandle = await open(fencePath, 'wx', 0o600); } catch (error) {
      if (error?.code === 'EEXIST') return { busy: true };
      throw error;
    }
    try {
      await fenceHandle.writeFile(JSON.stringify({
        version: 1, projectId: job.projectId, jobId: job.jobId, jobPath: job.jobPath,
      }) + '\n');
      await fenceHandle.sync();
      const unresolved = await findUnresolvedJournal(job.projectId, undefined, { jobDir });
      if (unresolved) {
        await rm(fencePath, { force: true });
        return { unresolved };
      }
      await writeAtomic(job);
      return { job };
    } catch (error) {
      await rm(fencePath, { force: true }).catch(() => {});
      throw error;
    } finally {
      await fenceHandle.close();
    }
  });
  if (claim.busy) return { job: null, busy: true };
  return claim.value ?? { job: null, busy: true };
}

export async function createDownloadJournal({ projectId, mediaId, outputPath }, { jobDir = JOB_DIR } = {}) {
  if (typeof projectId !== 'string' || !FLOW_ID.test(projectId)
      || typeof mediaId !== 'string' || !FLOW_ID.test(mediaId)
      || typeof outputPath !== 'string' || outputPath.trim() === '' || outputPath.includes('\0')) {
    throw new Error('Invalid Flow download journal input.');
  }
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const job = {
    version: 1,
    jobId,
    jobPath: path.join(path.resolve(jobDir), jobId + '.json'),
    operation: 'download_existing',
    state: 'needs_download',
    projectId,
    mediaId,
    clientIds: [],
    outputPath: path.resolve(outputPath),
    createdAt: now,
    updatedAt: now,
  };
  await writeAtomic(job);
  return job;
}

export async function updateJournal(job, fields) {
  const updated = { ...job, ...fields, updatedAt: new Date().toISOString() };
  await writeAtomic(updated);
  return updated;
}

export async function loadJournal(jobPath) {
  const resolved = path.resolve(jobPath);
  const job = JSON.parse(await readFile(resolved, 'utf8'));
  const validClientIds = Array.isArray(job?.clientIds) && job.clientIds.every((id) => typeof id === 'string');
  const validProjectId = typeof job?.projectId === 'string' && FLOW_ID.test(job.projectId);
  const validMediaId = job?.mediaId === undefined || (typeof job.mediaId === 'string' && FLOW_ID.test(job.mediaId));
  const validRequestId = job?.requestId === undefined || (typeof job.requestId === 'string' && FLOW_ID.test(job.requestId));
  const validOperation = job?.operation === undefined || job.operation === 'download_existing' || job.operation === 'generate_video';
  const validInputMode = job?.inputMode === undefined || INPUT_MODES.has(job.inputMode);
  const validDownloadJob = job?.operation !== 'download_existing' || typeof job.mediaId === 'string';
  if (job?.version !== 1 || !validProjectId || !validMediaId || !validRequestId || !validClientIds
      || typeof job?.outputPath !== 'string' || !KNOWN_STATES.has(job?.state)
      || !validOperation || !validDownloadJob || !validInputMode) {
    throw new Error('Invalid Flow job journal.');
  }
  return { ...job, jobPath: resolved };
}

export async function findUnresolvedJournal(projectId, promptHash, { jobDir = JOB_DIR, excludeJobId } = {}) {
  let names;
  try { names = await readdir(jobDir); } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const job = await loadJournal(path.join(jobDir, name));
    if (job.jobId !== excludeJobId && job.operation !== 'download_existing' && job.projectId.toLowerCase() === projectId.toLowerCase()
        && (promptHash === undefined || job.promptHash === promptHash) && !FINISHED_STATES.has(job.state)) return job;
  }
  return undefined;
}
