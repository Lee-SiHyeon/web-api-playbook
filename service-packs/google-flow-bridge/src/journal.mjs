import { randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const JOB_DIR = path.join(APP_DIR, '.runtime', 'jobs');
const FINISHED_STATES = new Set(['downloaded', 'rejected', 'preflight_failed']);

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

export async function createJournal({ projectId, promptHash, clientIds, aspect, duration, resolution, outputPath }) {
  const jobId = randomUUID();
  const job = {
    version: 1,
    jobId,
    jobPath: path.join(JOB_DIR, jobId + '.json'),
    state: 'intent_logged',
    projectId,
    promptHash,
    clientIds,
    aspect,
    duration,
    resolution,
    outputPath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
  if (job?.version !== 1 || typeof job.projectId !== 'string' || !Array.isArray(job.clientIds)
      || typeof job.outputPath !== 'string' || typeof job.state !== 'string') {
    throw new Error('Invalid Flow job journal.');
  }
  return { ...job, jobPath: resolved };
}

export async function findUnresolvedJournal(projectId, promptHash) {
  let names;
  try { names = await readdir(JOB_DIR); } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const job = await loadJournal(path.join(JOB_DIR, name));
    if (job.projectId === projectId && job.promptHash === promptHash && !FINISHED_STATES.has(job.state)) return job;
  }
  return undefined;
}
