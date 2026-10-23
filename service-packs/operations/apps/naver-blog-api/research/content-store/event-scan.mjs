// Event scan: run the collectors that are due, detect events, route them, write briefs, notify Telegram.
// Usage: node research/content-store/event-scan.mjs [--dry-run] [--force=connect,market,news,trends,life] [--no-notify]
//   (run from apps/naver-blog-api; the Telegram bot starts it every 30 minutes)
//
// Output: workflow-runs/scan-<KST yyyymmdd-hhmm>/events.json (+ the collector files it produced).
// State:  workflow-runs/_events/state.json (last collector runs, seen event keys, daily brief count, quiet-hour queue).
// Briefs: C:\Users\User\Documents\Codex\<KST date>\auto-briefs\<slug>\article-brief.json, status awaiting_draft.
// Routing policy (DEFAULT_POLICY): cooldown per kind, drop expired, a daily brief cap per kind and 3 messages a scan,
// no messages 23:00–07:00 KST (queued until the next scan outside those hours). Read-only toward every site.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detectGoldbox, detectTravelDeals, detectShoppingTrends, detectAiNews, detectHousingSchedule, detectNewBenefits, detectCoupangNotLowest } from './event-detectors.mjs';
import { probeWhyNow, suggestHooks, hookQuestion } from './hooks.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HUB = path.resolve(APP, '../affiliate-api-hub');
export const CODEX_ROOT = 'C:/Users/User/Documents/Codex';
export const DEFAULT_POLICY = {
  cadenceMinutes: { connect: 60, market: 180, news: 180, trends: 360, life: 360, compare: 1440 },
  // An event may carry `bucket` to count against its own cooldown/priority/daily cap instead of its kind's (frontier launches vs routine AI posts).
  cooldownHours: { goldbox_lowest: 12, travel_deals: 24, shopping_trend: 72, ai_news: 48, ai_model_launch: 48, housing_schedule: 168, benefit_new: 720, coupang_not_lowest: 168 },
  priority: { goldbox_lowest: 4, travel_deals: 3, coupang_not_lowest: 3, ai_model_launch: 3, ai_news: 2, housing_schedule: 2, benefit_new: 2, shopping_trend: 1 },
  maxBriefsPerDay: { goldbox_lowest: 2, travel_deals: 1, ai_news: 2, ai_model_launch: 2, shopping_trend: 1, housing_schedule: 1, benefit_new: 1, coupang_not_lowest: 1 }, maxNotifyPerScan: 3, quietHoursKst: [23, 7],
};
const readJson = f => JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (f, v) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2) + '\n'); renameSync(`${f}.tmp`, f); };
export const kst = t => { const d = new Date(t + 9 * 3600e3); return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), stamp: d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-') }; };
const shortHash = s => createHash('sha256').update(s).digest('hex').slice(0, 8);

export const COLLECTORS = {
  connect: dir => ({ args: ['research/content-store/naver-connect-snapshot.mjs', `--out=${dir}/naver-connect.json`, '--days=30'], out: 'naver-connect.json' }),
  market: dir => ({ args: ['research/content-store/goldbox-market-check.mjs', '--limit=40', `--out=${dir}/market-check.json`], out: 'market-check.json' }),
  news: dir => ({ args: ['research/content-store/collect.mjs', 'research/content-store/sources.json', `${dir}/collection.json`], out: 'collection.json' }),
  trends: dir => ({ args: ['research/trend-radar/run.mjs'], out: 'trend-radar.json', copyFrom: path.join(APP, 'research', 'trend-radar', 'latest.json') }),
  life: dir => ({ args: ['research/content-store/life-benefits-snapshot.mjs', `--out=${dir}/life-benefits.json`], out: 'life-benefits.json' }),
  compare: dir => ({ args: ['research/content-store/coupang-vs-market.mjs', `--out=${dir}/coupang-vs-market.json`], out: 'coupang-vs-market.json' }),
};
// Ontology program seeds decide which new 보조금24 programs are worth a brief.
export const LIFE_SEEDS = (() => {
  try { return readJson(path.join(APP, 'research', 'content-store', 'life-benefits-ontology.json')).domains.flatMap(d => d.topics.flatMap(t => t.seeds)); } catch { return []; }
})();

export function dueCollectors(state, now, policy = DEFAULT_POLICY, force = []) {
  return Object.keys(COLLECTORS).filter(name => force.includes(name)
    || !state.lastRun?.[name] || now - Date.parse(state.lastRun[name]) >= policy.cadenceMinutes[name] * 60e3);
}

