// 광역 단위 맛집 수집: 도시별 좌표 격자로 당근 가게 검색 API를 훑고, 구·시별 place-brief(가게 랭킹 + 동네생활 언급)를 만든 뒤 Drive 폴더로 복사한다.
// 관측(2026-09-29): /kr/api/v1/local-profiles/search 는 region_id를 무시하고 경계 상자 중심에서 가까운 300곳만 돌려준다(상자 크기 무관, 전국 크기는 400).
// 그래서 검색어 대신 격자 중심점을 옮겨 가며 search=맛집 을 반복한다. 구 목록과 지역 ID는 GET /kr/regions/?_data=routes/kr.regions._index.
// 쿠키·세션 없음, GET만, 요청 사이 pause. 403/챌린지가 오면 우회하지 않고 멈춘다.
//
//   node place-sweep.mjs <서울|부산|대구|인천|광주|대전|울산|세종|제주|all> [--areas=강서구,중구] [--detail=12] [--posts=60] [--no-drive] [--no-community]
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, normalizeShop, writeRun } from './place-brief.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.resolve(HERE, '..', '..', 'workflow-runs', 'place-brief');
const DRIVE_ROOT = 'G:\\내 드라이브\\place-brief';
const BASE = 'https://www.daangn.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kstDate = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const safe = s => s.replace(/[^\p{L}\p{N}]+/gu, '-');

// tree = /kr/regions 트리의 시도명, aliases = 가게 주소 첫 토큰 표기, bbox·step은 격자(도) 범위.
export const CITIES = {
  서울: { tree: '서울특별시', aliases: ['서울특별시', '서울'], bbox: { s: 37.43, n: 37.70, w: 126.76, e: 127.19 }, step: [0.018, 0.022] },
  부산: { tree: '부산광역시', aliases: ['부산광역시', '부산'], bbox: { s: 34.98, n: 35.32, w: 128.78, e: 129.33 }, step: [0.02, 0.024] },
  대구: { tree: '대구광역시', aliases: ['대구광역시', '대구'], bbox: { s: 35.65, n: 36.27, w: 128.25, e: 128.85 }, step: [0.025, 0.03] },
  인천: { tree: '인천광역시', aliases: ['인천광역시', '인천'], bbox: { s: 37.33, n: 37.80, w: 126.35, e: 126.80 }, step: [0.025, 0.03] },
  광주: { tree: '전남광주통합특별시', aliases: ['광주광역시', '광주', '전남광주통합특별시'], only: ['동구', '서구', '남구', '북구', '광산구'], bbox: { s: 35.05, n: 35.25, w: 126.72, e: 126.98 }, step: [0.02, 0.024] },
  대전: { tree: '대전광역시', aliases: ['대전광역시', '대전'], bbox: { s: 36.20, n: 36.50, w: 127.25, e: 127.55 }, step: [0.02, 0.024] },
  울산: { tree: '울산광역시', aliases: ['울산광역시', '울산'], bbox: { s: 35.35, n: 35.72, w: 129.05, e: 129.48 }, step: [0.025, 0.03] },
  세종: { tree: '세종특별자치시', aliases: ['세종특별자치시', '세종'], single: true, bbox: { s: 36.42, n: 36.70, w: 127.16, e: 127.35 }, step: [0.025, 0.03] },
  제주: { tree: '제주특별자치도', aliases: ['제주특별자치도', '제주'], bbox: { s: 33.18, n: 33.58, w: 126.14, e: 126.98 }, step: [0.03, 0.035] },
};

export function gridPoints({ bbox, step }) {
  const pts = [];
  for (let lat = bbox.s; lat <= bbox.n + 1e-9; lat += step[0]) for (let lng = bbox.w; lng <= bbox.e + 1e-9; lng += step[1]) pts.push({ lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) });
  return pts;
}

export const addressArea = (p, city) => {
  const [first, second] = String(p.roadAddress || p.jibunAddress || '').trim().split(/\s+/);
  if (!city.aliases.includes(first)) return null;
  return city.single ? city.tree : second ?? null;
};

