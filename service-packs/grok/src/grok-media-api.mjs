import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fail } from './errors.mjs';
import { validateMediaPrefix } from './media.mjs';
import { validateGrokAssetRequestContext } from './grok-media-asset-reader.mjs';

export const GROK_MEDIA_OPERATION_IDS = Object.freeze({
  quota: 'media.imagine.quota',
  references: 'media.references.list',
  searchStatus: 'media.search.status',
  skills: 'media.skills.list',
  assets: 'media.assets.list',
  assetMetadata: 'attachment.asset.read',
  conversation: 'conversation.read',
  responseNodes: 'history.response-nodes',
  loadResponses: 'history.load-responses',
  videoCreate: 'media.video.create',
});

// Opaque identifiers and SDK asset keys are needed for in-process correlation,
// but must stay out of receipts and CLI output.
export const GROK_MEDIA_PRIVATE_ASSET_DATA = Symbol('grok-media-private-asset-data');
export const GROK_MEDIA_PRIVATE_RESPONSE_IDS = Symbol('grok-media-private-response-ids');
export const GROK_MEDIA_PRIVATE_REFERENCE_ASSET_IDS = Symbol('grok-media-private-reference-asset-ids');
export const GROK_MEDIA_PRIVATE_ASSET_SNAPSHOT_DATA = Symbol('grok-media-private-asset-snapshot-data');

export const GROK_IMAGINE_WEBSOCKET_URL = 'wss://grok.com/ws/imagine/listen';
export const GROK_ASSET_SERVER_ORIGIN = 'https://assets.grok.com';
export const GROK_IMAGINE_IMAGE_BATCH = 4;
export const GROK_IMAGINE_VIDEO_DEFAULTS = Object.freeze({
  aspectRatio: '2:3',
  duration: 6,
  resolutionName: '480p',
  skipAudio: true,
});

const MAX_PROMPT_LENGTH = 4_000;
const DEFAULT_MAX_ASSET_PAGES = 20;
const ASSET_VERIFIER_BRIDGE_ENV = 'GROK_MEDIA_ASSET_VERIFIER_URL';

function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH
    || /\0/.test(prompt)) throw fail('MEDIA_PROMPT_INVALID');
  return prompt;
}

function assertClient(client) {
  if (!client || typeof client.read !== 'function') throw fail('MEDIA_CLIENT_REQUIRED');
}

function objectOrFail(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(code);
  return value;
}

function arrayOrFail(value, code) {
  if (!Array.isArray(value)) throw fail(code);
  return value;
}

function safeLabel(value) {
  if (typeof value !== 'string') return undefined;
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url-redacted]')
    .replace(/\b((?:token|signature|secret|api[_-]?key))=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9_-]{80,}/g, '[opaque]')
    .slice(0, 240);
}

function sanitizeReference(reference) {
  const assets = Array.isArray(reference?.assets) ? reference.assets : [];
  return {
    ...(typeof reference?.name === 'string' ? { name: safeLabel(reference.name) } : {}),
    ...(typeof reference?.kind === 'string' ? { kind: reference.kind } : {}),
    ...(typeof reference?.description === 'string' ? { description: safeLabel(reference.description) } : {}),
    ...(typeof reference?.isOwner === 'boolean' ? { isOwner: reference.isOwner } : {}),
    assets: assets.map(asset => ({
      ...(typeof asset?.mimeType === 'string' ? { mimeType: asset.mimeType } : {}),
    })),
  };
}

function sanitizeAsset(asset) {
  const fields = [
    'mimeType', 'name', 'sizeBytes', 'createTime', 'lastUseTime', 'updateTime', 'fileSource',
    'isDeleted', 'isModelGenerated', 'isLatest', 'inlineStatus', 'isPublic', 'width', 'height', 'rRated',
  ];
  const result = {};
  for (const field of fields) {
    const value = asset?.[field];
    if (field === 'name' && typeof value === 'string') result[field] = safeLabel(value);
    else if (['string', 'number', 'boolean'].includes(typeof value)) result[field] = value;
  }
  return result;
}

function operationAsset(asset) {
  const result = sanitizeAsset(asset);
  Object.defineProperty(result, GROK_MEDIA_PRIVATE_ASSET_DATA, {
    enumerable: false,
    value: Object.freeze({
      assetId: typeof asset?.assetId === 'string' ? asset.assetId : null,
      responseId: typeof asset?.responseId === 'string' ? asset.responseId : null,
      sourceConversationId: typeof asset?.sourceConversationId === 'string' ? asset.sourceConversationId : null,
      rootAssetSourceConversationId: typeof asset?.rootAssetSourceConversationId === 'string' ? asset.rootAssetSourceConversationId : null,
      key: typeof asset?.key === 'string' ? asset.key : null,
      ownerUserId: typeof asset?.ownerUserId === 'string' ? asset.ownerUserId : null,
      mediaGenInput: asset?.mediaGenInput && typeof asset.mediaGenInput === 'object' ? asset.mediaGenInput : null,
    }),
  });
  return result;
}

function mediaInputAssetIds(value) {
  const ids = new Set();
  const seen = new Set();
  const add = candidate => {
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 256) ids.add(candidate);
  };
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node.slice(0, 512)) visit(child, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(node).slice(0, 512)) {
      if (key === 'mediaGenInput' && child && typeof child === 'object' && !Array.isArray(child)) {
        for (const mode of ['imageToVideo', 'referenceToVideo']) {
          const input = child[mode];
          if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
          if (Array.isArray(input.inputAssets)) for (const id of input.inputAssets.slice(0, 64)) add(id);
          add(input.firstFrameAsset);
          add(input.lastFrameAsset);
          if (Array.isArray(input.keyframes)) {
            for (const frame of input.keyframes.slice(0, 64)) add(frame?.asset);
          }
        }
      }
      visit(child, depth + 1);
    }
  };
  visit(value);
  return ids;
}

function validateConversationId(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 128
    || !/^[A-Za-z0-9._~-]+$/.test(value)) throw fail('MEDIA_CONVERSATION_ID_INVALID');
  return value;
}

function responseSenderIsUser(value) {
  return typeof value === 'string' && ['user', 'human', 'client'].includes(value.toLowerCase());
}

