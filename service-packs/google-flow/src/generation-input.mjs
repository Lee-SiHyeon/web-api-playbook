import { createHash } from 'node:crypto';
import { FlowProtocolError } from './protocol.mjs';

const MAX_INPUT_AGE_MS = 120_000;
const CLOCK_SKEW_MS = 5_000;
const ISSUER_ORIGIN = 'https://www.google.com';
const ACTION = 'VIDEO_GENERATION';
const consumedInputs = new Map();
const BINDING_KEYS = Object.freeze([
  'projectId', 'promptHash', 'aspect', 'duration', 'resolution', 'modelKey', 'clientIds', 'requestId',
]);
const SORTED_BINDING_KEYS = [...BINDING_KEYS].sort();

function inputError(message, code) {
  return new FlowProtocolError(message, { code, serverCode: code, rejected: true });
}

export function hashGenerationPrompt(prompt) {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

export function createGenerationBinding({ projectId, promptHash, aspect, duration, resolution, modelKey, clientIds, requestId }) {
  if (typeof requestId !== 'string' || !/^[A-Fa-f0-9-]{16,64}$/.test(requestId)) {
    throw new TypeError('A generation request id is required for input binding.');
  }
  return Object.freeze({
    projectId,
    promptHash,
    aspect,
    duration: Number(duration),
    resolution: String(resolution).toLowerCase(),
    modelKey,
    clientIds: Object.freeze([...clientIds]),
    requestId,
  });
}

function bindingMatches(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const keys = Object.keys(actual).sort();
  if (keys.length !== SORTED_BINDING_KEYS.length
      || keys.some((key, index) => key !== SORTED_BINDING_KEYS[index])) return false;
  return BINDING_KEYS.every(key => {
    if (key === 'clientIds') return Array.isArray(actual[key])
      && actual[key].length === expected.clientIds.length
      && actual[key].every((id, index) => id === expected.clientIds[index]);
    return actual[key] === expected[key];
  });
}

export function revalidateGenerationInput(result, binding, { now = Date.now() } = {}) {
  if (!result || typeof result !== 'object' || result.mode !== 'pure_http'
      || result.issuerOrigin !== ISSUER_ORIGIN || result.action !== ACTION) {
    throw inputError('Flow generation input is not from the observed first-party pure HTTP VIDEO_GENERATION issuer.', 'FLOW_GENERATION_INPUT_MODE_UNSUPPORTED');
  }
  if (typeof result.token !== 'string' || !result.token.trim() || result.token.length > 8_192
      || /[\r\n\0]/.test(result.token)) {
    throw inputError('Flow generation input is missing or malformed.', 'FLOW_GENERATION_INPUT_INVALID');
  }
  if (!bindingMatches(result.binding, binding)) {
    throw inputError('Flow generation input does not match this project, prompt, or generation options.', 'FLOW_GENERATION_INPUT_MISMATCH');
  }
  if (result.oneTime !== true || !Number.isFinite(result.issuedAt) || !Number.isFinite(result.expiresAt)) {
    throw inputError('Flow generation input must carry a one-time issuance window.', 'FLOW_GENERATION_INPUT_INVALID');
  }
  if (result.issuedAt > now + CLOCK_SKEW_MS || result.issuedAt < now - MAX_INPUT_AGE_MS
      || result.expiresAt <= now || result.expiresAt <= result.issuedAt
      || result.expiresAt - result.issuedAt > MAX_INPUT_AGE_MS) {
    throw inputError('Flow generation input is expired or outside the permitted freshness window.', 'FLOW_GENERATION_INPUT_EXPIRED');
  }
  return result;
}

export async function acquireFreshGenerationInput(provider, binding, { clock = Date.now } = {}) {
  if (!provider || provider.mode !== 'pure_http' || provider.issuerOrigin !== ISSUER_ORIGIN
      || typeof provider.acquire !== 'function') {
    throw inputError('No verified first-party Flow reCAPTCHA issuer is configured for pure HTTP generation.', 'FLOW_HTTP_CAPTCHA_ISSUER_UNAVAILABLE');
  }
  let result;
  try {
    result = await provider.acquire({ mode: 'pure_http', issuerOrigin: ISSUER_ORIGIN, action: ACTION, binding });
  } catch {
    throw inputError('The first-party Flow HTTP generation input provider failed.', 'FLOW_HTTP_INPUT_PROVIDER_FAILED');
  }
  revalidateGenerationInput(result, binding, { now: clock() });

  const now = clock();
  for (const [digest, expiresAt] of consumedInputs) {
    if (expiresAt <= now) consumedInputs.delete(digest);
  }
  const digest = createHash('sha256').update(result.token, 'utf8').digest('hex');
  if (consumedInputs.has(digest)) {
    throw inputError('This one-time Flow generation input was already consumed locally.', 'FLOW_GENERATION_INPUT_REUSED');
  }
  consumedInputs.set(digest, result.expiresAt);
  return result;
}
