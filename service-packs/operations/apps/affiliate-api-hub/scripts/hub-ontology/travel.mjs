import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { fetchPlatformDeals } from '../../../naver-blog-api/research/content-store/travel-deals-platforms.mjs';
import { checkHotdeals } from '../../../naver-blog-api/research/content-store/travel-price/hotdeals/hotdeal-check.mjs';
import { REPO, text, https, integer, iso, observation, recent, stableId, tags, currentItems, publicFetch, readSnapshots, issuedTravelLinks, dryRun } from './travel-ranking-data.mjs';

let diagnostics = { sources: [], blocked: [] };
export const getDiagnostics = () => structuredClone(diagnostics);
const STORES = { ttang: '땡처리닷컴', myrealtrip: '마이리얼트립', naver_travel: '네이버 여행핫딜', naver_flight: '네이버 항공', tripcom: '트립닷컴', yeogi: '여기어때', nol: 'NOL' };
function provider(url, hint) {
  const host = new URL(url).hostname;
  if (/(^|\.)myrealtrip\.com$/.test(host)) return 'myrealtrip';
  if (/(^|\.)ttang\.com$/.test(host)) return 'ttang';
  if (host === 'pkgtour.naver.com' || host === 'travel-event.naver.com') return 'naver_travel';
  if (host === 'flight.naver.com') return 'naver_flight';
  if (/(^|\.)trip\.com$/.test(host)) return 'tripcom';
  if (/(^|\.)yeogi\.com$/.test(host) || host === 'api3.goodchoice.kr' || host === 'www.goodchoice.kr') return 'yeogi';
  if (/(^|\.)yanolja\.com$/.test(host)) return 'nol';
  return /^[a-z0-9_-]{2,20}$/i.test(hint ?? '') ? hint : 'travel_offer';
}
function earliest(values) { return values.filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null; }
function identityUrl(value) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|reqChannel$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.hash = '';
  try { return decodeURIComponent(url.href); } catch { return url.href; }
}
function departure(row, url) {
  const date = row.departDate ?? row.departureDate ?? row.startDate ?? row.detail?.startDate ?? row.deal?.travelStart;
  const coded = new URL(url).hostname === 'pkgtour.naver.com' ? new URL(url).pathname.match(/-(\d{8})$/)?.[1] : null;
  const checkin = new URL(url).searchParams.get('checkIn') ?? new URL(url).searchParams.get('checkin');
  return iso(date ?? coded ?? checkin);
}

// Maps only observed URLs; prices retain their displayed/from/base-fare scope.
export function mapTravelRows(rows, { now = new Date(), checkedAt = null, source = null, links = {} } = {}) {
  const out = [];
  for (const row of rows ?? []) {
    if (row.channel && row.channel !== 'travel') continue;
    const flight = row.verified;
    if (row.route && (row.deal !== true || flight?.ok !== true)) continue;
    const url = https(flight?.link ?? row.landingUrl ?? row.productUrl ?? row.targetUrl ?? row.url ?? row.sourceUrl);
    const title = text(row.title ?? row.name ?? row.productTitle ?? (row.route ? `${row.route} ${flight?.airline ?? ''} 항공권` : ''), 300);
    const at = observation(row, checkedAt);
    if (!url || !title || !recent(at, now, row.route ? 24 : 72) || row.ended === true || row.soldOut === true || row.available === false
      || ['expired', 'ended', 'sold_out'].includes(row.status)) continue;
    const key = row.route ? 'naver_flight' : provider(url, source ?? row.source);
    const deal = row.deal && typeof row.deal === 'object' ? row.deal : {};
    const pick = row.cheapest?.[0];
    const departAt = departure({ ...row, departureDate: pick?.departureDate ?? row.departureDate }, url);
    const expiresAt = earliest([iso(row.expiresAt, { endOfDay: true }), iso(row.endsAtUtc), iso(row.endsAtKst),
      iso(row.endDate, { endOfDay: true }), iso(deal.bookingEnd, { endOfDay: true }), departAt]);
    if (expiresAt && Date.parse(expiresAt) <= now.getTime()) continue;
    const price = integer(flight?.price ?? row.priceKrw ?? row.discountedPrice ?? row.discountedSalePrice ?? row.salePrice ?? row.priceFrom ?? deal.priceFrom);
    const priceText = text(deal.priceText, 200);
    const whenLabel = /[?&]check[Ii]n=/.test(url) ? '체크인' : '출발';
    const note = text(row.shippingNote ?? row.perk ?? (departAt ? `${whenLabel} ${new Date(Date.parse(departAt) + 9 * 3600_000).toISOString().slice(0, 10)}` : ''), 60) || null;
    const facts = [priceText, row.priceIsFrom === true ? '표시 시작가' : null,
      text(row.discountText, 180), text(row.perk, 120), text(deal.destination, 80),
      row.route && flight?.nonstop === true ? '직항' : null,
      row.route && row.priceScope ? text(row.priceScope, 100) : null,
      text(row.detail?.duration, 60),
      pick?.returnDate ? `귀국 ${pick.returnDate}` : null].filter(Boolean);
    const identity = `${identityUrl(url)}${departAt ? '@' + departAt.slice(0, 10) : ''}`;
    out.push({ id: stableId(key, identity), kind: 'travel', category: 'travel', title,
      store: text(row.store ?? row.storeName ?? row.publisher ?? deal.seller ?? STORES[key], 60) || null,
      priceKrw: price, shippingNote: note, imageUrl: https(row.imageUrl ?? row.image ?? row.thumbnailUrl ?? row.detail?.imageUrl), source: key,
      sourceUrl: url, affiliateUrl: https(links[url] ?? row.affiliateUrl ?? row.shortUrl ?? row.link), postedAt: at, expiresAt,
      comments: null, votes: null, views: null, tags: tags([...(deal.badges ?? []), ...(row.tags ?? []), row.kind === 'travel_hotdeal' ? '여행핫딜' : null]),
      summary: text(facts.join(' · '), 400), ended: false });
  }
  return currentItems(out, now);
}

