import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalJson,
  grokMediaOperationContractSnapshot,
  sha256Text,
  validateFeatureChecklist,
  validateFeatureReceipts,
} from './feature-checklist.mjs';
import { validateContractRegistry } from './contracts.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/;
const REQUIRED_READBACKS = Object.freeze([
  'media.assets.list', 'conversation.read', 'history.response-nodes', 'history.load-responses',
]);
const OPERATION_CONTRACT_IDS = Object.freeze(['auth.owner.read', ...REQUIRED_READBACKS]);
const OPERATION_REGISTRY_PATH = 'contracts/grok-web.v1.json';
const PERSISTENCE_FALSE_KEYS = Object.freeze([
  'credentialValuesPersisted', 'cookiesPersisted', 'tokensPersisted', 'requestBodiesPersisted',
  'responseBodiesPersisted', 'signedUrlValuesPersisted', 'passwordValuesPersisted',
  'conversationIdsPersisted', 'conversationTitlesPersisted', 'responseIdsPersisted', 'messageBodiesPersisted',
  'rawFramesPersisted', 'assetBytesPersisted', 'assetIdsPersisted', 'promptPersisted',
  'rawIdsOrKeysOrUrlsPersisted', 'cookiesOrTokensPersisted',
]);
const OPERATION_SHAPES = Object.freeze({
  'image.generate.wss': {
    featureId: 'image-generation', operationId: 'media.image.create', handlerId: 'media.image-wss',
    mode: 'direct_wss_imagine_image_batch4', execution: 'direct_wss_client', captureMode: 'websocket_frame_blocked',
  },
  'video.text-to-video': {
    featureId: 'video-generation', operationId: 'media.video.create', handlerId: 'media.video-submit',
    mode: 'owner_bound_media_http_one_shot', execution: 'direct_http_client', captureMode: 'http_request_aborted',
  },
  'video.image-reference-to-video': {
    featureId: 'video-generation', operationId: 'media.video.create', handlerId: 'media.video-submit',
    mode: 'owner_bound_media_http_one_shot', execution: 'direct_http_client', captureMode: 'http_request_aborted',
  },
  'artifact.image.download': {
    featureId: 'artifact-download', operationId: 'media.asset.download', handlerId: 'media.asset-download',
    mode: 'owner_bound_generated_asset_download', execution: 'direct_http_client', captureMode: 'native_read_capture',
  },
  'artifact.video.download': {
    featureId: 'artifact-download', operationId: 'media.asset.download', handlerId: 'media.asset-download',
    mode: 'owner_bound_generated_asset_download', execution: 'direct_http_client', captureMode: 'native_read_capture',
  },
});

export class GrokMediaProofError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GrokMediaProofError';
    this.code = code;
  }
}

function fail(code) { return new GrokMediaProofError(code); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isSha(value) { return typeof value === 'string' && SHA256.test(value); }
function isIso(value) { return typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value)); }
function has(value, key) { return Object.prototype.hasOwnProperty.call(value ?? {}, key); }
function pushMissing(missingFields, condition, field) { if (!condition) missingFields.push(field); }

function safeRelative(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && !value.includes('\\') && !value.includes('\0')
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}

function expectedFor(requirementId, checklist) {
  const expected = OPERATION_SHAPES[requirementId];
  if (!expected) throw fail('MEDIA_PROOF_REQUIREMENT_INVALID');
  const feature = checklist.features.find(item => item.id === expected.featureId);
  const requirement = feature?.requirements.find(item => item.id === requirementId);
  const binding = checklist.handlerBindings[expected.handlerId];
  const mediaContract = checklist.mediaContracts?.[requirementId];
  if (!feature || !requirement || !binding || !mediaContract
    || requirement.operationId !== expected.operationId || requirement.handlerId !== expected.handlerId) {
    throw fail('MEDIA_PROOF_CHECKLIST_BINDING_INVALID');
  }
  return { expected, feature, requirement, binding, mediaContract };
}

export function requiredGrokMediaProofFields(requirementId, codeFiles = []) {
  if (!OPERATION_SHAPES[requirementId]) throw fail('MEDIA_PROOF_REQUIREMENT_INVALID');
  const fields = [
    'schemaVersion=1', 'recordType=grok-media-source-bound-run', `requirementId=${requirementId}`,
    'observedAt', 'sourceExecution.capturedAt', 'sourceExecution.capturedBeforeDispatch=true',
    'sourceExecution.stableThroughReadback=true',
    'sourceExecution.registryPolicySha256',
    ...OPERATION_CONTRACT_IDS.map(operationId => `sourceExecution.operationContractSha256.${operationId}`),
    ...codeFiles.map(file => `sourceExecution.codeSha256.${file}`),
    'owner.verified=true', 'owner.sameAuthenticatedOwner=true', 'owner.proofPath',
    'owner.canonicalSha256', 'owner.ownerScopeSha256', 'owner.identityReceiptSha256',
    'currentOwnerProof.path/canonicalSha256/ownerScopeSha256 (same scope)',
    'requestDigest', 'intentDigest', 'promptSha256',
    'browserCapture.pageRoleMatched=true', 'browserCapture.intentMatched=true', 'browserCapture.requestCaptured=true',
    'browserCapture.rawRequestPersisted=false', 'browserCapture.rawResponsePersisted=false',
    'directTransport', 'operationReadbacks[media.assets.list,conversation.read,history.response-nodes,history.load-responses] (HTTP 200/bytes/raw-body SHA-256)',
    'semanticReadback', 'artifacts[].httpStatus/mimeType/bytes/sha256/magicVerified/independentFileReadback/taskAssetMatched',
    'artifactFilePaths[] (ephemeral; exact bytes rechecked)',
    'persistenceAssertions (all false)',
    'mediaContract.sourceEvidencePath/sourceEvidenceSha256 (current file hash matches)',
    'artifactRoot (ephemeral; artifactFilePaths remain in-memory only)',
  ];
  if (requirementId === 'image.generate.wss' || requirementId.startsWith('video.')) {
    fields.push('browserCapture.requestBodyDigest=SHA-256 of exact aborted native body/frame');
  }
  if (requirementId === 'video.text-to-video') fields.push('generationMode=text');
  if (requirementId === 'video.image-reference-to-video') fields.push('generationMode=image_reference');
  return fields;
}

