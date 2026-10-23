import { readFile, readdir } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiWebClient } from '../src/client.mjs';
import { validateObservedContract } from '../src/contract.mjs';
import { validateSessionBundle } from '../src/session.mjs';
import { extractConversationSummaries } from '../src/conversation-lifecycle.mjs';
import { findUnresolvedMutation, markMutationReconciled, mutationIntentDigest } from '../src/journal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

async function readInput() {
  if (stdin.isTTY === true) throw new Error('STDIN_REQUIRED');
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks, length);
  try { return JSON.parse(raw.toString('utf8')); }
  finally { raw.fill(0); }
}

function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'MEDIA_ONESHOT_FAILED';
}

function safeBootstrapDetails(error) {
  if (error?.code !== 'HTTP_SESSION_CONTEXT_MISSING' || !error.details || typeof error.details !== 'object') return undefined;
  const field = typeof error.details.field === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(error.details.field)
    ? error.details.field : undefined;
  const reason = typeof error.details.reason === 'string' && /^[a-z][a-z0-9_]{0,64}$/.test(error.details.reason)
    ? error.details.reason : undefined;
  return { ...(field ? { field } : {}), ...(reason ? { reason } : {}) };
}

function safeCauseCode(error) {
  const code = error?.cause?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : undefined;
}

function safeErrorFrame(error) {
  if (typeof error?.stack !== 'string') return undefined;
  for (const line of error.stack.split('\n').slice(1, 12)) {
    const match = line.match(/(?:\/src\/|\.\/)([A-Za-z0-9._-]+\.mjs):(\d+):\d+/);
    if (match) return `${match[1]}:${match[2]}`;
  }
  return undefined;
}

function locateUrlContext(root, target) {
  const matches = [];
  const budget = { visited: 0 };
  const walk = (value, path = [], objectKeys = [], depth = 0) => {
    budget.visited += 1;
    if (budget.visited > 50_000 || depth > 24 || matches.length >= 3) return;
    if (typeof value === 'string') {
      if (value === target) matches.push({
        path: path.slice(0, 24),
        ancestorObjectKeys: objectKeys.slice(-3),
      });
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length && index < 2_000; index += 1) walk(value[index], [...path, index], objectKeys, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      const keys = Object.keys(value).slice(0, 100).filter((key) => /^[A-Za-z_][A-Za-z0-9_.-]{0,80}$/.test(key)
        && !/^(?:[0-9a-f-]{24,}|\d{5,})$/i.test(key)
        && !/(?:cookie|token|secret|csrf|authorization|session|prompt|instruction|email|account)/i.test(key));
      const safeKeys = keys.map((key) => key.length > 64 ? '{field}' : key);
      for (const key of keys) walk(value[key], [...path, key], [...objectKeys, safeKeys], depth + 1);
    }
  };
  walk(root);
  return matches;
}

