if (process.argv.includes('--help')) { console.log('mrt-product.mjs — see service-packs/creator-tools/README.md for inputs and execution mode'); process.exit(0); }
// node mrt-product.mjs id1 id2 ...  -> title, price (from og/meta/JSON-LD) of experiences.myrealtrip.com/products/<id>
for (const id of process.argv.slice(2)) {
  try {
    const h = await (await fetch(`https://experiences.myrealtrip.com/products/${id}`, { headers: { 'user-agent': 'Mozilla/5.0' } })).text();
    const title = (/<meta property="og:title" content="([^"]+)"/.exec(h) || /<title>([^<]+)/.exec(h) || [])[1];
    const price = (/"price"\s*:\s*"?(\d{3,7})/.exec(h) || /"salePrice"\s*:\s*(\d{3,7})/.exec(h) || [])[1];
    const rating = (/"ratingValue"\s*:\s*"?([\d.]+)/.exec(h) || [])[1];
    const reviews = (/"reviewCount"\s*:\s*"?(\d+)/.exec(h) || [])[1];
    console.log(JSON.stringify({ id, title: title?.replace(/&amp;/g, '&').slice(0, 90), price, rating, reviews }));
  } catch (e) { console.log(JSON.stringify({ id, error: e.message })); }
  await new Promise((r) => setTimeout(r, 700));
}
