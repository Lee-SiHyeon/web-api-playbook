// 네이버 쇼핑 커넥트 상품 검색 (web-api-playbook brandconnect.mjs shopping-search, read-only, owner's DPAPI session).
// Returns affiliate-enabled products as { productId, storeName, brandStore, title, price, listPrice, commissionRate, productUrl, linkUrl }.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PLAYBOOK = process.env.WEB_API_PLAYBOOK || 'C:/Users/User/Documents/GitHub/web-api-playbook';

export function mapBrandconnectProducts(data) {
  return (data?.data ?? []).filter(p => p && p.enabled === true && p.storeStatus === 'ACTIVE' && !p.affiliateStorePenalty).map(p => ({
    productId: String(p.id), storeName: p.storeName ?? null, brandStore: p.brandStore === true, title: p.productName ?? '',
    price: Number.isFinite(p.discountedSalePrice) ? p.discountedSalePrice : null, listPrice: Number.isFinite(p.salePrice) ? p.salePrice : null,
    commissionRate: (p.commissionRate ?? 0) + (p.promotionCommissionRate ?? 0), productUrl: p.productUrl ?? null, linkUrl: p.shortenUrl ?? null,
  }));
}

export function brandconnectSearch({ run } = {}) {
  const exec = run ?? (input => {
    const r = spawnSync(process.execPath, [path.join(PLAYBOOK, 'scripts', 'brandconnect.mjs'), 'shopping-search'],
      { cwd: PLAYBOOK, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 120000 });
    try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { ok: false, code: 'NON_JSON_OUTPUT' }; }
  });
  return async query => {
    const j = exec({ query, limit: 20 });
    if (!j?.ok) throw Object.assign(new Error(j?.code ?? 'BRANDCONNECT_FAILED'), { code: `BRANDCONNECT_${j?.code ?? 'FAILED'}` });
    return mapBrandconnectProducts(j.data);
  };
}
