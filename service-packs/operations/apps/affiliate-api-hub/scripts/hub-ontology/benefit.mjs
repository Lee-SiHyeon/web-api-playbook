// Anonymous public reads + existing ontology/run data. No site imports or writes.
import path from 'node:path';
import { collect as collectLife } from '../../../naver-blog-api/research/content-store/life-benefits-snapshot.mjs';
import { parseCampaignList, CAMPAIGN_LIST_URL } from '../../../naver-blog-api/research/content-store/gov-discount-events/gov-discount-events.mjs';
import { collectFoodnuriSaleList } from '../../../naver-blog-api/research/content-store/gov-discount-events/foodnuri-html.mjs';
import { normalizeHtmlEvents } from '../../../naver-blog-api/research/content-store/gov-discount-events/html-event-records.mjs';
import { collectShNoticeList, collectShNoticeDetail } from '../../../naver-blog-api/research/content-store/rental-housing/rental-housing.mjs';
import { parsePressMoneyFacts } from '../../../naver-blog-api/research/content-store/gov-discount-events/press-event-facts.mjs';
import { parseNaverCardPromotion } from '../../../naver-blog-api/research/content-store/membership-campaigns/membership-campaigns.mjs';
import { parseHtml, textContent } from '../../../naver-blog-api/research/content-store/gov-discount-events/html-public.mjs';
import { clean, https, isoTime, makeItem, finish, readJson, snapshots, catalogRows,
  contentRoot, anonymousFetch, publicDocumentClient, isCli, cliReport } from './benefit-opportunity-utils.mjs';

export function mapHousing(row, checkedAt) {
  if (!row || row.ended || /^(?:마감|종료|접수마감)$/.test(row.status ?? '')) return null;
  const source = row.source?.startsWith('applyhome') ? 'applyhome' : row.source === 'lh' ? 'lh' : row.source === 'sh' ? 'sh' : null;
  if (!source) return null;
  return makeItem({ source, stableId: row.noticeId ?? row.id, kind: 'benefit', category: 'living',
    title: row.name ?? row.title, store: row.builder ?? (source === 'applyhome' ? '청약홈' : source.toUpperCase()),
    sourceUrl: row.url ?? row.sourceUrl, postedAt: row.announcedAt ?? row.registeredAt ?? checkedAt,
    expiresAt: row.receiptEnd, shippingNote: row.receiptEnd ? `신청 마감 ${row.receiptEnd}` : null,
    tags: [row.region, row.houseType, row.supplyKind].filter(Boolean),
    summary: [row.region, row.supplyKind, row.receiptStart && row.receiptEnd ? `신청 ${row.receiptStart} ~ ${row.receiptEnd}` : null,
      row.detail?.totalUnits != null ? `공급 ${row.detail.totalUnits}세대` : null].filter(Boolean).join(' · ') });
}

export function mapProgram(row, checkedAt) {
  return makeItem({ source: 'gov24', stableId: row.serviceId, kind: 'benefit', category: 'etc',
    title: row.name, store: row.agency, sourceUrl: row.url,
    postedAt: row.updatedAt ?? row.registeredAt ?? checkedAt, expiresAt: row.deadline,
    tags: [row.field, row.userType].filter(Boolean), summary: row.summary ?? row.content ?? '' });
}

export function mapDiscount(row, checkedAt) {
  if (!row || row.visible === false || row.enabled === false || /ended|not_listed/.test(row.status ?? '')) return null;
  // For public discount events the dated redemption/participation period is the
  // application window. A discount cap is never mapped as a product price.
  return makeItem({ source: 'gov_discount', stableId: row.id, kind: 'benefit', category: 'coupon',
    title: row.name ?? row.title, store: row.operatorAgency ?? row.operatorMinistry ?? row.retailerLabelRaw,
    sourceUrl: row.sourceUrl, postedAt: row.checkedAt ?? checkedAt,
    expiresAt: row.endDate ?? row.periodEnd, shippingNote: (row.endDate ?? row.periodEnd) ? `행사 종료 ${row.endDate ?? row.periodEnd}` : null,
    tags: [row.family, row.sourceId].filter(Boolean),
    summary: row.summary ?? row.descriptionRaw ?? row.description ?? row.periodRaw ?? '' });
}

