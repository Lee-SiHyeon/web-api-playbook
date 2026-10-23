import { createHash } from 'node:crypto';
import { safeSourceDestination } from './source-destination';

export const ADPICK_SERVICE_ORIGIN = 'https://adpick-api.vercel.app';
export const ADPICK_LINK_HOSTS = ['deg.kr', 'bitl.bz'] as const;
export class AdpickServiceError extends Error {
  constructor(code: string) { super(code); this.name = 'AdpickServiceError'; }
}
export const adpickObject = (value: unknown): Record<string, unknown> | null => value !== null
  && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
export function adpickProductUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || url.hostname.endsWith('.localhost')
      || [...url.searchParams.keys()].some(k => /^(apikey|api_key|token|access_token|password|cookie|signature)$/i.test(k))) return null;
    return url.href;
  } catch { return null; }
}
export const adpickShortLink = (value: unknown): string | null => safeSourceDestination(value, ADPICK_LINK_HOSTS);
/** Observe legacy merchant URLs without fabricating an HTTPS version for link issuance. */
export function adpickObservedProductUrl(value: unknown): string | null {
  const https = adpickProductUrl(value);
  if (https) return https;
  if (typeof value !== 'string' || !value.startsWith('http://')) return null;
  try {
    const original = new URL(value), validation = new URL(value); validation.protocol = 'https:';
    return adpickProductUrl(validation.href) ? original.href : null;
  } catch { return null; }
}
export const adpickDigest = (value: string): string => createHash('sha256').update(value).digest('hex');

export type AdpickCapabilities = {
  accountDigest: string | null; configured: { sdk: boolean; link: boolean; cookie: boolean };
  session: { outcome: string };
};
const READ_ROUTES = new Set(['capabilities', 'sdk-shopping', 'sdk-hotdeal', 'sdk-offers', 'session', 'malls',
  'categories', 'keywords', 'recommend', 'hotdeal', 'links', 'report', 'media', 'banner', 'campaigns', 'search']);

/** Both servers live on Vercel; the provider token is never passed to a merchant or redirect. */
export class AdpickServiceClient {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {
    if (!token || token.length < 32 || /\s/.test(token)) throw new AdpickServiceError('ADPICK_SERVICE_UNCONFIGURED');
  }
  async read(route: string, query: Record<string, string> = {}): Promise<unknown> {
    if (!READ_ROUTES.has(route)) throw new AdpickServiceError('ADPICK_OPERATION_INVALID');
    const params = new URLSearchParams(query);
    return this.request(route, params.toString());
  }
  async capabilities(): Promise<AdpickCapabilities> {
    const result = adpickObject(await this.read('capabilities'));
    const configured = adpickObject(result?.configured), session = adpickObject(result?.session);
    const account = result?.accountDigest;
    if (!configured || ['sdk', 'link', 'cookie'].some(k => typeof configured[k] !== 'boolean')
      || !session || typeof session.outcome !== 'string'
      || !(account === null || typeof account === 'string' && /^[a-f0-9]{64}$/.test(account)))
      throw new AdpickServiceError('ADPICK_CAPABILITIES_INVALID');
    return { accountDigest: account as string | null, configured: configured as AdpickCapabilities['configured'], session: { outcome: session.outcome } };
  }
  async issue(productUrl: string): Promise<string> {
    const url = adpickProductUrl(productUrl);
    if (!url) throw new AdpickServiceError('ADPICK_PRODUCT_URL_INVALID');
    const result = adpickObject(await this.request('sdk-link', '', { url }));
    const link = adpickShortLink(result?.link);
    if (!link) throw new AdpickServiceError('ADPICK_LINK_OUTCOME_UNKNOWN');
    return link;
  }
  private async request(route: string, query = '', body?: Record<string, unknown>): Promise<unknown> {
    try {
      const response = await this.fetchImpl(`${ADPICK_SERVICE_ORIGIN}/api/${route}${query ? `?${query}` : ''}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(25_000),
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 2_097_152) { await reader.cancel(); throw new AdpickServiceError('ADPICK_RESPONSE_TOO_LARGE'); }
        chunks.push(value);
      }
      if (!response.ok) throw new AdpickServiceError(response.status === 401 ? 'ADPICK_SERVICE_UNAUTHORIZED'
        : response.status === 503 ? 'ADPICK_PROVIDER_UNCONFIGURED' : 'ADPICK_SERVICE_REJECTED');
      if (!response.headers.get('content-type')?.includes('application/json')) throw new AdpickServiceError('ADPICK_RESPONSE_INVALID');
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof AdpickServiceError) throw error;
      throw new AdpickServiceError(body ? 'ADPICK_LINK_OUTCOME_UNKNOWN' : 'ADPICK_SERVICE_UNAVAILABLE');
    }
  }
}
