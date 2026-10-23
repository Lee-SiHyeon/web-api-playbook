import { record } from '../../native-handoff-envelope';
import { TOSS_ORIGIN, TOSS_SECTIONS, TossSessionClient, TossSessionError, tossErrorCode, tossId,
  tossSectionUrl, tossStopsSession, type TossSection } from '../../toss-session-core';
import { classifyHubTitle } from '../category';
import type { HubFacts, HubItem } from '../types';

export const TOSS_WRITER = 'toss:sharelink';
export const TOSS_LINK_CAP = 20;
/** Product-detail reads per run (2026-10-18: 20 → 50). The transport's request/time budget still bounds them; the runtime
 * stops detail reads early (without failing the run) when fewer than TOSS_DETAIL_RESERVE requests or 20 s remain. */
export const TOSS_DETAIL_CAP = 50;
export const TOSS_DETAIL_RESERVE = 6;
/** A delivery fee read within this window is reused for the same item so the detail reads rotate across the catalog. */
export const TOSS_DELIVERY_REUSE_MS = 24 * 3600_000;
export interface TossSurface { section: TossSection; tab: string | null; label: string | null }
export interface TossObservation {
  id: string; title: string; price: number | null; image: string | null;
  observedAt: string; facts: NonNullable<HubFacts['toss']>; expiresAt: string | null;
  linkAvailable: boolean | null; discountRate: number | null;
}
export interface TossCollection {
  products: TossObservation[]; fetched: number; pages: number; complete: boolean;
  errors: string[]; surfaces: number;
}
const label = (v: unknown): string | null => typeof v === 'string' && v.trim() && !/[\r\n\0]/.test(v)
  ? v.trim().slice(0, 300) : null;
