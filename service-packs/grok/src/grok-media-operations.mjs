import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';
import {
  GROK_MEDIA_PRIVATE_ASSET_DATA,
  GROK_MEDIA_PRIVATE_RESPONSE_IDS,
  GROK_MEDIA_PRIVATE_REFERENCE_ASSET_IDS,
  validateCapturedGrokImagineImageFrames,
  GROK_IMAGINE_WEBSOCKET_URL,
} from './grok-media-api.mjs';
import {
  openGrokImagineWebSocket,
  readGrokImagineMessages,
  sendGrokImagineFrames,
  summarizeGrokImagineMessages,
} from './grok-media-websocket.mjs';
import { validateGrokAssetRequestContext } from './grok-media-asset-reader.mjs';
import { boundCredentials, GROK_WEB_ORIGIN } from './session.mjs';
import { createRequestDigest } from './transport.mjs';
import { grokVideoNoWireProofDigest, isGrokVideoNoWireProof, isGrokVideoNoWireRecovery } from './grok-media-no-wire-proof.mjs';

const DEFAULT_READBACK_TIMEOUT_MS = 120_000;
const DEFAULT_READBACK_INTERVAL_MS = 2_000;
const MAX_MEDIA_READ_RETRY_AFTER_MS = 120_000;
const VIDEO_CREATE_PATH = '/rest/app-chat/conversations/new';
const VIDEO_BODY_FIELDS = [
  'enableImageStreaming', 'enableSideBySide', 'kind', 'mediaGenInput', 'message', 'modelName', 'responseMetadata', 'sendFinalMetadata',
];
const VIDEO_TEXT_FIELDS = ['aspectRatio', 'duration', 'prompt', 'resolutionName', 'skipAudio'];
const SAFE_SDK_HEADER_NAMES = ['x-statsig-id', 'x-xai-request-id'];

function validateRunOptions({ confirm, readbackTimeoutMs, readbackIntervalMs }) {
  if (confirm !== true) throw fail('MEDIA_WRITE_CONFIRMATION_REQUIRED');
  if (!Number.isInteger(readbackTimeoutMs) || readbackTimeoutMs < 1_000 || readbackTimeoutMs > 10 * 60_000
    || !Number.isInteger(readbackIntervalMs) || readbackIntervalMs < 250 || readbackIntervalMs > 30_000) {
    throw fail('MEDIA_READBACK_OPTIONS_INVALID');
  }
}

async function assertOwner(client) {
  if (!client || typeof client.status !== 'function') throw fail('MEDIA_CLIENT_REQUIRED');
  const status = await client.status();
  if (status?.session?.ownerVerified !== true) throw fail('OWNER_VERIFICATION_REQUIRED');
}

async function preflight({ mediaApi, quotaMode, client }) {
  if (!mediaApi || typeof mediaApi.getImagineQuota !== 'function'
    || typeof mediaApi.captureAssetSnapshot !== 'function'
    || typeof mediaApi.readBackNewAssets !== 'function'
    || !client || typeof client.status !== 'function') throw fail('MEDIA_RUNTIME_REQUIRED');
  await assertOwner(client);
  const quota = await mediaApi.getImagineQuota();
  if (quota?.modes?.[quotaMode]?.available !== true) throw fail('MEDIA_QUOTA_UNAVAILABLE');
  const snapshot = await mediaApi.captureAssetSnapshot();
  if (!snapshot?.complete || !(snapshot.assetIds instanceof Set)) throw fail('MEDIA_ASSET_BASELINE_INCOMPLETE');
  return snapshot;
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function mediaMatches(assets, type) {
  if (type === 'image') return assets.filter(asset => typeof asset.mimeType === 'string' && asset.mimeType.startsWith('image/'));
  return assets.filter(asset => asset.mimeType === 'video/mp4');
}

function collectSocketCorrelation(messages, expectedRequestId) {
  const requestIds = new Set();
  const conversationIds = new Set();
  const responseIds = new Set();
  const assetIds = new Set();
  const itemIds = new Set();
  const postIds = new Set();
  const eventTypes = new Set();
  const add = (set, value) => {
    if (typeof value === 'string' && value.length > 0 && value.length <= 256) set.add(value);
  };
  const walk = (value, parentKey = '', context = '', depth = 0) => {
    if (depth > 12 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value.slice(0, 512)) walk(child, parentKey, context, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value).slice(0, 512)) {
      const normalized = key.toLowerCase().replace(/[-_]/g, '');
      const nextContext = ['conversation', 'response', 'asset', 'item', 'post', 'task'].includes(normalized)
        ? normalized
        : context;
      if (typeof child === 'string') {
        if (['requestid', 'clientrequestid', 'requestuuid'].includes(normalized)) add(requestIds, child);
        else if (['conversationid', 'conversationuuid'].includes(normalized)) add(conversationIds, child);
        else if (['responseid', 'assistantresponseid'].includes(normalized)) add(responseIds, child);
        else if (['assetid', 'generatedassetid'].includes(normalized)) add(assetIds, child);
        else if (['postid', 'jobid', 'taskid'].includes(normalized)) add(postIds, child);
        else if (normalized === 'id') {
          if (nextContext === 'conversation') add(conversationIds, child);
          else if (nextContext === 'response') add(responseIds, child);
          else if (nextContext === 'asset') add(assetIds, child);
          else if (nextContext === 'item') add(itemIds, child);
          else if (nextContext === 'post' || nextContext === 'task') add(postIds, child);
        }
        if (normalized === 'type') eventTypes.add(child.slice(0, 128));
      }
      walk(child, key, nextContext, depth + 1);
    }
  };
  for (const message of messages) walk(message);
  return {
    requestIdEchoed: requestIds.has(expectedRequestId),
    requestIds,
    conversationIds,
    responseIds,
    assetIds,
    itemIds,
    postIds,
    eventTypes,
  };
}

function emptyDirectResponseResources() {
  return {
    requestIdEchoed: false,
    requestIds: new Set(),
    conversationIds: new Set(),
    responseIds: new Set(),
    assetIds: new Set(),
    itemIds: new Set(),
    postIds: new Set(),
    eventTypes: new Set(),
  };
}

async function withBoundedMediaReadRetryAfter(read, sleepImpl) {
  try { return await read(); }
  catch (error) {
    if (error?.details?.status !== 429) throw error;
    const seconds = error?.details?.retryAfterSeconds;
    const waitMs = Number.isInteger(seconds) && seconds > 0 ? seconds * 1_000 : 1_000;
    if (waitMs > MAX_MEDIA_READ_RETRY_AFTER_MS) throw error;
    await sleepImpl(waitMs);
    return await read();
  }
}

function hasVerifiedNoWireParents(entries, activeEntry, {
  intentDigest, intentIdSha256, ownerIdentityDigest, payloadProfile, promptSha256,
} = {}) {
  const priorEntries = entries.filter(entry => entry !== activeEntry);
  if (priorEntries.length === 0) return activeEntry.videoNoWireRecovery === undefined;
  const recovery = activeEntry.videoNoWireRecovery;
  if (!isGrokVideoNoWireRecovery(recovery) || recovery.priorRequestDigest !== activeEntry.requestDigest
    || priorEntries.some(entry => entry.state !== 'rejected'
    || entry.reasonCode !== 'MEDIA_VIDEO_CFFI_PREFLIGHT_FAILED'
    || !isGrokVideoNoWireProof(entry.videoNoWireProof, {
      operation: 'media.video.create', ownerIdentityDigest, intentIdSha256, intentDigest,
      requestDigest: entry.requestDigest, payloadProfile, promptSha256,
    }))) return false;
  const parents = priorEntries.filter(entry => createHash('sha256').update(entry.localOperationId, 'utf8').digest('hex')
    === recovery.priorOperationIdSha256 && entry.requestDigest === recovery.priorRequestDigest);
  if (parents.length !== 1) return false;
  const parent = parents[0];
  return parent.requestDigest === activeEntry.requestDigest
    && recovery.ownerIdentityDigest === ownerIdentityDigest
    && recovery.intentIdSha256 === intentIdSha256
    && recovery.payloadProfile === payloadProfile
    && recovery.promptSha256 === promptSha256
    && recovery.priorProofDigest === grokVideoNoWireProofDigest(parent.videoNoWireProof);
}

function extractPartialDirectResponseResources(value) {
  const output = emptyDirectResponseResources();
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) return output;
  const text = bytes.toString('utf8');
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (parsed !== null) return collectSocketCorrelation([parsed], '__partial_response_no_request_id__');
  const keys = {
    requestIds: ['requestId', 'clientRequestId', 'requestUuid', 'request_id'],
    conversationIds: ['conversationId', 'conversationUuid', 'conversation_id'],
    responseIds: ['responseId', 'assistantResponseId', 'response_id'],
    assetIds: ['assetId', 'generatedAssetId', 'asset_id'],
    postIds: ['postId', 'jobId', 'taskId', 'post_id', 'job_id', 'task_id'],
  };
  for (const [collection, aliases] of Object.entries(keys)) {
    for (const alias of aliases) {
      const pattern = new RegExp(`"${alias}"\\s*:\\s*"([A-Za-z0-9._:-]{1,256})"`, 'g');
      for (const match of text.matchAll(pattern)) output[collection].add(match[1]);
    }
  }
  return output;
}

function mergePartialDirectResponseResources(target, candidate) {
  if (!target || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return target;
  const map = {
    requestIds: target.requestIds,
    conversationIds: target.conversationIds,
    responseIds: target.responseIds,
    assetIds: target.assetIds,
    itemIds: target.itemIds,
    postIds: target.postIds,
  };
  for (const [name, set] of Object.entries(map)) {
    const values = candidate[name];
    if (!(set instanceof Set) || !Array.isArray(values)) continue;
    for (const value of values.slice(0, 100)) {
      if (typeof value === 'string' && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value)) set.add(value);
    }
  }
  return target;
}

function privateAssetData(asset) {
  return asset?.[GROK_MEDIA_PRIVATE_ASSET_DATA] ?? null;
}

const VERIFIED_REFERENCE_IMAGE_PROOF_KEYS = Object.freeze([
  'schemaVersion', 'ownerIdentityDigest', 'assetIdSha256', 'promptSha256', 'artifactSha256', 'bodyBytes',
  'mimeType', 'privateGenerated', 'sourceTaskHistoryVerified', 'sourceBytesVerified',
]);

function isVerifiedReferenceImageProof(value, {
  ownerIdentityDigest, assetIdSha256, promptSha256,
} = {}) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...VERIFIED_REFERENCE_IMAGE_PROOF_KEYS].sort())
    && value.schemaVersion === 1
    && value.ownerIdentityDigest === ownerIdentityDigest
    && value.assetIdSha256 === assetIdSha256
    && value.promptSha256 === promptSha256
    && typeof value.artifactSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.artifactSha256)
    && Number.isSafeInteger(value.bodyBytes) && value.bodyBytes > 0
    && value.mimeType === 'image/jpeg' && value.privateGenerated === true
    && value.sourceTaskHistoryVerified === true && value.sourceBytesVerified === true;
}

function safeMediaReadbackFailure(error) {
  const details = error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details : {};
  const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;
  const contentType = typeof details.contentType === 'string'
    && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(details.contentType)
    ? details.contentType.toLowerCase() : null;
  return {
    errorCode: safeCode(error?.code),
    causeCode: safeCode(details.causeCode) ?? safeCode(details.failureCode),
    httpStatus: Number.isInteger(details.status) && details.status >= 100 && details.status <= 599 ? details.status : null,
    contentType,
    errorClass: typeof details.errorClass === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(details.errorClass)
      ? details.errorClass : null,
  };
}

function hashSet(values) {
  return [...values].map(value => createHash('sha256').update(value, 'utf8').digest('hex')).sort();
}