export function buildGrokAssetUrl(assetKey, assetServerUrl = `${GROK_ASSET_SERVER_ORIGIN}/`) {
  if (typeof assetServerUrl !== 'string' || typeof assetKey !== 'string' || !assetKey || assetKey.length > 8192
    || /[\r\n\0\\]/.test(assetKey)) throw fail('MEDIA_ASSET_URL_INVALID');
  let base;
  try { base = new URL(assetServerUrl); } catch { throw fail('MEDIA_ASSET_URL_INVALID'); }
  if (base.origin !== GROK_ASSET_SERVER_ORIGIN || base.protocol !== 'https:' || base.username || base.password
    || base.search || base.hash) throw fail('MEDIA_ASSET_ORIGIN_SCOPE');
  let result;
  if (/^https?:/i.test(assetKey)) {
    try { result = new URL(assetKey); } catch { throw fail('MEDIA_ASSET_URL_INVALID'); }
    if (result.origin !== GROK_ASSET_SERVER_ORIGIN || result.protocol !== 'https:' || result.username || result.password
      || result.hash) throw fail('MEDIA_ASSET_ORIGIN_SCOPE');
  } else if (/^(?:data:|blob:|\/\/)/i.test(assetKey) || /[?#]/.test(assetKey)) {
    throw fail('MEDIA_ASSET_URL_INVALID');
  } else {
    result = new URL(assetServerUrl);
    result.pathname = assetKey;
  }
  if (!result.pathname.startsWith('/users/') || !result.pathname.includes('/generated/')) throw fail('MEDIA_ASSET_PATH_SCOPE');
  if (result.search) throw fail('MEDIA_ASSET_URL_QUERY_SCOPE');
  result.searchParams.set('cache', '1');
  return result;
}

function validateAssetVerifierBridgeUrl(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n\0]/.test(value)) throw fail('MEDIA_ASSET_BRIDGE_URL_INVALID');
  let url;
  try { url = new URL(value); } catch { throw fail('MEDIA_ASSET_BRIDGE_URL_INVALID'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/verify' || url.search || url.hash) {
    throw fail('MEDIA_ASSET_BRIDGE_URL_INVALID');
  }
  return url;
}

async function verifyWithObservedBrowserAssetRead(assetUrl, expectedMime, bridgeUrl, fetchImpl, timeoutMs) {
  const endpoint = validateAssetVerifierBridgeUrl(bridgeUrl);
  if (typeof fetchImpl !== 'function') throw fail('MEDIA_ASSET_TRANSPORT_FAILED');
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ assetUrl: assetUrl.href, mimeType: expectedMime }),
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw fail('MEDIA_ASSET_BRIDGE_FAILED');
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (response.status !== 200 || contentType !== 'application/json') {
    await response.body?.cancel().catch(() => {});
    throw fail('MEDIA_ASSET_BRIDGE_RESPONSE_INVALID');
  }
  const bodyText = await response.text().catch(() => '');
  if (bodyText.length < 1 || bodyText.length > 4_096) throw fail('MEDIA_ASSET_BRIDGE_RESPONSE_INVALID');
  let value;
  try { value = JSON.parse(bodyText); } catch { throw fail('MEDIA_ASSET_BRIDGE_RESPONSE_INVALID'); }
  const expectedKeys = ['assetHttpStatus', 'bodyBytes', 'magicVerified', 'mimeType', 'source'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
    || ![200, 206].includes(value.assetHttpStatus) || value.mimeType !== expectedMime
    || !Number.isSafeInteger(value.bodyBytes) || value.bodyBytes < 1
    || value.magicVerified !== true || value.source !== 'curl_cffi_chrome150') {
    throw fail('MEDIA_ASSET_BRIDGE_READBACK_INCOMPLETE', {
      status: Number.isInteger(value?.assetHttpStatus) ? value.assetHttpStatus : null,
      contentType: typeof value?.mimeType === 'string' ? value.mimeType : null,
    });
  }
  return { status: value.assetHttpStatus, mimeType: value.mimeType, bodyBytes: value.bodyBytes, magicVerified: true };
}

function validateAssetOutputTarget(outputRoot, outputName) {
  if (outputRoot === undefined && outputName === undefined) return null;
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot) || /[\r\n\0]/.test(outputRoot)
    || typeof outputName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(outputName)) {
    throw fail('MEDIA_ASSET_OUTPUT_TARGET_INVALID');
  }
  const root = path.resolve(outputRoot);
  const artifactsRoot = path.resolve(homedir(), 'artifacts');
  if (root !== artifactsRoot && !root.startsWith(`${artifactsRoot}${path.sep}`)) throw fail('MEDIA_ASSET_OUTPUT_SCOPE');
  return { root, file: path.resolve(root, outputName), outputName };
}

async function verifySavedAssetFile({ target, expectedMime, expectedBytes, expectedSha256, maxBytes }) {
  if (!target || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw fail('MEDIA_ASSET_OUTPUT_READBACK_INVALID');
  }
  let info;
  try { info = await lstat(target.file); } catch { throw fail('MEDIA_ASSET_OUTPUT_MISSING'); }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes || info.size !== expectedBytes) {
    throw fail('MEDIA_ASSET_OUTPUT_READBACK_INVALID');
  }
  let resolved;
  try { resolved = await realpath(target.file); } catch { throw fail('MEDIA_ASSET_OUTPUT_READBACK_INVALID'); }
  if (resolved !== target.file || path.dirname(resolved) !== target.root) throw fail('MEDIA_ASSET_OUTPUT_SCOPE');
  const hash = createHash('sha256');
  const prefix = Buffer.alloc(64);
  let prefixLength = 0;
  let total = 0;
  try {
    for await (const chunkValue of createReadStream(resolved)) {
      const chunk = Buffer.from(chunkValue);
      total += chunk.length;
      if (total > maxBytes) throw fail('MEDIA_ASSET_SIZE_LIMIT');
      hash.update(chunk);
      if (prefixLength < prefix.length) {
        const count = Math.min(prefix.length - prefixLength, chunk.length);
        chunk.copy(prefix, prefixLength, 0, count);
        prefixLength += count;
      }
    }
    if (total !== expectedBytes) throw fail('MEDIA_ASSET_OUTPUT_READBACK_INVALID');
    const media = validateMediaPrefix(prefix.subarray(0, prefixLength), expectedMime);
    const sha256 = hash.digest('hex');
    if (sha256 !== expectedSha256) throw fail('MEDIA_ASSET_OUTPUT_HASH_MISMATCH');
    return { artifactPath: resolved, bodyBytes: total, sha256, mimeType: media.mimeType, magicVerified: true };
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('MEDIA_')) throw error;
    throw fail('MEDIA_ASSET_OUTPUT_READBACK_FAILED');
  } finally {
    prefix.fill(0);
  }
}

