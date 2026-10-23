// MyRealTrip accommodation via the public, anonymous MCP endpoint (JSON-RPC 2.0 over HTTP).
//   POST https://mcp-servers.myrealtrip.com/mcp
//   headers: Content-Type: application/json, Accept: application/json, text/event-stream
//   body: {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"searchStays","arguments":{...}}}
// Documented at https://docs.myrealtrip.com (API > MCP overview: "별도 인증 없이").
// The keyed partner REST API (partner-ext-api.myrealtrip.com /v1/products/accommodation/search) returns
// originalPrice as well; the MCP search returns only the dated per-night price.
import { nightsBetween } from './lib.mjs';

export function buildSearchStaysRequest({ keyword, checkIn, checkOut, adultCount = 2, isDomestic = false, size = 20, page = 1, ...rest }) {
  return {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'searchStays', arguments: { keyword, checkIn, checkOut, adultCount, isDomestic, size, page, ...rest } },
  };
}

const num = (s) => (typeof s === 'string' ? Number(s.replace(/[^\d]/g, '')) || null : null);

function structured(rpc) {
  const r = rpc?.result ?? rpc;
  if (r?.structuredContent) return r.structuredContent;
  const text = r?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

export function parseSearchStays(rpc, { checkIn, checkOut, keyword = null } = {}) {
  const sc = structured(rpc);
  const nights = checkIn && checkOut ? nightsBetween(checkIn, checkOut) : null;
  const stays = sc?.stays ?? [];
  return stays.map((s) => {
    const parts = (s.description || '').split('·').map((x) => x.trim()).filter(Boolean);
    const star = parts.map((p) => /^(\d)성급$/.exec(p)).find(Boolean);
    const perNight = num(s.price);
    const perNightTaxIncl = num(s.additionalPrice);
    const qs = checkIn && checkOut ? `?checkIn=${checkIn}&checkOut=${checkOut}` : '';
    return {
      source: 'mrt-mcp-searchStays',
      gid: s.gid,
      name: s.name,
      city: keyword ?? parts[parts.length - 1] ?? null,
      starRating: star ? Number(star[1]) : null,
      descriptionParts: parts,
      checkIn: checkIn ?? null,
      checkOut: checkOut ?? null,
      nights,
      // null price == no rate for the requested dates (sold out / unavailable): do not post a price.
      pricePerNight: perNight,
      pricePerNightTaxIncluded: perNightTaxIncl,
      totalPriceComputed: perNightTaxIncl && nights ? perNightTaxIncl * nights : null,
      originalPrice: null, // not in search; getStayDetail.pricing.originalPrice (nullable) or partner API items[].originalPrice
      discountPct: null,
      rating: typeof s.rating === 'number' ? s.rating : null,
      reviewCount: num(s.reviewCount),
      freeCancel: Array.isArray(s.tags) && s.tags.includes('무료취소'),
      image: s.thumbnailUrl ?? null,
      productUrl: `https://accommodation.myrealtrip.com/union/products/${s.gid}${qs}`,
      mylinkTargetUrl: `https://accommodation.myrealtrip.com/union/products/${s.gid}${qs}`,
      hasRate: perNight != null,
    };
  });
}

export function parseStayDetail(rpc) {
  const sc = structured(rpc);
  if (!sc?.success) return null;
  const p = sc.pricing ?? {};
  const original = p.originalPrice ?? null;
  return {
    source: 'mrt-mcp-getStayDetail',
    gid: sc.property?.gid,
    name: sc.property?.name,
    city: sc.property?.region?.city ?? null,
    country: sc.property?.region?.country ?? null,
    starRating: Number(sc.property?.grade) || null,
    rating: Number(sc.property?.reviewScore) || null,
    reviewCount: sc.property?.reviewCount ?? null,
    checkIn: sc.searchParams?.checkIn,
    checkOut: sc.searchParams?.checkOut,
    isSoldOut: !!p.isSoldOut,
    pricePerNight: p.averagePrice ?? null,
    totalPrice: p.totalPrice ?? null,
    originalPrice: original,
    discountPct: original && p.averagePrice && p.averagePrice < original ? Math.round((1 - p.averagePrice / original) * 100) : null,
    shareWebLink: sc.property?.shareWebLink ?? null,
    rooms: (sc.rooms ?? []).map((r) => ({
      name: r.roomName,
      pricePerNight: r.ratePlan?.averagePrice ?? null,
      total: r.ratePlan?.totalPrice ?? null,
      originalPrice: r.ratePlan?.originalPrice ?? null,
      freeCancel: !!r.isFreeCancellation,
      status: r.ratePlan?.status ?? null,
    })),
  };
}
