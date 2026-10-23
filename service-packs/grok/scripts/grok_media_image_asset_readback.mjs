#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOME = homedir();
const SOURCE_CODE_FILES = [
  'scripts/grok_media_image_asset_readback.mjs',
  'scripts/grok_media_image_asset_readback_once.py',
  'scripts/grok_media_capture_guard.py',
  'scripts/grok_media_asset_download.py',
  'src/grok-media-api.mjs',
  'src/grok-media-asset-reader.mjs',
  'src/grok-media-proof-receipts.mjs',
  'src/feature-checklist.mjs',
  'src/runtime.mjs',
  'src/client.mjs',
  'src/contracts.mjs',
  'src/transport.mjs',
  'src/session.mjs',
  'src/journal.mjs',
  'src/nonsecret-json-store.mjs',
  'src/protected-json-store.mjs',
  'src/authenticated-chrome-fetch.mjs',
  'scripts/authenticated-chrome-transport.py',
  'contracts/grok-web.v1.json',
  'contracts/grok-feature-checklist.v1.json',
];
const READBACK_OPERATION_IDS = ['media.assets.list', 'conversation.read', 'history.response-nodes', 'history.load-responses'];
const PERSISTENCE_ASSERTIONS = {
  credentialValuesPersisted: false, cookiesPersisted: false, tokensPersisted: false, requestBodiesPersisted: false,
  responseBodiesPersisted: false, signedUrlValuesPersisted: false, passwordValuesPersisted: false,
  conversationIdsPersisted: false, conversationTitlesPersisted: false, responseIdsPersisted: false,
  messageBodiesPersisted: false, rawFramesPersisted: false, assetBytesPersisted: false, assetIdsPersisted: false,
  promptPersisted: false, rawIdsOrKeysOrUrlsPersisted: false, cookiesOrTokensPersisted: false,
};
let stage = 'source_snapshot';
let readDiagnostic = { operationId: null, httpStatus: null, errorCode: null };

function fail(code) { const error = new Error(code); error.code = code; return error; }
function isSha(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function isoNow() { return new Date().toISOString(); }
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function timeMs(value) {
  if (typeof value === 'number') return Math.floor(value > 10_000_000_000 ? value : value * 1000);
  if (typeof value === 'string') { const result = Date.parse(value); return Number.isFinite(result) ? result : null; }
  return null;
}

async function hashRepoFile(relative) {
  if (typeof relative !== 'string' || relative.startsWith('/') || relative.includes('\\')
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw fail('SOURCE_PATH_INVALID');
  const target = path.join(ROOT, relative); const info = await lstat(target).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw fail('SOURCE_FILE_INVALID');
  const bytes = await readFile(target); try { return sha(bytes); } finally { bytes.fill(0); }
}

async function sourceSnapshot() {
  const codeSha256 = {};
  for (const relative of SOURCE_CODE_FILES) codeSha256[relative] = await hashRepoFile(relative);
  return { capturedAt: isoNow(), codeSha256, digest: sha(canonicalJson(codeSha256)) };
}

async function readContainedJson(relative) {
  if (typeof relative !== 'string' || !/^(?:verification|contracts)\//.test(relative) || relative.startsWith('/')
    || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw fail('REPO_JSON_PATH_INVALID');
  }
  const rootReal = await realpath(ROOT); let current = rootReal;
  for (const part of relative.split('/')) {
    current = path.join(current, part); const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink()) throw fail('REPO_JSON_PATH_INVALID');
  }
  const real = await realpath(current);
  if (!real.startsWith(`${rootReal}${path.sep}`)) throw fail('REPO_JSON_PATH_INVALID');
  try { return JSON.parse(await readFile(real, 'utf8')); } catch { throw fail('REPO_JSON_INVALID'); }
}

async function readInput() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length; if (size > 256 * 1024) throw fail('INPUT_SIZE_LIMIT'); chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    const keys = ['assetId', 'assetRequestContext', 'browserCapture', 'expectedIdentity', 'imageSourceReceiptPath',
      'imageSourceReceiptSha256', 'currentExactTaskAssetCount', 'operationIntentDigest', 'operationRequestDigest', 'outputName', 'ownerProof',
      'sessionBundle', 'sourceSnapshotSha256'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys.sort())) throw fail('INPUT_SHAPE_INVALID');
    if (!isSha(value.sourceSnapshotSha256) || !isSha(value.imageSourceReceiptSha256)
      || !isSha(value.operationIntentDigest) || !isSha(value.operationRequestDigest)
      || !Number.isSafeInteger(value.currentExactTaskAssetCount) || value.currentExactTaskAssetCount < 1 || value.currentExactTaskAssetCount > 4
      || typeof value.assetId !== 'string' || value.assetId.length < 16 || value.assetId.length > 512 || /[\r\n\0]/.test(value.assetId)
      || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim() || value.expectedIdentity.length > 320
      || typeof value.outputName !== 'string' || !/^image-01-readback-[a-f0-9]{8}\.jpg$/.test(value.outputName)
      || typeof value.imageSourceReceiptPath !== 'string' || value.imageSourceReceiptPath !== 'verification/grok-media-image-live-2026-10-06.json') {
      throw fail('INPUT_VALUE_INVALID');
    }
    const ownerKeys = ['canonicalSha256', 'identityReceiptSha256', 'ownerScopeSha256', 'proofPath', 'sameAuthenticatedOwner', 'verified'];
    if (!value.ownerProof || typeof value.ownerProof !== 'object' || Array.isArray(value.ownerProof)
      || canonicalJson(Object.keys(value.ownerProof).sort()) !== canonicalJson(ownerKeys.sort())
      || !isSha(value.ownerProof.canonicalSha256) || value.ownerProof.identityReceiptSha256 !== value.ownerProof.canonicalSha256
      || !isSha(value.ownerProof.ownerScopeSha256) || value.ownerProof.verified !== true || value.ownerProof.sameAuthenticatedOwner !== true
      || typeof value.ownerProof.proofPath !== 'string' || !/^verification\/owner-proofs\/[a-f0-9]{64}\.json$/.test(value.ownerProof.proofPath)) {
      throw fail('OWNER_PROOF_INPUT_INVALID');
    }
    return value;
  } finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0); }
}

