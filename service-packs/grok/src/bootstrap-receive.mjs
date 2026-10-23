import {
  constants,
  createDecipheriv,
  createPrivateKey,
  generateKeyPairSync,
  privateDecrypt,
  randomUUID,
} from 'node:crypto';
import { stdin, stdout, stderr } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContractRegistry } from './client.mjs';
import { operationReadiness, validateContractRegistry } from './contracts.mjs';
import { fail } from './errors.mjs';
import { GrokSessionStore, GROK_WEB_ORIGIN, validateSessionBundle } from './session.mjs';

export const HANDOFF_AAD_LABEL = 'grok-web-xhr-client:session-handoff:v1';
export const HANDOFF_MAX_WAIT_MS = 5 * 60_000;
export const MAX_HANDOFF_LINE_BYTES = 400_000;
export const MAX_HANDOFF_BUNDLE_BYTES = 256 * 1024;

const HANDOFF_AAD = (runId) => Buffer.from(
  `${HANDOFF_AAD_LABEL}\n${'grok-web'}\n${GROK_WEB_ORIGIN}\n${runId}`,
  'utf8',
);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CHALLENGE_COOKIE_PATTERN = /(?:^|[_-])(?:cf[_-]?clearance|cf[_-]?chl|__?cf[_-]?bm|ak[_-]?bmsc|bm[_-]?sv|bm[_-]?sz|_abck|captcha|challenge|turnstile)(?:$|[_-])/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value || !BASE64_PATTERN.test(value)) throw fail('HANDOFF_INVALID');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    decoded.fill(0);
    throw fail('HANDOFF_INVALID');
  }
  return decoded;
}

function validateMaxWait(maxWaitMs) {
  if (!Number.isInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > HANDOFF_MAX_WAIT_MS) {
    throw fail('HANDOFF_TIMEOUT_INVALID');
  }
}

/**
 * Collect only credential names used by a ready, captured, session-authenticated
 * operation. Public/source-derived operations and unresolved security boundaries
 * never authorize session import.
 */
export function observedCredentialAllowlist(inputRegistry) {
  const registry = validateContractRegistry(inputRegistry);
  const cookieNames = new Set();
  const headerNames = new Set();
  let eligibleOperations = 0;

  for (const operation of registry.operations) {
    if (operation.authMode !== 'session'
      || operation.evidence.source !== 'browser_network_capture'
      || !operationReadiness(operation).ready) continue;
    const bindings = operation.request.credentialBindings;
    if (!bindings || (!bindings.cookies.length && !bindings.headers.length)) continue;
    eligibleOperations++;
    for (const name of bindings.cookies) cookieNames.add(name);
    for (const name of bindings.headers) headerNames.add(name.toLowerCase());
  }

  return Object.freeze({
    eligibleOperations,
    cookieNames: Object.freeze([...cookieNames].sort()),
    headerNames: Object.freeze([...headerNames].sort()),
  });
}

function validateBundleAgainstAllowlist(bundle, allowlist, { now }) {
  const session = validateSessionBundle(bundle, { now });
  const allowedCookies = new Set(allowlist.cookieNames);
  const allowedHeaders = new Set(allowlist.headerNames);
  const scoped = session.origins[0];
  if (!scoped.cookies.length && !scoped.headers.length) throw fail('SESSION_CREDENTIALS_EMPTY');
  if (scoped.cookies.some(cookie => !['grok.com', '.grok.com'].includes(cookie.domain.toLowerCase()))) {
    throw fail('SESSION_COOKIE_DOMAIN_SCOPE');
  }
  if (scoped.cookies.some(cookie => CHALLENGE_COOKIE_PATTERN.test(cookie.name))) {
    throw fail('SESSION_COOKIE_CHALLENGE_REJECTED');
  }
  if (scoped.cookies.some(cookie => !allowedCookies.has(cookie.name))
    || scoped.headers.some(header => !allowedHeaders.has(header.name.toLowerCase()))) {
    throw fail('SESSION_CREDENTIAL_NOT_OBSERVED');
  }
  return session;
}

export function handoffAssociatedData(runId) {
  if (typeof runId !== 'string' || !UUID_PATTERN.test(runId)) throw fail('HANDOFF_INVALID');
  return HANDOFF_AAD(runId);
}

