// 지역 축제 수집 (owner 2026-09-28: "각 지역 축제같은건 아직 온톨로지에 안들어와있나" → "xhr 브라우징으로 축제 수집할만한 온톨로지
// 자료탐색해와"). Source: 대한민국 구석구석 (한국관광공사) festival list, the XHR its list page sends (jQuery form-encoded POST, JSON response):
//   POST https://korean.visitkorea.or.kr/kfes/list/selectWntyFstvlList.do  (anonymous, 12 rows per page, totalCnt)
//   body {startIdx, searchType:'A' (축제일순)|'B' (좋아요순)|'F' (먹거리), searchDate, searchArea, searchCate, locationx, locationy, filterExcluded:true}
// Kept per festival: id, name, period, status, area/address, coordinates, fee/discount, homepage/instagram/youtube, organizer,
// 문화관광축제 flag, poster path, food-booth names; the long description only as its first 300 characters.
// Usage: node festivals.mjs collect --out=<file> [--max-pages=60] [--area=<searchArea code>] [--date=<searchDate>]
//        node festivals.mjs upcoming --in=<file> [--days=14] [--area=서울]
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LIST = 'https://korean.visitkorea.or.kr/kfes/list/selectWntyFstvlList.do';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const fail = code => { throw Object.assign(new Error(code), { code }); };
// Dates arrive as '2026.09.24' (20260924 and 2026-09-24 are accepted too).
const ymd = s => { const m = /^(\d{4})[.-]?(\d{2})[.-]?(\d{2})$/.exec(String(s ?? '').trim()); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const num = v => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function normalizeFestival(r) {
  return {
    id: r.fstvlCntntsId, name: String(r.cntntsNm ?? '').trim(),
    start: ymd(r.fstvlBgngDe), end: ymd(r.fstvlEndDe), daysLeft: num(r.fstvlDayDiff), ongoing: r.fstvlIngFlag === '0',
    cultureTourismFestival: r.fstvlClCd === 'MF',
    area: r.areaNm ?? null, address: [r.adres, r.dtadr].filter(Boolean).join(' ').trim() || null,
    lat: num(r.ycrdVal), lng: num(r.xcrdVal),
    fee: r.fstvlUtztFareInfo ?? null, discount: r.fstvlDscntInfo ?? null, reservationGuide: r.rsvtGdnYn ?? null,
    homepage: /https?:\/\/[^\s"<]+/.exec(String(r.fstvlHmpgUrl ?? ''))?.[0] ?? null, instagram: r.instaUrl || null, youtube: r.ytbUrl || null,
    organizer: r.fstvlMngtNm || r.fstvlAspcsNm || null, contact: r.fstvlMngtTelno || r.fstvlAspcsTelno || null,
    poster: r.posterImgRout ? `https://korean.visitkorea.or.kr${r.posterImgRout}${r.posterImgNm ?? ''}`.replace(/([^:])\/\//g, '$1/') : null,
    foodBooths: (r.boothInfoList ?? []).map(b => b.boothNm ?? b.boothName ?? b.nm).filter(Boolean).slice(0, 30),
    summary: String(r.fstvlOutlCn ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || null,
    detailUrl: `https://korean.visitkorea.or.kr/kfes/detail/fstvlDetail.do?fstvlCntntsId=${encodeURIComponent(r.fstvlCntntsId)}`,
  };
}

export async function collectFestivals({ fetchImpl = globalThis.fetch, maxPages = 60, area = '', date = '', delayMs = 1200, log = () => {} } = {}) {
  const rows = new Map();
  let total = null;
  for (let page = 0; page < maxPages; page++) {
    const body = { startIdx: page * 12, searchType: 'A', searchDate: date, searchArea: area, searchCate: '', locationx: 'undefined', locationy: 'undefined', filterExcluded: true };
    const r = await fetchImpl(LIST, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', accept: 'application/json, text/javascript, */*; q=0.01', 'x-requested-with': 'XMLHttpRequest', 'user-agent': UA,
      referer: 'https://korean.visitkorea.or.kr/kfes/list/wntyFstvlList.do' }, body: new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])) });
    if (r.status === 429 || r.status === 403) fail(`VISITKOREA_HTTP_${r.status}`);
    const j = await r.json().catch(() => fail('VISITKOREA_NOT_JSON'));
    total ??= j.totalCnt ?? null;
    const list = j.resultList ?? [];
    for (const x of list) if (x.fstvlCntntsId && !rows.has(x.fstvlCntntsId)) rows.set(x.fstvlCntntsId, normalizeFestival(x));
    log({ page, got: list.length, kept: rows.size, total });
    if (!list.length || (total != null && rows.size >= total)) break;
    if (delayMs) await new Promise(res => setTimeout(res, delayMs));
  }
  return { schemaVersion: 1, checkedAt: new Date().toISOString(), source: 'korean.visitkorea.or.kr/kfes selectWntyFstvlList (anonymous JSON XHR)', total, festivals: [...rows.values()] };
}

// Festivals running or starting within `days` from `today`, optionally in one area (substring of 시/도·시군구).
export function upcoming(festivals, { today = new Date().toISOString().slice(0, 10), days = 14, area = null } = {}) {
  const until = new Date(Date.parse(today) + days * 86400e3).toISOString().slice(0, 10);
  return festivals.filter(f => f.start && f.end && f.end >= today && f.start <= until && (!area || String(f.area ?? '').includes(area)))
    .sort((a, b) => a.start.localeCompare(b.start));
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  if (cmd === 'collect') {
    const out = arg('out') ?? fail('USAGE: collect --out=<file>');
    const res = await collectFestivals({ maxPages: Number(arg('max-pages') ?? 60), area: arg('area') ?? '', date: arg('date') ?? '', log: x => console.error(JSON.stringify(x)) });
    writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
    console.log(JSON.stringify({ ok: true, total: res.total, kept: res.festivals.length, withCoords: res.festivals.filter(f => f.lat && f.lng).length, withBooths: res.festivals.filter(f => f.foodBooths.length).length }));
  } else if (cmd === 'upcoming') {
    const data = JSON.parse(readFileSync(arg('in') ?? fail('USAGE: upcoming --in=<file>'), 'utf8'));
    const list = upcoming(data.festivals, { days: Number(arg('days') ?? 14), area: arg('area') ?? null });
    console.log(JSON.stringify(list.map(f => ({ name: f.name, start: f.start, end: f.end, area: f.area, fee: f.fee })), null, 1));
  } else fail('USAGE: collect | upcoming');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code || e.message })); process.exitCode = 1; });
