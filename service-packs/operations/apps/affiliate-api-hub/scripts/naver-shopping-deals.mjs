import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { collectTodayDeals } from '../adapters/naver-shopping-deals.mjs';

try {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'max-pages': { type: 'string', default: '30' } } });
  const result = await collectTodayDeals({ maxPages: Number(values['max-pages']) });
  if (values.output) {
    const target = path.resolve(values.output);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = target + '.tmp';
    await writeFile(temp, JSON.stringify(result, null, 2) + '\n', 'utf8');
    await rename(temp, target);
    console.log(JSON.stringify({ complete: result.complete, productCount: result.productCount, layouts: result.layouts, output: target }));
  } else console.log(JSON.stringify(result, null, 2));
  if (!result.complete) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code ?? 'COLLECT_FAILED', details: error.details ?? null }));
  process.exitCode = 1;
}