export function detectAll(outputs, { now, travelSeen }) {
  return [
    ...(outputs.market ? detectGoldbox(outputs.market, { now }) : []),
    ...(outputs.connect ? detectTravelDeals(outputs.connect, { now, seen: travelSeen }) : []),
    ...(outputs.trends ? detectShoppingTrends(outputs.trends, { now }) : []),
    ...(outputs.news ? detectAiNews(outputs.news, { now }) : []),
    ...(outputs.life ? detectHousingSchedule(outputs.life, { now }) : []),
    ...(outputs.life ? detectNewBenefits(outputs.life, { now, seeds: LIFE_SEEDS }) : []),
    ...(outputs.compare ? detectCoupangNotLowest(outputs.compare, { now }) : []),
  ];
}

// Decide what happens to each detected event. Pure: returns dispositions and the next state.
export function route(events, state, { now, policy = DEFAULT_POLICY }) {
  const seen = { ...(state.seen || {}) }, today = kst(now).date;
  const briefs = { ...(state.briefs?.date === today ? state.briefs.byKind || {} : {}) };
  const quiet = (() => { const h = kst(now).hour, [from, to] = policy.quietHoursKst; return from > to ? h >= from || h < to : h >= from && h < to; })();
  const out = [];
  let notify = 0;
  const bucketOf = e => e.bucket ?? e.kind;
  const ranked = [...events].sort((a, b) => (policy.priority[bucketOf(b)] ?? 0) - (policy.priority[bucketOf(a)] ?? 0) || b.score - a.score);
  for (const e of ranked) {
    const last = seen[e.key], bucket = bucketOf(e);
    if (last && now - Date.parse(last) < (policy.cooldownHours[bucket] ?? 24) * 3600e3) { out.push({ ...e, disposition: 'duplicate' }); continue; }
    if (e.expiresAt && Date.parse(e.expiresAt) <= now) { out.push({ ...e, disposition: 'expired' }); continue; }
    seen[e.key] = new Date(now).toISOString();
    if ((briefs[bucket] ?? 0) >= (policy.maxBriefsPerDay[bucket] ?? 1)) { out.push({ ...e, disposition: 'suppressed', reason: 'daily_brief_cap' }); continue; }
    briefs[bucket] = (briefs[bucket] ?? 0) + 1;
    if (quiet) { out.push({ ...e, disposition: 'queued', reason: 'quiet_hours' }); continue; }
    if (notify >= policy.maxNotifyPerScan) { out.push({ ...e, disposition: 'briefed', reason: 'scan_notify_cap' }); continue; }
    notify++;
    out.push({ ...e, disposition: 'notified' });
  }
  // Forget keys older than two weeks so the state file stays small.
  for (const [k, t] of Object.entries(seen)) if (now - Date.parse(t) > 14 * 864e5) delete seen[k];
  return { events: out, state: { ...state, seen, briefs: { date: today, byKind: briefs } } };
}