const money = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const instant = (v: unknown): string | null => typeof v === 'string' && /(Z|[+-]\d\d:\d\d)$/.test(v)
  && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const imageUrl = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
};
export function nextTossNoon(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new TossSessionError('TOSS_INPUT_INVALID');
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3));
  if (end <= now) end.setUTCDate(end.getUTCDate() + 1);
  return end.toISOString();
}
/** Both regular slots and the extra 12:03 KST switch run have stable persistent identities. */
export function tossLogicalSlot(now: Date, switchRun = false): string {
  if (!Number.isFinite(now.getTime())) throw new TossSessionError('TOSS_INPUT_INVALID');
  const slot = new Date(now);
  if (switchRun) {
    slot.setUTCHours(3, 3, 0, 0);
    if (slot > now) slot.setUTCDate(slot.getUTCDate() - 1);
    return slot.toISOString();
  }
  slot.setUTCSeconds(0, 0);
  slot.setUTCMinutes(now.getUTCMinutes() < 30 ? 0 : 30);
  return slot.toISOString();
}
export function discoverTossSurfaces(body: unknown): { surfaces: TossSurface[]; complete: boolean } {
  const root = record(body), success = record(root?.success);
  if (root?.resultType !== 'SUCCESS' || !Array.isArray(success?.sections) || success.sections.length > 32) throw new TossSessionError('TOSS_RESPONSE_INVALID');
  const surfaces: TossSurface[] = [], keys = new Set<string>();
  for (const raw of success.sections) {
    const s = record(raw);
    if (!s || !TOSS_SECTIONS.includes(s.sectionCode as TossSection)) throw new TossSessionError('TOSS_OPERATION_REJECTED');
    const section = s.sectionCode as TossSection;
    if (section !== 'CATEGORY_BEST') {
      if (!keys.has(section)) { surfaces.push({ section, tab: null, label: label(s.displayName) }); keys.add(section); }
      continue;
    }
    if (!Array.isArray(s.tabs) || !s.tabs.length || s.tabs.length > 64) throw new TossSessionError('TOSS_RESPONSE_INVALID');
    for (const rawTab of s.tabs) {
      const t = record(rawTab), tab = String(t?.code ?? t?.tabCode ?? '');
      if (!/^\d{1,24}$/.test(tab)) throw new TossSessionError('TOSS_TAB_MISMATCH');
      const key = `${section}:${tab}`;
      if (!keys.has(key)) { surfaces.push({ section, tab, label: label(t?.name ?? t?.displayName ?? t?.title) }); keys.add(key); }
    }
  }
  // Twelve tabs are the observed baseline (2026-10-08), never a synthesized taxonomy.
  return { surfaces, complete: TOSS_SECTIONS.every(s => surfaces.some(f => f.section === s))
    && surfaces.filter(s => s.section === 'CATEGORY_BEST').length >= 12
    && success.limited === false && record(success.paging)?.nextCursor === null };
}
export function parseTossItem(raw: unknown, surface: TossSurface, observedAt: string): TossObservation | null {
  const item = record(raw), taca = record(item?.taca), p = record(taca?.productView), id = tossId(p?.tacaItemId);
  const title = label(p?.displayName);
  if (!id || !title) return null;
  const isSoldOut = typeof p?.isSoldOut === 'boolean' ? p.isSoldOut : null, status = label(p?.status);
  const soldStatus = ['SOLD_OUT', 'SOLDOUT', 'OUT_OF_STOCK'].includes(status ?? '');
  const liveStatus = ['ON_SALE', 'AVAILABLE', 'SALE'].includes(status ?? '');
  const conflict = (isSoldOut === false && soldStatus) || (isSoldOut === true && liveStatus);
  const stockStatus = conflict ? 'unknown' : isSoldOut === true || soldStatus ? 'sold_out'
    : isSoldOut === false || liveStatus ? 'in_stock' : 'unknown';
  const deal = record(item?.todayDeal), campaign = record(taca?.tagMeta);
  const startAt = instant(deal?.startAt), endAt = instant(deal?.endAt ?? campaign?.campaignEndAt);
  return { id, title, price: money(p?.displayPrice), image: imageUrl(p?.thumbnailUrl ?? p?.adImageUrl), observedAt,
    expiresAt: surface.section === 'TODAY_DEAL' ? nextTossNoon(new Date(observedAt)) : endAt,
    linkAvailable: typeof record(item?.linkIssueAvailability)?.available === 'boolean'
      ? record(item?.linkIssueAvailability)!.available as boolean : null,
    discountRate: typeof p?.discountRate === 'number' && p.discountRate >= 0 && p.discountRate <= 100 ? p.discountRate : null,
    facts: { provider: 'toss_sharelink', tacaItemId: id, tacaId: tossId(p?.tacaId), productId: tossId(p?.productId),
      stockId: tossId(p?.stockId), merchantId: tossId(p?.merchantId), sellerName: null,
      currency: 'KRW', priceKind: label(p?.priceCompositionType), shippingFeeKrw: null, eligibility: 'unverified',
      sectionCodes: [surface.section], categoryTabs: surface.tab ? [surface.tab] : [], observedAt,
      evidencePeriod: { startAt, endAt }, stockStatus, stockSignals: { isSoldOut, status, conflict } },
  };
}
export function parseTossPage(body: unknown, surface: TossSurface, at: string) {
  const root = record(body), s = record(root?.success), paging = record(s?.paging);
  if (root?.resultType !== 'SUCCESS' || s?.sectionCode !== surface.section || !Array.isArray(s.items) || s.items.length > 200
    || !paging || !Object.hasOwn(paging, 'nextCursor')) throw new TossSessionError('TOSS_RESPONSE_INVALID');
  if (surface.section === 'CATEGORY_BEST' && String(s.selectedTabCode) !== surface.tab) throw new TossSessionError('TOSS_TAB_MISMATCH');
  const cursor = paging.nextCursor;
  if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 8192 || /[\r\n]/.test(cursor))) throw new TossSessionError('TOSS_RESPONSE_INVALID');
  const products = s.items.map(raw => parseTossItem(raw, surface, at)).filter((x): x is TossObservation => x !== null);
  return { products, cursor: cursor as string | null, fetched: s.items.length,
    clean: s.limited === false && products.length === s.items.length
      && products.every(p => p.price !== null && p.facts.stockStatus !== 'unknown') };
}
export function mergeTossObservation(prior: TossObservation | undefined, next: TossObservation): TossObservation {
  if (!prior) return next;
  const newest = Date.parse(next.observedAt) >= Date.parse(prior.observedAt) ? next : prior;
  const sections = [...new Set([...prior.facts.sectionCodes, ...next.facts.sectionCodes])];
  const today = next.facts.sectionCodes.includes('TODAY_DEAL') ? next : prior.facts.sectionCodes.includes('TODAY_DEAL') ? prior : null;
  return { ...newest, expiresAt: today?.expiresAt ?? newest.expiresAt,
    facts: { ...newest.facts, sectionCodes: sections, categoryTabs: [...new Set([...prior.facts.categoryTabs, ...next.facts.categoryTabs])],
      evidencePeriod: today?.facts.evidencePeriod ?? newest.facts.evidencePeriod } };
}
export async function collectTossCurations(client: TossSessionClient, options: { pageLimit?: number; now?: () => Date } = {}): Promise<TossCollection> {
  const pageLimit = options.pageLimit ?? 50, now = options.now ?? (() => new Date());
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 50) throw new TossSessionError('TOSS_INPUT_INVALID');
  const home = client.bundle.readRequests['shopping-curation-sections'];
  if (!home) throw new TossSessionError('TOSS_OPERATION_NOT_CAPTURED');
  const inventory = discoverTossSurfaces(await client.read(home.url));
  const products = new Map<string, TossObservation>(), errors = new Set<string>();
  if (!inventory.complete) errors.add('TOSS_INVENTORY_PARTIAL');
  let pages = 0, fetched = 0, stopped = false;
  for (const surface of inventory.surfaces) {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < pageLimit; page++) {
      try {
        const body = await client.read(tossSectionUrl(surface.section, surface.tab, cursor));
        const parsed = parseTossPage(body, surface, now().toISOString());
        pages++; fetched += parsed.fetched;
        for (const item of parsed.products) products.set(item.id, mergeTossObservation(products.get(item.id), item));
        if (!parsed.clean) errors.add('TOSS_DATA_PARTIAL');
        if (products.size > 5000) throw new TossSessionError('TOSS_ITEM_LIMIT');
        cursor = parsed.cursor;
        if (cursor === null) break;
        if (cursors.has(cursor)) throw new TossSessionError('TOSS_CURSOR_CYCLE');
        cursors.add(cursor);
        if (page + 1 === pageLimit) errors.add('TOSS_PAGE_LIMIT');
      } catch (error) {
        const code = tossErrorCode(error); errors.add(code);
        if (tossStopsSession(code)) throw error; // Preserve the transport's closed diagnostics through the vault/run receipt.
        stopped = ['TOSS_TIME_LIMIT', 'TOSS_REQUEST_LIMIT', 'TOSS_ITEM_LIMIT'].includes(code);
        break;
      }
    }
    if (stopped) break;
  }
  return { products: [...products.values()], fetched, pages, surfaces: inventory.surfaces.length, complete: errors.size === 0, errors: [...errors] };
}
/** Delivery facts read from Toss's product detail (GET /api-public/v3/shopping/sharelink/v2/products/{tacaItemId}).
 * The verified field is success.priceInfo.defaultDeliveryFee (aco produce-compare enrichToss, live-replayed 2026-09-28).
 * Hub runs until 2026-10-18 read success.deliveryFee as a plain number and every live item stayed '배송비 미확인' while the
 * seller name was filled, so the fee is not there in that form. The other paths below are defensive guesses for the same
 * fee and for a conditional free-shipping threshold; a missing or unfamiliar shape stays unknown (never free shipping). */
