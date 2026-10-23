// Only projected public fields leave the local, trusted receipt importer.
export function targetIdentity(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) throw new Error('MRT_TARGET');
  const hotel = u.hostname === 'accommodation.myrealtrip.com' && u.pathname.match(/^\/union\/products\/(\d+)$/);
  const offer = u.hostname === 'www.myrealtrip.com' && u.pathname.match(/^\/offers\/(\d+)$/);
  const promo = ['myrealtrip.com', 'www.myrealtrip.com'].includes(u.hostname) && u.pathname.match(/^\/promotions\/([A-Za-z0-9_-]+)$/);
  if (!(hotel || offer || promo)) throw new Error('MRT_TARGET');
  const allowed = hotel ? ['checkIn', 'checkOut', 'adultCount', 'childCount'] : [];
  for (const key of u.searchParams.keys()) if (!allowed.includes(key) || u.searchParams.getAll(key).length !== 1) throw new Error('MRT_TARGET');
  return { productId: (hotel || offer || promo)[1], targetUrl: u.href };
}

export function fromMyrealtripReceipt(receipt, product, expectedAccountFingerprint) {
  if (!/^[a-f0-9]{64}$/.test(expectedAccountFingerprint || '') || receipt.accountFingerprint !== expectedAccountFingerprint
    || receipt.source !== 'independent_http' || receipt.status !== 200 || receipt.ownerVerified !== true
    || receipt.operation !== 'myrealtripCreateLink' || !Number.isFinite(Date.parse(receipt.checkedAt))
    || !Number.isSafeInteger(receipt.data?.id) || receipt.data.id < 1
    || !/^https:\/\/myrealt\.rip\/[A-Za-z0-9]+$/.test(receipt.data.mylink || '')) throw new Error('MRT_OWNER_RECEIPT');
  const target = targetIdentity(receipt.targetUrl);
  if (product.productUrl !== target.targetUrl || !product.title || !Number.isFinite(Date.parse(product.checkedAt))) throw new Error('MRT_PRODUCT_BINDING');
  return { provider: 'myrealtrip', field: 'travel', ...target, title: String(product.title).slice(0, 300),
    description: String(product.description || '').slice(0, 1000), affiliateUrl: receipt.data.mylink,
    linkId: String(receipt.data.id), collectedAt: product.checkedAt, linkCreatedAt: receipt.checkedAt,
    ownershipEvidence: 'historical_owner_verified_receipt', sourceKind: 'independent_http_receipt',
    priceKrw: null, expiresAt: product.expiresAt || null, landingVerified: false,
    priceRecheckRequiredBeforePublication: true, collectionStatus: 'historical_link_imported' };
}

export async function verifyMyrealtripRedirect(product, { fetchImpl = globalThis.fetch } = {}) {
  let response;
  const checkedAt = new Date().toISOString();
  try {
    const target = new URL(targetIdentity(product.targetUrl).targetUrl);
    if (!/^https:\/\/myrealt\.rip\/[A-Za-z0-9]+$/.test(product.affiliateUrl || '') || !/^\d+$/.test(product.linkId || '')) throw new Error('MRT_INPUT');
    response = await fetchImpl(product.affiliateUrl, { redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { accept: 'text/html' } });
    if (response.redirected || ![301, 302, 303, 307, 308].includes(response.status)) throw new Error('MRT_REDIRECT');
    const bridge = new URL(response.headers.get('location'));
    if (bridge.origin !== 'https://www.myrealtrip.com' || bridge.username || bridge.password || bridge.pathname !== '/main/bridge/marketing'
      || bridge.searchParams.getAll('return_url').length !== 1) throw new Error('MRT_BRIDGE');
    const dest = new URL(bridge.searchParams.get('return_url'));
    if (dest.origin !== target.origin || dest.pathname !== target.pathname || dest.username || dest.password) throw new Error('MRT_DESTINATION');
    for (const key of target.searchParams.keys()) if (JSON.stringify(dest.searchParams.getAll(key)) !== JSON.stringify(target.searchParams.getAll(key))) throw new Error('MRT_VARIANT');
    if (dest.searchParams.getAll('mylink_id').length !== 1 || dest.searchParams.get('mylink_id') !== product.linkId) throw new Error('MRT_ATTRIBUTION');
    return { verified: true, checkedAt, method: 'independent_http_redirect', status: response.status, destinationMatches: true, attributionMatches: true, credentialSent: false, productPageFetched: false };
  } catch (error) {
    return { verified: false, checkedAt, reason: /^MRT_[A-Z_]+$/.test(error.message) ? error.message : 'MRT_TRANSPORT', credentialSent: false };
  } finally { await response?.body?.cancel().catch(() => {}); }
}
