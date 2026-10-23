// kr.trip.com/sale/deals -> campaign list (no per-product prices; campaigns have start/end times).
// Delivery: ssr_json (__NEXT_DATA__ props.pageProps.initialState.adsData.adsList[]);
// the page itself refreshes via POST /restapi/soa2/19816/bjjson/queryAdsDisplayData.
// startTime/endTime are wall-clock UTC+8 (Trip.com HQ zone): "2026-10-05 22:59:59" == 23:59:59 KST.
import { extractNextData } from './lib.mjs';

function plus1hKst(s) {
  if (!s) return null;
  const t = Date.parse(s.replace(' ', 'T') + '+08:00');
  if (Number.isNaN(t)) return null;
  return new Date(t + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

export function parseTripDeals(html) {
  const d = extractNextData(html);
  const ads = d?.props?.pageProps?.initialState?.adsData?.adsList ?? [];
  return ads.map((a) => ({
    source: 'trip-kr-deals',
    promoId: a.promoId ?? a.displayDataId,
    title: a.title,
    intro: a.introduction || null,
    startsAtKst: plus1hKst(a.startTime),
    endsAtKst: plus1hKst(a.endTime),
    endsAtRaw: a.endTime ?? null,
    landingUrl: a.pageLink || a.canonicalUrl || null,
    image: a.coverImageUrl || a.displayDataUrl || null,
    kind: /항공|에어|라이브/.test(a.title + (a.introduction || '')) ? 'flight' : /호텔|숙소/.test(a.title) ? 'hotel' : 'campaign',
  }));
}
