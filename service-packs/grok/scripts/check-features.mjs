#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GrokWebClient, loadContractRegistry } from '../src/client.mjs';
import { receiveOneEncryptedSession } from '../src/bootstrap-receive.mjs';
import { fetchPublicModels } from '../src/public-models.mjs';
import { submitCapturedGrokTextOnce } from '../src/grok-text-websocket.mjs';
import { submitGrokTextInSelectedMode } from '../src/grok-mode-selected-text.mjs';
import { submitGrokConversationRegenerationWssOnce } from '../src/grok-conversation-wss.mjs';
import { createGrokWorkspaceClient } from '../src/grok-workspaces.mjs';
import { createGrokAttachmentUploadClient } from '../src/grok-attachment-upload.mjs';
import { createGrokMediaApi } from '../src/grok-media-api.mjs';
import { submitGrokImagineImage, submitProvisionalCapturedGrokVideoOnce } from '../src/grok-media-operations.mjs';
import {
  evaluateFeatureChecklist,
  FeatureChecklistError,
  validateFeatureChecklist,
  validateFeatureReceipts,
  validatePublicReplayEvidence,
} from '../src/feature-checklist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKLIST_FILE = 'contracts/grok-feature-checklist.v1.json';
const REGISTRY_FILE = 'contracts/grok-web.v1.json';

function parseArgs(args) {
  const options = { strict: false, json: false };
  for (const arg of args) {
    if (arg === '--strict' && !options.strict) options.strict = true;
    else if (arg === '--json' && !options.json) options.json = true;
    else throw new FeatureChecklistError('FEATURE_CHECK_ARGUMENT_INVALID');
  }
  return options;
}

export async function resolveContainedRepoPath(root, relativePath, { allowMissing = false, expected = 'file' } = {}) {
  if (!['file', 'directory', 'either'].includes(expected)) throw new FeatureChecklistError('FEATURE_CHECK_PATH_INVALID');
  const rootReal = await realpath(root).catch(() => { throw new FeatureChecklistError('FEATURE_CHECK_PATH_INVALID'); });
  const parts = typeof relativePath === 'string' ? relativePath.split('/') : [];
  if (!parts.length || relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.includes('\0')
    || parts.some(part => !part || part === '.' || part === '..')) throw new FeatureChecklistError('FEATURE_CHECK_PATH_INVALID');
  let current = rootReal;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return { path: current, missing: true };
      throw new FeatureChecklistError(error?.code === 'ENOENT' ? 'FEATURE_CHECK_INPUT_INVALID' : 'FEATURE_CHECK_PATH_INVALID');
    }
    if (info.isSymbolicLink()) throw new FeatureChecklistError('FEATURE_CHECK_PATH_INVALID');
    const canonical = await realpath(current).catch(() => { throw new FeatureChecklistError('FEATURE_CHECK_PATH_INVALID'); });
    if (!canonical.startsWith(rootReal + path.sep)) throw new FeatureChecklistError('FEATURE_CHECK_PATH_INVALID');
    if (index < parts.length - 1 && !info.isDirectory()) throw new FeatureChecklistError('FEATURE_CHECK_PATH_INVALID');
    if (index === parts.length - 1 && expected === 'file' && !info.isFile()) throw new FeatureChecklistError('FEATURE_CHECK_PATH_INVALID');
    if (index === parts.length - 1 && expected === 'directory' && !info.isDirectory()) throw new FeatureChecklistError('FEATURE_CHECK_PATH_INVALID');
  }
  return { path: current, missing: false };
}

async function readJson(relativePath, { optional = false } = {}) {
  try {
    const { path: filePath, missing } = await resolveContainedRepoPath(ROOT, relativePath, { allowMissing: optional });
    if (missing) return null;
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (error instanceof FeatureChecklistError) throw error;
    throw new FeatureChecklistError('FEATURE_CHECK_INPUT_INVALID');
  }
}