export async function verifyGrokAssetBytes(asset, {
  fetchImpl = globalThis.fetch,
  assetServerUrl = `${GROK_ASSET_SERVER_ORIGIN}/`,
  assetVerificationBridgeUrl = process.env[ASSET_VERIFIER_BRIDGE_ENV],
  assetReader,
  assetRequestContext,
  expectedOwnerIdentityDigest,
  outputRoot,
  outputName,
  maxBytes = 256 * 1024 * 1024,
  timeoutMs = 60_000,
} = {}) {
  if (!asset || typeof asset !== 'object' || (assetReader === undefined && typeof fetchImpl !== 'function')
    || !Number.isInteger(maxBytes) || maxBytes < 64 || maxBytes > 1024 * 1024 * 1024
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10 * 60_000) throw fail('MEDIA_OPTIONS_INVALID');
  const privateAsset = asset[GROK_MEDIA_PRIVATE_ASSET_DATA];
  const assetKey = typeof asset.key === 'string' ? asset.key : privateAsset?.key;
  const url = buildGrokAssetUrl(assetKey, assetServerUrl);
  const expectedType = String(asset.mimeType ?? '').toLowerCase();
  const aliases = new Map([['image/jpg', 'image/jpeg']]);
  const normalizedExpectedType = aliases.get(expectedType) ?? expectedType;
  if (assetReader !== undefined) {
    if (typeof assetReader !== 'function') throw fail('MEDIA_ASSET_READER_INVALID');
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'].includes(normalizedExpectedType)) {
      throw fail('MEDIA_TYPE_UNSUPPORTED');
    }
    validateGrokAssetRequestContext(url.href, assetRequestContext, expectedOwnerIdentityDigest);
    const outputTarget = validateAssetOutputTarget(outputRoot, outputName);
    let result;
    try {
      result = await assetReader({
        assetUrl: url.href,
        mimeType: normalizedExpectedType,
        assetRequestContext,
        expectedOwnerIdentityDigest,
        ...(outputTarget ? { outputRoot: outputTarget.root, outputName: outputTarget.outputName } : {}),
        maxBytes,
        timeoutMs,
      });
    } catch {
      throw fail('MEDIA_ASSET_READER_FAILED');
    }
    const contentType = String(result?.mimeType ?? '').toLowerCase();
    if (![200, 206].includes(result?.status)) {
      throw fail('MEDIA_ASSET_STATUS_UNEXPECTED', {
        status: Number.isInteger(result?.status) ? result.status : null,
        contentType: contentType || null,
      });
    }
    if (contentType !== normalizedExpectedType) throw fail('MEDIA_ASSET_TYPE_MISMATCH', { status: result.status, contentType: contentType || null });
    if (!Number.isSafeInteger(result.bodyBytes) || result.bodyBytes < 1 || result.bodyBytes > maxBytes) throw fail('MEDIA_ASSET_SIZE_LIMIT');
    if (result.magicVerified !== true || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(result.sha256)) {
      throw fail('MEDIA_MAGIC_CHECK_FAILED');
    }
    const disk = outputTarget ? await verifySavedAssetFile({
      target: outputTarget,
      expectedMime: normalizedExpectedType,
      expectedBytes: result.bodyBytes,
      expectedSha256: result.sha256,
      maxBytes,
    }) : null;
    return {
      status: result.status,
      mimeType: normalizedExpectedType,
      bodyBytes: result.bodyBytes,
      magicVerified: true,
      sha256: result.sha256.toLowerCase(),
      source: result.source ?? 'curl_cffi-0.16.3-chrome150',
      cookiesUsed: result.cookiesUsed === true,
      cookieNamesUsed: Array.isArray(result.cookieNamesUsed) ? result.cookieNamesUsed : [],
      headersSubmittedNames: Array.isArray(result.headersSubmittedNames) ? result.headersSubmittedNames : [],
      ...(disk ? { artifactPath: disk.artifactPath, diskSha256: disk.sha256, diskBodyBytes: disk.bodyBytes } : {}),
    };
  }
  if (assetRequestContext !== undefined || outputRoot !== undefined || outputName !== undefined) {
    throw fail('MEDIA_ASSET_READER_REQUIRED');
  }
  if (assetVerificationBridgeUrl !== undefined) {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'].includes(normalizedExpectedType)) {
      throw fail('MEDIA_TYPE_UNSUPPORTED');
    }
    const result = await verifyWithObservedBrowserAssetRead(url, normalizedExpectedType, assetVerificationBridgeUrl, fetchImpl, timeoutMs);
    if (result.bodyBytes > maxBytes) throw fail('MEDIA_ASSET_SIZE_LIMIT');
    return result;
  }
  const response = await fetchImpl(url, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => { throw fail('MEDIA_ASSET_TRANSPORT_FAILED'); });
  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (![200, 206].includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    throw fail('MEDIA_ASSET_STATUS_UNEXPECTED', { status: response.status, contentType: contentType || null });
  }
  if (normalizedExpectedType !== contentType) {
    await response.body?.cancel().catch(() => {});
    throw fail('MEDIA_ASSET_TYPE_MISMATCH', { status: response.status, contentType: contentType || null });
  }
  if (response.status === 206) {
    const range = response.headers.get('content-range') ?? '';
    const match = /^bytes 0-(\d+)\/(\d+)$/i.exec(range);
    if (!match || Number(match[1]) + 1 !== Number(match[2])) {
      await response.body?.cancel().catch(() => {});
      throw fail('MEDIA_ASSET_PARTIAL');
    }
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 1 || length > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw fail('MEDIA_ASSET_SIZE_LIMIT');
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw fail('MEDIA_ASSET_BODY_MISSING');
  let total = 0;
  const hash = createHash('sha256');
  let prefix = Buffer.alloc(64);
  let prefixLength = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) throw fail('MEDIA_ASSET_SIZE_LIMIT');
      hash.update(chunk);
      if (prefixLength < prefix.length) {
        const count = Math.min(prefix.length - prefixLength, chunk.length);
        chunk.copy(prefix, prefixLength, 0, count);
        prefixLength += count;
      }
    }
    if (total < 1) throw fail('MEDIA_ASSET_EMPTY');
    const media = validateMediaPrefix(prefix.subarray(0, prefixLength), contentType);
    return { status: response.status, mimeType: media.mimeType, bodyBytes: total, magicVerified: true, sha256: hash.digest('hex'),
      width: media.width ?? null, height: media.height ?? null };
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (typeof error?.code === 'string' && error.code.startsWith('MEDIA_')) throw error;
    throw fail('MEDIA_ASSET_READ_FAILED');
  } finally {
    prefix.fill(0);
  }
}