const gridUrl = ({ lat, lng }, h = 0.01) => {
  const u = new URL('/kr/api/v1/local-profiles/search', BASE);
  for (const [k, v] of Object.entries({ bottomRightLat: lat - h, bottomRightLng: lng + h, region_id: 6052, restrict_to_focus_viewport: 'false', search: '맛집', topLeftLat: lat + h, topLeftLng: lng - h })) u.searchParams.set(k, String(v));
  return u.toString();
};

async function get(url, accept = 'application/json') {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { method: 'GET', headers: { accept, 'accept-language': 'ko-KR', 'user-agent': UA }, redirect: 'manual' });
    const raw = await res.text();
    if (res.status === 403) throw Object.assign(new Error(`403 challenge at ${url.slice(0, 80)} — 우회하지 않고 중단`), { fatal: true });
    if (res.status === 429 || res.status >= 500) { await sleep(5000 * (attempt + 1)); continue; }
    return { status: res.status, raw };
  }
  return { status: 0, raw: '' };
}

export async function sweepCity(name, city, { pauseMs = 250, log = console.log } = {}) {
  const dir = path.join(RUNS, `${kstDate()}-${name}-sweep`);
  const profilesFile = path.join(dir, 'profiles.json');
  if (existsSync(profilesFile)) { log(`[${name}] 격자 수집 이미 있음, 재사용`); return { dir, profiles: JSON.parse(readFileSync(profilesFile, 'utf8')) }; }
  const capDir = path.join(dir, 'captures'); mkdirSync(capDir, { recursive: true });
  const pts = gridPoints(city); const profiles = new Map(); const meta = [];
  for (const [i, pt] of pts.entries()) {
    const url = gridUrl(pt); const at = new Date().toISOString();
    const { status, raw } = await get(url);
    writeFileSync(path.join(capDir, `${String(i + 1).padStart(4, '0')}-grid_${pt.lat}_${pt.lng}.json.gz`), gzipSync(raw));
    let list = []; try { const b = JSON.parse(raw); list = b?.searchResult?.localProfiles ?? []; } catch { /* keep raw only */ }
    let added = 0; for (const p of list) if (!profiles.has(String(p.id))) { profiles.set(String(p.id), p); added++; }
    meta.push({ i: i + 1, ...pt, status, at, shops: list.length, added });
    if ((i + 1) % 25 === 0 || i + 1 === pts.length) log(`[${name}] 격자 ${i + 1}/${pts.length} 가게 ${profiles.size}곳`);
    await sleep(pauseMs);
  }
  writeFileSync(profilesFile, JSON.stringify([...profiles.values()]));
  writeFileSync(path.join(dir, 'sweep.json'), JSON.stringify({ city: name, points: pts.length, uniqueShops: profiles.size, capped300: meta.filter(m => m.shops >= 300).length, failed: meta.filter(m => m.status !== 200).length, requests: meta }, null, 1));
  return { dir, profiles: [...profiles.values()] };
}

export async function loadTree() {
  const { status, raw } = await get(`${BASE}/kr/regions/?_data=${encodeURIComponent('routes/kr.regions._index')}`);
  if (status !== 200) throw new Error(`regions tree ${status}`);
  return JSON.parse(raw).allRegions;
}

export function copyToDrive(srcDir, destDir, { zipCaptures = true } = {}) {
  mkdirSync(destDir, { recursive: true });
  if (zipCaptures && existsSync(path.join(srcDir, 'captures')) && !existsSync(path.join(srcDir, 'captures.zip'))) {
    execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-c', '-f', 'captures.zip', 'captures'], { cwd: srcDir });
  }
  // Drive 드라이브에 cpSync 재귀 덮어쓰기를 하면 프로세스가 조용히 죽어서, 파일별로 복사하고 같은 크기는 건너뛴다.
  const copyTree = (from, to, skip = []) => {
    mkdirSync(to, { recursive: true });
    for (const ent of readdirSync(from, { withFileTypes: true })) {
      if (skip.includes(ent.name)) continue;
      const a = path.join(from, ent.name); const b = path.join(to, ent.name);
      if (ent.isDirectory()) { copyTree(a, b); continue; }
      if (existsSync(b) && statSync(b).size === statSync(a).size) continue;
      copyFileSync(a, b);
    }
  };
  copyTree(srcDir, destDir, ['captures']);
}