export function decryptHandoffEnvelope(envelope, privateKey, runId, allowlist, { now = Date.now() } = {}) {
  if (!isRecord(envelope) || envelope.version !== 1 || envelope.serviceId !== 'grok-web'
    || envelope.origin !== GROK_WEB_ORIGIN || envelope.runId !== runId
    || !UUID_PATTERN.test(runId) || typeof envelope.wrappedKey !== 'string'
    || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string'
    || envelope.ciphertext.length > Math.ceil((MAX_HANDOFF_BUNDLE_BYTES + 16) * 4 / 3)) {
    throw fail('HANDOFF_INVALID');
  }

  let wrappedKey;
  let contentKey;
  let iv;
  let encrypted;
  let plaintext;
  try {
    wrappedKey = decodeBase64(envelope.wrappedKey);
    iv = decodeBase64(envelope.iv);
    encrypted = decodeBase64(envelope.ciphertext);
    if (wrappedKey.length !== 384 || iv.length !== 12 || encrypted.length < 17
      || encrypted.length > MAX_HANDOFF_BUNDLE_BYTES + 16) throw fail('HANDOFF_INVALID');
    contentKey = privateDecrypt({
      key: createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, wrappedKey);
    if (contentKey.length !== 32) throw fail('HANDOFF_INVALID');

    const decipher = createDecipheriv('aes-256-gcm', contentKey, iv);
    decipher.setAAD(handoffAssociatedData(runId));
    decipher.setAuthTag(encrypted.subarray(-16));
    plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(0, -16)),
      decipher.final(),
    ]);
    if (plaintext.length > MAX_HANDOFF_BUNDLE_BYTES) throw fail('HANDOFF_TOO_LARGE');

    let bundle;
    try {
      bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    } catch {
      throw fail('HANDOFF_INVALID');
    }
    return validateBundleAgainstAllowlist(bundle, allowlist, { now });
  } catch (error) {
    if (error?.code === 'SESSION_BUNDLE_INVALID' || error?.code === 'SESSION_ORIGIN_INVALID'
      || error?.code === 'SESSION_CREDENTIAL_SCOPE' || error?.code === 'SESSION_COOKIE_INVALID'
      || error?.code === 'SESSION_COOKIE_DOMAIN_SCOPE' || error?.code === 'SESSION_HEADER_INVALID'
      || error?.code === 'SESSION_CREDENTIAL_DUPLICATE' || error?.code === 'SESSION_CREDENTIAL_NOT_OBSERVED'
      || error?.code === 'SESSION_CREDENTIALS_EMPTY' || error?.code === 'SESSION_COOKIE_CHALLENGE_REJECTED'
      || error?.code === 'SESSION_HANDOFF_STALE' || error?.code === 'SESSION_HANDOFF_FUTURE') throw error;
    if (error?.code === 'HANDOFF_TOO_LARGE' || error?.code === 'HANDOFF_INVALID') throw error;
    throw fail('HANDOFF_DECRYPT_FAILED');
  } finally {
    wrappedKey?.fill(0);
    contentKey?.fill(0);
    iv?.fill(0);
    encrypted?.fill(0);
    plaintext?.fill(0);
  }
}

function receiveOneLine(input, { createdAt, maxWaitMs, now }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let totalBytes = 0;
    const chunks = [];
    const elapsedMs = now() - createdAt;
    const remainingMs = Math.min(maxWaitMs, Math.max(0, maxWaitMs - elapsedMs));
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.pause?.();
      input.destroy?.();
      for (const chunk of chunks) chunk.fill(0);
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, fail('HANDOFF_EXPIRED')), Math.max(0, remainingMs));
    const onError = () => finish(reject, fail('HANDOFF_INPUT_FAILED'));
    const onEnd = () => {
      if (!totalBytes) return finish(resolve, null);
      const lineBytes = Buffer.concat(chunks, totalBytes);
      const line = lineBytes.toString('utf8');
      lineBytes.fill(0);
      finish(resolve, line);
    };
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk), 'utf8');
      const newlineAt = bytes.indexOf(0x0a);
      const acceptedBytes = newlineAt < 0 ? bytes : bytes.subarray(0, newlineAt);
      const trailingBytes = newlineAt < 0 ? null : bytes.subarray(newlineAt + 1);
      if (trailingBytes?.length) {
        bytes.fill(0);
        return finish(reject, fail('HANDOFF_INVALID'));
      }
      totalBytes += acceptedBytes.length;
      if (totalBytes > MAX_HANDOFF_LINE_BYTES) {
        bytes.fill(0);
        return finish(reject, fail('HANDOFF_TOO_LARGE'));
      }
      if (newlineAt < 0) chunks.push(Buffer.from(acceptedBytes));
      else {
        chunks.push(Buffer.from(acceptedBytes));
        if (chunks.length) {
          const lineBytes = Buffer.concat(chunks, totalBytes);
          if (lineBytes.at(-1) === 0x0d) {
            const trimmed = lineBytes.subarray(0, -1);
            const line = trimmed.toString('utf8');
            lineBytes.fill(0);
            bytes.fill(0);
            return finish(resolve, line);
          }
          const line = lineBytes.toString('utf8');
          lineBytes.fill(0);
          bytes.fill(0);
          return finish(resolve, line);
        }
      }
      bytes.fill(0);
    };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.resume?.();
    if (remainingMs <= 0) finish(reject, fail('HANDOFF_EXPIRED'));
  });
}