function readData(result, operationId) {
  if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 299) {
    throw fail('MEDIA_READ_STATUS_INVALID', { operationId });
  }
  return objectOrFail(result.data, 'MEDIA_READ_JSON_INVALID');
}

function validatePageLimit(maxPages) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) throw fail('MEDIA_PAGE_LIMIT_INVALID');
  return maxPages;
}

async function readAssetPages(client, maxPages) {
  const pages = [];
  const assetIds = new Set();
  const cursorValues = new Set();
  let pageToken;
  let complete = false;
  let status = 200;
  for (let index = 0; index < maxPages; index++) {
    const input = pageToken ? { pageToken } : {};
    const result = await client.read(GROK_MEDIA_OPERATION_IDS.assets, input);
    const data = readData(result, GROK_MEDIA_OPERATION_IDS.assets);
    status = result.status;
    const assets = arrayOrFail(data.assets, 'MEDIA_ASSET_LIST_INVALID');
    for (const asset of assets) {
      if (typeof asset?.assetId === 'string' && asset.assetId) assetIds.add(asset.assetId);
    }
    pages.push(assets);
    if (typeof data.nextPageToken !== 'string' || !data.nextPageToken) {
      complete = true;
      pageToken = undefined;
      break;
    }
    if (data.nextPageToken.length > 8_192 || /[\r\n\0]/.test(data.nextPageToken)
      || cursorValues.has(data.nextPageToken)) throw fail('MEDIA_ASSET_CURSOR_INVALID');
    cursorValues.add(data.nextPageToken);
    pageToken = data.nextPageToken;
  }
  return { pages, assetIds, complete, nextPageAvailable: Boolean(pageToken), pageCount: pages.length, status };
}

export function buildGrokImagineImageFrames({ prompt, now = Date.now, requestId = randomUUID } = {}) {
  const text = validatePrompt(prompt);
  if (typeof now !== 'function' || typeof requestId !== 'function') throw fail('MEDIA_FRAME_PRODUCER_INVALID');
  const timestamp = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw fail('MEDIA_FRAME_TIMESTAMP_INVALID');
    return value;
  };
  const requestKey = requestId();
  if (typeof requestKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(requestKey)) {
    throw fail('MEDIA_FRAME_REQUEST_ID_INVALID');
  }
  return [{
    type: 'conversation.item.create',
    timestamp: timestamp(),
    item: {
      type: 'message',
      content: [{
        requestId: requestKey,
        text,
        type: 'input_text',
        properties: {
          section_count: 0,
          is_kids_mode: false,
          enable_nsfw: true,
          skip_upsampler: false,
          enable_side_by_side: true,
          is_initial: false,
          aspect_ratio: '2:3',
          enable_pro: true,
          num_generations: GROK_IMAGINE_IMAGE_BATCH,
          enable_watermark: false,
        },
      }],
    },
  }];
}

export function validateCapturedGrokImagineImageFrames(frames, { prompt, now = Date.now } = {}) {
  const text = validatePrompt(prompt);
  if (!Array.isArray(frames) || ![1, 2].includes(frames.length) || typeof now !== 'function') throw fail('MEDIA_CAPTURE_FRAME_INVALID');
  const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
  const topFields = ['item', 'timestamp', 'type'];
  const created = frames.length === 2 ? frames[0] : null;
  const submitted = frames.at(-1);
  const isRecentTimestamp = value => Number.isSafeInteger(value) && value > 0
    && now() - value <= 120_000 && value - now() <= 30_000;
  if (created && (!exactKeys(created, topFields) || created.type !== 'conversation.item.create' || !isRecentTimestamp(created.timestamp)
    || !exactKeys(created.item, ['content', 'type']) || created.item.type !== 'message'
    || !Array.isArray(created.item.content) || created.item.content.length !== 1
    || !exactKeys(created.item.content[0], ['type']) || created.item.content[0].type !== 'reset')) {
    throw fail('MEDIA_CAPTURE_FRAME_INVALID');
  }
  if (!exactKeys(submitted, topFields) || submitted.type !== 'conversation.item.create' || !isRecentTimestamp(submitted.timestamp)
    || !exactKeys(submitted.item, ['content', 'type']) || submitted.item.type !== 'message'
    || !Array.isArray(submitted.item.content) || submitted.item.content.length !== 1) {
    throw fail('MEDIA_CAPTURE_FRAME_INVALID');
  }
  const content = submitted.item.content[0];
  const propertyNames = [
    'section_count', 'is_kids_mode', 'enable_nsfw', 'skip_upsampler', 'enable_side_by_side',
    'is_initial', 'aspect_ratio', 'enable_pro', 'num_generations', 'enable_watermark',
  ];
  if (!exactKeys(content, ['properties', 'requestId', 'text', 'type'])
    || content.type !== 'input_text' || content.text !== text
    || typeof content.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(content.requestId)
    || !exactKeys(content.properties, propertyNames)) throw fail('MEDIA_CAPTURE_FRAME_INVALID');
  const properties = content.properties;
  if (properties.section_count !== 0 || properties.is_kids_mode !== false || properties.enable_nsfw !== true
    || properties.skip_upsampler !== false || properties.enable_side_by_side !== true || properties.is_initial !== false
    || properties.aspect_ratio !== '2:3' || properties.enable_pro !== true
    || properties.num_generations !== GROK_IMAGINE_IMAGE_BATCH || properties.enable_watermark !== false) {
    throw fail('MEDIA_CAPTURE_PROFILE_INVALID');
  }
  return frames;
}

export function buildGrokImagineVideoCreateBody({ prompt } = {}) {
  const text = validatePrompt(prompt);
  return {
    modelName: 'imagine-video-gen',
    message: `${text} --mode=custom`,
    enableImageStreaming: true,
    enableSideBySide: true,
    sendFinalMetadata: true,
    responseMetadata: { experiments: [], modelConfigOverride: { modelMap: {} } },
    mediaGenInput: {
      textToVideo: {
        aspectRatio: GROK_IMAGINE_VIDEO_DEFAULTS.aspectRatio,
        duration: GROK_IMAGINE_VIDEO_DEFAULTS.duration,
        prompt: text,
        resolutionName: GROK_IMAGINE_VIDEO_DEFAULTS.resolutionName,
        skipAudio: GROK_IMAGINE_VIDEO_DEFAULTS.skipAudio,
      },
    },
    kind: 'CONVERSATION_KIND_IMAGINE',
  };
}