export interface TossDelivery { feeKrw: number | null; freeThresholdKrw: number | null; feeField: string | null; thresholdField: string | null }
const FEE_KEYS = ['defaultDeliveryFee', 'deliveryFee', 'baseDeliveryFee', 'basicDeliveryFee', 'shippingFee', 'deliveryPrice', 'fee', 'amount', 'baseFee', 'price'];
const THRESHOLD_KEYS = ['freeDeliveryMinPrice', 'freeDeliveryMinimumPrice', 'freeDeliveryMinAmount', 'freeDeliveryThreshold', 'freeDeliveryThresholdPrice',
  'freeDeliveryConditionPrice', 'freeDeliveryConditionAmount', 'conditionalFreeDeliveryPrice', 'conditionalFreeDeliveryMinPrice',
  'freeShippingThreshold', 'freeShippingMinPrice', 'freeConditionAmount', 'freeConditionPrice', 'minimumOrderPriceForFreeDelivery'];
const wonField = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*[\d,]{1,9}\s*원?\s*$/.test(v) ? Number(v.replace(/[^\d]/g, '')) : NaN;
  return Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000 ? n : null;
};
export function tossDeliveryFromDetail(detail: Record<string, unknown>): TossDelivery {
  const containers: Array<[string, Record<string, unknown> | null]> = [['priceInfo', record(detail.priceInfo)], ['deliveryInfo', record(detail.deliveryInfo)],
    ['deliveryFee', record(detail.deliveryFee)], ['delivery', record(detail.delivery)], ['shippingInfo', record(detail.shippingInfo)],
    ['priceInfo.deliveryFee', record(record(detail.priceInfo)?.deliveryFee)], ['deliveryInfo.deliveryFee', record(record(detail.deliveryInfo)?.deliveryFee)]];
  let feeKrw: number | null = null, feeField: string | null = null, freeThresholdKrw: number | null = null, thresholdField: string | null = null;
  const plain = wonField(detail.deliveryFee);
  if (plain !== null) { feeKrw = plain; feeField = 'deliveryFee'; }
  for (const [name, box] of containers) {
    if (!box) continue;
    // priceInfo also carries the item price: only delivery-named keys are read there.
    for (const key of name === 'priceInfo' ? FEE_KEYS.filter(k => /deliver|ship/i.test(k)) : FEE_KEYS) {
      if (feeKrw !== null) break;
      const v = wonField(box[key]);
      if (v !== null) { feeKrw = v; feeField = `${name}.${key}`; }
    }
    for (const key of THRESHOLD_KEYS) {
      if (freeThresholdKrw !== null) break;
      const v = wonField(box[key]);
      if (v !== null && v > 0) { freeThresholdKrw = v; thresholdField = `${name}.${key}`; }
    }
  }
  // A threshold without a fee is not a fee.
  return feeKrw === null ? { feeKrw: null, freeThresholdKrw: null, feeField: null, thresholdField: null } : { feeKrw, freeThresholdKrw, feeField, thresholdField };
}
/** Safe shape of the delivery-related part of a detail response (keys and short scalar values only; no URLs, no long text),
 * logged on the first reads of a run so the real field names are visible in the Vercel log. */
