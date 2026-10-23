import { randomUUID } from 'node:crypto';

export const RPC = Object.freeze({
  generateTextVideo: 'YhhmEf',
  getMedia: 'as29s',
  projectMedia: 'Zzl0ze',
});
export const CAPTCHA_SLOT = '__CAPTCHA__';

const DURATION_SECONDS = new Set([4, 6, 8, 10]);
const RESOLUTIONS = new Set(['360p', '720p']);
const VIDEO_ASPECT = Object.freeze({ '9:16': 1, '16:9': 2 });

export class FlowProtocolError extends Error {
  constructor(message, { rpcId, httpStatus, ambiguous = false, rejected = false, serverCode } = {}) {
    super(message);
    this.name = 'FlowProtocolError';
    this.rpcId = rpcId;
    this.httpStatus = httpStatus;
    this.ambiguous = ambiguous;
    this.rejected = rejected;
    this.serverCode = serverCode;
  }
}

export function buildEnvelope(rpcId, payload) {
  if (typeof rpcId !== 'string' || !/^[A-Za-z0-9_-]{2,32}$/.test(rpcId)) {
    throw new TypeError('Invalid Flow RPC id.');
  }
  return JSON.stringify([[[rpcId, JSON.stringify(payload), null, 'generic']]]);
}

export function buildTextVideoSubmission({ prompt, projectId, aspect = '16:9', duration = 4, resolution = '720p' }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('A non-empty prompt is required.');
  if (prompt.length > 20_000) throw new TypeError('Prompt exceeds the local 20,000 character limit.');
  if (typeof projectId !== 'string' || !/^[A-Fa-f0-9-]{16,64}$/.test(projectId)) {
    throw new TypeError('The active Flow project id could not be resolved. Open a Flow project or pass --project-id.');
  }
  if (!Object.hasOwn(VIDEO_ASPECT, aspect)) throw new TypeError('Aspect must be 16:9 or 9:16.');
  if (!DURATION_SECONDS.has(Number(duration))) throw new TypeError('Duration must be 4, 6, 8, or 10 seconds.');
  const normalizedResolution = String(resolution).toLowerCase();
  if (!RESOLUTIONS.has(normalizedResolution)) throw new TypeError('Resolution must be 360p or 720p.');

  let modelKey = 'abra_t2v_' + Number(duration) + 's';
  if (normalizedResolution === '360p') modelKey += '_360p';
  const clientIds = [randomUUID().toUpperCase(), randomUUID().toUpperCase()];
  const request = [
    [null, null, [[[prompt]]]],
    modelKey,
    VIDEO_ASPECT[aspect],
    null,
    [null, null, null, null, ...clientIds],
  ];
  if (normalizedResolution === '360p') request.push(null, null, [4]);

  const context = [null, 22, null, null, null, projectId, null, null, null, null, [CAPTCHA_SLOT, 1]];
  return { freq: buildEnvelope(RPC.generateTextVideo, [[request], context, [randomUUID().toUpperCase(), 2]]), clientIds };
}

export function buildTextVideoRequest(options) {
  return buildTextVideoSubmission(options).freq;
}

export function buildGetMediaRequest(mediaId) {
  if (typeof mediaId !== 'string' || !/^[A-Fa-f0-9-]{16,64}$/.test(mediaId)) {
    throw new TypeError('Invalid media id returned by Flow.');
  }
  return buildEnvelope(RPC.getMedia, [mediaId]);
}

export function buildProjectMediaRequest(projectId) {
  if (typeof projectId !== 'string' || !/^[A-Fa-f0-9-]{16,64}$/.test(projectId)) {
    throw new TypeError('Invalid Flow project id.');
  }
  return buildEnvelope(RPC.projectMedia, [`projects/${projectId}`, null, null, null, [1]]);
}

function jsonEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function parseBatchResponse(text) {
  if (typeof text !== 'string' || !text) return [];
  const sentinelEnd = text.startsWith(")]}'") ? text.indexOf('\n') + 1 : 0;
  const body = sentinelEnd > 0 ? text.slice(sentinelEnd) : text;
  const results = [];
  let index = 0;
  while (index < body.length) {
    const start = body.indexOf('[', index);
    if (start < 0) break;
    const end = jsonEnd(body, start);
    if (end < 0) break;
    index = end;
    let chunk;
    try { chunk = JSON.parse(body.slice(start, end)); } catch { index = start + 1; continue; }
    for (const entry of Array.isArray(chunk) ? chunk : []) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;
      const rpcId = typeof entry[1] === 'string' ? entry[1] : '';
      let data;
      try { data = typeof entry[2] === 'string' ? JSON.parse(entry[2]) : entry[2]; } catch { data = entry[2]; }
      const error = entry[2] == null ? (entry[5] ?? true) : undefined;
      results.push({ rpcId, data, error });
    }
  }
  return results;
}

function serverErrorCode(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string' && /^[A-Z][A-Z0-9_]{2,100}$/.test(item)) return item;
    if (Array.isArray(item)) pending.push(...item);
  }
  return undefined;
}

export function getBatchPayload(text, expectedRpcId, { ambiguousOnMissing = false } = {}) {
  const results = parseBatchResponse(text);
  const result = results.find((entry) => entry.rpcId === expectedRpcId);
  if (!result) throw new FlowProtocolError('Flow response did not contain the expected RPC result.', {
    rpcId: expectedRpcId,
    ambiguous: ambiguousOnMissing,
  });
  if (result.error !== undefined) {
    const serverCode = serverErrorCode(result.error);
    throw new FlowProtocolError('Flow rejected RPC ' + expectedRpcId + (serverCode ? ' (' + serverCode + ')' : '') + '.', {
      rpcId: expectedRpcId,
      rejected: true,
      serverCode,
    });
  }
  return result.data;
}

export function readTextVideoSubmit(payload) {
  const record = payload?.[3]?.[0];
  const mediaId = record?.[0];
  if (typeof mediaId !== 'string' || !/^[A-Fa-f0-9-]{16,64}$/.test(mediaId)) {
    throw new FlowProtocolError('Flow create response had no recognizable media id.', {
      rpcId: RPC.generateTextVideo,
      ambiguous: true,
    });
  }
  return { mediaId, status: typeof record?.[3] === 'string' ? record[3] : undefined };
}

export function findProjectMediaByClientIds(payload, projectId, clientIds) {
  if (!Array.isArray(payload?.[1]) || typeof projectId !== 'string' || !Array.isArray(clientIds) || !clientIds.length) return undefined;
  const ids = new Set(clientIds.filter((id) => typeof id === 'string').map((id) => id.toLowerCase()));
  for (const scene of payload[1]) {
    if (!Array.isArray(scene) || typeof scene[4] !== 'string' || scene[4].toLowerCase() !== projectId.toLowerCase()
        || !Array.isArray(scene[3])) continue;
    const detail = scene[3];
    if (typeof detail[5] !== 'string' || !ids.has(detail[5].toLowerCase())) continue;
    const mediaId = detail[4];
    if (typeof mediaId === 'string' && /^[A-Fa-f0-9-]{16,64}$/.test(mediaId)) return { mediaId };
  }
  return undefined;
}

export function findSignedVideoUrl(payload) {
  const stack = [payload];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string' && item.startsWith('https://')) {
      try {
        const url = new URL(item);
        if (url.hostname === 'flow-content.google' && /^\/video\/[A-Fa-f0-9-]{16,64}$/.test(url.pathname)) return url;
      } catch { /* Ignore malformed server data. */ }
    } else if (Array.isArray(item)) {
      stack.push(...item);
    } else if (item && typeof item === 'object') {
      stack.push(...Object.values(item));
    }
  }
  return undefined;
}
