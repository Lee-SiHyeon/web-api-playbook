// Event detectors: pure functions from one collector output to candidate events.
// Every event has a stable `key` (dedupe across scans), a `kind`, a `score` for ranking within its kind,
// a Korean `headline`, the `genre`/`field` a brief would use, evidence `urls`, and an optional `expiresAt`
// after which the event is worthless (a Goldbox deal's end time, a departure date).
//
//   goldbox_lowest   market-check.json rows whose Goldbox price beats every other mall on Danawa by a margin
//   travel_deals     naver-connect.json travel products newly on 여행핫딜 / 가격하락 lists (one batch event)
//   shopping_trend   trend-radar latest.json Shopping Insight keywords that are new or climbing on the daily horizon
//   ai_news          collection.json AI items: official feeds, well-liked creator posts, popular papers
//   housing_schedule life-benefits.json 청약 notices opening in the next two weeks (weekly roundup)
//   benefit_new      life-benefits.json 보조금24 programs registered this week that match the ontology seeds
export const DEFAULT_THRESHOLDS = {
  // A real deal either saves a clear share of the price or a clear amount: ≥8%, or ≥5,000원 and ≥3%.
  goldbox: { minPct: 0.08, minKrw: 5000, minPctWithKrw: 0.03 },
  travel: { minDaysOut: 7, maxDaysOut: 90, maxItems: 6, minItems: 3 },
  trend: { minScore: 60, minMomentum: 0.25 },
  // Official = first-party feeds only (sources.json ids official-*, plus the Altman blog feed). Social posts must be about AI and
  // say something (≥40 chars). X engagement runs orders of magnitude above Threads, so it is scaled down for ranking.
  ai: { maxAgeHours: 36, minLikes: 30, minPaperUpvotes: 50, minTextChars: 40, xLikesPerPoint: 100, threadsLikesWeight: 5,
    officialSources: /^official-|^watch-ai-altman-blog-rss$/,
    // The vendors' own X accounts announce a model before any feed or article does; a model headline from one of them counts alone.
    vendorAccounts: /^creator-ai-x-(anthropicai|openai|googleai|spacexai|alibaba-qwen|deepseek)$/,
    // New frontier-model launches surface first on HN / GeekNews / creator feeds as bare headlines with no engagement numbers.
    // A headline naming a model family + version counts when it links to a first-party host or ≥2 distinct sources carry the same model.
    // Latin names and the Korean spellings Korean outlets use ("클로드 소넷 5.5", "Grok 4.7을"); "Qwen3Guard" and "Grok 4.7B" are different models, so a Latin letter or digit may not follow the version,
    // and the version is matched whole (the lookahead capture \2 cannot backtrack to "4"). Hyphenated pairs count only for "5-5" style slugs, not "3.8-27B".
    frontierModel: /(?<![\p{L}\p{N}])(claude|sonnet|opus|haiku|fable|gpt|gemini|grok|qwen|deepseek|llama|mistral|kimi|glm|클로드|소넷|오퍼스|하이쿠|제미나이|제미니|그록|큐웬|딥시크)[\s-]*v?(?=(\d+(?:\.\d+)*(?:-\d(?![\p{L}\p{N}.]))?))\2(?![A-Za-z0-9])/iu,
    frontierAlias: { 클로드: 'claude', 소넷: 'sonnet', 오퍼스: 'opus', 하이쿠: 'haiku', 제미나이: 'gemini', 제미니: 'gemini', 그록: 'grok', 큐웬: 'qwen', 딥시크: 'deepseek' },
    frontierHosts: /(^|\.)(anthropic\.com|claude\.com|openai\.com|deepmind\.google|blog\.google|ai\.google\.dev|x\.ai|qwen\.ai|deepseek\.com|ai\.meta\.com|mistral\.ai)$/i,
    frontierMinSources: 2,
    // The headline must read like a launch or a lifecycle change (short, leading with the model, or a release/retire word), not a customer story or a passing mention in a ranking story.
    frontierMaxTitleChars: 40,
    frontierLaunch: /\b(launch(es|ed)?|releas(e|es|ed)|introduc(e|es|ing)|announc(e|es|ed|ing)|unveil(s|ed)?|scrap(s|ped)?|shelv(e|es|ed)|delay(s|ed)?|retir(e|es|ed|ing)|deprecat(e|es|ed|ing)|discontinu(e|es|ed|ing)|sunset(s|ting)?|now available|is (out|live|here)|just dropped)\b|출시|공개|발표|폐기|중단|지연|연기|철회|종료|단종/i,
    topic: /\b(AI|LLM|GPT|Claude|Gemini|Llama|model|models|agent|agents|open[- ]?source|release[sd]?|launch(ed|es)?|benchmark|API)\b|인공지능|모델|에이전트|출시|공개|업데이트/i },
};
const won = n => `${Math.round(n).toLocaleString('ko-KR')}원`;
const day = t => new Date(t).toISOString().slice(0, 10);