const QUESTIONS = {
  goldbox_lowest: e => `${e.data.title}, 지금 골드박스 가격이 다른 쇼핑몰보다 정말 싼가? 언제까지 이 가격인가?`,
  travel_deals: e => `${[...new Set(e.data.items.flatMap(i => i.countries || []))].slice(0, 3).join('·') || '해외'} 여행 특가 중 날짜·가격·포함 내역을 따져 지금 예약할 만한 상품은?`,
  shopping_trend: e => `요즘 '${e.data.keyword}' 검색이 늘어난 이유와, 살 때 무엇을 확인해야 하나?`,
  ai_news: e => `${String(e.data.title).split('\n')[0].slice(0, 80)} — 무엇이 바뀌었고 쓰는 사람에게 어떤 의미인가?`,
  housing_schedule: () => '이번 주·다음 주 접수하는 단지 중 내 조건(신혼·생애최초·신생아·지역)으로 넣을 만한 곳은?',
  benefit_new: e => `${e.data.name}, 누가 받을 수 있고 얼마를 언제까지 어디서 신청하나?`,
  coupang_not_lowest: () => '쿠팡이 늘 최저가일까? 자주 사는 생필품을 여러 쇼핑몰과 같은 조건(배송비 포함)으로 비교하면 어디가 더 싼가?',
};
const NOTES = {
  goldbox_lowest: ['쿠팡 판매 페이지 원본 이미지와 다나와 가격 비교 캡처를 싣는다', '마감 시각과 가격 확인 시각을 본문 첫 부분에 적는다', '최저가가 아니게 되면 발행하지 않는다'],
  travel_deals: ['상품 페이지 원본 이미지와 일정 기반 동선 지도를 싣는다', '출발일·포함/불포함·가격 확인 시각을 표로 정리한다', '네이버 여행커넥트 링크를 쓰면 대가성 문구를 넣는다'],
  shopping_trend: ['검색량이 느는 이유를 근거로 먼저 설명하고 추천은 그 다음', '제품 이미지는 판매 페이지 원본만'],
  ai_news: ['공식 발표 원문을 1차 근거로', '무엇이 바뀌었는지부터 말하고 추측·헤지 표현은 줄인다'],
  housing_schedule: ['단지별 접수일·당첨자 발표일·특별공급 유형별 세대수를 표로', '청약홈 모집공고 원문 링크와 확인 시각을 적는다', '신혼·생애최초·신생아 중 누구에게 맞는 단지인지 먼저 말한다'],
  benefit_new: ['정부24·소관기관 원문을 1차 근거로', '대상·금액·신청기한·신청처를 첫 표에', '기준일을 공지 패널에 적는다'],
  coupang_not_lowest: ['메시지: 쿠팡이 절대 최저가는 아니다, AI로 여러 곳을 비교하면 더 싼 곳이 보인다(비교 N개 중 M개)',
    '같은 다나와 상품 페이지(같은 상품·같은 수량)에서 배송비 포함 가격만 비교, 쿠폰 필요 가격·회원가 제외라고 공지 패널에 적는다',
    '쿠팡이 가장 쌌던 상품 수도 함께 밝혀 공정하게', '상품별로 쿠팡가·최저 쇼핑몰·차액 표, 가격 확인 시각', '판매처 페이지에서 가격을 다시 확인할 수 없으면 그 상품은 뺀다'],
};

// Hook ontology (hook-ontology.v1.json, hooks.mjs): drafting notes that apply whenever the brief carries hooks.
const HOOK_NOTES = ['hooks.candidates 중 하나를 골라 제목·첫 문단을 쓴다(또는 같은 근거로 더 나은 훅). "총정리"를 훅 자리에 쓰지 않는다',
  '제목이 약속한 답(픽·가격·마감)은 첫 3문단 안에', '마감·단종 같은 긴급성 표현은 whyNow 원문 날짜 그대로, 원문이 없으면 쓰지 않는다', '검색 키워드는 제목 앞 15자 안에'];
const readerQuestion = e => e.readerQuestion ?? QUESTIONS[e.kind](e);

export function buildBrief(e, { now, root = CODEX_ROOT }) {
  const k = kst(now), slug = `${e.kind.replace('_', '-')}-${shortHash(e.key)}`;
  const dir = path.join(root, k.date, 'auto-briefs', slug);
  return { dir, brief: { schemaVersion: 1, briefId: `auto-${k.date}-${shortHash(e.key)}`, origin: `event:${e.key}`, eventKind: e.kind,
    topicKey: `${e.kind}:${shortHash(e.key)}`, genre: e.genre, field: e.field, readerQuestion: readerQuestion(e), headline: e.headline,
    status: 'awaiting_draft', createdAt: new Date(now).toISOString(), expiresAt: e.expiresAt ?? null,
    draftingNotes: [...(NOTES[e.kind] ?? []), ...(e.hooks ? HOOK_NOTES : [])],
    ...(e.whyNow ? { whyNow: e.whyNow } : {}), ...(e.hooks ? { hooks: e.hooks } : {}),
    evidence: { urls: e.urls, data: e.data }, candidateLedgerIds: [] } };
}

