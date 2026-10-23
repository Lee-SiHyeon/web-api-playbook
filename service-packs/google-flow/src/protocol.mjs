import { randomUUID } from 'node:crypto';

export const RPC = Object.freeze({
  generateTextVideo: 'YhhmEf',
  pollGeneration: 'jwpduf',
  getMedia: 'as29s',
  projectMedia: 'Zzl0ze',
});
export const CAPTCHA_SLOT = '__CAPTCHA__';

const DURATION_SECONDS = new Set([4, 6, 8, 10]);
const RESOLUTIONS = new Set(['360p', '720p']);
const VIDEO_ASPECT = Object.freeze({ '9:16': 1, '16:9': 2 });
// Candidate-only diagnostic shape. The historical Flow response body was not retained,
// so this compact ErrorInfo tuple and its reason allowlist are not capture-verified.
const CANDIDATE_ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';
const CANDIDATE_PUBLIC_ERROR_REASONS = new Set([
  'PUBLIC_ERROR_UNUSUAL_ACTIVITY',
  'PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC',
]);

export function isFlowErrorCandidateReason(value) {
  return CANDIDATE_PUBLIC_ERROR_REASONS.has(value);
}

export class FlowProtocolError extends Error {
  constructor(message, {
    code, rpcId, httpStatus, rpcStatus, ambiguous = false, rejected = false, serverCode, redirectCategory,
    errorMessagePresent, errorInfoPresent, errorInfoCount, errorDomainPresent,
    errorMetadataPresent, errorMetadataCount, errorReasonConflict, errorCandidateReason, errorInfoSchemaVerified,
  } = {}) {
    super(message);
    this.name = 'FlowProtocolError';
    this.code = code;
    this.rpcId = rpcId;
    this.httpStatus = httpStatus;
    this.rpcStatus = rpcStatus;
    this.ambiguous = ambiguous;
    this.rejected = rejected;
    this.serverCode = serverCode;
    this.redirectCategory = redirectCategory;
    this.errorMessagePresent = errorMessagePresent;
    this.errorInfoPresent = errorInfoPresent;
    this.errorInfoCount = errorInfoCount;
    this.errorDomainPresent = errorDomainPresent;
    this.errorMetadataPresent = errorMetadataPresent;
    this.errorMetadataCount = errorMetadataCount;
    this.errorReasonConflict = errorReasonConflict;
    this.errorCandidateReason = errorCandidateReason;
    this.errorInfoSchemaVerified = errorInfoSchemaVerified;
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
  const requestId = randomUUID().toUpperCase();
  return { freq: buildEnvelope(RPC.generateTextVideo, [[request], context, [requestId, 2]]), clientIds, requestId };
}

export function buildTextVideoRequest(options) {
  return buildTextVideoSubmission(options).freq;
}

export function bindCaptchaToken(freq, token) {
  if (typeof token !== 'string' || !token.trim() || token.length > 8_192 || /[\r\n\0]/.test(token)) {
    throw new TypeError('A fresh in-memory Flow generation input is required.');
  }
  let envelope;
  try { envelope = JSON.parse(freq); } catch { throw new TypeError('Invalid Flow generation request.'); }
  const rpc = envelope?.[0]?.[0];
  if (!Array.isArray(envelope) || envelope.length !== 1 || !Array.isArray(envelope[0]) || envelope[0].length !== 1
      || !Array.isArray(rpc) || rpc.length !== 4 || rpc[0] !== RPC.generateTextVideo
      || typeof rpc[1] !== 'string' || rpc[2] !== null || rpc[3] !== 'generic') {
    throw new TypeError('Invalid Flow generation request.');
  }
  let payload;
  try { payload = JSON.parse(rpc[1]); } catch { throw new TypeError('Invalid Flow generation request.'); }
  if (!Array.isArray(payload?.[1]?.[10]) || payload[1][10][0] !== CAPTCHA_SLOT || payload[1][10][1] !== 1) {
    throw new TypeError('Flow generation request has no expected input slot.');
  }
  payload[1][10][0] = token;
  return { freq: buildEnvelope(RPC.generateTextVideo, payload) };
}

/**
 * Build the explicitly selected diagnostic request with the optional input field absent.
 * This never synthesizes or replays an input value. It removes only the observed trailing
 * context field that normally contains the one-time VIDEO_GENERATION input.
 */
export function omitGenerationInput(freq) {
  if (typeof freq !== 'string' || freq.length > 250_000) {
    throw new TypeError('Invalid Flow generation request.');
  }
  let envelope;
  try { envelope = JSON.parse(freq); } catch { throw new TypeError('Invalid Flow generation request.'); }
  const rpc = envelope?.[0]?.[0];
  if (!Array.isArray(envelope) || envelope.length !== 1 || !Array.isArray(envelope[0]) || envelope[0].length !== 1
      || !Array.isArray(rpc) || rpc.length !== 4 || rpc[0] !== RPC.generateTextVideo
      || typeof rpc[1] !== 'string' || rpc[2] !== null || rpc[3] !== 'generic') {
    throw new TypeError('Invalid Flow generation request.');
  }
  let payload;
  try { payload = JSON.parse(rpc[1]); } catch { throw new TypeError('Invalid Flow generation request.'); }
  let markerCount = 0;
  const pending = [payload];
  while (pending.length) {
    const value = pending.pop();
    if (value === CAPTCHA_SLOT) markerCount += 1;
    else if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
  if (!Array.isArray(payload) || payload.length !== 3 || !Array.isArray(payload[1]) || payload[1].length !== 11
      || !Array.isArray(payload[1][10]) || payload[1][10].length !== 2
      || payload[1][10][0] !== CAPTCHA_SLOT || payload[1][10][1] !== 1 || markerCount !== 1) {
    throw new TypeError('Flow generation request has no expected optional input field.');
  }
  payload[1].length = 10;
  return { freq: buildEnvelope(RPC.generateTextVideo, payload) };
}

export function buildGetMediaRequest(mediaId) {
  if (typeof mediaId !== 'string' || !/^[A-Fa-f0-9-]{16,64}$/.test(mediaId)) {
    throw new TypeError('Invalid media id returned by Flow.');
  }
  return buildEnvelope(RPC.getMedia, [mediaId]);
}

export function buildPollGenerationRequest(mediaId) {
  if (typeof mediaId !== 'string' || !/^[A-Fa-f0-9-]{16,64}$/.test(mediaId)) {
    throw new TypeError('Invalid media id returned by Flow.');
  }
  return buildEnvelope(RPC.pollGeneration, [null, null, [[mediaId]]]);
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

function serverErrorDiagnostics(value) {
  const diagnostics = {
    rpcStatus: Array.isArray(value) && Number.isInteger(value[0]) && value[0] >= 0 && value[0] <= 16
      ? value[0] : undefined,
    errorMessagePresent: Array.isArray(value) && typeof value[1] === 'string' && value[1].length > 0,
    errorInfoPresent: false,
    errorInfoCount: 0,
    errorDomainPresent: false,
    errorMetadataPresent: false,
    errorMetadataCount: 0,
    errorReasonConflict: false,
    errorInfoSchemaVerified: undefined,
  };
  const details = Array.isArray(value) && Array.isArray(value[2]) ? value[2] : [];
  const errorInfoDetails = [];
  for (const detail of details) {
    if (Array.isArray(detail) && detail[0] === CANDIDATE_ERROR_INFO_TYPE) errorInfoDetails.push(detail);
  }
  diagnostics.errorInfoCount = errorInfoDetails.length;
  diagnostics.errorInfoPresent = diagnostics.errorInfoCount > 0;
  if (diagnostics.errorInfoPresent) diagnostics.errorInfoSchemaVerified = false;
  diagnostics.errorReasonConflict = errorInfoDetails.length > 1;

  // Only inspect one exact candidate tuple. Multiple details, extra slots, unknown
  // reasons, and cross-schema values remain presence/count diagnostics only. Multiple
  // typed details conflict for selection even if their contents might be identical.
  if (errorInfoDetails.length === 1) {
    const detail = errorInfoDetails[0];
    const info = detail.length === 2 && Array.isArray(detail[1]) ? detail[1] : null;
    const reason = info?.[0];
    const domain = info?.[1];
    const metadata = info?.[2];
    const validInfo = info && info.length >= 1 && info.length <= 3
      && CANDIDATE_PUBLIC_ERROR_REASONS.has(reason)
      && (info.length < 2 || domain === null || typeof domain === 'string')
      && (info.length < 3 || metadata === null || (metadata !== null && typeof metadata === 'object'
        && !Array.isArray(metadata)));
    if (validInfo) {
      diagnostics.errorCandidateReason = reason;
      diagnostics.errorDomainPresent = typeof domain === 'string' && domain.length > 0;
      if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
        diagnostics.errorMetadataPresent = true;
        diagnostics.errorMetadataCount = Math.min(1_000_000, Object.keys(metadata).length);
      }
    }
  }
  return diagnostics;
}

export function getBatchPayload(text, expectedRpcId, { ambiguousOnMissing = false } = {}) {
  const results = parseBatchResponse(text);
  const matchingResults = results.filter((entry) => entry.rpcId === expectedRpcId);
  if (matchingResults.length === 0) throw new FlowProtocolError('Flow response did not contain the expected RPC result.', {
    rpcId: expectedRpcId,
    ambiguous: ambiguousOnMissing,
  });
  if (matchingResults.length > 1) throw new FlowProtocolError('Flow response contained duplicate matching RPC results.', {
    code: 'FLOW_RPC_DUPLICATE_RESULT',
    rpcId: expectedRpcId,
    ambiguous: true,
  });
  const [result] = matchingResults;
  if (result.error !== undefined) {
    const diagnostics = serverErrorDiagnostics(result.error);
    throw new FlowProtocolError('Flow rejected RPC ' + expectedRpcId + '.', {
      rpcId: expectedRpcId,
      rejected: true,
      ...diagnostics,
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

/** @deprecated Flow project scenes do not expose request[4] client IDs for readback. */
export function findProjectMediaByClientIds(payload, projectId, clientIds) {
  // Deprecated: observed Flow project scenes do not persist request[4] client IDs.
  // Keep the export for compatibility, but never infer a match from that unsupported mapping.
  return undefined;
}

/**
 * Reconcile a create using the server request UUID recorded in project scenes.
 * In the observed project-media schema, scene[3][5] equals generation payload[2][0],
 * while scene[3][4] is the media id and scene[4] is the owning project id. Older
 * journals without requestId remain readable but cannot be correlated automatically.
 */
export function findProjectMediaByGenerationRequest(payload, projectId, requestId) {
  if (!Array.isArray(payload?.[1]) || typeof projectId !== 'string'
      || typeof requestId !== 'string' || !/^[A-Fa-f0-9-]{16,64}$/.test(requestId)) return undefined;
  let match;
  for (const scene of payload[1]) {
    if (!Array.isArray(scene) || typeof scene[4] !== 'string' || scene[4].toLowerCase() !== projectId.toLowerCase()
        || !Array.isArray(scene[3])) continue;
    const detail = scene[3];
    const observedId = detail[5];
    if (typeof observedId !== 'string' || observedId.toLowerCase() !== requestId.toLowerCase()) continue;
    const mediaId = detail[4];
    if (typeof mediaId !== 'string' || !/^[A-Fa-f0-9-]{16,64}$/.test(mediaId)) continue;
    if (match && match.mediaId.toLowerCase() !== mediaId.toLowerCase()) return undefined;
    match = { mediaId };
  }
  return match;
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
