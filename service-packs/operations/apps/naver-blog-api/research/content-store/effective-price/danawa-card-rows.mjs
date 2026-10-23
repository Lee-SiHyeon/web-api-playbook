// Danawa conditional (card / membership) price parsers. Pure functions over HTML strings; no network.
// Observed 2026-10-05 (anonymous GET/POST, non-KR egress) on https://prod.danawa.com/info/?pcode=94699838:
//   SSR  : #lowPriceCompanyArea .box__membership  ("멤버십/카드결제 최대 혜택가") -> li.list-item
//   XHR  : getAllPriceCompareMallList.ajax.php (the request danawa-prices.mjs fetchDanawaOffers() already makes)
//          -> div.diff_item div.card_line { span.card_prc em.prc_t, span.txt[title] } next to span.price em.prc_c
// Danawa shows these rows only when they undercut its own lowest price (page notice). They carry no cap, minimum
// purchase or instant/billing split, so every row is kind=card_unspecified, verification=aggregator_unverified.
const won = v => { const n = Number(String(v ?? '').replace(/[^\d]/g, '')); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const text = html => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const attr = (html, re) => re.exec(html)?.[1] ?? null;
const linkProductOf = block => {
  const href = attr(block, /href="([^"]*loadingBridge[^"]*)"/);
  if (!href) return null;
  const q = new URLSearchParams(href.replace(/&amp;/g, '&').split('?')[1] ?? '');
  return q.get('cmpnyc') && q.get('link_pcode') ? `${q.get('cmpnyc')}_${q.get('link_pcode')}` : null;
};
const CARD_WORDS = /카드|페이|Pay|pay/;
const MEMBER_WORDS = /멤버십|N\+|네이버플러스|와우|유니버스|회원/;

// Label such as "삼성카드 결제 시" -> { instrument: '삼성카드', kind }.
export function classifyDanawaLabel(label) {
  const clean = String(label ?? '').replace(/\s*(결제|가입)\s*시\s*$/, '').trim();
  if (MEMBER_WORDS.test(clean) && !/카드/.test(clean)) return { instrument: clean, kind: 'membership_price' };
  if (CARD_WORDS.test(clean)) return { instrument: clean, kind: 'card_unspecified' };
  return { instrument: clean || null, kind: 'card_unspecified' };
}

function toConditionalPrice({ instrument, kind, amount }, { pageUrl, observedAt, label }) {
  return {
    kind, priceEffect: 'price_cut', instrument, amount,
    condition: { note: label ?? null },
    period: null,
    source: { url: pageUrl ?? null, observedAt: observedAt ?? null, verification: 'aggregator_unverified', via: 'danawa' },
  };
}

// SSR block. Rows are listed twice (compact list + layer); the layer repeats them with the cash price and rate.
export function parseDanawaMembershipBox(pageHtml, { pageUrl = null, observedAt = null } = {}) {
  const src = String(pageHtml);
  const start = src.indexOf('box__membership');
  if (start < 0) return [];
  const area = src.slice(start, src.indexOf('box__mall-price', start) > 0 ? src.indexOf('box__mall-price', start) : undefined);
  const rows = new Map();
  for (const m of area.matchAll(/<li class="list-item">([\s\S]*?)<\/li>/g)) {
    const b = m[1];
    const mall = attr(b, /<img[^>]*alt=['"]([^'"]*)['"]/);
    const amount = won(attr(b, /class="text__num">([^<]*)</) ?? attr(b, /class="text__discount-price">([^<]*)</));
    const label = text(attr(b, /class="(?:text__desc|box__desc-wrap)">([\s\S]*?)<\/div>/));
    if (!mall || amount === null) continue;
    const key = `${linkProductOf(b) ?? mall}:${amount}`;
    const prev = rows.get(key) ?? {};
    rows.set(key, {
      ...prev, mall, linkProduct: linkProductOf(b) ?? prev.linkProduct ?? null, amount, label: label || prev.label || '',
      cashPrice: won(attr(b, /class="text__original-price">([^<]*)</)) ?? prev.cashPrice ?? null,
      ratePct: Number(attr(b, /class="text__discount-rate">([\d.]+)%/)) || prev.ratePct || null,
      shippingText: text(attr(b, /class="box__delivery">([\s\S]*?)<\/div>/)) || prev.shippingText || null,
    });
  }
  return [...rows.values()].map(r => {
    const c = classifyDanawaLabel(r.label);
    return { mall: r.mall, linkProduct: r.linkProduct, cashPrice: r.cashPrice, ratePct: r.ratePct, shippingText: r.shippingText,
      conditionalPrice: toConditionalPrice({ ...c, amount: r.amount }, { pageUrl, observedAt, label: r.label }) };
  });
}

// XHR rows. One entry per diff_item that has a card_line.
export function parseDanawaCardRows(mallListHtml, { pageUrl = null, observedAt = null } = {}) {
  const out = [];
  for (const m of String(mallListHtml).matchAll(/<div class="diff_item[^"]*"\s+data-linkProduct="([^"]+)"[^>]*>([\s\S]*?)(?=<div class="diff_item|<input type="hidden"|$)/g)) {
    const [, linkProduct, block] = m;
    const card = /<div class="card_line">([\s\S]*?)<\/div>/.exec(block)?.[1];
    if (!card) continue;
    const cardPrice = won(attr(card, /class="prc_t">([^<]*)</));
    const instrument = attr(card, /class="txt"\s+title="([^"]*)"/) ?? text(attr(card, /class="txt"[^>]*>([\s\S]*?)<\/span>/));
    const cashPrice = won(attr(block, /<em class="prc_c">([^<]*)<\/em>/));
    if (cardPrice === null || cashPrice === null) continue;
    const mall = (attr(block, /<div class="d_mall">[\s\S]*?<img[^>]*alt="([^"]*)"/) ?? '').trim();
    const shipText = text(attr(card, /class="ship">([\s\S]*?)<\/span>/));
    const shipping = /무료/.test(shipText) ? 0 : won(/배송비\s*([\d,]+)/.exec(shipText)?.[1]);
    const c = classifyDanawaLabel(instrument);
    out.push({ mall, linkProduct, cashPrice, shipping, shippingText: shipText || null,
      conditionalPrice: toConditionalPrice({ ...c, amount: cardPrice }, { pageUrl, observedAt, label: instrument }) });
  }
  return out;
}

// Attach parsed rows to offers shaped like danawa-prices.mjs parseDanawaMallList() output ({mall, price, ...}).
// Match on linkProduct when the offer has one, else on mall + cash price. Returns new offer objects.
export function attachDanawaConditionals(offers, rows) {
  const used = new Set();
  const out = offers.map(o => {
    const hit = rows.filter(r => (o.linkProduct && r.linkProduct === o.linkProduct) || (r.mall === o.mall && r.cashPrice === o.price));
    if (!hit.length) return { ...o };
    hit.forEach(h => used.add(h));
    const existing = o.conditionalPrices ?? [];
    const fresh = hit.map(h => h.conditionalPrice).filter(c => !existing.some(e => e.instrument === c.instrument && e.amount === c.amount));
    return { ...o, conditionalPrices: [...existing, ...fresh] };
  });
  return { offers: out, unmatched: rows.filter(r => !used.has(r)) };
}
