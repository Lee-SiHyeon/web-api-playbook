import { normalizeCoupangExactProductTarget } from '../../coupang-partner-link-issue-core';

const IDENTITY = /^[1-9][0-9]{0,19}:[1-9][0-9]{0,19}:[1-9][0-9]{0,19}$/;
const SHORT = /^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]{1,64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = (): never => { throw new Error('COUPANG_LINK_LOOKUP_RESPONSE_INVALID'); };

/** Own discovery CAS refreshes metadata; the original claim still owns the token/fence. */
export function currentCoupangLinkLookupRevision(value: unknown, sessionId: string, originalRevision: number): number {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!row || row.id !== sessionId || row.kind !== 'web_session' || row.status !== 'ready'
    || row.hasCredential !== true || row.leaseBusy !== true || !Number.isSafeInteger(originalRevision)
    || originalRevision < 1 || !Number.isSafeInteger(row.revision) || Number(row.revision) < originalRevision)
    throw new Error('COUPANG_LINK_LOOKUP_SCOPE_INVALID');
  return Number(row.revision);
}

/** Preserve all three seller-option IDs; no product-only association or generated URL is permitted. */
export function uniqueCoupangLinkIdentities(identities: readonly string[]): string[] {
  if (!Array.isArray(identities) || identities.length > 1000 || identities.some(id => typeof id !== 'string' || !IDENTITY.test(id)))
    throw new Error('COUPANG_LINK_LOOKUP_INPUT_INVALID');
  return [...new Set(identities)];
}
export function parseCoupangIssuedLinkLookup(value: unknown, requested: readonly string[]): Map<string, string> {
  if (!Array.isArray(value) || value.length > 200) return fail();
  const allowed = new Set(uniqueCoupangLinkIdentities(requested)), links = new Map<string, string>();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(key => !['product_identity', 'product_url', 'short_url', 'issue_id'].includes(key))
      || typeof row.product_identity !== 'string'
      || !allowed.has(row.product_identity) || typeof row.short_url !== 'string' || !SHORT.test(row.short_url)
      || typeof row.issue_id !== 'string' || !UUID.test(row.issue_id)
      || normalizeCoupangExactProductTarget(row.product_url)?.identity !== row.product_identity
      || links.has(row.product_identity)) return fail();
    links.set(row.product_identity, row.short_url);
  }
  return links;
}
