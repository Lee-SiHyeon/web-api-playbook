// 생활꿀팁 snapshot for the content catalog: housing subscription notices (청약홈 APT 분양·무순위, LH 임대·분양 공고)
// and, once a 공공데이터포털 key is stored, 정부24 보조금24 benefit programs. Topics and sources: life-benefits-ontology.json.
// Usage:
//   node life-benefits-snapshot.mjs --out=<life-benefits.json> [--apt-pages=4] [--max-details=25] [--max-age-days=45]
//   node life-benefits-snapshot.mjs setup-key    stdin {"serviceKey":"<data.go.kr 일반 인증키>"}   verify and store with DPAPI
//   node life-benefits-snapshot.mjs key-status   configured boolean only
//
// Read-only public pages, fetched one at a time with a pause between requests. No login, no queue or traffic-control
// page is touched: a response that is not the expected list or detail stops that source and is reported. The
// 공공데이터포털 key lives only in the DPAPI store (credential "data-go-kr") and in memory while a request is built; it is
// sent in the Authorization header, never in a URL, argument, log or output.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.resolve(HERE, '../../scripts/secure-credential-store.mjs');
const KEY_NAME = 'data-go-kr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const APPLYHOME = 'https://www.applyhome.co.kr/ai/aia';
const LH_LIST = 'https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancList.do?mi=1026';
const GOV24 = 'https://api.odcloud.kr/api/gov24/v3';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = s => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const cellsOf = rowHtml => [...rowHtml.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(m => text(m[1]));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const int = s => { const n = Number(String(s ?? '').replace(/[^\d.-]/g, '')); return String(s ?? '').trim() && Number.isFinite(n) ? n : null; };
const range = s => { const m = /(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/.exec(s || ''); return m ? [m[1], m[2]] : [null, null]; };
export const kstDate = t => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);

// 청약홈 목록 (APT 분양 / 무순위·잔여세대). Rows carry the notice id in data-pbno; cells differ by list.
export function parseApplyhomeList(html, kind) {
  const out = [];
  for (const m of String(html).matchAll(/<tr data-pbno="(\d+)"([^>]*)>([\s\S]*?)<\/tr>/g)) {
    const attrs = m[2], c = cellsOf(m[3]);
    const name = text(/data-honm="([^"]*)"/.exec(attrs)?.[1]) || null;
    const houseManageNo = /data-hmno="(\d+)"/.exec(attrs)?.[1] ?? m[1];
    const dates = c.filter(x => DATE.test(x)), win = c.find(x => / ~ /.test(x));
    const [receiptStart, receiptEnd] = range(win);
    const base = { source: kind === 'remndr' ? 'applyhome-remndr' : 'applyhome-apt', noticeId: m[1], houseManageNo, name, region: c[0] || null,
      announcedAt: dates[0] ?? null, receiptStart, receiptEnd, winnerDate: dates[1] ?? null,
      url: `${APPLYHOME}/${kind === 'remndr' ? 'selectAPTRemndrLttotPblancDetailView' : 'selectAPTLttotPblancDetail'}.do?houseManageNo=${houseManageNo}&pblancNo=${m[1]}` };
    if (kind === 'remndr') out.push({ ...base, houseType: null, supplyKind: c[1] || null, builder: c[3] || null });
    else out.push({ ...base, houseType: c[1] || null, supplyKind: c[2] || null, builder: c[4] || null });
  }
  return out;
}

const SPECIAL_TYPES = { '다자녀 가구': 'multiChild', '다자녀': 'multiChild', '신혼부부': 'newlywed', '생애최초': 'firstHome', '청년': 'youth',
  '노부모 부양': 'elderlyParent', '노부모': 'elderlyParent', '신생아': 'newborn', '기관추천': 'institution', '이전기관': 'relocated', '기타': 'other' };

