#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOME = homedir();
const SOURCE_CODE_FILES = [
  'scripts/grok_media_video_asset_readback.mjs',
  'scripts/grok_media_video_asset_readback_once.py',
  'scripts/grok_media_capture_guard.py',
  'scripts/grok_media_asset_download.py',
  'scripts/emit-grok-media-proof.mjs',
  'src/grok-media-api.mjs',
  'src/grok-media-asset-reader.mjs',
  'src/grok-media-proof-receipts.mjs',
  'src/grok-media-intent.mjs',
  'src/feature-checklist.mjs',
  'src/runtime.mjs',
  'src/cli.mjs',
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
  'verification/grok-media-contract-capture-2026-10-06.json',
];
const READBACK_OPERATION_IDS = [
  'media.assets.list', 'conversation.read', 'history.response-nodes', 'history.load-responses',
];
const PERSISTENCE_ASSERTIONS = {
  credentialValuesPersisted: false,
  cookiesPersisted: false,
  tokensPersisted: false,
  requestBodiesPersisted: false,
  responseBodiesPersisted: false,
  signedUrlValuesPersisted: false,
  passwordValuesPersisted: false,
  conversationIdsPersisted: false,
  conversationTitlesPersisted: false,
  responseIdsPersisted: false,
  messageBodiesPersisted: false,
  rawFramesPersisted: false,
  assetBytesPersisted: false,
  assetIdsPersisted: false,
  promptPersisted: false,
  rawIdsOrKeysOrUrlsPersisted: false,
  cookiesOrTokensPersisted: false,
};
let stage = 'source_snapshot';
let readDiagnostic = { operationId: null, httpStatus: null, errorCode: null };

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isSha(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function isoNow() { return new Date().toISOString(); }
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function sha(value) { return createHash('sha256').update(value).digest('hex'); }

async function hashRepoFile(relative) {
  if (typeof relative !== 'string' || relative.startsWith('/') || relative.includes('\\')
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw fail('SOURCE_PATH_INVALID');
  const target = path.join(ROOT, relative);
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw fail('SOURCE_FILE_INVALID');
  const bytes = await readFile(target);
  try { return sha(bytes); } finally { bytes.fill(0); }
}

async function sourceSnapshot() {
  const codeSha256 = {};
  for (const relative of SOURCE_CODE_FILES) codeSha256[relative] = await hashRepoFile(relative);
  return {
    capturedAt: isoNow(),
    codeSha256,
    digest: sha(canonicalJson(codeSha256)),
  };
}

async function readContainedJson(relative) {
  if (typeof relative !== 'string' || !/^(?:verification|contracts)\//.test(relative) || relative.startsWith('/')
    || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw fail('REPO_JSON_PATH_INVALID');
  }
  let current = await realpath(ROOT);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info?.isFile() && !info?.isDirectory() || info?.isSymbolicLink()) throw fail('REPO_JSON_PATH_INVALID');
  }
  const real = await realpath(current);
  if (!real.startsWith(`${await realpath(ROOT)}${path.sep}`)) throw fail('REPO_JSON_PATH_INVALID');
  try { return JSON.parse(await readFile(real, 'utf8')); } catch { throw fail('REPO_JSON_INVALID'); }
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 256 * 1024) throw fail('INPUT_SIZE_LIMIT');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    const keys = [
      'assetId', 'assetRequestContext', 'browserCapture', 'expectedIdentity', 'outputName',
      'promptLength', 'sessionBundle', 'sourceRunPath', 'sourceRunSha256', 'sourceSnapshotSha256',
    ];
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys.sort())) throw fail('INPUT_SHAPE_INVALID');
    if (typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim() || value.expectedIdentity.length > 320
      || typeof value.assetId !== 'string' || value.assetId.length < 16 || value.assetId.length > 512
      || /[\r\n\0]/.test(value.assetId) || !Number.isSafeInteger(value.promptLength) || value.promptLength < 1 || value.promptLength > 4000
      || !isSha(value.sourceRunSha256) || !isSha(value.sourceSnapshotSha256)
      || typeof value.sourceRunPath !== 'string' || !/^verification\/one-shot\/grok-media-video-text-source-run-[A-Za-z0-9._-]+\.json$/.test(value.sourceRunPath)
      || typeof value.outputName !== 'string' || !/^video-direct-01-readback-[a-f0-9]{8}\.mp4$/.test(value.outputName)) {
      throw fail('INPUT_VALUE_INVALID');
    }
    return value;
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function timeMs(value) {
  if (typeof value === 'number') return Math.floor(value > 10_000_000_000 ? value : value * 1000);
  if (typeof value === 'string') {
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
  }
  return null;
}

