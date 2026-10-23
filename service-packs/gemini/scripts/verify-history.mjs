import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const HISTORY_OWNER_IDENTITY_CASE = 'history_owner';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

function exactString(value, expected, budget = { remaining: 50_000 }, depth = 0) {
  if (--budget.remaining < 0 || depth > 24) return false;
  if (typeof value === 'string') return value === expected;
  if (Array.isArray(value)) return value.some((item) => exactString(item, expected, budget, depth + 1));
  if (value && typeof value === 'object') return Object.values(value)
    .some((item) => exactString(item, expected, budget, depth + 1));
  return false;
}

function requireResponse(result) {
  if (result?.httpStatus !== 200 || result.credentialPropagated !== true
      || !Number.isSafeInteger(result.responseBytes) || result.responseBytes < 1
      || !/^[a-f0-9]{64}$/.test(result.responseSha256 ?? '')) fail('HISTORY_LIVE_RESPONSE_INVALID');
}

function pair({ featureId, operationId, caseId, operation, result, contractSha256, codeSha256, observedAt, identity = false }) {
  const request = operation.request;
  return {
    schema: 'gemini-feature-pair-evidence-v1', service: 'gemini-web', featureId, operationId, caseId,
    contractSha256, clientCodeSha256: codeSha256, observedAt, executionHost: 'linux_worker',
    transport: 'direct_http', evidenceClass: 'direct_http_live', mocked: false, publicOnly: false,
    requestResponsePaired: true, authenticatedOwnerVerified: true, expectedOutcomeVerified: true,
    ...(identity ? { identityMatchVerified: true } : {}), credentialPropagated: true,
    request: {
      method: request.method, origin: request.origin, path: request.path,
      queryKeys: [...request.queryKeys],
      headerNames: result.request?.headerNames ?? [],
      bodyFieldNames: request.bodyFieldNames ?? [], valuesPersisted: false,
      ...(request.contentType ? { contentType: request.contentType } : {}),
    },
    response: {
      status: result.httpStatus, contentType: operation.response.contentType,
      bytes: result.responseBytes, bodySha256: result.responseSha256, framing: operation.response.framing,
    },
    secretsPersisted: false,
  };
}

function receipt(featureId, operationEvidence, identityRef, implementationFiles, contractSha256, checkedAt, sourceScope) {
  return {
    schema: 'gemini-feature-live-receipt-v1', service: 'gemini-web', featureId, outcome: 'verified',
    checkedAt, evidenceClass: 'direct_http_live', transport: 'direct_http', executionHost: 'linux_worker',
    mocked: false, publicOnly: false, authenticatedOwnerVerified: true, secretsPersisted: false,
    contractSha256, implementationFiles,
    implementationSetSha256: sourceScope?.implementationScopeSha256 ?? sha(JSON.stringify(implementationFiles)),
    ...(sourceScope ? { sourceScope } : {}),
    ownerIdentityEvidence: identityRef, operationEvidence,
  };
}

