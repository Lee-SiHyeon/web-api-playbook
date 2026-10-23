#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInMemoryGrokConversationFilesRuntime } from '../src/grok-conversation-files-runtime.mjs';
import { GROK_CONVERSATION_FILE_OPERATION_IDS as FILE_OPS } from '../src/grok-conversation-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT = path.join(ROOT, 'verification/grok-conversation-files-artifact-readback-live-2026-10-06-r4.json');
const OWNER_SCOPE = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7';
const FILE_NAME = '07b2d9f8b7b4b2abfa1afcd2e5dce663.csv';
const ARTIFACT_DIR = path.join(process.env.HOME || '/home/worker', 'artifacts/grok-conversation-files-20261006');
const MAX_PACKET_BYTES = 2 * 1024 * 1024;

function fail(code, details) { throw Object.assign(new Error(code), { code, details }); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function scrub(value, depth = 0, seen = new Set()) {
  if (depth > 24 || !value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = '';
      else scrub(value[index], depth + 1, seen);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') value[key] = '';
    else scrub(value[key], depth + 1, seen);
  }
}
async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { await readFile(filePath); fail('FILES_ARTIFACT_RECEIPT_EXISTS'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, filePath);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
async function readPacket() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_PACKET_BYTES) fail('FILES_ARTIFACT_PACKET_TOO_LARGE');
    chunks.push(bytes);
  }
  if (!size) fail('FILES_ARTIFACT_PACKET_REQUIRED');
  const raw = Buffer.concat(chunks, size);
  let packet;
  try { packet = JSON.parse(raw.toString('utf8')); } catch { raw.fill(0); fail('FILES_ARTIFACT_PACKET_INVALID'); }
  raw.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  if (!plainObject(packet)
      || JSON.stringify(Object.keys(packet).sort()) !== JSON.stringify([
        'sessionBundle', 'expectedIdentity', 'conversationIdSha256', 'expectedPrompt',
      ].sort())
      || !plainObject(packet.sessionBundle)
      || typeof packet.expectedIdentity !== 'string' || !packet.expectedIdentity.trim()
      || sha256(packet.expectedIdentity.trim().toLowerCase()) !== OWNER_SCOPE
      || typeof packet.conversationIdSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(packet.conversationIdSha256)
      || typeof packet.expectedPrompt !== 'string' || !packet.expectedPrompt.trim()
      || Buffer.byteLength(packet.expectedPrompt) > 4096) {
    scrub(packet);
    fail('FILES_ARTIFACT_PACKET_INVALID');
  }
  return packet;
}
function safeResult(result) {
  return {
    status: result.status,
    responseBytes: result.responseBytes ?? null,
    requestDigest: result.requestDigest ?? null,
    responseDigest: result.rawResponseDigest ?? result.responseDigest ?? null,
    contentType: result.contentType ?? null,
  };
}
function responseShape(value, depth = 0) {
  if (depth > 6) return { type: Array.isArray(value) ? 'array' : typeof value };
  if (Array.isArray(value)) {
    const item = value.find(entry => plainObject(entry));
    return { type: 'array', count: value.length, itemFieldNames: item ? Object.keys(item).sort().slice(0, 80) : [] };
  }
  if (!plainObject(value)) return { type: value === null ? 'null' : typeof value };
  const fields = {};
  for (const [key, child] of Object.entries(value).slice(0, 128)) {
    if (Array.isArray(child)) fields[key] = responseShape(child, depth + 1);
    else if (plainObject(child)) fields[key] = { type: 'object', fieldNames: Object.keys(child).sort().slice(0, 80) };
    else fields[key] = { type: child === null ? 'null' : typeof child };
  }
  return { type: 'object', topLevelFieldNames: Object.keys(value).sort().slice(0, 128), fields };
}
function findTaskFileCandidates(data, fileName) {
  const candidates = new Map();
  let visited = 0;
  function visit(value, depth = 0) {
    if (depth > 10 || visited > 10_000) return;
    visited += 1;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 2000)) visit(item, depth + 1);
      return;
    }
    if (!plainObject(value)) return;
    const name = [value.name, value.fileName, value.file_name].find(item => typeof item === 'string');
    const filePath = [value.path, value.filePath, value.file_path].find(item => typeof item === 'string');
    const directory = value.isDirectory === true || value.is_directory === true;
    if (name === fileName && typeof filePath === 'string' && !directory) candidates.set(filePath, value);
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  visit(data);
  return [...candidates.entries()].map(([pathValue, row]) => ({ path: pathValue, row }));
}
function csvMatches(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { return { utf8Verified: false, csvSemanticMatch: false }; }
  const rows = text.replace(/\r\n/g, '\n').split('\n').filter(Boolean);
  return { utf8Verified: true, csvSemanticMatch: JSON.stringify(rows) === JSON.stringify(['item,count', 'neutral,14']) };
}
async function runZipInspector(filePath) {
  const packet = Buffer.from(JSON.stringify({ artifactPath: filePath, expectedEntryName: FILE_NAME }), 'utf8');
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.GROK_CHROME_PYTHON || 'python3', [path.join(ROOT, 'scripts/grok-zip-artifact-inspect.py')], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        PYTHONDONTWRITEBYTECODE: '1',
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/home/worker',
        TMPDIR: process.env.TMPDIR ?? '/home/worker/.nad-scratch/tmp',
      },
    });
    let stdout = Buffer.alloc(0);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Object.assign(new Error('ZIP_INSPECT_TIMEOUT'), { code: 'ZIP_INSPECT_TIMEOUT' })); }, 30_000);
    child.stdout.on('data', chunk => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      if (stdout.length > 16 * 1024) {
        child.kill('SIGKILL');
        reject(Object.assign(new Error('ZIP_INSPECT_OUTPUT_INVALID'), { code: 'ZIP_INSPECT_OUTPUT_INVALID' }));
      }
    });
    child.on('error', () => { clearTimeout(timer); reject(Object.assign(new Error('ZIP_INSPECT_FAILED'), { code: 'ZIP_INSPECT_FAILED' })); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout.toString('utf8'));
        if (code !== 0 && result?.status !== 'needs_review') return reject(Object.assign(new Error('ZIP_INSPECT_FAILED'), { code: 'ZIP_INSPECT_FAILED' }));
        resolve(result);
      } catch { reject(Object.assign(new Error('ZIP_INSPECT_OUTPUT_INVALID'), { code: 'ZIP_INSPECT_OUTPUT_INVALID' })); }
    });
    child.stdin.end(packet, () => packet.fill(0));
  });
}

