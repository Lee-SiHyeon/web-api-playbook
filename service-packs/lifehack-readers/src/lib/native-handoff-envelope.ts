import { createHash, createPublicKey, verify } from 'node:crypto';

export type NativeHandoffProvider = 'naver_connect' | 'toss_sharelink';
export class NativeHandoffError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

const authorizations = new WeakMap<object, {
  provider: NativeHandoffProvider; ownerEmail: string; sourceRevision: number; expiresAt: number; digest: string;
}>();

/** Verify the exact signed bytes; unsigned request material never becomes an acquisition. */
export function verifyNativeHandoff<T extends object>(input: {
  envelope: unknown; publicKeyPem: string; expectedEmail: string; expectedRevision: number;
  provider: NativeHandoffProvider; kind: string; sourceKinds: readonly string[]; errorCode: string;
  validateMaterial: (value: unknown, now: number) => T; now?: number;
}): T {
  let bytes: Buffer | null = null;
  let signature: Buffer | null = null;
  const now = input.now ?? Date.now();
  try {
    const envelope = record(input.envelope);
    if (!envelope || !exactKeys(envelope, ['payload', 'signature'])
      || typeof envelope.payload !== 'string' || envelope.payload.length > 192 * 1024
      || typeof envelope.signature !== 'string' || envelope.signature.length > 128) throw new Error();
    bytes = Buffer.from(envelope.payload, 'base64url');
    signature = Buffer.from(envelope.signature, 'base64url');
    if (!bytes.length || bytes.length > 96 * 1024 || signature.length !== 64
      || bytes.toString('base64url') !== envelope.payload || signature.toString('base64url') !== envelope.signature) throw new Error();
    const key = createPublicKey(input.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, signature)) throw new Error();
    const payload = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (!payload || !exactKeys(payload, ['kind', 'provider', 'ownerEmail', 'issuedAt', 'expiresAt',
      'sourceRevision', 'sourceKind', 'material']) || payload.kind !== input.kind || payload.provider !== input.provider
      || payload.ownerEmail !== input.expectedEmail || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 1 || payload.sourceRevision !== input.expectedRevision
      || !input.sourceKinds.includes(String(payload.sourceKind))
      || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
      || Number(payload.issuedAt) > now + 10_000 || Number(payload.issuedAt) < now - 120_000
      || Number(payload.expiresAt) <= now || Number(payload.expiresAt) <= Number(payload.issuedAt)
      || Number(payload.expiresAt) > Number(payload.issuedAt) + 120_000) throw new Error();
    const material = input.validateMaterial(payload.material, now);
    authorizations.set(material, { provider: input.provider, ownerEmail: input.expectedEmail,
      sourceRevision: input.expectedRevision, expiresAt: Number(payload.expiresAt),
      digest: createHash('sha256').update(JSON.stringify(material)).digest('hex') });
    return material;
  } catch {
    throw new NativeHandoffError(input.errorCode);
  } finally {
    bytes?.fill(0);
    signature?.fill(0);
  }
}

export function authorizedNativeHandoffRevision(material: object, provider: NativeHandoffProvider,
  ownerEmail: string): number | null {
  const authorization = authorizations.get(material);
  return authorization && authorization.provider === provider && authorization.ownerEmail === ownerEmail
    && authorization.expiresAt > Date.now()
    && authorization.digest === createHash('sha256').update(JSON.stringify(material)).digest('hex')
    ? authorization.sourceRevision : null;
}

/** Clear mutable references as well as the byte buffers zeroed by the verifier and vault. */
export function clearNativeHandoffMaterial(value: unknown): void {
  const material = record(value);
  if (!material) return;
  authorizations.delete(material);
  for (const key of Object.keys(material)) {
    const child = material[key];
    if (Array.isArray(child)) { for (const item of child) clearNativeHandoffMaterial(item); child.length = 0; }
    else if (record(child)) clearNativeHandoffMaterial(child);
    else if (typeof child === 'string') material[key] = '';
  }
}
