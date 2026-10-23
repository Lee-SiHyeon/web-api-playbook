import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLeadersOntology, validateLeadersOntology, classifyIssues, parseTruthFeed, parseChinaList, parseJapanList, paragraphs, findReactions, mentionsKorea, collectLeaderBrief, renderLeaderBrief, evidenceFor, upcomingWatches }
  from '../research/content-store/leader-statements.mjs';
import { parseUpList, parseIndex, parseStockNews, parseYonhapFeatured, reasonFor, pickFeatured, newsTime, collectFeaturedStocks, renderFeatured }
  from '../research/content-store/featured-stocks.mjs';

const onto = loadLeadersOntology();
const NOW = Date.parse('2026-09-30T12:00:00Z');

// Shapes observed 2026-09-30.
const FEED = `<rss><channel>
<item><title><![CDATA[[No Title] - Post from September 30, 2026]]></title><link>https://www.trumpstruth.org/statuses/42026</link><description><![CDATA[<p></p>]]></description><pubDate>Wed, 30 Sep 2026 00:11:21 +0000</pubDate><truth:originalUrl>https://truthsocial.com/@realDonaldTrump/117357090030899348</truth:originalUrl><truth:originalId>117357090030899348</truth:originalId></item>
<item><title><![CDATA[Iran Has Lost Control of the Strait:]]></title><link>https://www.trumpstruth.org/statuses/42024</link><description><![CDATA[<p>Iran Has Lost Control of the Strait: https:// x.com/a/status/1</p>]]></description><pubDate>Tue, 29 Sep 2026 21:00:34 +0000</pubDate><truth:originalUrl>https://truthsocial.com/@realDonaldTrump/117356339820644146</truth:originalUrl><truth:originalId>117356339820644146</truth:originalId></item>
<item><title><![CDATA[Korea steel]]></title><link>https://www.trumpstruth.org/statuses/42020</link><description><![CDATA[<p>Korea will invest in Alaska LNG and buy American steel &amp; ships. Tariffs stay.</p>]]></description><pubDate>Mon, 28 Sep 2026 10:00:00 +0000</pubDate><truth:originalUrl>https://truthsocial.com/@realDonaldTrump/1</truth:originalUrl><truth:originalId>1</truth:originalId></item>
</channel></rss>`;
const cnPage = `<html><body><p>CCTV: This morning the report was released.</p><p>Guo Jiakun: China’s high-quality development is creating opportunities.</p>
<p>Yonhap: What is China’s position on the US tariff on Korean steel?</p><p>Guo Jiakun: China opposes unilateral tariffs and follows the Republic of Korea’s talks with the US.</p><p>Reuters: One more on Iran.</p><p>Guo Jiakun: We hope Iran and the U.S. resume dialogue.</p></body></html>`;

test('the ontology is well formed and every non-assumption rule cites a source URL', () => {
  assert.deepEqual(validateLeadersOntology(onto), []);
  assert.ok(onto.issueKinds.length >= 8);
  assert.ok(onto.marketImpactRules.every(r => r.status === 'assumption' ? r.measurementPlan : onto.sources[r.sourceId]));
  assert.ok(onto.policy.some(p => /매수·매도 권유/.test(p)));
  const bad = structuredClone(onto);
  bad.issueKinds[0].patterns = [['(']];
  bad.marketImpactRules.push({ id: 'x', status: 'sourced', issueKind: 'tariff_trade' });
  assert.match(validateLeadersOntology(bad).join(), /REGEX:tariff_trade.*RULE_SOURCE:x/);
});

test('the Truth Social mirror feed keeps only posts with text and carries the original URL', () => {
  const posts = parseTruthFeed(FEED);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].originalUrl, 'https://truthsocial.com/@realDonaldTrump/117356339820644146');
  assert.match(posts[1].text, /buy American steel & ships/);
  assert.equal(posts[0].publishedAt, '2026-09-29T21:00:34.000Z');
});

