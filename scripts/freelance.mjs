#!/usr/bin/env node
import { open, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stdinJsonNoEcho, safeError } from '../lib/cli.mjs';
import { createKmongClient } from '../lib/freelance/kmong.mjs';

const HELP = `Freelance service readers\n\n` +
  `  freelance kmong home|categories\n` +
  `  freelance kmong search --keyword=TEXT [--page=N --per-page=40]\n` +
  `  freelance kmong detail --id=GIG_ID\n` +
  `  freelance kmong reviews --id=GIG_ID [--page=N]\n` +
  `  freelance soomgo categories|subcategories --category-1=SLUG\n` +
  `  freelance soomgo search|collect [service/location filters] [--max-pages=N]\n` +
  `  freelance upwork search|detail|collect --credentials-stdin\n\n` +
  `Upwork credentials are tagged JSON on hidden stdin: {"provider":"upwork","accessToken":"..."}.\n` +
  `All outputs preserve source prices and incomplete page coverage. These commands do not place orders or send requests.\n`;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function cliErrorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_-]{1,120}$/.test(code) ? code : 'OPERATION_FAILED';
}

const text = { type: 'text', max: 2000 };
const integer = maxValue => ({ type: 'int', maxValue });

function parseFlags(args, spec) {
  const out = {};
  for (const arg of args) {
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(arg);
    if (!match || !Object.hasOwn(spec, match[1]) || Object.hasOwn(out, match[1])) fail('ARGUMENT_INVALID');
    const [, key, raw] = match;
    if (raw === undefined || raw.length === 0 || raw.length > (spec[key].max ?? 8192)) fail('ARGUMENT_INVALID');
    if (spec[key].type === 'int') {
      if (!/^(?:0|[1-9]\d*)$/.test(raw)) fail('ARGUMENT_INVALID');
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value > spec[key].maxValue) fail('ARGUMENT_INVALID');
      out[key] = value;
    } else out[key] = raw;
  }
  return out;
}

export async function runFreelanceCommand(argv, { fetchImpl = globalThis.fetch, now = Date.now, credentials } = {}) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) fail('ARGUMENT_INVALID');
  if (argv.length === 0 || argv.length === 1 && ['help', '-h', '--help'].includes(argv[0])) return { help: HELP };
  const [service, operation, ...tail] = argv;
  if (service === 'kmong') {
    if (!['home', 'categories', 'search', 'detail', 'reviews'].includes(operation)) fail('OPERATION_INVALID');
    const args = parseFlags(tail, operation === 'search' ? { keyword: text, page: integer(1000), 'per-page': integer(40), output: text }
      : operation === 'detail' ? { id: text, output: text }
        : operation === 'reviews' ? { id: text, page: integer(100_000), output: text }
          : { output: text });
    if (['detail', 'reviews'].includes(operation) !== Boolean(args.id)
      || operation === 'search' && !args.keyword) fail('ARGUMENT_INVALID');
    const client = createKmongClient({ fetchImpl, now });
    const result = operation === 'home' ? await client.home()
      : operation === 'categories' ? await client.categories()
        : operation === 'search' ? await client.search({ keyword: args.keyword, page: args.page ?? 1, perPage: args['per-page'] ?? 40 })
        : operation === 'detail' ? await client.detail({ id: args.id })
          : await client.reviews({ id: args.id, ...(args.page === undefined ? {} : { page: args.page }) });
    return { result, output: args.output === undefined ? null : path.resolve(args.output) };
  }

  if (service === 'soomgo') {
    if (!['categories', 'subcategories', 'search', 'collect'].includes(operation)) fail('OPERATION_INVALID');
    const args = parseFlags(tail, {
      'category-1': text, 'category-2': text, 'service-slug': text,
      address1: text, address2: text, keyword: text, sort: text, cursor: { ...text, max: 4096 },
      limit: integer(100), 'max-pages': integer(5), output: text,
    });
    if (operation === 'categories' && Object.keys(args).some(key => key !== 'output')
      || operation === 'subcategories' && (!args['category-1'] || Object.keys(args).some(key => !['category-1', 'output'].includes(key)))
      || operation === 'search' && args['max-pages'] !== undefined
      || operation !== 'collect' && args['max-pages'] !== undefined) fail('ARGUMENT_INVALID');
    const { createSoomgoClient } = await import('../lib/freelance/soomgo.mjs');
    const client = createSoomgoClient({ fetchImpl, now });
    const input = {
      ...(args['category-1'] === undefined ? {} : { category1: args['category-1'] }),
      ...(args['category-2'] === undefined ? {} : { category2: args['category-2'] }),
      ...(args['service-slug'] === undefined ? {} : { serviceSlug: args['service-slug'] }),
      ...(args.address1 === undefined ? {} : { address1: args.address1 }),
      ...(args.address2 === undefined ? {} : { address2: args.address2 }),
      ...(args.keyword === undefined ? {} : { keyword: args.keyword }),
      ...(args.sort === undefined ? {} : { sort: args.sort }),
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    };
    const method = { categories: 'listCategories', subcategories: 'listSubcategories', search: 'searchPros', collect: 'collectPros' }[operation];
    const result = await client[method](operation === 'subcategories' ? { category1Slug: args['category-1'] }
      : operation === 'collect' ? { ...input, ...(args['max-pages'] === undefined ? {} : { maxPages: args['max-pages'] }) }
        : input);
    return { result, output: args.output === undefined ? null : path.resolve(args.output) };
  }

  if (service === 'upwork') {
    const { runJobsCommand } = await import('./jobs.mjs');
    const parsed = await runJobsCommand(['upwork', operation, ...tail], { fetchImpl, now, credentials });
    return { result: parsed.result, output: parsed.output };
  }

  fail('SERVICE_INVALID');
}

