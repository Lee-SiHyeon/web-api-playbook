const todayKorea = checkedAt => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(checkedAt));

function eventFromRecord(record, sourceId, checkedAt) {
  const startDate = record.periodStart ?? null;
  const endDate = record.periodEnd ?? null;
  const today = todayKorea(checkedAt);
  const status = !startDate || !endDate ? 'unknown' : today < startDate ? 'upcoming' : today > endDate ? 'ended' : 'active';
  const venue = record.address ? [{
    name: record.venueName ?? null,
    dateStart: startDate, dateEnd: endDate,
    dateRaw: record.dateLabelRaw ?? record.periodRaw ?? null,
    region: record.region ?? null,
    municipality: record.municipality ?? null,
    address: record.address,
    sourceUrl: record.sourceUrl
  }] : [];
  return {
    id: record.id,
    sourceId,
    title: record.titleRaw ?? record.venueName ?? record.periodLabelRaw ?? record.statusLabelRaw ?? record.id,
    status,
    ratePercent: record.ratePercent ?? null,
    rateRaw: record.rateLabelRaw ?? record.maximumDiscountLabelRaw ?? null,
    capAmountKrw: record.capAmountKrw ?? null,
    capRaw: record.capLabelRaw ?? null,
    startDate, endDate,
    periodRaw: record.periodRaw ?? record.dateLabelRaw ?? null,
    venues: venue,
    venueRaw: record.address ?? null,
    eligibleItems: record.items ?? [],
    rawLabels: record.fieldLabels ?? {},
    descriptionRaw: record.promotionTextRaw ?? record.summaryRaw ?? record.noteRaw ?? null,
    retailerLabelRaw: record.retailerLabelRaw ?? null,
    retailerLogoUrl: record.retailerLogoUrl ?? null,
    offerUrl: record.clickThroughUrl ?? null,
    sourceUrl: record.sourceUrl,
    checkedAt,
    limitations: sourceId === 'fsale-coupon-board' ? ['Seller preview maximum, not the government subsidy rate. Preview lacks a confirmed cap or dated redemption period.'] : []
  };
}

/** Projects HTML records onto the campaign shape without manufacturing missing rules. */
export function normalizeHtmlEvents(sources, { checkedAt = new Date().toISOString() } = {}) {
  const events = [];
  for (const [sourceId, source] of Object.entries(sources)) {
    let records = source.records ?? [];
    if (sourceId === 'fsale-coupon-board') {
      const allRecords = (source.pages ?? []).flatMap(page => page.records ?? []);
      records = [...new Map(allRecords.map((record, index) => [record.id ?? `${record.sourceUrl}/${index}`, record])).values()];
    }
    if (sourceId === 'fsale-zero-onnuri-boards') records = Object.values(source.boards ?? {}).flatMap(board => board.records ?? []);
    if (sourceId === 'fsale-site') continue;
    events.push(...records.map(record => eventFromRecord(record, sourceId, checkedAt)));
  }
  return { events, activeEvents: events.filter(event => event.status === 'active'), upcomingEvents: events.filter(event => event.status === 'upcoming') };
}
