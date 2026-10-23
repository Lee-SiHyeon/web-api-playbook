import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export const SERVICE_SESSION_SERVICE = 'coupang_partners' as const;
export type ServiceSessionProvider = 'coupang_partners' | 'naver_connect' | 'toss_sharelink';
export const SERVICE_SESSION_KEY_VERSION = 1 as const;

export type ServiceCredentialKind = 'web_session' | 'open_api';

export type ServiceSessionAad = {
  serviceId: ServiceSessionProvider;
  credentialKind: ServiceCredentialKind;
  ownerDigest: string;
  keyVersion: number;
  revision: number;
  allowedOrigins: readonly string[];
};

export type ServiceSessionEnvelope = ServiceSessionAad & {
  ciphertext: string;
  nonce: string;
  authTag: string;
};

export class ServiceSessionCryptoError extends Error {
  readonly code: 'SESSION_VAULT_KEY_MISSING' | 'SESSION_VAULT_KEY_INVALID' | 'SESSION_OWNER_INVALID'
    | 'SESSION_METADATA_INVALID' | 'SESSION_ENVELOPE_INVALID' | 'SESSION_DECRYPTION_FAILED';

  constructor(code: ServiceSessionCryptoError['code']) {
    super(code);
    this.name = 'ServiceSessionCryptoError';
    this.code = code;
  }
}

const allowedHostsByKind: Record<ServiceCredentialKind, readonly string[]> = {
  web_session: ['login.coupang.com', 'partners.coupang.com'],
  // This host is still only a first-party contract candidate. The session
  // store does not make requests; issuance code must verify the contract first.
  open_api: ['api-gateway.coupang.com'],
};
const providerHosts: Record<Exclude<ServiceSessionProvider, 'coupang_partners'>, Partial<Record<ServiceCredentialKind, readonly string[]>>> = {
  naver_connect: { web_session: ['gw-brandconnect.naver.com'] },
  toss_sharelink: { web_session: ['sharelink.toss.im'] },
};

function hostsFor(serviceId: ServiceSessionProvider, kind?: ServiceCredentialKind): readonly string[] {
  const hosts = serviceId === SERVICE_SESSION_SERVICE ? allowedHostsByKind : providerHosts[serviceId];
  const selected = kind ? hosts?.[kind] : hosts && Object.values(hosts).flat();
  if (!selected) throw new ServiceSessionCryptoError('SESSION_METADATA_INVALID');
  return selected;
}
const MAX_CREDENTIAL_BYTES = 512 * 1024;

function vaultKey(): Buffer {
  const encoded = process.env.SESSION_VAULT_KEY;
  if (!encoded) throw new ServiceSessionCryptoError('SESSION_VAULT_KEY_MISSING');
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new ServiceSessionCryptoError('SESSION_VAULT_KEY_INVALID');
  const key = Buffer.from(encoded, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== encoded) {
    throw new ServiceSessionCryptoError('SESSION_VAULT_KEY_INVALID');
  }
  return key;
}

export function deriveServiceSessionOwnerDigest(ownerIdentity: string, serviceId: ServiceSessionProvider = SERVICE_SESSION_SERVICE): string {
  hostsFor(serviceId);
  if (typeof ownerIdentity !== 'string') throw new ServiceSessionCryptoError('SESSION_OWNER_INVALID');
  const normalized = ownerIdentity.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 320 || /[\r\n\0]/.test(normalized)) {
    throw new ServiceSessionCryptoError('SESSION_OWNER_INVALID');
  }
  const key = vaultKey();
  try {
    return createHmac('sha256', key)
    .update(`lifehack:service-session-owner:${serviceId}:v1\0${normalized}`, 'utf8')
      .digest('hex');
  } finally {
    key.fill(0);
  }
}

