import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { TossHttpLoginPendingHandle } from './toss-http-login-core';

export const TOSS_LOGIN_ATTEMPTS_TABLE = 'toss_http_login_attempts';
export const tossApprovalBinding = { receiverOrigin: 'https://business.toss.im', receiverPath: '/account/two-factor/push-status',
  receiverQueryNames: ['session_token', 'token'], tokenQueryName: 'token' as const };
function cipherKey(): Buffer {
  const key = Buffer.from(process.env.SESSION_VAULT_KEY ?? '', 'base64url');
  if (key.length !== 32) { key.fill(0); throw Error('TOSS_LOGIN_STORAGE_UNCONFIGURED'); }
  return key;
}
export function sealTossLoginContext(value: object, digest: string, id: string) {
  const key = cipherKey(), iv = randomBytes(12), bytes = Buffer.from(JSON.stringify(value));
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('toss/http-login/v1/' + digest + '/' + id));
    return { iv: iv.toString('base64url'), ciphertext: Buffer.concat([cipher.update(bytes), cipher.final()]).toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url') };
  } finally { key.fill(0); bytes.fill(0); }
}
export function openTossLoginContext(envelope: Record<string, string>, digest: string, id: string) {
  const key = cipherKey(); let bytes: Buffer | null = null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(Buffer.from('toss/http-login/v1/' + digest + '/' + id));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    bytes = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
    return JSON.parse(bytes.toString());
  } finally { key.fill(0); bytes?.fill(0); }
}
export async function tossPendingContextForStorage(pending: TossHttpLoginPendingHandle) {
  return pending.inspectContext(context => ({ ...context, cookieJar: context.cookieJar.serializeSync(),
    continuationUrl: context.continuationUrl?.href ?? null }));
}
