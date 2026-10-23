import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  CoupangShoppingClient,
  CoupangShoppingError
} from '../adapters/coupang-shopping.mjs';

export async function main(
  argv = process.argv.slice(2),
  {
    client = new CoupangShoppingClient(),
    stdout = console.log,
    stderr = console.error
  } = {}
) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        query: { type: 'string', short: 'q' },
        section: { type: 'string' },
        'min-price': { type: 'string' },
        'max-price': { type: 'string' },
        'min-discount': { type: 'string' },
        sort: { type: 'string' },
        'product-id': { type: 'string' },
        'item-id': { type: 'string' },
        'vendor-item-id': { type: 'string' },
        limit: { type: 'string' },
        pages: { type: 'string' }
      }
    });

    if (values.help || !positionals.length) {
      stdout(
        'Coupang Consumer Shopping HTTP Client (Node.js >=24)\n\n' +
        '사용법 (Usage):\n' +
        '  node scripts/coupang-shopping.mjs feed [--query 노트북] [--section 골드박스] [--min-price 10000] [--max-price 50000] [--min-discount 20] [--sort price_asc|price_desc|discount_desc|rating_signal_desc|reviews_desc] [--limit 20] [--pages 3]\n' +
        '  node scripts/coupang-shopping.mjs deals [--min-discount 20] [--sort discount_desc] [--limit 20] [--pages 3]\n' +
        '  node scripts/coupang-shopping.mjs sections [--pages 3]\n' +
        '  node scripts/coupang-shopping.mjs find --product-id 8035983162 [--pages 3]\n' +
        '  node scripts/coupang-shopping.mjs find --vendor-item-id 95036224970 [--pages 3]\n' +
        '  node scripts/coupang-shopping.mjs categories\n' +
        '  node scripts/coupang-shopping.mjs line-banner\n' +
        '  node scripts/coupang-shopping.mjs catalog\n\n' +
        '동작 안내 및 제한사항:\n' +
        '  - feed / deals / sections / find는 관측된 추천 피드 인벤토리 범위의 로컬 필터/정렬 작업입니다.\n' +
        '  - 전체 키워드 검색 엔진이나 임의 상품 상세 API가 아님에 유의하십시오.\n' +
        '  - 정렬 및 limit은 조기 절단 없이 크롤링된 전체 대상 상품군에 적용됩니다.'
      );
      return 0;
    }

    if (positionals.length !== 1) {
      throw new CoupangShoppingError('INPUT', '하나의 작업(operation)만 지정하십시오.');
    }

    const operation = positionals[0];
    const allowedOptions = {
      feed: ['query', 'section', 'min-price', 'max-price', 'min-discount', 'sort', 'product-id', 'item-id', 'vendor-item-id', 'limit', 'pages'],
      deals: ['min-discount', 'section', 'sort', 'limit', 'pages'],
      sections: ['pages'],
      find: ['product-id', 'vendor-item-id', 'item-id', 'pages'],
      categories: [],
      'line-banner': [],
      catalog: []
    }[operation];

    if (!allowedOptions) {
      throw new CoupangShoppingError('INPUT', `지원되지 않는 작업입니다: ${operation}`);
    }

    for (const opt of Object.keys(values)) {
      if (opt !== 'help' && !allowedOptions.includes(opt)) {
        throw new CoupangShoppingError('INPUT', `작업 '${operation}'에서 옵션 '--${opt}'은(는) 허용되지 않습니다.`);
      }
    }

    let result;
    if (operation === 'catalog') {
      const catalogPath = new URL('../references/coupang-shopping-contracts.json', import.meta.url);
      result = JSON.parse(await readFile(catalogPath, 'utf8'));
    } else if (operation === 'feed') {
      result = await client.feed({
        query: values.query ?? null,
        section: values.section ?? null,
        minPrice: values['min-price'] !== undefined ? values['min-price'] : null,
        maxPrice: values['max-price'] !== undefined ? values['max-price'] : null,
        minDiscount: values['min-discount'] !== undefined ? values['min-discount'] : null,
        sort: values.sort ?? 'none',
        productId: values['product-id'] ?? null,
        vendorItemId: values['vendor-item-id'] ?? null,
        itemId: values['item-id'] ?? null,
        limit: values.limit !== undefined ? values.limit : 20,
        maxPages: values.pages !== undefined ? values.pages : 3
      });
    } else if (operation === 'deals') {
      result = await client.deals({
        minDiscount: values['min-discount'] !== undefined ? values['min-discount'] : 20,
        section: values.section ?? null,
        sort: values.sort ?? 'discount_desc',
        limit: values.limit !== undefined ? values.limit : 20,
        maxPages: values.pages !== undefined ? values.pages : 3
      });
    } else if (operation === 'sections') {
      result = await client.sections({
        maxPages: values.pages !== undefined ? values.pages : 3
      });
    } else if (operation === 'find') {
      result = await client.find({
        productId: values['product-id'] ?? null,
        vendorItemId: values['vendor-item-id'] ?? null,
        itemId: values['item-id'] ?? null,
        maxPages: values.pages !== undefined ? values.pages : 3
      });
    } else if (operation === 'categories') {
      result = await client.categories();
    } else if (operation === 'line-banner') {
      result = await client.lineBanner();
    }

    stdout(JSON.stringify({ ok: true, operation, result }, null, 2));
    return 0;
  } catch (error) {
    const known = error instanceof CoupangShoppingError;
    const code = known ? error.code : error.code?.startsWith('ERR_PARSE_ARGS') ? 'INPUT' : 'INTERNAL';
    stderr(
      JSON.stringify(
        {
          ok: false,
          error: {
            code,
            message: known ? error.message : code === 'INPUT' ? '명령줄 인수가 유효하지 않습니다.' : '작업 처리에 실패했습니다.',
            receipt: known ? error.receipt : null
          }
        },
        null,
        2
      )
    );
    return code === 'INPUT' ? 2 : 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
