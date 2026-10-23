// 카드·쿠폰까지 넣은 최대할인율 (owner 2026-09-29 "카드 쿠폰도 넣었을때 최대할인율 봐줘라").
// The comparison price (`price`) stays free of card/coupon/first-order conditions; this module adds a separate,
// conditional "최대혜택가" per offer. Points (적립) are not a price cut and are reported apart.
//
//   maxBenefit(offer)          -> { basePrice, listPrice, baseRate, bestPrice, bestKind, maxRate, options, conditional, pointBack }
//   summarizeBenefits(offers)  -> per mall counts and the top offers by maxRate

const pct = (from, to) => from > 0 && to >= 0 && to <= from ? Math.round((1 - to / from) * 1000) / 10 : null;
const won = v => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;

export function maxBenefit(o) {
  const basePrice = won(o.price);
  if (!basePrice) return null;
  const listPrice = won(o.listPrice) && o.listPrice >= basePrice ? Number(o.listPrice) : basePrice;
  const options = [{ kind: 'base', price: basePrice, label: '표시가', conditional: false }];
  if (won(o.cardPrice) && o.cardPrice < basePrice) options.push({ kind: 'card', price: Number(o.cardPrice), label: o.cardBenefit || '카드 할인', conditional: true, approx: o.cardPriceApprox === true });
  if (won(o.couponPrice) && o.couponPrice < basePrice) options.push({ kind: 'coupon', price: Number(o.couponPrice), label: o.couponBenefit || '쿠폰 적용가', conditional: true });
  if (won(o.firstOrderPrice) && o.firstOrderPrice < basePrice) options.push({ kind: 'first_order', price: Number(o.firstOrderPrice), label: '첫 구매 혜택', conditional: true });
  const best = options.reduce((a, b) => (b.price < a.price ? b : a));
  return { basePrice, listPrice, baseRate: pct(listPrice, basePrice), bestPrice: best.price, bestKind: best.kind, bestLabel: best.label,
    maxRate: pct(listPrice, best.price), extraRate: pct(basePrice, best.price), options, conditional: best.conditional,
    approx: best.approx === true, pointBack: won(o.pointBack), memberBenefit: won(o.memberBenefit) };
}

export function summarizeBenefits(offers, { top = 3 } = {}) {
  const rows = offers.filter(o => !o.sponsored && !o.soldOut).map(o => ({ o, b: maxBenefit(o) })).filter(x => x.b);
  const byMall = {};
  for (const { o, b } of rows) {
    const m = (byMall[o.mall] ??= { offers: 0, withCondition: 0, withPoints: 0, best: null });
    m.offers++;
    if (b.conditional) m.withCondition++;
    if (b.pointBack) m.withPoints++;
    if (!m.best || (b.maxRate ?? 0) > (m.best.maxRate ?? 0)) m.best = { name: o.name, url: o.url, ...b };
  }
  const ranked = rows.filter(x => x.b.maxRate != null).sort((a, b) => b.b.maxRate - a.b.maxRate).slice(0, top)
    .map(({ o, b }) => ({ mall: o.mall, name: o.name, url: o.url, ...b }));
  const conditionalTop = rows.filter(x => x.b.conditional && x.b.extraRate != null).sort((a, b) => b.b.extraRate - a.b.extraRate).slice(0, top)
    .map(({ o, b }) => ({ mall: o.mall, name: o.name, url: o.url, ...b }));
  return { byMall, top: ranked, topConditional: conditionalTop };
}
