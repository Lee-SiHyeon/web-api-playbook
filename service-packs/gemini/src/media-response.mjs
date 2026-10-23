import { parseBatchResponse, collectRpcResponses } from './batch-response.mjs';
import { validateMedia } from './media.mjs';
import { GeminiClientError } from './errors.mjs';

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 64 * 1024 * 1024;
const MAX_WALK_NODES = 50_000;
const MAX_EMBEDDED_JSON_CHARS = 2 * 1024 * 1024;
const MAX_MEDIA_CANDIDATES = 16;
const MEDIA_KEY = /(?:url|uri|download|artifact|media|image|video|source|src|content|data|base64|bytes|buffer|key)/i;
const TASK_KEY = /(?:task|job|generation|request)[_.-]?(?:id|key)?/i;
const STATUS_KEY = /(?:status|error|failure|result|state|code)/i;
const USER_TEXT_KEY = /^(?:text|content|answer|response|message|caption|description)$/i;
const PRIVATE_TEXT_KEY = /(?:thought|reasoning|analysis|internal|system|prompt|instruction|scratchpad)/i;
const RESOURCE_ID_KEY = /^(?:conversation|thread|response|message|task|job|generation|artifact|media)[_.-]?(?:id|key)$/i;

function withInternal(summary, internal) {
  const result = { summary };
  Object.defineProperty(result, 'internal', { value: Object.freeze(internal), enumerable: false });
  return Object.freeze(result);
}

function normalizedMime(value) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeFieldName(value) {
  const key = String(value);
  if (/^\d{1,8}$/.test(key)) return `field_${key}`;
  if (/^[A-Za-z_][A-Za-z0-9_.-]{0,80}$/.test(key)) return key;
  return '{dynamic_field}';
}

function safePath(parts) {
  return parts.slice(0, 24).map((part) => typeof part === 'number' ? part : safeFieldName(part));
}

function typeShape(value, depth = 0) {
  if (depth > 12) return 'depth_limit';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) {
    return Object.freeze({
      type: 'array',
      length: value.length,
      items: Object.freeze(value.slice(0, 32).map((item) => typeShape(item, depth + 1))),
    });
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort().slice(0, 100);
    return Object.freeze({
      type: 'object',
      fieldCount: Object.keys(value).length,
      fields: Object.freeze(Object.fromEntries(keys.map((key) => [safeFieldName(key), typeShape(value[key], depth + 1)]))),
    });
  }
  return 'unsupported';
}

function decodeNestedJson(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_WALK_NODES || depth > 16) return value;
  if (typeof value === 'string') {
    const candidate = value.trimStart();
    if (candidate.length > MAX_EMBEDDED_JSON_CHARS || !['[', '{'].includes(candidate[0])) return value;
    try { return decodeNestedJson(JSON.parse(candidate), state, depth + 1); }
    catch { return value; }
  }
  if (Array.isArray(value)) {
    return value.slice(0, 2_000).map((item) => decodeNestedJson(item, state, depth + 1));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 2_000)
      .map(([key, item]) => [key, decodeNestedJson(item, state, depth + 1)]));
  }
  return value;
}

