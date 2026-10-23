/** Text-value parsing only: HTML structure is extracted by gov-press-html.mjs. */
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const date = (year, month, day) => {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value ? value : null;
};
const amount = (number, unit) => Number(number.replace(/,/g, '')) * ({ 만: 10000, 천: 1000, 백: 100 }[unit] ?? 1);

export function parsePressMoneyFacts(record, { checkedAt = new Date().toISOString(), today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(checkedAt)) } = {}) {
  const body = String(record.body ?? '');
  const lines = body.split(/\n+/).map(clean).filter(Boolean);
  const rateFacts = [];
  const capFacts = [];
  const periodFacts = [];
  const venueLabels = [];
  for (const line of lines) {
    for (const match of line.matchAll(/전국\s*\d+\s*개(?:소)?\s*(?:마트|시장)(?:와\s*온라인몰)?/g)) venueLabels.push(match[0]);
    for (const match of line.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
      const context = line.slice(Math.max(0, match.index - 70), match.index + match[0].length + 70);
      if (!/(할인|환급|쿠폰|캐시백|페이백)/.test(context)) continue;
      rateFacts.push({ ratePercent: Number(match[1]), rateRaw: match[0], labelRaw: clean(context), sourceUrl: record.sourceUrl });
    }
    for (const match of line.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(만|천)?\s*(?:(\d[\d,]*(?:\.\d+)?)\s*(천|백)?)?\s*원/g)) {
      const context = line.slice(Math.max(0, match.index - 70), match.index + match[0].length + 70);
      const beforeAmount = line.slice(Math.max(0, match.index - 40), match.index);
      const afterAmount = line.slice(match.index + match[0].length, match.index + match[0].length + 30);
      const explicitPersonalCap = /(?:1\s*인(?:당)?|인당|개인)[^.!?;]{0,24}(?:한도|상한)[^.!?;]{0,24}$/.test(beforeAmount);
      // Purchase ceilings and grant amounts are not discount/refund ceilings.
      if (!/(1\s*인|개인|인당)/.test(context) || !/(한도|최대|상한)/.test(context) ||
          !/(할인|환급|쿠폰|캐시백|페이백)/.test(context) ||
          !(explicitPersonalCap || /(?:할인|환급|쿠폰|캐시백|페이백)[^.!?;]{0,35}$/.test(beforeAmount) || /^\s*(?:까지|씩|을|를|의)?\s*(?:할인|환급|쿠폰|캐시백|페이백)/.test(afterAmount)) ||
          (/\s*(?:기존|종전|이전)[^0-9]{0,12}$/.test(beforeAmount) && /^\s*(?:에서|이던)/.test(afterAmount)) ||
          /(?:구매|결제|소비|지출)\s*(?:한도|가능(?:한)?\s*(?:금액|액)|허용\s*(?:금액|액)|상한)/.test(beforeAmount) ||
          /(발행\s*한도|총\s*예산|예산\s*규모)/.test(context)) continue;
      capFacts.push({ capAmountKrw: amount(match[1], match[2]) + (match[3] ? amount(match[3], match[4]) : 0), capRaw: match[0], labelRaw: clean(context), sourceUrl: record.sourceUrl });
    }
    const fullDate = '(20\\d{2})\\s*(?:년\\s*|[-./])\\s*(\\d{1,2})\\s*(?:월\\s*|[-./])\\s*(\\d{1,2})\\s*일?';
    const expression = new RegExp(`${fullDate}\\s*(?:\\([^)]{0,12}\\))?\\s*(?:부터|~|～|–|—|-)\\s*${fullDate}\\s*(?:까지)?`, 'g');
    for (const match of line.matchAll(expression)) {
      const startDate = date(match[1], match[2], match[3]);
      const endDate = date(match[4], match[5], match[6]);
      if (!startDate || !endDate || startDate > endDate) continue;
      periodFacts.push({ startDate, endDate, periodRaw: match[0], labelRaw: line, sourceUrl: record.sourceUrl,
        yearBasis: 'explicit_range_years', status: today < startDate ? 'upcoming' : today > endDate ? 'ended' : 'active' });
    }
    // Ministry releases often state Korean month/day ranges and put the year in the publication date.
    // Preserve that inference explicitly and skip historical/ambiguous year references.
    const years = [...new Set([...line.matchAll(/(20\d{2})\s*년/g)].map(match => match[1]))];
    const inferredYear = years.length === 1 ? years[0] : years.length === 0 ? /^20\d{2}/.exec(record.publishedDate ?? '')?.[0] : null;
    if (inferredYear) {
      const koreanRange = /(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*(?:\([^)]{0,12}\))?\s*(?:부터|~|～|–|—|-)\s*(?:(\d{1,2})\s*월\s*)?(\d{1,2})\s*일\s*(?:까지)?/g;
      for (const match of line.matchAll(koreanRange)) {
        // A later comparison with last year's store count does not change this range's year.
        if (/(지난해|작년|지지난해)[^.!?;]{0,20}$/.test(line.slice(Math.max(0, match.index - 30), match.index))) continue;
        const startDate = date(inferredYear, match[1], match[2]);
        const endDate = date(inferredYear, match[3] ?? match[1], match[4]);
        if (!startDate || !endDate || startDate > endDate) continue;
        periodFacts.push({ startDate, endDate, periodRaw: match[0], labelRaw: line, sourceUrl: record.sourceUrl,
          yearBasis: years.length ? 'explicit_paragraph_year' : 'publication_year',
          status: today < startDate ? 'upcoming' : today > endDate ? 'ended' : 'active' });
      }
    }
  }
  const uniqueRates = [...new Set(rateFacts.map(item => item.ratePercent))];
  const uniqueCaps = [...new Set(capFacts.map(item => item.capAmountKrw))];
  const uniquePeriods = [...new Map(periodFacts.map(item => [`${item.startDate}/${item.endDate}`, item])).values()];
  return {
    id: record.sourceId ?? record.sourceUrl,
    title: record.title,
    ministry: record.ministry,
    publishedDate: record.publishedDate,
    status: uniquePeriods.length === 1 ? uniquePeriods[0].status : 'unknown',
    startDate: uniquePeriods.length === 1 ? uniquePeriods[0].startDate : null,
    endDate: uniquePeriods.length === 1 ? uniquePeriods[0].endDate : null,
    periodRaw: uniquePeriods.length === 1 ? uniquePeriods[0].periodRaw : null,
    ratePercent: uniqueRates.length === 1 ? uniqueRates[0] : null,
    capAmountKrw: uniqueCaps.length === 1 ? uniqueCaps[0] : null,
    venues: [...new Set(venueLabels)].map(labelRaw => ({ labelRaw, sourceUrl: record.sourceUrl, coverage: 'stated_network_summary', branchAddresses: null })),
    venueRaw: [...new Set(venueLabels)].join('; ') || null,
    rateFacts, capFacts, periodFacts: uniquePeriods,
    descriptionRaw: body,
    sourceUrl: record.sourceUrl,
    checkedAt,
    limitations: ['Multiple benefits and periods remain separate raw-labeled facts; purchase ceilings are not refund caps. Stated venue-network summaries are not branch names or addresses.']
  };
}

export function pressEventsFromCollection(collection, options = {}) {
  const records = collection.record ? [collection.record] : (collection.details ?? []).flatMap(item => item.record ? [item.record] : []);
  const events = records.flatMap(record => {
    const parsed = parsePressMoneyFacts(record, options);
    if (!parsed.periodFacts.length) return [parsed];
    return parsed.periodFacts.map((period, index) => {
      const local = parsePressMoneyFacts({ ...record, body: period.labelRaw }, options);
      return { ...local, id: `${parsed.id}-${index + 1}`, startDate: period.startDate, endDate: period.endDate,
        periodRaw: period.periodRaw, periodYearBasis: period.yearBasis, status: period.status,
        limitations: [...local.limitations, 'A period defines a separate fact set; paragraph rates are preserved as separate raw facts.'] };
    });
  });
  return { events, activeEvents: events.filter(event => event.status === 'active') };
}
