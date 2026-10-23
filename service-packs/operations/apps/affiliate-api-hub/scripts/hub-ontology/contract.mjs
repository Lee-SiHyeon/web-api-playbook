// Shared HubItem validator. Pure: no network, credentials, or filesystem writes.
export const HUB_KINDS = Object.freeze(['hotdeal', 'travel', 'benefit', 'opportunity', 'ranking', 'trend', 'news']);
export const HUB_CATEGORIES = Object.freeze(['food', 'living', 'digital', 'pc', 'game', 'fashion', 'beauty', 'baby', 'pet', 'travel', 'coupon', 'etc']);
const FIELDS = ['id', 'kind', 'category', 'title', 'store', 'priceKrw', 'shippingNote', 'imageUrl', 'source', 'sourceUrl', 'affiliateUrl', 'postedAt', 'expiresAt', 'comments', 'votes', 'views', 'tags', 'summary', 'ended'];
export function isHttpsUrl(value) {
  if (typeof value !== 'string' || /\s/.test(value)) return false;
  try { const u = new URL(value); return u.protocol === 'https:' && Boolean(u.hostname) && !u.username && !u.password; } catch { return false; }
}
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
export function validateHubItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return ['item must be an object'];
  const errors = FIELDS.filter(key => !Object.hasOwn(item, key)).map(key => key + ' is required');
  if (typeof item.id !== 'string' || !/^[a-z0-9_-]{2,20}:[^\s]{1,160}$/i.test(item.id)) errors.push('id');
  if (!HUB_KINDS.includes(item.kind)) errors.push('kind');
  if (!HUB_CATEGORIES.includes(item.category)) errors.push('category');
  if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 300) errors.push('title');
  if (typeof item.source !== 'string' || !/^[a-z0-9_-]{2,20}$/i.test(item.source)) errors.push('source');
  for (const [key, max] of [['store', 60], ['shippingNote', 60]]) if (item[key] !== null && (typeof item[key] !== 'string' || item[key].length > max)) errors.push(key);
  if (item.priceKrw !== null && (!Number.isSafeInteger(item.priceKrw) || item.priceKrw < 0)) errors.push('priceKrw');
  if (!isHttpsUrl(item.sourceUrl)) errors.push('sourceUrl');
  for (const key of ['imageUrl', 'affiliateUrl']) if (item[key] !== null && !isHttpsUrl(item[key])) errors.push(key);
  if (!iso(item.postedAt)) errors.push('postedAt');
  if (item.expiresAt !== null && !iso(item.expiresAt)) errors.push('expiresAt');
  for (const key of ['comments', 'votes', 'views']) if (item[key] !== null) errors.push(key);
  if (!Array.isArray(item.tags) || item.tags.length > 12 || item.tags.some(tag => typeof tag !== 'string' || tag.length > 30)) errors.push('tags');
  if (typeof item.summary !== 'string' || item.summary.length > 400) errors.push('summary');
  if (typeof item.ended !== 'boolean') errors.push('ended');
  return errors;
}
export function assertHubItem(item) {
  const errors = validateHubItem(item);
  if (errors.length) throw Object.assign(new Error('Invalid HubItem: ' + errors.join(', ')), { code: 'HUB_ITEM_INVALID', errors });
  return item;
}
