// Quick-fact E source (owner 2026-10-05 "여행 핫딜 다른곳들도 탐색해라"): 네이버 여행핫딜 packages with a real end time.
// Reads https://travel-event.naver.com/ (SSR JSON, parsers/naver-travel-event.mjs), keeps packages that are still on, and
// issues a Travel Connect link for each (travel-links.mjs: cached; a product with affiliateEnabled=false fails to issue and
// is kept as a non-linked "other" item only). Hotels are left out: their "~원부터" price needs a dated rate re-check.
//   node hotdeal-check.mjs --out=path.json [--limit=6]
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseTravelEvent } from './parsers/naver-travel-event.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
export const SOURCE_URL = 'https://travel-event.naver.com/';

export async function checkHotdeals({ fetchImpl = globalThis.fetch, now = new Date(), limit = 6, issue } = {}) {
  const res = await fetchImpl(SOURCE_URL, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw Object.assign(new Error('HOTDEAL_HTTP_' + res.status), { code: 'HOTDEAL_HTTP_' + res.status });
  const { items } = parseTravelEvent(await res.text());
  // Two hours of margin: a deal that ends while the post is read is not worth posting.
  const live = items.filter(i => i.kind === 'package' && i.landingUrl && Number.isFinite(i.salePrice)
    && (!i.endsAtUtc || Date.parse(i.endsAtUtc) - now.getTime() > 2 * 3600e3)).slice(0, limit);
  issue ??= async urls => (await import(pathToFileURL('C:/Users/User/Documents/GitHub/affiliate-content-operations/apps/affiliate-api-hub/scripts/travel-links.mjs').href))
    .issueTravelLinks(urls.map(url => ({ kind: 'package', url })));
  const issued = live.length ? await issue(live.map(i => i.landingUrl)) : { links: {}, failed: [] };
  const rows = live.map(i => ({ kind: 'travel_hotdeal', source: 'naver-travel-event', sourceUrl: SOURCE_URL, checkedAt: now.toISOString(),
    name: i.name, salePrice: i.salePrice, priceIsFrom: i.priceIsFrom !== false, discountText: i.discountText ?? null, perk: i.perk ?? null,
    sectionTitle: i.sectionTitle ?? null, endsAtUtc: i.endsAtUtc ?? null, endsAtKst: i.endsAtKst ?? null, landingUrl: i.landingUrl, image: i.image ?? null,
    link: issued.links[i.landingUrl] ?? null, linkFailure: issued.failed.find(f => f.url === i.landingUrl)?.code ?? null }));
  return { checkedAt: now.toISOString(), sourceUrl: SOURCE_URL, rows };
}

async function main() {
  const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const r = await checkHotdeals({ limit: Number(arg('limit') ?? 6) });
  if (arg('out')) writeFileSync(arg('out'), JSON.stringify(r, null, 2));
  for (const row of r.rows) console.log([row.name, row.salePrice, row.endsAtKst, row.link ?? `no link (${row.linkFailure})`].join(' | '));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