async function sourceHash(relativePath) {
  try {
    if (typeof relativePath !== 'string' || !/^(?:(?:src|scripts)\/[A-Za-z0-9._/-]+\.(?:mjs|js|py|txt)|contracts\/[A-Za-z0-9._/-]+\.json)$/.test(relativePath)
      || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new FeatureChecklistError('FEATURE_CHECK_PATH_INVALID');
    }
    const { path: filePath, missing } = await resolveContainedRepoPath(ROOT, relativePath, { allowMissing: true });
    if (missing) return null;
    return createHash('sha256').update(await readFile(filePath)).digest('hex');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new FeatureChecklistError('FEATURE_CHECK_INPUT_INVALID');
  }
}

async function readFirstPartyEvidence(registry, receipts = [], mediaContracts = {}) {
  const paths = new Set(registry.operations
    .filter(operation => ['first_party_bundle_contract', 'first_party_sdk_contract'].includes(operation.evidence?.source))
    .map(operation => operation.evidence?.directReplayReceipt)
    .filter(value => typeof value === 'string'));
  for (const receipt of receipts) {
    if (receipt?.featureId === 'conversation.uploads' && receipt?.requirementId === 'upload.direct.asset'
      && typeof receipt.sourceProofPath === 'string') paths.add(receipt.sourceProofPath);
  }
  for (const contract of Object.values(mediaContracts)) {
    if (typeof contract?.sourceEvidencePath === 'string') paths.add(contract.sourceEvidencePath);
  }
  const documents = {};
  const hashes = {};
  for (const relativePath of paths) {
    if (!relativePath.startsWith('verification/')) throw new FeatureChecklistError('FEATURE_CHECK_PATH_INVALID');
    const { path: filePath, missing } = await resolveContainedRepoPath(ROOT, relativePath, { allowMissing: true });
    if (missing) {
      documents[relativePath] = null;
      hashes[relativePath] = null;
      continue;
    }
    try {
      const bytes = await readFile(filePath);
      documents[relativePath] = JSON.parse(bytes.toString('utf8'));
      hashes[relativePath] = createHash('sha256').update(bytes).digest('hex');
    } catch {
      throw new FeatureChecklistError('FEATURE_CHECK_INPUT_INVALID');
    }
  }
  const nestedAuditPaths = new Set(Object.values(documents)
    .map(document => document?.apiResult?.apiAuditPath)
    .filter(value => typeof value === 'string'));
  for (const linkedPath of nestedAuditPaths) {
    const absolutePath = path.isAbsolute(linkedPath) ? path.resolve(linkedPath) : null;
    const relativePath = absolutePath ? path.relative(ROOT, absolutePath).split(path.sep).join('/') : linkedPath;
    if (!relativePath.startsWith('verification/') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new FeatureChecklistError('FEATURE_CHECK_PATH_INVALID');
    }
    if (Object.hasOwn(documents, linkedPath)) continue;
    const { path: filePath, missing } = await resolveContainedRepoPath(ROOT, relativePath, { allowMissing: true });
    if (missing) {
      documents[linkedPath] = null;
      hashes[linkedPath] = null;
      continue;
    }
    try {
      const bytes = await readFile(filePath);
      documents[linkedPath] = JSON.parse(bytes.toString('utf8'));
      hashes[linkedPath] = createHash('sha256').update(bytes).digest('hex');
    } catch {
      throw new FeatureChecklistError('FEATURE_CHECK_INPUT_INVALID');
    }
  }
  return { documents, hashes };
}

async function readPrivateReceipts(relativePath) {
  const { path: directory, missing } = await resolveContainedRepoPath(ROOT, relativePath, { allowMissing: true, expected: 'directory' });
  if (missing) return [];
  let names;
  try { names = await readdir(directory); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new FeatureChecklistError('FEATURE_CHECK_INPUT_INVALID');
  }
  const receipts = [];
  for (const name of names.filter(item => item.endsWith('.json')).sort()) {
    const relativeFile = `${relativePath}/${name}`;
    const { path: filePath } = await resolveContainedRepoPath(ROOT, relativeFile);
    try { receipts.push(JSON.parse(await readFile(filePath, 'utf8'))); }
    catch { throw new FeatureChecklistError('FEATURE_CHECK_INPUT_INVALID'); }
  }
  return receipts;
}