function inspectRunShape(requirementId, runRecord, codeFiles, artifactFilePaths = []) {
  const missingFields = [];
  const invalidFields = [];
  if (!isRecord(runRecord)) return { missingFields: ['runRecord'], invalidFields };
  pushMissing(missingFields, runRecord.schemaVersion === 1, 'schemaVersion=1');
  pushMissing(missingFields, runRecord.recordType === 'grok-media-source-bound-run', 'recordType=grok-media-source-bound-run');
  pushMissing(missingFields, runRecord.requirementId === requirementId, `requirementId=${requirementId}`);
  pushMissing(missingFields, isIso(runRecord.observedAt), 'observedAt');

  const source = runRecord.sourceExecution;
  pushMissing(missingFields, isRecord(source), 'sourceExecution');
  pushMissing(missingFields, isIso(source?.capturedAt), 'sourceExecution.capturedAt');
  pushMissing(missingFields, source?.capturedBeforeDispatch === true, 'sourceExecution.capturedBeforeDispatch=true');
  pushMissing(missingFields, source?.stableThroughReadback === true, 'sourceExecution.stableThroughReadback=true');
  const snapshots = isRecord(source?.codeSha256) ? source.codeSha256 : {};
  for (const file of codeFiles) pushMissing(missingFields, isSha(snapshots[file]), `sourceExecution.codeSha256.${file}`);
  for (const file of Object.keys(snapshots)) {
    const sourcePath = (safeRelative(file, 'src/') || safeRelative(file, 'scripts/'))
      && /\.(?:mjs|js|py|txt)$/.test(file);
    const contractPath = safeRelative(file, 'contracts/') && /\.json$/.test(file);
    if (!sourcePath && !contractPath) {
      invalidFields.push(`sourceExecution.codeSha256.${file}:INVALID_FILE`);
    } else if (!isSha(snapshots[file])) {
      missingFields.push(`sourceExecution.codeSha256.${file}`);
    }
  }
  const operationHashes = isRecord(source?.operationContractSha256) ? source.operationContractSha256 : {};
  pushMissing(missingFields, isSha(source?.registryPolicySha256), 'sourceExecution.registryPolicySha256');
  for (const operationId of OPERATION_CONTRACT_IDS) {
    pushMissing(missingFields, isSha(operationHashes[operationId]),
      `sourceExecution.operationContractSha256.${operationId}`);
  }
  for (const operationId of Object.keys(operationHashes)) {
    if (!OPERATION_CONTRACT_IDS.includes(operationId)) {
      invalidFields.push(`sourceExecution.operationContractSha256.${operationId}:UNDECLARED_OPERATION`);
    } else if (!isSha(operationHashes[operationId])) {
      missingFields.push(`sourceExecution.operationContractSha256.${operationId}`);
    }
  }
  for (const key of Object.keys(source ?? {})) {
    if (!['capturedAt', 'capturedBeforeDispatch', 'stableThroughReadback', 'codeSha256',
      'operationContractSha256', 'registryPolicySha256'].includes(key)) {
      invalidFields.push(`sourceExecution.${key}:UNDECLARED_FIELD`);
    }
  }

  const owner = runRecord.owner;
  pushMissing(missingFields, isRecord(owner), 'owner');
  pushMissing(missingFields, owner?.verified === true, 'owner.verified=true');
  pushMissing(missingFields, owner?.sameAuthenticatedOwner === true, 'owner.sameAuthenticatedOwner=true');
  pushMissing(missingFields, typeof owner?.proofPath === 'string', 'owner.proofPath');
  pushMissing(missingFields, isSha(owner?.canonicalSha256), 'owner.canonicalSha256');
  pushMissing(missingFields, isSha(owner?.ownerScopeSha256), 'owner.ownerScopeSha256');
  pushMissing(missingFields, isSha(owner?.identityReceiptSha256), 'owner.identityReceiptSha256');
  for (const key of Object.keys(owner ?? {})) {
    if (!['verified', 'sameAuthenticatedOwner', 'proofPath', 'canonicalSha256', 'ownerScopeSha256', 'identityReceiptSha256'].includes(key)) {
      invalidFields.push(`owner.${key}:UNDECLARED_FIELD`);
    }
  }

  for (const [key, label] of [['requestDigest', 'requestDigest'], ['intentDigest', 'intentDigest'], ['promptSha256', 'promptSha256']]) {
    pushMissing(missingFields, isSha(runRecord[key]), label);
  }
  const expected = OPERATION_SHAPES[requirementId];
  const browser = runRecord.browserCapture;
  pushMissing(missingFields, isRecord(browser), 'browserCapture');
  for (const key of ['pageRoleMatched', 'intentMatched', 'requestCaptured']) {
    pushMissing(missingFields, browser?.[key] === true, `browserCapture.${key}=true`);
  }
  pushMissing(missingFields, browser?.captureMode === expected.captureMode, `browserCapture.captureMode=${expected.captureMode}`);
  pushMissing(missingFields, browser?.rawRequestPersisted === false, 'browserCapture.rawRequestPersisted=false');
  pushMissing(missingFields, browser?.rawResponsePersisted === false, 'browserCapture.rawResponsePersisted=false');
  pushMissing(missingFields, browser?.browserBusinessWritesDelivered === 0, 'browserCapture.browserBusinessWritesDelivered=0');
  pushMissing(missingFields, typeof browser?.businessActionBlocked === 'boolean', 'browserCapture.businessActionBlocked');
  pushMissing(missingFields, typeof browser?.networkFailureCorrelated === 'boolean', 'browserCapture.networkFailureCorrelated');
  pushMissing(missingFields, Number.isSafeInteger(browser?.browserResponseCount) && browser.browserResponseCount >= 0,
    'browserCapture.browserResponseCount');
  if (requirementId === 'image.generate.wss' || requirementId.startsWith('video.')) {
    pushMissing(missingFields, isSha(browser?.requestBodyDigest), 'browserCapture.requestBodyDigest');
  }

  const direct = runRecord.directTransport;
  pushMissing(missingFields, isRecord(direct), 'directTransport');
  const requiredDirectKeys = requirementId === 'image.generate.wss'
    ? ['transport', 'origin', 'path', 'handshakeStatus', 'businessFramesSent', 'requestStarted', 'responseReceived',
      'directDispatchCount', 'automaticRetries', 'attemptCount']
    : ['transport', 'origin', 'path', 'method', 'requestStarted', 'responseReceived', 'httpStatus', 'responseMime',
      'responseBytes', 'responseDigest', 'directDispatchCount', 'automaticRetries', 'tlsVerified', 'redirectsFollowed',
      'trustEnv', 'attemptCount'];
  for (const key of requiredDirectKeys) pushMissing(missingFields, has(direct, key), `directTransport.${key}`);
  if (requirementId.startsWith('video.')) {
    for (const key of ['requestBodyDigest', 'responseDigestKind']) pushMissing(missingFields, has(direct, key), `directTransport.${key}`);
  }
  if (Array.isArray(runRecord.operationReadbacks) && runRecord.operationReadbacks.length === REQUIRED_READBACKS.length) {
    runRecord.operationReadbacks.forEach((item, index) => {
      const prefix = `operationReadbacks[${index}]`;
      pushMissing(missingFields, item?.operationId === REQUIRED_READBACKS[index], `${prefix}.operationId=${REQUIRED_READBACKS[index]}`);
      pushMissing(missingFields, item?.httpStatus === 200, `${prefix}.httpStatus=200`);
      pushMissing(missingFields, Number.isSafeInteger(item?.responseBytes) && item.responseBytes > 0, `${prefix}.responseBytes`);
      pushMissing(missingFields, isSha(item?.responseDigest), `${prefix}.responseDigest`);
      pushMissing(missingFields, item?.responseDigestKind === 'raw_http_body', `${prefix}.responseDigestKind=raw_http_body`);
    });
  } else pushMissing(missingFields, false, 'operationReadbacks[4]');
  pushMissing(missingFields, isRecord(runRecord.semanticReadback), 'semanticReadback');
  const semanticKeys = requirementId === 'image.generate.wss'
    ? { booleans: ['taskBoundToIntent', 'exactPromptMatched', 'sameConversationResponseSet', 'allAssetDownloadsVerified',
      'allAssetMagicVerified', 'allFileReadbacksVerified'], counts: ['uniqueTaskCount', 'assetCount', 'privateGeneratedAssetCount', 'expectedAssetCount'] }
    : requirementId.startsWith('video.')
      ? { booleans: ['taskBoundToIntent', 'exactPromptMatched', 'sameConversationResponseSet', 'allAssetDownloadsVerified',
        'allAssetMagicVerified', 'allFileReadbacksVerified', ...(requirementId === 'video.image-reference-to-video' ? ['sourceImageTaskVerified'] : [])],
        counts: ['uniqueTaskCount', 'assetCount', 'privateGeneratedAssetCount', 'expectedAssetCount'] }
      : { booleans: ['taskBoundToIntent', 'exactPromptMatched', 'assetOwnerVerified', 'assetPromptMatched', 'sourceConversationMatched'], counts: [] };
  for (const key of semanticKeys.booleans) pushMissing(missingFields, runRecord.semanticReadback?.[key] === true, `semanticReadback.${key}=true`);
  for (const key of semanticKeys.counts) pushMissing(missingFields, Number.isSafeInteger(runRecord.semanticReadback?.[key]), `semanticReadback.${key}`);
  if (requirementId.startsWith('video.')) pushMissing(missingFields,
    runRecord.generationMode === (requirementId === 'video.image-reference-to-video' ? 'image_reference' : 'text'),
    `generationMode=${requirementId === 'video.image-reference-to-video' ? 'image_reference' : 'text'}`);
  const expectedArtifacts = requirementId === 'image.generate.wss' ? 4 : 1;
  pushMissing(missingFields, Array.isArray(runRecord.artifacts)
    && runRecord.artifacts.length === expectedArtifacts, `artifacts[${expectedArtifacts}]`);
  pushMissing(missingFields, Array.isArray(artifactFilePaths)
    && artifactFilePaths.length === expectedArtifacts, `artifactFilePaths[${expectedArtifacts}] (ephemeral input)`);
  if (Array.isArray(runRecord.artifacts) && runRecord.artifacts.length === expectedArtifacts) {
    runRecord.artifacts.forEach((artifact, index) => {
      const prefix = `artifacts[${index}]`;
      pushMissing(missingFields, artifact?.httpStatus === 200, `${prefix}.httpStatus=200`);
      pushMissing(missingFields, typeof artifact?.mimeType === 'string', `${prefix}.mimeType`);
      pushMissing(missingFields, Number.isSafeInteger(artifact?.bytes) && artifact.bytes > 0, `${prefix}.bytes`);
      pushMissing(missingFields, isSha(artifact?.sha256), `${prefix}.sha256`);
      pushMissing(missingFields, artifact?.magicVerified === true, `${prefix}.magicVerified=true`);
      pushMissing(missingFields, artifact?.independentFileReadback === true, `${prefix}.independentFileReadback=true`);
      pushMissing(missingFields, artifact?.taskAssetMatched === true, `${prefix}.taskAssetMatched=true`);
      const allowedArtifactKeys = new Set(['httpStatus', 'mimeType', 'bytes', 'sha256', 'magicVerified', 'independentFileReadback', 'taskAssetMatched']);
      for (const key of Object.keys(artifact ?? {})) if (!allowedArtifactKeys.has(key)) invalidFields.push(`${prefix}.${key}:UNDECLARED_FIELD`);
    });
  }
  if (Array.isArray(artifactFilePaths) && artifactFilePaths.length === expectedArtifacts) {
    artifactFilePaths.forEach((value, index) => pushMissing(missingFields,
      typeof value === 'string' && path.isAbsolute(value), `artifactFilePaths[${index}]`));
  }
  pushMissing(missingFields, isRecord(runRecord.persistenceAssertions), 'persistenceAssertions');
  for (const key of PERSISTENCE_FALSE_KEYS) {
    pushMissing(missingFields, runRecord.persistenceAssertions?.[key] === false, `persistenceAssertions.${key}=false`);
  }
  const allowedRunKeys = new Set([
    'schemaVersion', 'recordType', 'requirementId', 'observedAt', 'sourceExecution', 'owner', 'requestDigest',
    'intentDigest', 'promptSha256', 'generationMode', 'browserCapture', 'directTransport', 'operationReadbacks',
    'semanticReadback', 'artifacts', 'persistenceAssertions',
  ]);
  for (const key of Object.keys(runRecord)) if (!allowedRunKeys.has(key)) invalidFields.push(`runRecord.${key}:UNDECLARED_FIELD`);
  return { missingFields: [...new Set(missingFields)], invalidFields };
}