async function waitForNewMedia({
  mediaApi,
  snapshot,
  type,
  expectedCount,
  timeoutMs,
  intervalMs,
  verifyAsset,
  assetRequestContext,
  expectedOwnerIdentityDigest,
  prompt,
  directResponseResources,
  directAssets,
  expectedReferenceAssetId,
  expectedRequestId,
  serverMessages = [],
}) {
  if (type !== 'image') {
    const latest = Array.isArray(directAssets)
      ? { status: 200, verified: true, assets: directAssets }
      : await mediaApi.readBackNewAssets(snapshot);
    const matchingAssets = mediaMatches(latest.assets ?? [], type).filter(asset => {
      const opaque = privateAssetData(asset);
      return asset.isPublic === false && asset.isModelGenerated === true
        && typeof opaque?.assetId === 'string' && typeof opaque?.sourceConversationId === 'string'
        && typeof opaque?.responseId === 'string';
    });
    if (type !== 'video' || !latest.verified || matchingAssets.length !== expectedCount
      || typeof prompt !== 'string' || !directResponseResources) {
      return {
        state: latest.verified && matchingAssets.length ? 'needs_review' : 'outcome_unknown',
        readback: latest,
        matchingAssets,
        correlation: { verified: false, reason: 'MEDIA_DIRECT_RESOURCE_CORRELATION_REQUIRED' },
      };
    }
    const correlated = [];
    for (const asset of matchingAssets) {
      const opaque = privateAssetData(asset);
      let evidence;
      try {
        evidence = await mediaApi.readConversationEvidence({ conversationId: opaque.sourceConversationId, expectedPrompt: prompt,
          ...(expectedReferenceAssetId ? { expectedReferenceAssetId } : {}) });
      } catch {
        evidence = null;
      }
      if (!evidence || evidence.conversationMatch !== true || evidence.promptExactMatch !== true
        || (Number.isInteger(evidence.matchingUserPromptCount)
          ? evidence.matchingUserPromptCount !== 1 : evidence.uniqueUserPromptCount !== 1)
        || typeof evidence.promptSha256 !== 'string') continue;
      const responseIds = evidence[GROK_MEDIA_PRIVATE_RESPONSE_IDS]?.matchingPrompt ?? [];
      const assetResponseMatchesPrompt = responseIds.includes(opaque.responseId);
      const historyReferenceAssetIds = evidence[GROK_MEDIA_PRIVATE_REFERENCE_ASSET_IDS] ?? [];
      const assetMediaInputIds = [];
      for (const mode of ['imageToVideo', 'referenceToVideo']) {
        const inputAssets = opaque.mediaGenInput?.[mode]?.inputAssets;
        if (Array.isArray(inputAssets)) assetMediaInputIds.push(...inputAssets.filter(value => typeof value === 'string'));
        const firstFrame = opaque.mediaGenInput?.[mode]?.firstFrameAsset;
        const lastFrame = opaque.mediaGenInput?.[mode]?.lastFrameAsset;
        if (typeof firstFrame === 'string') assetMediaInputIds.push(firstFrame);
        if (typeof lastFrame === 'string') assetMediaInputIds.push(lastFrame);
      }
      const referenceAssetLinked = expectedReferenceAssetId === undefined
        || evidence.referenceAssetMatched === true
        || historyReferenceAssetIds.includes(expectedReferenceAssetId)
        || assetMediaInputIds.includes(expectedReferenceAssetId);
      const directConversationMatch = directResponseResources.conversationIds.has(opaque.sourceConversationId);
      const directResponseMatch = directResponseResources.responseIds.has(opaque.responseId)
        || directResponseResources.itemIds.has(opaque.responseId);
      const directAssetMatch = directResponseResources.assetIds.has(opaque.assetId);
      const directPostMatch = directResponseResources.postIds.has(opaque.responseId);
      const directResourceLinked = directConversationMatch || directResponseMatch || directAssetMatch || directPostMatch;
      const writerComparatorAvailable = directResponseResources.conversationIds.size > 0 || directResponseResources.responseIds.size > 0
        || directResponseResources.assetIds.size > 0 || directResponseResources.postIds.size > 0;
      if (assetResponseMatchesPrompt && referenceAssetLinked && (!writerComparatorAvailable || directResourceLinked)) {
        correlated.push({ asset, evidence, directConversationMatch, directResponseMatch, directAssetMatch, directPostMatch,
          referenceAssetLinked });
      }
    }
    const conversations = new Set(matchingAssets.map(asset => privateAssetData(asset).sourceConversationId));
    const assets = new Set(matchingAssets.map(asset => privateAssetData(asset).assetId));
    const correlation = {
      verified: latest.verified === true && correlated.length === expectedCount && conversations.size === 1 && assets.size === expectedCount,
      writerResponseIdComparatorAvailable: directResponseResources.conversationIds.size > 0 || directResponseResources.responseIds.size > 0
        || directResponseResources.assetIds.size > 0 || directResponseResources.postIds.size > 0,
      returnedConversationCount: directResponseResources.conversationIds.size,
      returnedResponseCount: directResponseResources.responseIds.size + directResponseResources.itemIds.size,
      returnedAssetCount: directResponseResources.assetIds.size,
      candidateAssetCount: matchingAssets.length,
      correlatedAssetCount: correlated.length,
      uniqueConversationCount: conversations.size,
      promptSha256: correlated[0]?.evidence.promptSha256 ?? null,
      assetResponseIdsMatchPrompt: correlated.length === expectedCount,
      referenceInputLinked: expectedReferenceAssetId === undefined || correlated.length === expectedCount
        && correlated.every(item => item.referenceAssetLinked),
      directResourceLinkCount: correlated.filter(item => item.directConversationMatch || item.directResponseMatch
        || item.directAssetMatch || item.directPostMatch).length,
      conversationIdSha256: hashSet(conversations),
      assetIdSha256: hashSet(assets),
      responseIdSha256: hashSet(correlated.map(item => privateAssetData(item.asset).responseId)),
      createTimeBounded: matchingAssets.every(asset => {
        const value = asset.createTime;
        const created = typeof value === 'number' ? (value > 10_000_000_000 ? value : value * 1000) : Date.parse(value);
        return Number.isFinite(created) && created >= snapshot.capturedAt - 5_000 && created <= Date.now() + 5_000;
      }),
    };
    correlation.verified = correlation.verified && correlation.createTimeBounded && correlation.referenceInputLinked;
    if (!correlation.verified) return { state: 'needs_review', readback: latest, matchingAssets, correlation };
    if (typeof verifyAsset !== 'function') return { state: 'needs_review', readback: latest, matchingAssets, correlation };
    try {
      const ids = correlated.map(item => privateAssetData(item.asset).assetId);
      const boundVerifier = asset => verifyAsset(asset, { assetRequestContext, expectedOwnerIdentityDigest });
      const verified = Array.isArray(directAssets)
        ? await mediaApi.verifyExactAssets({ assets: correlated.map(item => item.asset), verifyAsset: boundVerifier })
        : await mediaApi.readBackNewAssets(snapshot, { assetIds: ids, verifyAsset: boundVerifier });
      const checks = verified.mediaVerifications ?? [];
      if (!verified.verified || checks.length !== expectedCount || checks.some(item => item.magicVerified !== true
        || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256))) {
        return { state: 'needs_review', readback: verified, matchingAssets: mediaMatches(verified.assets ?? [], type), correlation };
      }
      return { state: 'completed', readback: verified, matchingAssets: verified.assets, correlation };
    } catch (error) {
      return { state: 'needs_review', readback: latest, matchingAssets, correlation,
        failure: safeMediaReadbackFailure(error) };
    }
  }
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  const conversationEvidenceCache = new Map();
  while (Date.now() <= deadline) {
    latest = await mediaApi.readBackNewAssets(snapshot);
    if (latest.verified) {
      const imageCandidates = mediaMatches(latest.assets ?? [], 'image').filter(asset => {
        const opaque = privateAssetData(asset);
        return opaque && typeof opaque.assetId === 'string'
          && typeof opaque.sourceConversationId === 'string'
          && typeof opaque.responseId === 'string'
          && asset.isPublic === false && asset.isModelGenerated === true;
      });
      if (imageCandidates.length) {
        if (typeof prompt !== 'string' || !prompt || typeof expectedRequestId !== 'string' || !expectedRequestId) {
          return { state: 'needs_review', readback: latest, matchingAssets: [], correlation: { verified: false, reason: 'MEDIA_CORRELATION_INPUT_MISSING' } };
        }
        const protocol = collectSocketCorrelation(serverMessages, expectedRequestId);
        const correlated = [];
        for (const asset of imageCandidates) {
          const opaque = privateAssetData(asset);
          const sourceConversationId = opaque.sourceConversationId;
          let evidence = conversationEvidenceCache.get(sourceConversationId);
          if (!evidence) {
            try {
              evidence = await mediaApi.readConversationEvidence({ conversationId: sourceConversationId, expectedPrompt: prompt });
            } catch {
              evidence = null;
            }
            if (evidence?.conversationMatch === true && evidence?.promptExactMatch === true
              && evidence.uniqueUserPromptCount === 1 && evidence.responseCount > 0) conversationEvidenceCache.set(sourceConversationId, evidence);
          }
          if (!evidence || evidence.conversationMatch !== true || evidence.promptExactMatch !== true
            || evidence.uniqueUserPromptCount !== 1
            || typeof evidence.promptSha256 !== 'string') continue;
          const responseIds = evidence[GROK_MEDIA_PRIVATE_RESPONSE_IDS]?.matchingPrompt ?? [];
          const assetResponseMatchesPrompt = responseIds.includes(opaque.responseId);
          const directConversationMatch = protocol.conversationIds.has(sourceConversationId);
          const directResponseMatch = protocol.responseIds.has(opaque.responseId) || protocol.itemIds.has(opaque.responseId);
          const directAssetMatch = protocol.assetIds.has(opaque.assetId);
          const directPostMatch = protocol.postIds.has(opaque.responseId);
          const directResourceLinked = directConversationMatch || directResponseMatch || directAssetMatch || directPostMatch;
          if (protocol.requestIdEchoed && directResourceLinked && assetResponseMatchesPrompt) {
            correlated.push({ asset, evidence, directConversationMatch, directResponseMatch, directAssetMatch, directPostMatch });
          }
        }
        if (correlated.length) {
          const targetConversationIds = new Set(correlated.map(item => privateAssetData(item.asset).sourceConversationId));
          const uniqueAssetIds = new Set(correlated.map(item => privateAssetData(item.asset).assetId));
          const directResourceLinked = correlated.every(item => item.directConversationMatch
            || item.directResponseMatch || item.directAssetMatch || item.directPostMatch);
          const matchedAssets = correlated.map(item => item.asset);
          const correlation = {
            verified: protocol.requestIdEchoed && targetConversationIds.size === 1 && uniqueAssetIds.size === expectedCount
              && matchedAssets.length === expectedCount && directResourceLinked,
            requestIdEchoed: protocol.requestIdEchoed,
            returnedConversationCount: protocol.conversationIds.size,
            returnedResponseCount: protocol.responseIds.size + protocol.itemIds.size,
            returnedAssetCount: protocol.assetIds.size,
            candidateAssetCount: imageCandidates.length,
            correlatedAssetCount: correlated.length,
            uniqueConversationCount: targetConversationIds.size,
            promptSha256: correlated[0].evidence.promptSha256,
            assetResponseIdsMatchPrompt: correlated.length === expectedCount,
            directResourceLinkCount: correlated.filter(item => item.directConversationMatch
              || item.directResponseMatch || item.directAssetMatch || item.directPostMatch).length,
            conversationIdSha256: hashSet(targetConversationIds),
            assetIdSha256: hashSet(uniqueAssetIds),
            responseIdSha256: hashSet(correlated.map(item => privateAssetData(item.asset).responseId)),
            eventTypes: [...protocol.eventTypes].sort().slice(0, 32),
          };
          if (!correlation.verified) {
            return { state: 'needs_review', readback: latest, matchingAssets: matchedAssets, correlation };
          }
          if (typeof verifyAsset !== 'function') {
            return { state: 'needs_review', readback: latest, matchingAssets: matchedAssets, correlation };
          }
          try {
            const ids = correlated.map(item => privateAssetData(item.asset).assetId);
            const verifyBoundAsset = asset => verifyAsset(asset, { assetRequestContext, expectedOwnerIdentityDigest });
            const verified = await mediaApi.readBackNewAssets(snapshot, { assetIds: ids, verifyAsset: verifyBoundAsset });
            const checks = verified.mediaVerifications ?? [];
            if (!verified.verified || checks.length !== expectedCount || checks.some(item => item.magicVerified !== true)) {
              return { state: 'needs_review', readback: verified, matchingAssets: mediaMatches(verified.assets ?? [], 'image'), correlation };
            }
            return { state: 'completed', readback: verified, matchingAssets: verified.assets, correlation };
          } catch {
            return { state: 'needs_review', readback: latest, matchingAssets: matchedAssets, correlation };
          }
        }
      }
    }
    if (Date.now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  return {
    state: 'outcome_unknown',
    readback: latest,
    matchingAssets: [],
    correlation: { verified: false, reason: 'MEDIA_DIRECT_RESOURCE_LINK_NOT_OBSERVED' },
  };
}

async function settleIntent(intentJournal, intent, { state, httpStatus, reasonCode, readback }) {
  return intentJournal.transition(intent.intentId, state, {
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...(readback ? {
      readback: {
        assetCount: readback.assets?.length ?? 0,
        mimeTypes: [...new Set((readback.assets ?? []).map(asset => asset.mimeType).filter(Boolean))],
        magicVerified: readback.mediaVerifications?.length > 0
          && readback.mediaVerifications.every(item => item.magicVerified === true),
        bodyBytes: readback.mediaVerifications?.reduce((sum, item) => sum + item.bodyBytes, 0) ?? 0,
      },
    } : {}),
  });
}

async function completeOperationJournal(operationJournal, submitted, httpStatus, reconciledBy = 'media.assets.list') {
  if (!operationJournal || typeof operationJournal.transition !== 'function'
    || typeof submitted?.localOperationId !== 'string') return false;
  try {
    await operationJournal.transition(submitted.localOperationId, 'completed', {
      ...(Number.isInteger(httpStatus) ? { httpStatus } : {}),
      reasonCode: 'MEDIA_ASSET_READBACK_VERIFIED',
      reconciledBy,
    });
    return true;
  } catch {
    return false;
  }
}

async function findNewOperationEntry(operationJournal, previousIds, operationId) {
  if (!operationJournal || typeof operationJournal.list !== 'function') return null;
  const entries = await operationJournal.list();
  return [...entries].reverse().find(entry => entry.contractId === operationId && !previousIds.has(entry.localOperationId)) ?? null;
}

function headerValue(headers, expectedName) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  const key = Object.keys(headers).find(name => name.toLowerCase() === expectedName);
  return key ? headers[key] : undefined;
}