// A rising shopping keyword says nothing about why it rises. Before briefing, find the trigger in the news and turn
// it into hooks; the headline and question then lead with the reason instead of the fixed template (owner
// 2026-09-27: "이런거 좀 진부하지않냐?"). A failed probe leaves the event as it was, marked "원인 미확인".
export async function enrichWithHooks(e, { probe, now }) {
  if (e.kind !== 'shopping_trend' || !probe) return e;
  let whyNow;
  try { whyNow = await probe(e.data.keyword, { now }); } catch (err) { whyNow = { error: err.code || 'PROBE_FAILED', triggers: [] }; }
  const hooks = suggestHooks(e, whyNow, { now });
  const t = whyNow.triggers?.[0];
  const reason = t ? `원인: ${t.headline}${t.endsAt && hooks.deadline ? ` (${new Date(Date.parse(hooks.deadline) + 9 * 3600e3).toISOString().slice(5, 10).replace('-', '/')}까지)` : ''}` : '원인 미확인';
  const deadline = hooks.deadline && Date.parse(hooks.deadline);
  return { ...e, whyNow: { checkedAt: whyNow.checkedAt ?? new Date(now).toISOString(), error: whyNow.error ?? null, triggers: whyNow.triggers ?? [] }, hooks,
    headline: `${e.headline} — ${reason}`, readerQuestion: hookQuestion(e, hooks) ?? undefined,
    urls: [...new Set([...(e.urls || []), ...(t?.url ? [t.url] : [])])],
    expiresAt: deadline && (!e.expiresAt || deadline < Date.parse(e.expiresAt)) ? new Date(deadline).toISOString() : e.expiresAt };
}

export const messageFor = (e, briefId) => [`[이벤트] ${e.headline}`, e.expiresAt ? `유효: ${new Date(e.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}까지` : null,
  ...(e.urls || []).slice(0, 2), `브리프 ${briefId} (초안 대기)`].filter(Boolean).join('\n');

// Alert as a draft-and-publish request (affiliate-api-hub approvals): the owner's ✍️ 써서 발행 starts drafting and publishing.
export const draftRequester = ({ approvals, notifier, approvalButtons, approvalText, requestLinks = null, now = () => Date.now() }) => async e => {
  const ttlHours = e.expiresAt ? Math.max(1, Math.min(72, (Date.parse(e.expiresAt) - now()) / 3600e3)) : 48;
  const r = approvals.create({ kind: 'draft-and-publish', params: { briefDir: e.briefDir }, title: e.headline, ttlHours,
    summary: [QUESTIONS[e.kind] ? `질문: ${readerQuestion(e)}` : null,
      ...(e.hooks?.candidates?.length ? ['훅 후보:', ...e.hooks.candidates.map((c, i) => `${i + 1}) ${c.title}`)] : []), ...(e.urls || []).slice(0, 2),
      '누르면 초안 작성 → 검사·Codex 검토·미리보기 → 네이버 발행 → 티스토리 미러까지 진행합니다 (30~90분).'].filter(Boolean).join('\n') });
  const sent = await notifier.send(approvalText(r), { buttons: approvalButtons(r.id, r.kind) });
  approvals.update(r.id, { messageId: sent.messageId ?? null, notified: sent.sent === true });
  // Products of approved LinkPrice merchants get their own "🔗 링크 만들기" request (links need the owner's OK).
  let links = null;
  if (requestLinks && e.briefDir) { try { links = await requestLinks(e.briefDir, { approvals, notifier, approvalButtons, approvalText }); } catch { links = { sent: false, reason: 'LINK_REQUEST_FAILED' }; } }
  return { sent: sent.sent === true, id: r.id, links };
};

function run(args, { cwd = APP, timeoutMs = 900000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code ?? 1, out, err }); });
    child.on('error', () => { clearTimeout(timer); resolve({ exitCode: 1, out, err }); });
  });
}

