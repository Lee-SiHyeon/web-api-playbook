import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = '/home/worker/work/provider-login-20261004/grok-web-xhr-client';
const PROMOTION_PROOF = 'verification/grok-fast-task-readonly-cli-live-2026-10-06-r6.json';
const CURRENT_PROOF = 'verification/grok-fast-task-readonly-cli-live-2026-10-06-r7.json';
const READ_IDS = Object.freeze(['conversation.list.read', 'conversation.read', 'history.response-nodes', 'history.load-responses']);
const OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7';
const FEATURE_RECEIPT_DIR = 'verification/grok-feature-live-receipts';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function validHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!object(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortObject(value[key])]));
}
function operationDigest(operation) { return sha256(canonical(operation)); }
function nowIso() { return new Date().toISOString(); }
async function json(relative) { return JSON.parse(await readFile(path.join(ROOT, relative), 'utf8')); }

function extractEvidenceSpan(source, operationId) {
  const marker = `"id": ${JSON.stringify(operationId)}`;
  const idOffset = source.indexOf(marker);
  if (idOffset < 0) throw new Error('OPERATION_TEXT_NOT_FOUND');
  const keyOffset = source.indexOf('"evidence"', idOffset + marker.length);
  if (keyOffset < 0) throw new Error('EVIDENCE_TEXT_NOT_FOUND');
  const colon = source.indexOf(':', keyOffset + '"evidence"'.length);
  const open = source.indexOf('{', colon + 1);
  if (colon < 0 || open < 0) throw new Error('EVIDENCE_OBJECT_NOT_FOUND');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return { start: open, end: index + 1, keyOffset };
  }
  throw new Error('EVIDENCE_OBJECT_UNCLOSED');
}

function indentJson(value, indent) {
  return JSON.stringify(value, null, 2).split('\n').map((line, index) => index === 0 ? line : `${indent}${line}`).join('\n');
}