function validImagineReferer(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let referer;
  try { referer = new URL(value); } catch { return false; }
  if (referer.origin !== GROK_WEB_ORIGIN || referer.username || referer.password || referer.hash) return false;
  const isImagine = referer.pathname === '/imagine';
  const isAssetPost = /^\/imagine\/post\/[A-Za-z0-9._~-]{1,256}$/.test(referer.pathname);
  const keys = [...referer.searchParams.keys()];
  return (isImagine || isAssetPost)
    && keys.every(key => key === 'scope' || key === 'conversation')
    && new Set(keys).size === keys.length
    && (!referer.searchParams.has('scope') || referer.searchParams.get('scope') === 'asset')
    && (!referer.searchParams.has('conversation') || /^[A-Za-z0-9._~-]{1,128}$/.test(referer.searchParams.get('conversation')));
}

function validateProvisionalVideoCapture(capture, prompt, intentId, { referenceAssetId } = {}) {
  const captureKeys = ['bodyText', 'browserAbortVerified', 'headers', 'intentId', 'method', 'ordinaryHeaders', 'path', 'serverWritesDelivered', 'ssoCookieObserved'];
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)
    || JSON.stringify(Object.keys(capture).sort()) !== JSON.stringify(captureKeys)
    || capture.intentId !== intentId || capture.method !== 'POST' || capture.path !== VIDEO_CREATE_PATH
    || capture.browserAbortVerified !== true || capture.serverWritesDelivered !== 0 || capture.ssoCookieObserved !== true
    || typeof capture.bodyText !== 'string' || capture.bodyText.length < 1 || capture.bodyText.length > 64 * 1024) {
    throw fail('MEDIA_CAPTURE_NOT_VERIFIED');
  }
  if (!capture.headers || typeof capture.headers !== 'object' || Array.isArray(capture.headers)
    || JSON.stringify(Object.keys(capture.headers).map(name => name.toLowerCase()).sort()) !== JSON.stringify([...SAFE_SDK_HEADER_NAMES].sort())) {
    throw fail('MEDIA_CAPTURE_HEADERS_INVALID');
  }
  const safeOrdinaryHeaders = new Set([
    'accept', 'accept-language', 'content-type', 'origin', 'referer', 'user-agent',
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  ]);
  if (!capture.ordinaryHeaders || typeof capture.ordinaryHeaders !== 'object' || Array.isArray(capture.ordinaryHeaders)
    || Object.keys(capture.ordinaryHeaders).some(name => !safeOrdinaryHeaders.has(name.toLowerCase()))
    || Object.values(capture.ordinaryHeaders).some(value => typeof value !== 'string' || !value.trim()
      || value.length > 2048 || /[\r\n\0]/.test(value))) throw fail('MEDIA_CAPTURE_HEADERS_INVALID');
  const basic = Object.fromEntries(Object.entries(capture.ordinaryHeaders).map(([name, value]) => [name.toLowerCase(), value]));
  if (basic['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
    || basic.origin !== GROK_WEB_ORIGIN || !validImagineReferer(basic.referer)
    || !basic.accept || !basic['user-agent'] || !basic['sec-ch-ua-platform']) throw fail('MEDIA_CAPTURE_HEADERS_INVALID');
  let body;
  try { body = JSON.parse(capture.bodyText); } catch { throw fail('MEDIA_CAPTURE_BODY_INVALID'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...VIDEO_BODY_FIELDS].sort())) {
    throw fail('MEDIA_CAPTURE_BODY_SCHEMA_INVALID');
  }
  const videoInput = referenceAssetId === undefined ? body.mediaGenInput?.textToVideo : body.mediaGenInput?.imageToVideo;
  const baseVideoInputKeys = referenceAssetId === undefined
    ? VIDEO_TEXT_FIELDS
    : ['aspectRatio', 'duration', 'inputAssets', 'mode', 'prompt', 'resolutionName', 'skipAudio'];
  const inputKeys = videoInput && typeof videoInput === 'object' && !Array.isArray(videoInput)
    ? Object.keys(videoInput).sort() : [];
  const optionalReferenceFields = referenceAssetId === undefined ? [] : ['useFirstFrame'];
  const allowedInputKeys = new Set([...baseVideoInputKeys, ...optionalReferenceFields]);
  const inputShapeValid = inputKeys.length === baseVideoInputKeys.length
    || referenceAssetId !== undefined && inputKeys.length === baseVideoInputKeys.length + 1
      && inputKeys.includes('useFirstFrame');
  const sourceReferenceMatches = referenceAssetId === undefined
    ? !body.mediaGenInput?.imageToVideo
    : !body.mediaGenInput?.textToVideo && Array.isArray(videoInput?.inputAssets)
      && videoInput.inputAssets.length === 1 && videoInput.inputAssets[0] === referenceAssetId
      && videoInput.mode === 'custom'
      && (!Object.hasOwn(videoInput, 'useFirstFrame') || typeof videoInput.useFirstFrame === 'boolean');
  const expectedVideoMessage = `${prompt.trim()} --mode=custom`;
  if (body.modelName !== 'imagine-video-gen' || body.kind !== 'CONVERSATION_KIND_IMAGINE'
    || body.message !== expectedVideoMessage || body.enableImageStreaming !== true || body.enableSideBySide !== true
    || body.sendFinalMetadata !== true || !Array.isArray(body.responseMetadata?.experiments)
    || body.responseMetadata.experiments.length !== 0
    || !body.responseMetadata.modelConfigOverride?.modelMap
    || Object.keys(body.responseMetadata).sort().join(',') !== 'experiments,modelConfigOverride'
    || Object.keys(body.responseMetadata.modelConfigOverride).sort().join(',') !== 'modelMap'
    || Object.keys(body.responseMetadata.modelConfigOverride.modelMap).length !== 0
    || Object.keys(body.mediaGenInput ?? {}).sort().join(',') !== (referenceAssetId === undefined ? 'textToVideo' : 'imageToVideo')
    || !videoInput || !inputShapeValid || inputKeys.some(key => !allowedInputKeys.has(key))
    || videoInput.prompt !== prompt || videoInput.aspectRatio !== '2:3' || videoInput.duration !== 6
    || videoInput.resolutionName !== '480p' || videoInput.skipAudio !== true || !sourceReferenceMatches) {
    throw fail('MEDIA_CAPTURE_PROFILE_INVALID');
  }
  const dynamicHeaders = {};
  for (const name of SAFE_SDK_HEADER_NAMES) {
    const value = headerValue(capture.headers, name);
    if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\r\n\0]/.test(value)) {
      throw fail('MEDIA_CAPTURE_SDK_HEADER_MISSING');
    }
    dynamicHeaders[name] = value;
  }
  return { body, videoInput, dynamicHeaders, ordinaryHeaders: basic,
    generationMode: referenceAssetId === undefined ? 'text' : 'image_reference' };
}

async function readBoundedResponse(response, maxBytes = 2 * 1024 * 1024) {
  const length = response.headers.get('content-length');
  if (length !== null) {
    const declared = Number(length);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) throw fail('MEDIA_RESPONSE_SIZE_LIMIT');
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) throw fail('MEDIA_RESPONSE_SIZE_LIMIT');
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    const partial = Buffer.concat(chunks, total);
    const partialResources = extractPartialDirectResponseResources(partial);
    const responseBodySha256 = createHash('sha256').update(partial).digest('hex');
    partial.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    const details = { responseBytesRead: total, responseBodySha256, partialResources };
    if (error?.code === 'MEDIA_RESPONSE_SIZE_LIMIT') throw fail('MEDIA_RESPONSE_SIZE_LIMIT', details);
    throw fail('MEDIA_RESPONSE_READ_FAILED', details);
  } finally {
    reader.releaseLock();
  }
  const responseBytes = Buffer.concat(chunks, total);
  for (const chunk of chunks) chunk.fill(0);
  return responseBytes;
}

function sanitizedResponseShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { topLevelType: Array.isArray(value) ? 'array' : typeof value };
  const denied = /(?:token|cookie|secret|auth|signature|session|user.?id|asset.?id|conversation.?id|job.?id|url|key)/i;
  return { topLevelFieldNames: Object.keys(value).filter(name => !denied.test(name)).sort().slice(0, 64) };
}

function safeVideoTransportEvidence(error) {
  const evidence = error?.details?.transportEvidence;
  const keys = ['stage', 'requestStarted', 'responseReceived', 'httpStatus', 'contentType', 'httpVersion',
    'responseBytesRead', 'requestBodyBytes', 'cfMitigated', 'errorClass', 'requestHeaderNames',
    'responseHeaderNames', 'cookieNamesUsed', 'source'];
  const responseHeaders = new Set(['content-type', 'content-length', 'cf-mitigated', 'retry-after']);
  const requestHeaders = new Set(['accept', 'content-type', 'origin', 'referer', 'user-agent', 'sec-ch-ua',
    'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
    'x-statsig-id', 'x-xai-request-id']);
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify([...keys].sort())
    || !['validation', 'dependency', 'session_setup', 'request', 'response_headers', 'response_body'].includes(evidence.stage)
    || typeof evidence.requestStarted !== 'boolean' || typeof evidence.responseReceived !== 'boolean'
    || evidence.httpStatus !== null && (!Number.isInteger(evidence.httpStatus) || evidence.httpStatus < 100 || evidence.httpStatus > 599)
    || evidence.contentType !== null && (typeof evidence.contentType !== 'string' || evidence.contentType.length > 128
      || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(evidence.contentType))
    || !['http/1.0', 'http/1.1', 'h2', 'h3', 'other'].includes(evidence.httpVersion)
    || !Number.isInteger(evidence.responseBytesRead) || evidence.responseBytesRead < 0 || evidence.responseBytesRead > 2 * 1024 * 1024
    || !Number.isInteger(evidence.requestBodyBytes) || evidence.requestBodyBytes < 0 || evidence.requestBodyBytes > 64 * 1024
    || typeof evidence.cfMitigated !== 'boolean'
    || evidence.errorClass !== null && (typeof evidence.errorClass !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(evidence.errorClass))
    || !Array.isArray(evidence.requestHeaderNames) || evidence.requestHeaderNames.some(name => !requestHeaders.has(name))
    || !Array.isArray(evidence.responseHeaderNames) || evidence.responseHeaderNames.some(name => !responseHeaders.has(name))
    || !Array.isArray(evidence.cookieNamesUsed) || evidence.cookieNamesUsed.some(name => name !== 'sso')
    || evidence.cookieNamesUsed.length > 1 || evidence.source !== 'curl_cffi-0.16.3-chrome150'
    || evidence.responseReceived && !evidence.requestStarted
    || !evidence.requestStarted && (evidence.responseBytesRead !== 0 || evidence.httpStatus !== null
      || evidence.contentType !== null || evidence.cookieNamesUsed.length !== 0)
    || !evidence.responseReceived && (evidence.httpStatus !== null || evidence.contentType !== null
      || evidence.responseBytesRead !== 0 || evidence.responseHeaderNames.length !== 0)) return undefined;
  return {
    stage: evidence.stage,
    requestStarted: evidence.requestStarted,
    responseReceived: evidence.responseReceived,
    httpStatus: evidence.httpStatus,
    contentType: evidence.contentType,
    httpVersion: evidence.httpVersion,
    responseBytesRead: evidence.responseBytesRead,
    requestBodyBytes: evidence.requestBodyBytes,
    cfMitigated: evidence.cfMitigated,
    errorClass: evidence.errorClass,
    requestHeaderNames: [...evidence.requestHeaderNames],
    responseHeaderNames: [...evidence.responseHeaderNames],
    cookieNamesUsed: [...evidence.cookieNamesUsed],
    source: evidence.source,
  };
}

