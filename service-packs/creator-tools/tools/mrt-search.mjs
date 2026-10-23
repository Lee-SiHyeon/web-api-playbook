if (process.argv.includes('--help')) { console.log('mrt-search.mjs — see service-packs/creator-tools/README.md for inputs and execution mode'); process.exit(0); }
// node mrt-search.mjs "<query>" [n]  -> experiences products (id, title, price, rating, reviews) from the public search page
const [q, n = 12] = process.argv.slice(2);
const html = await (await fetch('https://www.myrealtrip.com/search?q=' + encodeURIComponent(q), { headers: { 'user-agent': 'Mozilla/5.0' } })).text();
const nd = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
const found = new Map();
const walk = (v) => {
  if (Array.isArray(v)) return v.forEach(walk);
  if (v && typeof v === 'object') {
    const id = v.gid ?? v.productId ?? v.id;
    const title = v.title ?? v.name ?? v.productTitle;
    const url = v.url ?? v.linkUrl ?? v.productUrl ?? '';
    if (id && typeof title === 'string' && title.length > 6 && (/products|offers/.test(String(url)) || v.salePrice != null || v.price != null)) {
      if (!found.has(String(id))) found.set(String(id), { id: String(id), title, url: String(url), price: v.salePrice ?? v.price?.salePrice ?? v.price ?? v.displayPrice ?? null, rating: v.reviewScore ?? v.rating ?? v.averageRating ?? null, reviews: v.reviewCount ?? null });
    }
    Object.values(v).forEach(walk);
  }
};
if (nd) walk(JSON.parse(nd[1]));
const rows = [...found.values()].slice(0, Number(n));
if (!rows.length) { const ids = [...new Set([...html.matchAll(/(?:products|offers)\/(\d{5,8})/g)].map((m) => m[1]))]; console.log(JSON.stringify({ q, fallbackIds: ids.slice(0, n) })); }
for (const r of rows) console.log(JSON.stringify(r).slice(0, 260));