test('issue kinds: Korea + Alaska LNG is an investment issue, a $5000 dividend post is not an FX issue, bare "China" is not a reaction', () => {
  const ids = t => classifyIssues(t, onto).map(k => k.id);
  assert.deepEqual(ids('Korea will invest in Alaska LNG and buy American steel & ships. Tariffs stay.').sort(), ['korea_us_investment', 'steel_autos', 'tariff_trade']);
  assert.deepEqual(ids('A 5000 Dollar Dividend to all adults if Republicans WIN!'), []);
  assert.ok(ids('Iran Has Lost Control of the Strait').includes('mideast_energy'));
  const chinaBoilerplate = 'Guo Jiakun: China’s high-quality development is creating opportunities.';
  assert.ok(classifyIssues(chinaBoilerplate, onto).some(k => k.id === 'us_china'));
  assert.deepEqual(classifyIssues(chinaBoilerplate, onto, 'reaction'), []);
  assert.equal(mentionsKorea('the Republic of Korea'), true);
  assert.equal(mentionsKorea('North Korean'), true);
  assert.equal(mentionsKorea('Koreatown'), false);
});

test('list parsers read observed MFA and MOFA list markup', () => {
  const cn = parseChinaList('<a href="./lxjzh/202609/t20260930_12034352.html">Foreign Ministry Spokesperson Guo Jiakun’s Regular Press Conference on September 30, 2026</a><a href="./lxjzh/202609/t20260930_12034352.html">dup</a>');
  assert.deepEqual(cn.map(c => [c.date, c.url]), [['2026-09-30', 'https://www.mfa.gov.cn/eng/xw/fyrbt/lxjzh/202609/t20260930_12034352.html']]);
  const jp = parseJapanList('<a href="/press/kaiken/kaikenwe_000001_00278.html">Press Conference by Foreign Minister MOTEGI Toshimitsu (September 29, 2026, 2:09 p.m.)</a><a href="/press/kaiken/kaikenwe_000001_00276.html#topic1">Opening Remarks</a>');
  assert.deepEqual(jp.map(c => [c.date, c.url]), [['2026-09-29', 'https://www.mofa.go.jp/press/kaiken/kaikenwe_000001_00278.html']]);
  assert.deepEqual(paragraphs('<p>The Ministry of Foreign Affairs website uses JavaScript.</p><p>The text will be coming soon.</p>'), []);
});

test('a reaction is the answer next to a matching question, and a Korea mention counts even without an issue kind', () => {
  const rs = findReactions(paragraphs(cnPage), onto, { country: 'cn', date: '2026-09-30', url: 'https://x', title: 't' });
  assert.equal(rs.length, 2);
  const tariff = rs.find(r => r.issueKinds.some(k => k.id === 'tariff_trade'));
  assert.match(tariff.answer, /Republic of Korea’s talks/);
  assert.equal(tariff.mentionsKorea, true);
  assert.equal(rs.filter(r => r.paragraph.startsWith('Guo Jiakun')).length, 0);
});