async function main() {
  let packet;
  let runtime;
  let conversationId = '';
  const receipt = {
    schemaVersion: 1,
    serviceId: 'grok-web',
    operationId: 'conversation.files.artifact-readback',
    recordedAt: new Date().toISOString(),
    status: 'needs_review',
    ownerVerified: false,
    sameAuthenticatedOwner: false,
    ownerScopeSha256: null,
    task: null,
    sourceReads: {},
    artifact: null,
    filesZip: null,
    workspaceZip: null,
    persistenceAssertions: {
      credentialsPersisted: false,
      cookiesPersisted: false,
      rawConversationIdsPersisted: false,
      rawResponseIdsPersisted: false,
      rawRequestBodiesPersisted: false,
      rawResponseBodiesPersisted: false,
      fileNamesPersisted: false,
      filePathsPersisted: false,
      signedUrlsPersisted: false,
      rawUrlsPersisted: false,
    },
  };
  try {
    packet = await readPacket();
    runtime = await createInMemoryGrokConversationFilesRuntime({});
    await runtime.client.importSession(packet.sessionBundle);
    const owner = await runtime.client.verifyOwner(packet.expectedIdentity);
    const ownerStore = await runtime.sessionPersistence.read();
    const ownerScopeSha256 = ownerStore?.session?.ownerBinding?.identityDigest;
    if (owner?.ownerVerified !== true || ownerScopeSha256 !== OWNER_SCOPE) fail('FILES_ARTIFACT_OWNER_FAILED');
    receipt.ownerVerified = true;
    receipt.sameAuthenticatedOwner = true;
    receipt.ownerScopeSha256 = ownerScopeSha256;

    let fileCandidates = [];
    let rawListRows = [];
    if (typeof packet.conversationIdSha256 !== 'string') fail('FILES_TARGET_HASH_INVALID');

    const conversationList = await runtime.client.read('conversation.list.read', { pageSize: 100 }, {
      expectedOwnerScopeSha256: ownerScopeSha256,
    });
    const conversations = conversationList?.data?.conversations;
    if (conversationList.status !== 200 || !Array.isArray(conversations)) fail('FILES_TARGET_LIST_FAILED');
    const matchedConversations = conversations.filter(row => typeof row?.conversationId === 'string'
      && sha256(row.conversationId) === packet.conversationIdSha256);
    if (matchedConversations.length !== 1) fail('FILES_TARGET_HASH_NOT_UNIQUE');
    conversationId = matchedConversations[0].conversationId;

    // Re-read the exact task file list with the recovered owner CID; the initial
    // shape probe above deliberately had no raw ID available yet.
    const exactListResult = await runtime.client.read(FILE_OPS.list, { conversationId, path: '/', pageSize: 100 }, {
      expectedOwnerScopeSha256: ownerScopeSha256,
      sourceDiscoveryPermit: `first-read:${FILE_OPS.list}`,
    });
    receipt.sourceReads.filesList = {
      ...safeResult(exactListResult),
      responseShape: responseShape(exactListResult.data),
    };
    fileCandidates = findTaskFileCandidates(exactListResult.data, FILE_NAME);
    const filesArray = plainObject(exactListResult.data) && Array.isArray(exactListResult.data.files)
      ? exactListResult.data.files : [];
    rawListRows = filesArray;
    receipt.task = {
      conversationIdSha256: sha256(conversationId),
      exactTaskPromptSha256: sha256(packet.expectedPrompt),
      exactTaskPromptBytes: Buffer.byteLength(packet.expectedPrompt),
      fileNameSha256: sha256(FILE_NAME),
      fileNamePersisted: false,
      listExactFileCandidateCount: fileCandidates.length,
      sourceListRowCount: rawListRows.length,
      sourceListShapeAccepted: Array.isArray(exactListResult.data?.files),
    };

    const candidates = fileCandidates.filter(candidate => candidate.row?.isDirectory !== true
      && candidate.row?.is_directory !== true);
    if (candidates.length === 1) {
      const exactPath = candidates[0].path;
      try {
        const fileResult = await runtime.files.downloadFile({ conversationId, path: exactPath }, {
          expectedOwnerScopeSha256: ownerScopeSha256,
          outputDir: ARTIFACT_DIR,
          suggestedName: 'grok-task-file.csv',
        });
        const bytes = await readFile(fileResult.path);
        try {
          const content = csvMatches(bytes);
          const diskVerified = sha256(bytes) === fileResult.sha256 && bytes.length === fileResult.bytes;
          receipt.artifact = {
            resolverStatus: fileResult.resolverStatus,
            httpStatus: fileResult.httpStatus,
            mimeType: fileResult.mimeType,
            bytes: fileResult.bytes,
            sha256: fileResult.sha256,
            requestDigest: fileResult.downloadRequestDigest,
            resolverRequestDigest: fileResult.resolverRequestDigest,
            resolverResponseDigest: fileResult.resolverResponseDigest,
            redirectCount: fileResult.redirectCount,
            redirectOrigins: fileResult.redirectOrigins,
            magicVerified: fileResult.magicVerified,
            utf8Verified: content.utf8Verified,
            csvSemanticMatch: content.csvSemanticMatch,
            diskReadbackVerified: diskVerified,
            pathSha256: sha256(exactPath),
            artifactPath: fileResult.path,
          };
        } finally { bytes.fill(0); }
      } catch (error) {
        receipt.artifact = {
          status: 'content_resolution_needs_review',
          errorCode: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
            ? error.code : 'FILE_CONTENT_READ_FAILED',
          httpStatus: Number.isInteger(error?.details?.status) ? error.details.status : null,
          responseShape: error?.details?.responseShape ?? null,
          contentType: error?.details?.contentType ?? null,
          responseBytes: error?.details?.responseBytes ?? null,
          requestDigest: error?.details?.requestDigest ?? null,
          responseDigest: error?.details?.responseDigest ?? null,
          pathSha256: sha256(exactPath),
          retryCount: 0,
        };
      }
    } else {
      receipt.artifact = {
        status: candidates.length === 0 ? 'task_file_not_listed' : 'task_file_path_ambiguous',
        exactTaskFileMatchCount: candidates.length,
        resolverStatus: exactListResult.status,
      };
    }

    const contentVerified = receipt.artifact?.csvSemanticMatch === true && receipt.artifact.diskReadbackVerified === true;
    if (contentVerified) {
      const fileCount = Number.isSafeInteger(exactListResult.data?.files?.length)
        ? exactListResult.data.files.filter(row => row?.isDirectory !== true).length : null;
      const totalSize = receipt.artifact.bytes;
      if (fileCount === 1) {
        try {
          const zip = await runtime.files.downloadZip({ conversationId, path: '/' }, {
            expectedOwnerScopeSha256: ownerScopeSha256,
            expectedFileCount: 1,
            expectedTotalSize: totalSize,
            outputDir: ARTIFACT_DIR,
            suggestedName: 'grok-task-files.zip',
          });
          const inspected = await runZipInspector(zip.path);
          receipt.filesZip = {
            resolverStatus: zip.resolverStatus,
            httpStatus: zip.httpStatus,
            fileCount: zip.fileCount,
            totalSize: zip.totalSize,
            mimeType: zip.mimeType,
            bytes: zip.bytes,
            sha256: zip.sha256,
            magicVerified: zip.magicVerified,
            redirectCount: zip.redirectCount,
            redirectOrigins: zip.redirectOrigins,
            independentInspector: inspected,
            entryBytesMatchedCsv: inspected.status === 'verified'
              && inspected.entrySha256 === receipt.artifact.sha256 && inspected.entryBytes === receipt.artifact.bytes,
            archivePath: zip.path,
          };
        } catch (error) {
          receipt.filesZip = {
            status: 'needs_review',
            errorCode: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
              ? error.code : 'FILES_ZIP_DOWNLOAD_FAILED',
            httpStatus: Number.isInteger(error?.details?.status) ? error.details.status : null,
            actualMimeType: typeof error?.details?.actualMimeType === 'string' ? error.details.actualMimeType : null,
            allowedMimeTypes: Array.isArray(error?.details?.allowedMimeTypes) ? error.details.allowedMimeTypes : [],
            retryCount: 0,
          };
        }
      } else {
        receipt.filesZip = { status: 'not_attempted', reason: 'source_file_count_not_exactly_one' };
      }
    } else {
      receipt.filesZip = { status: 'not_attempted', reason: 'exact_task_file_content_not_verified' };
    }

    try {
      const workspace = await runtime.files.downloadWorkspaceZip({ conversationId }, {
        expectedOwnerScopeSha256: ownerScopeSha256,
        outputDir: ARTIFACT_DIR,
        suggestedName: 'grok-task-workspace.zip',
      });
      const inspected = await runZipInspector(workspace.path);
      receipt.workspaceZip = {
        resolverStatus: workspace.resolverStatus,
        httpStatus: workspace.httpStatus,
        bytes: workspace.bytes,
        sha256: workspace.sha256,
        magicVerified: workspace.magicVerified,
        responseMimeType: workspace.responseMimeType,
        redirectCount: workspace.redirectCount,
        redirectOrigins: workspace.redirectOrigins,
        independentInspector: inspected,
        entryBytesMatchedCsv: inspected.status === 'verified'
          && (receipt.artifact?.sha256 === undefined || inspected.entrySha256 === receipt.artifact.sha256)
          && (receipt.artifact?.bytes === undefined || inspected.entryBytes === receipt.artifact.bytes),
        entryIsExpectedCsv: inspected.status === 'verified',
        archivePath: workspace.path,
      };
    } catch (error) {
      receipt.workspaceZip = {
        status: 'needs_review',
        errorCode: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
          ? error.code : 'WORKSPACE_ZIP_DOWNLOAD_FAILED',
        httpStatus: Number.isInteger(error?.details?.status) ? error.details.status : null,
        actualMimeType: typeof error?.details?.actualMimeType === 'string' ? error.details.actualMimeType : null,
        allowedMimeTypes: Array.isArray(error?.details?.allowedMimeTypes) ? error.details.allowedMimeTypes : [],
        retryCount: 0,
      };
    }

    const contentOk = receipt.artifact?.csvSemanticMatch === true && receipt.artifact.diskReadbackVerified === true;
    const filesZipOk = receipt.filesZip?.entryBytesMatchedCsv === true;
    const workspaceZipOk = receipt.workspaceZip?.entryIsExpectedCsv === true;
    receipt.status = contentOk && filesZipOk && workspaceZipOk ? 'content_files_zip_workspace_zip_verified'
      : contentOk && filesZipOk ? 'content_and_files_zip_verified'
        : contentOk && workspaceZipOk ? 'content_and_workspace_zip_verified'
          : contentOk ? 'content_bytes_verified'
            : workspaceZipOk ? 'workspace_zip_entry_verified' : 'needs_review';
    receipt.recordedAt = new Date().toISOString();
    await atomicJson(RECEIPT, receipt);
    process.stdout.write(JSON.stringify({
      operationId: receipt.operationId,
      status: receipt.status,
      ownerVerified: true,
      conversationIdSha256: receipt.task.conversationIdSha256,
      fileListStatus: receipt.sourceReads.filesList.status,
      fileListTopLevelFieldNames: receipt.sourceReads.filesList.responseShape?.topLevelFieldNames ?? [],
      exactTaskFileMatchCount: receipt.task.listExactFileCandidateCount,
      contentStatus: receipt.artifact?.httpStatus ?? null,
      contentBytes: receipt.artifact?.bytes ?? null,
      contentSha256: receipt.artifact?.sha256 ?? null,
      filesZipStatus: receipt.filesZip?.httpStatus ?? null,
      workspaceZipStatus: receipt.workspaceZip?.httpStatus ?? null,
      artifactPath: receipt.artifact?.artifactPath ?? null,
      receiptPath: 'verification/grok-conversation-files-artifact-readback-live-2026-10-06-r4.json',
      rawIdentifiersPersisted: false,
      rawUrlsPersisted: false,
    }) + '\n');
  } finally {
    conversationId = '';
    if (runtime?.client) await runtime.client.clearSession().catch(() => {});
    if (packet) {
      packet.expectedIdentity = '';
      packet.conversationIdSha256 = '';
      packet.expectedPrompt = '';
      scrub(packet.sessionBundle);
    }
  }
}

main().catch(error => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code : 'FILES_ARTIFACT_READBACK_FAILED';
  process.stdout.write(JSON.stringify({ operationId: 'conversation.files.artifact-readback',
    status: 'needs_review', errorCode: code, rawIdentifiersPersisted: false, rawUrlsPersisted: false,
    retryAllowed: false }) + '\n');
  process.exitCode = 1;
});