export async function runFreelanceCli(argv = process.argv.slice(2), context = {}) {
  let reservedPath = null;
  let handle = null;
  try {
    const outputArgs = argv.filter(arg => arg === '--output' || arg.startsWith('--output='));
    if (outputArgs.length > 1) fail('ARGUMENT_INVALID');
    if (outputArgs.length === 1) {
      const match = /^--output=(.+)$/.exec(outputArgs[0]);
      if (!match) fail('ARGUMENT_INVALID');
      reservedPath = path.resolve(match[1]);
      handle = await open(reservedPath, 'wx', 0o600);
    }
    const parsed = await runFreelanceCommand(argv, context);
    if (parsed.help !== undefined) { (context.stdout ?? process.stdout).write(parsed.help); return 0; }
    if (parsed.output !== reservedPath) fail('OUTPUT_RESERVATION_MISMATCH');
    const serialized = JSON.stringify(parsed.result, null, 2) + '\n';
    if (handle) { await handle.writeFile(serialized); await handle.sync(); }
    (context.stdout ?? process.stdout).write(handle
      ? JSON.stringify({ ok: true, output: reservedPath, service: parsed.result.service,
        operation: parsed.result.operation, items: parsed.result.items?.length ?? parsed.result.categories?.length ?? (parsed.result.gig ? 1 : null),
        pagination: parsed.result.pagination ?? null }) + '\n'
      : serialized);
    return 0;
  } catch (error) {
    (context.stdout ?? process.stdout).write(JSON.stringify({ ok: false, code: cliErrorCode(error),
      httpStatus: error?.receipt?.httpStatus ?? null, origin: error?.receipt?.origin ?? null,
      path: error?.receipt?.path ?? null }) + '\n');
    return 1;
  } finally {
    await handle?.close().catch(() => {});
    if (reservedPath) {
      try { if ((await stat(reservedPath)).size === 0) await rm(reservedPath); } catch { /* only remove our empty reservation */ }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--credentials-stdin');
  let credentials;
  if (index >= 0 && process.argv[2] === 'upwork') {
    try { credentials = await stdinJsonNoEcho(16 * 1024, { prompt: 'Enter tagged API credentials (hidden): ' }); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: safeError(error) }) + '\n'); process.exitCode = 1; }
  }
  if (!process.exitCode) process.exitCode = await runFreelanceCli(process.argv.slice(2), { credentials });
}
