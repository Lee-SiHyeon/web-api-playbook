#!/usr/bin/env node
import { open, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stdinJsonNoEcho, safeError } from '../lib/cli.mjs';
import { createKmongClient } from '../lib/freelance/kmong.mjs';
import { createKmongCollector } from '../lib/freelance/kmong-collection.mjs';

const HELP = `Freelance service readers\n\n` +
  `  freelance kmong home|categories\n` +
  `  freelance kmong search --keyword=TEXT [--page=N --per-page=40]\n` +
  `  freelance kmong detail --id=GIG_ID\n` +
  `  freelance kmong reviews --id=GIG_ID [--page=N]\n` +
  `  freelance kmong search-collect --keyword=TEXT [--max-pages=1..5 --input=CHECKPOINT.json]\n` +
  `  freelance kmong reviews-collect --id=GIG_ID [--max-pages=1..5 --input=CHECKPOINT.json]\n` +
  `  freelance soomgo categories|subcategories --category-1=SLUG\n` +
  `  freelance soomgo search|collect [service/location filters] [--max-pages=N]\n` +
  `  freelance soomgo profile --user-id=ID [--expected-provider-id=ID]\n` +
  `  freelance soomgo profile-contents --user-id=ID\n` +
  `  freelance soomgo profile-reviews --user-id=ID [--next-cursor=CURSOR]\n` +
  `  freelance soomgo profile-reviews-collect --user-id=ID [--max-pages=1..5 --next-cursor=CURSOR]\n` +
  `  freelance soomgo portfolio --user-id=ID [--size=4|8 --next-cursor=CURSOR]\n` +
  `  freelance soomgo portfolio-collect --user-id=ID [--size=4|8 --max-pages=1..5 --next-cursor=CURSOR]\n` +
  `  freelance soomgo request-form --service-id=ID --service-slug=SLUG --service-name=NAME\n` +
  `  freelance soomgo address-options [--depth=3]\n` +
  `  freelance soomgo request-prepare --form=FORM.json [--answers=ANSWERS.json --addresses=ADDRESSES.json]\n` +
  `  freelance upwork search|detail|collect --credentials-stdin\n\n` +
  `Upwork credentials are tagged JSON on hidden stdin: {"provider":"upwork","accessToken":"..."}.\n` +
  `All outputs preserve source prices and incomplete page coverage. These commands do not place orders or contact sellers.\n`;

async function readCheckpoint(file) {
  if (file === undefined) return undefined;
  const limit = 32 * 1024 * 1024;
  const handle = await open(path.resolve(file), 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) fail('KMONG_COLLECTION_INPUT_TOO_LARGE');
    // Bound the read too, in case another process changes the file after stat.
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > info.size || used > limit) fail('KMONG_COLLECTION_INPUT_CHANGED');
    let value;
    try { value = JSON.parse(buffer.subarray(0, used).toString('utf8')); }
    catch { fail('KMONG_COLLECTION_INPUT_INVALID'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('KMONG_COLLECTION_INPUT_INVALID');
    if (Object.hasOwn(value, 'state')) {
      if (value.schemaVersion !== 1 || value.service !== 'kmong' || !value.state ||
          typeof value.state !== 'object' || Array.isArray(value.state)) fail('KMONG_COLLECTION_INPUT_INVALID');
      return value.state;
    }
    return value;
  } finally { await handle.close(); }
}

function fail(code) { throw Object.assign(new Error(code), { code }); }
function cliErrorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_-]{1,120}$/.test(code) ? code : 'OPERATION_FAILED';
}

const text = { type: 'text', max: 2000 };
const integer = maxValue => ({ type: 'int', maxValue });

async function readLocalJson(file, code, maxBytes = 4 * 1024 * 1024, tooLargeCode = code) {
  if (typeof file !== 'string' || !file) fail(code);
  let handle;
  let buffer;
  try { handle = await open(path.resolve(file), 'r'); }
  catch { fail(code); }
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail(code);
    if (info.size > maxBytes) fail(tooLargeCode);
    buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > info.size || used > maxBytes) fail(tooLargeCode);
    try { return JSON.parse(buffer.subarray(0, used).toString('utf8').replace(/^\uFEFF/, '')); }
    catch { fail(code); }
  } catch (error) {
    if (error?.code === code || error?.code === tooLargeCode) throw error;
    fail(code);
  }
  finally { buffer?.fill(0); await handle?.close().catch(() => {}); }
}

