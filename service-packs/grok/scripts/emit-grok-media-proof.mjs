#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson, sha256Text, validateFeatureChecklist } from '../src/feature-checklist.mjs';
import {
  createGrokMediaProofReceipt,
  emitGrokMediaProofReceipt,
  GrokMediaProofError,
  inspectGrokMediaRunRecord,
  readGrokMediaProofReceipt,
} from '../src/grok-media-proof-receipts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKLIST_PATH = 'contracts/grok-feature-checklist.v1.json';
const RECEIPT_REQUIREMENTS = new Set([
  'image.generate.wss', 'video.text-to-video', 'video.image-reference-to-video',
  'artifact.image.download', 'artifact.video.download',
]);

async function readContainedJson(relativePath, { optional = false } = {}) {
  if (typeof relativePath !== 'string' || relativePath.startsWith('/') || relativePath.includes('\\')
    || relativePath.includes('\0') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new GrokMediaProofError('MEDIA_PROOF_PATH_INVALID');
  }
  const rootReal = await realpath(ROOT);
  let current = rootReal;
  for (const part of relativePath.split('/')) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) {
      if (optional) return null;
      throw new GrokMediaProofError('MEDIA_PROOF_PATH_INVALID');
    }
    if (info.isSymbolicLink()) throw new GrokMediaProofError('MEDIA_PROOF_PATH_INVALID');
  }
  const canonical = await realpath(current);
  if (!canonical.startsWith(rootReal + path.sep) || !(await lstat(current)).isFile()) {
    throw new GrokMediaProofError('MEDIA_PROOF_PATH_INVALID');
  }
  try { return JSON.parse(await readFile(current, 'utf8')); }
  catch { throw new GrokMediaProofError('MEDIA_PROOF_JSON_INVALID'); }
}

function parseArgs(args) {
  if (args[0] === '--verify') {
    if (args.length !== 2 || !RECEIPT_REQUIREMENTS.has(args[1])) throw new GrokMediaProofError('MEDIA_PROOF_ARGUMENT_INVALID');
    return { mode: 'verify', requirementId: args[1] };
  }
  if (args.length < 2 || args.length > 3) throw new GrokMediaProofError('MEDIA_PROOF_ARGUMENT_INVALID');
  const [requirementId, runRecordPath, ...flags] = args;
  if (!RECEIPT_REQUIREMENTS.has(requirementId)) throw new GrokMediaProofError('MEDIA_PROOF_REQUIREMENT_INVALID');
  const mode = flags.length === 0 ? 'check' : flags[0] === '--write' ? 'write'
    : flags[0] === '--write-stdin' ? 'write-stdin' : null;
  if (!mode || flags.length > 1) {
    throw new GrokMediaProofError('MEDIA_PROOF_ARGUMENT_INVALID');
  }
  return { mode, requirementId, runRecordPath };
}