test('the brief links statements to same-issue reactions from Japan and China, and says 미확인 otherwise', async () => {
  const pages = {
    'https://www.trumpstruth.org/feed': FEED,
    [onto.statementChannels.federal_register_eo.url]: JSON.stringify({ results: [{ title: 'Restoring American Saltwater Angling', executive_order_number: 14999, signing_date: '2026-09-22', publication_date: '2026-09-25', html_url: 'https://www.federalregister.gov/d/1' }] }),
    'https://www.mfa.gov.cn/eng/xw/fyrbt/': '<a href="./lxjzh/202609/t20260930_1.html">Foreign Ministry Spokesperson Guo Jiakun’s Regular Press Conference on September 30, 2026</a>',
    'https://www.mfa.gov.cn/eng/xw/fyrbt/lxjzh/202609/t20260930_1.html': cnPage,
    'https://www.mofa.go.jp/press/kaiken/index.html': '<a href="/press/kaiken/kaikenwe_000001_00278.html">Press Conference by Foreign Minister MOTEGI Toshimitsu (September 29, 2026, 2:09 p.m.)</a>',
    'https://www.mofa.go.jp/press/kaiken/kaikenwe_000001_00278.html': '<p>The text will be coming soon.</p>',
  };
  const fetchImpl = async url => pages[url] === undefined ? { ok: false, status: 404 } : { ok: true, arrayBuffer: async () => Buffer.from(pages[url]) };
  const b = await collectLeaderBrief({ fetchImpl, now: NOW, hours: 96, ontology: onto });
  assert.equal(b.statementCount, 2);
  const invest = b.linked.find(l => l.statement.issueKinds.includes('korea_us_investment'));
  assert.equal(invest.statement.mentionsKorea, true);
  assert.equal(invest.statement.originalUrl, 'https://truthsocial.com/@realDonaldTrump/1');
  assert.equal(invest.cn.length, 1);
  assert.match(invest.cn[0].answer, /opposes unilateral tariffs/);
  assert.equal(invest.jp.length, 0);
  const iran = b.linked.find(l => l.statement.issueKinds.includes('mideast_energy'));
  assert.match(iran.cn[0].answer, /Iran and the U\.S\. resume dialogue/);
  assert.deepEqual(b.pendingTranscripts.map(p => p.country), ['jp']);
  assert.equal(b.executiveOrders[0].number, 14999);
  assert.deepEqual(b.errors, []);
  const text = renderLeaderBrief(b);
  assert.match(text, /일본: 공식 반응 미확인/);
  assert.match(text, /본문 미게시: jp 2026-09-29/);
  assert.ok(invest.evidence.some(e => e.id === 'src_deal_terms' && e.useLevel === 'quote_ok' && /whitehouse\.gov/.test(e.sourceUrl)));
  assert.deepEqual(iran.evidence, []);
  assert.match(text, /참고\[quote_ok\/primary\] src_deal_terms:/);
  assert.match(text, /참고: 이 이슈 종류에 검증된 시장 영향 자료 없음/);
  assert.match(text, /같은 이슈 종류의 검증 자료다\. 이 발언과 직접 관련되는지는 글 쓸 때 판단한다/);
  assert.match(text, /기한 2026-11-10 D-41: .*문서상 기한, 연장 여부 미확인/);
  assert.ok(b.gaps.length >= 5);
});

test('market-impact evidence: sourced rules carry how far they may be quoted, assumptions are never returned as evidence', () => {
  const tariff = evidenceFor(onto, ['tariff_trade']);
  assert.deepEqual(tariff.map(e => e.id).sort(), ['src_20260127_threat', 'src_deal_terms', 'src_legal_basis', 'src_sector_view_kiet']);
  assert.equal(tariff.find(e => e.id === 'src_legal_basis').useLevel, 'quote_ok');
  assert.equal(tariff.find(e => e.id === 'src_sector_view_kiet').useLevel, 'reverify_first');
  assert.deepEqual(tariff.find(e => e.id === 'src_20260127_threat').alsoSourceUrls.length, 1);
  assert.equal(evidenceFor(onto, ['semiconductors']).find(e => e.id === 'src_semi_targeted_tariff').useLevel, 'title_only');
  assert.equal(evidenceFor(onto, ['korea_us_investment'])[0].useLevel, 'quote_ok');
  assert.deepEqual(evidenceFor(onto, ['mideast_energy']), []);
  assert.ok(evidenceFor(onto, onto.issueKinds.map(k => k.id)).every(e => e.status !== 'assumption'));
});

test('shipped rules keep the verification discipline: title-only and agent-only sources never carry numbers or quotes', () => {
  for (const r of onto.marketImpactRules.filter(r => r.status === 'sourced')) {
    const level = onto.sources[r.sourceId].checked;
    assert.ok(['body_verified', 'title_verified', 'agent_only'].includes(level), `${r.id} has no checked level`);
    if (level === 'agent_only') assert.equal(r.postUse, 'reverify_first', r.id);
    if (level === 'title_verified') assert.deepEqual(r.numbers, [], r.id);
  }
  const gap = onto.marketImpactRules.find(r => r.id === 'gap_market_reactions');
  assert.equal(gap.status, 'assumption');
  assert.ok(gap.gaps.length >= 5 && gap.measurementPlan);
});