export function tossDeliveryShape(detail: Record<string, unknown>): Record<string, unknown> {
  const scalar = (v: unknown): unknown => typeof v === 'number' || typeof v === 'boolean' || v === null ? v
    : typeof v === 'string' ? (v.length <= 40 && !/https?:|[\r\n]/i.test(v) ? v : `string(${v.length})`)
    : Array.isArray(v) ? `array(${v.length})` : typeof v;
  const flat = (box: Record<string, unknown> | null, depth = 0): Record<string, unknown> | null => box ? Object.fromEntries(Object.entries(box).slice(0, 40)
    .map(([k, v]) => [k, record(v) && depth < 1 ? flat(record(v), depth + 1) : scalar(v)])) : null;
  const out: Record<string, unknown> = { topKeys: Object.keys(detail).slice(0, 60) };
  for (const [k, v] of Object.entries(detail)) if (/deliver|ship|fee|price/i.test(k)) out[k] = record(v) ? flat(record(v)) : scalar(v);
  return out;
}
/** Effective fee for the observed price: 0 once the price reaches a free-shipping threshold. */
export function tossEffectiveShipping(feeKrw: number | null, freeThresholdKrw: number | null, price: number | null): number | null {
  if (feeKrw === null) return null;
  if (freeThresholdKrw !== null) return price === null ? null : price >= freeThresholdKrw ? 0 : feeKrw;
  return feeKrw;
}
/** Detail endpoint is observed in client-core.mjs. Only exact option/seller/shipping fields are projected. */
export function enrichTossDetail(item: TossObservation, body: unknown): TossObservation {
  const detail = record(record(body)?.success);
  if (!detail) throw new TossSessionError('TOSS_RESPONSE_INVALID');
  const product = record(detail.productView) ?? record(record(detail.taca)?.productView);
  if (product?.tacaItemId !== undefined && tossId(product.tacaItemId) !== item.id) throw new TossSessionError('TOSS_PRODUCT_MISMATCH');
  const merchant = record(detail.merchantInfo);
  // Unknown shape/fee stays unknown. Do not infer free shipping from a delivery type or missing field.
  const delivery = tossDeliveryFromDetail(detail);
  return withTossDelivery({ ...item, facts: { ...item.facts, sellerName: label(merchant?.name) } }, delivery.feeKrw, delivery.freeThresholdKrw, item.observedAt);
}
export function withTossDelivery(item: TossObservation, feeKrw: number | null, freeThresholdKrw: number | null, readAt: string): TossObservation {
  return { ...item, facts: { ...item.facts, shippingFeeKrw: tossEffectiveShipping(feeKrw, freeThresholdKrw, item.price),
    displayedShippingFeeKrw: feeKrw, freeShippingThresholdKrw: feeKrw === null ? null : freeThresholdKrw,
    shippingReadAt: feeKrw === null ? null : readAt } };
}
/** The note the hub shows and Grok Bot's quick-fact parser (aco toss-hub-feed parseTossShippingNote) reads:
 * '무료배송 · 적용 조건 미확인' (0), '표시 배송비 N원 · 적용 조건 미확인', '표시 배송비 N원 (M원 이상 무료) · 적용 조건 미확인'. */