export async function scan({ now = Date.now(), dryRun = false, notifyEnabled = true, force = [], exec = run, notifier = null, requestDraft = null, probe = null,
  stateFile = path.join(APP, 'workflow-runs', '_events', 'state.json'), runsDir = path.join(APP, 'workflow-runs'), briefRoot = CODEX_ROOT, policy = DEFAULT_POLICY } = {}) {
  const state = existsSync(stateFile) ? readJson(stateFile) : {};
  const dir = path.join(runsDir, `scan-${kst(now).stamp}`);
  mkdirSync(dir, { recursive: true });
  const collectors = {}, outputs = {};
  for (const name of dueCollectors(state, now, policy, force)) {
    const c = COLLECTORS[name](dir.replace(/\\/g, '/'));
    const r = await exec(c.args);
    if (c.copyFrom && r.exitCode === 0 && existsSync(c.copyFrom)) copyFileSync(c.copyFrom, path.join(dir, c.out));
    const file = path.join(dir, c.out);
    collectors[name] = { ran: true, ok: r.exitCode === 0 && existsSync(file), exitCode: r.exitCode };
    if (collectors[name].ok) { outputs[name] = readJson(file); state.lastRun = { ...(state.lastRun || {}), [name]: new Date(now).toISOString() }; }
  }
  const travelSeen = new Set(Object.keys(state.travelSeen || {}));
  const detected = detectAll(outputs, { now, travelSeen });
  const queued = (state.queue || []).filter(e => !e.expiresAt || Date.parse(e.expiresAt) > now);
  const routed = route(detected, { ...state, queue: [] }, { now, policy });
  const quietNow = routed.events.some(e => e.disposition === 'queued');
  // Queued events from quiet hours are sent first once quiet hours end.
  const toSend = quietNow ? [] : queued.map(e => ({ ...e, disposition: 'notified', reason: 'from_queue' }));
  const events = [...toSend, ...routed.events];
  const nextState = { ...routed.state, queue: [...(quietNow ? queued : []), ...routed.events.filter(e => e.disposition === 'queued')] };
  for (const e of events.filter(e => e.kind === 'travel_deals' && ['notified', 'briefed', 'queued'].includes(e.disposition))) {
    for (const i of e.data.items) nextState.travelSeen = { ...(nextState.travelSeen || {}), [i.itemKey]: new Date(now).toISOString() };
  }
  // In place: queued events are the same objects in nextState.queue and must keep the hooks and brief id.
  for (const e of events) {
    if (!['notified', 'briefed', 'queued'].includes(e.disposition) || e.briefId || e.hooks) continue;
    Object.assign(e, await enrichWithHooks(e, { probe, now }));
  }
  for (const e of events) {
    if (!['notified', 'briefed', 'queued'].includes(e.disposition) || e.briefId) continue;
    const { dir: briefDir, brief } = buildBrief(e, { now, root: briefRoot });
    e.briefId = brief.briefId; e.briefDir = briefDir;
    if (!dryRun) writeJson(path.join(briefDir, 'article-brief.json'), brief);
  }
  if (!dryRun && notifyEnabled && notifier) {
    for (const e of events.filter(e => e.disposition === 'notified')) {
      // With a draft requester the alert carries ✍️ 써서 발행 / 건너뛰기 buttons; otherwise it is plain text.
      try {
        if (requestDraft && e.briefDir) { const s = await requestDraft(e); e.notified = s.sent === true; e.approvalId = s.id ?? null; }
        else { const s = await notifier.send(messageFor(e, e.briefId)); e.notified = s.sent === true; }
      } catch { e.notified = false; }
    }
  }
  const result = { schemaVersion: 1, kind: 'event-scan', checkedAt: new Date(now).toISOString(), dryRun, collectors,
    counts: events.reduce((a, e) => ({ ...a, [e.disposition]: (a[e.disposition] ?? 0) + 1 }), {}),
    events: events.map(({ data, ...e }) => ({ ...e, data })) };
  writeJson(path.join(dir, 'events.json'), result);
  if (!dryRun) writeJson(stateFile, nextState);
  return result;
}

async function main() {
  const force = (process.argv.find(a => a.startsWith('--force='))?.slice(8) || '').split(',').filter(Boolean);
  const dryRun = process.argv.includes('--dry-run'), notifyEnabled = !process.argv.includes('--no-notify');
  let notifier = null, requestDraft = null;
  if (!dryRun && notifyEnabled) {
    try { notifier = await (await import(pathToFileURL(path.join(HUB, 'scripts', 'notify.mjs')).href)).defaultNotifier(); } catch { notifier = null; }
    try {
      const { createApprovals, approvalButtons, approvalText } = await import(pathToFileURL(path.join(HUB, 'scripts', 'approvals.mjs')).href);
      const approvals = createApprovals();
      let requestLinks = null;
      try { requestLinks = (await import(pathToFileURL(path.join(HUB, 'scripts', 'linkprice-links.mjs')).href)).requestLinks; } catch { requestLinks = null; }
      requestDraft = draftRequester({ approvals, notifier, approvalButtons, approvalText, requestLinks });
    } catch { requestDraft = null; }
  }
  const r = await scan({ dryRun, notifyEnabled, force, notifier, requestDraft, probe: probeWhyNow });
  console.log(JSON.stringify({ ok: true, checkedAt: r.checkedAt, collectors: r.collectors, counts: r.counts,
    top: r.events.filter(e => ['notified', 'briefed', 'queued'].includes(e.disposition)).map(e => `${e.disposition}: ${e.headline}`) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code || 'EVENT_SCAN_FAILED', message: e.message })); process.exitCode = 1; });