function validOwnerProof(proof) {
  return isRecord(proof) && proof.schemaVersion === 1 && proof.serviceId === 'grok-web'
    && proof.featureId === 'auth.owner-identity' && proof.requirementId === 'auth.owner.read'
    && proof.operationId === 'auth.owner.read' && proof.ownerVerified === true
    && proof.sameAuthenticatedOwner === true && proof.evidenceScope === 'same_authenticated_owner'
    && isSha(proof.ownerScopeSha256);
}

function safeOwnerProofPath(value) {
  return typeof value === 'string' && !value.includes('\\') && !value.includes('\0')
    && (/^verification\/owner-proofs\/[a-f0-9]{64}\.json$/.test(value)
      || /^verification\/conversation-read-runs\/[A-Za-z0-9._:-]{1,160}\/auth-owner\.read\.json$/.test(value))
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}

async function containedPath(root, relativePath, { allowMissing = false, expected = 'file' } = {}) {
  if (typeof relativePath !== 'string' || relativePath.startsWith('/') || relativePath.includes('\\')
    || relativePath.includes('\0') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw fail('MEDIA_PROOF_PATH_INVALID');
  }
  const rootReal = await realpath(root).catch(() => { throw fail('MEDIA_PROOF_PATH_INVALID'); });
  let current = rootReal;
  const parts = relativePath.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return { path: current, missing: true };
      throw fail('MEDIA_PROOF_PATH_INVALID');
    }
    if (info.isSymbolicLink()) throw fail('MEDIA_PROOF_PATH_INVALID');
    const canonical = await realpath(current).catch(() => { throw fail('MEDIA_PROOF_PATH_INVALID'); });
    if (!canonical.startsWith(rootReal + path.sep)) throw fail('MEDIA_PROOF_PATH_INVALID');
    if (index < parts.length - 1 && !info.isDirectory()) throw fail('MEDIA_PROOF_PATH_INVALID');
    if (index === parts.length - 1 && expected === 'file' && !info.isFile()) throw fail('MEDIA_PROOF_PATH_INVALID');
    if (index === parts.length - 1 && expected === 'directory' && !info.isDirectory()) throw fail('MEDIA_PROOF_PATH_INVALID');
  }
  return { path: current, missing: false };
}

