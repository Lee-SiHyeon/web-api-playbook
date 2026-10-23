import path from 'node:path';
import { options, jsonFile, stdinJson, reserveOutput, safeError } from '../lib/cli.mjs';
import { createJapanPublicClient, crawlJapanPublic } from '../lib/retail/japan-public.mjs';
import { createYahooShoppingJpClient } from '../lib/commerce/yahoo-shopping-jp.mjs';
import { fail, japanDestination } from '../lib/retail/japan-http.mjs';

let output;
try {
  const [service, operation, ...tail] = process.argv.slice(2);
  if (!['rakuten', 'yahoo'].includes(service)) fail('JAPAN_SERVICE_INVALID');
  const args = options(tail, ['url','query','category-id','page','max-pages','input','output','credentials-stdin',
    'start','results','sort','seller-id','jan']);
  const allowed = {
    home: ['output'], page: ['url','output'], product: ['url','output'],
    search: ['query','category-id','page','output'],
    crawl: ['input','max-pages','output'],
    'official-search': ['query','category-id','credentials-stdin','output','start','results','sort','seller-id','jan'],
  };
  if (!allowed[operation] || Object.keys(args).some(k => !allowed[operation].includes(k))) fail('JAPAN_ARGUMENT_INVALID');
  if (args.output !== undefined && typeof args.output !== 'string') fail('JAPAN_OUTPUT_INVALID');
  output = await reserveOutput(args.output);
  let result;
  const client = createJapanPublicClient({ service });
  if (operation === 'home') result = await client.home();
  else if (operation === 'page' || operation === 'product') {
    if (typeof args.url !== 'string') fail('JAPAN_URL_REQUIRED');
    if (operation === 'product' && japanDestination(service, args.url)?.kind !== 'product') fail('JAPAN_PRODUCT_URL_REQUIRED');
    result = await client.read(args.url);
  } else if (operation === 'search') result = await client.search({ query: args.query, categoryId: args['category-id'], page: Number(args.page ?? 1) });
  else if (operation === 'crawl') {
    if (!output) fail('JAPAN_CRAWL_OUTPUT_REQUIRED');
    result = await crawlJapanPublic({ service, state: args.input ? await jsonFile(args.input) : undefined,
      maxPages: Number(args['max-pages'] ?? 5), client,
      checkpoint: async state => {
        const bytes = Buffer.from(JSON.stringify(state, null, 2) + '\n');
        await output.truncate(0); await output.write(bytes, 0, bytes.length, 0); await output.sync();
      } });
  } else if (operation === 'official-search') {
    if (service !== 'yahoo' || args['credentials-stdin'] !== true) fail('YAHOO_APPLICATION_CREDENTIALS_REQUIRED');
    const credentials = await stdinJson(16384);
    if (credentials.provider !== 'yahoo-shopping-jp' || Object.keys(credentials).some(k => !['provider','appId'].includes(k))) fail('YAHOO_CREDENTIAL_SCOPE_INVALID');
    result = await createYahooShoppingJpClient({ appId: credentials.appId }).search({ query: args.query, categoryId: args['category-id'],
      start: Number(args.start ?? 1), results: Number(args.results ?? 20), sort: args.sort ?? '-score',
      sellerId: args['seller-id'], jan: args.jan });
  }
  if (output && operation !== 'crawl') await output.writeFile(JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(output ? { ok: true, service, operation, output: path.resolve(args.output),
    products: result.data?.products?.length ?? (result.data?.product ? 1 : undefined), variants: result.data?.product?.variants?.length,
    collection: result.collection,
    links: result.data?.links?.length, nextUrl: result.data?.pagination?.nextUrl, completeCatalog: false } : result, null, 2));
} catch (error) {
  const result = { ok: false, code: safeError(error), httpStatus: error.receipt?.httpStatus ?? null,
    origin: error.receipt?.origin ?? null, path: error.receipt?.path ?? null };
  console.log(JSON.stringify(result)); process.exitCode = 1;
} finally { await output?.close(); }
