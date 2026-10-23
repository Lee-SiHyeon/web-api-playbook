import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { NaverTravelClient, NaverTravelError } from '../adapters/naver-travel.mjs';

export async function main(argv = process.argv.slice(2), { client = new NaverTravelClient(), stdout = console.log, stderr = console.error } = {}) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        type: { type: 'string' },
        'flight-type': { type: 'string' },
        departure: { type: 'string' },
        arrival: { type: 'string' },
        'departure-date': { type: 'string' },
        'return-date': { type: 'string' },
        'trip-type': { type: 'string' },
        adult: { type: 'string' },
        child: { type: 'string' },
        infant: { type: 'string' },
        'seat-class': { type: 'string' },
        nonstop: { type: 'boolean' },
        query: { type: 'string', short: 'q' },
        keyword: { type: 'string' },
        from: { type: 'string' },
        size: { type: 'string' },
        sort: { type: 'string' },
        'center-lat': { type: 'string' },
        'center-lon': { type: 'string' },
        'search-radius': { type: 'string' },
        'hotel-id': { type: 'string' },
        'check-in': { type: 'string' },
        'check-out': { type: 'string' },
        name: { type: 'string' },
        category: { type: 'string' },
        limit: { type: 'string' },
        'departure-type': { type: 'string' },
        'arrival-type': { type: 'string' },
        'trip-days': { type: 'string' },
        leg: { type: 'string' },
        'fare-type': { type: 'string' },
        'no-event-fare': { type: 'boolean' },
        period: { type: 'string' },
        'current-min-fare': { type: 'string' },
        'location-type': { type: 'string' },
        'current-nightly-price': { type: 'string' },
      },
    });

    if (values.help || !positionals.length) {
      stdout(
        'Naver travel HTTP client\n' +
        '  flight-search --type international|domestic --departure ICN --arrival NRT --departure-date 20261015 [--return-date 20261020] [--adult 2] [--seat-class Y]\n' +
        '  flight-calendar --departure SEL --arrival OSA [--departure-type CITY|AIRPORT] [--arrival-type CITY|AIRPORT] [--trip-type RT|OW] [--trip-days 4] [--nonstop]\n' +
        '  flight-price-graph --departure ICN --arrival SPN --departure-date 20261026 [--return-date 20261030] [--fare-type Y] [--nonstop] [--no-event-fare] [--period 60] [--location-type airport|city] [--current-min-fare 230400]\n' +
        '  hotel-price-trend --hotel-id 11583218 --check-in 2026-10-26 [--current-nightly-price 209000]\n' +
        '  flight-cards\n' +
        '  hotel-search --query 서울 [--size 10] [--sort POPULAR_DESC]\n' +
        '  hotel-rates --hotel-id 11583218 --check-in 2026-10-15 --check-out 2026-10-20 [--adult 2]\n' +
        '  travel-products [--category tour|hotel|all] [--limit 20]\n' +
        '  travel-autocomplete --keyword 제주\n' +
        '  catalog\n' +
        'Direct HTTP operations using verified Naver travel production-observed contracts.'
      );
      return 0;
    }

    if (positionals.length !== 1) throw new NaverTravelError('INPUT', 'Specify exactly one operation');
    const operation = positionals[0];

    const allowed = {
      'flight-search': ['type', 'flight-type', 'departure', 'arrival', 'departure-date', 'return-date', 'trip-type', 'adult', 'child', 'infant', 'seat-class', 'nonstop', 'leg'],
      'flight-cards': [],
      'hotel-price-trend': ['hotel-id', 'check-in', 'current-nightly-price'],
      'flight-price-graph': ['departure', 'arrival', 'departure-date', 'return-date', 'fare-type', 'nonstop', 'no-event-fare', 'period', 'current-min-fare', 'location-type'],
      'flight-calendar': ['departure', 'arrival', 'departure-type', 'arrival-type', 'trip-type', 'trip-days', 'nonstop'],
      'hotel-search': ['query', 'from', 'size', 'sort', 'center-lat', 'center-lon', 'search-radius'],
      'hotel-rates': ['hotel-id', 'check-in', 'check-out', 'adult', 'name'],
      'travel-products': ['category', 'limit'],
      'travel-autocomplete': ['keyword'],
      catalog: [],
    }[operation];

    if (!allowed || Object.keys(values).some(k => !allowed.includes(k))) {
      throw new NaverTravelError('INPUT', 'Unknown operation or option for this operation');
    }

    let result;
    if (operation === 'catalog') {
      result = JSON.parse(await readFile(new URL('../references/naver-travel-contracts.json', import.meta.url), 'utf8'));
    } else if (operation === 'flight-search') {
      const fType = values['flight-type'] ?? values.type;
      if (!fType) {
        throw new NaverTravelError('INPUT', 'flight-search requires --type (international or domestic)');
      }
      if (!values.departure || !values.arrival || !values['departure-date']) {
        throw new NaverTravelError('INPUT', 'flight-search requires --departure, --arrival, and --departure-date');
      }
      result = await client.flightSearch({
        type: fType,
        departureAirport: values.departure,
        arrivalAirport: values.arrival,
        departureDate: values['departure-date'],
        returnDate: values['return-date'] ?? null,
        tripType: values['trip-type'] ?? (values['return-date'] ? 'RT' : 'OW'),
        adult: values.adult === undefined ? 1 : Number(values.adult),
        child: values.child === undefined ? 0 : Number(values.child),
        infant: values.infant === undefined ? 0 : Number(values.infant),
        seatClass: values['seat-class'] ?? 'Y',
        isNonstop: Boolean(values.nonstop),
        leg: values.leg ?? null,
      });
    } else if (operation === 'flight-price-graph') {
      if (!values.departure || !values.arrival || !values['departure-date']) {
        throw new NaverTravelError('INPUT', 'flight-price-graph requires --departure, --arrival, and --departure-date');
      }
      const itinerary = [{ departureDate: values['departure-date'], origin: values.departure, destination: values.arrival },
        ...(values['return-date'] ? [{ departureDate: values['return-date'], origin: values.arrival, destination: values.departure }] : [])];
      const locationType = values['location-type'] ?? 'airport';
      result = await client.flightPriceGraph({
        itinerary, fareType: values['fare-type'] ?? 'Y', includeEventFare: !values['no-event-fare'], nonstop: Boolean(values.nonstop),
        period: values.period === undefined ? 60 : Number(values.period), departureLocationType: locationType, arrivalLocationType: locationType,
        currentMinFare: values['current-min-fare'] === undefined ? null : Number(values['current-min-fare']),
      });
    } else if (operation === 'hotel-price-trend') {
      if (!values['hotel-id'] || !values['check-in']) throw new NaverTravelError('INPUT', 'hotel-price-trend requires --hotel-id and --check-in');
      result = await client.hotelPriceTrend({ hotelId: values['hotel-id'], checkIn: values['check-in'],
        currentNightlyPrice: values['current-nightly-price'] === undefined ? null : Number(values['current-nightly-price']) });
    } else if (operation === 'flight-cards') {
      result = await client.flightCards();
    } else if (operation === 'flight-calendar') {
      result = await client.flightCalendar({
        departure: values.departure, arrival: values.arrival,
        departureType: values['departure-type'] ?? 'CITY', arrivalType: values['arrival-type'] ?? 'CITY',
        tripType: values['trip-type'] ?? 'RT', tripDays: values['trip-days'] === undefined ? 4 : Number(values['trip-days']),
        nonstop: Boolean(values.nonstop),
      });
    } else if (operation === 'hotel-search') {
      result = await client.hotelSearch({
        query: values.query ?? '서울',
        from: values.from === undefined ? 0 : Number(values.from),
        size: values.size === undefined ? 10 : Number(values.size),
        sort: values.sort ?? 'POPULAR_DESC',
        centerLat: values['center-lat'] !== undefined ? Number(values['center-lat']) : 37.5665,
        centerLon: values['center-lon'] !== undefined ? Number(values['center-lon']) : 126.9780,
        searchRadius: values['search-radius'] !== undefined ? Number(values['search-radius']) : 20000,
      });
    } else if (operation === 'hotel-rates') {
      if (!values['hotel-id'] || !values['check-in'] || !values['check-out']) {
        throw new NaverTravelError('INPUT', 'hotel-rates requires --hotel-id, --check-in, and --check-out');
      }
      result = await client.hotelRates({
        hotelId: values['hotel-id'],
        checkIn: values['check-in'],
        checkOut: values['check-out'],
        adult: values.adult === undefined ? 2 : Number(values.adult),
        queryName: values.name ?? '',
      });
    } else if (operation === 'travel-products') {
      result = await client.domesticFeed({
        category: values.category ?? 'all',
        limit: values.limit === undefined ? 20 : Number(values.limit),
      });
    } else if (operation === 'travel-autocomplete') {
      if (!values.keyword) {
        throw new NaverTravelError('INPUT', 'travel-autocomplete requires --keyword');
      }
      result = await client.domesticAutocomplete({
        keyword: values.keyword,
      });
    }

    stdout(JSON.stringify({ ok: true, operation, result }, null, 2));
    return 0;
  } catch (error) {
    const known = error instanceof NaverTravelError;
    const code = known ? error.code : error.code?.startsWith('ERR_PARSE_ARGS') ? 'INPUT' : 'INTERNAL';
    stderr(
      JSON.stringify({
        ok: false,
        error: {
          code,
          message: known ? error.message : code === 'INPUT' ? 'Invalid command-line arguments' : 'Naver travel operation failed',
          receipt: known ? error.receipt : null,
        },
      })
    );
    return code === 'INPUT' ? 2 : 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
