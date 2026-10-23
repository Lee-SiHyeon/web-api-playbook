// travel-event.naver.com ("네이버 여행핫딜") -> normalized deal items.
// Delivery: ssr_json. GET https://travel-event.naver.com/ and read <script id="__NEXT_DATA__">
// props.pageProps.hotDeals[]. Section end times are UTC ISO strings; we also emit KST.
import { extractNextData, parseWonRange, discountPct, toKst } from './lib.mjs';

function landingInfo(url) {
  if (!url) return {};
  try {
    const u = new URL(url);
    if (u.hostname === 'naver.triptopaz.com') {
      return {
        kind: 'hotel',
        hotel: {
          hcd: u.searchParams.get('hcd'),
          checkin: u.searchParams.get('checkin'),
          checkout: u.searchParams.get('checkout'),
          adult: Number(u.searchParams.get('adult')) || null,
          eventCd: u.searchParams.get('eventCd'),
        },
      };
    }
    if (u.hostname === 'pkgtour.naver.com') {
      const m = /^\/products\/([^/]+)\/([^/?]+)/.exec(u.pathname);
      if (m) return { kind: 'package', package: { seller: m[1], code: decodeURIComponent(m[2]) } };
    }
  } catch {
    /* fall through */
  }
  return {};
}

export function parseTravelEvent(html) {
  const data = extractNextData(html);
  const sections = data?.props?.pageProps?.hotDeals ?? [];
  const items = [];
  for (const s of sections) {
    if (s.sectionType === 'exclusive' && s.exclusiveContent) {
      const c = s.exclusiveContent;
      const original = parseWonRange(c.originalPrice).sale;
      const sale = parseWonRange(c.salePrice);
      items.push({
        section: s.clickCode,
        sectionType: 'exclusive',
        serviceType: 'hotel',
        ...landingInfo(c.landingUrl),
        name: c.title,
        headline: (c.headline || '').replace(/<br\s*\/?>/gi, ' '),
        originalPrice: original,
        salePrice: sale.sale,
        priceIsFrom: sale.from,
        discountPct: discountPct(original, sale.sale),
        discountText: c.caption || null,
        endsAtUtc: s.showEventEndDate || null,
        endsAtKst: toKst(s.showEventEndDate),
        landingUrl: c.landingUrl,
        image: c.images?.[0] ?? null,
      });
    } else if (s.sectionType === 'flicking') {
      for (const p of s.products ?? []) {
        const price = parseWonRange(p.price);
        const landing = p.pcLandingUrl || p.moLandingUrl;
        const end = p.showProductEndDate || s.showEventEndDate || null;
        items.push({
          section: s.clickCode,
          sectionType: 'flicking',
          serviceType: s.serviceType,
          sectionTitle: s.title,
          ...landingInfo(landing),
          productId: p.productId,
          name: p.productName,
          originalPrice: price.original,
          salePrice: price.sale,
          priceIsFrom: price.from,
          discountPct: discountPct(price.original, price.sale),
          discountText: p.description1 || null,
          perk: p.description2 || null,
          endsAtUtc: end,
          endsAtKst: toKst(end),
          landingUrl: landing,
          image: p.pcImage || p.moImage || null,
        });
      }
    }
  }
  return { sectionCount: sections.length, items };
}