export function mapMembership(row, document) {
  if (!row.period?.end || row.recheck || !['open', 'active'].includes(row.availability)) return null;
  const registry = document.sourceRegistry ?? [];
  const entry = registry.find(s => row.sourceIds?.includes(s.sourceId) && https(s.url));
  const program = document.membershipPrograms?.find(p => p.id === row.programId);
  if (!entry) return null;
  return makeItem({ source: 'membership', stableId: row.id, kind: 'benefit', category: 'coupon',
    title: entry.name ?? program?.name, store: program?.name, sourceUrl: entry.url,
    postedAt: row.checkedAt ?? entry.checkedAt ?? document.checkedAt, expiresAt: row.period.end,
    shippingNote: `행사 종료 ${row.period.end}`, tags: [program?.name].filter(Boolean), summary: row.fact });
}

export function mapLiveMembership(parsed, { sourceUrl, checkedAt, store, body = '' }) {
  // The existing parser's short "mentions" can cut a date (31 -> 3), so dates
  // must come from full text extracted by the existing public HTML parser.
  const facts = parsePressMoneyFacts({ body, sourceUrl });
  const periods = facts.periodFacts.filter(p => /적립/.test(p.labelRaw));
  if (periods.length !== 1) return null;
  return makeItem({ source: 'membership', stableId: 'naver-card-points', kind: 'benefit', category: 'coupon',
    title: parsed.title, store, sourceUrl, postedAt: checkedAt, expiresAt: periods[0].endDate,
    shippingNote: `행사 종료 ${periods[0].endDate}`, tags: [store].filter(Boolean),
    summary: (parsed.conditions ?? []).slice(0, 4).join(' · ') });
}

export function mapSnapshot(document, { now = new Date() } = {}) {
  const items = (document.housing ?? []).map(row => mapHousing(row, document.checkedAt));
  items.push(...(document.benefits ?? []).map(row => mapProgram(row, document.checkedAt)));
  for (const row of document.events ?? document.records ?? []) {
    const entry = document.sourceRegistry?.find(s => row.sourceIds?.includes(s.id) && https(s.url));
    items.push(mapDiscount({ ...row, sourceUrl: row.sourceUrl ?? entry?.url }, document.checkedAt));
  }
  items.push(...(document.facts ?? []).map(row => mapMembership(row, document)));
  return finish(items, now);
}

async function fallbackLife(sources, diagnostics) {
  const newest = (await snapshots('life', diagnostics))[0];
  if (newest) { sources.push({ type: 'file', location: newest.file, checkedAt: newest.checkedAt }); return newest.data; }
  try {
    const { file, rows } = await catalogRows('housing_notices');
    sources.push({ type: 'catalog_fallback', location: file, checkedAt: rows[0]?.checked_at ?? null });
    return { checkedAt: rows[0]?.checked_at, housing: rows.map(r => ({ source: r.source, noticeId: r.notice_id,
      name: r.name, region: r.region, houseType: r.house_type, supplyKind: r.supply_kind, builder: r.builder,
      status: r.status, announcedAt: r.announced_at, receiptStart: r.receipt_start, receiptEnd: r.receipt_end, url: r.url })) };
  } catch { diagnostics.push({ code: 'LIFE_DATA_MISSING' }); return { housing: [] }; }
}

