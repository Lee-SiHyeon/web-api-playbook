#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInMemoryGrokConversationFilesRuntime } from '../src/grok-conversation-files-runtime.mjs';
import { submitCapturedGrokConversationContinuationOnce } from '../src/grok-conversation-continuation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT_RECEIPT = path.join(ROOT, 'verification/grok-conversation-files-text-live-2026-10-06.json');
const FILE_RECEIPT = path.join(ROOT, 'verification/grok-conversation-files-live-2026-10-06.json');
const CREATE_RECEIPT = path.join(ROOT, 'verification/grok-conversation-files-create-live-2026-10-06.json');
const EXPECTED_OWNER_SCOPE = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7';
const FILE_NAME = '07b2d9f8b7b4b2abfa1afcd2e5dce663.csv';
const MAX_PACKET_BYTES = 12 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 64;
const CODE_FILES = [
  'src/client.mjs', 'src/contracts.mjs', 'src/transport.mjs', 'src/session.mjs',
  'src/grok-conversation-files.mjs', 'src/grok-conversation-files-runtime.mjs',
  'src/grok-file-artifact-fetch.mjs', 'src/file-download.mjs', 'src/grok-text-websocket.mjs',
  'scripts/grok-file-artifact-download.py', 'scripts/grok-zip-artifact-inspect.py',
  'scripts/grok-conversation-files-once.mjs', 'contracts/grok-web.v1.json',
  'contracts/grok-conversation-files-source-fragment-2026-10-06.json',
  'src/cli.mjs', 'scripts/grok-conversation-files-capture-once.py',
  'scripts/grok-conversation-files-cid-recover-once.mjs',
  'scripts/grok-text-websocket-transport.py',
  'src/grok-conversation-continuation.mjs', 'test/grok-conversation-continuation.test.mjs',
];
const createdReceipts = new Set();

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function scrub(value, depth = 0, seen = new Set()) {
  if (depth > 24 || value === null || value === undefined || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') { /* array element cleared below */ }
    }
    for (let index = 0; index < value.length; index += 1) {
      try {
        if (typeof value[index] === 'string') value[index] = '';
        else scrub(value[index], depth + 1, seen);
      } catch { /* best effort */ }
    }
    return;
  }
  for (const key of Object.keys(value)) {
    try {
      if (typeof value[key] === 'string') value[key] = '';
      else scrub(value[key], depth + 1, seen);
    } catch { /* best effort */ }
  }
}

async function readPacket() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_PACKET_BYTES) fail('FILES_PACKET_TOO_LARGE');
    chunks.push(Buffer.from(buffer));
  }
  if (!bytes) fail('FILES_PACKET_REQUIRED');
  const raw = Buffer.concat(chunks, bytes);
  let packet;
  try { packet = JSON.parse(raw.toString('utf8')); } catch { raw.fill(0); fail('FILES_PACKET_INVALID'); }
  raw.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  const expectedKeys = ['sessionBundle', 'expectedIdentity', 'expectedPrompt', 'fileName', 'intentId',
    'capture', 'captureEvidence', 'conversationId', 'createEvidence', 'cidRecoveryEvidence', 'outputDirectory'];
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)
      || JSON.stringify(Object.keys(packet).sort()) !== JSON.stringify(expectedKeys.sort())
      || !packet.sessionBundle || typeof packet.sessionBundle !== 'object' || Array.isArray(packet.sessionBundle)
      || typeof packet.expectedIdentity !== 'string' || !packet.expectedIdentity.trim()
      || typeof packet.expectedPrompt !== 'string' || !packet.expectedPrompt.trim()
      || Buffer.byteLength(packet.expectedPrompt, 'utf8') > 4096
      || packet.fileName !== FILE_NAME
      || typeof packet.intentId !== 'string' || !packet.intentId.trim()
      || !packet.capture || typeof packet.capture !== 'object' || Array.isArray(packet.capture)
      || !packet.captureEvidence || typeof packet.captureEvidence !== 'object' || Array.isArray(packet.captureEvidence)
      || typeof packet.conversationId !== 'string' || packet.conversationId.length < 16 || packet.conversationId.length > 512
      || /[\r\n\0]/.test(packet.conversationId)
      || !packet.createEvidence || typeof packet.createEvidence !== 'object' || Array.isArray(packet.createEvidence)
      || packet.cidRecoveryEvidence !== null
        && (!packet.cidRecoveryEvidence || typeof packet.cidRecoveryEvidence !== 'object' || Array.isArray(packet.cidRecoveryEvidence))
      || typeof packet.outputDirectory !== 'string' || !path.isAbsolute(packet.outputDirectory)) {
    scrub(packet);
    fail('FILES_PACKET_INVALID');
  }
  return packet;
}

