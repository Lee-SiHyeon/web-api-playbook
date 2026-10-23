#!/usr/bin/env node
// Musinsa (무신사) and 29CM (29CM) women's fashion reads for outfit sourcing. JSON on stdout.
//   node scripts/musinsa.mjs rank [--site=musinsa|29cm] [--category=top|outer|bottom|dress|swim|bag|hat|sunglasses|<code>]
//                                 [--period=realtime|daily|weekly|monthly(29cm only)] [--limit=20] [--include-soldout]
//   node scripts/musinsa.mjs search "<keyword>" [--site=..] [--limit=20] [--sort=<29cm sort, default MOST_SOLD>]
//   node scripts/musinsa.mjs goods <goodsNo> [--site=..]
//   node scripts/musinsa.mjs images <goodsNo> --out=<dir> [--site=..]
// Downloads go to a local temp folder first, then the files are copied into --out (no direct writes to a synced folder).
// Optional: --output=<new file> (reserved exclusively), --interval-ms=<>=3000>.
import { access, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fail as cliFail, options, reserveOutput, report, safeError } from '../lib/cli.mjs';
import { createMusinsaClient, MUSINSA_CATEGORY_CODES, MUSINSA_RANK_PERIODS, musinsaImageSet } from '../lib/commerce/musinsa.mjs';
import { createCm29Client, CM29_CATEGORY_CODES, CM29_RANK_PERIODS, CM29_SEARCH_SORTS, cm29ImageSet } from '../lib/commerce/29cm.mjs';
import { downloadImageSet } from '../lib/commerce/fashion-images.mjs';

const SITES = {
  musinsa: { categories: MUSINSA_CATEGORY_CODES, periods: Object.keys(MUSINSA_RANK_PERIODS), create: createMusinsaClient, imageSet: musinsaImageSet },
  '29cm': { categories: CM29_CATEGORY_CODES, periods: Object.keys(CM29_RANK_PERIODS), create: createCm29Client, imageSet: cm29ImageSet },
};
const COMMANDS = {
  rank: ['site', 'category', 'period', 'limit', 'include-soldout'],
  search: ['site', 'q', 'limit', 'sort'],
  goods: ['site'],
  images: ['site', 'out'],
};
const MAX_LIMIT = { rank: 300, search: 200 }; // musinsa: 3 pages of ~101; 29cm best returns at most 100

const fail = code => cliFail(code);
const num = (v, d, max) => (v === undefined ? d : /^\d{1,4}$/.test(String(v)) && Number(v) >= 1 && Number(v) <= max ? Number(v) : fail('FASHION_ARGUMENT_INVALID'));
const goodsArg = v => (/^\d{1,12}$/.test(String(v ?? '')) && !/^0/.test(String(v)) ? String(v) : fail('FASHION_ID_INVALID'));

const [command, ...rest] = process.argv.slice(2);
let handle;
try {
  if (!Object.hasOwn(COMMANDS, command ?? '')) fail('FASHION_COMMAND_INVALID');
  const opts = options(rest.filter(a => a.startsWith('--')), [...COMMANDS[command], 'output', 'interval-ms']);
  const positional = rest.filter(a => !a.startsWith('--'));
  const site = opts.site ?? 'musinsa';
  if (!Object.hasOwn(SITES, site)) fail('FASHION_SITE_INVALID');
  const cfg = SITES[site];
  const intervalMs = num(opts['interval-ms'], 3000, 60000);
  if (intervalMs < 3000) fail('FASHION_INTERVAL_TOO_SHORT');
  if (opts.output) handle = await reserveOutput(opts.output);
  const client = cfg.create({ minIntervalMs: intervalMs });
  let data;
  if (command === 'rank') {
    const category = opts.category ?? 'top';
    if (!/^\d{3,9}$/.test(category) && !Object.hasOwn(cfg.categories, category)) fail('FASHION_CATEGORY_INVALID');
    const period = opts.period ?? 'realtime';
    if (!cfg.periods.includes(period)) fail('FASHION_PERIOD_INVALID');
    data = await client.ranking({ category, period, limit: num(opts.limit, 20, MAX_LIMIT.rank), includeSoldOut: opts['include-soldout'] === true });
  } else if (command === 'search') {
    const keyword = opts.q ?? positional.join(' ');
    if (!keyword.trim()) fail('FASHION_KEYWORD_REQUIRED');
    const sort = opts.sort ?? (site === 'musinsa' ? 'POPULAR' : 'MOST_SOLD');
    if (site === 'musinsa' && sort !== 'POPULAR') fail('FASHION_SORT_INVALID');
    if (site === '29cm' && !CM29_SEARCH_SORTS.includes(sort)) fail('FASHION_SORT_INVALID');
    data = await client.search({ keyword, sort, limit: num(opts.limit, 20, MAX_LIMIT.search) });
  } else if (command === 'goods') {
    if (positional.length !== 1) fail('FASHION_GOODS_NO_REQUIRED');
    data = await client.goods({ goodsNo: goodsArg(positional[0]) });
  } else {
    if (positional.length !== 1) fail('FASHION_GOODS_NO_REQUIRED');
    if (!opts.out || opts.out === true) fail('FASHION_OUT_REQUIRED');
    const goodsNo = goodsArg(positional[0]);
    const goods = await client.goods({ goodsNo });
    const items = cfg.imageSet(goods);
    const outDir = path.resolve(opts.out);
    const staging = await mkdtemp(path.join(tmpdir(), 'fashion-images-'));
    try {
      const { saved, skipped } = await downloadImageSet({ items, dir: staging, prefix: goodsNo, minIntervalMs: 500 });
      for (const f of saved) {
        const exists = await access(path.join(outDir, f.file)).then(() => true, () => false);
        if (exists) fail('FASHION_OUTPUT_EXISTS');
      }
      await mkdir(outDir, { recursive: true });
      for (const f of saved) await copyFile(path.join(staging, f.file), path.join(outDir, f.file), constants.COPYFILE_EXCL);
      data = {
        goodsNo: goods.goodsNo, name: goods.name, out: outDir,
        files: saved.map(({ file, kind, sourceUrl, contentType, bytes, sha256 }) => ({ file: path.join(outDir, file), kind, sourceUrl, contentType, bytes, sha256 })),
        skipped,
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await report({
    schema: 'web-api-fashion-result-v1', site, command, ok: true, checkedAt: new Date().toISOString(),
    executionMode: 'pure_http', browserUsed: false, accountLogin: false, writesSubmitted: 0,
    session: 'none: no cookies, no login, no account token (responses are used in memory only)',
    requests: client.receipts, data,
  }, handle);
} catch (error) {
  const out = { code: safeError(error) };
  for (const key of ['httpStatus', 'path', 'vendor', 'mime', 'skipped']) if (error?.[key] !== undefined) out[key] = error[key];
  await report({ schema: 'web-api-fashion-result-v1', command: command ?? null, ok: false, error: out }, handle).catch(() => {});
  process.exitCode = 1;
} finally {
  await handle?.close();
}