function clearObjectStrings(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (typeof value[index] === 'string') value[index] = '';
      else clearObjectStrings(value[index], seen);
    }
  } else {
    for (const key of Object.keys(value)) {
      if (typeof value[key] === 'string') value[key] = '';
      else clearObjectStrings(value[key], seen);
    }
  }
}

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
    if (!['home', 'categories', 'search', 'detail', 'reviews', 'search-collect', 'reviews-collect'].includes(operation)) fail('OPERATION_INVALID');
    const collecting = operation.endsWith('-collect');
    const args = parseFlags(tail, collecting ? {
      [operation === 'search-collect' ? 'keyword' : 'id']: text,
      'max-pages': integer(5), input: text, output: text,
    } : operation === 'search' ? { keyword: text, page: integer(1000), 'per-page': integer(40), output: text }
      : operation === 'detail' ? { id: text, output: text }
        : operation === 'reviews' ? { id: text, page: integer(100_000), output: text }
          : { output: text });
    if (['detail', 'reviews', 'reviews-collect'].includes(operation) !== Boolean(args.id)
      || ['search', 'search-collect'].includes(operation) && !args.keyword) fail('ARGUMENT_INVALID');
    const client = createKmongClient({ fetchImpl, now });
    const state = collecting ? await readCheckpoint(args.input) : undefined;
    const collector = collecting ? createKmongCollector({ client, now }) : null;
    const result = operation === 'search-collect'
      ? await collector.collectSearch({ keyword: args.keyword, maxPages: args['max-pages'] ?? 1, state })
      : operation === 'reviews-collect'
        ? await collector.collectReviews({ id: args.id, maxPages: args['max-pages'] ?? 1, state })
      : operation === 'home' ? await client.home()
      : operation === 'categories' ? await client.categories()
        : operation === 'search' ? await client.search({ keyword: args.keyword, page: args.page ?? 1, perPage: args['per-page'] ?? 40 })
        : operation === 'detail' ? await client.detail({ id: args.id })
          : await client.reviews({ id: args.id, ...(args.page === undefined ? {} : { page: args.page }) });
    const failed = collecting && (Boolean(result.error) || result.status === 'unstable');
    return { result: collecting ? { ...result, ok: !failed } : result,
      exitCode: failed ? 1 : 0, output: args.output === undefined ? null : path.resolve(args.output) };
  }

  if (service === 'soomgo') {
    if (!['categories', 'subcategories', 'search', 'collect', 'request-form', 'address-options', 'request-prepare',
      'profile', 'profile-contents', 'profile-reviews', 'profile-reviews-collect', 'portfolio', 'portfolio-collect'].includes(operation)) fail('OPERATION_INVALID');
    const spec = operation === 'request-form' ? {
      'service-id': integer(2_147_483_647), 'service-slug': { ...text, max: 200 }, 'service-name': { ...text, max: 200 }, output: text,
    } : operation === 'address-options' ? { depth: integer(3), output: text }
      : operation === 'request-prepare' ? { form: text, answers: text, addresses: text, output: text }
      : ['profile', 'profile-contents', 'profile-reviews', 'profile-reviews-collect', 'portfolio', 'portfolio-collect'].includes(operation) ? {
        'user-id': { ...text, max: 20 },
        ...(operation === 'profile' ? { 'expected-provider-id': { ...text, max: 20 } } : {}),
        ...(['profile-reviews', 'profile-reviews-collect', 'portfolio', 'portfolio-collect'].includes(operation)
          ? { 'next-cursor': { ...text, max: 500 } } : {}),
        ...(['profile-reviews-collect', 'portfolio-collect'].includes(operation) ? { 'max-pages': integer(5) } : {}),
        ...(['portfolio', 'portfolio-collect'].includes(operation) ? { size: integer(8) } : {}), output: text,
      } : {
      'category-1': text, 'category-2': text, 'service-slug': text,
      address1: text, address2: text, keyword: text, sort: text, cursor: { ...text, max: 4096 },
      limit: integer(100), 'max-pages': integer(5), output: text,
    };
    const args = parseFlags(tail, spec);
    if (operation === 'request-form' && (!args['service-id'] || !args['service-slug'] || !args['service-name']) ||
        operation === 'request-prepare' && !args.form ||
        operation === 'address-options' && (Object.keys(args).some(key => !['depth', 'output'].includes(key)) ||
          args.depth !== undefined && args.depth !== 3) ||
        ['profile', 'profile-contents', 'profile-reviews', 'profile-reviews-collect', 'portfolio', 'portfolio-collect'].includes(operation) && !args['user-id']) fail('ARGUMENT_INVALID');
    if (operation === 'categories' && Object.keys(args).some(key => key !== 'output')
      || operation === 'subcategories' && (!args['category-1'] || Object.keys(args).some(key => !['category-1', 'output'].includes(key)))
      || operation === 'search' && args['max-pages'] !== undefined
      || !['collect', 'profile-reviews-collect', 'portfolio-collect'].includes(operation) && args['max-pages'] !== undefined) fail('ARGUMENT_INVALID');
    if (['profile', 'profile-contents', 'profile-reviews', 'profile-reviews-collect', 'portfolio', 'portfolio-collect'].includes(operation)) {
      const { createSoomgoProfileClient } = await import('../lib/freelance/soomgo-profile.mjs');
      const client = createSoomgoProfileClient({ fetchImpl, now });
      const userId = args['user-id'];
      const result = operation === 'profile'
        ? await client.getProfile({ userId, ...(args['expected-provider-id'] === undefined ? {} : { expectedProviderId: args['expected-provider-id'] }) })
        : operation === 'profile-contents' ? await client.getProfileContents({ userId })
          : operation === 'profile-reviews' ? await client.getProfileReviews({ userId,
            ...(args['next-cursor'] === undefined ? {} : { nextCursor: args['next-cursor'] }) })
            : operation === 'profile-reviews-collect' ? await client.collectProfileReviews({ userId,
              maxPages: args['max-pages'] ?? 1, ...(args['next-cursor'] === undefined ? {} : { nextCursor: args['next-cursor'] }) })
              : operation === 'portfolio-collect' ? await client.collectProfilePortfolios({ userId,
                size: args.size ?? 8, maxPages: args['max-pages'] ?? 1,
                ...(args['next-cursor'] === undefined ? {} : { nextCursor: args['next-cursor'] }) })
                : await client.getProfilePortfolios({ userId, size: args.size ?? 8,
                  ...(args['next-cursor'] === undefined ? {} : { nextCursor: args['next-cursor'] }) });
      return { result, output: args.output === undefined ? null : path.resolve(args.output) };
    }
    if (['request-form', 'address-options', 'request-prepare'].includes(operation)) {
      if (operation === 'request-form') {
        const { createSoomgoRequestClient } = await import('../lib/freelance/soomgo-request.mjs');
        const client = createSoomgoRequestClient({ fetchImpl, now });
        const result = await client.getServiceForm({ service: {
          id: args['service-id'], slug: args['service-slug'], name: args['service-name'],
        } });
        return { result, output: args.output === undefined ? null : path.resolve(args.output) };
      }
      if (operation === 'address-options') {
        const { createSoomgoRequestClient } = await import('../lib/freelance/soomgo-request.mjs');
        const client = createSoomgoRequestClient({ fetchImpl, now });
        const result = await client.listAddressOptions({ areaDepth: args.depth ?? 3 });
        return { result, output: args.output === undefined ? null : path.resolve(args.output) };
      }
      const form = await readLocalJson(args.form, 'SOOMGO_REQUEST_FORM_INPUT_INVALID', 1024 * 1024);
      let answers = {};
      let addresses;
      try {
        if (args.answers !== undefined) answers = await readLocalJson(args.answers,
          'SOOMGO_REQUEST_ANSWERS_INPUT_INVALID', 128 * 1024, 'SOOMGO_REQUEST_INPUT_TOO_LARGE');
        if (args.addresses !== undefined) addresses = await readLocalJson(args.addresses, 'SOOMGO_REQUEST_ADDRESSES_INPUT_INVALID', 2 * 1024 * 1024);
        const { prepareSoomgoRequest } = await import('../lib/freelance/soomgo-request.mjs');
        const prepared = prepareSoomgoRequest(form, {
          answersByItemId: answers,
          ...(addresses === undefined ? {} : { addressOptions: addresses }),
          now,
        });
        return { result: { ...prepared, networkUsed: false, writesSubmitted: 0, readOnly: true },
          output: args.output === undefined ? null : path.resolve(args.output) };
      } finally {
        clearObjectStrings(answers);
        clearObjectStrings(form);
        if (addresses !== undefined) clearObjectStrings(addresses);
      }
    }
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
      ? JSON.stringify({ ok: parsed.exitCode !== 1, output: reservedPath, service: parsed.result.service,
        operation: parsed.result.operation, items: parsed.result.items?.length ?? parsed.result.categories?.length ?? (parsed.result.gig ? 1 : null),
        pagination: parsed.result.pagination ?? null,
        ...(parsed.result.status ? { status: parsed.result.status, error: parsed.result.error, issues: parsed.result.issues } : {}) }) + '\n'
      : serialized);
    return parsed.exitCode ?? 0;
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
