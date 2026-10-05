export const CATALOG_SERVICES = Object.freeze(['catalog', 'commerce', 'aliexpress', 'aliexpress-partner', 'amazon',
  'amazon-partner', 'oliveyoung', 'oliveyoung-public', 'oliveyoung-global', 'shopee-affiliate-id', 'rakuten-ichiba', 'rakuten-public', 'sephora', 'ulta',
  'shopify-storefronts', 'ebay', 'ebay-partner']);

/** Scope exclusion changes the requested audit, not the original capability status. */
export function catalogScopeAudit(audit) {
  const include = cap => /(?:^|\.)(?:catalog|collection|search|product|price|reviews?|details?|variants?|stock|listing|item|description|images|options|ratings?|categories|pagination)[._]/.test(cap.id) ||
    /^(?:storefront\.(?:anonymous|product|detail|review|description|media|sku|price)|affiliate\.(?:catalog_search|product_lookup|price_and_commission_fields))/.test(cap.id);
  const capabilities = audit.capabilities.filter(include);
  const requiredGaps = capabilities.filter(cap => cap.priority === 'required' && !cap.gatePassed).map(cap => cap.id);
  return { ...audit, scope: 'catalog', excludedFromScope: audit.capabilities.filter(cap => !include(cap)).map(cap => cap.id),
    capabilities, summary: { ...audit.summary, total: capabilities.length,
      recordedLive: capabilities.filter(cap => cap.status === 'recorded_live').length,
      needsReverification: capabilities.filter(cap => cap.status === 'needs_reverification').length,
      requiredGaps, strictPassed: requiredGaps.length === 0 } };
}