async function readOwnerProofDocuments() {
  const documents = {};
  const add = async relativePath => {
    const { path: filePath, missing } = await resolveContainedRepoPath(ROOT, relativePath, { allowMissing: true });
    if (missing) return;
    try { documents[relativePath] = JSON.parse(await readFile(filePath, 'utf8')); }
    catch { throw new FeatureChecklistError('FEATURE_CHECK_INPUT_INVALID'); }
  };
  const ownerProofRoot = 'verification/owner-proofs';
  const { path: ownerProofDirectory, missing: ownerProofMissing } = await resolveContainedRepoPath(ROOT, ownerProofRoot,
    { allowMissing: true, expected: 'directory' });
  if (!ownerProofMissing) {
    let entries;
    try { entries = await readdir(ownerProofDirectory, { withFileTypes: true }); }
    catch { throw new FeatureChecklistError('FEATURE_CHECK_INPUT_INVALID'); }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      await add(`${ownerProofRoot}/${entry.name}`);
    }
  }
  const runRoot = 'verification/conversation-read-runs';
  const { path: runDirectory, missing: runRootMissing } = await resolveContainedRepoPath(ROOT, runRoot,
    { allowMissing: true, expected: 'directory' });
  if (!runRootMissing) {
    let runs;
    try { runs = await readdir(runDirectory, { withFileTypes: true }); }
    catch { throw new FeatureChecklistError('FEATURE_CHECK_INPUT_INVALID'); }
    for (const run of runs) {
      if (!run.isDirectory() || !/^[A-Za-z0-9._:-]{1,160}$/.test(run.name)) continue;
      const relativePath = `${runRoot}/${run.name}/auth-owner.read.json`;
      await add(relativePath);
    }
  }
  return documents;
}

function runtimeHandlers(checklist) {
  const exportsBySource = {
    'src/client.mjs': { GrokWebClient },
    'src/public-models.mjs': { fetchPublicModels },
    'src/grok-text-websocket.mjs': { submitCapturedGrokTextOnce },
    'src/grok-mode-selected-text.mjs': { submitGrokTextInSelectedMode },
    'src/grok-conversation-wss.mjs': { submitGrokConversationRegenerationWssOnce },
    'src/grok-workspaces.mjs': { createGrokWorkspaceClient },
    'src/grok-attachment-upload.mjs': { createGrokAttachmentUploadClient },
    'src/grok-media-api.mjs': { createGrokMediaApi },
    'src/grok-media-operations.mjs': { submitGrokImagineImage, submitProvisionalCapturedGrokVideoOnce },
  };
  const workspaceClient = createGrokWorkspaceClient({
    client: { read: async () => ({}), submit: async () => ({}), status: async () => ({}) },
    journal: { get: async () => null, transition: async () => null },
  });
  const attachmentClient = createGrokAttachmentUploadClient({
    client: { read: async () => ({}), submit: async () => ({}), getInMemoryPrivateResponse: async () => ({}) },
    journal: { get: async () => null, transition: async () => null },
    assetReader: async () => ({}),
  });
  const mediaApi = createGrokMediaApi({ client: { read: async () => ({}) }, assetReader: async () => ({}) });
  const output = {};
  for (const [handlerId, binding] of Object.entries(checklist.handlerBindings)) {
    const namespace = exportsBySource[binding.source];
    const owner = namespace?.[binding.owner];
    if (binding.kind === 'clientMethod') {
      output[handlerId] = typeof owner?.prototype?.[binding.member] === 'function';
    } else {
      const exported = typeof namespace?.[binding.member] === 'function';
      const factory = handlerId === 'attachments.upload-direct' ? attachmentClient : mediaApi;
      output[handlerId] = exported && (binding.workspaceMethod !== undefined
        ? typeof workspaceClient[binding.workspaceMethod] === 'function'
        : binding.factoryMethod !== undefined ? typeof factory[binding.factoryMethod] === 'function' : true);
    }
  }
  output['auth.bootstrap'] = typeof receiveOneEncryptedSession === 'function';
  return output;
}