export function tossShippingNote(facts: NonNullable<HubFacts['toss']>): string {
  const fee = facts.displayedShippingFeeKrw ?? facts.shippingFeeKrw;
  if (fee === null || fee === undefined) return '배송비 미확인';
  const threshold = facts.freeShippingThresholdKrw ?? null;
  if (fee === 0) return '무료배송 · 적용 조건 미확인';
  return `표시 배송비 ${fee.toLocaleString('ko-KR')}원${threshold ? ` (${threshold.toLocaleString('ko-KR')}원 이상 무료)` : ''} · 적용 조건 미확인`;
}
const SECTION_TAGS: Record<string, string> = { TODAY_DEAL: '오늘의 특가', BEST_SELLING: '많이 팔린 상품',
  TRENDING: '인기 상승', CATEGORY_BEST: '카테고리 베스트', MOST_ISSUED: '공유 인기', GOOD_PRICE: '가격 추천', HIGH_CONVERSION: '구매 전환 인기' };
export function toTossHubItem(item: TossObservation, affiliateUrl: string): HubItem {
  return { id: `toss:${item.id}`, kind: 'hotdeal', category: classifyHubTitle(item.title), title: item.title,
    store: item.facts.sellerName ?? '토스쇼핑', priceKrw: item.price, imageUrl: item.image,
    shippingNote: tossShippingNote(item.facts),
    source: 'toss', sourceUrl: `${TOSS_ORIGIN}/home`, affiliateUrl, targetUrl: null,
    postedAt: item.observedAt, updatedAt: item.observedAt, observedAt: item.observedAt, expiresAt: item.expiresAt,
    comments: null, votes: null, views: null, tags: [...item.facts.sectionCodes.map(s => SECTION_TAGS[s]),
      ...(item.discountRate ? [`${item.discountRate}%`] : [])], summary: '토스 표시 가격 · 쿠폰 및 계정별 적용 조건 미확인',
    ended: item.facts.stockStatus === 'sold_out', facts: { toss: item.facts } };
}
/** At most this many of the per-run detail reads go to the priority tier, so the rest of the list keeps rotating. */
export const TOSS_DETAIL_PRIORITY_CAP = 35;
const tossPostLikely = (p: TossObservation) => p.facts.sectionCodes.includes('TODAY_DEAL') || (p.discountRate ?? 0) >= 20;
/** Detail-read order (owner 2026-10-18 23:16): items whose fee was never read and that are likely to be posted (today's deal or
 * 20%+ off; most discounted first, then the curation's own order, which lists the newest first; at most TOSS_DETAIL_PRIORITY_CAP),
 * then the other never-read items, the rest of the likely ones, and items whose earlier fee is older than 24 h. The last two tiers rotate per half-hour slot so a fee that stays unreadable
 * does not hold the same slots every run. */
export function orderTossDetailReads(unread: TossObservation[], stale: ReadonlySet<string>, slot = Math.floor(Date.now() / 1_800_000)): TossObservation[] {
  const rotate = (list: TossObservation[]) => { const start = list.length ? (slot * TOSS_DETAIL_CAP) % list.length : 0; return [...list.slice(start), ...list.slice(0, start)]; };
  const fresh = unread.filter(p => !stale.has(p.id));
  const hot = fresh.map((p, i) => ({ p, i })).filter(({ p }) => tossPostLikely(p))
    .sort((a, b) => (b.p.discountRate ?? 0) - (a.p.discountRate ?? 0) || a.i - b.i).map(({ p }) => p);
  const first = hot.slice(0, TOSS_DETAIL_PRIORITY_CAP), firstIds = new Set(first.map(p => p.id));
  const rest = rotate(fresh.filter(p => !firstIds.has(p.id) && !tossPostLikely(p)));
  const overflow = hot.slice(TOSS_DETAIL_PRIORITY_CAP);
  return [...first, ...rest, ...rotate(overflow), ...rotate(unread.filter(p => stale.has(p.id)))];
}