// 청약홈 APT 입주자모집공고 상세: schedule, units by house type, special supply by type, price range (만원).
export function parseApplyhomeDetail(html) {
  const tables = [...String(html).matchAll(/<table[\s\S]*?<\/table>/g)].map(t => [...t[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map(r => cellsOf(r[0])));
  if (!tables.length) fail('APPLYHOME_DETAIL_UNEXPECTED');
  const rows = tables.flat(), find = label => rows.find(r => r[0] === label);
  const d = { location: find('공급위치')?.[1] ?? null, totalUnits: int(find('공급규모')?.[1]), announcedIn: find('모집공고일')?.[1] ?? null,
    specialSupply: null, rank1: null, rank2: null, winnerDate: null, contract: null, regulation: null, units: null, specialByType: null, priceManwon: null };
  const sched = label => { const r = find(label); return r ? { local: DATE.test(r[1]) ? r[1] : null, other: DATE.test(r[2]) ? r[2] : null, place: r[3] ?? null } : null; };
  d.specialSupply = sched('특별공급'); d.rank1 = sched('1순위'); d.rank2 = sched('2순위');
  const all = text(html);
  d.winnerDate = /당첨자 발표일\s*(\d{4}-\d{2}-\d{2})/.exec(all)?.[1] ?? null;
  d.contract = /계약일\s*(\d{4}-\d{2}-\d{2}(?:\s*~\s*\d{4}-\d{2}-\d{2})?)/.exec(all)?.[1] ?? null;
  d.regulation = /특이사항\s*:\s*([^*]+?)\s*\*/.exec(all)?.[1]?.trim() ?? null;
  // Units: rows of the 공급대상 table end with the model number "<id>(nn)"; the three numbers before it are 일반·특별·계.
  const unitRows = rows.filter(r => /^\d+\(\d+\)$/.test(r.at(-1) || ''));
  if (unitRows.length) d.units = unitRows.reduce((a, r) => { const n = r.slice(-4, -1).map(int); return { general: a.general + (n[0] ?? 0), special: a.special + (n[1] ?? 0), total: a.total + (n[2] ?? 0) }; }, { general: 0, special: 0, total: 0 });
  // Special supply by type: the header row lists the types and ends with 계; data rows start with the house type.
  const table = tables.find(t => t.some(r => r.includes('신혼부부') && r.at(-1) === '계'));
  if (table) {
    const head = table.find(r => r.includes('신혼부부')), keys = head.slice(0, -1).map(h => SPECIAL_TYPES[h] ?? h);
    const sums = Object.fromEntries(keys.map(k => [k, 0]));
    for (const r of table.filter(r => /^\d{3}\.\d+/.test(r[0] || ''))) keys.forEach((k, i) => { sums[k] += int(r[i + 1]) ?? 0; });
    d.specialByType = sums;
  }
  const priceTable = tables.find(t => t[0]?.[0] === '주택형' && /공급금액/.test(t[0]?.[1] || ''));
  if (priceTable) {
    const p = priceTable.slice(1).map(r => int(r[1])).filter(n => n != null && n > 0);
    if (p.length) d.priceManwon = { min: Math.min(...p), max: Math.max(...p), basis: text(priceTable[0][1]) };
  }
  return d;
}

// LH 청약플러스 공고 목록. Detail links are rebuilt from the four data-id attributes of the title link.
export function parseLhList(html) {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(String(html))?.[1] ?? '';
  const out = [];
  for (const m of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const ids = /data-id1="(\d+)" data-id2="(\d+)" data-id3="(\d+)" data-id4="(\d*)" class="wrtancInfoBtn"/.exec(m[1]);
    if (!ids) continue;
    const c = cellsOf(m[1]);
    const title = text(/<span>([\s\S]*?)<em/.exec(m[1])?.[1] ?? c[2]);
    const dot = s => (/^\d{4}\.\d{2}\.\d{2}$/.test(s || '') ? s.replace(/\./g, '-') : null);
    out.push({ source: 'lh', noticeId: ids[1], name: title, houseType: c[1] || null, supplyKind: c[1] || null, region: c[3] || null,
      announcedAt: dot(c[5]), receiptStart: null, receiptEnd: dot(c[6]), winnerDate: null, status: c[7] || null, builder: 'LH',
      url: `https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancInfo.do?panId=${ids[1]}&ccrCnntSysDsCd=${ids[2]}&uppAisTpCd=${ids[3]}&aisTpCd=${ids[4]}&mi=1026` });
  }
  return out;
}

// 정부24 보조금24 (공공서비스 혜택) row → compact program record.
export function benefitProgram(x) {
  return { serviceId: String(x['서비스ID'] ?? ''), name: x['서비스명'] ?? null, agency: x['소관기관명'] ?? null, agencyType: x['소관기관유형'] ?? null,
    field: x['서비스분야'] ?? null, userType: x['사용자구분'] ?? null, summary: x['서비스목적요약'] ?? null, target: x['지원대상'] ?? null,
    criteria: x['선정기준'] ?? null, content: x['지원내용'] ?? null, applyMethod: x['신청방법'] ?? null, deadline: x['신청기한'] ?? null,
    url: x['상세조회URL'] ?? null, views: int(x['조회수']), registeredAt: x['등록일시'] ?? null, updatedAt: x['수정일시'] ?? null };
}

async function getText(fetchImpl, url, { expect }) {
  let r;
  try { r = await fetchImpl(url, { headers: { 'user-agent': UA, 'accept-language': 'ko' }, redirect: 'manual', signal: AbortSignal.timeout(30000) }); } catch { fail('FETCH_FAILED'); }
  if (r.status >= 300 && r.status < 400) fail('REDIRECTED'); // a queue or traffic-control page: stop, never follow
  if (r.status !== 200) fail(`HTTP_${r.status}`);
  const body = await r.text();
  if (!expect.test(body)) fail('UNEXPECTED_PAGE');
  return body;
}

async function loadKey(store) {
  const raw = store?.readCredential(KEY_NAME);
  if (!raw) return null;
  try { const v = JSON.parse(raw); return v?.version === 1 && typeof v.serviceKey === 'string' && v.serviceKey.length >= 20 ? v.serviceKey : null; } catch { return null; }
}

async function odcloud(fetchImpl, key, pathname, params) {
  const u = new URL(`${GOV24}/${pathname}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  let r;
  try { r = await fetchImpl(u, { headers: { authorization: `Infuser ${key}`, accept: 'application/json' }, signal: AbortSignal.timeout(30000) }); } catch { fail('GOV24_FETCH_FAILED'); }
  if (r.status === 401 || r.status === 403) fail('DATA_GO_KR_KEY_REJECTED');
  if (r.status !== 200) fail(`GOV24_HTTP_${r.status}`);
  return r.json();
}

export async function collect({ fetchImpl = globalThis.fetch, now = Date.now(), aptPages = 4, remndrPages = 2, maxDetails = 25, maxAgeDays = 45,
  pauseMs = 800, store = null, benefitPages = 30, benefitPerPage = 500 } = {}) {
  const today = kstDate(now), oldest = kstDate(now - maxAgeDays * 864e5);
  const sources = {}, housing = [];
  const note = (id, v) => { sources[id] = v; };
  // 청약홈 APT: newest notices first; stop paging once a page is entirely older than the window.
  for (const [kind, id, view, pages] of [['apt', 'applyhome-apt-list', 'selectAPTLttotPblancListView', aptPages], ['remndr', 'applyhome-remndr-list', 'selectAPTRemndrLttotPblancListView', remndrPages]]) {
    let count = 0;
    try {
      for (let page = 1; page <= pages; page++) {
        const rows = parseApplyhomeList(await getText(fetchImpl, `${APPLYHOME}/${view}.do?pageIndex=${page}`, { expect: /data-pbno=|총게시물/ }), kind);
        await sleep(pauseMs);
        const fresh = rows.filter(r => !r.announcedAt || r.announcedAt >= oldest);
        housing.push(...fresh); count += fresh.length;
        if (!rows.length || fresh.length < rows.length) break;
      }
      note(id, { ok: true, count });
    } catch (e) { note(id, { ok: false, count, error: e.code || 'FAILED' }); }
  }
  // Details for APT notices that are still open or upcoming.
  const open = housing.filter(h => h.source === 'applyhome-apt' && (!h.receiptEnd || h.receiptEnd >= today)).slice(0, maxDetails);
  let details = 0, detailError = null;
  for (const h of open) {
    try { h.detail = parseApplyhomeDetail(await getText(fetchImpl, h.url, { expect: /입주자모집공고 주요정보/ })); details++; }
    catch (e) { detailError = e.code || 'FAILED'; if (e.code === 'REDIRECTED') break; }
    await sleep(pauseMs);
  }
  note('applyhome-apt-detail', { ok: detailError == null, count: details, wanted: open.length, error: detailError });
  try {
    const rows = parseLhList(await getText(fetchImpl, LH_LIST, { expect: /wrtancInfoBtn|공고명/ }));
    housing.push(...rows); note('lh-notice-list', { ok: true, count: rows.length });
  } catch (e) { note('lh-notice-list', { ok: false, count: 0, error: e.code || 'FAILED' }); }
  // 보조금24 through the official Open API, only when the key is stored.
  let benefits = null;
  const key = await loadKey(store);
  if (!key) note('gov24-benefits', { ok: false, count: 0, error: 'KEY_MISSING' });
  else {
    benefits = [];
    try {
      for (let page = 1; page <= benefitPages; page++) {
        const j = await odcloud(fetchImpl, key, 'serviceList', { page, perPage: benefitPerPage, returnType: 'JSON' });
        benefits.push(...(j.data || []).map(benefitProgram));
        if (!j.data?.length || page * benefitPerPage >= (j.totalCount ?? 0)) break;
        await sleep(pauseMs);
      }
      note('gov24-benefits', { ok: true, count: benefits.length });
    } catch (e) { note('gov24-benefits', { ok: false, count: benefits.length, error: e.code || 'FAILED' }); }
  }
  return { schemaVersion: 1, kind: 'life-benefits', checkedAt: new Date(now).toISOString(), window: { from: oldest, today }, sources, housing, benefits };
}

async function readStdin() { let s = ''; for await (const c of process.stdin) s += c; return s; }

async function main() {
  const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
  const cmd = process.argv[2];
  const store = await import(pathToFileURL(STORE).href);
  if (cmd === 'key-status') { console.log(JSON.stringify({ ok: true, configured: Boolean(await loadKey(store)) })); return; }
  if (cmd === 'setup-key') {
    let key;
    try { key = String(JSON.parse(await readStdin()).serviceKey || '').trim(); } catch { fail('STDIN_JSON_REQUIRED'); }
    if (key.length < 20) fail('SERVICE_KEY_INVALID');
    await odcloud(globalThis.fetch, key, 'serviceList', { page: 1, perPage: 1, returnType: 'JSON' }); // throws DATA_GO_KR_KEY_REJECTED
    store.writeCredential(KEY_NAME, JSON.stringify({ version: 1, serviceKey: key, verifiedAt: new Date().toISOString() }));
    console.log(JSON.stringify({ ok: true, configured: true }));
    return;
  }
  const out = arg('out');
  if (!out) fail('OUT_REQUIRED');
  const r = await collect({ store, aptPages: Number(arg('apt-pages') ?? 4), maxDetails: Number(arg('max-details') ?? 25), maxAgeDays: Number(arg('max-age-days') ?? 45) });
  writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
  console.log(JSON.stringify({ ok: Object.entries(r.sources).some(([k, v]) => k !== 'gov24-benefits' && v.ok), out, sources: r.sources, housing: r.housing.length, benefits: r.benefits?.length ?? null }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code || 'LIFE_BENEFITS_FAILED' })); process.exitCode = 1; });
