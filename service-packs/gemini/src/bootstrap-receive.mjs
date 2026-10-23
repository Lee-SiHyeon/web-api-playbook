import { createDecipheriv, generateKeyPairSync, privateDecrypt, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stdin, stdout, stderr } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadObservedContract } from './contract.mjs';
import { CREDENTIAL_NAME, SERVICE_ID, SERVICE_ORIGIN } from './constants.mjs';
import { validateSessionBundle } from './session.mjs';
import { credentialStoreReady, writeCredential } from './secure-credential-store.mjs';
import { GeminiClientError } from './errors.mjs';

const MAX_ENVELOPE_CHARS = 350000;
const MAX_BUNDLE_BYTES = 262144;

export function decryptHandoffEnvelope(envelope, privateKey, runId, contract) {
  if (envelope?.version !== 1 || envelope.service !== SERVICE_ID || envelope.origin !== SERVICE_ORIGIN
      || envelope.runId !== runId || typeof envelope.wrappedKey !== 'string'
      || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string'
      || envelope.ciphertext.length > MAX_ENVELOPE_CHARS) {
    throw new GeminiClientError('HANDOFF_INVALID', 'The encrypted Gemini session handoff is invalid.');
  }
  let key;
  let plain;
  try {
    key = privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'));
    const iv = Buffer.from(envelope.iv, 'base64');
    const encrypted = Buffer.from(envelope.ciphertext, 'base64');
    if (key.length !== 32 || iv.length !== 12 || encrypted.length < 17 || encrypted.length > MAX_BUNDLE_BYTES + 16) {
      throw new Error();
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from('gemini-web-xhr-client:v1', 'utf8'));
    decipher.setAuthTag(encrypted.subarray(-16));
    plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    if (plain.length > MAX_BUNDLE_BYTES) throw new Error();
    const bundle = JSON.parse(plain.toString('utf8'));
    return validateSessionBundle(bundle, contract);
  } catch (error) {
    if (error instanceof GeminiClientError) throw error;
    throw new GeminiClientError('HANDOFF_DECRYPT_FAILED', 'The encrypted Gemini session handoff could not be verified.');
  } finally {
    if (key) key.fill(0);
    if (plain) plain.fill(0);
  }
}

async function receiveOneLine() {
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > MAX_ENVELOPE_CHARS) throw new GeminiClientError('HANDOFF_TOO_LARGE', 'The encrypted Gemini session handoff exceeded its size limit.');
      return line;
    }
    return null;
  } finally {
    lines.close();
  }
}

async function main() {
  const contract = await loadObservedContract();
  if (!credentialStoreReady()) throw new GeminiClientError('CREDENTIAL_STORE_UNAVAILABLE', 'Windows DPAPI CurrentUser storage is unavailable.');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const runId = randomUUID();
  stdout.write(JSON.stringify({
    state: 'waiting_for_encrypted_handoff',
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    runId,
    publicKey: publicKey.toString('base64'),
    encryption: 'RSA-OAEP-SHA256+AES-256-GCM',
  }) + '\n');
  const line = await receiveOneLine();
  if (!line) throw new GeminiClientError('HANDOFF_MISSING', 'The encrypted Gemini session handoff was not received.');
  let envelope;
  try { envelope = JSON.parse(line); } catch { throw new GeminiClientError('HANDOFF_INVALID', 'The encrypted Gemini session handoff is not valid JSON.'); }
  const session = decryptHandoffEnvelope(envelope, privateKey, runId, contract);
  writeCredential(CREDENTIAL_NAME, JSON.stringify(session));
  stdout.write(JSON.stringify({
    stored: true,
    provider: 'Windows DPAPI CurrentUser',
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    cookieCount: session.cookies.length,
    headerCount: Object.keys(session.headers).length,
    plaintextPersisted: false,
  }) + '\n');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof GeminiClientError ? error.code : 'HANDOFF_FAILED';
    stderr.write(code + '\n');
    process.exitCode = 1;
  });
}
