import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalJson,
  sha256Text,
  validateFeatureChecklist,
  validateFeatureReceipts,
} from '../src/feature-checklist.mjs';
import {
  createGrokMediaProofReceipt,
  emitGrokMediaProofReceipt,
  readGrokMediaProofReceipt,
  snapshotGrokMediaOperationContracts,
  verifyGrokMediaProofReceipt,
} from '../src/grok-media-proof-receipts.mjs';
import { runMediaProofProducer } from '../scripts/emit-grok-media-proof.mjs';

const SOURCE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FALSE_PERSISTENCE_FIELDS = [
  'credentialValuesPersisted', 'cookiesPersisted', 'tokensPersisted', 'requestBodiesPersisted',
  'responseBodiesPersisted', 'signedUrlValuesPersisted', 'passwordValuesPersisted',
  'conversationIdsPersisted', 'conversationTitlesPersisted', 'responseIdsPersisted', 'messageBodiesPersisted',
  'rawFramesPersisted', 'assetBytesPersisted', 'assetIdsPersisted', 'promptPersisted',
  'rawIdsOrKeysOrUrlsPersisted', 'cookiesOrTokensPersisted',
];

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

test('proof CLI preserves a legacy receipt and reports current handler drift without restamping it', async () => {
  await assert.rejects(runMediaProofProducer(['--verify', 'artifact.image.download']),
    error => /^MEDIA_PROOF_CURRENT_CODE_DRIFT_[A-Za-z0-9._-]+$/.test(error?.code ?? ''));
  const missing = await runMediaProofProducer(['--verify', 'video.text-to-video']);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.requirementId, 'video.text-to-video');
});