async function hashRepoFile(repoRoot, relativePath) {
  const sourcePath = (safeRelative(relativePath, 'src/') || safeRelative(relativePath, 'scripts/'))
    && /\.(?:mjs|js|py|txt)$/.test(relativePath);
  const contractPath = safeRelative(relativePath, 'contracts/') && /\.json$/.test(relativePath);
  if (!sourcePath && !contractPath) throw fail('MEDIA_PROOF_CODE_PATH_INVALID');
  const { path: filePath, missing } = await containedPath(repoRoot, relativePath, { allowMissing: true });
  if (missing) return null;
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

export async function snapshotGrokMediaOperationContracts(repoRoot) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) throw fail('MEDIA_PROOF_OPTIONS_INVALID');
  const { path: registryPath, missing } = await containedPath(repoRoot, OPERATION_REGISTRY_PATH, { allowMissing: true });
  if (missing) throw fail('MEDIA_PROOF_OPERATION_REGISTRY_MISSING');
  let registry;
  try { registry = JSON.parse(await readFile(registryPath, 'utf8')); }
  catch { throw fail('MEDIA_PROOF_OPERATION_REGISTRY_INVALID'); }
  try { validateContractRegistry(registry); }
  catch { throw fail('MEDIA_PROOF_OPERATION_REGISTRY_INVALID'); }
  if (!Array.isArray(registry.operations)) throw fail('MEDIA_PROOF_OPERATION_REGISTRY_INVALID');
  const snapshot = grokMediaOperationContractSnapshot(registry);
  if (!snapshot) throw fail('MEDIA_PROOF_OPERATION_CONTRACT_MISSING');
  return snapshot;
}

function sameDigestMap(left, right, expectedKeys) {
  return isRecord(left) && Object.keys(left).length === expectedKeys.length
    && expectedKeys.every(key => isSha(left[key]) && left[key] === right[key]);
}

async function sourceEvidence(repoRoot, mediaContract) {
  if (!safeRelative(mediaContract?.sourceEvidencePath, 'verification/') || !isSha(mediaContract?.sourceEvidenceSha256)) {
    throw fail('MEDIA_PROOF_SOURCE_EVIDENCE_MISSING');
  }
  const { path: filePath, missing } = await containedPath(repoRoot, mediaContract.sourceEvidencePath, { allowMissing: true });
  if (missing) throw fail('MEDIA_PROOF_SOURCE_EVIDENCE_MISSING');
  const bytes = await readFile(filePath);
  try { JSON.parse(bytes.toString('utf8')); } catch { throw fail('MEDIA_PROOF_SOURCE_EVIDENCE_INVALID'); }
  const digest = createHash('sha256').update(bytes).digest('hex');
  bytes.fill(0);
  if (digest !== mediaContract.sourceEvidenceSha256) throw fail('MEDIA_PROOF_SOURCE_EVIDENCE_DRIFT');
  return digest;
}

