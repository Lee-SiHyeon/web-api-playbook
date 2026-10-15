import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readCoupangCategories, readCoupangDocument, readCoupangRetailSearch, readCoupangTravelAutocomplete,
  readCoupangTravelSearch, readCoupangTravelRooms, readCoupangTravelReviews, readCoupangTravelTicketOptions } from '../lib/retail/coupang-public.mjs';

const [operation, ...args] = process.argv.slice(2);
const flags = Object.fromEntries(args.map(x => { const i = x.indexOf('='); return [x.slice(0, i < 0 ? undefined : i).replace(/^--/, ''), i < 0 ? true : x.slice(i + 1)]; }));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
try {
  if (flags.visitor !== undefined && flags.visitor !== true || flags.anonymous !== undefined && flags.anonymous !== true
    || flags.visitor && flags.anonymous || (flags.visitor || flags.anonymous) && !['document','retail-search'].includes(operation))
    throw Object.assign(new Error(), { code: 'COUPANG_PUBLIC_AUTH_INPUT' });
  const authentication = flags.visitor ? 'visitor' : flags.anonymous ? 'anonymous' : undefined;
  let result;
  if (operation === 'categories') result = await readCoupangCategories();
  else if (operation === 'document') result = await readCoupangDocument(flags.url, { authentication });
  else if (operation === 'retail-search') result = await readCoupangRetailSearch(flags.query, {authentication,sorter:flags.sorter,freeDelivery:flags['free-delivery']===true,page:flags.page??1});
  else if (operation === 'autocomplete') result = await readCoupangTravelAutocomplete(flags.query);
  else if (operation === 'search') result = await readCoupangTravelSearch(await json(flags.template), { page: flags.page,
    sort: flags.sort, resultsOnly: flags['results-only'] === true });
  else if (operation === 'rooms') result = await readCoupangTravelRooms(await json(flags.template));
  else if (operation === 'ticket-options') result = await readCoupangTravelTicketOptions(await json(flags.template));
  else if (operation === 'reviews') result = await readCoupangTravelReviews(flags['product-id'], { page: Number(flags.page ?? 0), sort: flags.sort ?? 'DATE_DESC' });
  else throw Object.assign(new Error(), { code: 'USAGE_categories_document_retail-search_autocomplete_search_rooms_ticket-options_reviews' });
  if (flags.out) { await mkdir(path.dirname(flags.out), { recursive: true }); await writeFile(flags.out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); }
  console.log(JSON.stringify({ ok: true, operation, output: flags.out ?? null, kind: result.data.kind,
    count: result.data.kind==='travel_detail'?1:result.data.products?.length ?? result.data.rooms?.length ?? result.data.options?.length ?? result.data.reviews?.length ?? result.data.nodes?.length ?? result.data.navigation?.length,
    httpStatus: result.request.httpStatus, authenticationMode: result.request.authenticationMode,
    visitorCookiesSent: result.request.cookieSent, executionMode: result.executionMode, states: result.states }));
} catch (e) {
  const result = { schema: 'web-api-coupang-public-result-v1', ok: false, checkedAt: new Date().toISOString(), operation,
    executionMode: 'pure_http', browserUsed: false, credentialsUsed: false, anonymous: true, writesSubmitted: 0,
    code: e.code ?? 'COUPANG_CLIENT_FAILED', request: e.receipt ?? null,
    states: { captured: ['categories','autocomplete','search','rooms','ticket-options','reviews'].includes(operation),client_exists: true, remnant_free: true, credential_propagated: 'not_applicable_anonymous', live_replay: false } };
  if (flags.out) { try { await mkdir(path.dirname(flags.out), { recursive: true }); await writeFile(flags.out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); } catch {} }
  console.log(JSON.stringify(result)); process.exitCode = 1;
}
