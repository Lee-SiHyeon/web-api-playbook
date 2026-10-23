import { createDecipheriv, generateKeyPairSync, privateDecrypt, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stdin, stdout, stderr } from 'node:process';
import { writeCredential } from './secure-credential-store.mjs';
import { FLOW_CREDENTIAL } from './session-name.mjs';
import { validateFlowSessionBundle } from './session-bundle.mjs';


function decryptEnvelope(envelope, privateKey) {
  if (envelope?.version !== 1 || typeof envelope.key !== 'string'
    || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string'
    || envelope.ciphertext.length > 180000) throw new Error('FLOW_ENVELOPE_INVALID');
  const key = privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(envelope.key, 'base64'));
  const iv = Buffer.from(envelope.iv, 'base64');
  const encrypted = Buffer.from(envelope.ciphertext, 'base64');
  if (key.length !== 32 || iv.length !== 12 || encrypted.length < 17) throw new Error('FLOW_ENVELOPE_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(encrypted.subarray(-16));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  if (plain.length > 131072) throw new Error('FLOW_ENVELOPE_TOO_LARGE');
  return validateFlowSessionBundle(JSON.parse(plain.toString('utf8')));
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const runId = randomUUID();
stdout.write(`${JSON.stringify({ state: 'waiting_for_encrypted_handoff', runId,
  publicKey: publicKey.toString('base64'), encryption: 'RSA-OAEP-SHA256+AES-256-GCM' })}\n`);

const lines = createInterface({ input: stdin, crlfDelay: Infinity });
let received = false;
try {
  for await (const line of lines) {
    if (received || line.length > 200000) throw new Error('FLOW_HANDOFF_INVALID');
    received = true;
    const message = JSON.parse(line);
    if (message.runId !== runId) throw new Error('FLOW_HANDOFF_RUN_MISMATCH');
    const bundle = decryptEnvelope(message, privateKey);
    writeCredential(FLOW_CREDENTIAL, JSON.stringify(bundle));
    stdout.write(`${JSON.stringify({ stored: true, provider: 'Windows DPAPI CurrentUser',
      origin: bundle.origin, projectId: bundle.projectId, cookieCount: bundle.cookieCount })}\n`);
    break;
  }
  if (!received) throw new Error('FLOW_HANDOFF_MISSING');
} catch (error) {
  stderr.write(`${error?.message?.startsWith('FLOW_') ? error.message : 'FLOW_HANDOFF_FAILED'}\n`);
  process.exitCode = 1;
} finally {
  lines.close();
}