function artifactMagic(bytes, mimeType) {
  const mime = mimeType.toLowerCase();
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (mime === 'image/png') return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.subarray(12, 16).toString('ascii') === 'IHDR';
  if (mime === 'image/webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mime === 'image/gif') return bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  if (mime === 'video/mp4') return bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mime === 'video/webm') return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

async function verifyArtifactFiles(artifactRoot, artifacts, filePaths) {
  if (typeof artifactRoot !== 'string' || !path.isAbsolute(artifactRoot)) throw fail('MEDIA_PROOF_ARTIFACT_ROOT_INVALID');
  const rootInfo = await lstat(artifactRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw fail('MEDIA_PROOF_ARTIFACT_ROOT_INVALID');
  const rootReal = await realpath(artifactRoot).catch(() => { throw fail('MEDIA_PROOF_ARTIFACT_ROOT_INVALID'); });
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    const artifactPath = filePaths[index];
    if (typeof artifactPath !== 'string' || !path.isAbsolute(artifactPath)) throw fail(`MEDIA_PROOF_ARTIFACT_PATH_INVALID_${index}`);
    const resolved = path.resolve(artifactPath);
    if (!resolved.startsWith(rootReal + path.sep)) throw fail(`MEDIA_PROOF_ARTIFACT_PATH_INVALID_${index}`);
    let current = rootReal;
    const relativeParts = path.relative(rootReal, resolved).split(path.sep);
    for (let partIndex = 0; partIndex < relativeParts.length; partIndex += 1) {
      current = path.join(current, relativeParts[partIndex]);
      const info = await lstat(current).catch(() => null);
      if (!info || info.isSymbolicLink()
        || (partIndex < relativeParts.length - 1 && !info.isDirectory())
        || (partIndex === relativeParts.length - 1 && !info.isFile())) {
        throw fail(`MEDIA_PROOF_ARTIFACT_FILE_INVALID_${index}`);
      }
    }
    const fileHandle = await open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch(() => null);
    if (!fileHandle) throw fail(`MEDIA_PROOF_ARTIFACT_FILE_INVALID_${index}`);
    let bytes;
    try {
      const fileInfo = await fileHandle.stat();
      if (!fileInfo.isFile() || fileInfo.size > 256 * 1024 * 1024) throw fail(`MEDIA_PROOF_ARTIFACT_FILE_INVALID_${index}`);
      bytes = await fileHandle.readFile();
    } finally { await fileHandle.close(); }
    const digest = createHash('sha256').update(bytes).digest('hex');
    const magic = artifactMagic(bytes, artifact.mimeType);
    bytes.fill(0);
    if (bytes.length !== artifact.bytes || digest !== artifact.sha256 || !magic || artifact.magicVerified !== true
      || artifact.independentFileReadback !== true || artifact.taskAssetMatched !== true) {
      throw fail(`MEDIA_PROOF_ARTIFACT_FACT_MISMATCH_${index}`);
    }
  }
}

function assertPositiveSemantics(requirementId, run) {
  const { browserCapture: browser, directTransport: direct, semanticReadback: readback } = run;
  const commonReadbackIds = run.operationReadbacks.map(item => item?.operationId);
  if (JSON.stringify(commonReadbackIds) !== JSON.stringify(REQUIRED_READBACKS)) throw fail('MEDIA_PROOF_READBACK_OPERATIONS_INVALID');
  for (const item of run.operationReadbacks) {
    if (!isRecord(item) || item.httpStatus !== 200 || !Number.isSafeInteger(item.responseBytes) || item.responseBytes < 1
      || !isSha(item.responseDigest) || item.responseDigestKind !== 'raw_http_body') throw fail('MEDIA_PROOF_READBACK_NOT_VERIFIED');
  }
  if (browser.pageRoleMatched !== true || browser.intentMatched !== true || browser.requestCaptured !== true
    || browser.rawRequestPersisted !== false || browser.rawResponsePersisted !== false
    || browser.browserBusinessWritesDelivered !== 0 || !Number.isSafeInteger(browser.browserResponseCount)) {
    throw fail('MEDIA_PROOF_BROWSER_CAPTURE_INVALID');
  }
  if (!isRecord(direct) || direct.directDispatchCount !== 1 || direct.attemptCount !== 1 || direct.automaticRetries !== 0
    || direct.requestStarted !== true || !isRecord(readback)) throw fail('MEDIA_PROOF_DISPATCH_NOT_SINGLE');
  if (requirementId === 'image.generate.wss') {
    if (browser.captureMode !== 'websocket_frame_blocked' || browser.businessActionBlocked !== true
      || browser.browserResponseCount !== 0 || browser.networkFailureCorrelated !== false
      || direct.transport !== 'wss' || direct.handshakeStatus !== 101 || direct.businessFramesSent !== 1
      || direct.origin !== 'wss://grok.com' || direct.path !== '/ws/imagine/listen'
      || direct.requestBodyDigest !== browser.requestBodyDigest
      || readback.taskBoundToIntent !== true || readback.exactPromptMatched !== true || readback.uniqueTaskCount !== 1
      || readback.assetCount !== 4 || readback.privateGeneratedAssetCount !== 4 || readback.expectedAssetCount !== 4
      || readback.sameConversationResponseSet !== true || readback.allAssetDownloadsVerified !== true
      || readback.allAssetMagicVerified !== true || readback.allFileReadbacksVerified !== true
      || run.artifacts.length !== 4 || run.artifacts.some(item => !item.mimeType?.startsWith('image/')
        || item.httpStatus !== 200)) {
      throw fail('MEDIA_PROOF_IMAGE_SEMANTICS_INVALID');
    }
  } else if (requirementId.startsWith('video.')) {
    const imageReference = requirementId === 'video.image-reference-to-video';
    if (browser.captureMode !== 'http_request_aborted' || browser.businessActionBlocked !== true
      || browser.networkFailureCorrelated !== true || browser.browserResponseCount !== 0
      || direct.transport !== 'http' || direct.origin !== 'https://grok.com'
      || direct.path !== '/rest/app-chat/conversations/new' || direct.method !== 'POST'
      || direct.responseReceived !== true || direct.httpStatus !== 200
      || direct.responseMime?.split(';', 1)[0].toLowerCase() !== 'application/json'
      || !Number.isSafeInteger(direct.responseBytes) || direct.responseBytes < 1
      || !isSha(direct.responseDigest) || direct.responseDigestKind !== 'raw_http_body'
      || direct.requestBodyDigest !== browser.requestBodyDigest || direct.tlsVerified !== true
      || direct.redirectsFollowed !== false || direct.trustEnv !== false
      || readback.taskBoundToIntent !== true || readback.exactPromptMatched !== true || readback.uniqueTaskCount !== 1
      || readback.assetCount !== 1 || readback.privateGeneratedAssetCount !== 1 || readback.expectedAssetCount !== 1
      || readback.sameConversationResponseSet !== true || readback.allAssetDownloadsVerified !== true
      || readback.allAssetMagicVerified !== true || readback.allFileReadbacksVerified !== true
      || (imageReference && readback.sourceImageTaskVerified !== true)
      || run.artifacts.length !== 1 || run.artifacts[0]?.mimeType !== 'video/mp4'
      || run.artifacts[0]?.httpStatus !== 200) throw fail('MEDIA_PROOF_VIDEO_SEMANTICS_INVALID');
    if (run.generationMode !== (imageReference ? 'image_reference' : 'text')) throw fail('MEDIA_PROOF_GENERATION_MODE_INVALID');
  } else {
    const image = requirementId === 'artifact.image.download';
    if (browser.captureMode !== 'native_read_capture' || browser.businessActionBlocked !== false
      || browser.browserResponseCount < 1 || direct.transport !== 'asset_http'
      || direct.origin !== 'https://assets.grok.com' || direct.path !== '/users/{owner}/generated/{assetKey}'
      || direct.method !== 'GET' || direct.responseReceived !== true || direct.httpStatus !== 200
      || direct.tlsVerified !== true || direct.redirectsFollowed !== false || direct.trustEnv !== false
      || !Number.isSafeInteger(direct.responseBytes) || direct.responseBytes < 1 || !isSha(direct.responseDigest)
      || direct.responseBytes !== run.artifacts[0]?.bytes || direct.responseDigest !== run.artifacts[0]?.sha256
      || direct.httpStatus !== run.artifacts[0]?.httpStatus
      || direct.responseMime?.split(';', 1)[0].toLowerCase() !== run.artifacts[0]?.mimeType?.toLowerCase()
      || readback.taskBoundToIntent !== true || readback.exactPromptMatched !== true
      || readback.assetOwnerVerified !== true || readback.assetPromptMatched !== true
      || readback.sourceConversationMatched !== true
      || (image ? !run.artifacts[0]?.mimeType.startsWith('image/') : run.artifacts[0]?.mimeType !== 'video/mp4')) {
      throw fail('MEDIA_PROOF_DOWNLOAD_SEMANTICS_INVALID');
    }
  }
}

function validateCurrentOwnerProof({ runRecord, ownerProofDocuments, currentOwnerProof }) {
  const owner = runRecord.owner;
  if (owner?.verified !== true || owner?.sameAuthenticatedOwner !== true) throw fail('MEDIA_PROOF_OWNER_NOT_VERIFIED');
  const proofPath = owner.proofPath;
  if (!safeOwnerProofPath(proofPath)) throw fail('MEDIA_PROOF_OWNER_PATH_INVALID');
  const proof = ownerProofDocuments?.[proofPath];
  if (!validOwnerProof(proof)) throw fail('MEDIA_PROOF_OWNER_DOCUMENT_MISSING');
  const digest = sha256Text(canonicalJson(proof));
  if (digest !== owner.canonicalSha256 || owner.identityReceiptSha256 !== digest
    || owner.ownerScopeSha256 !== proof.ownerScopeSha256) throw fail('MEDIA_PROOF_OWNER_DOCUMENT_MISMATCH');
  if (proofPath.startsWith('verification/owner-proofs/')
    && proofPath !== `verification/owner-proofs/${digest}.json`) throw fail('MEDIA_PROOF_OWNER_PATH_MISMATCH');
  if (!isRecord(currentOwnerProof) || !safeRelative(currentOwnerProof.path, 'verification/')) throw fail('MEDIA_PROOF_CURRENT_OWNER_MISSING');
  const current = ownerProofDocuments?.[currentOwnerProof.path];
  if (!validOwnerProof(current) || sha256Text(canonicalJson(current)) !== currentOwnerProof.canonicalSha256
    || current.ownerScopeSha256 !== owner.ownerScopeSha256
    || currentOwnerProof.ownerScopeSha256 !== owner.ownerScopeSha256) throw fail('MEDIA_PROOF_CURRENT_OWNER_MISMATCH');
  return { proofPath, proof, digest, ownerScopeSha256: proof.ownerScopeSha256 };
}

function buildCanonicalReceipt(requirementId, runRecord, sourceCodeSnapshotAt, owner, mediaContract, recordedAt) {
  const shape = OPERATION_SHAPES[requirementId];
  const receipt = {
    schemaVersion: 2,
    serviceId: 'grok-web',
    evidenceClass: 'direct_media_operation_replay',
    featureId: shape.featureId,
    requirementId,
    operationId: shape.operationId,
    observedAt: runRecord.observedAt,
    recordedAt,
    execution: shape.execution,
    liveReplay: true,
    liveReplayRecorded: true,
    mocked: false,
    ownerVerified: true,
    sameAuthenticatedOwner: true,
    evidenceScope: 'same_authenticated_owner',
    ownerIdentityReceiptSha256: owner.digest,
    ownerProofPath: owner.proofPath,
    ownerProofSha256: owner.digest,
    ownerScopeSha256: owner.ownerScopeSha256,
    handlerId: shape.handlerId,
    dispatchBinding: {
      handlerId: shape.handlerId,
      operationId: shape.operationId,
      operationKind: requirementId.startsWith('artifact.') ? 'download' : 'submit',
      mode: shape.mode,
    },
    mediaContractSha256: sha256Text(canonicalJson(mediaContract)),
    operationContractSnapshotAt: runRecord.sourceExecution.capturedAt,
    operationContractSha256: runRecord.sourceExecution.operationContractSha256,
    registryPolicySha256: runRecord.sourceExecution.registryPolicySha256,
    requestDigest: runRecord.requestDigest,
    intentDigest: runRecord.intentDigest,
    promptSha256: runRecord.promptSha256,
    sourceCodeSnapshotAt,
    browserCapture: runRecord.browserCapture,
    directTransport: runRecord.directTransport,
    operationReadbacks: runRecord.operationReadbacks,
    semanticReadback: runRecord.semanticReadback,
    artifact: runRecord.artifacts.map(({ httpStatus, mimeType, bytes, sha256, magicVerified, independentFileReadback, taskAssetMatched }) => ({
      httpStatus, mimeType, bytes, sha256, magicVerified, independentFileReadback, taskAssetMatched,
    })),
    codeSha256: runRecord.sourceExecution.codeSha256,
    codeHashCapturedAtExecution: true,
    persistenceAssertions: runRecord.persistenceAssertions,
  };
  if (requirementId.startsWith('video.')) receipt.generationMode = runRecord.generationMode;
  return receipt;
}

export async function createGrokMediaProofReceipt({
  repoRoot,
  checklist,
  requirementId,
  runRecord,
  ownerProofDocuments = {},
  currentOwnerProof,
  artifactRoot,
  artifactFilePaths = [],
  recordedAt = new Date().toISOString(),
} = {}) {
  validateFeatureChecklist(checklist);
  const { expected, binding, mediaContract } = expectedFor(requirementId, checklist);
  const shape = inspectRunShape(requirementId, runRecord, binding.codeFiles, artifactFilePaths);
  if (shape.missingFields.length || shape.invalidFields.length) {
    return { status: 'incomplete', requirementId, missingFields: shape.missingFields, blockers: shape.invalidFields, receipt: null };
  }
  if (!isIso(recordedAt) || !path.isAbsolute(repoRoot ?? '')) throw fail('MEDIA_PROOF_OPTIONS_INVALID');
  if (Date.parse(runRecord.sourceExecution.capturedAt) > Date.parse(runRecord.observedAt)) {
    return { status: 'incomplete', requirementId, missingFields: [], blockers: ['sourceExecution.capturedAt:AFTER_OBSERVED_AT'], receipt: null };
  }
  const owner = validateCurrentOwnerProof({ runRecord, ownerProofDocuments, currentOwnerProof });
  if (!safeRelative(mediaContract.sourceEvidencePath, 'verification/')) throw fail('MEDIA_PROOF_SOURCE_EVIDENCE_PATH_INVALID');
  await sourceEvidence(repoRoot, mediaContract);
  const currentOperationSnapshot = await snapshotGrokMediaOperationContracts(repoRoot);
  const capturedOperationHashes = runRecord.sourceExecution.operationContractSha256;
  if (!sameDigestMap(capturedOperationHashes, currentOperationSnapshot.operationContractSha256, OPERATION_CONTRACT_IDS)) {
    const changed = OPERATION_CONTRACT_IDS.filter(operationId =>
      capturedOperationHashes?.[operationId] !== currentOperationSnapshot.operationContractSha256[operationId]);
    return { status: 'incomplete', requirementId, missingFields: [],
      blockers: changed.map(operationId => `sourceExecution.operationContractSha256.${operationId}:CURRENT_CONTRACT_DRIFT`), receipt: null };
  }
  if (runRecord.sourceExecution.registryPolicySha256 !== currentOperationSnapshot.registryPolicySha256) {
    return { status: 'incomplete', requirementId, missingFields: [],
      blockers: ['sourceExecution.registryPolicySha256:CURRENT_POLICY_DRIFT'], receipt: null };
  }
  for (const file of binding.codeFiles) {
    const currentHash = await hashRepoFile(repoRoot, file);
    if (!currentHash) throw fail('MEDIA_PROOF_HANDLER_SOURCE_MISSING');
    if (runRecord.sourceExecution.codeSha256[file] !== currentHash) {
      return { status: 'incomplete', requirementId, missingFields: [], blockers: [`sourceExecution.codeSha256.${file}:CURRENT_SOURCE_DRIFT`], receipt: null };
    }
  }
  for (const [file, capturedHash] of Object.entries(runRecord.sourceExecution.codeSha256)) {
    const currentHash = await hashRepoFile(repoRoot, file);
    if (!currentHash) throw fail('MEDIA_PROOF_HANDLER_SOURCE_MISSING');
    if (capturedHash !== currentHash) {
      return { status: 'incomplete', requirementId, missingFields: [], blockers: [`sourceExecution.codeSha256.${file}:CURRENT_SOURCE_DRIFT`], receipt: null };
    }
  }
  try {
    assertPositiveSemantics(requirementId, runRecord);
    await verifyArtifactFiles(artifactRoot, runRecord.artifacts, artifactFilePaths);
  } catch (error) {
    if (error instanceof GrokMediaProofError) {
      return { status: 'incomplete', requirementId, missingFields: [], blockers: [error.code], receipt: null };
    }
    throw error;
  }
  const receipt = buildCanonicalReceipt(requirementId, runRecord, runRecord.sourceExecution.capturedAt, owner, mediaContract, recordedAt);
  validateFeatureReceipts([receipt]);
  if (receipt.operationId !== expected.operationId) throw fail('MEDIA_PROOF_OPERATION_BINDING_INVALID');
  return { status: 'ready', requirementId, missingFields: [], blockers: [], receipt };
}

export function inspectGrokMediaRunRecord({ checklist, requirementId, runRecord, artifactFilePaths = [] } = {}) {
  validateFeatureChecklist(checklist);
  const { binding } = expectedFor(requirementId, checklist);
  return { requirementId, ...inspectRunShape(requirementId, runRecord, binding.codeFiles, artifactFilePaths) };
}

async function mkdirContained(repoRoot, relativeDirectory) {
  if (!safeRelative(relativeDirectory, 'verification/')) throw fail('MEDIA_PROOF_RECEIPT_PATH_INVALID');
  const rootReal = await realpath(repoRoot).catch(() => { throw fail('MEDIA_PROOF_PATH_INVALID'); });
  let current = rootReal;
  for (const part of relativeDirectory.split('/')) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw fail('MEDIA_PROOF_RECEIPT_PATH_INVALID'); }
    const info = await lstat(current).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw fail('MEDIA_PROOF_RECEIPT_PATH_INVALID');
    const canonical = await realpath(current).catch(() => { throw fail('MEDIA_PROOF_RECEIPT_PATH_INVALID'); });
    if (!canonical.startsWith(rootReal + path.sep)) throw fail('MEDIA_PROOF_RECEIPT_PATH_INVALID');
  }
}