test('the validator rejects unverified numbers, dangling source ids, unknown issue kinds and vocabulary typos', () => {
  const bad = structuredClone(onto);
  bad.marketImpactRules.find(r => r.id === 'src_sector_view_kiet').postUse = null;
  bad.marketImpactRules.find(r => r.id === 'src_semi_targeted_tariff').numbers = ['삼성 400억 달러'];
  bad.marketImpactRules.find(r => r.id === 'src_deal_terms').alsoSourceIds = ['nowhere'];
  bad.marketImpactRules.find(r => r.id === 'src_bok_outlook').issueKind = 'no_such_kind';
  bad.marketImpactRules.find(r => r.id === 'src_us_china_truce').watch.date = '11/10';
  bad.sources.kctdi_20251020_rare_earth.checked = 'looks_fine';
  bad.sources.etnews_20260109_cosmetics.confidence = 'trust_me';
  const errs = validateLeadersOntology(bad).join();
  for (const code of ['AGENT_ONLY_NEEDS_REVERIFY:src_sector_view_kiet', 'TITLE_ONLY_NUMBERS:src_semi_targeted_tariff', 'RULE_ALSO_SOURCE:src_deal_terms:nowhere', 'RULE_KIND:src_bok_outlook', 'RULE_WATCH:src_us_china_truce', 'SOURCE_CHECKED:kctdi_20251020_rare_earth', 'SOURCE_CONFIDENCE:etnews_20260109_cosmetics']) assert.ok(errs.includes(code), code);
});

test('dated hooks count KST days and stay listed after the date passes', () => {
  const w = upcomingWatches(onto, NOW);
  assert.deepEqual(w.map(x => [x.date, x.daysLeft, x.state]), [['2026-11-10', 41, 'upcoming']]);
  assert.match(w[0].sourceUrl, /whitehouse\.gov/);
  assert.deepEqual(upcomingWatches(onto, Date.parse('2026-11-10T20:00:00Z')).map(x => [x.daysLeft, x.state]), [[-1, 'passed']]);
  assert.equal(upcomingWatches(onto, Date.parse('2026-11-09T16:00:00Z'))[0].daysLeft, 0);
});

test('a failing channel is reported in errors and does not stop the other channels', async () => {
  const fetchImpl = async url => url.includes('trumpstruth') ? { ok: false, status: 503 } : { ok: false, status: 404 };
  const b = await collectLeaderBrief({ fetchImpl, now: NOW, ontology: onto });
  assert.equal(b.statementCount, 0);
  assert.ok(b.errors.includes('trump_feed:HTTP_503'));
});

// ---- featured stocks ----
const UP = { stocks: [
  { stockEndType: 'stock', itemCode: '002710', stockName: 'TCC스틸', closePrice: '14,610', fluctuationsRatio: '29.98', compareToPreviousPrice: { name: 'UPPER_LIMIT' }, accumulatedTradingValue: '48,583', accumulatedTradingValueKrwHangeul: '486억원', marketValueHangeul: '3,830억원', endUrl: 'https://m.stock.naver.com/domestic/stock/002710', localTradedAt: '2026-09-30T20:20:19+09:00' },
  { stockEndType: 'stock', itemCode: '111111', stockName: '작은주', closePrice: '1,000', fluctuationsRatio: '3.10', compareToPreviousPrice: { name: 'RISING' }, accumulatedTradingValue: '10' },
  { stockEndType: 'etf', itemCode: '222222', stockName: 'KODEX 뭔가', closePrice: '10,000', fluctuationsRatio: '12.0', compareToPreviousPrice: { name: 'RISING' } },
  { stockEndType: 'stock', itemCode: '333333', stockName: '금강철강', closePrice: '5,000', fluctuationsRatio: '23.6', compareToPreviousPrice: { name: 'RISING' }, accumulatedTradingValue: '73,400' },
] };
const NEWS = [{ total: 1, items: [{ officeName: '연합뉴스', datetime: '202609301633', title: "[특징주] '韓 LNG 대미투자' 전망에 철강주 등 강세(종합)", body: '30일 철강 및 관 이음쇠 관련주가 강세를 보였다. 한국거래소에 따르면 이날 KBI동양철관은 전…', mobileNewsUrl: 'https://n.news.naver.com/mnews/article/001/0016347847' }] },
  { total: 1, items: [{ officeName: '서울신문', datetime: '202609250900', title: '금강철강 지난주 실적 발표', body: '', mobileNewsUrl: 'https://n.news.naver.com/x' }] }];

