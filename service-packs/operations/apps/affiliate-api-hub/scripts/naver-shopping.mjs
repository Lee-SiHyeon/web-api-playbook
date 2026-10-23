import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { NaverShoppingClient, NaverShoppingError, parseProductUrl } from '../adapters/naver-shopping.mjs';
import { searchIntegratedPrices } from '../adapters/naver-price-observations.mjs';

export async function main(argv = process.argv.slice(2), { client = new NaverShoppingClient(), stdout = console.log, stderr = console.error } = {}) {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' }, store: { type: 'string' }, query: { type: 'string', short: 'q' },
      'product-url': { type: 'string' }, 'product-id': { type: 'string' }, section: { type: 'string' },
      limit: { type: 'string' }, page: { type: 'string' }, 'page-size': { type: 'string' },
      regex: { type: 'string' }, exclude: { type: 'string' }, 'min-price': { type: 'string' }, 'max-price': { type: 'string' },
    } });
    if (values.help || !positionals.length) {
      stdout('Naver shopping HTTP client\n  feed [--section promotion] [--query 텀블러] [--limit 40]\n  integrated-search --query 노트북 [--limit 20]\n  search --store https://brand.naver.com/hera --query 쿠션\n  product --product-url https://brand.naver.com/hera/products/9215718713\n  reviews --product-url https://brand.naver.com/hera/products/9215718713 [--page 1 --page-size 20]\n  catalog\nIntegrated search covers observed shopping cards. Store search requires --store; feed filtering is local. Restricted requests fail without retry.');
      return 0;
    }
    if (positionals.length !== 1) throw new NaverShoppingError('INPUT', 'Specify exactly one operation');
    const operation = positionals[0];
    const allowed = { feed: ['section', 'query', 'limit'], 'integrated-search': ['query', 'limit', 'regex', 'exclude', 'min-price', 'max-price'], search: ['store', 'query', 'limit'], product: ['store', 'product-id', 'product-url'], reviews: ['store', 'product-id', 'product-url', 'page', 'page-size'], catalog: [] }[operation];
    if (!allowed || Object.keys(values).some(k => !allowed.includes(k))) throw new NaverShoppingError('INPUT', 'Unknown operation or option for this operation');
    if (values['product-url'] && (values.store || values['product-id'])) throw new NaverShoppingError('INPUT', 'Use product-url or store/product-id, not both');
    let result;
    if (operation === 'catalog') {
      result = JSON.parse(await readFile(new URL('../references/naver-shopping-contracts.json', import.meta.url), 'utf8'));
    } else if (operation === 'feed') {
      result = await client.feed({ section: values.section ?? 'promotion', query: values.query ?? null, limit: values.limit === undefined ? 40 : Number(values.limit) });
    } else if (operation === 'integrated-search') {
      for (const k of ['min-price', 'max-price']) if (values[k] !== undefined && !/^[0-9]+$/.test(values[k])) throw new NaverShoppingError('INPUT', 'Price bounds must contain integer digits');
      result = await searchIntegratedPrices({ query: values.query, limit: values.limit === undefined ? 20 : Number(values.limit), fetchImpl: client.fetchImpl,
        includeRegex: values.regex ?? null, excludeRegex: values.exclude ?? null,
        minPriceKrw: values['min-price'] === undefined ? null : Number(values['min-price']), maxPriceKrw: values['max-price'] === undefined ? null : Number(values['max-price']) });
    } else if (operation === 'search') {
      result = await client.search({ storeUrl: values.store, query: values.query, limit: values.limit === undefined ? 40 : Number(values.limit) });
    } else {
      const target = values['product-url'] ? parseProductUrl(values['product-url']) : { storeUrl: values.store, productId: values['product-id'] };
      result = operation === 'product' ? await client.product(target) : await client.reviews({ ...target,
        page: values.page === undefined ? 1 : Number(values.page), pageSize: values['page-size'] === undefined ? 20 : Number(values['page-size']) });
    }
    stdout(JSON.stringify({ ok: true, operation, result }, null, 2));
    return 0;
  } catch (error) {
    const known = error instanceof NaverShoppingError;
    const code = known ? error.code : error.code?.startsWith('ERR_PARSE_ARGS') ? 'INPUT' : 'INTERNAL';
    stderr(JSON.stringify({ ok: false, error: { code, message: known ? error.message : code === 'INPUT' ? 'Invalid command-line arguments' : 'Naver shopping operation failed', receipt: known ? error.receipt : null } }));
    return code === 'INPUT' ? 2 : 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main();