export function mapTravelSnapshot(data, options = {}) {
  if (!data || typeof data !== 'object') return [];
  const checkedAt = observation(data, options.checkedAt);
  const rows = Array.isArray(data) ? data : data.rows ?? data.items ?? data.products ?? data.travel?.flatMap(x => x.items ?? []) ?? [];
  return mapTravelRows(rows, { ...options, checkedAt });
}

async function catalogFallback(now, links) {
  const file = join(REPO, 'apps/content-catalog/data/catalog.db');
  const { DatabaseSync } = await import('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const builtAt = db.prepare("SELECT value FROM meta WHERE key = 'builtAt'").get()?.value ?? null;
    const rows = db.prepare("SELECT checked_at, product_id, name, store_name, url, discounted_price, sale_price, short_url, start_date FROM connect_products WHERE channel = 'travel' ORDER BY checked_at DESC LIMIT 400").all();
    const items = mapTravelRows(rows.map(r => ({ checkedAt: r.checked_at, productId: r.product_id, title: r.name, store: r.store_name, url: r.url,
      salePrice: r.discounted_price ?? r.sale_price, affiliateUrl: r.short_url, startDate: r.start_date })), { now, links });
    diagnostics.sources.push({ file, newestTimestamp: builtAt, mode: 'read_only_sqlite_fallback', count: items.length, stale: !recent(builtAt, now, 72) });
    return items;
  } catch { diagnostics.blocked.push('CATALOG_UNAVAILABLE'); return []; }
  finally { db?.close(); }
}

export async function load({ now = new Date(), fetchImpl = globalThis.fetch, live = true, roots = null, catalog = true } = {}) {
  now = new Date(now);
  if (!Number.isFinite(now.getTime())) throw new Error('INVALID_NOW');
  diagnostics = { sources: [], blocked: ['MyRealTrip Partner API skipped: DPAPI reads and link issuance prohibited for this worker.',
    'Naver flight live collector requires POST query/search requests; GET-only CLI uses saved travel-deal-check outputs instead.'] };
  const { links, file: linkFile } = await issuedTravelLinks();
  const items = [], liveSources = new Set();
  if (live) {
    const endpoints = [];
    const read = publicFetch(fetchImpl, endpoints);
    const results = await Promise.allSettled([
      fetchPlatformDeals(160, { fetchImpl: read, now, sites: ['ttang', 'myrealtrip', 'tripcom', 'yeogi', 'nol'] }),
      checkHotdeals({ fetchImpl: read, now, limit: 100, issue: async urls => ({ links: Object.fromEntries(urls.filter(u => links[u]).map(u => [u, links[u]])), failed: [] }) }),
    ]);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') { diagnostics.blocked.push(['TRAVEL_PLATFORMS', 'TRAVEL_HOTDEALS'][i] + ': ' + (result.reason?.code ?? 'COLLECTION_FAILED')); continue; }
      const data = result.value;
      const mapped = mapTravelSnapshot(data, { now, checkedAt: now.toISOString(), links });
      items.push(...mapped);
      for (const item of mapped) liveSources.add(item.source);
      for (const receipt of data.receipt?.perSite ?? []) if (receipt.skipped) diagnostics.blocked.push(`${receipt.site}: ${receipt.skipped}`);
    }
    diagnostics.sources.push(...endpoints.map(r => ({ ...r, newestTimestamp: r.checkedAt, mode: 'anonymous_live_read' })));
  }
  const savedSources = new Set();
  for (const doc of await readSnapshots('travel', roots)) {
    const mapped = mapTravelSnapshot(doc.data, { now, checkedAt: doc.mtime, links }).filter(item => !liveSources.has(item.source) && !savedSources.has(item.source));
    const newestTimestamp = observation(doc.data, doc.mtime);
    diagnostics.sources.push({ file: doc.file, newestTimestamp, mode: 'saved_collector_output', count: mapped.length, stale: !recent(newestTimestamp, now, 72) });
    items.push(...mapped);
    for (const item of mapped) savedSources.add(item.source);
  }
  if (!items.length && catalog) items.push(...await catalogFallback(now, links));
  const selected = currentItems(items, now);
  diagnostics.countsBySource = Object.fromEntries([...new Set(selected.map(i => i.source))].map(source => [source, selected.filter(i => i.source === source).length]));
  if (!selected.some(i => i.source === 'naver_flight')) diagnostics.blocked.push('naver_flight: NO_CURRENT_SAVED_VERIFIED_FLIGHT (24-hour freshness limit); live ttang airfares remain eligible.');
  if (linkFile && selected.some(i => links[i.sourceUrl])) diagnostics.sources.push({ file: linkFile, mode: 'previously_issued_links_only', count: selected.filter(i => links[i.sourceUrl]).length });
  return selected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--dry-run')) { console.error('Use --dry-run (read-only; never POSTs to the hub).'); process.exitCode = 1; }
  else load().then(items => dryRun('travel', items, getDiagnostics())).catch(() => { console.error('TRAVEL_LOAD_FAILED'); process.exitCode = 1; });
}
