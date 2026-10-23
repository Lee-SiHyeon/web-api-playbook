import { createDecipheriv, generateKeyPairSync, privateDecrypt, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stdin, stdout, stderr } from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeCredential } from './secure-credential-store.mjs';
import { CREDENTIAL_NAME, validateSessionBundle } from './session.mjs';

const AAD = Buffer.from('chatgpt-web-xhr-client:v1', 'utf8');
const MAX_LINE = 250_000;

function decryptEnvelope(envelope, privateKey, runId) {
  if (envelope?.version !== 1 || envelope.runId !== runId
    || typeof envelope.wrappedKey !== 'string' || typeof envelope.iv !== 'string'
    || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > MAX_LINE * 1.4) {
    throw new Error('HANDOFF_INVALID');
  }
  const key = privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'));
  const iv = Buffer.from(envelope.iv, 'base64');
  const encrypted = Buffer.from(envelope.ciphertext, 'base64');
  if (key.length !== 32 || iv.length !== 12 || encrypted.length < 17 || encrypted.length > 180_000) {
    key.fill(0);
    throw new Error('HANDOFF_INVALID');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(encrypted.subarray(-16));
  try {
    const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    if (plaintext.length > 131_072) {
      plaintext.fill(0);
      throw new Error('HANDOFF_TOO_LARGE');
    }
    return plaintext;
  } finally {
    key.fill(0);
  }
}

export function createBootstrapPublicEnvelope() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey, runId: randomUUID(), createdAt: Date.now() };
}

export async function receiveOneEncryptedSession({ input = stdin, output = stdout, errorOutput = stderr,
  write = writeCredential, now = () => Date.now(), maxWaitMs = 5 * 60_000 } = {}) {
  const { publicKey, privateKey, runId, createdAt } = createBootstrapPublicEnvelope();
  output.write(`${JSON.stringify({ state: 'waiting_for_encrypted_handoff', service: 'chatgpt-web', runId,
    publicKey: publicKey.toString('base64'), encryption: 'RSA-OAEP-SHA256+AES-256-GCM',
    expiresAt: new Date(createdAt + maxWaitMs).toISOString() })}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let received = false;
  try {
    for await (const line of lines) {
      if (received || line.length > MAX_LINE) throw new Error('HANDOFF_INVALID');
      received = true;
      if (now() - createdAt > maxWaitMs) throw new Error('HANDOFF_EXPIRED');
      const envelope = JSON.parse(line);
      const plaintext = decryptEnvelope(envelope, privateKey, runId);
      let bundle;
      try {
        bundle = validateSessionBundle(JSON.parse(plaintext.toString('utf8')), { now: now() });
      } finally {
        plaintext.fill(0);
      }
      const serialized = JSON.stringify(bundle);
      const result = await write(CREDENTIAL_NAME, serialized);
      bundle = null;
      if (result?.stored !== true) throw new Error('CREDENTIAL_STORE_UNVERIFIED');
      output.write(`${JSON.stringify({ stored: true, provider: 'Windows DPAPI CurrentUser',
        service: 'chatgpt-web', origin: 'https://chatgpt.com' })}\n`);
      return { stored: true, service: 'chatgpt-web' };
    }
    throw new Error('HANDOFF_MISSING');
  } catch (error) {
    const code = ['HANDOFF_INVALID', 'HANDOFF_TOO_LARGE', 'HANDOFF_EXPIRED', 'HANDOFF_MISSING',
      'SESSION_BUNDLE_INVALID', 'SESSION_HANDOFF_STALE', 'SESSION_COOKIE_INVALID',
      'SESSION_CHALLENGE_COOKIE_REJECTED', 'SESSION_COOKIE_DUPLICATE', 'CREDENTIAL_STORE_UNVERIFIED']
      .includes(error?.message) ? error.message : 'HANDOFF_FAILED';
    errorOutput.write(`${code}\n`);
    throw new Error(code);
  } finally {
    lines.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  receiveOneEncryptedSession().catch(() => { process.exitCode = 1; });
}