function makeVideoNoWireProof(error, { ownerIdentityDigest, intentId, intentDigest, requestDigest, prompt, payloadProfile }) {
  const evidence = safeVideoTransportEvidence(error);
  const helperErrorCode = error?.details?.helperErrorCode;
  if (!evidence || evidence.requestStarted !== false || evidence.responseReceived !== false
    || !['validation', 'dependency', 'session_setup'].includes(evidence.stage)
    || typeof helperErrorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(helperErrorCode)) return undefined;
  const proof = {
    schemaVersion: 1,
    operation: 'media.video.create',
    ownerIdentityDigest,
    intentIdSha256: createHash('sha256').update(intentId, 'utf8').digest('hex'),
    intentDigest,
    requestDigest,
    payloadProfile,
    promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
    stage: evidence.stage,
    requestStarted: false,
    responseReceived: false,
    httpStatus: null,
    contentType: null,
    httpVersion: evidence.httpVersion,
    responseBytesRead: 0,
    requestBodyBytes: evidence.requestBodyBytes,
    cfMitigated: false,
    errorClass: evidence.errorClass,
    helperErrorCode,
    requestHeaderNames: [...evidence.requestHeaderNames].sort(),
    responseHeaderNames: [],
    cookieNamesUsed: [],
    source: evidence.source,
  };
  return isGrokVideoNoWireProof(proof, { ownerIdentityDigest, intentDigest, requestDigest }) ? proof : undefined;
}

