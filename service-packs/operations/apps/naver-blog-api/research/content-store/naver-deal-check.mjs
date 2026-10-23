// 네이버 오늘끝딜 × 쇼핑 커넥트: which active 오늘끝딜 items are sold by a 쇼핑 커넥트 store and are the lowest payable
// price against Danawa, Naver 통합검색 cards and other 커넥트 stores (priceVerdict with the 끝딜 item as `self`).
// Usage: node naver-deal-check.mjs [--limit=40] [--out=path.json]
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { searchDanawa, fetchDanawaOffers, matchDanawaResult, danawaQuery, sizeTokens, danawaSession } from './danawa-prices.mjs';
import { naverSearchCards, makeRunner, DEFAULT_CRAWLER_DIR, OPERATIONS } from './naver-crawler-snapshot.mjs';
import { brandconnectSearch } from './brandconnect-offers.mjs';
import { naverSameProduct, priceVerdict } from './goldbox-market-check.mjs';
import { loadTossMarketSnapshot, matchTossMarketOffers, tossCoverageNeedsVerification } from './toss-market-offers.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const modelCode = title => /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{2,}-[A-Z0-9-]{3,}\b|\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z]{2})[A-Z0-9]{7,}\b/.exec(String(title))?.[0] ?? null;
const idOf = url => /\/products\/(\d+)/.exec(String(url ?? ''))?.[1] ?? null;