export function detectGoldbox(marketCheck, { now = Date.now(), t = DEFAULT_THRESHOLDS.goldbox } = {}) {
  const events = [];
  for (const r of marketCheck?.rows || []) {
    if (r.status !== 'beats_market' || !Number.isFinite(r.salePrice) || !Number.isFinite(r.market?.lowestOtherTotal)) continue;
    const saving = r.market.lowestOtherTotal - r.salePrice, pct = saving / r.market.lowestOtherTotal;
    if (!(pct >= t.minPct || (saving >= t.minKrw && pct >= t.minPctWithKrw))) continue;
    if (r.eventEnd && Date.parse(r.eventEnd) <= now) continue;
    const productId = /\/products\/(\d+)/.exec(r.url || '')?.[1] ?? r.url;
    events.push({ kind: 'goldbox_lowest', key: `goldbox:${productId}:${r.salePrice}`, score: saving, genre: 'deal_roundup', field: 'deals',
      headline: `골드박스 진짜 최저가: ${r.title} ${won(r.salePrice)} (다른 몰 최저 ${won(r.market.lowestOtherTotal)}, ${won(saving)} 저렴)`,
      urls: [r.url, r.danawa?.url].filter(Boolean), expiresAt: r.eventEnd ?? null,
      data: { title: r.title, salePrice: r.salePrice, lowestOtherTotal: r.market.lowestOtherTotal, lowestOtherMall: r.market.lowestOther?.mall ?? null, saving, danawaPcode: r.danawa?.pcode ?? null, checkedAt: r.danawa?.checkedAt ?? marketCheck.checkedAt } });
  }
  return events;
}

