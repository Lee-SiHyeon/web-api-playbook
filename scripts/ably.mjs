#!/usr/bin/env node
// Ably (에이블리) anonymous public reads. JSON on stdout.
//   node scripts/ably.mjs categories
//   node scripts/ably.mjs ranking [--category=<sno>] [--period=daily|weekly|monthly] [--age=1..5] [--limit=20]
//   node scripts/ably.mjs search --q=<keyword> [--limit=30]
//   node scripts/ably.mjs product --id=<goods sno> [--no-options]
//   node scripts/ably.mjs outfits [--goods=<sno>] [--order=recommend|recent] [--limit=30]
//   node scripts/ably.mjs style-contents [--limit=10]
//   node scripts/ably.mjs markets [--type=7] [--limit=20]          (7 = 셀럽 influencer shops)
// Optional: --output=<new file> (reserved exclusively), --interval-ms=<>=3000>.
import { options, reserveOutput, report, safeError } from '../lib/cli.mjs';
import { createAblyClient } from '../lib/commerce/ably.mjs';

const COMMANDS = {
  categories: [], ranking: ['category', 'period', 'age', 'limit'], search: ['q', 'limit'],
  product: ['id', 'no-options'], outfits: ['goods', 'order', 'limit'], 'style-contents': ['limit'], markets: ['type', 'limit'],
};
const fail = code => { throw Object.assign(new Error(code), { code }); };
const num = (v, d) => (v === undefined ? d : /^\d{1,6}$/.test(String(v)) ? Number(v) : fail('ABLY_ARGUMENT_INVALID'));

let handle;
const [command, ...rest] = process.argv.slice(2);
try {
  if (!Object.hasOwn(COMMANDS, command ?? '')) fail('ABLY_COMMAND_INVALID');
  const opts = options(rest, [...COMMANDS[command], 'output', 'interval-ms']);
  const intervalMs = num(opts['interval-ms'], 3000);
  if (intervalMs < 3000) fail('ABLY_INTERVAL_TOO_SHORT');
  if (opts.output) handle = await reserveOutput(opts.output);
  const client = createAblyClient({ minIntervalMs: intervalMs });
  let data;
  if (command === 'categories') data = await client.categories();
  else if (command === 'ranking') data = await client.ranking({ categorySno: opts.category, period: opts.period, age: opts.age, limit: num(opts.limit, 20) });
  else if (command === 'search') data = await client.search({ query: opts.q, limit: num(opts.limit, 30) });
  else if (command === 'product') { if (!opts.id) fail('ABLY_PRODUCT_ID_REQUIRED'); data = await client.product({ id: opts.id, options: !opts['no-options'] }); }
  else if (command === 'outfits') data = await client.outfits({ goodsSno: opts.goods, order: opts.order, limit: num(opts.limit, 30) });
  else if (command === 'style-contents') data = await client.styleContents({ limit: num(opts.limit, 10) });
  else data = await client.marketRanking({ type: opts.type ?? 7, limit: num(opts.limit, 20) });
  await report({
    schema: 'web-api-ably-result-v1', service: 'ably', command, ok: true, checkedAt: new Date().toISOString(),
    executionMode: 'pure_http', browserUsed: false, accountLogin: false, writesSubmitted: 0,
    session: 'server-issued anonymous token in memory only (not persisted)',
    requests: client.receipts, data,
  }, handle);
} catch (error) {
  const out = { code: safeError(error) };
  for (const key of ['httpStatus', 'path', 'vendor', 'categorySno']) if (error?.[key] !== undefined) out[key] = error[key];
  await report({ schema: 'web-api-ably-result-v1', service: 'ably', command: command ?? null, ok: false, error: out }, handle).catch(() => {});
  process.exitCode = 1;
} finally {
  await handle?.close();
}