export function normalizeServiceSessionOrigins(origins: readonly string[], kind?: ServiceCredentialKind,
  serviceId: ServiceSessionProvider = SERVICE_SESSION_SERVICE): string[] {
  const hosts = hostsFor(serviceId, kind);
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 8) {
    throw new ServiceSessionCryptoError('SESSION_METADATA_INVALID');
  }
  const normalized = origins.map((candidate) => {
    if (typeof candidate !== 'string' || candidate.length > 300) {
      throw new ServiceSessionCryptoError('SESSION_METADATA_INVALID');
    }
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new ServiceSessionCryptoError('SESSION_METADATA_INVALID');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash || url.origin !== candidate
      || !hosts.includes(url.hostname.toLowerCase())) {
      throw new ServiceSessionCryptoError('SESSION_METADATA_INVALID');
    }
    return url.origin;
  }).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new ServiceSessionCryptoError('SESSION_METADATA_INVALID');
  }
  if (kind) {
    const expected = [...hosts].map((host) => `https://${host}`).sort();
    if (normalized.length !== expected.length || normalized.some((origin, index) => origin !== expected[index])) {
      throw new ServiceSessionCryptoError('SESSION_METADATA_INVALID');
    }
  }
  return normalized;
}

function canonicalAad(input: ServiceSessionAad): Buffer {
  if (!['coupang_partners', 'naver_connect', 'toss_sharelink'].includes(input.serviceId)
    || (input.credentialKind !== 'web_session' && input.credentialKind !== 'open_api')
    || !/^[a-f0-9]{64}$/.test(input.ownerDigest)
    || !Number.isSafeInteger(input.keyVersion) || input.keyVersion !== SERVICE_SESSION_KEY_VERSION
    || !Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new ServiceSessionCryptoError('SESSION_METADATA_INVALID');
  }
  const allowedOrigins = normalizeServiceSessionOrigins(input.allowedOrigins, input.credentialKind, input.serviceId);
  if (allowedOrigins.length !== input.allowedOrigins.length
    || allowedOrigins.some((origin, index) => origin !== input.allowedOrigins[index])) {
    throw new ServiceSessionCryptoError('SESSION_METADATA_INVALID');
  }
  // JSON arrays are used so delimiters in any future field cannot make two
  // different metadata tuples produce the same associated data.
  return Buffer.from(JSON.stringify([
    input.serviceId,
    input.credentialKind,
    input.ownerDigest,
    input.keyVersion,
    input.revision,
    allowedOrigins,
  ]), 'utf8');
}

function decodeCanonicalBase64Url(value: string, expectedBytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ServiceSessionCryptoError('SESSION_ENVELOPE_INVALID');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)) {
    throw new ServiceSessionCryptoError('SESSION_ENVELOPE_INVALID');
  }
  return decoded;
}

export function encryptServiceSessionCredential(
  input: ServiceSessionAad & { plaintext: string | Uint8Array },
): ServiceSessionEnvelope {
  const aad = canonicalAad(input);
  const plaintext = typeof input.plaintext === 'string' ? Buffer.from(input.plaintext, 'utf8') : Buffer.from(input.plaintext);
  if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_CREDENTIAL_BYTES) {
    throw new ServiceSessionCryptoError('SESSION_ENVELOPE_INVALID');
  }
  const nonce = randomBytes(12);
  const key = vaultKey();
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad, { plaintextLength: plaintext.byteLength });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      serviceId: input.serviceId,
      credentialKind: input.credentialKind,
      ownerDigest: input.ownerDigest,
      keyVersion: input.keyVersion,
      revision: input.revision,
      allowedOrigins: [...input.allowedOrigins],
      ciphertext: ciphertext.toString('base64url'),
      nonce: nonce.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
    };
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

export function decryptServiceSessionCredential(envelope: ServiceSessionEnvelope): Buffer {
  try {
    const aad = canonicalAad(envelope);
    const nonce = decodeCanonicalBase64Url(envelope.nonce, 12);
    const authTag = decodeCanonicalBase64Url(envelope.authTag, 16);
    const ciphertext = decodeCanonicalBase64Url(envelope.ciphertext);
    if (ciphertext.byteLength < 1 || ciphertext.byteLength > MAX_CREDENTIAL_BYTES) {
      throw new ServiceSessionCryptoError('SESSION_ENVELOPE_INVALID');
    }
    const key = vaultKey();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      decipher.setAAD(aad, { plaintextLength: ciphertext.byteLength });
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } finally {
      key.fill(0);
      ciphertext.fill(0);
    }
  } catch (error) {
    if (error instanceof ServiceSessionCryptoError
      && ['SESSION_VAULT_KEY_MISSING', 'SESSION_VAULT_KEY_INVALID', 'SESSION_METADATA_INVALID'].includes(error.code)) {
      throw error;
    }
    throw new ServiceSessionCryptoError('SESSION_DECRYPTION_FAILED');
  }
}