// One batch event per scan: travel posts are roundups, so single products don't become separate briefs.
export function detectTravelDeals(connect, { now = Date.now(), seen = new Set(), t = DEFAULT_THRESHOLDS.travel } = {}) {
  const fresh = new Map();
  for (const p of connect?.products || []) {
    if (p.channel !== 'travel' || p.context?.kind !== 'recommend' || !/^(SPECIAL_OFFER|PRICE_DROP)\//.test(p.context.key)) continue;
    const start = Date.parse(p.detail?.startDate);
    if (!Number.isFinite(start) || start < now + t.minDaysOut * 864e5 || start > now + t.maxDaysOut * 864e5) continue;
    const itemKey = `${p.productId}:${p.discountedPrice}`;
    if (seen.has(itemKey) || fresh.has(itemKey)) continue;
    const commission = Math.round((p.discountedPrice ?? 0) * ((p.commissionRate ?? 0) + (p.promotionCommissionRate ?? 0)) / 100);
    fresh.set(itemKey, { itemKey, productId: p.productId, name: p.name, store: p.storeName, price: p.discountedPrice, discountRate: p.discountRate,
      startDate: p.detail.startDate, duration: p.detail.duration, countries: p.detail.countries, cities: p.detail.cities, url: p.url, section: p.context.key, commission });
  }
  const items = [...fresh.values()].sort((a, b) => b.commission - a.commission).slice(0, t.maxItems);
  if (items.length < t.minItems) return [];
  const places = [...new Set(items.flatMap(i => i.countries || []))].slice(0, 4).join('·');
  return [{ kind: 'travel_deals', key: `travel:${day(now)}:${items.map(i => i.itemKey).sort().join(',')}`, score: items.reduce((s, i) => s + i.commission, 0),
    genre: 'deal_roundup', field: 'travel', headline: `여행 특가 새로 ${items.length}건 (${places || '해외'}) — 가격하락·여행핫딜`,
    urls: items.map(i => i.url), expiresAt: new Date(Math.min(...items.map(i => Date.parse(i.startDate)))).toISOString(),
    data: { items, checkedAt: connect.checkedAt } }];
}

export function detectShoppingTrends(trends, { now = Date.now(), t = DEFAULT_THRESHOLDS.trend } = {}) {
  const events = [];
  for (const k of trends?.shoppingTrends || []) {
    const best = (k.categories || []).map(c => ({ c, d: c.horizons?.date })).filter(x => x.d).sort((a, b) => (b.d.score ?? 0) - (a.d.score ?? 0))[0];
    if (!best || (best.d.score ?? 0) < t.minScore) continue;
    if (!(best.d.novelty === true || (best.d.momentum ?? 0) >= t.minMomentum)) continue;
    events.push({ kind: 'shopping_trend', key: `trend:${k.keyword}:${day(now)}`, score: best.d.score + (best.d.momentum ?? 0) * 100,
      genre: 'deal_roundup', field: 'deals', headline: `쇼핑 검색 급상승: ${k.keyword} (${best.c.name}, ${best.d.novelty ? '신규 진입' : `모멘텀 +${Math.round(best.d.momentum * 100)}%`})`,
      urls: [], expiresAt: new Date(now + 3 * 864e5).toISOString(),
      data: { keyword: k.keyword, category: best.c.name, score: best.d.score, momentum: best.d.momentum ?? 0, novelty: best.d.novelty === true, rank: best.d.latestRank ?? null, checkedAt: trends.checkedAt } });
  }
  return events;
}

export function detectAiNews(collection, { now = Date.now(), t = DEFAULT_THRESHOLDS.ai } = {}) {
  const events = [];
  const isAi = c => c.field === 'ai' || (c.fields || []).includes('ai');
  const fresh = c => { const at = Date.parse(c.publishedAt || c.collectedAt || collection.checkedAt); return Number.isFinite(at) && now - at <= t.maxAgeHours * 3600e3 ? at : null; };
  const firstPartyUrl = c => (c.urls || []).find(u => { try { return t.frontierHosts.test(new URL(u).hostname); } catch { return false; } });
  // "<family> <version>" when the headline names a model and reads like a launch or lifecycle change; a customer story or ranking article that mentions one does not.
  const frontierOf = c => {
    const headline = String(c.title || '').split('\n')[0];
    const m = headline.match(t.frontierModel);
    // A headline that leads with the model ("DeepSeek-V4.1-Flash: Smarter, Faster") is a release title even without a launch word.
    if (!m || (headline.length > t.frontierMaxTitleChars && m.index > 2 && !t.frontierLaunch.test(headline))) return null;
    const name = m[1].toLowerCase();
    return `${t.frontierAlias[name] ?? name} ${m[2].replace(/-/g, '.')}`;
  };
  const groups = new Map();
  for (const c of collection?.candidates || []) {
    if (!isAi(c)) continue;
    const at = fresh(c);
    if (at === null) continue;
    const official = (c.sourceIds || []).some(id => t.officialSources.test(id)) && c.evidenceLevel === 'direct_feed';
    const text = String(c.title || '') + ' ' + String(c.summary || '');
    const onX = (c.sourceIds || []).some(id => /-x-/.test(id));
    const liked = c.sourceKind === 'public_social_post' && (c.engagement?.likes ?? 0) >= t.minLikes
      && String(c.title || '').trim().length >= t.minTextChars && t.topic.test(text);
    const paper = c.sourceKind === 'paper' && (c.engagement?.upvotes ?? c.upvotes ?? 0) >= t.minPaperUpvotes;
    const model = frontierOf(c);
    // Official launches and well-liked posts about a model go to the model-launch buckets, where the vendors' own posts and the press merge into one event per model.
    if (model && (official || liked || !paper)) {
      if (!groups.has(model)) groups.set(model, []);
      groups.get(model).push({ c, at, official: official || (c.sourceIds || []).some(id => t.vendorAccounts.test(id)), liked });
      continue;
    }
    if (!official && !liked && !paper) continue;
    const title = String(c.title || '').split('\n')[0].replace(/https?:\/\/\S+/g, '').trim().slice(0, 90);
    const score = official ? 1000 : liked ? (onX ? c.engagement.likes / t.xLikesPerPoint : c.engagement.likes * t.threadsLikesWeight) : (c.engagement?.upvotes ?? 0);
    events.push({ kind: 'ai_news', key: `ai:${c.id}`, score,
      genre: 'ai_news', field: 'ai', headline: `AI 소식${official ? '(공식)' : liked ? `(좋아요 ${c.engagement.likes})` : '(논문)'}: ${title}`,
      urls: c.urls || [], expiresAt: new Date(at + 72 * 3600e3).toISOString(),
      data: { candidateId: c.id, title: c.title, summary: String(c.summary || '').slice(0, 600), sourceIds: c.sourceIds || [], publisher: c.publisher ?? null, publishedAt: new Date(at).toISOString() } });
  }
  for (const [model, items] of groups) {
    const rank = ({ c, official, liked }) => (official ? 4 : 0) + (firstPartyUrl(c) ? 2 : 0) + (liked ? 1 : 0);
    const best = [...items].sort((x, y) => rank(y) - rank(x) || x.at - y.at)[0];
    const sources = [...new Set(items.flatMap(({ c }) => c.sourceIds || []))];
    if (rank(best) === 0 && sources.length < t.frontierMinSources) continue;
    const { c, at } = best;
    const title = String(c.title || '').split('\n')[0].replace(/https?:\/\/\S+/g, '').trim().slice(0, 90);
    events.push({ kind: 'ai_news', bucket: 'ai_model_launch', key: `ai:frontier:${model.replace(/ /g, '-')}`, score: 900,
      genre: 'ai_news', field: 'ai', headline: `AI 신모델: ${title}`,
      urls: [...new Set(items.flatMap(({ c: x }) => x.urls || []))], expiresAt: new Date(at + 72 * 3600e3).toISOString(),
      data: { candidateId: c.id, title: c.title, summary: String(c.summary || '').slice(0, 600), sourceIds: sources, publisher: c.publisher ?? null,
        publishedAt: new Date(at).toISOString(), model, firstPartyUrl: items.map(({ c: x }) => firstPartyUrl(x)).find(Boolean) ?? null } });
  }
  return events;
}

// 생활꿀팁 (life-benefits.json from life-benefits-snapshot.mjs).
//   housing_schedule  one weekly roundup of APT notices whose 청약 접수 falls in the next two weeks (details with special
//                     supply by type), plus 수도권 무순위·재공급. Keyed by KST week so it briefs once a week.
//   benefit_new       보조금24 programs registered in the last week that match the life-benefits ontology seeds.
export const LIFE_THRESHOLDS = { housing: { aheadDays: 14, minItems: 2, maxItems: 12, maxRentals: 6, capital: /^(서울|경기|인천)/, rentalTopic: /신혼|신생아|청년|행복주택/ }, benefit: { maxAgeDays: 7, maxItems: 5 } };
const weekOf = t => { const d = new Date(t + 9 * 3600e3); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

export function detectHousingSchedule(life, { now = Date.now(), t = LIFE_THRESHOLDS.housing } = {}) {
  const today = new Date(now + 9 * 3600e3).toISOString().slice(0, 10), until = new Date(now + (9 * 3600e3) + t.aheadDays * 864e5).toISOString().slice(0, 10);
  const soon = h => h.receiptStart && h.receiptEnd && h.receiptEnd >= today && h.receiptStart <= until;
  const apt = (life?.housing || []).filter(h => h.source === 'applyhome-apt' && h.detail && soon(h));
  const remndr = (life?.housing || []).filter(h => h.source === 'applyhome-remndr' && soon(h) && t.capital.test(h.region || ''));
  const special = h => h.detail?.specialByType || {};
  const items = [...apt, ...remndr].map(h => ({ noticeId: h.noticeId, source: h.source, name: h.name, region: h.region, kind: h.supplyKind, receiptStart: h.receiptStart,
    receiptEnd: h.receiptEnd, winnerDate: h.winnerDate ?? h.detail?.winnerDate ?? null, totalUnits: h.detail?.totalUnits ?? null,
    newlywed: special(h).newlywed ?? null, firstHome: special(h).firstHome ?? null, newborn: special(h).newborn ?? null, priceManwon: h.detail?.priceManwon ?? null,
    regulation: h.detail?.regulation ?? null, url: h.url }))
    .sort((a, b) => (t.capital.test(b.region) - t.capital.test(a.region)) || (b.totalUnits ?? 0) - (a.totalUnits ?? 0)).slice(0, t.maxItems);
  if (items.length < t.minItems) return [];
  // 수도권 LH rentals aimed at the same readers (신혼·신생아·청년·행복주택), still open; listed beside the sale notices.
  const rentals = (life?.housing || []).filter(h => h.source === 'lh' && h.receiptEnd && h.receiptEnd >= today && t.capital.test(h.region || '')
    && t.rentalTopic.test(h.name || '') && !/^\[정정공고\]/.test(h.name || ''))
    .sort((a, b) => a.receiptEnd.localeCompare(b.receiptEnd)).slice(0, t.maxRentals)
    .map(h => ({ noticeId: h.noticeId, name: h.name, region: h.region, kind: h.supplyKind, receiptEnd: h.receiptEnd, status: h.status, url: h.url }));
  const units = items.reduce((s, i) => s + (i.totalUnits ?? 0), 0), newlywed = items.reduce((s, i) => s + (i.newlywed ?? 0), 0);
  return [{ kind: 'housing_schedule', key: `housing:${weekOf(now)}`, score: units, genre: 'housing_schedule', field: 'life',
    headline: `이번 주·다음 주 청약 일정 ${items.length}곳 (${units.toLocaleString('ko-KR')}세대, 신혼부부 특공 ${newlywed.toLocaleString('ko-KR')}세대)${rentals.length ? ` + LH 임대 ${rentals.length}건` : ''}`,
    urls: [...items, ...rentals].map(i => i.url), expiresAt: new Date(now + 3 * 864e5).toISOString(), data: { week: weekOf(now), items, rentals, checkedAt: life.checkedAt } }];
}

export function detectNewBenefits(life, { now = Date.now(), seeds = [], t = LIFE_THRESHOLDS.benefit } = {}) {
  if (!Array.isArray(life?.benefits)) return [];
  const since = now - t.maxAgeDays * 864e5;
  const norm = s => String(s || '').replace(/\s+/g, '');
  const hits = life.benefits.filter(b => {
    const at = Date.parse(String(b.registeredAt || '').replace(' ', 'T') + (/(Z|[+-]\d\d:?\d\d)$/.test(b.registeredAt || '') ? '' : '+09:00'));
    return Number.isFinite(at) && at >= since && seeds.some(s => norm(`${b.name} ${b.summary} ${b.target}`).includes(norm(s)));
  }).sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, t.maxItems);
  return hits.map(b => ({ kind: 'benefit_new', key: `benefit:${b.serviceId}`, score: b.views ?? 0, genre: 'program_guide', field: 'life',
    headline: `새 지원 제도: ${b.name} (${b.agency ?? '소관기관 미상'})${b.deadline ? ` · 신청기한 ${String(b.deadline).slice(0, 40)}` : ''}`,
    urls: [b.url].filter(Boolean), expiresAt: null, data: { ...b } }));
}

// coupang_not_lowest: coupang-vs-market.json (Danawa, same product page) — everyday products where another mall's shipped
// price beats Coupang's. One weekly roundup; rows flagged needsCheck (likely quantity mismatch) never count.
export const COUPANG_THRESHOLDS = { minItems: 4, maxItems: 8, minGapKrw: 300 };
export function detectCoupangNotLowest(cvm, { now = Date.now(), t = COUPANG_THRESHOLDS } = {}) {
  const rows = (cvm?.rows || []).filter(r => r.comparable && !r.needsCheck);
  const items = rows.filter(r => !r.coupangIsLowest && r.gapKrw >= t.minGapKrw).sort((a, b) => b.gapPct - a.gapPct).slice(0, t.maxItems)
    .map(r => ({ name: r.name, label: r.label ?? null, danawaUrl: r.url, coupangTotal: r.coupang.total, mall: r.cheapestOther.mall, otherTotal: r.cheapestOther.total,
      otherShipping: r.cheapestOther.shipping, gapKrw: r.gapKrw, gapPct: r.gapPct, cheaperMalls: r.cheaperMalls }));
  if (items.length < t.minItems) return [];
  const notLowest = rows.filter(r => !r.coupangIsLowest).length;
  return [{ kind: 'coupang_not_lowest', key: `coupang-vs:${weekOf(now)}`, score: notLowest, genre: 'deal_roundup', field: 'deals',
    headline: `생필품 ${rows.length}개 비교: ${notLowest}개는 쿠팡보다 싼 곳이 있었다 (최대 ${items[0].gapPct}% 차이)`,
    urls: items.map(i => i.danawaUrl), expiresAt: new Date(now + 2 * 864e5).toISOString(),
    data: { compared: rows.length, notLowest, items, checkedAt: cvm.checkedAt } }];
}