async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (!createdReceipts.has(filePath)) {
    try { await readFile(filePath); fail('FILES_RECEIPT_ALREADY_EXISTS'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, filePath);
    createdReceipts.add(filePath);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

async function codeSnapshot() {
  const snapshot = {};
  for (const file of CODE_FILES) snapshot[file] = sha256(await readFile(path.join(ROOT, file)));
  return snapshot;
}

async function requireReceiptAbsent(filePath) {
  try { await readFile(filePath); fail('FILES_RECEIPT_ALREADY_EXISTS'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

async function exactPromptConversation(client, conversationId, prompt, expectedIdSha256, ownerScopeSha256) {
  if (sha256(conversationId) !== expectedIdSha256) fail('FILES_TASK_CREATE_BINDING_MISMATCH');
  const detail = await client.read('conversation.read', { conversationId }, { expectedOwnerScopeSha256: ownerScopeSha256 });
  const row = detail?.data?.conversation;
  if (detail.status !== 200 || !row || row.conversationId !== conversationId || row.viewerIsOwner !== true) {
    fail('FILES_TASK_OWNER_DETAIL_UNVERIFIED');
  }
  const nodes = await client.read('history.response-nodes', { conversationId }, { expectedOwnerScopeSha256: ownerScopeSha256 });
  const responseNodes = nodes?.data?.responseNodes;
  if (nodes.status !== 200 || !Array.isArray(responseNodes) || !Array.isArray(nodes.data?.inflightResponses)
      || nodes.data.inflightResponses.length !== 0 || responseNodes.length !== 2
      || responseNodes.some(item => !item || typeof item.responseId !== 'string')) fail('FILES_TASK_HISTORY_NODES_UNVERIFIED');
  const responseIds = [...new Set(responseNodes.map(item => item.responseId))];
  if (responseIds.length !== 2) fail('FILES_TASK_HISTORY_NODES_UNVERIFIED');
  const loaded = await client.read('history.load-responses', { conversationId, responseIds }, {
    expectedOwnerScopeSha256: ownerScopeSha256,
  });
  const responses = loaded?.data?.responses;
  if (loaded.status !== 200 || !Array.isArray(responses)) fail('FILES_TASK_HISTORY_LOAD_FAILED');
  const users = responses.filter(item => ['user', 'human', 'you'].includes(String(item?.sender ?? '').toLowerCase())
    && item?.message === prompt);
  const assistants = responses.filter(item => ['assistant', 'model'].includes(String(item?.sender ?? '').toLowerCase()));
  if (users.length !== 1 || assistants.length !== 1 || assistants[0].parentResponseId !== users[0].responseId) {
    fail('FILES_TASK_HISTORY_SEMANTIC_MISMATCH');
  }
  return {
    conversationId,
    conversationIdSha256: sha256(conversationId),
    detailStatus: detail.status,
    detailResponseBytes: detail.responseBytes,
    detailRequestDigest: detail.requestDigest,
    detailResponseDigest: detail.rawResponseDigest ?? detail.responseDigest,
    nodesStatus: nodes.status,
    nodesResponseBytes: nodes.responseBytes,
    nodesRequestDigest: nodes.requestDigest,
    nodesResponseDigest: nodes.rawResponseDigest ?? nodes.responseDigest,
    nodeCount: responseNodes.length,
    loadStatus: loaded.status,
    loadResponseBytes: loaded.responseBytes,
    loadRequestDigest: loaded.requestDigest,
    loadResponseDigest: loaded.rawResponseDigest ?? loaded.responseDigest,
    exactPromptMatchCount: users.length,
    assistantChildMatched: true,
    viewerIsOwner: true,
  };
}

async function listTaskFiles(files, conversationId, ownerScopeSha256) {
  let pageToken;
  const seen = new Set();
  const rows = [];
  const pages = [];
  for (let index = 0; index < 8; index += 1) {
    const input = { conversationId, path: '/', pageSize: 100, ...(pageToken ? { pageToken } : {}) };
    const result = await files.listFiles(input, { expectedOwnerScopeSha256: ownerScopeSha256 });
    pages.push({ status: result.status, responseBytes: result.responseBytes,
      requestDigest: result.requestDigest, responseDigest: result.rawResponseDigest ?? result.responseDigest,
      fileCount: result.files.length, nextPageTokenPresent: Boolean(result.nextPageToken) });
    rows.push(...result.files);
    const next = result.nextPageToken;
    if (!next) return { rows, pages, complete: true };
    if (seen.has(next)) fail('FILES_LIST_CURSOR_CYCLE');
    seen.add(next);
    pageToken = next;
  }
  return { rows, pages, complete: false };
}

async function runZipInspector(filePath, expectedName) {
  const packet = Buffer.from(JSON.stringify({ artifactPath: filePath, expectedEntryName: expectedName }), 'utf8');
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.GROK_CHROME_PYTHON || 'python3', [path.join(ROOT, 'scripts/grok-zip-artifact-inspect.py')], {
      cwd: ROOT, stdio: ['pipe', 'pipe', 'ignore'],
      env: { PYTHONDONTWRITEBYTECODE: '1', PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/home/worker', TMPDIR: process.env.TMPDIR ?? '/home/worker/.nad-scratch/tmp' },
    });
    let stdout = Buffer.alloc(0);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Object.assign(new Error('ZIP_INSPECT_TIMEOUT'), { code: 'ZIP_INSPECT_TIMEOUT' })); }, 30_000);
    child.stdout.on('data', chunk => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      if (stdout.length > 16 * 1024) { child.kill('SIGKILL'); reject(Object.assign(new Error('ZIP_INSPECT_OUTPUT_INVALID'), { code: 'ZIP_INSPECT_OUTPUT_INVALID' })); }
    });
    child.on('error', () => { clearTimeout(timer); reject(Object.assign(new Error('ZIP_INSPECT_FAILED'), { code: 'ZIP_INSPECT_FAILED' })); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const output = JSON.parse(stdout.toString('utf8'));
        if (code !== 0 && output?.status !== 'needs_review') return reject(Object.assign(new Error('ZIP_INSPECT_FAILED'), { code: 'ZIP_INSPECT_FAILED' }));
        resolve(output);
      } catch { reject(Object.assign(new Error('ZIP_INSPECT_OUTPUT_INVALID'), { code: 'ZIP_INSPECT_OUTPUT_INVALID' })); }
    });
    child.stdin.end(packet, () => packet.fill(0));
  });
}