async function fixture(requirementId) {
  const scratch = path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(scratch, 'grok-media-proof-'));
  const artifactRoot = path.join(root, 'artifacts');
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const checklist = JSON.parse(await readFile(path.join(SOURCE_ROOT, 'contracts/grok-feature-checklist.v1.json'), 'utf8'));
  validateFeatureChecklist(checklist);
  const requirement = checklist.features.flatMap(item => item.requirements).find(item => item.id === requirementId);
  const binding = checklist.handlerBindings[requirement.handlerId];
  const mediaContract = checklist.mediaContracts[requirementId];
  const snapshotFiles = [...new Set([...binding.codeFiles,
    'src/client.mjs', 'src/transport.mjs', 'src/session.mjs', 'src/grok-media-intent.mjs', 'src/journal.mjs',
    'src/contracts.mjs', 'contracts/grok-web.v1.json', 'contracts/grok-feature-checklist.v1.json', 'src/authenticated-chrome-fetch.mjs',
    'scripts/authenticated-chrome-transport.py', 'scripts/grok_media_video_submit.py',
    'scripts/verify-conversations.mjs', 'src/feature-checklist.mjs', 'src/grok-media-proof-receipts.mjs',
    'scripts/emit-grok-media-proof.mjs', 'scripts/grok_media_capture_guard.py', 'src/mp4-duration.mjs'])];
  for (const file of snapshotFiles) {
    const bytes = await readFile(path.join(SOURCE_ROOT, file));
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
  }
  const contractBytes = await readFile(path.join(SOURCE_ROOT, mediaContract.sourceEvidencePath));
  const contractTarget = path.join(root, mediaContract.sourceEvidencePath);
  await mkdir(path.dirname(contractTarget), { recursive: true, mode: 0o700 });
  await writeFile(contractTarget, contractBytes, { mode: 0o600 });
  const fixtureChecklistPath = path.join(root, 'contracts/grok-feature-checklist.v1.json');
  await mkdir(path.dirname(fixtureChecklistPath), { recursive: true, mode: 0o700 });
  await writeFile(fixtureChecklistPath, JSON.stringify(checklist), { mode: 0o600 });

  const ownerScopeSha256 = 'a'.repeat(64);
  const ownerProof = {
    schemaVersion: 1,
    serviceId: 'grok-web',
    featureId: 'auth.owner-identity',
    requirementId: 'auth.owner.read',
    operationId: 'auth.owner.read',
    ownerVerified: true,
    sameAuthenticatedOwner: true,
    evidenceScope: 'same_authenticated_owner',
    ownerScopeSha256,
  };
  const ownerProofSha256 = sha256Text(canonicalJson(ownerProof));
  const ownerProofPath = `verification/owner-proofs/${ownerProofSha256}.json`;
  const ownerProofFile = path.join(root, ownerProofPath);
  await mkdir(path.dirname(ownerProofFile), { recursive: true, mode: 0o700 });
  await writeFile(ownerProofFile, JSON.stringify(ownerProof), { mode: 0o600 });
  const ownerProofDocuments = { [ownerProofPath]: ownerProof };
  const currentOwnerProof = { path: ownerProofPath, canonicalSha256: ownerProofSha256, ownerScopeSha256 };

  const video = requirementId.startsWith('video.');
  const imageDownload = requirementId === 'artifact.image.download';
  const imageGenerate = requirementId === 'image.generate.wss';
  const mimeType = video || requirementId === 'artifact.video.download' ? 'video/mp4' : 'image/jpeg';
  const artifactBytes = mimeType === 'video/mp4'
    ? Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, ...Buffer.alloc(24, 0x31)])
    : Buffer.from([0xff, 0xd8, 0xff, ...Buffer.alloc(31, 0x31)]);
  const artifactCount = imageGenerate ? 4 : 1;
  const artifacts = [];
  const artifactFilePaths = [];
  for (let index = 0; index < artifactCount; index += 1) {
    const bytes = Buffer.from(artifactBytes);
    if (index > 0) bytes[bytes.length - 1] = index;
    const artifactFilePath = path.join(artifactRoot, `verified-output-${index}.bin`);
    await writeFile(artifactFilePath, bytes, { mode: 0o600 });
    artifacts.push({ httpStatus: 200, mimeType, bytes: bytes.length, sha256: digest(bytes), magicVerified: true,
      independentFileReadback: true, taskAssetMatched: true });
    artifactFilePaths.push(artifactFilePath);
    bytes.fill(0);
  }
  const now = new Date().toISOString();
  const observedAt = now;
  const operationContractSnapshot = await snapshotGrokMediaOperationContracts(root);
  const sourceFiles = Object.fromEntries(await Promise.all(binding.codeFiles.map(async file => [file,
    digest(await readFile(path.join(root, file)))])));
  const readbacks = ['media.assets.list', 'conversation.read', 'history.response-nodes', 'history.load-responses']
    .map((operationId, index) => ({ operationId, httpStatus: 200, responseBytes: 512 + index,
      responseDigest: (index + 1).toString(16).padStart(64, '0'), responseDigestKind: 'raw_http_body' }));
  const semanticReadback = video
    ? { taskBoundToIntent: true, exactPromptMatched: true, sourceImageTaskVerified: requirementId === 'video.image-reference-to-video',
      uniqueTaskCount: 1, assetCount: 1, privateGeneratedAssetCount: 1, expectedAssetCount: 1,
      sameConversationResponseSet: true, allAssetDownloadsVerified: true, allAssetMagicVerified: true, allFileReadbacksVerified: true }
      : imageGenerate
      ? { taskBoundToIntent: true, exactPromptMatched: true, uniqueTaskCount: 1, assetCount: 4,
        privateGeneratedAssetCount: 4, expectedAssetCount: 4, sameConversationResponseSet: true,
        allAssetDownloadsVerified: true, allAssetMagicVerified: true, allFileReadbacksVerified: true }
      : { taskBoundToIntent: true, exactPromptMatched: true, assetOwnerVerified: true,
        assetPromptMatched: true, sourceConversationMatched: true };
  const browserCapture = {
    captureMode: imageGenerate ? 'websocket_frame_blocked' : video ? 'http_request_aborted' : 'native_read_capture',
    pageRoleMatched: true,
    intentMatched: true,
    requestCaptured: true,
    businessActionBlocked: !(!imageGenerate && !video),
    networkFailureCorrelated: video,
    browserBusinessWritesDelivered: 0,
    browserResponseCount: imageGenerate || video ? 0 : 1,
    rawRequestPersisted: false,
    rawResponsePersisted: false,
    ...((video || imageGenerate) ? { requestBodyDigest: 'f'.repeat(64) } : {}),
  };
  const requestDigest = imageGenerate ? 'a'.repeat(64) : 'b'.repeat(64);
  const directTransport = video
    ? { transport: 'http', origin: 'https://grok.com', path: '/rest/app-chat/conversations/new', method: 'POST',
      requestStarted: true, responseReceived: true, httpStatus: 200, responseMime: 'application/json', responseBytes: 240,
      responseDigest: 'c'.repeat(64), responseDigestKind: 'raw_http_body', requestBodyDigest: browserCapture.requestBodyDigest,
      directDispatchCount: 1, automaticRetries: 0, tlsVerified: true, redirectsFollowed: false, trustEnv: false, attemptCount: 1 }
    : imageGenerate
      ? { transport: 'wss', origin: 'wss://grok.com', path: '/ws/imagine/listen', handshakeStatus: 101,
        controlFramesSent: 1, businessFramesSent: 1, requestStarted: true, responseReceived: false,
        requestBodyDigest: browserCapture.requestBodyDigest,
        directDispatchCount: 1, automaticRetries: 0, attemptCount: 1 }
      : { transport: 'asset_http', origin: 'https://assets.grok.com', path: '/users/{owner}/generated/{assetKey}', method: 'GET',
        requestStarted: true, responseReceived: true, httpStatus: 200, responseMime: mimeType, responseBytes: artifacts[0].bytes,
        responseDigest: artifacts[0].sha256, directDispatchCount: 1, automaticRetries: 0, tlsVerified: true,
        redirectsFollowed: false, trustEnv: false, attemptCount: 1 };
  const receiptInput = {
    schemaVersion: 1,
    recordType: 'grok-media-source-bound-run',
    requirementId,
    observedAt,
    sourceExecution: { capturedAt: now, capturedBeforeDispatch: true, stableThroughReadback: true,
      codeSha256: sourceFiles, ...operationContractSnapshot },
    owner: { verified: true, sameAuthenticatedOwner: true, proofPath: ownerProofPath,
      canonicalSha256: ownerProofSha256, ownerScopeSha256, identityReceiptSha256: ownerProofSha256 },
    requestDigest,
    intentDigest: 'd'.repeat(64),
    promptSha256: 'e'.repeat(64),
    ...(video ? { generationMode: requirementId === 'video.image-reference-to-video' ? 'image_reference' : 'text' } : {}),
    browserCapture,
    directTransport,
    operationReadbacks: readbacks,
    semanticReadback,
    artifacts,
    persistenceAssertions: Object.fromEntries(FALSE_PERSISTENCE_FIELDS.map(key => [key, false])),
  };
  return {
    root, artifactRoot, checklist, requirementId, runRecord: receiptInput, artifactFilePaths,
    ownerProofDocuments, currentOwnerProof,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('source-bound image-reference video evidence becomes a validated canonical receipt and is rechecked', async () => {
  const f = await fixture('video.image-reference-to-video');
  try {
    const extraFile = 'src/client.mjs';
    const extraBytes = await readFile(path.join(SOURCE_ROOT, extraFile));
    await mkdir(path.dirname(path.join(f.root, extraFile)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(f.root, extraFile), extraBytes, { mode: 0o600 });
    f.runRecord.sourceExecution.codeSha256[extraFile] = digest(extraBytes);
    const result = await createGrokMediaProofReceipt({ ...f, repoRoot: f.root, recordedAt: f.runRecord.observedAt });
    assert.equal(result.status, 'ready');
    assert.equal(result.receipt.sourceCodeSnapshotAt, f.runRecord.sourceExecution.capturedAt);
    assert.equal(result.receipt.operationContractSnapshotAt, f.runRecord.sourceExecution.capturedAt);
    assert.deepEqual(result.receipt.operationContractSha256, f.runRecord.sourceExecution.operationContractSha256);
    assert.equal(result.receipt.registryPolicySha256, f.runRecord.sourceExecution.registryPolicySha256);
    assert.equal(result.receipt.generationMode, 'image_reference');
    assert.equal(result.receipt.codeSha256[extraFile], digest(extraBytes));
    validateFeatureReceipts([result.receipt]);
    const emitted = await emitGrokMediaProofReceipt({ ...f, repoRoot: f.root, recordedAt: f.runRecord.observedAt });
    assert.equal(emitted.status, 'ready');
    assert.equal(emitted.receiptPath, 'verification/grok-feature-live-receipts/media-video.image-reference-to-video.json');
    const reloaded = await readGrokMediaProofReceipt({ ...f, repoRoot: f.root });
    assert.equal(reloaded.status, 'verified');
    assert.equal(reloaded.codeCurrent, true);
    assert.equal(reloaded.ownerProofBound, true);
    assert.equal(reloaded.operationContractsCurrent, true);
    assert.equal(reloaded.artifactBytesRecheckedThisRun, false);
    await assert.rejects(emitGrokMediaProofReceipt({ ...f, repoRoot: f.root, recordedAt: f.runRecord.observedAt }),
      error => error?.code === 'MEDIA_PROOF_RECEIPT_ALREADY_EXISTS');
  } finally { await f.close(); }
});

test('media contract snapshots ignore unrelated registry edits and reject scoped operation or origin-policy drift', async () => {
  const f = await fixture('artifact.image.download');
  try {
    const registryPath = path.join(f.root, 'contracts/grok-web.v1.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry.operations.find(item => item.id === 'public.models').evidence.capturedAt = '2026-10-04';
    await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
    const unrelatedEdit = await createGrokMediaProofReceipt({ ...f, repoRoot: f.root, recordedAt: f.runRecord.observedAt });
    assert.equal(unrelatedEdit.status, 'ready');
    const unrelatedVerify = await verifyGrokMediaProofReceipt({ ...f, repoRoot: f.root, receipt: unrelatedEdit.receipt });
    assert.equal(unrelatedVerify.status, 'verified');

    registry.operations.find(item => item.id === 'media.assets.list').evidence.capturedAt = '2026-10-05';
    await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
    await assert.rejects(verifyGrokMediaProofReceipt({ ...f, repoRoot: f.root, receipt: unrelatedEdit.receipt }),
      error => error?.code === 'MEDIA_PROOF_OPERATION_CONTRACT_DRIFT');
    const operationDrift = await createGrokMediaProofReceipt({ ...f, repoRoot: f.root, recordedAt: f.runRecord.observedAt });
    assert.equal(operationDrift.status, 'incomplete');
    assert.deepEqual(operationDrift.blockers, [
      'sourceExecution.operationContractSha256.media.assets.list:CURRENT_CONTRACT_DRIFT',
    ]);

    registry.operations.find(item => item.id === 'media.assets.list').evidence.capturedAt = '2026-10-06';
    registry.allowedOrigins.push('https://assets.grok.com');
    await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
    await assert.rejects(verifyGrokMediaProofReceipt({ ...f, repoRoot: f.root, receipt: unrelatedEdit.receipt }),
      error => error?.code === 'MEDIA_PROOF_OPERATION_CONTRACT_DRIFT');
    const policyDrift = await createGrokMediaProofReceipt({ ...f, repoRoot: f.root, recordedAt: f.runRecord.observedAt });
    assert.equal(policyDrift.status, 'incomplete');
    assert.deepEqual(policyDrift.blockers, ['sourceExecution.registryPolicySha256:CURRENT_POLICY_DRIFT']);
  } finally { await f.close(); }
});

test('image asset download evidence requires a current source snapshot and disk bytes matching MIME magic', async () => {
  const f = await fixture('artifact.image.download');
  try {
    const result = await createGrokMediaProofReceipt({ ...f, repoRoot: f.root, recordedAt: f.runRecord.observedAt });
    assert.equal(result.status, 'ready');
    assert.equal(result.receipt.directTransport.transport, 'asset_http');
    assert.equal(result.receipt.artifact[0].mimeType, 'image/jpeg');
    validateFeatureReceipts([result.receipt]);
  } finally { await f.close(); }
});

test('WSS batch-four evidence is emitted only after every task-bound image file is independently reread', async () => {
  const f = await fixture('image.generate.wss');
  try {
    const result = await createGrokMediaProofReceipt({ ...f, repoRoot: f.root, recordedAt: f.runRecord.observedAt });
    assert.equal(result.status, 'ready');
    assert.equal(result.receipt.artifact.length, 4);
    assert.equal(result.receipt.directTransport.handshakeStatus, 101);
    validateFeatureReceipts([result.receipt]);
  } finally { await f.close(); }
});

test('historical records missing execution hashes return exact gaps and cannot be stamped with current hashes', async () => {
  const f = await fixture('video.image-reference-to-video');
  try {
    const historical = {
      schemaVersion: 1,
      recordType: 'grok-media-source-bound-run',
      requirementId: 'video.image-reference-to-video',
      observedAt: f.runRecord.observedAt,
      sourceExecution: { capturedAt: f.runRecord.observedAt, capturedBeforeDispatch: true, stableThroughReadback: true },
    };
    const result = await createGrokMediaProofReceipt({ ...f, runRecord: historical, repoRoot: f.root });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.receipt, null);
    assert.ok(result.missingFields.includes('sourceExecution.codeSha256.src/grok-media-operations.mjs'));
    assert.ok(result.missingFields.includes('owner.proofPath'));
    assert.ok(result.missingFields.includes('directTransport'));
  } finally { await f.close(); }
});

test('execution-time code mismatch and wrong owner scope both fail closed', async () => {
  const f = await fixture('artifact.video.download');
  try {
    const codeFile = f.runRecord.sourceExecution.codeSha256 && Object.keys(f.runRecord.sourceExecution.codeSha256)[0];
    f.runRecord.sourceExecution.codeSha256[codeFile] = 'f'.repeat(64);
    const drift = await createGrokMediaProofReceipt({ ...f, repoRoot: f.root, recordedAt: f.runRecord.observedAt });
    assert.equal(drift.status, 'incomplete');
    assert.equal(drift.blockers[0], `sourceExecution.codeSha256.${codeFile}:CURRENT_SOURCE_DRIFT`);
    f.runRecord.sourceExecution.codeSha256[codeFile] = digest(await readFile(path.join(f.root, codeFile)));
    f.currentOwnerProof = { ...f.currentOwnerProof, ownerScopeSha256: 'f'.repeat(64) };
    await assert.rejects(createGrokMediaProofReceipt({ ...f, repoRoot: f.root }),
      error => error?.code === 'MEDIA_PROOF_CURRENT_OWNER_MISMATCH');
  } finally { await f.close(); }
});

test('media readback evidence refuses parsed-data hashes when the raw response hash is missing', async () => {
  const f = await fixture('video.text-to-video');
  try {
    f.runRecord.operationReadbacks[1].responseDigestKind = 'parsed_json_data';
    const result = await createGrokMediaProofReceipt({ ...f, repoRoot: f.root, recordedAt: f.runRecord.observedAt });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.receipt, null);
    assert.ok(result.missingFields.includes('operationReadbacks[1].responseDigestKind=raw_http_body'));
  } finally { await f.close(); }
});

test('artifact symlink is rejected even when the target bytes match the claimed asset', async () => {
  const f = await fixture('artifact.image.download');
  try {
    const link = path.join(f.artifactRoot, 'linked-output.bin');
    await import('node:fs/promises').then(({ symlink }) => symlink(f.artifactFilePaths[0], link));
    f.artifactFilePaths[0] = link;
    const result = await createGrokMediaProofReceipt({ ...f, repoRoot: f.root, recordedAt: f.runRecord.observedAt });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.blockers[0], 'MEDIA_PROOF_ARTIFACT_FILE_INVALID_0');
  } finally { await f.close(); }
});