function validateBrowserCapture(value) {
  const keys = [
    'businessActionBlocked', 'browserBusinessWritesDelivered', 'browserResponseCount', 'captureMode',
    'intentMatched', 'networkFailureCorrelated', 'pageRoleMatched', 'rawRequestPersisted',
    'rawResponsePersisted', 'requestCaptured',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys.sort())
    || value.captureMode !== 'native_read_capture' || value.pageRoleMatched !== true || value.intentMatched !== true
    || value.requestCaptured !== true || value.businessActionBlocked !== false || value.networkFailureCorrelated !== false
    || value.browserBusinessWritesDelivered !== 0 || value.browserResponseCount < 1
    || value.rawRequestPersisted !== false || value.rawResponsePersisted !== false) throw fail('BROWSER_CAPTURE_INVALID');
}

async function atomicJson(relative, value) {
  const target = path.join(ROOT, relative);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw fail('RUN_RECORD_DIRECTORY_INVALID');
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporary, target);
    await unlink(temporary);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (error?.code === 'EEXIST') throw fail('RUN_RECORD_ALREADY_EXISTS');
    throw error;
  } finally { bytes.fill(0); }
}

async function writeLink(relative, value) {
  await atomicJson(relative, value);
}

async function run() {
  stage = 'source_snapshot';
  const source = await sourceSnapshot();
  stage = 'input_validation';
  const input = await readInput();
  if (source.digest !== input.sourceSnapshotSha256) throw fail('SOURCE_SNAPSHOT_MISMATCH');
  validateBrowserCapture(input.browserCapture);
  await readContainedJson(input.sourceRunPath);
  const sourceRunBytes = await open(path.join(ROOT, input.sourceRunPath), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    .then(async handle => {
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 64 * 1024) throw fail('SOURCE_RUN_INVALID');
        return await handle.readFile();
      } finally { await handle.close(); }
    }).catch(() => null);
  if (!sourceRunBytes || sha(sourceRunBytes) !== input.sourceRunSha256) {
    sourceRunBytes?.fill(0);
    throw fail('SOURCE_RUN_DIGEST_MISMATCH');
  }
  let sourceRun;
  try { sourceRun = JSON.parse(sourceRunBytes.toString('utf8')); } finally { sourceRunBytes.fill(0); }
  if (sourceRun.recordType !== 'grok-media-source-bound-run' || sourceRun.requirementId !== 'video.text-to-video'
    || sourceRun.directTransport?.directDispatchCount !== 1 || sourceRun.directTransport?.attemptCount !== 1
    || !isSha(sourceRun.intentDigest) || sourceRun.generationMode !== 'text'
    || !isSha(sourceRun.owner?.ownerScopeSha256)
    || !isSha(sourceRun.promptSha256) || !Number.isSafeInteger(sourceRun.artifacts?.[0]?.bytes)
    || !isSha(sourceRun.artifacts?.[0]?.sha256)) throw fail('SOURCE_VIDEO_RUN_INVALID');
  const capturedAt = source.capturedAt;

  stage = 'handler_imports';
  const [{ createInMemoryGrokRuntime }, mediaModule, { createGrokCffiAssetReader, validateGrokAssetRequestContext },
    { createRequestDigest }, { readMp4DurationFromFile },
    proofModule, checklistModule] = await Promise.all([
    import('../src/runtime.mjs'),
    import('../src/grok-media-api.mjs'),
    import('../src/grok-media-asset-reader.mjs'),
    import('../src/transport.mjs'),
    import('../src/mp4-duration.mjs'),
    import('../src/grok-media-proof-receipts.mjs'),
    import('../src/feature-checklist.mjs'),
  ]);
  const runtime = await createInMemoryGrokRuntime({
    pythonExecutable: process.env.GROK_CHROME_PYTHON ?? 'python3',
    journalFilePath: path.join(HOME, '.nad-scratch', 'grok-web-xhr-client', 'operations.json'),
  });
  const readReceipts = new Map();
  const originalRead = runtime.client.read.bind(runtime.client);
  runtime.client.read = async (operationId, request, options) => {
    readDiagnostic = { operationId, httpStatus: null, errorCode: null };
    try {
      const result = await originalRead(operationId, request, options);
      readDiagnostic.httpStatus = result.status;
      if (READBACK_OPERATION_IDS.includes(operationId)) {
        const previous = readReceipts.get(operationId) ?? { pageCount: 0 };
        readReceipts.set(operationId, {
          operationId,
          httpStatus: result.status,
          responseBytes: result.responseBytes ?? null,
          responseDigest: result.rawResponseDigest ?? null,
          responseDigestKind: result.rawResponseDigestKind ?? null,
          pageCount: previous.pageCount + 1,
        });
      }
      return result;
    } catch (error) {
      readDiagnostic.errorCode = typeof error?.code === 'string' ? error.code : 'READ_FAILED';
      readDiagnostic.httpStatus = Number.isInteger(error?.details?.status) ? error.details.status : null;
      throw error;
    }
  };
  let runPath = null;
  try {
    stage = 'owner_verification';
    await runtime.client.importSession(input.sessionBundle);
    await runtime.client.verifyOwner(input.expectedIdentity);
    const storedSession = await runtime.sessionPersistence.read();
    const ownerScopeSha256 = storedSession?.session?.ownerBinding?.identityDigest;
    if (storedSession?.kind !== 'grok-session' || ownerScopeSha256 !== sourceRun.owner.ownerScopeSha256) {
      throw fail('CURRENT_OWNER_SCOPE_MISMATCH');
    }

    stage = 'completed_intent_and_operation_binding';
    const intentJournalPath = path.join(HOME, '.nad-scratch', 'grok-web-xhr-client', 'media-intents.json');
    const intentJournalValue = JSON.parse(await readFile(intentJournalPath, 'utf8'));
    const completedIntents = (Array.isArray(intentJournalValue.intents) ? intentJournalValue.intents : []).filter(entry =>
      entry.operation === 'media.video.create' && entry.ownerIdentityDigest === ownerScopeSha256
      && entry.promptSha256 === sourceRun.promptSha256 && entry.promptLength === input.promptLength
      && entry.attemptNumber === 1 && entry.state === 'completed'
      && sha(`media.video.create\n${ownerScopeSha256}\n${entry.intentId}`) === sourceRun.intentDigest);
    if (completedIntents.length !== 1) throw fail('COMPLETED_VIDEO_INTENT_NOT_UNIQUE');

    const operationRows = (await runtime.journal.list()).filter(entry => entry.contractId === 'media.video.create'
      && entry.intentDigest === sourceRun.intentDigest && entry.state === 'completed' && entry.httpStatus === 200
      && entry.requestDigest === sourceRun.requestDigest && entry.attemptCount === 1);
    if (operationRows.length !== 1) throw fail('COMPLETED_VIDEO_OPERATION_NOT_UNIQUE');
    const operationStart = timeMs(operationRows[0].createdAt);
    if (operationStart === null) throw fail('VIDEO_OPERATION_TIME_INVALID');

    stage = 'asset_reader_setup';
    const assetReader = createGrokCffiAssetReader({
      pythonExecutable: process.env.GROK_CHROME_PYTHON ?? 'python3',
      scriptPath: path.join(ROOT, 'scripts', 'grok_media_asset_download.py'),
    });
    const mediaApi = mediaModule.createGrokMediaApi({ client: runtime.client, assetReader,
      assetServerUrl: `${input.assetRequestContext.assetOrigin}/` });
    validateGrokAssetRequestContext('https://assets.grok.com/users/owner/generated/video.mp4?cache=1',
      input.assetRequestContext, ownerScopeSha256);

    stage = 'direct_task_history_readback';
    const listed = await mediaApi.listAssets({ maxPages: 20 });
    if (listed.status !== 200 || listed.complete !== true || listed.nextPageAvailable !== false) {
      throw fail('ASSET_LIST_INCOMPLETE');
    }
    const byTime = listed.assets.filter(asset => {
      const raw = asset[mediaModule.GROK_MEDIA_PRIVATE_ASSET_DATA];
      const created = timeMs(asset.createTime);
      return asset.mimeType === 'video/mp4' && asset.isPublic === false && asset.isModelGenerated === true
        && raw?.assetId && raw?.responseId && raw?.sourceConversationId
        && created !== null && created >= operationStart - 5_000 && created <= Date.now() + 5_000;
    });
    const exactMatches = [];
    for (const asset of byTime) {
      const raw = asset[mediaModule.GROK_MEDIA_PRIVATE_ASSET_DATA];
      const evidence = await mediaApi.readConversationEvidence({
        conversationId: raw.sourceConversationId,
        expectedPromptSha256: sourceRun.promptSha256,
      });
      const matchingResponseIds = evidence[mediaModule.GROK_MEDIA_PRIVATE_RESPONSE_IDS]?.matchingPrompt ?? [];
      if (evidence.conversationMatch === true && evidence.promptExactMatch === true
        && evidence.uniqueUserPromptCount === 1 && evidence.promptSha256 === sourceRun.promptSha256
        && matchingResponseIds.includes(raw.responseId)) {
        exactMatches.push(asset);
      }
    }
    if (exactMatches.length !== 1 || exactMatches[0][mediaModule.GROK_MEDIA_PRIVATE_ASSET_DATA]?.assetId !== input.assetId) {
      throw fail('VIDEO_TASK_ASSET_NOT_UNIQUE_OR_MISMATCHED');
    }

    const artifactRoot = path.join(HOME, 'artifacts', 'grok-media-20261006');
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    await chmod(artifactRoot, 0o700);
    const artifactPath = path.join(artifactRoot, input.outputName);
    if (await lstat(artifactPath).catch(() => null)) throw fail('ARTIFACT_OUTPUT_ALREADY_EXISTS');
    const requestUrl = mediaModule.buildGrokAssetUrl(
      exactMatches[0][mediaModule.GROK_MEDIA_PRIVATE_ASSET_DATA].key,
      `${input.assetRequestContext.assetOrigin}/`,
    ).href;
    const requestDigest = createRequestDigest({ method: 'GET', url: requestUrl, body: null });
    stage = 'asset_download';
    const download = await mediaApi.downloadAssetToFile(exactMatches[0], {
      assetRequestContext: input.assetRequestContext,
      expectedOwnerIdentityDigest: ownerScopeSha256,
      outputRoot: artifactRoot,
      outputName: input.outputName,
    });
    if (download.status !== 200 || download.mimeType !== 'video/mp4' || download.magicVerified !== true
      || download.sha256 !== sourceRun.artifacts[0].sha256 || download.bodyBytes !== sourceRun.artifacts[0].bytes
      || download.diskSha256 !== download.sha256 || download.diskBodyBytes !== download.bodyBytes) {
      throw fail('VIDEO_ASSET_READBACK_MISMATCH');
    }
    stage = 'artifact_file_readback';
    const durationSeconds = await readMp4DurationFromFile(download.artifactPath);
    if (durationSeconds < 4.5 || durationSeconds > 7.5) throw fail('VIDEO_ASSET_DURATION_INVALID');
    const observedAt = isoNow();
    const currentSource = await sourceSnapshot();
    const stableThroughReadback = currentSource.digest === source.digest;
    if (!stableThroughReadback) throw fail('SOURCE_CHANGED_DURING_READBACK');

    const operationReadbacks = READBACK_OPERATION_IDS.map(id => {
      const value = readReceipts.get(id);
      if (!value || value.httpStatus !== 200 || !Number.isSafeInteger(value.responseBytes) || value.responseBytes < 1
        || !isSha(value.responseDigest) || value.responseDigestKind !== 'raw_http_body') {
        throw fail('READBACK_HTTP_RECEIPT_MISSING');
      }
      return {
        operationId: value.operationId,
        httpStatus: value.httpStatus,
        responseBytes: value.responseBytes,
        responseDigest: value.responseDigest,
        responseDigestKind: value.responseDigestKind,
      };
    });

    const runRecord = {
      schemaVersion: 1,
      recordType: 'grok-media-source-bound-run',
      requirementId: 'artifact.video.download',
      observedAt,
      sourceExecution: {
        capturedAt: capturedAt,
        capturedBeforeDispatch: true,
        stableThroughReadback: true,
        codeSha256: source.codeSha256,
      },
      owner: {
        verified: true,
        sameAuthenticatedOwner: true,
        proofPath: sourceRun.owner.proofPath,
        canonicalSha256: sourceRun.owner.canonicalSha256,
        ownerScopeSha256,
        identityReceiptSha256: sourceRun.owner.identityReceiptSha256,
      },
      requestDigest,
      intentDigest: sourceRun.intentDigest,
      promptSha256: sourceRun.promptSha256,
      browserCapture: input.browserCapture,
      directTransport: {
        transport: 'asset_http',
        origin: 'https://assets.grok.com',
        path: '/users/{owner}/generated/{assetKey}',
        method: 'GET',
        requestStarted: true,
        responseReceived: true,
        httpStatus: download.status,
        responseMime: download.mimeType,
        responseBytes: download.bodyBytes,
        responseDigest: download.sha256,
        directDispatchCount: 1,
        automaticRetries: 0,
        tlsVerified: true,
        redirectsFollowed: false,
        trustEnv: false,
        attemptCount: 1,
      },
      operationReadbacks,
      semanticReadback: {
        taskBoundToIntent: true,
        exactPromptMatched: true,
        assetOwnerVerified: true,
        assetPromptMatched: true,
        sourceConversationMatched: true,
      },
      artifacts: [{
        httpStatus: download.status,
        mimeType: download.mimeType,
        bytes: download.bodyBytes,
        sha256: download.sha256,
        magicVerified: download.magicVerified,
        independentFileReadback: download.diskSha256 === download.sha256 && download.diskBodyBytes === download.bodyBytes,
        taskAssetMatched: true,
      }],
      persistenceAssertions: PERSISTENCE_ASSERTIONS,
    };

    const proofPath = sourceRun.owner.proofPath;
    const ownerProof = await readContainedJson(proofPath);
    const currentOwnerPath = process.env.GROK_CURRENT_OWNER_PROOF_PATH
      ?? 'verification/grok-feature-live-receipts/auth-owner.read.json';
    const currentOwnerProof = await readContainedJson(currentOwnerPath);
    const ownerProofDocuments = { [proofPath]: ownerProof, [currentOwnerPath]: currentOwnerProof };
    const currentOwner = {
      path: currentOwnerPath,
      canonicalSha256: sha(canonicalJson(currentOwnerProof)),
      ownerScopeSha256: currentOwnerProof.ownerScopeSha256,
    };
    if (currentOwner.ownerScopeSha256 !== ownerScopeSha256) throw fail('CURRENT_OWNER_PROOF_SCOPE_MISMATCH');
    const checklist = await readContainedJson('contracts/grok-feature-checklist.v1.json');
    checklistModule.validateFeatureChecklist(checklist);
    const runName = `grok-media-video-asset-readback-${observedAt.replace(/[-:.]/g, '')}-${sourceRun.intentDigest.slice(0, 16)}.json`;
    runPath = `verification/one-shot/${runName}`;
    await atomicJson(runPath, runRecord);
    const runBytes = await readFile(path.join(ROOT, runPath));
    const readRunDigest = sha(runBytes);
    runBytes.fill(0);
    stage = 'canonical_receipt_validation';
    const result = await proofModule.emitGrokMediaProofReceipt({
      repoRoot: ROOT,
      checklist,
      requirementId: 'artifact.video.download',
      runRecord,
      artifactFilePaths: [artifactPath],
      ownerProofDocuments,
      currentOwnerProof: currentOwner,
      artifactRoot: path.join(HOME, 'artifacts'),
    });
    if (result.status !== 'verified') throw fail('MEDIA_PROOF_RECEIPT_NOT_VERIFIED');

    const sourceLinkPath = `verification/one-shot/grok-media-video-readback-link-${sourceRun.intentDigest.slice(0, 16)}-${readRunDigest.slice(0, 8)}.json`;
    const sourceLink = {
      schemaVersion: 1,
      recordType: 'grok-media-video-readback-link',
      sourceVideoRunPath: input.sourceRunPath,
      sourceVideoRunSha256: input.sourceRunSha256,
      directVideoIntentDigest: sourceRun.intentDigest,
      directVideoRequestDigest: sourceRun.requestDigest,
      directVideoJournalState: 'completed',
      directVideoJournalHttpStatus: 200,
      assetReadbackRunPath: runPath,
      assetReadbackRunSha256: readRunDigest,
      assetReadbackRequestDigest: requestDigest,
      assetReadbackHttpStatus: download.status,
      artifactBytes: download.bodyBytes,
      artifactSha256: download.sha256,
      videoDurationSeconds: Math.round(durationSeconds * 1000) / 1000,
    };
    await writeLink(sourceLinkPath, sourceLink);

    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: 'verified',
      requirementId: 'artifact.video.download',
      sourceSnapshotSha256: source.digest,
      sourceCodeSnapshotAt: capturedAt,
      sourceStableThroughReadback: true,
      ownerVerified: true,
      sourceVideoIntentJournalLinked: true,
      taskAssetMatched: true,
      httpStatus: download.status,
      mimeType: download.mimeType,
      bodyBytes: download.bodyBytes,
      artifactSha256: download.sha256,
      magicVerified: download.magicVerified,
      independentFileReadback: true,
      videoDurationSeconds: Math.round(durationSeconds * 1000) / 1000,
      artifactReceiptPath: result.receiptPath,
      sourceRunPath: runPath,
      sourceRunSha256: readRunDigest,
      sourceLinkPath,
      sourceLinkSha256: sha(canonicalJson(sourceLink)),
    })}\n`);
  } finally {
    await runtime.client.clearSession().catch(() => {});
  }
}

run().catch(error => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code : 'VIDEO_ASSET_READBACK_FAILED';
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: 'failed', stage,
    operationId: readDiagnostic.operationId,
    httpStatus: readDiagnostic.httpStatus,
    directReadMayHaveStarted: ['asset_download', 'artifact_file_readback', 'canonical_receipt_validation'].includes(stage),
    errorCode: code })}\n`);
  process.exitCode = 1;
});