function safeVideoResponseReadEvidence({ response, error, status, contentType, bodyText, capture }) {
  const transport = response?.transportEvidence;
  if (!transport || transport.source !== 'curl_cffi-0.16.3-chrome150') return undefined;
  const allowedResponseHeaders = new Set(['content-type', 'content-length', 'cf-mitigated', 'retry-after']);
  const requestHeaderNames = Array.isArray(transport.requestHeaderNames)
    ? transport.requestHeaderNames
    : [...Object.keys(capture.ordinaryHeaders ?? {}), ...Object.keys(capture.dynamicHeaders ?? {})];
  const responseHeaderNames = [...response.headers.keys()].map(name => name.toLowerCase())
    .filter(name => allowedResponseHeaders.has(name));
  return safeVideoTransportEvidence({ details: { transportEvidence: {
    stage: 'response_body',
    requestStarted: true,
    responseReceived: true,
    httpStatus: status,
    contentType: typeof contentType === 'string' && contentType ? contentType : null,
    httpVersion: transport.httpVersion,
    responseBytesRead: Number.isInteger(error?.details?.responseBytesRead) ? error.details.responseBytesRead : 0,
    requestBodyBytes: Buffer.byteLength(bodyText, 'utf8'),
    cfMitigated: String(response.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge',
    errorClass: typeof error?.name === 'string' ? error.name : null,
    requestHeaderNames: [...new Set(requestHeaderNames.map(name => String(name).toLowerCase()))].sort(),
    responseHeaderNames,
    cookieNamesUsed: transport.cookieNamesUsed,
    source: transport.source,
  } } });
}

function safeVideoSuccessEvidence({ response, status, contentType, responseBytes, responseBodySha256, requestBodyBytes }) {
  const value = response?.transportEvidence;
  const requestHeaders = new Set(['accept', 'content-type', 'origin', 'referer', 'user-agent', 'sec-ch-ua',
    'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
    'x-statsig-id', 'x-xai-request-id']);
  const responseHeaders = new Set(['content-type', 'content-length', 'cf-mitigated', 'retry-after']);
  if (!value || value.source !== 'curl_cffi-0.16.3-chrome150'
    || !['http/1.0', 'http/1.1', 'h2', 'h3', 'other'].includes(value.httpVersion)
    || !Array.isArray(value.requestHeaderNames) || value.requestHeaderNames.some(name => !requestHeaders.has(name))
    || !Array.isArray(value.responseHeaderNames) || value.responseHeaderNames.some(name => !responseHeaders.has(name))
    || JSON.stringify(value.cookieNamesUsed) !== JSON.stringify(['sso'])
    || typeof responseBodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(responseBodySha256)
    || value.responseBodySha256 !== responseBodySha256
    || !Number.isInteger(responseBytes) || responseBytes < 0 || responseBytes > 2 * 1024 * 1024
    || !Number.isInteger(requestBodyBytes) || requestBodyBytes < 0 || requestBodyBytes > 64 * 1024
    || value.contentLength !== null && (!Number.isInteger(value.contentLength) || value.contentLength < 0 || value.contentLength > 2 * 1024 * 1024)
    || value.retryAfterSeconds !== null && (!Number.isInteger(value.retryAfterSeconds) || value.retryAfterSeconds < 0 || value.retryAfterSeconds > 86_400)) {
    return undefined;
  }
  return {
    stage: 'response_body',
    requestStarted: true,
    responseReceived: true,
    httpStatus: status,
    contentType: typeof contentType === 'string' && contentType ? contentType : null,
    httpVersion: value.httpVersion,
    responseBytesRead: responseBytes,
    requestBodyBytes,
    cfMitigated: value.cfMitigated === true,
    errorClass: null,
    requestHeaderNames: [...new Set(value.requestHeaderNames)].sort(),
    responseHeaderNames: [...new Set(value.responseHeaderNames)].sort(),
    cookieNamesUsed: ['sso'],
    source: value.source,
    responseBodySha256,
    contentLength: value.contentLength,
    retryAfterSeconds: value.retryAfterSeconds,
  };
}

function paymentOrUpgradeSignal(body) {
  const text = body.toString('utf8', 0, Math.min(body.length, 64 * 1024));
  return /(?:purchase|upgrade|subscribe|payment required|insufficient credits|buy credits|add credits)/i.test(text);
}

async function reconcileProvisionalVideoReadback({
  operationJournal,
  operationEntry,
  intentJournal,
  intent,
  mediaApi,
  snapshot,
  verifyAsset,
  prompt,
  expectedReferenceAssetId,
  directResponseResources,
  directAssets,
  assetRequestContext,
  expectedOwnerIdentityDigest,
  readbackTimeoutMs,
  readbackIntervalMs,
  heldState,
  httpStatus,
  reconciledBy = 'media.assets.list',
  responseDetails = {},
}) {
  responseDetails = {
    ...responseDetails,
    directHttpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
  };
  let readback;
  let readbackFailure;
  try {
    readback = await waitForNewMedia({
      mediaApi, snapshot, type: 'video', expectedCount: 1, timeoutMs: readbackTimeoutMs, intervalMs: readbackIntervalMs,
      verifyAsset, prompt, directResponseResources, assetRequestContext, expectedOwnerIdentityDigest, expectedReferenceAssetId,
      directAssets,
    });
  } catch (error) {
    readbackFailure = safeMediaReadbackFailure(error);
    readback = { state: 'needs_review', readback: null, matchingAssets: [] };
  }
  if (!readbackFailure && readback?.failure) readbackFailure = readback.failure;
  if (readback.correlation && readback.correlation.writerResponseIdComparatorAvailable !== true
    && typeof responseDetails.writerResponseIdComparatorReason === 'string') {
    readback.correlation = {
      ...readback.correlation,
      writerResponseIdComparatorReason: responseDetails.writerResponseIdComparatorReason,
    };
  }
  if (readback.state === 'completed') {
    const journalCompleted = await completeOperationJournal(operationJournal, operationEntry, httpStatus, reconciledBy);
    if (journalCompleted) {
      await settleIntent(intentJournal, intent, {
        state: 'completed', httpStatus, reasonCode: 'MEDIA_ASSET_READBACK_VERIFIED', readback: readback.readback,
      });
      return { ...responseDetails, state: 'completed', readbackVerified: true, assets: readback.matchingAssets,
        mediaVerifications: readback.readback?.mediaVerifications ?? [], correlation: readback.correlation };
    }
    await settleIntent(intentJournal, intent, {
      state: 'needs_review', httpStatus, reasonCode: 'OPERATION_JOURNAL_RECONCILE_FAILED', readback: readback.readback,
    });
    return { ...responseDetails, state: 'needs_review', readbackVerified: true, assets: readback.matchingAssets,
      mediaVerifications: readback.readback?.mediaVerifications ?? [], correlation: readback.correlation };
  }
  if (intent.state !== heldState) {
    await settleIntent(intentJournal, intent, {
      state: heldState,
      httpStatus,
      reasonCode: 'MEDIA_VIDEO_READBACK_INCOMPLETE',
      readback: readback.readback,
    });
  }
  return { ...responseDetails, ...(readbackFailure ? { readbackFailure } : {}), state: heldState, readbackVerified: false, assets: readback.matchingAssets ?? [],
    correlation: readback.correlation };
}

export async function reconcileUnknownGrokVideoOnce({
  client,
  sessionPersistence,
  mediaApi,
  operationJournal,
  intentJournal,
  intentId,
  prompt,
  generationMode = 'text',
  referenceAssetId,
  referenceAssetIdSha256,
  referencePromptSha256,
  candidateAssetId,
  candidateAssetIdSha256,
  verifiedReferenceImageProof,
  assetRequestContext,
  verifyAsset,
  sleepImpl = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4_000
    || typeof intentId !== 'string' || !intentId.trim()
    || !['text', 'image_reference'].includes(generationMode)
    || (generationMode === 'image_reference'
      && ((typeof referenceAssetId !== 'string' || !referenceAssetId.trim())
        && (typeof referenceAssetIdSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(referenceAssetIdSha256))
        || typeof referencePromptSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(referencePromptSha256)))
    || (generationMode === 'text' && (referenceAssetId !== undefined || referenceAssetIdSha256 !== undefined
      || referencePromptSha256 !== undefined || verifiedReferenceImageProof !== undefined))
    || ((candidateAssetId === undefined) !== (candidateAssetIdSha256 === undefined))
    || (candidateAssetId !== undefined && (typeof candidateAssetId !== 'string' || candidateAssetId.length < 16
      || candidateAssetId.length > 512 || /[\r\n\0]/.test(candidateAssetId)
      || typeof candidateAssetIdSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(candidateAssetIdSha256)
      || createHash('sha256').update(candidateAssetId, 'utf8').digest('hex') !== candidateAssetIdSha256.toLowerCase()))
    || (candidateAssetId !== undefined && generationMode === 'image_reference' && typeof referenceAssetId !== 'string')
    || !sessionPersistence || typeof sessionPersistence.read !== 'function'
    || !operationJournal || typeof operationJournal.list !== 'function'
    || typeof operationJournal.transition !== 'function'
    || !intentJournal || typeof intentJournal.get !== 'function' || typeof intentJournal.transition !== 'function'
    || !mediaApi || typeof mediaApi.readBackNewAssets !== 'function' || typeof sleepImpl !== 'function'
    || candidateAssetId !== undefined && (typeof mediaApi.readAssetMetadata !== 'function'
      || typeof mediaApi.verifyExactAssets !== 'function')
    || typeof mediaApi.readConversationEvidence !== 'function') throw fail('MEDIA_VIDEO_RECONCILE_RUNTIME_REQUIRED');

  await assertOwner(client);
  const stored = await sessionPersistence.read();
  const ownerIdentityDigest = stored?.session?.ownerBinding?.identityDigest;
  if (stored?.kind !== 'grok-session' || typeof ownerIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(ownerIdentityDigest)) {
    throw fail('OWNER_VERIFICATION_REQUIRED');
  }
  const promptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const profile = generationMode === 'image_reference'
    ? 'video-image-reference-6s-480p-no-audio' : 'video-6s-480p-no-audio';
  const intent = await intentJournal.get(intentId);
  if (intent.operation !== 'media.video.create' || !['outcome_unknown', 'accepted', 'needs_review'].includes(intent.state)
    || intent.attemptNumber !== 1
    || intent.payloadProfile !== profile || intent.promptLength !== prompt.length
    || intent.promptSha256 !== promptSha256 || intent.ownerIdentityDigest !== ownerIdentityDigest) {
    throw fail('MEDIA_INTENT_RECONCILE_BINDING_MISMATCH');
  }
  validateGrokAssetRequestContext(
    'https://assets.grok.com/users/owner/generated/video.mp4?cache=1', assetRequestContext, ownerIdentityDigest,
  );
  const intentDigest = createHash('sha256')
    .update(`media.video.create\n${ownerIdentityDigest}\n${intentId}`, 'utf8')
    .digest('hex');
  const entries = (await operationJournal.list()).filter(entry => entry.contractId === 'media.video.create'
    && entry.intentDigest === intentDigest);
  const activeEntries = entries.filter(entry => entry.state === 'outcome_unknown'
    || entry.state === 'needs_review' && Number.isInteger(entry.httpStatus));
  const operationEntry = activeEntries.length === 1 ? activeEntries[0] : null;
  const hasHttpSuccess = Number.isInteger(operationEntry?.httpStatus)
    && operationEntry.httpStatus >= 200 && operationEntry.httpStatus <= 299;
  const noWireParentsVerified = operationEntry !== null && hasVerifiedNoWireParents(entries, operationEntry, {
    intentDigest,
    intentIdSha256: createHash('sha256').update(intentId, 'utf8').digest('hex'),
    ownerIdentityDigest,
    payloadProfile: profile,
    promptSha256,
  });
  if (!operationEntry || !noWireParentsVerified || operationEntry.attemptCount !== 1
    || typeof operationEntry.localOperationId !== 'string') {
    return { operation: 'media.video.create', generationMode,
      state: intent.state === 'needs_review' || intent.state === 'accepted' ? 'needs_review' : 'outcome_unknown',
      reconciliationBusinessWritesSent: 0, writeRequestsSent: null, readbackVerified: false,
      reasonCode: 'MEDIA_VIDEO_OPERATION_ENTRY_NOT_UNIQUE' };
  }
  const heldState = hasHttpSuccess ? 'needs_review' : 'outcome_unknown';
  const directCreateRequestsSent = hasHttpSuccess ? 1 : null;
  const unavailableResponseComparatorReason = hasHttpSuccess
    ? 'HTTP success was journaled, but the response body and writer resource IDs were not durably captured'
    : 'No direct writer response resource receipt is available';
  const incomplete = async (reasonCode, extra = {}) => {
    if (hasHttpSuccess && intent.state === 'accepted') {
      await intentJournal.transition(intent.intentId, 'needs_review', {
        httpStatus: operationEntry.httpStatus, reasonCode,
      });
    }
    return { operation: 'media.video.create', generationMode, state: heldState,
      reconciliationBusinessWritesSent: 0, writeRequestsSent: directCreateRequestsSent,
      readbackVerified: false, reasonCode, ...extra };
  };
  const operationTime = Date.parse(operationEntry.createdAt);
  if (!Number.isFinite(operationTime)) throw fail('MEDIA_VIDEO_OPERATION_TIME_INVALID');

  let allAssets;
  let directCandidateAsset;
  if (candidateAssetId !== undefined) {
    try {
      directCandidateAsset = await withBoundedMediaReadRetryAfter(
        () => mediaApi.readAssetMetadata({ assetId: candidateAssetId }), sleepImpl,
      );
    } catch (error) {
      const status = Number.isInteger(error?.details?.status) ? error.details.status : null;
      return incomplete(status === 429 ? 'MEDIA_VIDEO_ASSET_DETAIL_RATE_LIMITED' : 'MEDIA_VIDEO_ASSET_DETAIL_READ_FAILED', {
        ...(status === 429 && Number.isInteger(error?.details?.retryAfterSeconds)
          ? { retryAfterSeconds: error.details.retryAfterSeconds } : {}),
      });
    }
    if (privateAssetData(directCandidateAsset)?.assetId !== candidateAssetId
      || createHash('sha256').update(privateAssetData(directCandidateAsset)?.assetId ?? '', 'utf8').digest('hex')
        !== candidateAssetIdSha256
      || directCandidateAsset.mimeType !== 'video/mp4' || directCandidateAsset.isPublic !== false
      || directCandidateAsset.isModelGenerated !== true) {
      return incomplete('MEDIA_VIDEO_ASSET_DETAIL_BINDING_MISMATCH');
    }
    allAssets = { status: 200, verified: true, assets: [directCandidateAsset] };
  } else {
    try {
      allAssets = await withBoundedMediaReadRetryAfter(
        () => mediaApi.readBackNewAssets({ assetIds: new Set(), complete: true }), sleepImpl,
      );
    } catch (error) {
      const status = Number.isInteger(error?.details?.status) ? error.details.status : null;
      return incomplete(status === 429 ? 'MEDIA_ASSET_LIST_RATE_LIMITED' : 'MEDIA_ASSET_LIST_READ_FAILED', {
        ...(status === 429 && Number.isInteger(error?.details?.retryAfterSeconds)
          ? { retryAfterSeconds: error.details.retryAfterSeconds } : {}),
      });
    }
  }
  if (!allAssets || allAssets.reason === 'MEDIA_ASSET_LIST_INCOMPLETE' || !Array.isArray(allAssets.assets)) {
    return incomplete('MEDIA_ASSET_LIST_INCOMPLETE');
  }
  let expectedReferenceAssetId;
  let referenceImageTaskVerified = null;
  let referenceImageProofSource = null;
  if (generationMode === 'image_reference') {
    let sourceAssets;
    if (candidateAssetId !== undefined && referenceAssetId !== undefined) {
      if (createHash('sha256').update(referenceAssetId, 'utf8').digest('hex') !== referenceAssetIdSha256.toLowerCase()) {
        return incomplete('MEDIA_REFERENCE_ASSET_ID_HASH_MISMATCH');
      }
      try {
        sourceAssets = [await withBoundedMediaReadRetryAfter(
          () => mediaApi.readAssetMetadata({ assetId: referenceAssetId }), sleepImpl,
        )];
      } catch (error) {
        const status = Number.isInteger(error?.details?.status) ? error.details.status : null;
        return incomplete(status === 429 ? 'MEDIA_REFERENCE_ASSET_DETAIL_RATE_LIMITED' : 'MEDIA_REFERENCE_ASSET_DETAIL_READ_FAILED', {
          ...(status === 429 && Number.isInteger(error?.details?.retryAfterSeconds)
            ? { retryAfterSeconds: error.details.retryAfterSeconds } : {}),
        });
      }
    } else {
      sourceAssets = allAssets.assets.filter(asset => {
        const data = privateAssetData(asset);
        const id = data?.assetId;
        return typeof id === 'string' && (referenceAssetId
          ? id === referenceAssetId
          : createHash('sha256').update(id, 'utf8').digest('hex') === referenceAssetIdSha256);
      });
    }
    if (sourceAssets.length !== 1) {
      return incomplete('MEDIA_REFERENCE_ASSET_NOT_UNIQUE');
    }
    if (sourceAssets[0].mimeType !== 'image/jpeg' || sourceAssets[0].isPublic !== false
      || sourceAssets[0].isModelGenerated !== true) return incomplete('MEDIA_REFERENCE_ASSET_NOT_PRIVATE_GENERATED');
    const sourceAssetIdSha256 = createHash('sha256').update(privateAssetData(sourceAssets[0]).assetId, 'utf8').digest('hex');
    if (verifiedReferenceImageProof !== undefined) {
      if (!isVerifiedReferenceImageProof(verifiedReferenceImageProof, {
        ownerIdentityDigest, assetIdSha256: sourceAssetIdSha256, promptSha256: referencePromptSha256,
      })) return incomplete('MEDIA_REFERENCE_PRIOR_READBACK_PROOF_INVALID');
      referenceImageProofSource = 'verified_prior_image_readback';
    } else {
      if (typeof mediaApi.verifyOwnedGeneratedImageReference !== 'function') {
        return incomplete('MEDIA_REFERENCE_VERIFIER_REQUIRED');
      }
      let sourceProof;
      try {
        sourceProof = await withBoundedMediaReadRetryAfter(() => mediaApi.verifyOwnedGeneratedImageReference({
          asset: sourceAssets[0], expectedPromptSha256: referencePromptSha256,
        }), sleepImpl);
      } catch (error) {
        const status = Number.isInteger(error?.details?.status) ? error.details.status : null;
        return incomplete(status === 429 ? 'MEDIA_REFERENCE_HISTORY_RATE_LIMITED' : 'MEDIA_REFERENCE_HISTORY_READ_FAILED', {
          ...(status === 429 && Number.isInteger(error?.details?.retryAfterSeconds)
            ? { retryAfterSeconds: error.details.retryAfterSeconds } : {}),
        });
      }
      if (sourceProof?.verified !== true) return incomplete('MEDIA_REFERENCE_TASK_NOT_VERIFIED');
      referenceImageProofSource = 'current_owner_history_readback';
    }
    expectedReferenceAssetId = privateAssetData(sourceAssets[0]).assetId;
    referenceImageTaskVerified = true;
  }
  const timeCandidates = mediaMatches(allAssets.assets, 'video').filter(asset => {
    const opaque = privateAssetData(asset);
    const created = typeof asset.createTime === 'number'
      ? (asset.createTime > 10_000_000_000 ? asset.createTime : asset.createTime * 1000)
      : Date.parse(asset.createTime);
    return asset.isPublic === false && asset.isModelGenerated === true
      && typeof opaque?.assetId === 'string' && typeof opaque?.sourceConversationId === 'string'
      && typeof opaque?.responseId === 'string' && Number.isFinite(created)
      && created >= operationTime - 5_000 && created <= Date.now() + 5_000;
  });
  const exactCandidates = [];
  for (const asset of timeCandidates) {
    const opaque = privateAssetData(asset);
    let evidence;
    try {
      evidence = await withBoundedMediaReadRetryAfter(() => mediaApi.readConversationEvidence({
        conversationId: opaque.sourceConversationId, expectedPrompt: prompt,
        ...(expectedReferenceAssetId ? { expectedReferenceAssetId } : {}),
      }), sleepImpl);
    } catch (error) {
      const status = Number.isInteger(error?.details?.status) ? error.details.status : null;
      if (status === 429) {
        return incomplete('MEDIA_VIDEO_HISTORY_RATE_LIMITED', {
          ...(Number.isInteger(error?.details?.retryAfterSeconds)
            ? { retryAfterSeconds: error.details.retryAfterSeconds } : {}),
          correlation: {
            verified: false,
            writerResponseIdComparatorAvailable: false,
            writerResponseIdComparatorReason: unavailableResponseComparatorReason,
            operationAttempts: operationEntry.attemptCount,
            promptSha256,
            timeCandidateCount: timeCandidates.length,
            exactPromptResponseLinkedCandidateCount: exactCandidates.length,
            ...(generationMode === 'image_reference' ? { referenceImageTaskVerified, referenceImageProofSource } : {}),
          },
        });
      }
      evidence = null;
    }
    const responseIds = evidence?.[GROK_MEDIA_PRIVATE_RESPONSE_IDS]?.matchingPrompt ?? [];
    if (evidence?.conversationMatch === true && evidence.promptExactMatch === true
      && evidence.uniqueUserPromptCount === 1 && evidence.promptSha256 === promptSha256
      && responseIds.includes(opaque.responseId)
      && (expectedReferenceAssetId === undefined || evidence.referenceAssetMatched === true)) exactCandidates.push(asset);
  }
  if (exactCandidates.length !== 1) {
    return incomplete('MEDIA_VIDEO_EXACT_TASK_NOT_UNIQUE', { correlation: {
        verified: false,
        writerResponseIdComparatorAvailable: false,
        writerResponseIdComparatorReason: unavailableResponseComparatorReason,
        operationAttempts: operationEntry.attemptCount,
        promptSha256,
        timeCandidateCount: timeCandidates.length,
        exactPromptResponseLinkedCandidateCount: exactCandidates.length,
        ...(generationMode === 'image_reference' ? { referenceImageTaskVerified, referenceImageProofSource } : {}),
      } });
  }
  const candidateData = privateAssetData(exactCandidates[0]);
  const currentAssetIds = new Set(allAssets.assets.map(asset => privateAssetData(asset)?.assetId).filter(id => typeof id === 'string'));
  if (currentAssetIds.size !== allAssets.assets.length || !currentAssetIds.delete(candidateData.assetId)) {
    return incomplete('MEDIA_VIDEO_ASSET_SET_UNVERIFIED');
  }
  const snapshot = { assetIds: currentAssetIds, complete: true, capturedAt: operationTime };
  return {
    operation: 'media.video.create',
    generationMode,
    writeRequestsSent: directCreateRequestsSent,
    reconciliationBusinessWritesSent: 0,
    ...await reconcileProvisionalVideoReadback({
      operationJournal,
      operationEntry,
      intentJournal,
      intent,
      mediaApi,
      snapshot,
      verifyAsset,
      prompt,
      ...(expectedReferenceAssetId ? { expectedReferenceAssetId } : {}),
      directResponseResources: emptyDirectResponseResources(),
      ...(candidateAssetId !== undefined ? { directAssets: [exactCandidates[0]] } : {}),
      assetRequestContext,
      expectedOwnerIdentityDigest: ownerIdentityDigest,
      readbackTimeoutMs: 1_000,
      readbackIntervalMs: 250,
      heldState,
      httpStatus: Number.isInteger(operationEntry.httpStatus) ? operationEntry.httpStatus : undefined,
      reconciledBy: candidateAssetId !== undefined ? 'attachment.asset.read' : 'media.assets.list',
      responseDetails: {
        writerResponseIdComparatorAvailable: false,
        writerResponseIdComparatorReason: unavailableResponseComparatorReason,
        reconciliationReadMethod: candidateAssetId !== undefined ? 'attachment.asset.read' : 'media.assets.list',
        ...(generationMode === 'image_reference' ? { referenceImageTaskVerified, referenceImageProofSource } : {}),
      },
    }),
  };
}

function isChallenge(status, contentType, body, headers) {
  if (status !== 403) return null;
  if (String(headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') return 'challenge_header';
  if (!/html/i.test(contentType)) return null;
  const text = body.toString('utf8', 0, Math.min(body.length, 16 * 1024));
  return /(?:challenge-platform|cf-chl-|cf-turnstile|captcha|verify you are human|checking your browser)/i.test(text)
    ? 'challenge_markup'
    : null;
}

export async function submitProvisionalCapturedGrokVideoOnce({
  client,
  sessionPersistence,
  mediaApi,
  operationJournal,
  intentJournal,
  intentId,
  prompt,
  generationMode = 'text',
  referenceAssetId,
  referencePromptSha256,
  confirm = false,
  capturedRequest,
  assetRequestContext,
  fetchImpl = globalThis.fetch,
  verifyAsset,
  readbackTimeoutMs = DEFAULT_READBACK_TIMEOUT_MS,
  readbackIntervalMs = DEFAULT_READBACK_INTERVAL_MS,
  timeoutMs = 30_000,
} = {}) {
  validateRunOptions({ confirm, readbackTimeoutMs, readbackIntervalMs });
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4_000) throw fail('MEDIA_PROMPT_INVALID');
  if (!['text', 'image_reference'].includes(generationMode)
    || (generationMode === 'image_reference' && (typeof referenceAssetId !== 'string' || referenceAssetId.length < 1
      || referenceAssetId.length > 256 || /[\r\n\0]/.test(referenceAssetId)
      || typeof referencePromptSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(referencePromptSha256)))
    || (generationMode === 'text' && (referenceAssetId !== undefined || referencePromptSha256 !== undefined))) {
    throw fail('MEDIA_VIDEO_GENERATION_MODE_INVALID');
  }
  if (typeof fetchImpl !== 'function' || !sessionPersistence || typeof sessionPersistence.read !== 'function'
    || !operationJournal || typeof operationJournal.begin !== 'function' || typeof operationJournal.transition !== 'function'
    || typeof operationJournal.list !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000) {
    throw fail('MEDIA_PROVISIONAL_RUNTIME_REQUIRED');
  }
  await runWithMediaStage('owner_verification', () => assertOwner(client));
  const capture = validateProvisionalVideoCapture(capturedRequest, prompt, intentId,
    generationMode === 'image_reference' ? { referenceAssetId } : {});
  const quota = await runWithMediaStage('video_quota_read', () => mediaApi.getImagineQuota());
  if (quota?.modes?.video?.available !== true) throw fail('MEDIA_QUOTA_UNAVAILABLE');
  const snapshot = await runWithMediaStage('asset_snapshot_read', () => mediaApi.captureAssetSnapshot());
  if (!snapshot?.complete || !(snapshot.assetIds instanceof Set)) throw fail('MEDIA_ASSET_BASELINE_INCOMPLETE');
  if (generationMode === 'image_reference') {
    if (!snapshot.assetIds.has(referenceAssetId) || typeof mediaApi.verifyOwnedGeneratedImageReference !== 'function') {
      throw fail('MEDIA_REFERENCE_ASSET_VERIFIER_REQUIRED');
    }
    const referenceProof = await runWithMediaStage('reference_image_history_read', () => mediaApi.verifyOwnedGeneratedImageReference({
      assetId: referenceAssetId,
      expectedPromptSha256: referencePromptSha256,
      snapshot,
    }));
    if (referenceProof?.verified !== true || referenceProof.asset?.mimeType !== 'image/jpeg'
      || referenceProof.asset?.isPublic !== false || referenceProof.asset?.isModelGenerated !== true) {
      throw fail('MEDIA_REFERENCE_ASSET_NOT_VERIFIED');
    }
  }
  const stored = await runWithMediaStage('session_binding_read', () => sessionPersistence.read());
  const session = stored?.session;
  if (stored?.kind !== 'grok-session' || !session || session.generation !== session.ownerBinding?.generation
    || typeof session.ownerBinding?.identityDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(session.ownerBinding.identityDigest)) {
    throw fail('OWNER_VERIFICATION_REQUIRED');
  }
  await runWithMediaStage('asset_cookie_binding', async () => validateGrokAssetRequestContext(
    'https://assets.grok.com/users/owner/generated/asset.mp4?cache=1',
    assetRequestContext,
    session.ownerBinding.identityDigest,
  ));
  const bound = await runWithMediaStage('session_cookie_binding', async () => boundCredentials(session, GROK_WEB_ORIGIN, VIDEO_CREATE_PATH, { cookieNames: ['sso'], headerNames: [] }));
  if (bound.cookieHeader !== `sso=${assetRequestContext.cookies[0].value}`) throw fail('MEDIA_VIDEO_OWNER_COOKIE_MISMATCH');
  const requestUrl = `${GROK_WEB_ORIGIN}${VIDEO_CREATE_PATH}`;
  const bodyText = capturedRequest.bodyText;
  const requestDigest = createRequestDigest({ method: 'POST', url: requestUrl, body: bodyText });
  const intentDigest = createHash('sha256')
    .update(`media.video.create\n${session.ownerBinding.identityDigest}\n${intentId}`, 'utf8')
    .digest('hex');
  const payloadProfile = generationMode === 'image_reference'
    ? 'video-image-reference-6s-480p-no-audio' : 'video-6s-480p-no-audio';
  const expectedPromptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
  let existingIntent;
  if (typeof intentJournal.get === 'function') {
    try { existingIntent = await runWithMediaStage('caller_intent_read', () => intentJournal.get(intentId)); }
    catch (error) { if (error?.code !== 'MEDIA_INTENT_NOT_FOUND') throw error; }
  }
  let priorOperations = (await operationJournal.list()).filter(entry => entry.contractId === 'media.video.create'
    && entry.intentDigest === intentDigest);
  const proofBindings = {
    ownerIdentityDigest: session.ownerBinding.identityDigest,
    intentIdSha256: createHash('sha256').update(intentId, 'utf8').digest('hex'),
    intentDigest,
    payloadProfile,
    promptSha256: expectedPromptSha256,
  };
  const failedJournalBegin = existingIntent?.state === 'failed' && existingIntent.reasonCode === 'JOURNAL_STATE_INVALID';
  if (existingIntent?.state === 'sending' || (existingIntent?.state === 'prepared' && priorOperations.length > 0)
    || failedJournalBegin) {
    const prior = priorOperations.at(-1);
    if (!prior || priorOperations.some(entry => entry.state !== 'rejected'
      || !isGrokVideoNoWireProof(entry.videoNoWireProof, { ...proofBindings, requestDigest: entry.requestDigest }))) {
      throw fail('MEDIA_INTENT_SENDING_HELD');
    }
    await runWithMediaStage('verified_no_wire_intent_recovery', () => intentJournal.recoverVerifiedNoWire({
      intentId, prompt, payloadProfile, ownerIdentityDigest: session.ownerBinding.identityDigest,
      operationJournal, localOperationId: prior.localOperationId,
      ...(failedJournalBegin ? { preDispatchFailure: {
        stage: 'operation_journal_begin', mainFetchCallCount: 0, requestStarted: false,
        responseReceived: false, errorCode: 'JOURNAL_STATE_INVALID',
      } } : {}),
    }));
    existingIntent = await intentJournal.get(intentId);
  }
  if (priorOperations.length && (existingIntent?.state !== 'prepared' || priorOperations.some(entry => entry.state !== 'rejected'
    || !isGrokVideoNoWireProof(entry.videoNoWireProof, { ...proofBindings, requestDigest: entry.requestDigest })))) {
    throw fail('MEDIA_VIDEO_OPERATION_ALREADY_ATTEMPTED');
  }
  const intent = await runWithMediaStage('caller_intent_transition', () => verifyRunInputs({
    intentJournal, prompt, operation: 'media.video.create',
    profile: payloadProfile, intentId,
    ownerIdentityDigest: session.ownerBinding.identityDigest,
  }));
  let operationEntry;
  try {
    operationEntry = priorOperations.length
      ? await operationJournal.beginVerifiedNoWireVideoRecovery({
        requestDigest, intentDigest, intentId, ownerIdentityDigest: session.ownerBinding.identityDigest,
        payloadProfile, promptSha256: expectedPromptSha256,
      })
      : await operationJournal.begin({ contractId: 'media.video.create', requestDigest, intentDigest });
  } catch (error) {
    const duplicate = typeof error?.code === 'string' && /^OPERATION_ALREADY_/.test(error.code);
    if (duplicate) {
      await intentJournal.transition(intent.intentId, 'outcome_unknown', { reasonCode: 'MEDIA_OPERATION_ALREADY_HELD' }).catch(() => {});
      throw error;
    }
    await intentJournal.transition(intent.intentId, 'failed', {
      reasonCode: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code : 'MEDIA_OPERATION_JOURNAL_FAILED',
    }).catch(() => {});
    throw fail('MEDIA_OPERATION_JOURNAL_FAILED', { stage: 'operation_journal_begin', persistenceErrorCode:
      typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : null,
      mainFetchCallCount: 0, requestStarted: false, responseReceived: false });
  }
  const reconcileReadback = options => reconcileProvisionalVideoReadback({
    ...options,
    prompt,
    ...(generationMode === 'image_reference' ? { expectedReferenceAssetId: referenceAssetId } : {}),
    directResponseResources,
    assetRequestContext,
    expectedOwnerIdentityDigest: session.ownerBinding.identityDigest,
  });

  const requestHeaders = new Headers({ ...capture.ordinaryHeaders, cookie: bound.cookieHeader, ...capture.dynamicHeaders });
  let directResponseResources = emptyDirectResponseResources();
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: bodyText,
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const transportEvidence = safeVideoTransportEvidence(error);
    mergePartialDirectResponseResources(directResponseResources, error?.details?.partialResources);
    const httpStatus = transportEvidence?.responseReceived === true ? transportEvidence.httpStatus : undefined;
    if (transportEvidence?.responseReceived === true && transportEvidence.cfMitigated === true) {
      await operationJournal.transition(operationEntry.localOperationId, 'blocked_security_boundary', {
        ...(Number.isInteger(httpStatus) ? { httpStatus } : {}),
        reasonCode: 'SECURITY_CHALLENGE_HEADER',
      });
      await intentJournal.transition(intent.intentId, 'blocked_security_boundary', {
        ...(Number.isInteger(httpStatus) ? { httpStatus } : {}),
        reasonCode: 'SECURITY_CHALLENGE_BLOCKED',
      });
      return {
        operation: 'media.video.create',
        state: 'blocked_security_boundary',
        writeRequestsSent: 1,
        readbackVerified: false,
        ...(Number.isInteger(httpStatus) ? { httpStatus } : {}),
        transportEvidence,
      };
    }
    if (transportEvidence?.requestStarted === false) {
      const proof = makeVideoNoWireProof(error, {
        ownerIdentityDigest: session.ownerBinding.identityDigest,
        intentId,
        intentDigest,
        requestDigest,
        prompt,
        payloadProfile,
      });
      if (!proof || typeof operationJournal.rejectMediaVideoNoWireAttempt !== 'function'
        || typeof intentJournal.recoverVerifiedNoWire !== 'function') {
        throw fail('MEDIA_VIDEO_NO_WIRE_PROOF_NOT_PERSISTABLE', {
          stage: 'no_wire_proof_persist', requestStarted: false, responseReceived: false,
          helperErrorCode: typeof error?.details?.helperErrorCode === 'string'
            && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.details.helperErrorCode) ? error.details.helperErrorCode : null,
          errorClass: transportEvidence.errorClass,
        });
      }
      try {
        await operationJournal.rejectMediaVideoNoWireAttempt(operationEntry.localOperationId, proof);
      } catch (persistError) {
        throw fail('MEDIA_VIDEO_NO_WIRE_PROOF_PERSIST_FAILED', {
          stage: 'operation_journal_no_wire_proof', requestStarted: false, responseReceived: false,
          helperErrorCode: proof.helperErrorCode, errorClass: proof.errorClass,
          persistenceErrorCode: typeof persistError?.code === 'string'
            && /^[A-Z][A-Z0-9_]{0,63}$/.test(persistError.code) ? persistError.code : null,
        });
      }
      try {
        await intentJournal.recoverVerifiedNoWire({
          intentId, prompt, payloadProfile, ownerIdentityDigest: session.ownerBinding.identityDigest,
          operationJournal, localOperationId: operationEntry.localOperationId,
        });
      } catch (recoveryError) {
        return {
          operation: 'media.video.create', state: 'pre_dispatch_recovery_pending', writeRequestsSent: 0,
          readbackVerified: false, reasonCode: 'MEDIA_VIDEO_NO_WIRE_INTENT_RECOVERY_PENDING',
          noWireProofPersisted: true, intentRecoveryRecorded: false,
          transportEvidence, helperErrorCode: proof.helperErrorCode,
          persistenceErrorCode: typeof recoveryError?.code === 'string'
            && /^[A-Z][A-Z0-9_]{0,63}$/.test(recoveryError.code) ? recoveryError.code : null,
        };
      }
      return {
        operation: 'media.video.create', state: 'pre_dispatch_failed', writeRequestsSent: 0,
        readbackVerified: false, reasonCode: 'MEDIA_VIDEO_CFFI_PREFLIGHT_FAILED',
        noWireProofPersisted: true, intentRecoveryRecorded: true, sameIntentPreparedForRecovery: true,
        transportEvidence, helperErrorCode: proof.helperErrorCode,
      };
    }
    await operationJournal.transition(operationEntry.localOperationId, 'outcome_unknown', {
      ...(Number.isInteger(httpStatus) ? { httpStatus } : {}),
      reasonCode: 'HTTP_TRANSPORT_FAILED',
    });
    return {
      operation: 'media.video.create', writeRequestsSent: transportEvidence?.requestStarted === true ? 1 : null,
      ...await reconcileReadback({
        operationJournal, operationEntry, intentJournal, intent, mediaApi, snapshot, verifyAsset,
        readbackTimeoutMs, readbackIntervalMs, heldState: 'outcome_unknown', httpStatus,
        responseDetails: { reasonCode: 'HTTP_TRANSPORT_FAILED', ...(Number.isInteger(httpStatus) ? { httpStatus } : {}),
          responseBodySha256: error?.details?.responseBodySha256 ?? null,
          ...(transportEvidence ? { transportEvidence } : {}) },
      }),
    };
  }

  const status = response.status;
  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  let body;
  try { body = await readBoundedResponse(response); } catch (error) {
    mergePartialDirectResponseResources(directResponseResources, error?.details?.partialResources);
    const transportEvidence = safeVideoResponseReadEvidence({
      response, error, status, contentType, bodyText, capture,
    });
    if (status === 403 && String(response.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') {
      await operationJournal.transition(operationEntry.localOperationId, 'blocked_security_boundary', {
        httpStatus: status, reasonCode: 'SECURITY_CHALLENGE_HEADER',
      });
      await intentJournal.transition(intent.intentId, 'blocked_security_boundary', {
        httpStatus: status, reasonCode: 'SECURITY_CHALLENGE_BLOCKED',
      });
      return { operation: 'media.video.create', state: 'blocked_security_boundary', writeRequestsSent: 1,
        readbackVerified: false, httpStatus: status,
        responseBodySha256: error?.details?.responseBodySha256 ?? response?.transportEvidence?.responseBodySha256 ?? null,
        ...(transportEvidence ? { transportEvidence } : {}) };
    }
    await operationJournal.transition(operationEntry.localOperationId, 'needs_review', {
      httpStatus: status,
      reasonCode: 'CAPTURED_RESPONSE_SIZE_OR_READ_FAILED',
    });
    return {
      operation: 'media.video.create', writeRequestsSent: 1,
      ...await reconcileReadback({
        operationJournal, operationEntry, intentJournal, intent, mediaApi, snapshot, verifyAsset,
        readbackTimeoutMs, readbackIntervalMs, heldState: 'needs_review', httpStatus: status,
        responseDetails: { httpStatus: status, responseContentType: contentType || null,
          responseBytesRead: error?.details?.responseBytesRead ?? null,
          responseBodySha256: error?.details?.responseBodySha256 ?? response?.transportEvidence?.responseBodySha256 ?? null,
          ...(transportEvidence ? { transportEvidence } : {}),
          reasonCode: 'CAPTURED_RESPONSE_SIZE_OR_READ_FAILED' },
      }),
    };
  }
  const signal = isChallenge(status, contentType, body, response.headers);
  const paymentSignal = paymentOrUpgradeSignal(body);
  const bodyBytes = body.length;
  const responseBodySha256 = createHash('sha256').update(body).digest('hex');
  const successTransportEvidence = safeVideoSuccessEvidence({
    response, status, contentType, responseBytes: bodyBytes, responseBodySha256,
    requestBodyBytes: Buffer.byteLength(bodyText, 'utf8'),
  });
  let parsed;
  if (contentType.includes('json')) {
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
    catch {
      parsed = null;
      mergePartialDirectResponseResources(directResponseResources, extractPartialDirectResponseResources(body));
    }
  }
  const parsedObject = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  if (parsed) directResponseResources = collectSocketCorrelation([parsed], '__direct_video_response_no_request_id__');
  const responseShape = sanitizedResponseShape(parsed);
  parsed = null;
  body.fill(0);

  if (signal) {
    await operationJournal.transition(operationEntry.localOperationId, 'blocked_security_boundary', {
      httpStatus: status,
      reasonCode: signal === 'challenge_header' ? 'SECURITY_CHALLENGE_HEADER' : 'SECURITY_CHALLENGE_MARKUP',
    });
    await intentJournal.transition(intent.intentId, 'blocked_security_boundary', { httpStatus: status, reasonCode: 'SECURITY_CHALLENGE_BLOCKED' });
    return { operation: 'media.video.create', state: 'blocked_security_boundary', writeRequestsSent: 1,
      readbackVerified: false, httpStatus: status, responseContentType: contentType || null,
      responseBytes: bodyBytes, responseBodySha256,
      ...(successTransportEvidence ? { transportEvidence: successTransportEvidence } : {}) };
  }

  if (status < 200 || status > 299) {
    const unresolved = status >= 500 || (status >= 300 && status < 400);
    await operationJournal.transition(operationEntry.localOperationId, unresolved ? 'outcome_unknown' : 'rejected', {
      httpStatus: status,
      reasonCode: paymentSignal ? 'PURCHASE_OR_UPGRADE_SIGNAL' : `HTTP_STATUS_${status}`,
    });
    if (!unresolved) {
      await intentJournal.transition(intent.intentId, 'failed', {
        httpStatus: status,
        reasonCode: paymentSignal ? 'PURCHASE_OR_UPGRADE_SIGNAL' : `HTTP_STATUS_${status}`,
      });
      return { operation: 'media.video.create', state: 'failed', writeRequestsSent: 1, readbackVerified: false,
        httpStatus: status, responseContentType: contentType || null, responseBytes: bodyBytes,
        responseBodySha256, ...(successTransportEvidence ? { transportEvidence: successTransportEvidence } : {}),
        paymentOrUpgradeSignal: paymentSignal };
    }
    return {
      operation: 'media.video.create', writeRequestsSent: 1,
      ...await reconcileReadback({
        operationJournal, operationEntry, intentJournal, intent, mediaApi, snapshot, verifyAsset,
        readbackTimeoutMs, readbackIntervalMs, heldState: 'outcome_unknown', httpStatus: status,
        responseDetails: { responseContentType: contentType || null, responseBytes: bodyBytes, responseBodySha256,
          ...(successTransportEvidence ? { transportEvidence: successTransportEvidence } : {}), paymentOrUpgradeSignal: paymentSignal },
      }),
    };
  }

  await operationJournal.transition(operationEntry.localOperationId, 'needs_review', {
    httpStatus: status,
    reasonCode: paymentSignal ? 'PURCHASE_OR_UPGRADE_SIGNAL' : 'CAPTURED_RESPONSE_SCHEMA_UNKNOWN',
  });
  await intentJournal.transition(intent.intentId, 'accepted', { httpStatus: status });
  if (paymentSignal || !contentType.includes('json') || !parsedObject) {
    const reasonCode = paymentSignal ? 'PURCHASE_OR_UPGRADE_SIGNAL' : 'CAPTURED_RESPONSE_SCHEMA_UNKNOWN';
    if (paymentSignal) {
      await intentJournal.transition(intent.intentId, 'needs_review', { httpStatus: status, reasonCode });
      return {
        operation: 'media.video.create', state: 'needs_review', writeRequestsSent: 1, readbackVerified: false,
        httpStatus: status, responseContentType: contentType || null, responseBytes: bodyBytes, responseBodySha256,
        responseShape, ...(successTransportEvidence ? { transportEvidence: successTransportEvidence } : {}), paymentOrUpgradeSignal: true,
      };
    }
    return {
      operation: 'media.video.create', writeRequestsSent: 1,
      ...await reconcileReadback({
        operationJournal, operationEntry, intentJournal, intent, mediaApi, snapshot, verifyAsset,
        readbackTimeoutMs, readbackIntervalMs, heldState: 'needs_review', httpStatus: status,
        responseDetails: { responseContentType: contentType || null, responseBytes: bodyBytes, responseBodySha256,
          responseShape, ...(successTransportEvidence ? { transportEvidence: successTransportEvidence } : {}) },
      }),
    };
  }

  return {
    operation: 'media.video.create', writeRequestsSent: 1,
    ...await reconcileReadback({
      operationJournal, operationEntry, intentJournal, intent, mediaApi, snapshot, verifyAsset,
      readbackTimeoutMs, readbackIntervalMs, heldState: 'needs_review', httpStatus: status,
      responseDetails: { responseContentType: contentType, responseBytes: bodyBytes, responseBodySha256,
        responseShape, ...(successTransportEvidence ? { transportEvidence: successTransportEvidence } : {}) },
    }),
  };
}

function submitErrorState(error) {
  if (error?.code === 'SECURITY_CHALLENGE_BLOCKED') return 'blocked_security_boundary';
  if (error?.code === 'HTTP_TRANSPORT_FAILED' || error?.code === 'SUBMIT_RESPONSE_UNREADABLE') return 'outcome_unknown';
  return 'failed';
}

async function runWithMediaStage(stage, work) {
  try {
    return await work();
  } catch (error) {
    const existing = error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
      ? error.details : {};
    error.details = { ...existing, stage: typeof existing.stage === 'string' ? existing.stage : stage };
    throw error;
  }
}

async function verifyRunInputs({ intentJournal, prompt, operation, profile, intentId, ownerIdentityDigest }) {
  if (!intentJournal || typeof intentJournal.begin !== 'function' || typeof intentJournal.transition !== 'function') {
    throw fail('MEDIA_INTENT_JOURNAL_REQUIRED');
  }
  if (typeof intentId !== 'string' || !intentId.trim()) throw fail('MEDIA_INTENT_ID_REQUIRED');
  let intent;
  if (typeof intentJournal.get === 'function') {
    try {
      intent = await intentJournal.get(intentId);
    } catch (error) {
      if (error?.code !== 'MEDIA_INTENT_NOT_FOUND') throw error;
    }
  }
  if (intent) {
    if (intent.operation !== operation || intent.state !== 'prepared' || intent.attemptNumber !== 1
      || intent.payloadProfile !== profile || intent.promptLength !== prompt.length) {
      throw fail('MEDIA_INTENT_PREPARED_PROFILE_MISMATCH');
    }
    if (intent.promptSha256 !== createHash('sha256').update(prompt, 'utf8').digest('hex')) {
      throw fail('MEDIA_INTENT_PREPARED_PROMPT_MISMATCH');
    }
    if (typeof ownerIdentityDigest !== 'string' || intent.ownerIdentityDigest !== ownerIdentityDigest) {
      throw fail('MEDIA_INTENT_PREPARED_OWNER_MISMATCH');
    }
  } else {
    intent = await intentJournal.begin({ operation, prompt, payloadProfile: profile, intentId, ownerIdentityDigest });
  }
  await intentJournal.transition(intent.intentId, 'sending');
  return intent;
}

export async function submitGrokImagineVideo({
  client,
  operationJournal,
  mediaApi,
  sessionPersistence,
  intentJournal,
  intentId,
  prompt,
  confirm = false,
  verifyAsset,
  assetRequestContext,
  readbackTimeoutMs = DEFAULT_READBACK_TIMEOUT_MS,
  readbackIntervalMs = DEFAULT_READBACK_INTERVAL_MS,
} = {}) {
  validateRunOptions({ confirm, readbackTimeoutMs, readbackIntervalMs });
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4_000) throw fail('MEDIA_PROMPT_INVALID');
  if (!client || typeof client.submit !== 'function') throw fail('MEDIA_CLIENT_REQUIRED');
  if (!operationJournal || typeof operationJournal.transition !== 'function' || typeof operationJournal.list !== 'function') {
    throw fail('MEDIA_OPERATION_JOURNAL_REQUIRED');
  }
  const snapshot = await preflight({ mediaApi, quotaMode: 'video', client });
  if (!sessionPersistence || typeof sessionPersistence.read !== 'function') throw fail('MEDIA_SESSION_REQUIRED');
  const stored = await sessionPersistence.read();
  const ownerIdentityDigest = stored?.session?.ownerBinding?.identityDigest;
  if (stored?.kind !== 'grok-session' || typeof ownerIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(ownerIdentityDigest)) {
    throw fail('OWNER_VERIFICATION_REQUIRED');
  }
  const intent = await verifyRunInputs({
    intentJournal, prompt, operation: 'media.video.create',
    profile: 'video-6s-480p-no-audio', intentId,
    ownerIdentityDigest,
  });
  const previousIds = new Set((await operationJournal.list()).map(entry => entry.localOperationId));
  let submitted;
  try {
    submitted = await client.submit('media.video.create', { prompt }, { confirm: true, intentId: intent.intentId });
  } catch (error) {
    const journalEntry = await findNewOperationEntry(operationJournal, previousIds, 'media.video.create');
    const state = !journalEntry
      ? 'failed'
      : journalEntry.state === 'blocked_security_boundary'
      ? 'blocked_security_boundary'
      : journalEntry.state === 'outcome_unknown'
        ? 'outcome_unknown'
        : submitErrorState(error);
    if (state === 'outcome_unknown') {
      const readback = await waitForNewMedia({
        mediaApi, snapshot, type: 'video', expectedCount: 1, timeoutMs: readbackTimeoutMs, intervalMs: readbackIntervalMs, verifyAsset,
      });
      if (readback.state === 'completed') {
        const recovered = { localOperationId: journalEntry?.localOperationId };
        await completeOperationJournal(operationJournal, recovered, error?.details?.status);
        await settleIntent(intentJournal, intent, {
          state: 'completed',
          httpStatus: Number.isInteger(error?.details?.status) ? error.details.status : undefined,
          reasonCode: 'MEDIA_ASSET_READBACK_VERIFIED',
          readback: readback.readback,
        });
        return { operation: 'media.video.create', state: 'completed', writeRequestsSent: 1, readbackVerified: true, assets: readback.matchingAssets };
      }
      await settleIntent(intentJournal, intent, {
        state: 'outcome_unknown',
        httpStatus: Number.isInteger(error?.details?.status) ? error.details.status : undefined,
        reasonCode: typeof error?.code === 'string' ? error.code : 'MEDIA_SUBMIT_FAILED',
        readback: readback.readback,
      });
      return { operation: 'media.video.create', state: 'outcome_unknown', writeRequestsSent: journalEntry ? 1 : 0, readbackVerified: false };
    }
    await settleIntent(intentJournal, intent, {
      state,
      httpStatus: Number.isInteger(error?.details?.status) ? error.details.status : undefined,
      reasonCode: typeof error?.code === 'string' ? error.code : 'MEDIA_SUBMIT_FAILED',
    });
    return { operation: 'media.video.create', state, writeRequestsSent: journalEntry ? 1 : 0, readbackVerified: false };
  }
  const httpStatus = Number.isInteger(submitted?.httpStatus) ? submitted.httpStatus : undefined;
  await intentJournal.transition(intent.intentId, 'accepted', { httpStatus });
  const readback = await waitForNewMedia({
    mediaApi, snapshot, type: 'video', expectedCount: 1, timeoutMs: readbackTimeoutMs, intervalMs: readbackIntervalMs, verifyAsset,
  });
  if (readback.state === 'completed') await completeOperationJournal(operationJournal, submitted, httpStatus);
  await settleIntent(intentJournal, intent, {
    state: readback.state,
    httpStatus,
    reasonCode: readback.state === 'completed' ? undefined : 'MEDIA_VIDEO_READBACK_INCOMPLETE',
    readback: readback.readback,
  });
  return {
    operation: 'media.video.create',
    state: readback.state,
    writeRequestsSent: 1,
    readbackVerified: readback.state === 'completed',
    assets: readback.matchingAssets,
    mediaVerifications: readback.readback?.mediaVerifications ?? [],
    clientOperationState: submitted?.state ?? 'unknown',
  };
}