async function main() {
  let packet;
  let runtime;
  let conversationId = '';
  let filePath = '';
  try {
    packet = await readPacket();
    if (sha256(packet.expectedIdentity.trim().toLowerCase()) !== EXPECTED_OWNER_SCOPE
        || packet.createEvidence?.operationId !== 'conversation.create'
        || packet.createEvidence?.state !== 'completed'
        || packet.createEvidence?.verified !== true
        || packet.createEvidence?.ownerScopeSha256 !== EXPECTED_OWNER_SCOPE
        || packet.createEvidence?.conversationIdSha256 !== sha256(packet.conversationId)
        || packet.createEvidence?.httpStatus !== 200
        || packet.createEvidence?.readbackStatus !== 200
        || packet.captureEvidence?.sourcePageRole !== 'codex-grok-files-20261006'
        || packet.captureEvidence?.promptSha256 !== sha256(packet.expectedPrompt)
        || packet.captureEvidence?.businessFrameCaptured !== true
        || packet.captureEvidence?.browserBusinessFramesDelivered !== 0
        || packet.captureEvidence?.markerSearchStatus !== 200
        || !['zero_matches', 'broad_hits_no_exact_title'].includes(packet.captureEvidence?.markerSearchCoverage)
        || !Number.isInteger(packet.captureEvidence?.markerSearchMatchCount)
        || !Number.isInteger(packet.captureEvidence?.exactTitleMatchCount)
        || packet.captureEvidence?.exactTitleMatchCount !== 0
        || packet.captureEvidence?.conversationIdSha256 !== sha256(packet.conversationId)
        || packet.cidRecoveryEvidence !== null
          && (packet.cidRecoveryEvidence?.operationId !== 'conversation.create.task-cid-reconcile'
            || packet.cidRecoveryEvidence?.status !== 'completed'
            || packet.cidRecoveryEvidence?.ownerVerified !== true
            || packet.cidRecoveryEvidence?.conversationIdSha256 !== sha256(packet.conversationId))
        || packet.capture?.sourcePageRole !== packet.captureEvidence.sourcePageRole
        || packet.capture?.browserWriteAbortVerified !== true
        || packet.capture?.browserBusinessFramesCaptured !== 1
        || packet.capture?.browserBusinessWritesDelivered !== 0
        || packet.capture?.browserControlFramesForwarded !== 1) {
      fail('FILES_TASK_WRITER_PROOF_INVALID');
    }
    await requireReceiptAbsent(TEXT_RECEIPT);
    await requireReceiptAbsent(FILE_RECEIPT);
    const createAudit = JSON.parse(await readFile(CREATE_RECEIPT, 'utf8'));
    if (createAudit?.operationId !== 'conversation.create' || createAudit.status !== 'completed'
        || createAudit.verified !== true || createAudit.ownerVerified !== true
        || createAudit.ownerScopeSha256 !== EXPECTED_OWNER_SCOPE
        || createAudit.conversationIdSha256 !== packet.captureEvidence.conversationIdSha256
        || createAudit.conversationIdSha256 !== packet.createEvidence.conversationIdSha256
        || createAudit.intentDigest !== packet.createEvidence.intentDigest) {
      fail('FILES_TASK_CREATE_RECEIPT_INVALID');
    }
    if (packet.cidRecoveryEvidence !== null) {
      const recoveryAudit = JSON.parse(await readFile(CREATE_RECEIPT.replace(
        'grok-conversation-files-create-live-2026-10-06.json',
        'grok-conversation-files-create-cid-reconcile-live-2026-10-06.json'), 'utf8'));
      if (recoveryAudit?.operationId !== packet.cidRecoveryEvidence.operationId
          || recoveryAudit.status !== 'completed' || recoveryAudit.ownerVerified !== true
          || recoveryAudit.ownerScopeSha256 !== EXPECTED_OWNER_SCOPE
          || recoveryAudit.conversationIdSha256 !== packet.captureEvidence.conversationIdSha256
          || recoveryAudit.conversationIdSha256 !== packet.cidRecoveryEvidence.conversationIdSha256) {
        fail('FILES_TASK_CID_RECOVERY_RECEIPT_INVALID');
      }
    }
    const snapshotBefore = await codeSnapshot();
    runtime = await createInMemoryGrokConversationFilesRuntime({});
    await runtime.client.importSession(packet.sessionBundle);
    const owner = await runtime.client.verifyOwner(packet.expectedIdentity);
    const ownerState = await runtime.sessionPersistence.read();
    const ownerScopeSha256 = ownerState?.session?.ownerBinding?.identityDigest;
    if (owner?.ownerVerified !== true || owner?.source !== 'direct_http_identity_read'
        || ownerScopeSha256 !== EXPECTED_OWNER_SCOPE) fail('FILES_TASK_OWNER_VERIFICATION_FAILED');

    const submitted = await submitCapturedGrokConversationContinuationOnce({
      sessionPersistence: runtime.sessionPersistence,
      operationJournal: runtime.journal,
      client: runtime.client,
      capture: packet.capture,
      conversationId: packet.conversationId,
      intentId: packet.intentId,
      expectedPrompt: packet.expectedPrompt,
      expectedSourcePageRole: packet.captureEvidence.sourcePageRole,
      confirm: true,
      pythonExecutable: process.env.GROK_CHROME_PYTHON ?? 'python3',
    });
    const intentDigest = submitted.intentDigest ?? null;
    const textReceipt = {
      schemaVersion: 1,
      serviceId: 'grok-web',
      operationId: 'chat.text.continuation.wss',
      observedAt: packet.captureEvidence.observedAt,
      recordedAt: new Date().toISOString(),
      status: submitted.state,
      ownerVerified: true,
      ownerScopeSha256,
      promptSha256: packet.captureEvidence.promptSha256,
      promptBytes: Buffer.byteLength(packet.expectedPrompt),
      intentDigest,
      sourcePageRole: packet.captureEvidence.sourcePageRole,
      createIntentDigest: packet.createEvidence.intentDigest,
      conversationIdSha256: submitted.conversationIdSha256,
      prewriteMarkerSearchCoverage: packet.captureEvidence.markerSearchCoverage,
      prewriteMarkerSearchMatchCount: packet.captureEvidence.markerSearchMatchCount,
      prewriteExactTitleMatchCount: packet.captureEvidence.exactTitleMatchCount,
      exactMarkerAbsentBeforeWrite: packet.captureEvidence.markerSearchCoverage === 'zero_matches' ? true : null,
      browserBusinessFramesDelivered: 0,
      directHandshakeStatus: submitted.handshakeStatus,
      directBusinessFramesSent: submitted.directBusinessFrameSent === true ? 1 : 0,
      normalControlFrameSent: submitted.normalControlFrameSent === true,
      serverSessionAcknowledgementObserved: submitted.serverSessionAcknowledgementObserved === true,
      businessFrameBoundToServerSession: submitted.businessFrameBoundToServerSession === true,
      terminalEventObserved: submitted.terminalEventObserved === true,
      terminalEventTypes: submitted.eventTypes ?? [],
      exactHistoryReadbackVerified: submitted.verified === true,
      readbackConversationIdSha256: submitted.conversationIdSha256 ?? null,
      readbackStatus: submitted.readbackStatus ?? null,
      readbackResponseIdHintMatched: submitted.responseHintMatched ?? null,
      fileAttachmentCount: submitted.fileAttachmentCount ?? 0,
      fileAttachmentIdsSha256: submitted.fileAttachmentIdsSha256 ?? null,
      rawPromptPersisted: false,
      rawFramesPersisted: false,
      rawIdsPersisted: false,
      cookiesPersisted: false,
      sourceCodeSnapshotSha256: snapshotBefore,
    };
    await atomicJson(TEXT_RECEIPT, textReceipt);

    if (submitted.state !== 'completed' || submitted.verified !== true
        || !/^[a-f0-9]{64}$/.test(submitted.conversationIdSha256 ?? '')
        || submitted.conversationIdSha256 !== packet.createEvidence.conversationIdSha256) {
      const failedReceipt = {
        schemaVersion: 1,
        serviceId: 'grok-web',
        operationId: 'conversation.files.download-once',
        observedAt: packet.captureEvidence.observedAt,
        recordedAt: new Date().toISOString(),
        status: submitted.state === 'outcome_unknown' ? 'text_task_outcome_unknown' : 'text_task_not_verified',
        ownerVerified: true,
        ownerScopeSha256,
        promptSha256: packet.captureEvidence.promptSha256,
        prewriteMarkerSearchCoverage: packet.captureEvidence.markerSearchCoverage,
        prewriteMarkerSearchMatchCount: packet.captureEvidence.markerSearchMatchCount,
        prewriteExactTitleMatchCount: packet.captureEvidence.exactTitleMatchCount,
        exactMarkerAbsentBeforeWrite: packet.captureEvidence.markerSearchCoverage === 'zero_matches' ? true : null,
        textReceiptPath: 'verification/grok-conversation-files-text-live-2026-10-06.json',
        directHandshakeStatus: submitted.handshakeStatus,
        directBusinessFramesSent: submitted.directBusinessFrameSent === true ? 1 : 0,
        historyReadbackVerified: submitted.verified === true,
        rawIdentifiersPersisted: false,
        rawPromptPersisted: false,
        rawUrlsPersisted: false,
        retryAllowed: false,
      };
      await atomicJson(FILE_RECEIPT, failedReceipt);
      process.stdout.write(JSON.stringify({ operationId: failedReceipt.operationId, status: failedReceipt.status,
        textTaskState: submitted.state, textTaskReadbackVerified: submitted.verified === true,
        directHandshakeStatus: submitted.handshakeStatus, fileApiStatus: null, fileDownloadStatus: null,
        zipDownloadStatus: null, workspaceZipStatus: null, retryAllowed: false }) + '\n');
      return;
    }

    const match = await exactPromptConversation(runtime.client, packet.conversationId, packet.expectedPrompt,
      submitted.conversationIdSha256, ownerScopeSha256);
    conversationId = match.conversationId;
    const pageOutput = await listTaskFiles(runtime.files, conversationId, ownerScopeSha256);
    if (!pageOutput.complete) fail('FILES_TASK_LIST_INCOMPLETE');
    const markerFiles = pageOutput.rows.filter(item => !item.isDirectory && item.name === packet.fileName);
    const otherFiles = pageOutput.rows.filter(item => !item.isDirectory && item.name !== packet.fileName);
    const directories = pageOutput.rows.filter(item => item.isDirectory);
    const receipt = {
      schemaVersion: 1,
      serviceId: 'grok-web',
      operationId: 'conversation.files.download-once',
      observedAt: packet.captureEvidence.observedAt,
      recordedAt: new Date().toISOString(),
      status: 'needs_review',
      ownerVerified: true,
      sameAuthenticatedOwner: true,
      ownerScopeSha256,
      sourceWrites: {
        conversationCreate: {
          operationId: 'conversation.create',
          state: packet.createEvidence.state,
          verified: packet.createEvidence.verified,
          ownerVerified: packet.createEvidence.ownerVerified,
          httpStatus: packet.createEvidence.httpStatus,
          readbackStatus: packet.createEvidence.readbackStatus,
          ownerScopeSha256: packet.createEvidence.ownerScopeSha256,
          conversationIdSha256: packet.createEvidence.conversationIdSha256,
          intentDigest: packet.createEvidence.intentDigest,
          requestDigest: packet.createEvidence.requestDigest,
          responseDigest: packet.createEvidence.responseDigest,
          responseBytes: packet.createEvidence.responseBytes,
          sourceFunctionName: packet.createEvidence.sourceFunctionName,
          sourceMethod: packet.createEvidence.sourceMethod,
          sourcePathTemplate: packet.createEvidence.sourcePathTemplate,
          requestHeaderNames: packet.createEvidence.requestHeaderNames,
          cookieNames: packet.createEvidence.cookieNames,
          responseJobIdObserved: packet.createEvidence.responseJobIdObserved,
        },
      },
      task: {
        operationId: 'chat.text.continuation.wss',
        createOperationId: 'conversation.create',
        createIntentDigest: packet.createEvidence.intentDigest,
        conversationIdRecoveryVerified: packet.cidRecoveryEvidence === null ? null : true,
        intentDigest,
        promptSha256: packet.captureEvidence.promptSha256,
        promptBytes: Buffer.byteLength(packet.expectedPrompt),
        conversationIdSha256: match.conversationIdSha256,
        exactPromptReadbackVerified: true,
        sameConversationAsDirectReadback: true,
        prewriteMarkerSearchCoverage: packet.captureEvidence.markerSearchCoverage,
        prewriteMarkerSearchMatchCount: packet.captureEvidence.markerSearchMatchCount,
        prewriteExactTitleMatchCount: packet.captureEvidence.exactTitleMatchCount,
        exactMarkerAbsentBeforeWrite: packet.captureEvidence.markerSearchCoverage === 'zero_matches' ? true : null,
        conversationDetailStatus: match.detailStatus,
        responseNodesStatus: match.nodesStatus,
        loadedResponsesStatus: match.loadStatus,
        viewerIsOwner: match.viewerIsOwner,
        taskFileNameSha256: sha256(packet.fileName),
        fileNamePersisted: false,
      },
      sourceReads: {
        conversationDetail: {
          status: match.detailStatus,
          responseBytes: match.detailResponseBytes,
          requestDigest: match.detailRequestDigest,
          responseDigest: match.detailResponseDigest,
          viewerIsOwner: match.viewerIsOwner,
        },
        responseNodes: {
          status: match.nodesStatus,
          responseBytes: match.nodesResponseBytes,
          requestDigest: match.nodesRequestDigest,
          responseDigest: match.nodesResponseDigest,
          responseCount: match.nodeCount,
          inflightCount: 0,
        },
        loadResponses: {
          status: match.loadStatus,
          responseBytes: match.loadResponseBytes,
          requestDigest: match.loadRequestDigest,
          responseDigest: match.loadResponseDigest,
          exactPromptMatchCount: match.exactPromptMatchCount,
          assistantChildMatched: match.assistantChildMatched,
        },
        filesList: {
          complete: true,
          pageCount: pageOutput.pages.length,
          entryCount: pageOutput.rows.length,
          fileCount: pageOutput.rows.length - directories.length,
          directoryCount: directories.length,
          expectedFileMatchCount: markerFiles.length,
          otherFileCount: otherFiles.length,
          pages: pageOutput.pages,
          fileNamesPersisted: false,
          filePathsPersisted: false,
        },
      },
      persistenceAssertions: {
        credentialsPersisted: false,
        cookiesPersisted: false,
        signedUrlsPersisted: false,
        rawConversationIdsPersisted: false,
        rawResponseIdsPersisted: false,
        requestBodiesPersisted: false,
        responseBodiesPersisted: false,
        assistantTextPersisted: false,
        artifactBytesPersisted: false,
      },
      artifact: null,
      zip: null,
      workspaceZip: { attempted: false, status: null, verified: false, reason: 'awaiting_task_file' },
      captureReceiptPath: 'verification/grok-conversation-files-capture-2026-10-06.json',
        createReceiptPath: 'verification/grok-conversation-files-create-live-2026-10-06.json',
        cidRecoveryReceiptPath: packet.captureEvidence.cidRecoveryReceiptPath ?? null,
      textReceiptPath: 'verification/grok-conversation-files-text-live-2026-10-06.json',
      rawOutputUrlPersisted: false,
    };

    if (markerFiles.length !== 1) {
      receipt.status = 'file_not_found_or_ambiguous';
      receipt.workspaceZip.reason = 'expected_task_file_not_unique';
      await atomicJson(FILE_RECEIPT, receipt);
      const snapshotAfter = await codeSnapshot();
      receipt.sourceCodeSnapshotStable = JSON.stringify(snapshotBefore) === JSON.stringify(snapshotAfter);
      receipt.sourceCodeSnapshotAfterSha256 = snapshotAfter;
      await atomicJson(FILE_RECEIPT, receipt);
      process.stdout.write(JSON.stringify({ operationId: receipt.operationId, status: receipt.status,
        textTaskState: submitted.state, textTaskReadbackVerified: submitted.verified === true,
        fileApiStatus: pageOutput.pages[0]?.status ?? null, expectedFileMatchCount: markerFiles.length,
        zipDownloadStatus: null, workspaceZipStatus: null, artifactPath: null }) + '\n');
      return;
    }
    if (otherFiles.length > 0 || directories.length > 0) {
      receipt.status = 'task_file_list_contains_other_entries';
      receipt.workspaceZip.reason = 'workspace_contains_additional_entries';
    }
    const taskFile = markerFiles[0];
    filePath = taskFile.path;
    if (receipt.status === 'needs_review') {
      const downloaded = await runtime.files.downloadFile({ conversationId, path: filePath }, {
        expectedOwnerScopeSha256: ownerScopeSha256,
        outputDir: packet.outputDirectory,
        suggestedName: packet.fileName,
      });
      const bytes = await readFile(downloaded.path);
      try {
        const diskSha256 = sha256(bytes);
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
        catch { fail('FILES_CSV_DISK_UTF8_INVALID'); }
        const rows = content.replace(/\r\n/g, '\n').split('\n').filter(Boolean);
        const csvContentMatches = JSON.stringify(rows) === JSON.stringify(['item,count', 'neutral,14']);
        if (diskSha256 !== downloaded.sha256 || bytes.length !== downloaded.bytes) fail('FILES_DISK_READBACK_MISMATCH');
        receipt.artifact = {
          httpStatus: downloaded.httpStatus,
          resolverStatus: downloaded.resolverStatus,
          mimeType: downloaded.mimeType,
          bytes: downloaded.bytes,
          sha256: downloaded.sha256,
          downloadRequestDigest: downloaded.downloadRequestDigest,
          resolverRequestDigest: downloaded.resolverRequestDigest,
          resolverResponseDigest: downloaded.resolverResponseDigest,
          resolverTransportEvidence: downloaded.resolverTransportEvidence,
          downloadTransportEvidence: downloaded.transportEvidence,
          redirectCount: downloaded.redirectCount,
          redirectOrigins: downloaded.redirectOrigins,
          magicVerified: downloaded.magicVerified,
          utf8Verified: downloaded.textEncodingVerified,
          diskReadbackVerified: true,
          csvSemanticMatch: csvContentMatches,
          artifactPath: downloaded.path,
          filePathSha256: sha256(filePath),
        };
        receipt.persistenceAssertions.artifactBytesPersisted = true;
        if (csvContentMatches) receipt.status = 'csv_download_verified';
      } finally { bytes.fill(0); }
    }

    if (receipt.status === 'csv_download_verified' && otherFiles.length === 0 && directories.length === 0) {
      try {
        const zipped = await runtime.files.downloadZip({ conversationId, path: '/' }, {
          expectedOwnerScopeSha256: ownerScopeSha256,
          expectedFileCount: 1,
          expectedTotalSize: receipt.artifact.bytes,
          outputDir: packet.outputDirectory,
          suggestedName: 'codex-file-probe-20261006-files',
        });
        const inspected = await runZipInspector(zipped.path, packet.fileName);
        const zipHashMatches = inspected.entrySha256 === receipt.artifact.sha256
          && inspected.entryBytes === receipt.artifact.bytes && inspected.status === 'verified';
        receipt.zip = {
          resolverStatus: zipped.resolverStatus,
          httpStatus: zipped.httpStatus,
          fileCount: zipped.fileCount,
          totalSize: zipped.totalSize,
          mimeType: zipped.mimeType,
          bytes: zipped.bytes,
          sha256: zipped.sha256,
          requestDigest: zipped.downloadRequestDigest,
          resolverRequestDigest: zipped.resolverRequestDigest,
          resolverResponseDigest: zipped.resolverResponseDigest,
          redirectCount: zipped.redirectCount,
          redirectOrigins: zipped.redirectOrigins,
          magicVerified: zipped.magicVerified,
          archivePath: zipped.path,
          independentInspector: inspected,
          entryBytesMatchedCsv: zipHashMatches,
        };
        if (zipHashMatches) receipt.status = 'csv_and_zip_download_verified';
      } catch (error) {
        receipt.zip = {
          status: 'needs_review',
          errorCode: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
            ? error.code : 'ZIP_DOWNLOAD_FAILED',
          httpStatus: Number.isInteger(error?.details?.status) ? error.details.status : null,
          automaticRetryCount: 0,
        };
      }
      try {
        const workspaceZip = await runtime.files.downloadWorkspaceZip({ conversationId }, {
          expectedOwnerScopeSha256: ownerScopeSha256,
          outputDir: packet.outputDirectory,
          suggestedName: 'codex-file-probe-20261006-workspace',
        });
        const inspected = await runZipInspector(workspaceZip.path, packet.fileName);
        receipt.workspaceZip = {
          attempted: true,
          status: workspaceZip.httpStatus,
          resolverStatus: workspaceZip.resolverStatus,
          bytes: workspaceZip.bytes,
          sha256: workspaceZip.sha256,
          magicVerified: workspaceZip.magicVerified,
          independentInspector: inspected,
          taskCsvEntryMatched: inspected.status === 'verified'
            && inspected.entrySha256 === receipt.artifact.sha256,
          artifactPath: workspaceZip.path,
        };
        if (receipt.workspaceZip.taskCsvEntryMatched && receipt.status === 'csv_and_zip_download_verified') {
          receipt.status = 'csv_files_zip_and_workspace_zip_verified';
        }
      } catch (error) {
        receipt.workspaceZip = {
          attempted: true,
          status: Number.isInteger(error?.details?.status) ? error.details.status : null,
          errorCode: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
            ? error.code : 'WORKSPACE_ZIP_DOWNLOAD_FAILED',
          verified: false,
          automaticRetryCount: 0,
        };
      }
    }

    const snapshotAfter = await codeSnapshot();
    receipt.sourceCodeSnapshotSha256 = snapshotBefore;
    receipt.sourceCodeSnapshotAfterSha256 = snapshotAfter;
    receipt.sourceCodeSnapshotStable = JSON.stringify(snapshotBefore) === JSON.stringify(snapshotAfter);
    await atomicJson(FILE_RECEIPT, receipt);
    process.stdout.write(JSON.stringify({
      operationId: receipt.operationId,
      status: receipt.status,
      textTaskState: submitted.state,
      textTaskReadbackVerified: submitted.verified === true,
      fileApiStatus: receipt.sourceReads.filesList.pages[0]?.status ?? null,
      expectedFileMatchCount: receipt.sourceReads.filesList.expectedFileMatchCount,
      fileDownloadStatus: receipt.artifact?.httpStatus ?? null,
      zipDownloadStatus: receipt.zip?.httpStatus ?? null,
      workspaceZipStatus: receipt.workspaceZip?.status ?? null,
      artifactPath: receipt.artifact?.artifactPath ?? null,
      artifactBytes: receipt.artifact?.bytes ?? null,
      artifactSha256: receipt.artifact?.sha256 ?? null,
    }) + '\n');
  } finally {
    conversationId = '';
    filePath = '';
    if (runtime?.client) await runtime.client.clearSession().catch(() => {});
    if (packet) {
      packet.expectedIdentity = '';
      packet.expectedPrompt = '';
      packet.intentId = '';
      packet.conversationId = '';
      scrub(packet.sessionBundle);
      scrub(packet.capture);
    }
  }
}

main().catch(error => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code : 'FILES_TASK_RUNNER_FAILED';
  process.stdout.write(JSON.stringify({ operationId: 'conversation.files.download-once', status: 'needs_review', errorCode: code,
    retryAllowed: false, rawIdentifiersPersisted: false, rawUrlsPersisted: false }) + '\n');
  process.exitCode = 1;
});