function validateBrowserCapture(value) {
  const keys = ['businessActionBlocked','browserBusinessWritesDelivered','browserResponseCount','captureMode','intentMatched',
    'networkFailureCorrelated','pageRoleMatched','rawRequestPersisted','rawResponsePersisted','requestCaptured'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys.sort())
    || value.captureMode !== 'native_read_capture' || value.pageRoleMatched !== true || value.intentMatched !== true
    || value.requestCaptured !== true || value.businessActionBlocked !== false || value.networkFailureCorrelated !== false
    || value.browserBusinessWritesDelivered !== 0 || value.browserResponseCount !== 1
    || value.rawRequestPersisted !== false || value.rawResponsePersisted !== false) throw fail('BROWSER_CAPTURE_INVALID');
}

async function atomicJson(relative, value) {
  const target = path.join(ROOT, relative); const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700).catch(() => {});
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw fail('RUN_RECORD_DIRECTORY_INVALID');
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await link(temporary, target); await unlink(temporary);
  } catch (error) {
    await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {});
    if (error?.code === 'EEXIST') throw fail('RUN_RECORD_ALREADY_EXISTS'); throw error;
  } finally { bytes.fill(0); }
}

async function run() {
  stage = 'source_snapshot'; const source = await sourceSnapshot();
  stage = 'input_validation'; const input = await readInput();
  if (source.digest !== input.sourceSnapshotSha256) throw fail('SOURCE_SNAPSHOT_MISMATCH');
  validateBrowserCapture(input.browserCapture);
  const sourceBytes = await open(path.join(ROOT, input.imageSourceReceiptPath), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    .then(async fh => { try { const st = await fh.stat(); if (!st.isFile() || st.size > 128 * 1024) throw fail('IMAGE_SOURCE_RECEIPT_INVALID'); return fh.readFile(); } finally { await fh.close(); } })
    .catch(() => null);
  if (!sourceBytes || sha(sourceBytes) !== input.imageSourceReceiptSha256) { sourceBytes?.fill(0); throw fail('IMAGE_SOURCE_RECEIPT_DIGEST_MISMATCH'); }
  let imageSource;
  try { imageSource = JSON.parse(sourceBytes.toString('utf8')); } finally { sourceBytes.fill(0); }
  if (imageSource.operation !== 'media.image.create' || imageSource.ownerVerified !== true || imageSource.ownerMatchesExpected !== true
    || imageSource.nativeBatchFourVerified !== true || imageSource.nativeProfileVerified !== true || imageSource.writeRequestsSent !== 1
    || !isSha(imageSource.promptSha256)) throw fail('IMAGE_SOURCE_FACTS_INVALID');
  const imageReadbackPath = 'verification/grok-media-readback-reconcile-2026-10-06.json';
  const imageReadbackBytes = await open(path.join(ROOT, imageReadbackPath), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    .then(async fh => { try { const st = await fh.stat(); if (!st.isFile() || st.size > 256 * 1024) throw fail('IMAGE_READBACK_SOURCE_INVALID'); return fh.readFile(); }
      finally { await fh.close(); } }).catch(() => null);
  if (!imageReadbackBytes) throw fail('IMAGE_READBACK_SOURCE_MISSING');
  const imageReadbackSha256 = sha(imageReadbackBytes);
  let imageReadbackSource;
  try { imageReadbackSource = JSON.parse(imageReadbackBytes.toString('utf8')); } finally { imageReadbackBytes.fill(0); }
  const historicalImageAssets = imageReadbackSource.image?.directAssetFetches;
  if (imageReadbackSource.image?.promptSha256 !== imageSource.promptSha256
    || imageReadbackSource.image?.assetCountDelta !== 4 || imageReadbackSource.image?.generationAttributionVerified !== true
    || imageReadbackSource.image?.sameConversationAndResponseSet !== true || imageReadbackSource.image?.readbackVerified !== true
    || !Array.isArray(historicalImageAssets) || historicalImageAssets.length !== 4
    || historicalImageAssets.some(asset => asset.assetHttpStatus !== 200 || asset.mimeType !== 'image/jpeg'
      || asset.magicVerified !== true || !Number.isSafeInteger(asset.bodyBytes) || !isSha(asset.sha256))) {
    throw fail('IMAGE_HISTORICAL_TASK_ASSET_PROOF_INVALID');
  }
  const capturedAt = source.capturedAt;
  stage = 'handler_imports';
  const [{ createInMemoryGrokRuntime }, mediaModule, { createGrokCffiAssetReader, validateGrokAssetRequestContext },
    { createRequestDigest }, proofModule, checklistModule] = await Promise.all([
    import('../src/runtime.mjs'), import('../src/grok-media-api.mjs'), import('../src/grok-media-asset-reader.mjs'),
    import('../src/transport.mjs'), import('../src/grok-media-proof-receipts.mjs'), import('../src/feature-checklist.mjs'),
  ]);
  const runtime = await createInMemoryGrokRuntime({
    pythonExecutable: process.env.GROK_CHROME_PYTHON ?? 'python3',
    journalFilePath: path.join(HOME, '.nad-scratch', 'grok-web-xhr-client', 'operations.json'),
  });
  const readReceipts = new Map(); const originalRead = runtime.client.read.bind(runtime.client);
  runtime.client.read = async (operationId, request, options) => {
    readDiagnostic = { operationId, httpStatus: null, errorCode: null };
    try {
      const result = await originalRead(operationId, request, options); readDiagnostic.httpStatus = result.status;
      if (READBACK_OPERATION_IDS.includes(operationId)) {
        const previous = readReceipts.get(operationId) ?? { pageCount: 0 };
        readReceipts.set(operationId, { operationId, httpStatus: result.status, responseBytes: result.responseBytes ?? null,
          responseDigest: result.rawResponseDigest ?? null, responseDigestKind: result.rawResponseDigestKind ?? null,
          pageCount: previous.pageCount + 1 });
      }
      return result;
    } catch (error) { readDiagnostic.errorCode = typeof error?.code === 'string' ? error.code : 'READ_FAILED';
      readDiagnostic.httpStatus = Number.isInteger(error?.details?.status) ? error.details.status : null; throw error; }
  };
  try {
    stage = 'owner_verification'; await runtime.client.importSession(input.sessionBundle); await runtime.client.verifyOwner(input.expectedIdentity);
    const ownerSession = await runtime.sessionPersistence.read(); const ownerScopeSha256 = ownerSession?.session?.ownerBinding?.identityDigest;
    if (ownerSession?.kind !== 'grok-session' || !isSha(ownerScopeSha256) || ownerScopeSha256 !== '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7') throw fail('CURRENT_OWNER_SCOPE_MISMATCH');
    const operations = (await runtime.journal.list()).filter(item => item.contractId === 'media.image.create'
      && item.intentDigest === input.operationIntentDigest && item.requestDigest === input.operationRequestDigest
      && item.state === 'completed' && item.httpStatus === 101 && item.attemptCount === 1
      && item.reasonCode === 'MEDIA_ASSET_READBACK_VERIFIED');
    if (operations.length !== 1) throw fail('IMAGE_CREATE_OPERATION_NOT_UNIQUE');
    const operationStart = timeMs(operations[0].createdAt); if (operationStart === null) throw fail('IMAGE_OPERATION_TIME_INVALID');

    const assetReader = createGrokCffiAssetReader({ pythonExecutable: process.env.GROK_CHROME_PYTHON ?? 'python3',
      scriptPath: path.join(ROOT, 'scripts', 'grok_media_asset_download.py') });
    const mediaApi = mediaModule.createGrokMediaApi({ client: runtime.client, assetReader,
      assetServerUrl: `${input.assetRequestContext.assetOrigin}/` });
    validateGrokAssetRequestContext('https://assets.grok.com/users/owner/generated/image.jpg?cache=1', input.assetRequestContext, ownerScopeSha256);
    stage = 'direct_task_history_readback';
    const listing = await mediaApi.listAssets({ maxPages: 20 });
    if (listing.status !== 200 || listing.complete !== true || listing.nextPageAvailable !== false) throw fail('ASSET_LIST_INCOMPLETE');
    const candidates = listing.assets.filter(asset => {
      const privateData = asset[mediaModule.GROK_MEDIA_PRIVATE_ASSET_DATA]; const created = timeMs(asset.createTime);
      return typeof asset.mimeType === 'string' && asset.mimeType.startsWith('image/') && asset.isPublic === false
        && asset.isModelGenerated === true && privateData?.assetId && privateData?.responseId && privateData?.sourceConversationId
        && created !== null && created >= operationStart - 60_000 && created <= operationStart + 60_000;
    });
    const exactMatches = []; const evidenceCache = new Map();
    for (const asset of candidates) {
      const privateData = asset[mediaModule.GROK_MEDIA_PRIVATE_ASSET_DATA];
      let evidence = evidenceCache.get(privateData.sourceConversationId);
      if (!evidence) {
        evidence = await mediaApi.readConversationEvidence({ conversationId: privateData.sourceConversationId,
          expectedPromptSha256: imageSource.promptSha256 });
        evidenceCache.set(privateData.sourceConversationId, evidence);
      }
      const matchingResponseIds = evidence[mediaModule.GROK_MEDIA_PRIVATE_RESPONSE_IDS]?.matchingPrompt ?? [];
      if (evidence.conversationMatch === true && evidence.promptExactMatch === true && evidence.uniqueUserPromptCount === 1
        && evidence.promptSha256 === imageSource.promptSha256 && matchingResponseIds.includes(privateData.responseId)) exactMatches.push(asset);
    }
    if (exactMatches.length !== input.currentExactTaskAssetCount
      || !exactMatches.some(asset => asset[mediaModule.GROK_MEDIA_PRIVATE_ASSET_DATA]?.assetId === input.assetId)) {
      throw fail('IMAGE_TASK_ASSET_SET_MISMATCH');
    }
    const selected = exactMatches.find(asset => asset[mediaModule.GROK_MEDIA_PRIVATE_ASSET_DATA]?.assetId === input.assetId);
    const selectedPrivate = selected[mediaModule.GROK_MEDIA_PRIVATE_ASSET_DATA];
    const sourceConversationEvidence = evidenceCache.get(selectedPrivate.sourceConversationId);
    if (!sourceConversationEvidence || sourceConversationEvidence.conversationMatch !== true
      || sourceConversationEvidence.promptExactMatch !== true || sourceConversationEvidence.uniqueUserPromptCount !== 1) {
      throw fail('IMAGE_TASK_HISTORY_BINDING_FAILED');
    }
    const artifactRoot = path.join(HOME, 'artifacts', 'grok-media-20261006'); await mkdir(artifactRoot, { recursive: true, mode: 0o700 }); await chmod(artifactRoot, 0o700);
    const artifactPath = path.join(artifactRoot, input.outputName); if (await lstat(artifactPath).catch(() => null)) throw fail('ARTIFACT_OUTPUT_ALREADY_EXISTS');
    const requestUrl = mediaModule.buildGrokAssetUrl(selectedPrivate.key, `${input.assetRequestContext.assetOrigin}/`).href;
    const requestDigest = createRequestDigest({ method: 'GET', url: requestUrl, body: null });
    stage = 'prewire_owner_recheck'; await runtime.client.verifyOwner(input.expectedIdentity);
    const prewireOwner = await runtime.sessionPersistence.read();
    if (prewireOwner?.kind !== 'grok-session' || prewireOwner?.session?.ownerBinding?.identityDigest !== ownerScopeSha256) {
      throw fail('PREWIRE_OWNER_SCOPE_MISMATCH');
    }
    stage = 'prewire_source_recheck';
    const prewireSource = await sourceSnapshot();
    if (prewireSource.digest !== source.digest) throw fail('SOURCE_CHANGED_BEFORE_ASSET_GET');
    stage = 'asset_download';
    const download = await mediaApi.downloadAssetToFile(selected, { assetRequestContext: input.assetRequestContext,
      expectedOwnerIdentityDigest: ownerScopeSha256, outputRoot: artifactRoot, outputName: input.outputName });
    if (download.status !== 200 || !download.mimeType.startsWith('image/') || download.magicVerified !== true
      || download.diskSha256 !== download.sha256 || download.diskBodyBytes !== download.bodyBytes
      || !historicalImageAssets.some(asset => asset.sha256 === download.sha256 && asset.bodyBytes === download.bodyBytes)) {
      throw fail('IMAGE_ASSET_READBACK_MISMATCH');
    }
    stage = 'handler_source_recheck'; const observedAt = isoNow(); const current = await sourceSnapshot();
    if (current.digest !== source.digest) throw fail('SOURCE_CHANGED_DURING_READBACK');
    const operationReadbacks = READBACK_OPERATION_IDS.map(id => {
      const result = readReceipts.get(id);
      if (!result || result.httpStatus !== 200 || !Number.isSafeInteger(result.responseBytes) || result.responseBytes < 1
        || !isSha(result.responseDigest) || result.responseDigestKind !== 'raw_http_body') throw fail('READBACK_HTTP_RECEIPT_MISSING');
      return { operationId: id, httpStatus: 200, responseBytes: result.responseBytes, responseDigest: result.responseDigest, responseDigestKind: result.responseDigestKind };
    });
    const runRecord = {
      schemaVersion: 1, recordType: 'grok-media-source-bound-run', requirementId: 'artifact.image.download', observedAt,
      sourceExecution: { capturedAt, capturedBeforeDispatch: true, stableThroughReadback: true, codeSha256: source.codeSha256 },
      owner: input.ownerProof,
      requestDigest, intentDigest: input.operationIntentDigest, promptSha256: imageSource.promptSha256,
      browserCapture: input.browserCapture,
      directTransport: { transport: 'asset_http', origin: 'https://assets.grok.com', path: '/users/{owner}/generated/{assetKey}',
        method: 'GET', requestStarted: true, responseReceived: true, httpStatus: download.status, responseMime: download.mimeType,
        responseBytes: download.bodyBytes, responseDigest: download.sha256, directDispatchCount: 1, automaticRetries: 0,
        tlsVerified: true, redirectsFollowed: false, trustEnv: false, attemptCount: 1 },
      operationReadbacks,
      semanticReadback: { taskBoundToIntent: true, exactPromptMatched: true, assetOwnerVerified: true, assetPromptMatched: true, sourceConversationMatched: true },
      artifacts: [{ httpStatus: download.status, mimeType: download.mimeType, bytes: download.bodyBytes, sha256: download.sha256,
        magicVerified: download.magicVerified, independentFileReadback: download.diskSha256 === download.sha256
          && download.diskBodyBytes === download.bodyBytes, taskAssetMatched: true }],
      persistenceAssertions: PERSISTENCE_ASSERTIONS,
    };
    stage = 'owner_proof_and_receipt';
    const ownerProofPath = input.ownerProof.proofPath; const ownerProof = await readContainedJson(ownerProofPath);
    const currentOwnerPath = process.env.GROK_CURRENT_OWNER_PROOF_PATH ?? 'verification/grok-feature-live-receipts/auth-owner.read.json';
    const currentOwnerDoc = await readContainedJson(currentOwnerPath);
    const docs = { [ownerProofPath]: ownerProof, [currentOwnerPath]: currentOwnerDoc };
    const currentOwner = { path: currentOwnerPath, canonicalSha256: sha(canonicalJson(currentOwnerDoc)), ownerScopeSha256: currentOwnerDoc.ownerScopeSha256 };
    if (currentOwner.ownerScopeSha256 !== ownerScopeSha256) throw fail('CURRENT_OWNER_PROOF_SCOPE_MISMATCH');
    const checklist = await readContainedJson('contracts/grok-feature-checklist.v1.json'); checklistModule.validateFeatureChecklist(checklist);
    const runName = `grok-media-image-asset-readback-${observedAt.replace(/[-:.]/g, '')}-${input.operationIntentDigest.slice(0, 16)}.json`;
    const runPath = `verification/one-shot/${runName}`; await atomicJson(runPath, runRecord);
    const runBytes = await readFile(path.join(ROOT, runPath)); const runSha = sha(runBytes); runBytes.fill(0);
    const emitted = await proofModule.emitGrokMediaProofReceipt({ repoRoot: ROOT, checklist, requirementId: 'artifact.image.download',
      runRecord, artifactFilePaths: [download.artifactPath], ownerProofDocuments: docs, currentOwnerProof: currentOwner,
      artifactRoot: path.join(HOME, 'artifacts') });
    if (emitted.status !== 'ready') throw fail('IMAGE_ARTIFACT_RECEIPT_NOT_READY');
    const receipt = await readContainedJson(emitted.receiptPath);
    const verified = await proofModule.verifyGrokMediaProofReceipt({ repoRoot: ROOT, checklist,
      requirementId: 'artifact.image.download', receipt, ownerProofDocuments: docs, currentOwnerProof: currentOwner });
    if (verified.status !== 'verified' || verified.codeCurrent !== true || verified.ownerProofBound !== true) throw fail('IMAGE_ARTIFACT_RECEIPT_VERIFY_FAILED');
    const sourceLink = {
      schemaVersion: 1, recordType: 'grok-media-image-readback-link',
      sourceImageReceiptPath: input.imageSourceReceiptPath, sourceImageReceiptSha256: input.imageSourceReceiptSha256,
      sourceImageReadbackReceiptPath: imageReadbackPath, sourceImageReadbackReceiptSha256: imageReadbackSha256,
      sourceImagePromptSha256: imageSource.promptSha256, sourceImageOperationIntentDigest: input.operationIntentDigest,
      sourceImageOperationRequestDigest: input.operationRequestDigest, sourceImageOperationState: 'completed',
      sourceImageOperationHttpStatus: 101, sourceImageOperationAttemptCount: 1,
      historicalBatchAssetCount: 4, currentExactTaskAssetCount: exactMatches.length,
      selectedAssetMatchesHistoricalBytes: true, directAssetReadRequestDigest: requestDigest,
      assetHttpStatus: download.status, assetMimeType: download.mimeType, assetBytes: download.bodyBytes,
      assetSha256: download.sha256, artifactRunPath: runPath, artifactRunSha256: runSha,
      canonicalReceiptPath: emitted.receiptPath, canonicalReceiptVerified: verified.status,
    };
    const linkPath = `verification/one-shot/grok-media-image-readback-link-${input.operationIntentDigest.slice(0, 16)}-${runSha.slice(0, 8)}.json`;
    await atomicJson(linkPath, sourceLink);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: 'verified', requirementId: 'artifact.image.download',
      sourceSnapshotSha256: source.digest, sourceStableThroughReadback: true, ownerVerified: true, taskBoundAssetCount: 4,
      currentExactTaskAssetCount: exactMatches.length,
      httpStatus: download.status, mimeType: download.mimeType, bodyBytes: download.bodyBytes, assetSha256: download.sha256,
      magicVerified: download.magicVerified, independentFileReadback: true, receiptPath: emitted.receiptPath,
      runPath, runSha256: runSha, linkPath })}\n`);
  } finally { await runtime.client.clearSession().catch(() => {}); }
}

run().catch(error => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'IMAGE_ASSET_READBACK_FAILED';
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: 'failed', stage,
    operationId: readDiagnostic.operationId, httpStatus: readDiagnostic.httpStatus,
    directReadMayHaveStarted: stage === 'asset_download' || stage === 'handler_source_recheck'
      || stage === 'owner_proof_and_receipt', errorCode: code })}\n`);
  process.exitCode = 1;
});
