#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
let createInMemoryGrokConversationRuntime;
let loadContractRegistry;
let canonicalJson;
let operationDigest;
let sha256Text;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_DIR = path.join(ROOT, 'verification/grok-feature-live-receipts');
const READ_OPERATION_IDS = Object.freeze([
  'auth.owner.read', 'conversation.list.read', 'conversation.read',
  'history.response-nodes', 'history.load-responses',
]);
const SOURCE_FILES = Object.freeze([
  'src/client.mjs', 'src/transport.mjs', 'src/session.mjs', 'src/runtime.mjs',
  'src/grok-conversations.mjs', 'src/cli.mjs', 'src/contracts.mjs',
  'src/feature-checklist.mjs', 'scripts/check-features.mjs', 'scripts/verify-conversations.mjs',
  'contracts/grok-web.v1.json', 'contracts/grok-feature-checklist.v1.json',
]);
const ID = /^[A-Za-z0-9_-]{16,512}$/;

function safeError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : null;
  return { state: 'direct_read_failed', code, errorClass: error?.constructor?.name ?? 'Error' };
}

function requestDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function resultFields(result) {
  if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 299
    || typeof result.contentType !== 'string' || !Number.isSafeInteger(result.responseBytes) || result.responseBytes < 1
    || !requestDigest(result.requestDigest) || !requestDigest(result.responseDigest)) {
    throw Object.assign(new Error('READ_RESULT_INVALID'), { code: 'READ_RESULT_INVALID' });
  }
  return {
    httpStatus: result.status,
    responseMime: result.contentType,
    responseBytes: result.responseBytes,
    requestDigest: result.requestDigest,
    responseDigest: result.responseDigest,
  };
}

function responseRows(result, key) {
  const rows = result?.data?.[key];
  if (!Array.isArray(rows)) throw Object.assign(new Error('READ_RESPONSE_SHAPE_INVALID'), { code: 'READ_RESPONSE_SHAPE_INVALID' });
  return rows;
}

function senderKind(value) {
  if (typeof value !== 'string') return 'unknown';
  const sender = value.trim().toLowerCase();
  if (['user', 'human', 'you'].includes(sender)) return 'user';
  if (['assistant', 'grok', 'bot'].includes(sender)) return 'assistant';
  return 'other';
}

export function selectExactSearchTarget(rows, conversationId) {
  const target = Array.isArray(rows) ? rows.find(row => row?.conversationId === conversationId) : null;
  if (!target || !ID.test(target.conversationId)) {
    throw Object.assign(new Error('CONVERSATION_SEARCH_TARGET_NOT_FOUND'), { code: 'CONVERSATION_SEARCH_TARGET_NOT_FOUND' });
  }
  return target;
}

export function assertLoadedResponseBindings(rows, responseIds) {
  const requested = new Set(responseIds);
  const returned = Array.isArray(rows) ? rows.map(row => row?.responseId) : [];
  if (!returned.length || returned.some(id => !requested.has(id)) || new Set(returned).size !== returned.length) {
    throw Object.assign(new Error('HISTORY_LOADED_IDS_NOT_BOUND'), { code: 'HISTORY_LOADED_IDS_NOT_BOUND' });
  }
}

async function hashFiles(relativePaths) {
  return Object.fromEntries(await Promise.all(relativePaths.map(async relativePath => {
    const bytes = await readFile(path.join(ROOT, relativePath));
    return [relativePath, createHash('sha256').update(bytes).digest('hex')];
  })));
}

async function sourceSnapshot() {
  const hashes = await hashFiles(SOURCE_FILES);
  const sortedHashes = Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)));
  return { hashes, digest: createHash('sha256').update(JSON.stringify(sortedHashes)).digest('hex') };
}

function operationFor(registry, operationId) {
  const operation = registry.operations.find(candidate => candidate.id === operationId);
  if (!operation) throw Object.assign(new Error('CONTRACT_OPERATION_MISSING'), { code: 'CONTRACT_OPERATION_MISSING' });
  return operation;
}