function safeMediaRef(value, fieldPath = [], taskPayload = null) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
  const pathFamily = url.pathname.split('/').map((part) => (
    part.length > 40 || /^[0-9a-f-]{16,}$/i.test(part) ? '{id}' : part
  )).join('/');
  const filename = url.searchParams.get('filename') || url.pathname;
  const extension = /\.jpe?g(?:$|[?#])/i.test(filename) ? 'jpeg'
    : /\.png(?:$|[?#])/i.test(filename) ? 'png' : null;
  return {
    origin: url.origin,
    pathFamily,
    queryKeyNames: [...new Set(url.searchParams.keys())].sort(),
    fieldPath: Array.isArray(fieldPath) ? fieldPath : [],
    sourceFieldContext: locateUrlContext(taskPayload, value),
    mimeHint: extension,
  };
}

async function hasReconciledIntent({ capability, intentKeyHash, root }) {
  let names;
  try { names = await readdir(root); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let journal;
    try { journal = JSON.parse(await readFile(path.join(root, name), 'utf8')); }
    catch { continue; }
    if (journal?.capability === capability && journal?.version === 2
        && journal?.intentKeyHash === intentKeyHash && journal?.state === 'reconciled') return true;
  }
  return false;
}

function clearStrings(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = '';
      else clearStrings(value[index], seen);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') value[key] = '';
    else clearStrings(value[key], seen);
  }
}

async function main() {
  let input;
  let client;
  let capture;
  try {
    if (process.env.GEMINI_MEDIA_ORCHESTRATOR !== '1' || stdout.isTTY === true) throw new Error('ORCHESTRATOR_PIPE_REQUIRED');
    input = await readInput();
    const contractSource = await readFile(path.join(ROOT, 'discovery', 'observed-contract.json'), 'utf8');
    const baseContract = validateObservedContract(JSON.parse(contractSource));
    if (input.mode === 'session-bootstrap-check') {
      if (typeof input.expectedOwner !== 'string' || !input.session
          || Object.keys(input).some((key) => !['mode', 'expectedOwner', 'session'].includes(key))) {
        throw new Error('INPUT_INVALID');
      }
      const session = validateSessionBundle(input.session, baseContract);
      client = new GeminiWebClient({ contract: baseContract, session });
      let stage = 'refresh_session';
      let identity;
      let history;
      let historyCount;
      try {
        identity = await client.refreshSession(input.expectedOwner);
        stage = 'history_list';
        history = await client.listHistory();
        const historyRows = extractConversationSummaries(history.data);
        historyCount = historyRows.length;
      } catch (error) {
        const safeDetails = safeBootstrapDetails(error);
        stdout.write(JSON.stringify({
          mode: input.mode,
          status: 'failed',
          stage,
          error: safeErrorCode(error),
          errorClass: error?.constructor?.name ?? 'Error',
          ...(safeCauseCode(error) ? { causeCode: safeCauseCode(error) } : {}),
          ...(safeErrorFrame(error) ? { errorFrame: safeErrorFrame(error) } : {}),
          ...(safeDetails ? { safeDetails } : {}),
        }) + '\n');
        return 1;
      }
      stdout.write(JSON.stringify({
        mode: input.mode,
        ownerMatched: identity.ownerMatched === true,
        anonymousOwnerAbsent: identity.anonymousOwnerAbsent === true,
        credentialPropagated: history.credentialPropagated === true,
        batchContextRefreshed: true,
        historyHttpStatus: history.httpStatus,
        historyRpcId: history.rpcId,
        historySummaryCount: historyCount,
        historyResponseBytes: history.responseBytes,
        historyResponseSha256: history.responseSha256,
        rawSessionPersisted: false,
        rawHistoryIdsPersisted: false,
        responseBodyPersisted: false,
      }) + '\n');
      return 0;
    }
    if (input.mode === 'task-asset-readback-check') {
      if (typeof input.expectedOwner !== 'string' || typeof input.expectedIntent !== 'string'
          || typeof input.callerIntent !== 'string' || !input.session
          || (input.downloadTaskAssetOnce !== undefined && typeof input.downloadTaskAssetOnce !== 'boolean')
          || Object.keys(input).some((key) => ![
            'mode', 'expectedOwner', 'expectedIntent', 'callerIntent', 'session', 'journalRoot',
            'downloadTaskAssetOnce', 'artifactRoot', 'artifactName', 'previousArtifactPath',
          ].includes(key))) {
        throw new Error('INPUT_INVALID');
      }
      if (input.downloadTaskAssetOnce === true
          && (typeof input.artifactRoot !== 'string' || !path.isAbsolute(input.artifactRoot)
            || typeof input.artifactName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.artifactName)
            || (input.previousArtifactPath !== undefined && (typeof input.previousArtifactPath !== 'string' || !path.isAbsolute(input.previousArtifactPath))))) {
        throw new Error('INPUT_INVALID');
      }
      const session = validateSessionBundle(input.session, baseContract);
      client = new GeminiWebClient({ contract: baseContract, session });
      const identity = await client.refreshSession(input.expectedOwner);
      if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true) {
        throw Object.assign(new Error('OWNER_VERIFICATION_FAILED'), { code: 'OWNER_VERIFICATION_FAILED' });
      }
      const history = await client.listHistory();
      const rows = extractConversationSummaries(history.data);
      const taskMatches = [];
      let detailReadCount = 0;
      for (const row of rows.slice(0, 8)) {
        detailReadCount += 1;
        const detail = await client.readHistoryDetail({
          apiConversationId: row.conversationId,
          visibleRouteId: row.conversationId.slice(2),
          expectedIntent: input.expectedIntent,
          mediaCapability: 'image',
        });
        if (detail.httpStatus !== 200 || detail.summary.taskIntentMatched !== true
            || detail.summary.apiConversationIdMatched !== true || detail.binding.bound !== true
            || detail.summary.rpcMatchCount !== 1) continue;
        const seenUrls = new Set();
        const candidates = (detail.media?.assetCandidates ?? []).filter((candidate) => {
          if (typeof candidate?.url !== 'string' || seenUrls.has(candidate.url)) return false;
          seenUrls.add(candidate.url);
          return true;
        });
        const urls = candidates.map((candidate) => candidate.url);
        const references = candidates.map((candidate) => safeMediaRef(candidate.url, candidate.fieldPath, detail.payload)).filter(Boolean);
        taskMatches.push({ detail, urls, references });
        if (taskMatches.length > 1) break;
      }
      const exactTask = taskMatches.length === 1 ? taskMatches[0] : null;
      let assetDownload = null;
      if (exactTask && input.downloadTaskAssetOnce === true) {
        assetDownload = await client.downloadTaskMediaAssetOnce(exactTask.detail, {
          artifactRoot: input.artifactRoot,
          artifactName: input.artifactName,
          previousArtifactPath: input.previousArtifactPath ?? null,
        });
      }
      let journalReconciled = false;
      if (exactTask) {
        const intentKeyHash = mutationIntentDigest({
          capability: 'image', actor: input.expectedOwner, callerIntent: input.callerIntent,
        });
        const pending = await findUnresolvedMutation('image', intentKeyHash, { root: input.journalRoot });
        if (pending) {
          await markMutationReconciled(pending.jobPath, {
            found: true,
            resultCategory: exactTask.urls.length ? 'task_detail_media_reference_readback' : 'task_detail_prompt_id_readback',
          });
          journalReconciled = true;
        } else {
          journalReconciled = await hasReconciledIntent({
            capability: 'image', intentKeyHash, root: input.journalRoot,
          });
        }
      }
      stdout.write(JSON.stringify({
        mode: input.mode,
        ownerMatched: true,
        anonymousOwnerAbsent: true,
        credentialPropagated: history.credentialPropagated === true,
        historyHttpStatus: history.httpStatus,
        historyRpcId: history.rpcId,
        historyResponseBytes: history.responseBytes,
        historyResponseSha256: history.responseSha256,
        historySummaryCount: rows.length,
        detailReadLimit: 8,
        detailReadCount,
        exactTaskMatchCount: taskMatches.length,
        detailHttpStatus: exactTask?.detail.httpStatus ?? null,
        detailResponseSha256: exactTask?.detail.responseSha256 ?? null,
        detailResponseCount: exactTask?.detail.summary.rpcMatchCount ?? 0,
        exactPromptMatched: exactTask?.detail.summary.taskIntentMatched === true,
        apiConversationIdEchoed: exactTask?.detail.summary.apiConversationIdMatched === true,
        routeBound: exactTask?.detail.binding.bound === true,
        assetCandidateCount: exactTask?.references.length ?? 0,
        assetCandidates: exactTask?.references ?? [],
        assetDownload: assetDownload ? {
          status: 'verified',
          httpStatus: assetDownload.httpStatus,
          contentType: assetDownload.contentType,
          mime: assetDownload.mime,
          bytes: assetDownload.bytes,
          sha256: assetDownload.sha256,
          mimeMagicMatched: assetDownload.mimeMagicMatched,
          independentFileReadback: assetDownload.independentFileReadback,
          dimensions: assetDownload.dimensions ?? null,
          independentDimensionReadback: assetDownload.artifact.independentDimensionReadback ?? null,
          credentialForwarding: assetDownload.credentialForwarding,
          redirects: assetDownload.redirects,
          downloadAuthorization: assetDownload.downloadAuthorization,
          browserAssetGetPerformed: assetDownload.browserAssetGetPerformed,
          artifact: assetDownload.artifact,
          taskBinding: assetDownload.taskBinding,
          taskPromptMatched: assetDownload.taskPromptMatched,
          apiConversationIdEchoed: assetDownload.apiConversationIdEchoed,
          routeBound: assetDownload.routeBound,
          taskAssetCandidateCount: assetDownload.taskAssetCandidateCount,
          excludedTaskCandidateCount: assetDownload.excludedTaskCandidateCount,
        } : null,
        journalReconciled,
        rawExpectedIntentPersisted: false,
        rawConversationIdsPersisted: false,
        signedUrlsPersisted: false,
        responseBodiesPersisted: false,
      }) + '\n');
      return 0;
    }
    if (!['image', 'video'].includes(input.capability) || typeof input.expectedOwner !== 'string'
        || typeof input.expectedIntent !== 'string' || typeof input.callerIntent !== 'string'
        || !input.capture || typeof input.capture.bodyBase64 !== 'string') {
      throw new Error('INPUT_INVALID');
    }
    const session = validateSessionBundle(input.session, baseContract);
    client = new GeminiWebClient({ contract: baseContract, session });
    capture = {
      ...input.capture,
      body: Buffer.from(input.capture.bodyBase64, 'base64'),
    };
    delete capture.bodyBase64;
    const result = await client.generateMediaOnce({
      capability: input.capability,
      capture,
      expectedOwner: input.expectedOwner,
      callerIntent: input.callerIntent,
      expectedIntent: input.expectedIntent,
      journalRoot: input.journalRoot,
    });
    const privateAssetUrl = result.internal?.taskReadbackVerified === true
      && result.internal?.assetReferenceVerified === true
      && typeof result.internal.assetUrl === 'string'
      ? result.internal.assetUrl : undefined;
    stdout.write(JSON.stringify({
      ownerMatched: result.summary.ownerMatched === true,
      capability: input.capability,
      summary: result.summary,
      ...(privateAssetUrl ? { privateAssetUrl } : {}),
    }) + '\n');
    return 0;
  } catch (error) {
    const safeDetails = safeBootstrapDetails(error);
    stdout.write(JSON.stringify({
      error: safeErrorCode(error),
      errorClass: error?.constructor?.name ?? 'Error',
      ...(safeDetails ? { safeDetails } : {}),
    }) + '\n');
    return 1;
  } finally {
    client?.transport && (client.transport.session = null);
    if (Buffer.isBuffer(capture?.body)) capture.body.fill(0);
    clearStrings(input);
  }
}

process.exitCode = await main();