function countNullSelectorResponses(frames) {
  let count = 0;
  const pending = [...frames];
  let visited = 0;
  while (pending.length && visited < MAX_WALK_NODES) {
    const value = pending.pop();
    visited += 1;
    if (Array.isArray(value)) {
      if (value.length >= 3 && value[0] === 'wrb.fr' && value[1] === null) count += 1;
      for (const item of value) pending.push(item);
    } else if (isPlainObject(value)) {
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  return count;
}

function safeUrlMetadata(value, allowedOrigins, path) {
  let parsed;
  try { parsed = new URL(value); } catch { return { kind: 'invalid_url' }; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    return { kind: 'blocked_url' };
  }
  if (parsed.origin === 'https://www.gstatic.com' && parsed.pathname.startsWith('/images/branding/productlogos/')) {
    return { kind: 'static_placeholder' };
  }
  if (!allowedOrigins.includes(parsed.origin)) return { kind: 'blocked_origin' };
  const pathFamily = parsed.pathname
    .split('/')
    .map((part) => /^(?:[0-9a-f-]{24,}|\d{5,}|[A-Za-z0-9_-]{48,})$/i.test(part) ? '{id}' : part.slice(0, 64))
    .join('/');
  return Object.freeze({
    kind: 'allowlisted_asset_url',
    host: parsed.hostname,
    pathFamily,
    queryKeyNames: [...new Set([...parsed.searchParams.keys()])].sort(),
    fieldPath: safePath(path),
  });
}

function decodeCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > Math.ceil(MAX_CANDIDATE_BYTES * 4 / 3) + 16
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length > MAX_CANDIDATE_BYTES || bytes.toString('base64') !== value) {
      bytes.fill(0);
      return null;
    }
    return bytes;
  } catch {
    return null;
  }
}

function validMediaCandidate(bytes, mime, capability) {
  try {
    return validateMedia(bytes, mime, capability);
  } catch {
    return null;
  }
}

function parseDataUri(value, capability) {
  const match = /^data:(image\/[A-Za-z0-9.+-]+|video\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) return null;
  const bytes = decodeCanonicalBase64(match[2]);
  if (!bytes) return null;
  try {
    const media = validMediaCandidate(bytes, match[1], capability);
    return media ? { mime: media.mime, bytes: bytes.length, body: bytes } : (bytes.fill(0), null);
  } catch (error) {
    bytes.fill(0);
    return null;
  }
}

function byteArrayMedia(value, capability) {
  if (!Array.isArray(value) || value.length < 12 || value.length > MAX_CANDIDATE_BYTES
    || value.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return null;
  const bytes = Buffer.from(value);
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm']) {
    const media = validMediaCandidate(bytes, mime, capability);
    if (media) {
      return { mime: media.mime, bytes: bytes.length, body: bytes };
    }
  }
  bytes.fill(0);
  return null;
}