function receiptBase({ featureId, requirementId, operation, handlerId, ownerIdentityReceiptSha256,
  ownerProofReference, codeSha256, result, now }) {
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
    ...(ownerIdentityReceiptSha256 ? { ownerIdentityReceiptSha256 } : {}),
    ...(ownerProofReference ? {
      ownerProofPath: ownerProofReference.path,
      ownerProofSha256: ownerProofReference.sha256,
      ownerScopeSha256: ownerProofReference.scopeSha256,
    } : {}),
    ...result,
    capturedOperationSha256: operationDigest(operation),
    handlerId,
    dispatchBinding: {
      handlerId,
      operationId: operation.id,
      operationKind: operation.kind,
      mode: handlerId === 'client.verify-owner' ? 'identity_role_dispatch' : 'validated_registry_generic',
    },
    readinessAssertions: { handlerDispatchVerified: true, ownerScopeBound: true },
    persistenceAssertions: {
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
    },
    codeSha256,
  };
}

function listVariant(name, result, requestFieldNames, { searchQuerySha256, textSearchMatchCount, targetConversationMatched } = {}) {
  const fields = resultFields(result);
  const conversations = responseRows(result, 'conversations');
  const variant = {
    name,
    requestDigest: fields.requestDigest,
    responseDigest: fields.responseDigest,
    httpStatus: fields.httpStatus,
    responseBytes: fields.responseBytes,
    requestFieldNames,
    conversationCount: conversations.length,
    nextPageTokenPresent: typeof result.data.nextPageToken === 'string' && result.data.nextPageToken.length > 0,
  };
  if (name === 'search') {
    variant.searchQuerySha256 = searchQuerySha256;
    variant.textSearchMatchCount = textSearchMatchCount;
    variant.targetConversationMatched = targetConversationMatched;
  }
  return variant;
}