export async function checkNaverDeals(deals, { connectSearch, naverCards = null, tossSearch = null, fetchImpl = danawaSession(), delayMs = 800 }) {
  const rows = [];
  for (const deal of deals) {
    const price = deal.discountedPrice ?? deal.salePrice;
    const base = { title: deal.title, productId: deal.productId, url: deal.url, price, listPrice: deal.salePrice, saleEnd: deal.saleEndAt ?? deal.campaignEndAt ?? null,
      image: [deal.imageUrl, deal.image, deal.thumbnailUrl, deal.productImageUrl].find(u => /^https:\/\//.test(String(u ?? ''))) ?? null };
    const query = danawaQuery(deal.title) || deal.title.slice(0, 40);
    let products;
    try { products = await connectSearch(query); } catch (error) { rows.push({ ...base, route: 'error', error: error.code ?? 'UNKNOWN' }); continue; }
    const own = products.find(p => idOf(p.productUrl) === String(deal.productId));
    if (!own) { rows.push({ ...base, route: 'not_in_connect' }); continue; }
    let danawaOffers = [], danawa = null;
    try {
      // A model code (NT960QHA-K71AR) finds the exact Danawa product when the title carries specs Danawa's name lacks.
      const model = modelCode(deal.title);
      const search = await searchDanawa(model ?? query, { fetchImpl });
      const sizes = sizeTokens(deal.title);
      const byModel = search.results.filter(x => x.name.toUpperCase().includes(model));
      // One model code can cover several storage sizes (SM-S948N 256GB/512GB); prefer the listing that names the same sizes.
      const match = model ? (byModel.find(x => sizes.length && sizes.every(s => sizeTokens(x.name).includes(s))) ?? (byModel.length === 1 ? byModel[0] : null))
        : matchDanawaResult(deal.title, search.results);
      if (match) {
        await sleep(delayMs);
        const offers = await fetchDanawaOffers(match.pcode, { fetchImpl });
        danawaOffers = offers.offers;
        danawa = { pcode: offers.pcode, name: offers.name };
      }
    } catch (error) { if (error.code === 'ACCESS_BLOCKED') { rows.push({ ...base, route: 'error', error: 'DANAWA_BLOCKED' }); break; } }
    let naverSame = [];
    if (naverCards) {
      try { naverSame = naverSameProduct(deal.title, (await naverCards(query)).filter(c => c.seller !== own.storeName)); } catch { naverSame = []; }
    }
    const connectSame = naverSameProduct(deal.title, products.filter(p => p !== own && p.storeName !== own.storeName));
    const shipping = deal.isDeliveryFree === true ? 0 : Number.isFinite(deal.deliveryFee) ? deal.deliveryFee : null;
    const verdict = priceVerdict({ title: deal.title, salePrice: price, danawaOffers, naverSame, connectSame,
      tossSame: tossSearch?.offers ?? [], excludeMall: own.storeName,
      self: { channel: 'naver_deal', seller: own.storeName, shipping, affiliate: 'naver_connect', productId: own.productId, productUrl: own.productUrl, commissionRate: own.commissionRate } });
    // Without a Danawa listing the comparison is a handful of Naver cards (갤럭시북5: 3 cards at +10,000원 while Danawa had
    // 48 sellers at -299,000원), so an unmatched item is never called the lowest.
    const matchedToss = matchTossMarketOffers(deal.title, tossSearch?.offers ?? []);
    const route = tossSearch && tossCoverageNeedsVerification(tossSearch.coverage) ? 'comparison_toss_unverified'
      : danawa ? verdict.route : matchedToss.length ? 'danawa_unmatched_toss_found' : 'danawa_unmatched';
    rows.push({ ...base, connect: { productId: own.productId, storeName: own.storeName, commissionRate: own.commissionRate, linkUrl: own.linkUrl },
      danawa, route, verdict, matchedTossItemIds: matchedToss.map(offer => offer.tacaItemId),
      comparisonCoverage: { toss: tossSearch?.coverage ?? { configured: false } } });
    await sleep(delayMs);
  }
  return rows;
}

async function main() {
  const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const run = makeRunner(process.env.NAVER_CRAWLER_DIR || DEFAULT_CRAWLER_DIR);
  const r = run(OPERATIONS['naver_shopping.today-deals'], []);
  if (!r.ok) { console.error(JSON.stringify({ ok: false, code: r.code })); process.exitCode = 1; return; }
  // The runner reports its own success; the crawler's result can still fail (2026-10-06: MANIFEST_SCHEMA after Naver moved
  // the promotion layout out of __NEXT_DATA__). That used to read as "0 deals" for every cycle; it is a failure.
  if (r.result?.ok === false) { console.error(JSON.stringify({ ok: false, code: `NAVER_DEALS_${r.result.code ?? 'FAILED'}` })); process.exitCode = 1; return; }
  // --food (owner 2026-10-05, groceries first): only 오늘끝딜 items whose title is food.
  const { isFood } = process.argv.includes('--food') ? await import('./food-classifier.mjs') : { isFood: () => true };
  const deals = (r.result.products ?? []).filter(p => p.status === 'listed_active' && isFood(p.title ?? p.name)).slice(0, Number(arg('limit') ?? 40));
  const tossSearch = process.argv.includes('--food') && deals.length
    ? await loadTossMarketSnapshot({ foodOnly: true, pages: Number(arg('toss-pages') ?? 3) }) : null;
  const rows = await checkNaverDeals(deals, { connectSearch: brandconnectSearch(), naverCards: naverSearchCards(), tossSearch });
  const checkedAt = new Date().toISOString();
  if (arg('out')) writeFileSync(arg('out'), JSON.stringify({ checkedAt, rows,
    comparisonCoverage: { toss: tossSearch?.coverage ?? { configured: false } } }, null, 2));
  for (const row of rows.filter(x => x.verdict)) {
    const v = row.verdict;
    console.log([row.route.padEnd(24), `src ${v.sources}`, `${row.price}원`, `${row.connect.commissionRate}%`, `best ${v.best?.seller ?? '-'} ${v.best?.payable ?? '-'}`, row.title.slice(0, 40)].join(' | '));
  }
  console.log(JSON.stringify({ checkedAt, counts: rows.reduce((a, x) => ({ ...a, [x.route]: (a[x.route] ?? 0) + 1 }), {}) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.code ?? error.message); process.exitCode = 1; });