export async function emitGrokMediaProofReceipt(options = {}) {
  const result = await createGrokMediaProofReceipt(options);
  if (result.status !== 'ready') return { ...result, receiptPath: null };
  const relativeDirectory = options.checklist.receiptDirectory;
  await mkdirContained(options.repoRoot, relativeDirectory);
  const fileName = `media-${result.requirementId}.json`;
  const relativePath = `${relativeDirectory}/${fileName}`;
  const { path: destination, missing } = await containedPath(options.repoRoot, relativePath, { allowMissing: true });
  if (!missing) throw fail('MEDIA_PROOF_RECEIPT_ALREADY_EXISTS');
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.media-proof-${randomUUID()}.partial`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(`${JSON.stringify(result.receipt, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await linkNoReplace(temporary, destination);
    const directoryHandle = await open(directory, fsConstants.O_RDONLY).catch(() => null);
    if (directoryHandle) {
      try { await directoryHandle.sync(); } catch { /* Directory sync is not available on every filesystem. */ }
      finally { await directoryHandle.close(); }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await import('node:fs/promises').then(({ unlink }) => unlink(temporary).catch(() => {}));
  }
  return { ...result, receiptPath: relativePath };
}

async function linkNoReplace(source, destination) {
  const { link } = await import('node:fs/promises');
  try { await link(source, destination); }
  catch (error) {
    if (error?.code === 'EEXIST') throw fail('MEDIA_PROOF_RECEIPT_ALREADY_EXISTS');
    throw fail('MEDIA_PROOF_RECEIPT_WRITE_FAILED');
  }
}

export async function verifyGrokMediaProofReceipt({
  repoRoot,
  checklist,
  requirementId,
  receipt,
  ownerProofDocuments = {},
  currentOwnerProof,
} = {}) {
  validateFeatureChecklist(checklist);
  const { binding, mediaContract } = expectedFor(requirementId, checklist);
  validateFeatureReceipts([receipt]);
  if (receipt.requirementId !== requirementId) throw fail('MEDIA_PROOF_RECEIPT_REQUIREMENT_MISMATCH');
  if (!isIso(receipt.sourceCodeSnapshotAt) || Date.parse(receipt.sourceCodeSnapshotAt) > Date.parse(receipt.observedAt)) {
    throw fail('MEDIA_PROOF_SOURCE_SNAPSHOT_TIME_INVALID');
  }
  if (receipt.operationContractSha256 !== undefined) {
    if (!isIso(receipt.operationContractSnapshotAt)
      || receipt.operationContractSnapshotAt !== receipt.sourceCodeSnapshotAt
      || Date.parse(receipt.operationContractSnapshotAt) > Date.parse(receipt.observedAt)) {
      throw fail('MEDIA_PROOF_OPERATION_CONTRACT_SNAPSHOT_TIME_INVALID');
    }
    const currentOperationSnapshot = await snapshotGrokMediaOperationContracts(repoRoot);
    if (!sameDigestMap(receipt.operationContractSha256, currentOperationSnapshot.operationContractSha256, OPERATION_CONTRACT_IDS)
      || receipt.registryPolicySha256 !== currentOperationSnapshot.registryPolicySha256) {
      throw fail('MEDIA_PROOF_OPERATION_CONTRACT_DRIFT');
    }
  } else if (receipt.operationContractSnapshotAt !== undefined || receipt.registryPolicySha256 !== undefined) {
    throw fail('MEDIA_PROOF_OPERATION_CONTRACT_SNAPSHOT_INVALID');
  }
  const { proofPath, proof, digest, ownerScopeSha256 } = validateCurrentOwnerProof({
    runRecord: {
      owner: {
        verified: receipt.ownerVerified,
        sameAuthenticatedOwner: receipt.sameAuthenticatedOwner,
        proofPath: receipt.ownerProofPath,
        canonicalSha256: receipt.ownerProofSha256,
        ownerScopeSha256: receipt.ownerScopeSha256,
        identityReceiptSha256: receipt.ownerIdentityReceiptSha256,
      },
    },
    ownerProofDocuments,
    currentOwnerProof,
  });
  if (proofPath !== receipt.ownerProofPath || digest !== receipt.ownerProofSha256
    || ownerScopeSha256 !== receipt.ownerScopeSha256) throw fail('MEDIA_PROOF_OWNER_BINDING_INVALID');
  await sourceEvidence(repoRoot, mediaContract);
  if (receipt.mediaContractSha256 !== sha256Text(canonicalJson(mediaContract))) throw fail('MEDIA_PROOF_CONTRACT_DRIFT');
  try {
    assertPositiveSemantics(requirementId, {
      requestDigest: receipt.requestDigest,
      generationMode: receipt.generationMode,
      browserCapture: receipt.browserCapture,
      directTransport: receipt.directTransport,
      operationReadbacks: receipt.operationReadbacks,
      semanticReadback: receipt.semanticReadback,
      artifacts: receipt.artifact,
    });
  } catch (error) {
    if (error instanceof GrokMediaProofError) throw fail('MEDIA_PROOF_RECEIPT_SEMANTICS_INVALID');
    throw error;
  }
  for (const file of binding.codeFiles) {
    const currentHash = await hashRepoFile(repoRoot, file);
    if (!currentHash || receipt.codeSha256[file] !== currentHash) throw fail(`MEDIA_PROOF_CURRENT_CODE_DRIFT_${path.basename(file)}`);
  }
  for (const [file, capturedHash] of Object.entries(receipt.codeSha256)) {
    const currentHash = await hashRepoFile(repoRoot, file);
    if (!currentHash || capturedHash !== currentHash) throw fail(`MEDIA_PROOF_CURRENT_CODE_DRIFT_${path.basename(file)}`);
  }
  return {
    status: 'verified',
    requirementId,
    receiptPath: null,
    codeCurrent: true,
    ownerProofBound: true,
    ownerScopeCurrent: true,
    mediaContractCurrent: true,
    operationContractsCurrent: receipt.operationContractSha256 === undefined ? null : true,
    artifactFactsPersisted: receipt.artifact.length,
    artifactBytesRecheckedThisRun: false,
  };
}

export async function readGrokMediaProofReceipt(options = {}) {
  const { repoRoot, checklist, requirementId } = options;
  validateFeatureChecklist(checklist);
  if (!OPERATION_SHAPES[requirementId]) throw fail('MEDIA_PROOF_REQUIREMENT_INVALID');
  const relativePath = `${checklist.receiptDirectory}/media-${requirementId}.json`;
  const { path: receiptPath, missing } = await containedPath(repoRoot, relativePath, { allowMissing: true });
  if (missing) return { status: 'missing', requirementId, receiptPath: relativePath };
  let receipt;
  try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); }
  catch { throw fail('MEDIA_PROOF_RECEIPT_INVALID'); }
  const verified = await verifyGrokMediaProofReceipt({ ...options, receipt });
  return { ...verified, receiptPath: relativePath, receipt };
}