function inspectFrames(frames, capability, allowedOrigins, expectedIntent) {
  const assetUrlCandidates = [];
  const inlineMediaCandidates = [];
  const internalAssetCandidates = [];
  const internalInlineMediaCandidates = [];
  const internalTextCandidates = [];
  const internalResourceIds = [];
  const blockedAssetUrlCandidateCount = { value: 0 };
  const statusErrorFieldPaths = [];
  const taskIdentifierFieldPaths = [];
  let expectedIntentMatched = false;
  let visited = 0;

  const retainInline = (candidate, path, source) => {
    if (!candidate) return;
    inlineMediaCandidates.push(Object.freeze({
      mime: candidate.mime,
      bytes: candidate.bytes,
      fieldPath: safePath(path),
      source,
    }));
    internalInlineMediaCandidates.push(Object.freeze({
      mime: candidate.mime,
      body: candidate.body,
      fieldPath: safePath(path),
    }));
  };

  const walk = (value, path = [], parentKey = '') => {
    if (visited >= MAX_WALK_NODES || path.length > 24 || assetUrlCandidates.length + inlineMediaCandidates.length >= MAX_MEDIA_CANDIDATES) return;
    visited += 1;

    if (typeof value === 'string') {
      if (expectedIntent && value === expectedIntent) expectedIntentMatched = true;
      if (/^data:/i.test(value)) {
        const media = parseDataUri(value, capability);
        retainInline(media, path, 'data_uri');
        return;
      }
      if (/^https:\/\//i.test(value)) {
        const metadata = safeUrlMetadata(value, allowedOrigins, path);
        if (metadata.kind === 'allowlisted_asset_url') {
          assetUrlCandidates.push(metadata);
          let parsed;
          try { parsed = new URL(value); } catch { parsed = null; }
          if (parsed) internalAssetCandidates.push(Object.freeze({
            url: value,
            origin: parsed.origin,
            fieldPath: safePath(path),
          }));
        }
        else if (metadata.kind === 'blocked_origin' || metadata.kind === 'static_placeholder') blockedAssetUrlCandidateCount.value += 1;
        return;
      }
      if (MEDIA_KEY.test(parentKey)) {
        const bytes = decodeCanonicalBase64(value);
        if (bytes) {
          let found = false;
          try {
            for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm']) {
              const media = validMediaCandidate(bytes, mime, capability);
              if (media) {
                inlineMediaCandidates.push(Object.freeze({ mime: media.mime, bytes: bytes.length, fieldPath: safePath(path), source: 'base64_field' }));
                internalInlineMediaCandidates.push(Object.freeze({ mime: media.mime, body: Buffer.from(bytes), fieldPath: safePath(path) }));
                found = true;
                break;
              }
            }
          } finally { bytes.fill(0); }
          if (found) return;
        }
      }
      const privatePath = path.some((part) => typeof part === 'string' && PRIVATE_TEXT_KEY.test(part));
      if (!privatePath && USER_TEXT_KEY.test(parentKey) && value.trim() && value.length <= 100_000) {
        internalTextCandidates.push(value);
      }
      return;
    }

    if (Array.isArray(value)) {
      if (/(?:bytes|buffer|content|data|payload)/i.test(parentKey)) {
        const candidate = byteArrayMedia(value, capability);
        retainInline(candidate, path, 'byte_array');
      }
      for (let index = 0; index < Math.min(value.length, 2_000); index += 1) walk(value[index], [...path, index], parentKey);
      return;
    }

    if (isPlainObject(value)) {
      for (const [key, item] of Object.entries(value).slice(0, 2_000)) {
        const nextPath = [...path, key];
        if (STATUS_KEY.test(key)) statusErrorFieldPaths.push(safePath(nextPath));
        if (TASK_KEY.test(key) && ((typeof item === 'string' && item.length > 0) || (typeof item === 'number' && Number.isFinite(item)))) {
          taskIdentifierFieldPaths.push(safePath(nextPath));
        }
        if (RESOURCE_ID_KEY.test(key) && (typeof item === 'string' || typeof item === 'number')) {
          internalResourceIds.push(Object.freeze({ kind: safeFieldName(key), value: String(item) }));
        }
        walk(item, nextPath, key);
      }
    }
  };

  const decodedFrames = frames.map((frame) => decodeNestedJson(frame));
  for (let index = 0; index < decodedFrames.length; index += 1) walk(decodedFrames[index], ['frame', index]);
  const rpcIds = [...new Set(collectRpcResponses(decodedFrames).map((item) => item.rpcId))].sort();
  return Object.freeze({
    responseShape: Object.freeze(decodedFrames.slice(0, 10).map((frame) => typeShape(frame))),
    rpcIds: Object.freeze(rpcIds),
    nullSelectorResponseCount: countNullSelectorResponses(decodedFrames),
    allowedAssetUrlCandidateCount: assetUrlCandidates.length,
    blockedAssetUrlCandidateCount: blockedAssetUrlCandidateCount.value,
    assetCandidates: Object.freeze(assetUrlCandidates),
    inlineMediaCandidates: Object.freeze(inlineMediaCandidates),
    mediaMagicMatched: inlineMediaCandidates.length > 0,
    statusErrorFieldPaths: Object.freeze(statusErrorFieldPaths.slice(0, 40)),
    namedTaskIdentifierFieldPaths: Object.freeze(taskIdentifierFieldPaths.slice(0, 40)),
    expectedIntentMatched,
    internal: Object.freeze({
      assetCandidates: Object.freeze(internalAssetCandidates),
      inlineMediaCandidates: Object.freeze(internalInlineMediaCandidates),
      textCandidates: Object.freeze(internalTextCandidates.slice(0, 32)),
      resourceIds: Object.freeze(internalResourceIds.slice(0, 64)),
    }),
  });
}

/**
 * Decode the observed Gemini media response in memory. `internal` contains values required for
 * owner-side readback/download and must never be logged, serialized, or persisted. `summary` is safe
 * to put in a receipt.
 */
