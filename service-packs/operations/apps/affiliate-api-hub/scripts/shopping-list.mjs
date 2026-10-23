import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShoppingProducts } from '../adapters/shopping-products.mjs';

const usage = [
  'Usage: npm run shopping:list -- "<query>" [--sources=coupang,coupang-partners,11st,ssg] [--limit=1..36] [--write]',
  'coupang: www.coupang.com consumer search; currently blocked after an observed direct HTTP 403.',
  'coupang-partners: separate authenticated Partners catalog; requested explicitly and never used as the consumer fallback.',
  'Default sources are coupang,11st,ssg. Use --sources=11st,ssg to omit blocked consumer Coupang.',
].join('\n');

try {
  const args = process.argv.slice(2), query = args.find(arg => !arg.startsWith('--'));
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(usage);
    process.exit(0);
  }
  const valid = /^(?:--sources=.+|--limit=\d+|--write)$/;
  if (!query || args.filter(arg => !arg.startsWith('--')).length !== 1
    || args.filter(arg => arg.startsWith('--')).some(arg => !valid.test(arg))) throw Object.assign(Error(), { code: 'USAGE_SHOPPING_LIST_QUERY_SOURCES_LIMIT_WRITE' });
  const sourceArg = args.find(arg => arg.startsWith('--sources='));
  const result = await readShoppingProducts({ query,
    ...(sourceArg ? { sources: sourceArg.slice(10).split(',') } : {}),
    limit: Number(args.find(arg => arg.startsWith('--limit='))?.slice(8) ?? 36) });
  if (args.includes('--write')) {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const directory = path.join(root, 'runs', `shopping-list-${result.checkedAt.replace(/[:.]/g, '-')}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'shopping-list.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
    const markdown = [`# ${cell(result.query)} 쇼핑 목록`, '', `조회: ${result.checkedAt}`, '',
      '| 출처 | 상품 | 표시가격 | 평점 | 리뷰 수 |', '|---|---|---:|---:|---:|',
      ...result.items.map(item => `| ${cell(item.mall)} | ${item.url ? `[${cell(item.name).replace(/[\[\]]/g, '')}](${item.url})` : cell(item.name)} | ${item.price ?? '미확인'} | ${item.rating ?? '미확인'} | ${item.reviews ?? '미확인'} |`),
      '', result.coverage, '', ...Object.entries(result.sites).map(([source, status]) => `- ${source}: ${status.status}, ${status.count}개${status.error ? ` (${status.error})` : ''}`), ''].join('\n');
    await writeFile(path.join(directory, 'shopping-list.md'), markdown, { flag: 'wx' });
    console.log(JSON.stringify({ ...result, items: undefined, outputDirectory: directory }, null, 2));
  } else console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'SHOPPING_LIST_FAILED';
  console.error(JSON.stringify({ ok: false, code,
    ...(['USAGE_SHOPPING_LIST_QUERY_SOURCES_LIMIT_WRITE', 'SHOPPING_INPUT_INVALID'].includes(code) ? { usage } : {}) }, null, 2));
  process.exitCode = 2;
}
