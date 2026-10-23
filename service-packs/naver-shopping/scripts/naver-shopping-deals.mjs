import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { collectTodayDeals } from '../adapters/naver-shopping-deals.mjs';

try {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, output: { type: 'string' },
    'max-pages': { type: 'string', default: '30' }, 'max-requests': { type: 'string', default: '100' } } });
  if (values.help) {
    console.log('Naver 오늘끝딜 (shopping.naver.com/promotion) HTTP collector: WAFFLE V3 tabs via vertical-api /v3/waffle-maker/v1/waffle-promotion\n  --max-pages 30 (per item group)\n  --max-requests 100 (including manifest; 1.5s between live requests, no retries)\n  --output evidence/today-deals.json\nIncomplete pagination exits with code 2; prices are observed listing prices.');
  } else {
    const result = await collectTodayDeals({ maxPages: Number(values['max-pages']), maxRequests: Number(values['max-requests']) });
    if (values.output) {
      const target = path.resolve(values.output);
      await mkdir(path.dirname(target), { recursive: true });
      const temp = target + '.tmp';
      await writeFile(temp, JSON.stringify(result, null, 2) + '\n', 'utf8');
      await rename(temp, target);
      console.log(JSON.stringify({ complete: result.complete, productCount: result.productCount, layouts: result.layouts, output: target }));
    } else console.log(JSON.stringify(result, null, 2));
    if (!result.complete) process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code ?? 'COLLECT_FAILED', details: error.details ?? null }));
  process.exitCode = 1;
}
