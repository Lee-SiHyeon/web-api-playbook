// pkgtour.naver.com GraphQL (anonymous): imminent-departure overseas package lists.
//   POST https://pkgtour.naver.com/graphql   Content-Type: application/json   Origin: https://pkgtour.naver.com
//   queries copied from the site's own bundle: GET_DEPARTURE_THIS_WEEK / GET_NATION_GROUP_PRODUCTS
// "price" is a from-price per person in KRW; totalPromoAccRate is Naver point accrual %, not a discount.
export const QUERY_DEPARTURE_THIS_WEEK =
  'query GET_DEPARTURE_THIS_WEEK($device: String) { overseasDepartureThisWeek(device: $device) { productId productName image price agtCode landingMo landingPc beginDate beginTime totalPromoAccRate totalSavingPoint totalSavingFlat isTravelLive isHomeShopping badge { text textColor backgroundColor } discountOtaCouponGrade supportNaverPlus productFamilyId } }';

export const QUERY_NATION_GROUP =
  'query GET_NATION_GROUP_PRODUCTS($device: String, $isImminent: Boolean, $continentCode: String) { overseasProductsByNationGroup(device: $device, isImminent: $isImminent, continentCode: $continentCode) { productId productName image price agtCode landingMo landingPc beginDate endDate dayPeriod nightPeriod visitAreas isTravelLive isHomeShopping totalPromoAccRate totalSavingPoint totalSavingFlat badge { text textColor backgroundColor } discountOtaCouponGrade supportNaverPlus productFamilyId } }';

export function buildRequest(kind, variables = { device: 'pc' }) {
  const q = kind === 'thisWeek' ? QUERY_DEPARTURE_THIS_WEEK : QUERY_NATION_GROUP;
  return { operationName: q.split('(')[0].split(' ')[1], query: q, variables };
}

export function parsePkgtourProducts(body) {
  const d = typeof body === 'string' ? JSON.parse(body) : body;
  if (d.errors?.length) throw new Error('GraphQL error: ' + d.errors[0].message);
  const key = Object.keys(d.data ?? {})[0];
  const rows = d.data?.[key] ?? [];
  return rows.map((p) => ({
    source: 'naver-pkgtour-' + key,
    productId: p.productId,
    name: p.productName,
    seller: p.landingPc || p.landingMo,
    agtCode: p.agtCode,
    pricePerPerson: p.price,
    priceIsFrom: true,
    originalPrice: null,
    discountPct: null,
    departDate: p.beginDate,
    departTime: p.beginTime ?? null,
    returnDate: p.endDate ?? null,
    nights: p.nightPeriod ?? null,
    days: p.dayPeriod ?? null,
    visitAreas: p.visitAreas ?? null,
    // For "임박출발" the departure date is the effective deadline of the offer.
    endsAtKst: p.beginDate ? p.beginDate + (p.beginTime ? ' ' + p.beginTime + ':00' : ' 00:00:00') : null,
    pointAccrualPct: p.totalPromoAccRate ?? null,
    savingPoint: p.totalSavingPoint ?? null,
    image: p.image ?? null,
    productUrl: `https://pkgtour.naver.com/products/${p.landingPc || p.landingMo}/${encodeURIComponent(p.productId)}`,
    travelConnectCandidate: true, // partner link only if the product is TRAVEL_PACKAGE with affiliateEnabled=true (check in Naver Travel Connect)
  }));
}
