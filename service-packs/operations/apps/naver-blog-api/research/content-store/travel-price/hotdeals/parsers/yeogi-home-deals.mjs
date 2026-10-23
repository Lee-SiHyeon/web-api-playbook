// www.yeogi.com (여기어때) home -> event banners with start/end dates + dated stay cards with strike/discount prices.
// Delivery: ssr_json (__NEXT_DATA__ props.pageProps). Works anonymously from a non-KR IP at capture time.
import { extractNextData } from './lib.mjs';

export function parseYeogiHome(html) {
  const pp = extractNextData(html)?.props?.pageProps ?? {};
  const banners = [];
  for (const q of pp.dehydratedState?.queries ?? []) {
    const items = q?.state?.data?.content?.items;
    if (!Array.isArray(items)) continue;
    for (const b of items) {
      if (!b.bannerItemId) continue;
      const m = /(https:\/\/[^\s]+)$/.exec(b.scheme || '');
      banners.push({
        source: 'yeogi-home-banners',
        id: b.bannerItemId,
        title: b.title,
        startsAt: b.startDate,
        endsAt: b.endDate,
        open: b.endDate?.startsWith('9999'),
        landingUrl: m ? m[1] : null,
        scheme: b.scheme,
        image: b.imageUrl,
        kind: /항공/.test(b.title) ? 'flight' : /쿠폰|세일|특가/.test(b.title) ? 'coupon_sale' : 'campaign',
      });
    }
  }
  // dated checkIn/checkOut live in accommodationApis[*] query strings
  const apis = Object.values(pp.accommodationApis ?? {}).join(' ');
  const ci = /checkIn=(\d{4}-\d{2}-\d{2})/.exec(apis)?.[1] ?? null;
  const co = /checkOut=(\d{4}-\d{2}-\d{2})/.exec(apis)?.[1] ?? null;
  const stays = [];
  const seen = new Set();
  for (const list of Object.values(pp.accommodationsModuleIndex ?? {})) {
    for (const x of list) {
      const id = x.meta?.id;
      const price = x.room?.stay?.price;
      if (!id || !price || seen.has(id)) continue;
      seen.add(id);
      const strike = price.strikePrice || null;
      const sale = price.discountPrice || null;
      stays.push({
        source: 'yeogi-home-stays',
        id,
        name: x.meta.name,
        grade: x.meta.grade,
        region: x.meta.address?.address ?? null,
        rating10: x.meta.review?.rate ?? null,
        reviewCount: x.meta.review?.count ?? null,
        checkIn: ci,
        checkOut: co,
        originalPrice: strike,
        pricePerNight: sale,
        discountRate: price.discountRate || null,
        couponBadge: (x.room.stay.badges ?? []).map((b) => b.text).filter(Boolean)[0] ?? null,
        image: x.meta.newImages?.[0] ?? null,
        // URL pattern inferred, not observed in the capture: verify before use
        productUrl: `https://www.yeogi.com/domestic-accommodations/${id}`,
      });
    }
  }
  return { banners, stays, checkIn: ci, checkOut: co };
}
