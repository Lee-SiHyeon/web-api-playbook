import { pathToFileURL } from 'node:url';

const COMMANDS = ['yanolja-search', 'modetour-packages', 'naver-overseas', 'agoda-campaigns', 'agoda-rates'];

async function readJsonInput() {
  if (process.stdin.isTTY) throw Object.assign(new Error(), { code: 'INPUT_JSON_REQUIRED' });
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > 32 * 1024) throw Object.assign(new Error(), { code: 'INPUT_TOO_LARGE' });
  }
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error(), { code: 'INPUT_INVALID' });
  return input;
}

export async function collectLive(command, args = [], { input } = {}) {
  if (!COMMANDS.includes(command)) throw Object.assign(new Error(), { code: 'COMMAND_INVALID' });
  if (command === 'yanolja-search') {
    if (args.length !== 1 || !args[0].trim()) throw Object.assign(new Error(), { code: 'KEYWORD_REQUIRED' });
    const { searchYanoljaAccommodation } = await import('./seller-adapters/yanolja-search.mjs');
    return searchYanoljaAccommodation({ keyword: args[0] });
  }
  if (command === 'modetour-packages') {
    if (args.length > 1 || (args.length === 1 && (!args[0].trim() || args[0].length > 80))) {
      throw Object.assign(new Error(), { code: 'ARGUMENT_INVALID' });
    }
    const { collectModetourLive } = await import('./seller-adapters/modetour.mjs');
    const result = await collectModetourLive({ destination: args[0]?.trim() ?? '다낭', maxProductsPerDestination: 1, requestBudget: 3 });
    if (result.fiveStates?.live_replay !== true) {
      throw Object.assign(new Error('MODETOUR_LIVE_READ_FAILED'), { code: 'MODETOUR_LIVE_READ_FAILED' });
    }
    return result;
  }
  if (args.length) throw Object.assign(new Error(), { code: 'ARGUMENT_INVALID' });
  if (command === 'agoda-campaigns' || command === 'agoda-rates') {
    const { AgodaHotelClient } = await import('./seller-adapters/agoda.mjs');
    const client = new AgodaHotelClient();
    return command === 'agoda-campaigns' ? client.campaigns() : client.rates(input ?? await readJsonInput());
  }
  const { NaverOverseasHotelClient } = await import('./seller-adapters/naver-overseas-hotel.mjs');
  const search = input ?? await readJsonInput();
  const searchKeys = new Set(['query', 'placeId', 'from', 'size', 'sort', 'checkIn', 'checkOut', 'adultCnt', 'childAges',
    'includeRecommendedBnb', 'accommodationTypeIds', 'chainIds', 'facilityIds', 'priceRangeKey', 'starRatings', 'deviceType']);
  if (Object.keys(search).some(key => !searchKeys.has(key))) throw Object.assign(new Error(), { code: 'INPUT_INVALID' });
  const client = new NaverOverseasHotelClient();
  const listing = await client.search(search);
  const xbuIds = listing.items.filter(item => item.hotel).map(item => item.hotel.id);
  const rates = xbuIds.length ? await client.rates({
    xbuIds, query: search.query, nPlaceId: search.query,
    checkIn: search.checkIn, checkOut: search.checkOut,
    adultCnt: search.adultCnt, childAges: search.childAges ?? [],
    impArea: 'renewalMulti', includeTax: true,
  }) : null;
  return {
    sourceId: 'naver-hotel-overseas',
    execution: { mode: 'pure_http', browserUsed: false, auth: 'anonymous' },
    listing, rates,
    coverage: { paginationReplayed: false, rows: listing.items.length, total: listing.total,
      priceCoverage: rates?.priceCoverage ?? { status: 'no_hotel_rates' }, checkoutVerified: false },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help') {
    process.stdout.write(`Public HTTP travel reads: ${COMMANDS.join(', ')}\nYanolja search takes one keyword. ModeTours takes an optional destination and filters the limited recommendation feed; it is not whole-inventory search. Naver overseas and Agoda rates take public search JSON on stdin.\n`);
  } else {
    try {
      const result = await collectLive(command, args);
      process.stdout.write(JSON.stringify({ ok: true, command, result }, null, 2) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, command: COMMANDS.includes(command) ? command : null,
        code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'TRAVEL_COLLECTION_FAILED',
        ...(error?.metadata ? { metadata: error.metadata } : {}),
      }) + '\n');
      process.exitCode = 2;
    }
  }
}
