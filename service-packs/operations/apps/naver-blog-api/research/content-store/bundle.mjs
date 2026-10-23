import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { hash } from './collect.mjs';
import { targetIdentity, verifyMyrealtripRedirect } from './myrealtrip.mjs';

export function normalizeAffiliates(rows) {
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('AFFILIATE_INPUT');
  const seen = new Set();
  return rows.map(p => {
    if (p.provider === 'myrealtrip') {
      const target = targetIdentity(p.targetUrl);
      if (target.productId !== p.productId || p.field !== 'travel' || !p.title || !Number.isFinite(Date.parse(p.collectedAt))
        || !/^https:\/\/myrealt\.rip\/[A-Za-z0-9]+$/.test(p.affiliateUrl || '') || !/^\d+$/.test(p.linkId || '')) throw new Error('AFFILIATE_SCHEMA');
      return { provider: p.provider, field: 'travel', ...target, title: String(p.title).slice(0, 300),
        description: String(p.description || '').slice(0, 1000), affiliateUrl: p.affiliateUrl, linkId: p.linkId,
        collectedAt: p.collectedAt, linkCreatedAt: p.linkCreatedAt, expiresAt: p.expiresAt || null, priceKrw: null,
        ownershipEvidence: p.ownershipEvidence === 'historical_owner_verified_receipt' ? p.ownershipEvidence : 'unverified',
        sourceKind: 'independent_http_receipt', landingVerified: false, priceRecheckRequiredBeforePublication: true };
    }
    if (p.provider !== 'coupang' || !/^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]+$/.test(p.affiliateUrl || '')
      || !['ai', 'travel', 'deals', 'finance'].includes(p.field) || !p.title
      || !['productId', 'itemId', 'vendorItemId'].every(k => /^\d+$/.test(p[k] || ''))
      || !Number.isFinite(Date.parse(p.collectedAt))) throw new Error('AFFILIATE_SCHEMA');
    // Explicit projection: do not upload session state, account identifiers or arbitrary capture fields.
    return { provider: p.provider, field: p.field, title: String(p.title).slice(0, 300),
      productId: p.productId, itemId: p.itemId, vendorItemId: p.vendorItemId,
      priceKrw: Number.isFinite(p.priceKrw) && p.priceKrw >= 0 ? p.priceKrw : null,
      affiliateUrl: p.affiliateUrl, collectedAt: p.collectedAt,
      ownershipEvidence: p.ownershipEvidence === 'generated_in_authenticated_user_browser' ? p.ownershipEvidence : 'unverified',
      landingVerified: false, sourceKind: 'authenticated_partners_browser',
      collectionStatus: 'link_collected', priceRecheckRequiredBeforePublication: true };
  }).filter(p => { const key = `${p.provider}:${p.productId}:${p.targetUrl || `${p.itemId}:${p.vendorItemId}`}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

export async function verifyCoupangRedirect(product, { fetchImpl = globalThis.fetch } = {}) {
  let current = product.affiliateUrl;
  const hops = [];
  for (let i = 0; i < 5; i++) {
    const url = new URL(current);
    if (url.protocol !== 'https:' || !['link.coupang.com', 'www.coupang.com', 'm.coupang.com'].includes(url.hostname)
      || url.username || url.password) return { verified: false, reason: 'unexpected_redirect_host', hops };
    try {
      const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      hops.push({ host: url.hostname, status: response.status });
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) { current = new URL(location, url).href; continue; }
      const matches = ['www.coupang.com', 'm.coupang.com'].includes(url.hostname)
        && url.pathname === `/vp/products/${product.productId}`
        && url.searchParams.get('itemId') === product.itemId && url.searchParams.get('vendorItemId') === product.vendorItemId;
      return { verified: response.status === 200 && matches, reason: response.status !== 200 ? 'landing_http_blocked' : matches ? 'exact_product_variant' : 'target_mismatch', hops, checkedAt: new Date().toISOString() };
    } catch { return { verified: false, reason: 'redirect_transport_failure', hops }; }
  }
  return { verified: false, reason: 'redirect_limit', hops };
}

export async function main(args) {
  const [collectionPath, affiliatesPath, output] = args;
  if (!output) throw new Error('Use bundle.mjs COLLECTION_JSON AFFILIATES_JSON NEW_OUTPUT_JSON');
  const collection = JSON.parse(await readFile(collectionPath, 'utf8'));
  if (collection.kind !== 'content_collection') throw new Error('COLLECTION_SCHEMA');
  const affiliates = normalizeAffiliates(JSON.parse(await readFile(affiliatesPath, 'utf8')));
  for (const product of affiliates) { product.redirectCheck = await (product.provider === 'myrealtrip' ? verifyMyrealtripRedirect(product) : verifyCoupangRedirect(product)); product.landingVerified = product.redirectCheck.verified; }
  const record = { schemaVersion: 1, kind: 'content_store_bundle', checkedAt: new Date().toISOString(), collection, affiliates };
  const bytes = JSON.stringify(record, null, 2) + '\n';
  await writeFile(output, bytes, { flag: 'wx' });
  console.log(JSON.stringify({ output, sha256: hash(bytes), candidates: collection.candidates.length, affiliateProducts: affiliates.length, redirects: affiliates.map(p => ({ productId: p.productId, ...p.redirectCheck })) }));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch(() => { console.error('BUNDLE_FAILED'); process.exitCode = 1; });