export async function receiveOneEncryptedSession({ input = stdin, output = stdout,
  registryLoader = loadContractRegistry, sessionStore,
  now = () => Date.now(), maxWaitMs = HANDOFF_MAX_WAIT_MS } = {}) {
  validateMaxWait(maxWaitMs);
  try {
    const registry = validateContractRegistry(await registryLoader());
    const allowlist = observedCredentialAllowlist(registry);
    if (allowlist.eligibleOperations < 1 || (!allowlist.cookieNames.length && !allowlist.headerNames.length)) {
      throw fail('SESSION_CONTRACT_NOT_READY');
    }

    if (process.platform !== 'win32' && !sessionStore) throw fail('CREDENTIAL_STORE_UNAVAILABLE');
    const store = sessionStore ?? new GrokSessionStore();
    if (store.provider !== 'Windows DPAPI CurrentUser') throw fail('CREDENTIAL_STORE_UNAVAILABLE');

    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const runId = randomUUID();
    const createdAt = now();
    let line;
    let session;
    try {
      output.write(`${JSON.stringify({
        state: 'waiting_for_encrypted_handoff',
        serviceId: 'grok-web',
        origin: GROK_WEB_ORIGIN,
        runId,
        publicKey: publicKey.toString('base64'),
        encryption: 'RSA-OAEP-SHA256+AES-256-GCM',
        aad: HANDOFF_AAD_LABEL,
        expiresAt: new Date(createdAt + maxWaitMs).toISOString(),
        maxBundleBytes: MAX_HANDOFF_BUNDLE_BYTES,
      })}\n`);
      line = await receiveOneLine(input, { createdAt, maxWaitMs, now });
      if (line === null) throw fail('HANDOFF_MISSING');
      if (now() - createdAt >= maxWaitMs) throw fail('HANDOFF_EXPIRED');
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch {
        throw fail('HANDOFF_INVALID');
      }
      session = decryptHandoffEnvelope(envelope, privateKey, runId, allowlist, { now: now() });
      envelope = null;
      const receipt = await store.importBundle(session, { now: now() });
      session = null;
      if (receipt?.stored !== true || receipt.provider !== 'Windows DPAPI CurrentUser' || receipt.persistent !== true) {
        throw fail('CREDENTIAL_STORE_UNVERIFIED');
      }
      const result = {
        stored: true,
        provider: receipt.provider,
        persistent: true,
        serviceId: 'grok-web',
        origin: GROK_WEB_ORIGIN,
        cookieCount: receipt.cookieCount,
        headerCount: receipt.headerCount,
        ownerVerified: false,
      };
      output.write(`${JSON.stringify(result)}\n`);
      return result;
    } finally {
      publicKey.fill(0);
      privateKey.fill(0);
      session = null;
      if (typeof line === 'string') line = '';
    }
  } catch (error) {
    const safeCodes = new Set([
      'SESSION_CONTRACT_NOT_READY', 'CREDENTIAL_STORE_UNAVAILABLE', 'CREDENTIAL_STORE_UNVERIFIED',
      'HANDOFF_TIMEOUT_INVALID', 'HANDOFF_TOO_LARGE', 'HANDOFF_EXPIRED', 'HANDOFF_MISSING',
      'HANDOFF_INVALID', 'HANDOFF_DECRYPT_FAILED', 'SESSION_BUNDLE_INVALID', 'SESSION_ORIGIN_INVALID',
      'SESSION_CREDENTIAL_SCOPE', 'SESSION_COOKIE_INVALID', 'SESSION_COOKIE_DOMAIN_SCOPE',
      'SESSION_HEADER_INVALID', 'SESSION_CREDENTIAL_DUPLICATE', 'SESSION_CREDENTIAL_NOT_OBSERVED',
      'SESSION_CREDENTIALS_EMPTY', 'SESSION_COOKIE_CHALLENGE_REJECTED', 'SESSION_HANDOFF_STALE',
      'SESSION_HANDOFF_FUTURE',
      'HANDOFF_INPUT_FAILED',
    ]);
    const code = safeCodes.has(error?.code) ? error.code : 'HANDOFF_FAILED';
    throw fail(code);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  receiveOneEncryptedSession().catch(error => {
    const code = typeof error?.code === 'string' ? error.code : 'HANDOFF_FAILED';
    stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