test('Naver stock JSON becomes rows: stocks only, upper-limit flag, trading value in 억원', () => {
  const rows = parseUpList(UP, 'KOSPI');
  assert.deepEqual(rows.map(r => r.code), ['002710', '111111', '333333']);
  assert.equal(rows[0].upperLimit, true);
  assert.equal(rows[0].tradingValueEok, 486);
  assert.equal(rows[0].changePct, 29.98);
  assert.equal(parseIndex({ itemCode: 'KOSPI', stockName: '코스피', closePrice: '6,838.04', compareToPreviousClosePrice: '-32.77', fluctuationsRatio: '-0.48', marketStatus: 'CLOSE' }).changePct, -0.48);
  const picked = pickFeatured({ up: rows, minRatio: 10 });
  assert.deepEqual(picked.map(r => r.name), ['TCC스틸', '금강철강']);
});

test('a reason needs a fresh headline that names the stock, or a [특징주] piece whose lead names it', () => {
  const news = parseStockNews(NEWS);
  assert.equal(newsTime('202609301633'), Date.parse('2026-09-30T16:33:00+09:00'));
  const tcc = { name: 'TCC스틸' }, kbi = { name: 'KBI동양철관' }, geumgang = { name: '금강철강' };
  assert.equal(reasonFor(kbi, news, NOW + 8 * 3600e3)?.office, '연합뉴스');
  assert.equal(reasonFor(tcc, news, NOW + 8 * 3600e3), null);
  assert.equal(reasonFor(geumgang, news, NOW + 8 * 3600e3), null);
  assert.equal(reasonFor(kbi, news, Date.parse('2026-10-05T00:00:00Z')), null);
  const yna = parseYonhapFeatured('<item><title><![CDATA[[특징주] 삼성전자 강세]]></title><link>https://yna.co.kr/1</link></item><item><title>일반 기사</title><link>https://yna.co.kr/2</link></item>');
  assert.deepEqual(yna.map(y => y.url), ['https://yna.co.kr/1']);
});

test('collectFeaturedStocks marks 이유 미확인 when no headline names the stock, and never invents a reason', async () => {
  const yna = '<rss><item><title><![CDATA[[특징주] 금강철강 급등]]></title><link>https://yna.co.kr/9</link></item></rss>';
  const fetchImpl = async url => {
    const json = body => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes('yna.co.kr')) return { ok: true, text: async () => yna };
    if (url.includes('/stocks/up/KOSPI')) return json(UP);
    if (url.includes('/stocks/up/KOSDAQ')) return json({ stocks: [] });
    if (url.includes('/index/')) return json({ itemCode: 'KOSPI', stockName: '코스피', closePrice: '6,838.04', compareToPreviousClosePrice: '-32.77', fluctuationsRatio: '-0.48' });
    if (url.includes('/news/stock/333333')) return json([]);
    if (url.includes('/news/stock/')) return json(NEWS);
    return { ok: false, status: 404 };
  };
  const r = await collectFeaturedStocks({ fetchImpl, now: NOW + 8 * 3600e3 });
  const byName = Object.fromEntries(r.stocks.map(s => [s.name, s]));
  assert.equal(byName['TCC스틸'].reasonStatus, 'unconfirmed');
  assert.equal(byName['금강철강'].reason.office, '연합뉴스');
  assert.match(renderFeatured(r), /TCC스틸\(KOSPI\) 상한가 \+29\.98% 거래대금 486억원 — 이유 미확인/);
  assert.match(r.policy, /매수·매도 권유/);
  assert.deepEqual(r.errors, []);
});