async function run(options) {
  const checklist = await readJson(CHECKLIST_FILE);
  validateFeatureChecklist(checklist);
  const { path: registryPath } = await resolveContainedRepoPath(ROOT, REGISTRY_FILE);
  const registry = await loadContractRegistry(registryPath);
  const receipts = validateFeatureReceipts(await readPrivateReceipts(checklist.receiptDirectory));
  const ownerProofDocuments = await readOwnerProofDocuments();
  const firstPartyEvidence = await readFirstPartyEvidence(registry, receipts, checklist.mediaContracts);
  const publicReplayReceipt = validatePublicReplayEvidence(await readJson(checklist.publicReplayReceipt, { optional: true }));
  const files = new Set(Object.values(checklist.handlerBindings).flatMap(binding => binding.codeFiles));
  for (const file of ['src/bootstrap-receive.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/protected-json-store.mjs', 'src/session.mjs']) files.add(file);
  for (const receipt of receipts) {
    for (const file of Object.keys(receipt?.codeSha256 ?? {})) files.add(file);
  }
  for (const file of Object.keys(publicReplayReceipt?.implementationSha256 ?? {})) files.add(file);
  const codeHashes = Object.fromEntries(await Promise.all([...files].map(async file => [file, await sourceHash(file)])));
  const report = evaluateFeatureChecklist({
    checklist,
    registry,
    receipts,
    publicReplayReceipt,
    codeHashes,
    handlers: runtimeHandlers(checklist),
    sourceEvidenceHashes: firstPartyEvidence.hashes,
    sourceEvidenceDocuments: firstPartyEvidence.documents,
    ownerProofDocuments,
  });
  report.mode = options.strict ? 'strict' : 'report';
  report.ioPolicy = 'offline; repository files only; no provider, login, browser, credential store, or network access';
  return report;
}

function printHuman(report) {
  const summary = report.summary;
  process.stdout.write(`Grok feature checklist: ${report.status}\n`);
  process.stdout.write(`Evidence: ${report.evidenceFreshness}; last recorded ${report.lastRecordedEvidenceAt ?? 'none'}\n`);
  process.stdout.write(`Required features: ${summary.completeRequiredFeatures}/${summary.requiredFeatures}; operations: ${summary.completeRequiredOperations}/${summary.requiredOperations}\n`);
  process.stdout.write(`Needs re-verification: ${summary.needsReverificationOperations}; manifest requirements: ${summary.checklistRequirements}\n`);
  for (const feature of report.features) {
    if (!feature.required && feature.status === 'stored_receipt_consistent') continue;
    const state = feature.status === 'stored_receipt_consistent' ? 'RECORDED'
      : feature.requirements.some(item => item.reverificationRequired) ? 'NEEDS_REVERIFICATION' : 'INCOMPLETE';
    const missing = feature.requirements.filter(item => !item.ready)
      .map(item => `${item.id} [${item.blockers.join(',') || 'unknown'}]`).join('; ');
    const lastRecorded = feature.requirements.map(item => item.evidence?.recordedAt).filter(Boolean).sort().at(-1);
    process.stdout.write(`${state} ${feature.id}${lastRecorded ? ` (recorded ${lastRecorded})` : ''}${missing ? `: ${missing}` : ''}\n`);
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) {
    const code = error instanceof FeatureChecklistError ? error.code : 'FEATURE_CHECK_ARGUMENT_INVALID';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const report = await run(options);
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printHuman(report);
    if (options.strict && report.status !== 'stored_receipt_consistent') process.exitCode = 2;
  } catch (error) {
    const code = error instanceof FeatureChecklistError ? error.code : 'FEATURE_CHECK_FAILED';
    if (options.json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, serviceId: 'grok-web', status: 'invalid', error: { code } })}\n`);
    else process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