async function run(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)
    || Object.keys(packet).some(key => !['sessionBundle', 'expectedIdentity'].includes(key))
    || !packet.sessionBundle || typeof packet.sessionBundle !== 'object'
    || typeof packet.expectedIdentity !== 'string' || !packet.expectedIdentity.trim()) {
    throw Object.assign(new Error('READ_PACKET_INVALID'), { code: 'READ_PACKET_INVALID' });
  }

  const beforeSnapshot = await sourceSnapshot();
  // Load the client only after recording the source that this process executes.
  // A later edit is caught by the second snapshot instead of being stamped onto
  // a module loaded before the first snapshot.
  const [runtimeModule, clientModule, auditModule] = await Promise.all([
    import('../src/runtime.mjs'), import('../src/client.mjs'), import('../src/feature-checklist.mjs'),
  ]);
  ({ createInMemoryGrokConversationRuntime } = runtimeModule);
  ({ loadContractRegistry } = clientModule);
  ({ canonicalJson, operationDigest, sha256Text } = auditModule);
  const registry = await loadContractRegistry(path.join(ROOT, 'contracts/grok-web.v1.json'));
  const runtime = await createInMemoryGrokConversationRuntime({
    registry,
    pythonExecutable: process.env.GROK_CHROME_PYTHON,
  });
  const pendingReceipts = [];
  const report = { state: 'running', ownerVerified: false, operations: [] };
  let phase = 'session_import';
  try {
    await runtime.client.importSession(packet.sessionBundle);
    phase = 'owner_read';
    const ownerResult = await runtime.client.verifyOwner(packet.expectedIdentity);
    report.ownerVerified = true;
    const checklist = JSON.parse(await readFile(path.join(ROOT, 'contracts/grok-feature-checklist.v1.json'), 'utf8'));
    const ownerBinding = checklist.handlerBindings['client.verify-owner'];
    const readBinding = checklist.handlerBindings['client.read'];
    const ownerCodeSha256 = await hashFiles(ownerBinding.codeFiles);
    const readCodeSha256 = await hashFiles([...new Set([
      ...readBinding.codeFiles, 'src/session.mjs', 'src/runtime.mjs', 'src/grok-conversations.mjs',
    ])]);
    const ownerReceipt = receiptBase({
      featureId: 'auth.owner-identity', requirementId: 'auth.owner.read',
      operation: operationFor(registry, 'auth.owner.read'), handlerId: 'client.verify-owner',
      codeSha256: ownerCodeSha256,
      result: resultFields({
        status: ownerResult.httpStatus, contentType: ownerResult.contentType,
        responseBytes: ownerResult.responseBytes, requestDigest: ownerResult.requestDigest,
        responseDigest: ownerResult.responseDigest,
      }),
      now: new Date().toISOString(),
    });
    const verifiedSession = await runtime.sessionPersistence.read();
    const ownerScopeSha256 = verifiedSession?.session?.ownerBinding?.identityDigest;
    if (typeof ownerScopeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ownerScopeSha256)) {
      throw Object.assign(new Error('OWNER_SCOPE_DIGEST_UNAVAILABLE'), { code: 'OWNER_SCOPE_DIGEST_UNAVAILABLE' });
    }
    ownerReceipt.ownerScopeSha256 = ownerScopeSha256;
    const ownerReceiptDigest = sha256Text(canonicalJson(ownerReceipt));
    const ownerProofReference = {
      path: `verification/owner-proofs/${ownerReceiptDigest}.json`,
      sha256: ownerReceiptDigest,
      scopeSha256: ownerScopeSha256,
    };
    pendingReceipts.push(['auth-owner.read.json', ownerReceipt]);
    report.operations.push({ operationId: 'auth.owner.read', httpStatus: ownerResult.httpStatus, responseBytes: ownerResult.responseBytes });

    phase = 'conversation_first_page';
    const firstPage = await runtime.conversations.list({ pageSize: 1 });
    const firstRows = responseRows(firstPage, 'conversations');
    if (!firstRows.length || typeof firstPage.data.nextPageToken !== 'string' || !firstPage.data.nextPageToken) {
      throw Object.assign(new Error('CONVERSATION_NEXT_PAGE_NOT_OBSERVED'), { code: 'CONVERSATION_NEXT_PAGE_NOT_OBSERVED' });
    }
    const firstVariant = listVariant('first_page', firstPage, ['pageSize']);
    phase = 'conversation_next_page';
    const nextPage = await runtime.conversations.list({ pageSize: 1, pageToken: firstPage.data.nextPageToken });
    const nextRows = responseRows(nextPage, 'conversations');
    const nextVariant = listVariant('next_page', nextPage, ['pageSize', 'pageToken']);
    const firstRow = firstRows[0];
    const searchQuery = typeof firstRow.title === 'string' && firstRow.title.trim()
      ? firstRow.title.trim() : 'PROTOCOL42';
    if (searchQuery.length > 512 || /[\r\n\0]/.test(searchQuery)) {
      throw Object.assign(new Error('CONVERSATION_SEARCH_INPUT_INVALID'), { code: 'CONVERSATION_SEARCH_INPUT_INVALID' });
    }
    phase = 'conversation_search';
    const searchResult = await runtime.conversations.search(searchQuery, { pageSize: 10 });
    const searchRows = responseRows(searchResult, 'conversations');
    const textSearchMatches = Array.isArray(searchResult.data.textSearchMatches) ? searchResult.data.textSearchMatches : [];
    const firstConversationId = firstRow.conversationId;
    const searchTarget = selectExactSearchTarget(searchRows, firstConversationId);
    const searchVariant = listVariant('search', searchResult, ['pageSize', 'searchQuery'], {
      searchQuerySha256: sha256Text(searchQuery),
      textSearchMatchCount: textSearchMatches.length,
      targetConversationMatched: true,
    });
    const listOperation = operationFor(registry, 'conversation.list.read');
    const firstPageResult = resultFields(firstPage);
    pendingReceipts.push(['conversation.list.read.json', {
      ...receiptBase({
        featureId: 'conversation.list', requirementId: 'conversation.list.read', operation: listOperation,
        handlerId: 'client.read', ownerIdentityReceiptSha256: ownerReceiptDigest, ownerProofReference,
        codeSha256: readCodeSha256, result: firstPageResult, now: new Date().toISOString(),
      }),
      readVariants: [firstVariant, nextVariant, searchVariant],
    }]);
    report.operations.push(
      { operationId: 'conversation.list.read', variant: 'first_page', httpStatus: firstPage.status, responseBytes: firstPage.responseBytes, conversationCount: firstRows.length },
      { operationId: 'conversation.list.read', variant: 'next_page', httpStatus: nextPage.status, responseBytes: nextPage.responseBytes, conversationCount: nextRows.length },
      { operationId: 'conversation.list.read', variant: 'search', httpStatus: searchResult.status, responseBytes: searchResult.responseBytes, conversationCount: searchRows.length, textSearchMatchCount: textSearchMatches.length },
    );

    const targetId = searchTarget.conversationId;
    phase = 'conversation_detail';
    const detail = await runtime.conversations.read(targetId);
    const conversation = detail.data?.conversation;
    const detailMatches = conversation?.conversationId === targetId;
    const viewerIsOwner = conversation?.viewerIsOwner === true;
    const mutableOwnerAccessVerified = viewerIsOwner && conversation?.isReadonly !== true
      && (conversation?.accessLevel === undefined || conversation.accessLevel === 'OWNER');
    if (detail.status !== 200 || !detailMatches || !viewerIsOwner || !mutableOwnerAccessVerified) {
      throw Object.assign(new Error('CONVERSATION_DETAIL_OWNER_READBACK_UNVERIFIED'), { code: 'CONVERSATION_DETAIL_OWNER_READBACK_UNVERIFIED' });
    }
    const detailReceipt = receiptBase({
      featureId: 'conversation.crud', requirementId: 'conversation.read',
      operation: operationFor(registry, 'conversation.read'), handlerId: 'client.read',
      ownerIdentityReceiptSha256: ownerReceiptDigest, ownerProofReference, codeSha256: readCodeSha256,
      result: resultFields(detail), now: new Date().toISOString(),
    });
    detailReceipt.semanticReadback = {
      readbackVerified: true,
      detailMatchesSearch: true,
      viewerIsOwner: true,
      mutableOwnerAccessVerified: true,
    };
    pendingReceipts.push(['conversation.read.json', detailReceipt]);
    report.operations.push({ operationId: 'conversation.read', httpStatus: detail.status, responseBytes: detail.responseBytes, viewerIsOwner: true });

    phase = 'history_response_nodes';
    const nodes = await runtime.conversations.responseNodes(targetId);
    const nodeRows = responseRows(nodes, 'responseNodes');
    const inflightRows = responseRows(nodes, 'inflightResponses');
    const responseIds = [...new Set(nodeRows.map(row => row?.responseId).filter(value => typeof value === 'string' && ID.test(value)))].slice(-500);
    if (!responseIds.length) throw Object.assign(new Error('HISTORY_RESPONSE_IDS_NOT_OBSERVED'), { code: 'HISTORY_RESPONSE_IDS_NOT_OBSERVED' });
    const nodesReceipt = receiptBase({
      featureId: 'conversation.history', requirementId: 'history.response-nodes',
      operation: operationFor(registry, 'history.response-nodes'), handlerId: 'client.read',
      ownerIdentityReceiptSha256: ownerReceiptDigest, ownerProofReference, codeSha256: readCodeSha256,
      result: resultFields(nodes), now: new Date().toISOString(),
    });
    nodesReceipt.semanticReadback = { responseNodeCount: nodeRows.length, inflightResponseCount: inflightRows.length };
    pendingReceipts.push(['history.response-nodes.json', nodesReceipt]);
    report.operations.push({ operationId: 'history.response-nodes', httpStatus: nodes.status, responseBytes: nodes.responseBytes,
      responseNodeCount: nodeRows.length, inflightResponseCount: inflightRows.length });

    phase = 'history_load_responses';
    const loaded = await runtime.conversations.loadResponses(targetId, responseIds);
    const loadedRows = responseRows(loaded, 'responses');
    assertLoadedResponseBindings(loadedRows, responseIds);
    const loadedReceipt = receiptBase({
      featureId: 'conversation.history', requirementId: 'history.load-responses',
      operation: operationFor(registry, 'history.load-responses'), handlerId: 'client.read',
      ownerIdentityReceiptSha256: ownerReceiptDigest, ownerProofReference, codeSha256: readCodeSha256,
      result: resultFields(loaded), now: new Date().toISOString(),
    });
    loadedReceipt.semanticReadback = {
      loadedResponseCount: loadedRows.length,
      loadedUserMessageCount: loadedRows.filter(row => senderKind(row?.sender) === 'user').length,
      loadedAssistantMessageCount: loadedRows.filter(row => senderKind(row?.sender) === 'assistant').length,
      responseIdsBoundInMemory: true,
    };
    pendingReceipts.push(['history.load-responses.json', loadedReceipt]);
    report.operations.push({ operationId: 'history.load-responses', httpStatus: loaded.status, responseBytes: loaded.responseBytes,
      loadedResponseCount: loadedRows.length, responseIdsBoundInMemory: true });

    phase = 'source_snapshot_after';
    const afterSnapshot = await sourceSnapshot();
    if (canonicalJson(beforeSnapshot.hashes) !== canonicalJson(afterSnapshot.hashes)) {
      return { state: 'source_snapshot_changed', sourceSnapshotBeforeSha256: beforeSnapshot.digest,
        sourceSnapshotAfterSha256: afterSnapshot.digest, ownerVerified: true, operations: report.operations };
    }
    report.sourceSnapshotStable = true;
    report.sourceSnapshotSha256 = afterSnapshot.digest;
    report.state = 'verified';
    report.readOnly = true;

    await mkdir(RECEIPT_DIR, { recursive: true, mode: 0o700 });
    const ownerProofFile = path.join(ROOT, ownerProofReference.path);
    await mkdir(path.dirname(ownerProofFile), { recursive: true, mode: 0o700 });
    try {
      await writeFile(ownerProofFile, `${JSON.stringify(ownerReceipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const prior = JSON.parse(await readFile(ownerProofFile, 'utf8'));
      if (sha256Text(canonicalJson(prior)) !== ownerReceiptDigest) {
        throw Object.assign(new Error('OWNER_PROOF_ARCHIVE_CONFLICT'), { code: 'OWNER_PROOF_ARCHIVE_CONFLICT' });
      }
    }
    const runName = new Date().toISOString().replace(/[:.]/g, '-') + '-' + afterSnapshot.digest.slice(0, 16);
    const runDirectory = path.join(ROOT, 'verification/conversation-read-runs', runName);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    for (const [fileName, receipt] of pendingReceipts) {
      await writeFile(path.join(runDirectory, fileName), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await writeFile(path.join(RECEIPT_DIR, fileName), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    }
    const manifest = JSON.parse(await readFile(path.join(ROOT, 'contracts/grok-feature-checklist.v1.json'), 'utf8'));
    const aggregate = {
      schemaVersion: 1,
      serviceId: 'grok-web',
      verificationKind: 'read_only_conversation_api_replay',
      observedAt: new Date().toISOString(),
      ownerVerified: true,
      sourceSnapshotStable: true,
      sourceSnapshotSha256: afterSnapshot.digest,
      manifestRequirements: manifest.features.reduce((total, feature) => total + feature.requirements.length, 0),
      operationIds: READ_OPERATION_IDS,
      readOnly: true,
      immutableRunReceiptDirectory: path.relative(ROOT, runDirectory),
      rawIdsPersisted: false,
      rawTitlesPersisted: false,
      rawMessagesPersisted: false,
      queryTextPersisted: false,
      operations: report.operations,
    };
    await writeFile(path.join(ROOT, 'verification/grok-conversations-direct-reads-2026-10-06.json'),
      `${JSON.stringify(aggregate, null, 2)}\n`, { mode: 0o600 });
    report.writtenReceiptCount = pendingReceipts.length;
    return report;
  } catch (error) {
    if (error && typeof error === 'object') error.phase = phase;
    throw error;
  } finally {
    await runtime.client.clearSession().catch(() => {});
    if (packet && typeof packet === 'object') {
      packet.sessionBundle = null;
      packet.expectedIdentity = null;
    }
  }
}

async function readPacket() {
  const chunks = [];
  let size = 0;
  let bytes;
  try {
    for await (const chunk of process.stdin) {
      const part = Buffer.from(chunk);
      chunks.push(part);
      size += part.length;
      if (size > 1024 * 1024) throw Object.assign(new Error('READ_PACKET_TOO_LARGE'), { code: 'READ_PACKET_TOO_LARGE' });
    }
    bytes = Buffer.concat(chunks, size);
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    bytes?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function main() {
  let packet;
  let result;
  try {
    packet = await readPacket();
    result = await run(packet);
  } catch (error) {
    result = { ...safeError(error), phase: typeof error?.phase === 'string' ? error.phase : null };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
