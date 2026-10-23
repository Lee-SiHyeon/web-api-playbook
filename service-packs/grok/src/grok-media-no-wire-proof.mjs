import { createHash } from 'node:crypto';

const VIDEO_PROFILE = /^video-(?:6s-480p-no-audio|image-reference-6s-480p-no-audio)$/;
const STAGES = new Set(['validation', 'dependency', 'session_setup']);
const REQUEST_HEADERS = new Set([
  'accept', 'content-type', 'origin', 'referer', 'user-agent', 'sec-ch-ua', 'sec-ch-ua-mobile',
  'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'x-statsig-id', 'x-xai-request-id',
]);
const RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'cf-mitigated', 'retry-after']);
const PROOF_KEYS = Object.freeze([
  'schemaVersion', 'operation', 'ownerIdentityDigest', 'intentIdSha256', 'intentDigest', 'requestDigest',
  'payloadProfile', 'promptSha256', 'stage', 'requestStarted', 'responseReceived', 'httpStatus', 'contentType',
  'httpVersion', 'responseBytesRead', 'requestBodyBytes', 'cfMitigated', 'errorClass', 'helperErrorCode',
  'requestHeaderNames', 'responseHeaderNames', 'cookieNamesUsed', 'source',
]);
const RECOVERY_KEYS = Object.freeze([
  'schemaVersion', 'priorOperationIdSha256', 'priorRequestDigest', 'priorProofDigest', 'ownerIdentityDigest', 'intentIdSha256',
  'payloadProfile', 'promptSha256',
]);
const SHA256 = /^[a-f0-9]{64}$/;
const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const HELPER_ERROR = /^[A-Z][A-Z0-9_]{0,63}$/;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function safeNameArray(value, allowed, { empty = false } = {}) {
  return Array.isArray(value) && value.length <= 32
    && (empty ? value.length === 0 : true)
    && value.every(name => typeof name === 'string' && allowed.has(name))
    && new Set(value).size === value.length;
}

export function isGrokVideoNoWireProof(value, binding = {}) {
  if (!exactKeys(value, PROOF_KEYS)
    || value.schemaVersion !== 1 || value.operation !== 'media.video.create'
    || !SHA256.test(value.ownerIdentityDigest) || !SHA256.test(value.intentIdSha256)
    || !SHA256.test(value.intentDigest) || !SHA256.test(value.requestDigest)
    || !SHA256.test(value.promptSha256) || typeof value.payloadProfile !== 'string' || !VIDEO_PROFILE.test(value.payloadProfile)
    || !STAGES.has(value.stage) || value.requestStarted !== false || value.responseReceived !== false
    || value.httpStatus !== null || value.contentType !== null || !['http/1.0', 'http/1.1', 'h2', 'h3', 'other'].includes(value.httpVersion)
    || value.responseBytesRead !== 0 || !Number.isInteger(value.requestBodyBytes) || value.requestBodyBytes < 0 || value.requestBodyBytes > 64 * 1024
    || value.cfMitigated !== false || (value.errorClass !== null && !ERROR_CLASS.test(value.errorClass))
    || !HELPER_ERROR.test(value.helperErrorCode) || !safeNameArray(value.requestHeaderNames, REQUEST_HEADERS)
    || !safeNameArray(value.responseHeaderNames, RESPONSE_HEADERS, { empty: true })
    || !safeNameArray(value.cookieNamesUsed, new Set(), { empty: true })
    || value.source !== 'curl_cffi-0.16.3-chrome150') return false;
  return Object.entries(binding).every(([key, expected]) => value[key] === expected);
}

export function isGrokVideoNoWireRecovery(value) {
  return exactKeys(value, RECOVERY_KEYS)
    && value.schemaVersion === 1
    && SHA256.test(value.priorOperationIdSha256)
    && SHA256.test(value.priorRequestDigest)
    && SHA256.test(value.priorProofDigest)
    && SHA256.test(value.ownerIdentityDigest)
    && SHA256.test(value.intentIdSha256)
    && typeof value.payloadProfile === 'string' && VIDEO_PROFILE.test(value.payloadProfile)
    && SHA256.test(value.promptSha256);
}

export function grokVideoNoWireProofDigest(proof) {
  if (!isGrokVideoNoWireProof(proof)) return null;
  const canonical = Object.fromEntries(PROOF_KEYS.map(key => [key, proof[key]]));
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export function validateGrokVideoNoWireEntries(entries) {
  const videos = entries.filter(entry => entry?.contractId === 'media.video.create');
  const recoveryParents = new Set();
  for (const entry of videos) {
    if (entry.videoNoWireProof !== undefined) {
      if (entry.state !== 'rejected' || entry.reasonCode !== 'MEDIA_VIDEO_CFFI_PREFLIGHT_FAILED'
        || entry.httpStatus !== null
        || !isGrokVideoNoWireProof(entry.videoNoWireProof, {
          intentDigest: entry.intentDigest,
          requestDigest: entry.requestDigest,
        })) return false;
    }
    if (entry.videoNoWireRecovery !== undefined) {
      const recovery = entry.videoNoWireRecovery;
      if (!isGrokVideoNoWireRecovery(recovery) || !SHA256.test(entry.intentDigest ?? '')) return false;
      const prior = videos.filter(candidate => createHash('sha256').update(candidate.localOperationId, 'utf8').digest('hex')
        === recovery.priorOperationIdSha256 && candidate.requestDigest === recovery.priorRequestDigest
        && candidate.intentDigest === entry.intentDigest);
      if (prior.length !== 1) return false;
      const proofDigest = grokVideoNoWireProofDigest(prior[0].videoNoWireProof);
      if (prior[0].state !== 'rejected' || !proofDigest || proofDigest !== recovery.priorProofDigest
        || prior[0].videoNoWireProof.ownerIdentityDigest !== recovery.ownerIdentityDigest
        || prior[0].videoNoWireProof.intentIdSha256 !== recovery.intentIdSha256
        || prior[0].videoNoWireProof.payloadProfile !== recovery.payloadProfile
        || prior[0].videoNoWireProof.promptSha256 !== recovery.promptSha256
        || recoveryParents.has(recovery.priorOperationIdSha256)) return false;
      recoveryParents.add(recovery.priorOperationIdSha256);
    }
  }
  return true;
}
