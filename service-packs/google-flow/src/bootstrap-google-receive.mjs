import { createDecipheriv, generateKeyPairSync, privateDecrypt, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { writeCredential } from './secure-credential-store.mjs';
import { GOOGLE_FLOW_AUTH_CREDENTIAL, validateGoogleFlowAuthBundle } from './google-sso-recovery.mjs';

// The authorized first-party capture sender encrypts in memory. No cookie values
// or identity fields pass through command arguments, stdout, or evidence files.
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const runId = randomUUID();
process.stdout.write(`${JSON.stringify({ state: 'waiting_for_encrypted_handoff', runId,
  publicKey: publicKey.toString('base64'), encryption: 'RSA-OAEP-SHA256+AES-256-GCM' })}\n`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let received = false;
try {
  for await (const line of lines) {
    if (received || line.length > 200000) throw new Error('FLOW_GOOGLE_HANDOFF_INVALID');
    received = true;
    const envelope = JSON.parse(line);
    if (envelope?.version !== 1 || envelope.runId !== runId
      || typeof envelope.key !== 'string' || typeof envelope.iv !== 'string'
      || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 180000) {
      throw new Error('FLOW_GOOGLE_HANDOFF_INVALID');
    }
    const key = privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(envelope.key, 'base64'));
    const iv = Buffer.from(envelope.iv, 'base64');
    const encrypted = Buffer.from(envelope.ciphertext, 'base64');
    if (key.length !== 32 || iv.length !== 12 || encrypted.length < 17) throw new Error('FLOW_GOOGLE_HANDOFF_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(encrypted.subarray(-16));
    const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    if (plain.length > 131072) throw new Error('FLOW_GOOGLE_HANDOFF_INVALID');
    const bundle = validateGoogleFlowAuthBundle(JSON.parse(plain.toString('utf8')));
    const stored = writeCredential(GOOGLE_FLOW_AUTH_CREDENTIAL, JSON.stringify(bundle));
    process.stdout.write(`${JSON.stringify({ stored: stored.stored, provider: stored.encryption,
      origin: 'https://accounts.google.com', serviceOrigin: 'https://flow.google.com',
      cookieCount: bundle.cookies.length, plaintextPersisted: false })}\n`);
    break;
  }
  if (!received) throw new Error('FLOW_GOOGLE_HANDOFF_MISSING');
} catch {
  process.stderr.write('FLOW_GOOGLE_HANDOFF_FAILED\n');
  process.exitCode = 1;
} finally {
  lines.close();
}