export async function loadWithReport({ now = new Date(), live = true, fetchImpl = globalThis.fetch, documents = null } = {}) {
  const sources = [], diagnostics = [];
  if (documents) return { items: finish(documents.flatMap(d => mapSnapshot(d, { now })), now), sources, diagnostics };
  const request = anonymousFetch(sources, fetchImpl);
  let life;
  if (live) {
    try { life = await collectLife({ fetchImpl: request, now: new Date(now).valueOf(), maxDetails: 0, store: null }); }
    catch { diagnostics.push({ code: 'LIFE_LIVE_FAILED' }); }
  }
  if (!life || Object.entries(life.sources).some(([k, v]) => k !== 'gov24-benefits' && !v.ok)) {
    const fallback = await fallbackLife(sources, diagnostics);
    if (!life) life = fallback;
    else for (const [key, prefix] of [['applyhome-apt-list', 'applyhome-apt'], ['applyhome-remndr-list', 'applyhome-remndr'], ['lh-notice-list', 'lh']]) {
      if (!life.sources[key]?.ok) {
        life.housing.push(...(fallback.housing ?? []).filter(row => row.source === prefix));
        diagnostics.push({ code: 'SOURCE_FALLBACK', source: prefix, reason: life.sources[key]?.error });
      }
    }
  }
  diagnostics.push({ code: 'GOV24_KEY_REQUIRED', detail: 'No credential store opened; official 보조금24 API requires a data.go.kr key.' });
  const items = mapSnapshot(life, { now });
  const govFile = path.join(contentRoot, 'gov-discount-events/gov-discount-events-ontology.v1.json');
  const memberFile = path.join(contentRoot, 'membership-campaigns/membership-campaigns-ontology.v1.json');
  let membershipDocument;
  for (const file of [govFile, memberFile]) {
    try {
      const document = await readJson(file);
      if (file === memberFile) membershipDocument = document;
      const mapped = mapSnapshot(document, { now }); items.push(...mapped);
      sources.push({ type: 'ontology_fallback', location: file, checkedAt: document.checkedAt ?? document.updatedAt,
        count: mapped.length, itemNewestTimestamp: mapped.map(x => x.postedAt).sort().at(-1) ?? null });
    } catch { diagnostics.push({ code: 'ONTOLOGY_UNREADABLE', location: file }); }
  }
  if (live) {
    try {
      const response = await request(CAMPAIGN_LIST_URL);
      if (!response.ok) throw new Error('CAMPAIGN_HTTP_FAILED');
      const document = parseCampaignList(await response.json(), { checkedAt: new Date(now).toISOString() });
      items.push(...mapSnapshot(document, { now }));
    } catch (e) { diagnostics.push({ source: 'k-shoppingfesta', code: e.code ?? e.message }); }
    const client = await publicDocumentClient(sources, fetchImpl);
    const cardSource = membershipDocument?.sourceRegistry?.find(s => s.sourceId === 'naver-card-promo' && https(s.url));
    if (cardSource) {
      const response = await client.get(cardSource.url, { sourceId: 'naver-card-promo' });
      try {
        if (response.error) throw new Error(response.error);
        const parsed = parseNaverCardPromotion(response.html);
        const item = mapLiveMembership(parsed, { sourceUrl: response.url, checkedAt: response.checkedAt,
          store: membershipDocument.membershipPrograms.find(p => p.id === 'naver-plus')?.name,
          body: textContent(parseHtml(response.html)) });
        if (!item) throw new Error('MEMBERSHIP_DEADLINE_NOT_VERIFIED');
        items.push(item);
      } catch (e) { diagnostics.push({ source: 'naver-card-promo', code: e.code ?? e.message, fallbackCheckedAt: cardSource.checkedAt }); }
    }
    try {
      const food = await collectFoodnuriSaleList({ client });
      const document = normalizeHtmlEvents({ foodnuri: food }, { checkedAt: new Date(now).toISOString() });
      items.push(...mapSnapshot(document, { now }));
      if (food.status !== 'read') diagnostics.push({ source: 'foodnuri', code: food.error ?? food.status });
    } catch (e) { diagnostics.push({ source: 'foodnuri', code: e.code ?? 'COLLECT_FAILED' }); }
    try {
      const list = await collectShNoticeList({ client });
      const candidates = list.parsed.items.filter(r => /모집|입주자/.test(r.title) && !/발표|계약|당첨|결과/.test(r.title)).slice(0, 3);
      let mappedCount = 0;
      for (const row of candidates) {
        const { parsed: detail } = await collectShNoticeDetail({ client, seq: row.detailId });
        // Existing money-facts parser supplies explicit date ranges. Only labeled
        // recruitment/application ranges qualify; contract/occupancy never do.
        const facts = parsePressMoneyFacts({ body: detail.body, sourceUrl: detail.sourceUrl });
        const ranges = facts.periodFacts ?? [];
        const periods = ranges.filter(p => /(?:접수|신청|청약)\s*(?:기간|일정)/.test(p.labelRaw) && !/계약기간|입주기간/.test(p.labelRaw));
        if (periods.length !== 1) continue;
        const item = mapHousing({ ...detail, source: 'sh', noticeId: detail.id, receiptEnd: periods[0].endDate }, detail.registeredAt);
        if (item) { items.push(item); mappedCount++; }
      }
      diagnostics.push({ source: 'sh', code: mappedCount ? 'READ' : 'NO_CONFIRMED_APPLICATION_DEADLINE', candidates: candidates.length });
    } catch (e) { diagnostics.push({ source: 'sh', code: e.code ?? 'COLLECT_FAILED' }); }
  }
  return { items: finish(items, now), sources, diagnostics };
}

export async function load({ now = new Date(), ...options } = {}) { return (await loadWithReport({ now, ...options })).items; }
if (isCli(import.meta.url)) {
  if (!process.argv.includes('--dry-run')) { console.error('Only --dry-run is supported; this module never POSTs.'); process.exitCode = 2; }
  else loadWithReport().then(result => cliReport('benefit', result)).catch(() => { console.error('BENEFIT_LOAD_FAILED'); process.exitCode = 1; });
}