async function preflightHistoryBackups(root, destinations) {
  const backups = [];
  for (const destination of destinations) {
    let bytes;
    try { bytes = await readFile(path.join(root, destination)); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const backup = `verification/one-shot/gemini-history-before-refresh-${path.basename(destination, '.json')}-${sha(bytes).slice(0, 12)}.json`;
    try {
      await readFile(path.join(root, backup));
      fail('HISTORY_EVIDENCE_BACKUP_EXISTS');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    backups.push({ destination, backup, bytes });
  }
  return backups;
}

/** Direct HTTP only. The caller supplies the session and an existing task marker through stdin. */
export async function verifyHistory(packet, {
  root = ROOT,
  createClient,
} = {}) {
  if (!packet || typeof packet.expectedOwner !== 'string' || !packet.session
      || typeof packet.query !== 'string' || !packet.query.trim() || packet.query.length > 256
      || /[\r\n\0]/.test(packet.query)
      || typeof packet.expectedIntent !== 'string' || !packet.expectedIntent.trim()
      || packet.expectedIntent.length > 16_384
      || (packet.expectedConversationSha256 !== undefined
        && !/^[a-f0-9]{64}$/.test(packet.expectedConversationSha256))) fail('HISTORY_VERIFICATION_INPUT_INVALID');
  if (packet.preserveExistingIdentityEvidence !== undefined && packet.preserveExistingIdentityEvidence !== true) {
    fail('HISTORY_VERIFICATION_INPUT_INVALID');
  }
  const preserveExistingIdentity = packet.preserveExistingIdentityEvidence === true;
  const contractBytes = await readFile(path.join(root, 'discovery/observed-contract.json'));
  const contractInput = JSON.parse(contractBytes);
  const checklist = JSON.parse(await readFile(path.join(root, 'discovery/feature-checklist.json'), 'utf8'));
  const historyFeature = checklist.features.find((feature) => feature.id === 'history');
  if (!historyFeature || !Array.isArray(historyFeature.contractOperations)) fail('HISTORY_CHECKLIST_INVALID');
  const { snapshotFeatureSourceScope, validateFeatureSourceScope } = await import('../src/source-scope.mjs');
  const before = await snapshotFeatureSourceScope({
    root, contract: contractInput, featureId: 'history', operationNames: historyFeature.contractOperations,
  });
  const identityScopeBefore = await snapshotFeatureSourceScope({
    root, contract: contractInput, featureId: 'identity', operationNames: [checklist.policy.ownerIdentityOperationId],
  });
  // Hash the contract and operation handlers before importing the API runtime.
  const [{ GeminiWebClient }, { validateObservedContract }, { extractConversationSummaries }] = await Promise.all([
    import('../src/client.mjs'), import('../src/contract.mjs'), import('../src/conversation-lifecycle.mjs'),
  ]);
  const contract = validateObservedContract(contractInput);
  const contractSha256 = sha(contractBytes);
  const codeSha256 = before.implementationScopeSha256;
  const historyDestinations = [
    'verification/feature-evidence/history--history_list--list.json',
    'verification/feature-evidence/history--history_search--search.json',
    'verification/feature-evidence/history--history_read--conversation.json',
    'verification/features/history.json',
    `verification/feature-evidence/identity--identity--${HISTORY_OWNER_IDENTITY_CASE}.json`,
    ...(!preserveExistingIdentity ? [
      'verification/feature-evidence/identity--identity--owner.json',
      'verification/features/identity.json',
    ] : []),
  ];
  const historyBackups = await preflightHistoryBackups(root, historyDestinations);
  const client = createClient ? createClient({ contract, session: packet.session })
    : new GeminiWebClient({ contract, session: packet.session });
  try {
    const identity = await client.verifyOwner(packet.expectedOwner);
    requireResponse(identity);
    if (!identity.ownerMatched || !identity.anonymousOwnerAbsent) fail('OWNER_VERIFICATION_FAILED');
    await client.refreshSession(packet.expectedOwner);
    const listed = await client.listHistory();
    requireResponse(listed);
    const listedRows = extractConversationSummaries(listed.data);
    if (!listedRows.length) fail('HISTORY_LIST_NO_ROWS');
    const searched = await client.searchHistory({ expectedOwner: packet.expectedOwner, query: packet.query });
    requireResponse(searched);
    // Retain IDs in memory. Search must actually return a conversation from the owner list.
    const candidates = listedRows.filter((row) => exactString(searched.data, row.conversationId)
      && (packet.expectedConversationSha256 === undefined || sha(row.conversationId) === packet.expectedConversationSha256));
    if (!candidates.length) fail('HISTORY_SEARCH_NO_LIST_MATCH');
    const matched = [];
    for (const row of candidates.slice(0, 12)) {
      const result = await client.readHistoryDetail({
        apiConversationId: row.conversationId, visibleRouteId: row.conversationId.slice(2),
        expectedIntent: packet.expectedIntent,
      });
      requireResponse(result);
      if (result.summary?.rpcMatchCount === 1 && result.summary.taskIntentMatched === true
          && result.summary.apiConversationIdMatched === true && result.binding?.bound === true) matched.push(result);
    }
    if (matched.length !== 1) fail('HISTORY_TASK_MATCH_NOT_UNIQUE');
    const contractBytesAfter = await readFile(path.join(root, 'discovery/observed-contract.json'));
    const contractAfter = JSON.parse(contractBytesAfter);
    let after;
    let identityScopeAfter;
    try {
      after = await snapshotFeatureSourceScope({
        root, contract: contractAfter, featureId: 'history', operationNames: historyFeature.contractOperations,
      });
      identityScopeAfter = await snapshotFeatureSourceScope({
        root, contract: contractAfter, featureId: 'identity', operationNames: [checklist.policy.ownerIdentityOperationId],
      });
    } catch {
      throw Object.assign(new Error('Source changed'), { code: 'SOURCE_CHANGED_DURING_VERIFICATION',
        safeReadSummary: {
          listHttpStatus: listed.httpStatus, searchHttpStatus: searched.httpStatus,
          detailHttpStatus: matched[0].httpStatus, uniqueTaskMatchCount: matched.length,
          changedSourcePaths: [], canonicalReceiptsWritten: false,
        },
      });
    }
    if (!validateFeatureSourceScope(before, after)
        || !validateFeatureSourceScope(identityScopeBefore, identityScopeAfter)) {
      const afterByPath = new Map(after.implementationUnits.map((item) => [item.path, item.sha256]));
      const changedSourcePaths = before.implementationUnits
        .filter((item) => item.sha256 !== afterByPath.get(item.path)).map((item) => item.path);
      throw Object.assign(new Error('Source changed'), { code: 'SOURCE_CHANGED_DURING_VERIFICATION',
        safeReadSummary: {
          listHttpStatus: listed.httpStatus, searchHttpStatus: searched.httpStatus,
          detailHttpStatus: matched[0].httpStatus, uniqueTaskMatchCount: matched.length,
          changedSourcePaths, canonicalReceiptsWritten: false,
        },
      });
    }
    const checkedAt = new Date().toISOString();
    const documents = new Map();
    const identityPath = 'verification/feature-evidence/identity--identity--owner.json';
    const historyIdentityPath = `verification/feature-evidence/identity--identity--${HISTORY_OWNER_IDENTITY_CASE}.json`;
    const identityImplementationFiles = identityScopeBefore.implementationUnits;
    const identityImplementationHash = identityScopeBefore.implementationScopeSha256;
    const historyIdentityPairBytes = jsonBytes(pair({
      featureId: 'identity', operationId: 'identity',
      caseId: HISTORY_OWNER_IDENTITY_CASE,
      operation: contract.operations.identity, result: identity, contractSha256,
      codeSha256: identityImplementationHash, observedAt: checkedAt, identity: true,
    }));
    documents.set(historyIdentityPath, historyIdentityPairBytes);
    let identityPairBytes = historyIdentityPairBytes;
    if (!preserveExistingIdentity) {
      identityPairBytes = jsonBytes(pair({
        featureId: 'identity', operationId: 'identity', caseId: 'owner',
        operation: contract.operations.identity, result: identity, contractSha256,
        codeSha256: identityImplementationHash, observedAt: checkedAt, identity: true,
      }));
      documents.set(identityPath, identityPairBytes);
    }
    const identityRef = {
      path: historyIdentityPath, sha256: sha(historyIdentityPairBytes),
      implementationFiles: identityImplementationFiles,
      implementationSetSha256: identityImplementationHash,
      contractSha256,
      sourceScope: identityScopeBefore,
    };
    const evidence = [];
    for (const [operationId, caseId, result] of [
      ['history_list', 'list', listed], ['history_search', 'search', searched], ['history_read', 'conversation', matched[0]],
    ]) {
      const relativePath = `verification/feature-evidence/history--${operationId}--${caseId}.json`;
      const bytes = jsonBytes(pair({ featureId: 'history', operationId, caseId,
        operation: contract.operations[operationId], result, contractSha256, codeSha256, observedAt: checkedAt }));
      documents.set(relativePath, bytes);
      evidence.push({ operationId, caseId, path: relativePath, sha256: sha(bytes) });
    }
    if (!preserveExistingIdentity) {
      const currentIdentityRef = { ...identityRef, path: identityPath, sha256: sha(identityPairBytes) };
      documents.set('verification/features/identity.json', jsonBytes(receipt('identity', [
        { operationId: 'identity', caseId: 'owner', path: identityPath, sha256: currentIdentityRef.sha256 },
      ], currentIdentityRef, identityImplementationFiles, contractSha256, checkedAt, identityScopeBefore)));
    }
    documents.set('verification/features/history.json', jsonBytes(receipt(
      'history', evidence, identityRef, before.implementationUnits, contractSha256, checkedAt, before,
    )));
    // Prepare all nonsecret files before replacing any canonical document.
    const pending = [];
    try {
      for (const { backup, bytes } of historyBackups) {
        const destination = path.join(root, backup);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
      }
      for (const [relativePath, bytes] of documents) {
        const destination = path.join(root, relativePath);
        await mkdir(path.dirname(destination), { recursive: true });
        const temporary = destination + '.pending-' + process.pid;
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
        pending.push([temporary, destination]);
      }
      for (const [temporary, destination] of pending) await rename(temporary, destination);
    } finally {
      await Promise.all(pending.map(([temporary]) => rm(temporary, { force: true })));
    }
    return {
      service: 'gemini-web', verified: true, ownerMatched: true, anonymousOwnerAbsent: true,
      listHttpStatus: listed.httpStatus, searchHttpStatus: searched.httpStatus, detailHttpStatus: matched[0].httpStatus,
      listedConversationCount: listedRows.length, uniqueTaskMatchCount: matched.length,
      codeStableDuringExecution: true,
      canonicalReceiptsWritten: preserveExistingIdentity ? ['history'] : ['identity', 'history'],
      identityEvidenceFresh: true,
      existingIdentityEvidencePreserved: preserveExistingIdentity,
      currentIdentityEvidencePath: identityRef.path,
      priorHistoryEvidenceBackupCount: historyBackups.length,
      credentialsPersisted: false, requestValuesPersisted: false, responseValuesPersisted: false,
    };
  } finally {
    if (client.transport) client.transport.session = null;
    packet = null;
  }
}

async function main() {
  const chunks = [];
  let size = 0;
  let raw;
  try {
    if (process.argv.length !== 2) fail('HISTORY_VERIFICATION_ARGUMENT_INVALID');
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) fail('HISTORY_VERIFICATION_INPUT_TOO_LARGE');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks);
    const packet = JSON.parse(raw.toString('utf8'));
    raw.fill(0);
    process.stdout.write(JSON.stringify(await verifyHistory(packet)) + '\n');
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
      ? error.code : 'HISTORY_VERIFICATION_FAILED';
    process.stdout.write(JSON.stringify({ service: 'gemini-web', verified: false, error: code,
      ...(code === 'SOURCE_CHANGED_DURING_VERIFICATION' ? { completedReadSummary: error.safeReadSummary } : {}),
    }) + '\n');
    process.exitCode = 1;
  } finally {
    raw?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