export async function submitGrokImagineImage({
  client,
  operationJournal,
  mediaApi,
  sessionPersistence,
  cookieNames,
  requestMetadataProvider,
  intentJournal,
  intentId,
  prompt,
  capturedFrames,
  confirm = false,
  verifyAsset,
  assetRequestContext,
  readbackTimeoutMs = DEFAULT_READBACK_TIMEOUT_MS,
  readbackIntervalMs = DEFAULT_READBACK_INTERVAL_MS,
  webSocketFactory = openGrokImagineWebSocket,
} = {}) {
  validateRunOptions({ confirm, readbackTimeoutMs, readbackIntervalMs });
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4_000) throw fail('MEDIA_PROMPT_INVALID');
  const frameCaptureKeys = ['frames', 'intentId', 'serverForwarded', 'source'];
  if (!capturedFrames || typeof capturedFrames !== 'object' || Array.isArray(capturedFrames)
    || JSON.stringify(Object.keys(capturedFrames).sort()) !== JSON.stringify(frameCaptureKeys)
    || capturedFrames.intentId !== intentId || capturedFrames.serverForwarded !== false
    || capturedFrames.source !== 'normal_ui_network_capture') throw fail('MEDIA_CAPTURE_NOT_VERIFIED');
  if (!operationJournal || typeof operationJournal.begin !== 'function' || typeof operationJournal.transition !== 'function') {
    throw fail('MEDIA_OPERATION_JOURNAL_REQUIRED');
  }
  const frames = validateCapturedGrokImagineImageFrames(capturedFrames.frames, { prompt });
  const snapshot = await preflight({ mediaApi, quotaMode: 'imagePro', client });
  if (!sessionPersistence || typeof sessionPersistence.read !== 'function') throw fail('MEDIA_SESSION_REQUIRED');
  const preflightSession = await sessionPersistence.read();
  const expectedOwnerIdentityDigest = preflightSession?.session?.ownerBinding?.identityDigest;
  if (preflightSession?.kind !== 'grok-session' || typeof expectedOwnerIdentityDigest !== 'string'
    || !/^[a-f0-9]{64}$/i.test(expectedOwnerIdentityDigest)) throw fail('OWNER_VERIFICATION_REQUIRED');
  validateGrokAssetRequestContext(
    'https://assets.grok.com/users/owner/generated/asset.jpg?cache=1', assetRequestContext, expectedOwnerIdentityDigest,
  );
  if (!intentJournal || typeof intentJournal.begin !== 'function' || typeof intentJournal.transition !== 'function') {
    throw fail('MEDIA_INTENT_JOURNAL_REQUIRED');
  }
  let connection;
  try {
    connection = await webSocketFactory({ sessionPersistence, cookieNames, requestMetadataProvider });
  } catch (error) {
    const state = error?.code === 'SECURITY_CHALLENGE_BLOCKED' ? 'blocked_security_boundary' : 'failed';
    return {
      operation: 'media.image.create',
      transport: 'direct_ws',
      state,
      writeRequestsSent: 0,
      readbackVerified: false,
      reasonCode: typeof error?.code === 'string' ? error.code : 'MEDIA_WS_HANDSHAKE_FAILED',
      ...(Number.isInteger(error?.details?.status) ? { httpStatus: error.details.status } : {}),
    };
  }

  let intent;
  try {
    intent = await verifyRunInputs({
      intentJournal,
      prompt,
      operation: 'media.image.create',
      profile: 'image-quality2-native-batch4',
      intentId,
      ownerIdentityDigest: expectedOwnerIdentityDigest,
    });
  } catch (error) {
    connection.close();
    throw error;
  }

  let operationEntry;
  try {
    const stored = await sessionPersistence.read();
    const session = stored?.session;
    if (stored?.kind !== 'grok-session' || !session || session.generation !== session.ownerBinding?.generation
      || typeof session.ownerBinding?.identityDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(session.ownerBinding.identityDigest)) {
      throw fail('OWNER_VERIFICATION_REQUIRED');
    }
    const bodyText = JSON.stringify(frames);
    const requestDigest = createRequestDigest({ method: 'WS', url: GROK_IMAGINE_WEBSOCKET_URL, body: bodyText });
    const intentDigest = createHash('sha256')
      .update(`media.image.create\n${session.ownerBinding.identityDigest}\n${intentId}`, 'utf8')
      .digest('hex');
    operationEntry = await operationJournal.begin({ contractId: 'media.image.create', requestDigest, intentDigest });
  } catch (error) {
    await intentJournal.transition(intent.intentId, 'failed', {
      reasonCode: typeof error?.code === 'string' ? error.code : 'MEDIA_OPERATION_JOURNAL_FAILED',
    });
    connection.close();
    return { operation: 'media.image.create', transport: 'direct_ws', state: 'failed', writeRequestsSent: 0, readbackVerified: false };
  }

  let writeStarted = false;
  const inputFrame = frames.find(frame => frame?.item?.content?.[0]?.type === 'input_text');
  const requestId = inputFrame.item.content[0].requestId;
  const serverMessages = [];
  let stopMessageReader = false;
  const messageRead = readGrokImagineMessages(connection, {
    maxMessages: 64,
    timeoutMs: Math.min(2_000, readbackTimeoutMs),
    overallTimeoutMs: readbackTimeoutMs,
    maxIdleTimeouts: Math.max(1, Math.ceil(readbackTimeoutMs / Math.min(2_000, readbackTimeoutMs))),
    shouldStop: () => stopMessageReader,
    onMessage: message => serverMessages.push(message),
  }).catch(() => []);
  writeStarted = true;
  let sent;
  try {
    sent = await sendGrokImagineFrames(connection, frames);
  } catch (error) {
    stopMessageReader = true;
    await operationJournal.transition(operationEntry.localOperationId, 'outcome_unknown', {
      reasonCode: typeof error?.code === 'string' ? error.code : 'MEDIA_WS_SUBMIT_FAILED',
    }).catch(() => {});
    await settleIntent(intentJournal, intent, {
      state: 'outcome_unknown',
      reasonCode: typeof error?.code === 'string' ? error.code : 'MEDIA_WS_SUBMIT_FAILED',
    });
    connection.close();
    return { operation: 'media.image.create', transport: 'direct_ws', state: 'outcome_unknown', writeRequestsSent: 1, readbackVerified: false };
  }

  try {
    await operationJournal.transition(operationEntry.localOperationId, 'needs_review', { reasonCode: 'WS_RESPONSE_SCHEMA_UNKNOWN' });
    await intentJournal.transition(intent.intentId, 'accepted');
  } catch {
    await settleIntent(intentJournal, intent, { state: 'outcome_unknown', reasonCode: 'MEDIA_OPERATION_JOURNAL_UPDATE_FAILED' });
    connection.close();
    return { operation: 'media.image.create', transport: 'direct_ws', state: 'outcome_unknown', writeRequestsSent: 1, readbackVerified: false };
  }

  let readback;
  try {
    readback = await waitForNewMedia({
      mediaApi,
      snapshot,
      type: 'image',
      expectedCount: 4,
      timeoutMs: readbackTimeoutMs,
      intervalMs: readbackIntervalMs,
      verifyAsset,
      assetRequestContext,
      expectedOwnerIdentityDigest,
      prompt,
      expectedRequestId: requestId,
      serverMessages,
    });
  } catch {
    readback = {
      state: 'needs_review',
      readback: null,
      matchingAssets: [],
      correlation: { verified: false, reason: 'MEDIA_CORRELATED_READBACK_FAILED' },
    };
  }
  stopMessageReader = true;
  connection.close();
  await messageRead;
  const socketMessages = summarizeGrokImagineMessages(serverMessages);
  serverMessages.length = 0;
  if (readback.state === 'completed') {
    const journalCompleted = await completeOperationJournal(operationJournal, operationEntry, undefined);
    if (!journalCompleted) readback.state = 'needs_review';
  }
  await settleIntent(intentJournal, intent, {
    state: readback.state,
    reasonCode: readback.state === 'completed' ? undefined : 'MEDIA_IMAGE_READBACK_INCOMPLETE',
    readback: readback.readback,
  });
  return {
    operation: 'media.image.create',
    transport: 'direct_ws',
    handshakeStatus: connection.handshakeStatus,
    websocketUrl: GROK_IMAGINE_WEBSOCKET_URL,
    state: readback.state,
    writeRequestsSent: sent.operationFrameSent,
    protocolFramesSent: sent.framesSent,
    readbackVerified: readback.state === 'completed',
    correlation: readback.correlation ?? { verified: false, reason: 'MEDIA_CORRELATED_READBACK_INCOMPLETE' },
    assets: readback.matchingAssets,
    mediaVerifications: readback.readback?.mediaVerifications ?? [],
    socketMessages,
  };
}