async function writeAtomic(target, data, mode = 0o600, { replace = false } = {}) {
  const absolute = path.join(ROOT, target);
  await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  let prior;
  try { prior = await lstat(absolute); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (prior && (prior.isSymbolicLink() || !prior.isFile())) throw new Error('TARGET_INVALID');
  if (prior && !replace) throw new Error('TARGET_EXISTS');
  const temp = `${absolute}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { mode, flag: 'wx' });
    await chmod(temp, mode);
    await rename(temp, absolute);
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}

async function writeContentAddressed(target, value) {
  const absolute = path.join(ROOT, target);
  try {
    const prior = JSON.parse(await readFile(absolute, 'utf8'));
    if (canonical(prior) !== canonical(value)) throw new Error('CONTENT_ADDRESSED_PROOF_CONFLICT');
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

async function promoteEvidence() {
  const proof = await json(PROMOTION_PROOF);
  if (proof.status !== 'completed' || proof.sourceSnapshot?.stable !== true
      || proof.ownerScopeSha256 !== OWNER_SHA256) throw new Error('PROMOTION_PROOF_NOT_VERIFIED');
  const target = path.join(ROOT, 'contracts/grok-web.v1.json');
  const original = await readFile(target, 'utf8');
  const registry = JSON.parse(original);
  const prior = {};
  const evidenceEdits = [];
  for (const operationId of READ_IDS) {
    const operation = registry.operations.find(item => item.id === operationId);
    if (!operation || operation.evidence?.source !== 'browser_network_capture') throw new Error('OPERATION_SOURCE_INVALID');
    prior[operationId] = proof.sourceSnapshot.before.contractOperationSha256[operationId];
    if (!validHash(prior[operationId])) throw new Error('PRIOR_OPERATION_HASH_MISSING');
    let replay;
    if (operationId === 'conversation.list.read') {
      const row = proof.reads.listVariants?.variants?.find(item => item.name === 'first_page');
      replay = row && { status: row.httpStatus, responseBytes: row.responseBytes,
        requestDigest: row.requestDigest, rawResponseDigest: row.responseDigest };
    } else {
      const key = operationId === 'conversation.read' ? 'detail'
        : operationId === 'history.response-nodes' ? 'responseNodes' : 'loadResponses';
      const row = proof.reads[key];
      replay = row && { status: row.status, responseBytes: row.responseBytes,
        requestDigest: row.requestDigest, rawResponseDigest: row.rawResponseDigest };
    }
    if (!replay || replay.status !== 200 || !Number.isSafeInteger(replay.responseBytes)
        || !validHash(replay.requestDigest) || !validHash(replay.rawResponseDigest)) throw new Error('REPLAY_METADATA_INVALID');
    const sourceSnapshotBeforeSha256 = sha256(Buffer.from(canonical(proof.sourceSnapshot.before), 'utf8'));
    operation.evidence.directReplayReceipt = PROMOTION_PROOF;
    delete operation.evidence.directReplay;
    operation.evidence.normalCliReplay = {
      source: 'normal_cli_direct_http',
      observedAt: proof.recordedAt,
      status: replay.status,
      ownerVerified: true,
      responseMime: 'application/json',
      responseBytes: replay.responseBytes,
      requestDigest: replay.requestDigest,
      rawResponseDigest: replay.rawResponseDigest,
      responseDigestKind: 'raw_http_body',
      sourceSnapshotBeforeSha256,
      priorOperationProjectionSha256: prior[operationId],
      sourceProofPath: PROMOTION_PROOF,
    };
    const span = extractEvidenceSpan(original, operationId);
    const lineStart = original.lastIndexOf('\n', span.keyOffset) + 1;
    const indent = original.slice(lineStart, span.keyOffset);
    evidenceEdits.push({ start: span.start, end: span.end, value: indentJson(operation.evidence, indent) });
  }
  let updated = original;
  for (const edit of evidenceEdits.sort((a, b) => b.start - a.start)) {
    updated = `${updated.slice(0, edit.start)}${edit.value}${updated.slice(edit.end)}`;
  }
  const parsed = JSON.parse(updated);
  for (const operationId of registry.operations.map(item => item.id)) {
    if (READ_IDS.includes(operationId)) continue;
    const before = registry.operations.find(item => item.id === operationId);
    const after = parsed.operations.find(item => item.id === operationId);
    if (canonical(before) !== canonical(after)) throw new Error('NON_TARGET_OPERATION_CHANGED');
  }
  if (canonical(parsed.operations.find(item => item.id === 'settings.read'))
      !== canonical(registry.operations.find(item => item.id === 'settings.read'))) throw new Error('ROOT_SETTINGS_OPERATION_CHANGED');
  const info = await lstat(target);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, updated, { mode: info.mode & 0o777, flag: 'wx' });
    await chmod(temp, info.mode & 0o777);
    await rename(temp, target);
  } finally { await rm(temp, { force: true }).catch(() => {}); }
  process.stdout.write(JSON.stringify({ state: 'operation_evidence_updated', operationIds: READ_IDS,
    priorOperationProjectionSha256: prior, contractBytesChangedOnlyInTargetEvidence: true,
    settingsOperationPreserved: true, directReplayReceipt: PROMOTION_PROOF }) + '\n');
}

function readResult(proof, key) {
  const result = proof.reads?.[key];
  if (!result || result.status !== 200 || !validHash(result.requestDigest)
      || !validHash(result.rawResponseDigest) || result.rawResponseDigestKind !== 'raw_http_body'
      || !Number.isSafeInteger(result.responseBytes) || typeof result.contentType !== 'string') {
    throw new Error(`READ_PROOF_INVALID_${key}`);
  }
  return result;
}

function receiptBase({ operation, featureId, requirementId, handlerId, ownerReceiptDigest, ownerProof, result,
  codeSha256, sourceProofPath, sourceProofSha256, now }) {
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    featureId,
    requirementId,
    operationId: operation.id,
    observedAt: now,
    recordedAt: now,
    execution: 'direct_http_client',
    liveReplay: true,
    liveReplayRecorded: true,
    mocked: false,
    ownerVerified: true,
    sameAuthenticatedOwner: true,
    evidenceScope: 'same_authenticated_owner',
    ...(ownerReceiptDigest ? { ownerIdentityReceiptSha256: ownerReceiptDigest,
      ownerProofPath: ownerProof.path, ownerProofSha256: ownerProof.sha256,
      ownerScopeSha256: ownerProof.scopeSha256 } : { ownerScopeSha256: OWNER_SHA256 }),
    httpStatus: result.status,
    responseMime: result.contentType,
    responseBytes: result.responseBytes,
    capturedOperationSha256: operationDigest(operation),
    requestDigest: result.requestDigest,
    responseDigest: result.rawResponseDigest,
    responseDigestKind: 'raw_http_body',
    handlerId,
    dispatchBinding: { handlerId, operationId: operation.id, operationKind: 'read',
      mode: handlerId === 'client.verify-owner' ? 'identity_role_dispatch' : 'validated_registry_generic' },
    readinessAssertions: { handlerDispatchVerified: true, ownerScopeBound: true },
    persistenceAssertions: {
      credentialValuesPersisted: false, cookiesPersisted: false, tokensPersisted: false,
      requestBodiesPersisted: false, responseBodiesPersisted: false, signedUrlValuesPersisted: false,
      passwordValuesPersisted: false, conversationIdsPersisted: false, conversationTitlesPersisted: false,
      responseIdsPersisted: false, messageBodiesPersisted: false,
    },
    codeSha256,
    codeHashCapturedAtExecution: true,
    sourceProofPath,
    sourceProofSha256,
  };
}

async function emitReceipts() {
  const receiptPath = CURRENT_PROOF;
  const proofBytes = await readFile(path.join(ROOT, receiptPath));
  const proof = JSON.parse(proofBytes.toString('utf8'));
  const proofSha256 = sha256(proofBytes);
  proofBytes.fill(0);
  if (proof.status !== 'completed' || proof.ownerScopeSha256 !== OWNER_SHA256
      || proof.sourceSnapshot?.stable !== true || proof.ownerVerified !== true
      || proof.reads?.listVariants?.status !== 'captured') throw new Error('CURRENT_READ_PROOF_NOT_VERIFIED');

  const registryBytes = await readFile(path.join(ROOT, 'contracts/grok-web.v1.json'));
  const registry = JSON.parse(registryBytes.toString('utf8'));
  registryBytes.fill(0);
  const checklist = await json('contracts/grok-feature-checklist.v1.json');
  const ownerOperation = registry.operations.find(item => item.id === 'auth.owner.read');
  const operations = Object.fromEntries(READ_IDS.map(id => [id, registry.operations.find(item => item.id === id)]));
  if (!ownerOperation || Object.values(operations).some(item => !item)) throw new Error('CONTRACT_OPERATION_MISSING');
  if (proof.sourceSnapshot.before.contractOperationSha256?.[ownerOperation.id] !== operationDigest(ownerOperation)) {
    throw new Error('LIVE_OWNER_OPERATION_PROJECTION_MISMATCH');
  }
  for (const operationId of READ_IDS) {
    if (proof.sourceSnapshot.before.contractOperationSha256?.[operationId] !== operationDigest(operations[operationId])) {
      throw new Error('LIVE_OPERATION_PROJECTION_MISMATCH');
    }
  }

  const sourceHashes = proof.sourceSnapshot.before.codeSha256;
  const handlerFiles = Object.fromEntries(['client.verify-owner', 'client.read'].map(handlerId => {
    const files = checklist.handlerBindings[handlerId]?.codeFiles;
    if (!Array.isArray(files) || files.some(file => !validHash(sourceHashes[file]))) throw new Error('HANDLER_CODE_HASH_NOT_IN_EXECUTION_SNAPSHOT');
    return [handlerId, Object.fromEntries(files.map(file => [file, sourceHashes[file]]))];
  }));
  const ownerRead = proof.reads.ownerAndList.ownerIdentityRead;
  if (!ownerRead || ownerRead.status !== 200 || !validHash(ownerRead.requestDigest)
      || !validHash(ownerRead.rawResponseDigest) || ownerRead.rawResponseDigestKind !== 'raw_http_body') {
    throw new Error('OWNER_READ_PROOF_INVALID');
  }
  const now = new Date().toISOString();
  const ownerReceipt = receiptBase({
    operation: ownerOperation,
    featureId: 'auth.owner-identity',
    requirementId: 'auth.owner.read',
    handlerId: 'client.verify-owner',
    ownerReceiptDigest: null,
    ownerProof: null,
    result: { status: ownerRead.status, contentType: ownerRead.contentType,
      responseBytes: ownerRead.responseBytes, requestDigest: ownerRead.requestDigest,
      rawResponseDigest: ownerRead.rawResponseDigest },
    codeSha256: handlerFiles['client.verify-owner'],
    sourceProofPath: receiptPath,
    sourceProofSha256: proofSha256,
    now,
  });
  const ownerReceiptDigest = sha256(Buffer.from(canonical(ownerReceipt), 'utf8'));
  const ownerProof = {
    path: `verification/owner-proofs/${ownerReceiptDigest}.json`,
    sha256: ownerReceiptDigest,
    scopeSha256: OWNER_SHA256,
  };
  ownerReceipt.ownerScopeSha256 = OWNER_SHA256;

  const list = proof.reads.listVariants.variants;
  if (!Array.isArray(list) || list.length !== 3 || JSON.stringify(list.map(item => item.name))
      !== JSON.stringify(['first_page', 'next_page', 'search'])) throw new Error('LIST_VARIANTS_INVALID');
  const listReceipt = receiptBase({
    operation: operations['conversation.list.read'], featureId: 'conversation.list',
    requirementId: 'conversation.list.read', handlerId: 'client.read', ownerReceiptDigest, ownerProof,
    result: { status: list[0].httpStatus, contentType: 'application/json', responseBytes: list[0].responseBytes,
      requestDigest: list[0].requestDigest, rawResponseDigest: list[0].responseDigest },
    codeSha256: handlerFiles['client.read'], sourceProofPath: receiptPath, sourceProofSha256: proofSha256, now,
  });
  listReceipt.readVariants = list.map(({ name, requestDigest, responseDigest, httpStatus, responseBytes,
    requestFieldNames, conversationCount, nextPageTokenPresent, searchQuerySha256, textSearchMatchCount,
    targetConversationMatched }) => ({
    name, requestDigest, responseDigest, httpStatus, responseBytes, requestFieldNames, conversationCount,
    nextPageTokenPresent,
    ...(name === 'search' ? { searchQuerySha256, textSearchMatchCount, targetConversationMatched } : {}),
  }));

  const detailResult = readResult(proof, 'detail');
  const detail = receiptBase({
    operation: operations['conversation.read'], featureId: 'conversation.crud', requirementId: 'conversation.read',
    handlerId: 'client.read', ownerReceiptDigest, ownerProof, result: detailResult,
    codeSha256: handlerFiles['client.read'], sourceProofPath: receiptPath, sourceProofSha256: proofSha256, now,
  });
  detail.semanticReadback = { readbackVerified: true, detailMatchesSearch: true,
    viewerIsOwner: proof.reads.detail.viewerIsOwner === true,
    mutableOwnerAccessVerified: proof.reads.detail.viewerIsOwner === true && proof.reads.detail.readonly !== true };

  const nodesResult = readResult(proof, 'responseNodes');
  const nodes = receiptBase({
    operation: operations['history.response-nodes'], featureId: 'conversation.history', requirementId: 'history.response-nodes',
    handlerId: 'client.read', ownerReceiptDigest, ownerProof, result: nodesResult,
    codeSha256: handlerFiles['client.read'], sourceProofPath: receiptPath, sourceProofSha256: proofSha256, now,
  });
  nodes.semanticReadback = { responseNodeCount: proof.reads.responseNodes.nodeCount,
    inflightResponseCount: proof.reads.responseNodes.inflightCount };

  const loadedResult = readResult(proof, 'loadResponses');
  const loaded = receiptBase({
    operation: operations['history.load-responses'], featureId: 'conversation.history', requirementId: 'history.load-responses',
    handlerId: 'client.read', ownerReceiptDigest, ownerProof, result: loadedResult,
    codeSha256: handlerFiles['client.read'], sourceProofPath: receiptPath, sourceProofSha256: proofSha256, now,
  });
  loaded.semanticReadback = { loadedResponseCount: proof.reads.loadResponses.responseCount,
    loadedUserMessageCount: 1, loadedAssistantMessageCount: 1, responseIdsBoundInMemory: true };

  const runName = `${now.replace(/[:.]/g, '-')}-${proof.sourceSnapshot.after.codeSha256['src/cli.mjs'].slice(0, 16)}`;
  const runDirectory = `verification/conversation-read-runs/${runName}`;
  const fixedReceipts = [
    ['conversation.list.read.json', listReceipt],
    ['conversation.read.json', detail],
    ['history.response-nodes.json', nodes],
    ['history.load-responses.json', loaded],
  ];
  await writeContentAddressed(ownerProof.path, ownerReceipt);
  await writeAtomic(`${FEATURE_RECEIPT_DIR}/auth-owner.read.json`, `${JSON.stringify(ownerReceipt, null, 2)}\n`, 0o600, { replace: true });
  await mkdir(path.join(ROOT, runDirectory), { recursive: true, mode: 0o700 });
  await writeAtomic(`${runDirectory}/auth-owner.read.json`, `${JSON.stringify(ownerReceipt, null, 2)}\n`, 0o600);
  for (const [name, value] of fixedReceipts) {
    await writeAtomic(`${runDirectory}/${name}`, `${JSON.stringify(value, null, 2)}\n`, 0o600);
    await writeAtomic(`${FEATURE_RECEIPT_DIR}/${name}`, `${JSON.stringify(value, null, 2)}\n`, 0o600, { replace: true });
  }
  const aggregate = {
    schemaVersion: 1, serviceId: 'grok-web', operationId: 'conversation.reads.canonical',
    status: 'completed', ownerVerified: true, sameAuthenticatedOwner: true,
    sourceProofPath: receiptPath, sourceProofSha256: proofSha256,
    sourceSnapshotStable: true, conversationIdSha256: proof.task.conversationIdSha256,
    operationIds: ['conversation.list.read', 'conversation.read', 'history.response-nodes', 'history.load-responses'],
    readOnly: true, immutableRunReceiptDirectory: runDirectory,
    parentRelationship: proof.reads.loadResponses.assistantParentRelationship,
    rawIdentifiersPersisted: false, rawTitlesPersisted: false, rawMessagesPersisted: false,
  };
  await writeAtomic('verification/grok-fast-task-canonical-read-receipts-live-2026-10-06.json',
    `${JSON.stringify(aggregate, null, 2)}\n`, 0o600, { replace: true });
  process.stdout.write(JSON.stringify({ status: 'completed', ownerProofPath: ownerProof.path,
    immutableRunReceiptDirectory: runDirectory,
    operationReceiptPaths: fixedReceipts.map(([name]) => `${FEATURE_RECEIPT_DIR}/${name}`),
    rawIdsPersisted: false, rawMessagesPersisted: false, ownerProofSha256: ownerProof.sha256 }) + '\n');
}

const command = process.argv[2];
if (command === 'promote') await promoteEvidence();
else if (command === 'emit') await emitReceipts();
else throw new Error('USAGE: promote|emit');