export async function runCity(name, { areasOnly, detail = 12, posts = 60, drive = true, community = true, pauseMs = 250, log = console.log } = {}) {
  const city = CITIES[name];
  const tree = (await loadTree()).find(r => r.regionName === city.tree);
  if (!tree) throw new Error(`${name}: 지역 트리에 ${city.tree} 없음`);
  const swept = await sweepCity(name, city, { pauseMs, log });
  const driveDay = path.join(DRIVE_ROOT, kstDate(), name);
  const driveOk = drive && existsSync('G:\\내 드라이브');
  if (drive && !driveOk) log('G:\\내 드라이브 없음: Drive 복사 생략');
  if (driveOk) copyToDrive(swept.dir, path.join(driveDay, '_sweep'));
  const children = city.single ? [{ regionId: tree.childrenRegion?.[0]?.regionId, regionName: city.tree }] : tree.childrenRegion.filter(c => !city.only || city.only.includes(c.regionName));
  const results = [];
  for (const area of children) {
    if (areasOnly?.length && !areasOnly.includes(area.regionName)) continue;
    const label = `${name}-${area.regionName}`;
    const outDir = path.join(RUNS, `${kstDate()}-${safe(label)}`);
    if (existsSync(path.join(outDir, 'place-brief.json'))) { log(`[${label}] 이미 있음, 건너뜀`); continue; }
    const shops = swept.profiles.filter(p => addressArea(p, city) === area.regionName).map(p => normalizeShop(p, null));
    const started = Date.now();
    const seed = { id: area.regionId, name: city.single ? tree.childrenRegion[0].regionName : area.regionName };
    const regionFilter = city.single ? r => r?.name1 === city.tree : r => r?.name1 === city.tree && r?.name2 === area.regionName;
    const requests = [{ query: 'grid sweep 맛집', status: 200, region: null, shops: shops.length, note: `${name} 격자 ${gridPoints(city).length}점, 점당 가까운 300곳(region_id 무시)` }];
    try {
      const result = await collect(city.single ? city.tree : area.regionName, { shops, requests, seed, regionFilter, detail, posts, community, pauseMs });
      result.brief.city = name; result.brief.areaLabel = label;
      result.brief.gaps.push(`${name} 격자 검색(점당 300곳 상한)으로 모은 후보라 누락 가능; 주소 기준으로 ${area.regionName}에 배정`);
      const dir = writeRun(label, result, path.resolve(RUNS, '..'), label);
      if (driveOk) copyToDrive(dir, path.join(driveDay, safe(area.regionName)));
      results.push({ label, candidates: result.brief.candidateCount, ranked: result.brief.rankedCount, community: result.brief.community?.articles ?? null, sec: Math.round((Date.now() - started) / 1000) });
      log(`[${label}] 후보 ${result.brief.candidateCount} 랭킹 ${result.brief.rankedCount} 커뮤니티글 ${result.brief.community?.articles ?? '-'} (${results.at(-1).sec}s)`);
    } catch (e) { if (e.fatal) throw e; log(`[${label}] 실패: ${e.message}`); results.push({ label, error: e.message }); }
  }
  return results;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [target, ...rest] = process.argv.slice(2);
  const flag = (k, d) => (rest.find(a => a.startsWith(`--${k}=`)) ?? '').split('=').slice(1).join('=') || d;
  const names = target === 'all' ? Object.keys(CITIES) : [target];
  if (!target || names.some(n => !CITIES[n])) { console.error(`usage: place-sweep.mjs <${Object.keys(CITIES).join('|')}|all> [--areas=a,b] [--detail=12] [--posts=60] [--no-drive] [--no-community]`); process.exit(2); }
  for (const n of names) {
    try {
      await runCity(n, { areasOnly: flag('areas') ? flag('areas').split(',') : undefined, detail: Number(flag('detail', 12)), posts: Number(flag('posts', 60)), drive: !rest.includes('--no-drive'), community: !rest.includes('--no-community'), log: m => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`) });
    } catch (e) { console.log(`[${n}] 중단: ${e.message}`); if (e.fatal) process.exit(3); }
  }
}