export function decodeGeminiMediaResponse(input, {
  capability,
  contentType,
  assetOrigins = [],
  maxBytes = MAX_RESPONSE_BYTES,
  expectedIntent,
} = {}) {
  if (!['image', 'video'].includes(capability) || typeof contentType !== 'string'
    || !Array.isArray(assetOrigins) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES) {
    throw new GeminiClientError('MEDIA_RESPONSE_OPTIONS_INVALID', 'The captured media response inspection options are invalid.');
  }
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (bytes.length > maxBytes) throw new GeminiClientError('MEDIA_RESPONSE_TOO_LARGE', 'The captured media response exceeded its configured size limit.');
  const mime = normalizedMime(contentType);
  const exactOrigins = [...new Set(assetOrigins.filter((origin) => {
    try {
      const parsed = new URL(origin);
      return parsed.protocol === 'https:' && parsed.origin === origin && !parsed.username && !parsed.password;
    } catch { return false; }
  }))];

  const directMedia = validMediaCandidate(bytes, mime, capability);
  if (directMedia) {
    const summary = Object.freeze({
      responseBytes: bytes.length,
      responseMime: mime,
      framing: 'direct_media',
      frameCount: 0,
      responseShape: Object.freeze(['binary']),
      rpcIds: Object.freeze([]),
      nullSelectorResponseCount: 0,
      allowedAssetUrlCandidateCount: 0,
      blockedAssetUrlCandidateCount: 0,
      inlineMediaCandidateCount: 1,
      mediaMagicMatched: true,
      statusErrorFieldPaths: Object.freeze([]),
      namedTaskIdentifierFieldPaths: Object.freeze([]),
    });
    return withInternal(summary, {
        assetCandidates: Object.freeze([]),
        inlineMediaCandidates: Object.freeze([Object.freeze({ mime: directMedia.mime, body: bytes, fieldPath: [] })]),
        textCandidates: Object.freeze([]),
        resourceIds: Object.freeze([]),
    });
  }

  let frames;
  let framing;
  try {
    frames = parseBatchResponse(bytes, {
      maxBytes,
      lengthUnit: 'utf16_code_units',
      frameLengthOverheadUnits: 2,
    });
    const text = bytes.toString('utf8').replace(/^\)\]\}'[\r\n]*/, '').trimStart();
    framing = /^\d+\r?\n/.test(text) ? 'utf16_length_frames' : 'json';
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'MEDIA_RESPONSE_UNCLASSIFIED';
    const summary = Object.freeze({
      responseBytes: bytes.length,
      responseMime: mime,
      framing: 'unclassified',
      parseErrorCode: code,
      frameCount: 0,
      responseShape: Object.freeze([]),
      rpcIds: Object.freeze([]),
      nullSelectorResponseCount: 0,
      allowedAssetUrlCandidateCount: 0,
      blockedAssetUrlCandidateCount: 0,
      inlineMediaCandidateCount: 0,
      mediaMagicMatched: false,
      statusErrorFieldPaths: Object.freeze([]),
      namedTaskIdentifierFieldPaths: Object.freeze([]),
    });
    return withInternal(summary, {
        assetCandidates: Object.freeze([]),
        inlineMediaCandidates: Object.freeze([]),
        textCandidates: Object.freeze([]),
        resourceIds: Object.freeze([]),
    });
  }

  const inspected = inspectFrames(frames, capability, exactOrigins, expectedIntent);
  const { internal, inlineMediaCandidates, ...safeInspection } = inspected;
  const summary = Object.freeze({
    responseBytes: bytes.length,
    responseMime: mime,
    framing,
    frameCount: frames.length,
    ...safeInspection,
    inlineMediaCandidateCount: inlineMediaCandidates.length,
  });
  return withInternal(summary, internal);
}

/** Safe audit-only view; raw values remain available only from decodeGeminiMediaResponse(). */
export function inspectGeminiMediaResponse(input, options = {}) {
  return decodeGeminiMediaResponse(input, options).summary;
}