async function readEphemeralArtifactPaths() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16 * 1024) throw new GrokMediaProofError('MEDIA_PROOF_INPUT_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  const input = Buffer.concat(chunks, size);
  try {
    const value = JSON.parse(input.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['artifactFilePaths'])
      || !Array.isArray(value.artifactFilePaths) || value.artifactFilePaths.length < 1 || value.artifactFilePaths.length > 4
      || value.artifactFilePaths.some(item => typeof item !== 'string' || !path.isAbsolute(item))) {
      throw new GrokMediaProofError('MEDIA_PROOF_ARTIFACT_INPUT_INVALID');
    }
    return value.artifactFilePaths;
  } catch (error) {
    if (error instanceof GrokMediaProofError) throw error;
    throw new GrokMediaProofError('MEDIA_PROOF_ARTIFACT_INPUT_INVALID');
  } finally {
    input.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function loadProofDocuments(runRecord, currentPath) {
  const paths = new Set([runRecord?.owner?.proofPath, currentPath].filter(value => typeof value === 'string'));
  if ([...paths].some(value => !value.startsWith('verification/'))) throw new GrokMediaProofError('MEDIA_PROOF_OWNER_REFERENCE_MISSING');
  const documents = {};
  for (const relativePath of paths) documents[relativePath] = await readContainedJson(relativePath);
  const current = documents[currentPath];
  if (!current || !/^[a-f0-9]{64}$/.test(current.ownerScopeSha256 ?? '')) {
    throw new GrokMediaProofError('MEDIA_PROOF_CURRENT_OWNER_MISSING');
  }
  return {
    documents,
    currentOwnerProof: {
      path: currentPath,
      canonicalSha256: sha256Text(canonicalJson(current)),
      ownerScopeSha256: current.ownerScopeSha256,
    },
  };
}

async function run(args = process.argv.slice(2)) {
  const { mode, requirementId, runRecordPath } = parseArgs(args);
  const checklist = await readContainedJson(CHECKLIST_PATH);
  validateFeatureChecklist(checklist);
  const currentOwnerPath = process.env.GROK_CURRENT_OWNER_PROOF_PATH ?? 'verification/grok-feature-live-receipts/auth-owner.read.json';
  if (mode === 'verify') {
    const receiptPath = `${checklist.receiptDirectory}/media-${requirementId}.json`;
    const storedReceipt = await readContainedJson(receiptPath, { optional: true });
    if (!storedReceipt) return {
      schemaVersion: 1, serviceId: 'grok-web', status: 'missing', requirementId, receiptPath,
    };
    const { documents: ownerProofDocuments, currentOwnerProof } = await loadProofDocuments({
      owner: { proofPath: storedReceipt.ownerProofPath },
    }, currentOwnerPath);
    const result = await readGrokMediaProofReceipt({
      repoRoot: ROOT, checklist, requirementId, ownerProofDocuments, currentOwnerProof,
    });
    return {
      schemaVersion: 1, serviceId: 'grok-web', status: result.status, requirementId,
      receiptPath: result.receiptPath, codeCurrent: result.codeCurrent ?? null,
      ownerProofBound: result.ownerProofBound ?? null, mediaContractCurrent: result.mediaContractCurrent ?? null,
      operationContractsCurrent: result.operationContractsCurrent ?? null,
      artifactFactsPersisted: result.artifactFactsPersisted ?? 0, artifactBytesRecheckedThisRun: false,
    };
  }
  if (!runRecordPath.startsWith('verification/')) throw new GrokMediaProofError('MEDIA_PROOF_RUN_PATH_INVALID');
  const runRecord = await readContainedJson(runRecordPath);
  const artifactFilePaths = mode === 'write-stdin' ? await readEphemeralArtifactPaths() : [];
  const inspected = inspectGrokMediaRunRecord({ checklist, requirementId, runRecord, artifactFilePaths });
  if (inspected.missingFields.length || inspected.invalidFields.length) {
    return {
      schemaVersion: 1, serviceId: 'grok-web', status: 'incomplete', requirementId,
      receiptPath: null, missingFields: inspected.missingFields, blockers: inspected.invalidFields,
    };
  }
  const { documents: ownerProofDocuments, currentOwnerProof } = await loadProofDocuments(runRecord, currentOwnerPath);
  const base = {
    repoRoot: ROOT,
    checklist,
    requirementId,
    runRecord,
    artifactFilePaths,
    ownerProofDocuments,
    currentOwnerProof,
    artifactRoot: process.env.GROK_ARTIFACT_ROOT ?? path.join(process.env.HOME ?? '/home/worker', 'artifacts'),
  };
  if (mode === 'write' || mode === 'write-stdin') {
    const result = await emitGrokMediaProofReceipt(base);
    return {
      schemaVersion: 1,
      serviceId: 'grok-web',
      status: result.status,
      requirementId,
      receiptPath: result.receiptPath,
      missingFields: result.missingFields,
      blockers: result.blockers,
    };
  }
  const result = await createGrokMediaProofReceipt(base);
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    status: result.status,
    requirementId,
    receiptPath: null,
    missingFields: result.missingFields,
    blockers: result.blockers,
  };
}

export { run as runMediaProofProducer };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
    const code = error instanceof GrokMediaProofError ? error.code : 'MEDIA_PROOF_FAILED';
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, serviceId: 'grok-web', status: 'invalid', error: { code } })}\n`);
    process.exitCode = 1;
  });
}