export function createGrokMediaApi({ client, assetReader, assetServerUrl = `${GROK_ASSET_SERVER_ORIGIN}/` } = {}) {
  assertClient(client);
  if (assetReader !== undefined && typeof assetReader !== 'function') throw fail('MEDIA_ASSET_READER_INVALID');
  if (typeof assetServerUrl !== 'string' || !assetServerUrl.trim()) throw fail('MEDIA_ASSET_SERVER_URL_INVALID');

  return Object.freeze({
    async getImagineQuota() {
      const result = await client.read(GROK_MEDIA_OPERATION_IDS.quota, {});
      const data = readData(result, GROK_MEDIA_OPERATION_IDS.quota);
      const modes = {};
      for (const name of ['image', 'imagePro', 'imageEdit', 'video', 'video720p']) {
        const value = objectOrFail(data[name], 'MEDIA_QUOTA_SHAPE_INVALID');
        if (typeof value.available !== 'boolean' || !Number.isInteger(value.windowSizeSeconds)) {
          throw fail('MEDIA_QUOTA_SHAPE_INVALID');
        }
        modes[name] = { available: value.available, windowSizeSeconds: value.windowSizeSeconds };
      }
      return { status: result.status, modes, remainingCountExposed: false };
    },

    async listReferences() {
      const result = await client.read(GROK_MEDIA_OPERATION_IDS.references, {});
      const data = readData(result, GROK_MEDIA_OPERATION_IDS.references);
      const references = arrayOrFail(data.references, 'MEDIA_REFERENCE_LIST_INVALID');
      return { status: result.status, count: references.length, references: references.map(sanitizeReference) };
    },

    async getSearchStatus() {
      const result = await client.read(GROK_MEDIA_OPERATION_IDS.searchStatus, {});
      const data = readData(result, GROK_MEDIA_OPERATION_IDS.searchStatus);
      if (typeof data.status !== 'string' || !Number.isInteger(data.itemCount)) throw fail('MEDIA_SEARCH_STATUS_INVALID');
      return { status: result.status, searchStatus: data.status, itemCount: data.itemCount };
    },

    async listSkills() {
      const result = await client.read(GROK_MEDIA_OPERATION_IDS.skills, {});
      const data = readData(result, GROK_MEDIA_OPERATION_IDS.skills);
      const skills = arrayOrFail(data.skills, 'MEDIA_SKILLS_LIST_INVALID');
      return {
        status: result.status,
        count: skills.length,
        skills: skills.map(skill => ({
          ...(typeof skill?.name === 'string' ? { name: skill.name } : {}),
          ...(typeof skill?.displayName === 'string' ? { displayName: skill.displayName } : {}),
          ...(typeof skill?.description === 'string' ? { description: skill.description } : {}),
        })),
      };
    },

    async listAssets({ maxPages = DEFAULT_MAX_ASSET_PAGES } = {}) {
      const limit = validatePageLimit(maxPages);
      const pageResult = await readAssetPages(client, limit);
      const assets = pageResult.pages.flat().map(operationAsset);
      return {
        status: pageResult.status,
        assets,
        pageCount: pageResult.pageCount,
        complete: pageResult.complete,
        nextPageAvailable: pageResult.nextPageAvailable,
      };
    },

    async readAssetMetadata({ assetId } = {}) {
      if (typeof assetId !== 'string' || assetId.length < 16 || assetId.length > 512 || /[\r\n\0]/.test(assetId)) {
        throw fail('MEDIA_ASSET_ID_INVALID');
      }
      const result = await client.read(GROK_MEDIA_OPERATION_IDS.assetMetadata, { assetId }, {
        sourceDiscoveryPermit: `first-read:${GROK_MEDIA_OPERATION_IDS.assetMetadata}`,
      });
      const data = readData(result, GROK_MEDIA_OPERATION_IDS.assetMetadata);
      const raw = data.asset && typeof data.asset === 'object' && !Array.isArray(data.asset) ? data.asset : data;
      if (raw.assetId !== assetId) throw fail('MEDIA_ASSET_DETAIL_ID_MISMATCH');
      return operationAsset(raw);
    },

    async verifyExactAssets({ assets, verifyAsset } = {}) {
      if (!Array.isArray(assets) || assets.length < 1 || assets.length > 10
        || assets.some(asset => !asset?.[GROK_MEDIA_PRIVATE_ASSET_DATA]
          || typeof asset[GROK_MEDIA_PRIVATE_ASSET_DATA]?.assetId !== 'string')
        || new Set(assets.map(asset => asset[GROK_MEDIA_PRIVATE_ASSET_DATA]?.assetId)).size !== assets.length
        || typeof verifyAsset !== 'function') {
        throw fail('MEDIA_ASSET_CORRELATION_INVALID');
      }
      const mediaVerifications = [];
      for (const asset of assets) {
        let result;
        try { result = await verifyAsset(asset); }
        catch (error) {
          const details = error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
            ? error.details : {};
          const failureCode = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
            ? error.code : null;
          const causeCode = typeof details.failureCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(details.failureCode)
            ? details.failureCode : null;
          throw fail('MEDIA_MAGIC_CHECK_FAILED', {
            ...(failureCode ? { failureCode } : {}), ...(causeCode ? { causeCode } : {}),
            ...(Number.isInteger(details.status) && details.status >= 100 && details.status <= 599
              ? { status: details.status } : {}),
            ...(typeof details.contentType === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(details.contentType)
              ? { contentType: details.contentType.toLowerCase() } : {}),
          });
        }
        if (!result || typeof result.mimeType !== 'string' || !Number.isInteger(result.bodyBytes)
          || result.bodyBytes < 1 || result.magicVerified !== true
          || result.mimeType.toLowerCase() !== String(asset.mimeType ?? '').toLowerCase()) {
          throw fail('MEDIA_MAGIC_CHECK_FAILED');
        }
        mediaVerifications.push({
          ...(Number.isInteger(result.status) ? { httpStatus: result.status } : {}),
          mimeType: result.mimeType,
          bodyBytes: result.bodyBytes,
          magicVerified: true,
          ...(typeof result.durationSeconds === 'number' && Number.isFinite(result.durationSeconds)
            && result.durationSeconds > 0 && result.durationSeconds <= 86_400
            ? { durationSeconds: Math.round(result.durationSeconds * 1000) / 1000 } : {}),
          ...(typeof result.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(result.sha256) ? { sha256: result.sha256.toLowerCase() } : {}),
          ...(typeof result.artifactPath === 'string' ? { artifactPath: result.artifactPath } : {}),
        });
      }
      return { status: 200, verified: true, assets, mediaVerifications };
    },

    async captureAssetSnapshot({ maxPages = DEFAULT_MAX_ASSET_PAGES } = {}) {
      const pageResult = await readAssetPages(client, validatePageLimit(maxPages));
      const snapshot = {
        status: pageResult.status,
        capturedAt: Date.now(),
        pageCount: pageResult.pageCount,
        complete: pageResult.complete,
        nextPageAvailable: pageResult.nextPageAvailable,
        assetIds: new Set(pageResult.assetIds),
      };
      Object.defineProperty(snapshot, GROK_MEDIA_PRIVATE_ASSET_SNAPSHOT_DATA, {
        enumerable: false,
        value: Object.freeze(pageResult.pages.flat()),
      });
      return Object.freeze(snapshot);
    },

    async readBackNewAssets(snapshot, { maxPages = DEFAULT_MAX_ASSET_PAGES, verifyAsset, assetIds } = {}) {
      if (!snapshot || !(snapshot.assetIds instanceof Set) || typeof snapshot.complete !== 'boolean') {
        throw fail('MEDIA_ASSET_SNAPSHOT_INVALID');
      }
      if (verifyAsset !== undefined && typeof verifyAsset !== 'function') throw fail('MEDIA_MAGIC_VERIFIER_INVALID');
      if (assetIds !== undefined && (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 500
        || assetIds.some(value => typeof value !== 'string' || !value || value.length > 256)
        || new Set(assetIds).size !== assetIds.length)) throw fail('MEDIA_ASSET_CORRELATION_INVALID');
      const pageResult = await readAssetPages(client, validatePageLimit(maxPages));
      if (!snapshot.complete || !pageResult.complete) {
        return { status: pageResult.status, verified: false, reason: 'MEDIA_ASSET_LIST_INCOMPLETE', assets: [] };
      }
      const rawNewAssets = pageResult.pages.flat()
        .filter(asset => typeof asset?.assetId === 'string' && !snapshot.assetIds.has(asset.assetId));
      const selectedAssets = assetIds === undefined
        ? rawNewAssets
        : rawNewAssets.filter(asset => assetIds.includes(asset.assetId));
      const newAssets = selectedAssets.map(operationAsset);
      if (assetIds !== undefined && selectedAssets.length !== assetIds.length) {
        return {
          status: pageResult.status,
          verified: false,
          reason: 'MEDIA_CORRELATED_ASSET_NOT_OBSERVED',
          assets: newAssets,
        };
      }
      const mediaVerifications = [];
      if (verifyAsset) {
        for (const asset of selectedAssets) {
          let result;
          try { result = await verifyAsset(asset); }
          catch (error) {
            const details = error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
              ? error.details : {};
            const failureCode = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
              ? error.code : null;
            const causeCode = typeof details.failureCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(details.failureCode)
              ? details.failureCode : null;
            throw fail('MEDIA_MAGIC_CHECK_FAILED', {
              ...(failureCode ? { failureCode } : {}),
              ...(causeCode ? { causeCode } : {}),
              ...(Number.isInteger(details.status) && details.status >= 100 && details.status <= 599
                ? { status: details.status } : {}),
              ...(typeof details.contentType === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(details.contentType)
                ? { contentType: details.contentType.toLowerCase() } : {}),
            });
          }
          if (!result || typeof result.mimeType !== 'string' || !Number.isInteger(result.bodyBytes)
            || result.bodyBytes < 1 || result.magicVerified !== true
            || result.mimeType.toLowerCase() !== String(asset.mimeType ?? '').toLowerCase()) {
            throw fail('MEDIA_MAGIC_CHECK_FAILED');
          }
          mediaVerifications.push({
            ...(Number.isInteger(result.status) ? { httpStatus: result.status } : {}),
            mimeType: result.mimeType,
            bodyBytes: result.bodyBytes,
            magicVerified: true,
            ...(typeof result.durationSeconds === 'number' && Number.isFinite(result.durationSeconds)
              && result.durationSeconds > 0 && result.durationSeconds <= 86_400
              ? { durationSeconds: Math.round(result.durationSeconds * 1000) / 1000 } : {}),
            ...(typeof result.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(result.sha256) ? { sha256: result.sha256.toLowerCase() } : {}),
            ...(typeof result.artifactPath === 'string' ? { artifactPath: result.artifactPath } : {}),
          });
        }
      }
      return {
        status: pageResult.status,
        verified: newAssets.length > 0,
        reason: newAssets.length ? null : 'NEW_MEDIA_NOT_OBSERVED',
        assets: newAssets,
        ...(verifyAsset ? { mediaVerifications } : {}),
      };
    },

    async readConversationEvidence({ conversationId, expectedPrompt, expectedPromptSha256, expectedReferenceAssetId } = {}) {
      const id = validateConversationId(conversationId);
      if (expectedPrompt !== undefined && (typeof expectedPrompt !== 'string' || !expectedPrompt.trim()
        || expectedPrompt.length > MAX_PROMPT_LENGTH || /\0/.test(expectedPrompt))) {
        throw fail('MEDIA_PROMPT_INVALID');
      }
      if (expectedPromptSha256 !== undefined && (typeof expectedPromptSha256 !== 'string'
        || !/^[a-f0-9]{64}$/i.test(expectedPromptSha256))) throw fail('MEDIA_PROMPT_HASH_INVALID');
      if (expectedPrompt !== undefined && expectedPromptSha256 !== undefined
        && createHash('sha256').update(expectedPrompt, 'utf8').digest('hex') !== expectedPromptSha256.toLowerCase()) {
        throw fail('MEDIA_PROMPT_BINDING_MISMATCH');
      }
      if (expectedReferenceAssetId !== undefined && (typeof expectedReferenceAssetId !== 'string'
        || expectedReferenceAssetId.length < 1 || expectedReferenceAssetId.length > 256
        || /[\r\n\0]/.test(expectedReferenceAssetId))) throw fail('MEDIA_ASSET_CORRELATION_INVALID');

      const readHistory = async (stage, operationId, input) => {
        try { return await client.read(operationId, input); }
        catch (error) {
          const details = error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
            ? error.details : {};
          error.details = { ...details, stage: `history_${stage}` };
          throw error;
        }
      };

      const detailResult = await readHistory('conversation_detail', GROK_MEDIA_OPERATION_IDS.conversation, { conversationId: id });
      const detailData = readData(detailResult, GROK_MEDIA_OPERATION_IDS.conversation);
      const conversation = objectOrFail(detailData.conversation, 'MEDIA_CONVERSATION_SHAPE_INVALID');
      const conversationMatch = conversation.conversationId === id;

      const nodesResult = await readHistory('response_nodes', GROK_MEDIA_OPERATION_IDS.responseNodes, { conversationId: id });
      const nodesData = readData(nodesResult, GROK_MEDIA_OPERATION_IDS.responseNodes);
      const nodes = arrayOrFail(nodesData.responseNodes, 'MEDIA_RESPONSE_NODES_INVALID');
      const responseIds = [...new Set(nodes
        .map(node => node?.responseId)
        .filter(value => typeof value === 'string' && value.length > 0 && value.length <= 256))];

      let responses = [];
      let loadStatus = null;
      if (responseIds.length > 0) {
        const loadedResult = await readHistory('load_responses', GROK_MEDIA_OPERATION_IDS.loadResponses, {
          conversationId: id,
          responseIds,
        });
        const loadedData = readData(loadedResult, GROK_MEDIA_OPERATION_IDS.loadResponses);
        responses = arrayOrFail(loadedData.responses, 'MEDIA_LOADED_RESPONSES_INVALID');
        loadStatus = loadedResult.status;
      }

      const conversationPrompt = typeof conversation.prompt === 'string' && conversation.prompt.length <= MAX_PROMPT_LENGTH
        ? conversation.prompt
        : null;
      const userMessages = responses.flatMap((response, responseIndex) => responseSenderIsUser(response?.sender)
        && typeof response?.message === 'string' && response.message.length <= MAX_PROMPT_LENGTH
        ? [{ responseIndex, responseId: typeof response.responseId === 'string' ? response.responseId : null, text: response.message }]
        : []);
      const candidatePrompts = [
        ...(conversationPrompt !== null ? [{ source: 'conversation.prompt', text: conversationPrompt, responseId: null }] : []),
        ...userMessages.map(item => ({ source: 'history.user_message', text: item.text, responseId: item.responseId })),
      ];
      const uniqueTexts = [...new Set(candidatePrompts.map(item => item.text))];
      const uniqueUserPromptCount = new Set(userMessages.map(item => item.text)).size;
      const expectedPromptHash = expectedPromptSha256?.toLowerCase()
        ?? (expectedPrompt === undefined ? null : createHash('sha256').update(expectedPrompt, 'utf8').digest('hex'));
      const canonicalPromptMatchesExpected = conversationPrompt !== null && expectedPromptHash !== null
        && createHash('sha256').update(conversationPrompt, 'utf8').digest('hex') === expectedPromptHash;
      const nativeModeSuffix = ' --mode=custom';
      const matchingUserMessages = expectedPrompt === undefined && expectedPromptHash === null
        ? userMessages
        : userMessages.filter(item => {
          if (expectedPrompt !== undefined) return item.text === expectedPrompt || item.text === `${expectedPrompt}${nativeModeSuffix}`;
          const exactHash = createHash('sha256').update(item.text, 'utf8').digest('hex') === expectedPromptHash;
          const suffixHash = item.text.endsWith(nativeModeSuffix)
            && createHash('sha256').update(item.text.slice(0, -nativeModeSuffix.length), 'utf8').digest('hex') === expectedPromptHash;
          return exactHash || suffixHash;
        });
      const matchingUserPromptCount = matchingUserMessages.length;
      const nestedConversationPromptSha256 = conversationPrompt === null
        ? null
        : createHash('sha256').update(conversationPrompt, 'utf8').digest('hex');
      const exactPromptMatches = expectedPromptHash === null
        ? uniqueTexts.length === 1
        : matchingUserPromptCount === 1 && uniqueUserPromptCount === 1
          && (canonicalPromptMatchesExpected || expectedPrompt !== undefined
            || expectedPromptSha256 !== undefined);
      const promptToHash = exactPromptMatches
        ? expectedPrompt ?? (canonicalPromptMatchesExpected
          ? conversationPrompt
          : matchingUserMessages[0]?.text.endsWith(nativeModeSuffix)
            ? matchingUserMessages[0].text.slice(0, -nativeModeSuffix.length)
            : matchingUserMessages[0]?.text ?? (uniqueTexts.length === 1 ? uniqueTexts[0] : null))
        : null;
      const promptSha256 = promptToHash === null
        ? null
        : createHash('sha256').update(promptToHash, 'utf8').digest('hex');
      const matchedUserMessageForm = matchingUserPromptCount === 1
        ? ((expectedPrompt !== undefined && matchingUserMessages[0].text === `${expectedPrompt}${nativeModeSuffix}`)
          || (expectedPrompt === undefined && matchingUserMessages[0].text.endsWith(nativeModeSuffix)))
          ? 'native_custom_mode_suffix' : 'exact_prompt'
        : null;
      const matchingPromptIndexes = expectedPromptHash === null
        ? (uniqueTexts.length === 1 ? userMessages.map(item => item.responseIndex) : [])
        : matchingUserPromptCount === 1 && uniqueUserPromptCount === 1
          ? matchingUserMessages.map(item => item.responseIndex) : [];
      const matchingResponseIds = new Set();
      const matchingResponseIndexes = new Set();
      for (const index of matchingPromptIndexes) {
        for (let next = index; next < responses.length; next++) {
          if (next > index && responseSenderIsUser(responses[next]?.sender)) break;
          matchingResponseIndexes.add(next);
          const responseId = responses[next]?.responseId;
          if (typeof responseId === 'string' && responseId.length > 0 && responseId.length <= 256) matchingResponseIds.add(responseId);
        }
      }
      if (conversationPrompt !== null && (expectedPromptHash === null
        ? conversationPrompt === promptToHash : canonicalPromptMatchesExpected)) {
        for (const response of responses) {
          if (typeof response?.responseId === 'string' && response.responseId.length > 0 && response.responseId.length <= 256) {
            matchingResponseIds.add(response.responseId);
          }
        }
      }
      const referenceAssetIds = new Set();
      for (const responseIndex of matchingResponseIndexes) {
        for (const assetId of mediaInputAssetIds(responses[responseIndex])) referenceAssetIds.add(assetId);
      }
      const evidence = {
        detailStatus: detailResult.status,
        responseNodesStatus: nodesResult.status,
        loadResponsesStatus: loadStatus,
        conversationMatch,
        nestedConversationPromptPresent: conversationPrompt !== null,
        nestedConversationPromptSha256,
        nestedConversationPromptMatchesHistory: conversationPrompt !== null && userMessages.some(item =>
          item.text === conversationPrompt || item.text === `${conversationPrompt} --mode=custom`),
        nestedConversationPromptMatchesExpected: expectedPromptHash === null
          ? conversationPrompt !== null && conversationPrompt === promptToHash
          : canonicalPromptMatchesExpected,
        promptExactMatch: exactPromptMatches,
        promptSha256,
        matchedUserMessageForm,
        promptSource: conversationPrompt !== null && (expectedPromptHash === null
          ? conversationPrompt === promptToHash : canonicalPromptMatchesExpected)
          ? 'conversation.prompt'
          : matchingUserPromptCount === 1 ? 'history.user_message' : null,
        userMessageCount: userMessages.length,
        uniqueUserPromptCount,
        matchingUserPromptCount,
        responseCount: responses.length,
        responseIdCount: responseIds.length,
        responseIdSha256: responseIds.map(value => createHash('sha256').update(value, 'utf8').digest('hex')),
        matchingPromptResponseIdCount: matchingResponseIds.size,
        referenceAssetCount: referenceAssetIds.size,
        ...(expectedReferenceAssetId !== undefined ? { referenceAssetMatched: referenceAssetIds.has(expectedReferenceAssetId) } : {}),
      };
      Object.defineProperty(evidence, GROK_MEDIA_PRIVATE_RESPONSE_IDS, {
        enumerable: false,
        value: Object.freeze({
          all: Object.freeze(responseIds),
          matchingPrompt: Object.freeze([...matchingResponseIds]),
        }),
      });
      Object.defineProperty(evidence, GROK_MEDIA_PRIVATE_REFERENCE_ASSET_IDS, {
        enumerable: false,
        value: Object.freeze([...referenceAssetIds]),
      });
      return evidence;
    },

    async verifyOwnedGeneratedImageReference({ assetId, asset: suppliedAsset, expectedPromptSha256, snapshot } = {}) {
      if ((suppliedAsset === undefined && (typeof assetId !== 'string' || assetId.length < 1 || assetId.length > 256 || /[\r\n\0]/.test(assetId)))
        || (suppliedAsset !== undefined && (!suppliedAsset || typeof suppliedAsset !== 'object' || Array.isArray(suppliedAsset)
          || !suppliedAsset[GROK_MEDIA_PRIVATE_ASSET_DATA]))
        || typeof expectedPromptSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedPromptSha256)) {
        throw fail('MEDIA_ASSET_CORRELATION_INVALID');
      }
      let opaque;
      if (suppliedAsset !== undefined) {
        opaque = suppliedAsset;
      } else {
        let rawAssets;
        if (snapshot !== undefined) {
          const snapshotAssets = snapshot?.[GROK_MEDIA_PRIVATE_ASSET_SNAPSHOT_DATA];
          if (!snapshot || snapshot.complete !== true || !(snapshot.assetIds instanceof Set)
            || !snapshot.assetIds.has(assetId) || !Array.isArray(snapshotAssets)) {
            return { verified: false, reason: 'MEDIA_ASSET_SNAPSHOT_INVALID' };
          }
          rawAssets = snapshotAssets;
        } else {
          const pageResult = await readAssetPages(client, DEFAULT_MAX_ASSET_PAGES);
          if (!pageResult.complete) return { verified: false, reason: 'MEDIA_ASSET_LIST_INCOMPLETE' };
          rawAssets = pageResult.pages.flat();
        }
        const matches = rawAssets.filter(asset => asset?.assetId === assetId);
        if (matches.length !== 1) return { verified: false, reason: 'MEDIA_REFERENCE_ASSET_NOT_UNIQUE' };
        opaque = operationAsset(matches[0]);
      }
      const privateData = opaque[GROK_MEDIA_PRIVATE_ASSET_DATA];
      if (!String(opaque.mimeType ?? '').toLowerCase().startsWith('image/') || opaque.isPublic !== false
        || opaque.isModelGenerated !== true || typeof privateData?.assetId !== 'string'
        || typeof privateData?.responseId !== 'string'
        || typeof privateData?.sourceConversationId !== 'string') {
        return { verified: false, reason: 'MEDIA_REFERENCE_ASSET_NOT_PRIVATE_GENERATED' };
      }
      const evidence = await this.readConversationEvidence({ conversationId: privateData.sourceConversationId,
        expectedPromptSha256 });
      const responseIds = evidence[GROK_MEDIA_PRIVATE_RESPONSE_IDS]?.all ?? [];
      const proof = {
        verified: evidence.conversationMatch === true && evidence.promptExactMatch === true
          && evidence.uniqueUserPromptCount === 1 && evidence.promptSha256?.toLowerCase() === expectedPromptSha256.toLowerCase()
          && responseIds.includes(privateData.responseId),
        mimeType: opaque.mimeType,
        isPublic: opaque.isPublic,
        isModelGenerated: opaque.isModelGenerated,
        conversationMatch: evidence.conversationMatch === true,
        promptExactMatch: evidence.promptExactMatch === true,
        uniqueUserPromptCount: evidence.uniqueUserPromptCount,
        promptSha256: evidence.promptSha256,
        sourceResponseInHistory: responseIds.includes(privateData.responseId),
      };
      return proof.verified ? { ...proof, asset: opaque } : { ...proof, reason: 'MEDIA_REFERENCE_TASK_HISTORY_MISMATCH' };
    },

    verifyAssetBytes(asset, options = {}) {
      return verifyGrokAssetBytes(asset, { assetServerUrl: options.assetServerUrl ?? assetServerUrl,
        ...options, ...(assetReader ? { assetReader } : {}) });
    },

    async downloadAssetToFile(asset, options = {}) {
      if (typeof options.outputRoot !== 'string' || typeof options.outputName !== 'string') {
        throw fail('MEDIA_ASSET_OUTPUT_TARGET_INVALID');
      }
      const target = validateAssetOutputTarget(options.outputRoot, options.outputName);
      await mkdir(target.root, { recursive: true, mode: 0o700 }).catch(() => { throw fail('MEDIA_ASSET_OUTPUT_SCOPE'); });
      await chmod(target.root, 0o700).catch(() => { throw fail('MEDIA_ASSET_OUTPUT_SCOPE'); });
      return verifyGrokAssetBytes(asset, { assetServerUrl: options.assetServerUrl ?? assetServerUrl,
        ...options, ...(assetReader ? { assetReader } : {}) });
    },

    buildImageFrames: buildGrokImagineImageFrames,
    buildVideoCreateBody: buildGrokImagineVideoCreateBody,
  });
}
