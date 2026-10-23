// Reuses public opportunity collectors; deliberately never calls the DPAPI-backed
// Brand Connect client under this worker's no-credential/no-member-data limits.
import { collectRevu, collectWevity, loadProfile } from '../../../naver-blog-api/research/content-store/apply-opportunities.mjs';
import { clean, integer, makeItem, finish, snapshots, catalogRows, anonymousFetch, isCli, cliReport } from './benefit-opportunity-utils.mjs';

const publicSources = new Set(['revu', 'wevity']);
function categoryOf(row) {
  const text = (row.categories ?? []).join(' ');
  for (const [category, pattern] of [['beauty', /뷰티|화장품|미용/], ['food', /식품|맛집|음식/],
    ['travel', /여행|숙박|관광/], ['digital', /IT|디지털|소프트웨어/], ['fashion', /패션|의류/],
    ['living', /리빙|생활|가구/], ['pet', /반려|애완/]]) if (pattern.test(text)) return category;
  return 'etc';
}

export function mapOpportunity(row, checkedAt) {
  if (!row || !publicSources.has(row.source) || row.open !== true) return null;
  const slots = integer(row.competition?.slots), applicants = integer(row.competition?.applicants);
  const shippingNote = [slots != null ? `모집 ${slots}명` : null, applicants != null ? `신청 ${applicants}명` : null].filter(Boolean).join(' · ');
  const summary = [clean(row.reward?.raw), row.target && `대상 ${clean(row.target)}`,
    row.location?.address ?? row.location?.region].filter(Boolean).join(' · ');
  const id = typeof row.id === 'string' && row.id.startsWith(`${row.source}:`) ? row.id.slice(row.source.length + 1) : row.id;
  return makeItem({ source: row.source, stableId: id, kind: 'opportunity', category: categoryOf(row),
    title: row.title, store: row.host ?? (row.source === 'revu' ? '레뷰' : '위비티'), shippingNote,
    sourceUrl: row.url, postedAt: row.postedAt ?? row.publishedAt ?? row.checkedAt ?? checkedAt,
    expiresAt: row.schedule?.applyEnd, imageUrl: row.imageUrl,
    tags: [...(row.categories ?? []), row.media, row.deliveryMode].filter(Boolean), summary });
}

export function mapSnapshot(document, { now = new Date() } = {}) {
  return finish((document.opportunities ?? document.assessed?.map(x => x.o) ?? []).map(row => mapOpportunity(row, document.checkedAt)), now);
}

async function fallback(sources, diagnostics) {
  const newest = (await snapshots('opportunity', diagnostics))[0];
  if (newest) { sources.push({ type: 'file', location: newest.file, checkedAt: newest.checkedAt }); return newest.data; }
  try {
    const { file, rows } = await catalogRows('apply_opportunities');
    sources.push({ type: 'catalog_fallback', location: file, checkedAt: rows[0]?.checked_at ?? null });
    return { checkedAt: rows[0]?.checked_at, opportunities: rows.filter(r => publicSources.has(r.source)).map(r => ({
      id: r.opportunity_id, source: r.source, title: r.title, url: r.url, host: r.host, checkedAt: r.checked_at,
      open: r.is_open === 1, schedule: { applyEnd: r.apply_end }, reward: { raw: r.reward_raw },
      competition: { slots: r.slots, applicants: r.applicants }, location: { region: r.region }, categories: [] })) };
  } catch { diagnostics.push({ code: 'OPPORTUNITY_DATA_MISSING' }); return { opportunities: [] }; }
}

export async function loadWithReport({ now = new Date(), live = true, fetchImpl = globalThis.fetch, documents = null } = {}) {
  const sources = [], diagnostics = [{ source: 'brandconnect', code: 'BLOCKED_CREDENTIAL_AND_MEMBER_DATA',
    detail: 'Existing campaign-search reads a DPAPI creator session and returns a creator-space search URL, not a public original campaign page. No client or credential store was opened.' }];
  if (documents) return { items: finish(documents.flatMap(d => mapSnapshot(d, { now })), now), sources, diagnostics };
  const checkedAt = new Date(now).toISOString();
  const request = anonymousFetch(sources, fetchImpl);
  let results = [];
  if (live) results = await Promise.all([
    collectRevu({ fetchImpl: request, checkedAt }).catch(() => ({ source: 'revu', error: 'COLLECT_FAILED', opportunities: [] })),
    collectWevity(loadProfile(), { fetchImpl: request, checkedAt, pages: 2, maxDetails: 8 }).catch(() => ({ source: 'wevity', error: 'COLLECT_FAILED', opportunities: [] })),
  ]);
  const failed = new Set();
  if (!live) for (const source of publicSources) failed.add(source);
  for (const result of results) {
    if (result.error || Object.values(result.lists ?? {}).some(v => typeof v !== 'number')) {
      failed.add(result.source); diagnostics.push({ source: result.source, code: result.error ?? 'PARTIAL_PUBLIC_LIST_FAILURE', lists: result.lists });
    }
    const invalidDeadline = result.opportunities.filter(row => row.open && !row.schedule?.applyEnd).length;
    if (invalidDeadline) diagnostics.push({ source: result.source, code: 'MISSING_DEADLINE_EXCLUDED', count: invalidDeadline });
  }
  if (failed.size) {
    const document = await fallback(sources, diagnostics);
    results.push({ opportunities: (document.opportunities ?? []).filter(row => failed.has(row.source)), checkedAt: document.checkedAt });
  }
  // Successful live results come first for equal timestamps. A newer closure must
  // suppress an older open row even on a partial list failure.
  const unique = new Map();
  for (const result of results) for (const row of result.opportunities) if (!unique.has(row.id)) unique.set(row.id, row);
  const items = mapSnapshot({ checkedAt, opportunities: [...unique.values()] }, { now });
  return { items, sources, diagnostics };
}

export async function load({ now = new Date(), ...options } = {}) { return (await loadWithReport({ now, ...options })).items; }
if (isCli(import.meta.url)) {
  if (!process.argv.includes('--dry-run')) { console.error('Only --dry-run is supported; this module never POSTs.'); process.exitCode = 2; }
  else loadWithReport().then(result => cliReport('opportunity', result)).catch(() => { console.error('OPPORTUNITY_LOAD_FAILED'); process.exitCode = 1; });
}
