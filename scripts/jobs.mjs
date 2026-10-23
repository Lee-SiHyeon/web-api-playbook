#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { open, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stdinJsonNoEcho } from '../lib/cli.mjs';
import { createJobsClient } from '../lib/jobs/providers.mjs';
import { createJobSnapshot, compareJobSnapshots } from '../lib/jobs/snapshots.mjs';
import { createRemotiveJobsClient, createReedJobsClient } from '../lib/jobs/boards.mjs';

const HELP = `Public job-board readers\n\n` +
  `  jobs greenhouse|lever|ashby list --board=TOKEN [options]\n` +
  `  jobs greenhouse|lever|ashby detail --board=TOKEN --id=ID [options]\n` +
  `  jobs greenhouse|lever|ashby collect --board=TOKEN [--max-pages=N] [options]\n` +
  `  jobs tokyodev list\n` +
  `  jobs tokyodev detail --url=https://www.tokyodev.com/companies/SLUG/jobs/SLUG\n` +
  `  jobs tokyodev parse --input=HTML_FILE --url=https://www.tokyodev.com/jobs|https://www.tokyodev.com/companies/SLUG/jobs/SLUG\n` +
  `  jobs remotive list [--query=TEXT] [--category=NAME] [--company=NAME]\n` +
  `  jobs remotive categories\n` +
  `  jobs reed list|collect --credentials-stdin [search filters]\n` +
  `  jobs snapshot --input=LIST.json\n` +
  `  jobs diff --before=SNAPSHOT.json --after=SNAPSHOT.json\n\n` +
  `Options: --output=FILE --region=global|eu --limit=N --offset=N --max-pages=N\n` +
  `         --include-content=true|false --include-compensation=true|false\n` +
  `Reed keys arrive only as tagged JSON on hidden stdin: {"provider":"reed","apiKey":"..."}.\n` +
  `Reed search filters: --query=TEXT --location=PLACE --minimum-salary=N --maximum-salary=N\n` +
  `                        --full-time=true|false --permanent=true|false --page-size=N\n`;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function cliErrorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_-]{1,120}$/.test(code) ? code : 'OPERATION_FAILED';
}

function parseFlags(args, spec) {
  const out = {};
  for (const arg of args) {
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(arg);
    if (!match || !Object.hasOwn(spec, match[1]) || Object.hasOwn(out, match[1])) fail('ARGUMENT_INVALID');
    const [, key, value] = match;
    const kind = spec[key];
    if (kind === 'bool') {
      if (value === undefined) out[key] = true;
      else if (value === 'true') out[key] = true;
      else if (value === 'false') out[key] = false;
      else fail('ARGUMENT_INVALID');
    } else {
      if (value === undefined || value.length === 0 || value.length > (kind.max ?? 8192)) fail('ARGUMENT_INVALID');
      out[key] = kind.type === 'int' ? parseInteger(value, kind.maxValue) : value;
    }
  }
  return out;
}

function parseInteger(value, max = Number.MAX_SAFE_INTEGER) {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) fail('ARGUMENT_INVALID');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > max) fail('ARGUMENT_INVALID');
  return result;
}

const text = { type: 'text', max: 2_000 };
const int = maxValue => ({ type: 'int', maxValue });
const bool = 'bool';

function outputOf(options) {
  if (options.output !== undefined && typeof options.output !== 'string') fail('OUTPUT_INVALID');
  return options.output === undefined ? null : path.resolve(options.output);
}

function helpOrArgs(argv) {
  if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) return true;
  return false;
}

async function readJsonBounded(file, maxBytes = 32 * 1024 * 1024) {
  if (typeof file !== 'string' || !file.length || file.length > 4096) fail('INPUT_FILE_INVALID');
  let info;
  try { info = await stat(path.resolve(file)); } catch { fail('INPUT_FILE_UNAVAILABLE'); }
  if (!info.isFile() || info.size > maxBytes) fail('INPUT_FILE_TOO_LARGE');
  let bytes;
  try { bytes = await readFile(path.resolve(file)); } catch { fail('INPUT_FILE_UNAVAILABLE'); }
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { fail('INPUT_JSON_INVALID'); }
  finally { bytes.fill(0); }
}

async function readCredentials(expectedProvider, credentials) {
  if (credentials === undefined) fail('CREDENTIALS_REQUIRED');
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)
    || credentials.provider !== expectedProvider) fail('CREDENTIAL_SCOPE_INVALID');
  if (expectedProvider === 'reed') {
    if (Object.keys(credentials).some(key => !['provider', 'apiKey'].includes(key))
      || typeof credentials.apiKey !== 'string' || !credentials.apiKey.length) fail('CREDENTIAL_SCOPE_INVALID');
  } else if (expectedProvider === 'upwork') {
    if (Object.keys(credentials).some(key => !['provider', 'accessToken', 'tenantId'].includes(key))
      || typeof credentials.accessToken !== 'string' || !credentials.accessToken.length
      || credentials.tenantId !== undefined && typeof credentials.tenantId !== 'string') fail('CREDENTIAL_SCOPE_INVALID');
  }
  return credentials;
}

function reedFilters(options) {
  return {
    ...(options.query === undefined ? {} : { keywords: options.query }),
    ...(options.location === undefined ? {} : { locationName: options.location }),
    ...(options['minimum-salary'] === undefined ? {} : { minimumSalary: options['minimum-salary'] }),
    ...(options['maximum-salary'] === undefined ? {} : { maximumSalary: options['maximum-salary'] }),
    ...(options['full-time'] === undefined ? {} : { fullTime: options['full-time'] }),
    ...(options.permanent === undefined ? {} : { permanent: options.permanent }),
    ...(options.contract === undefined ? {} : { contract: options.contract }),
    ...(options.graduate === undefined ? {} : { graduate: options.graduate }),
    ...(options['page-size'] === undefined ? {} : { pageSize: options['page-size'] }),
  };
}

export async function runJobsCommand(argv, { fetchImpl = globalThis.fetch, now = Date.now, credentials } = {}) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) fail('ARGUMENT_INVALID');
  if (helpOrArgs(argv)) return { help: HELP };
  if (argv.length === 0) return { help: HELP };
  const [source, ...rest] = argv;
  if (source === 'snapshot') {
    const args = parseFlags(rest, { input: text, output: text });
    if (!args.input) fail('ARGUMENT_REQUIRED');
    const input = await readJsonBounded(args.input);
    return { result: createJobSnapshot(input), output: outputOf(args) };
  }
  if (source === 'diff') {
    const args = parseFlags(rest, { before: text, after: text, output: text });
    if (!args.before || !args.after) fail('ARGUMENT_REQUIRED');
    const [before, after] = await Promise.all([readJsonBounded(args.before), readJsonBounded(args.after)]);
    return { result: compareJobSnapshots(before, after), output: outputOf(args) };
  }
  const [operation, ...tail] = rest;
  if (!operation) fail('ARGUMENT_REQUIRED');

  if (['greenhouse', 'lever', 'ashby'].includes(source)) {
    if (!['list', 'detail', 'collect'].includes(operation)) fail('OPERATION_INVALID');
    const args = parseFlags(tail, {
      board: text, id: text, region: text, limit: int(1000), offset: int(100_000_000),
      'max-pages': int(100), 'include-content': bool, 'include-compensation': bool, output: text,
    });
    if (!args.board || operation === 'detail' && !args.id || operation !== 'detail' && args.id) fail('ARGUMENT_INVALID');
    const client = createJobsClient({ fetchImpl, now });
    const input = {
      provider: source, board: args.board,
      ...(args.region === undefined ? {} : { region: args.region }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
      ...(args.offset === undefined ? {} : { offset: args.offset }),
      ...(args['include-content'] === undefined ? {} : { includeContent: args['include-content'] }),
      ...(args['include-compensation'] === undefined ? {} : { includeCompensation: args['include-compensation'] }),
    };
    let result;
    if (operation === 'detail') result = await client.detail({ ...input, id: args.id });
    else if (operation === 'collect') result = await client.collect(input, { ...(args['max-pages'] === undefined ? {} : { maxPages: args['max-pages'] }) });
    else {
      if (args['max-pages'] !== undefined) fail('ARGUMENT_INVALID');
      result = await client.list(input);
    }
    return { result, output: outputOf(args) };
  }

  if (source === 'tokyodev') {
    if (!['list', 'detail', 'parse'].includes(operation)) fail('OPERATION_INVALID');
    const args = parseFlags(tail, operation === 'list' ? { output: text }
      : operation === 'detail' ? { url: text, output: text }
        : { input: text, url: text, output: text });
    if (operation === 'detail' && !args.url || operation === 'list' && args.url !== undefined
      || operation === 'parse' && (!args.input || !args.url)) fail('ARGUMENT_INVALID');
    let result;
    if (operation === 'parse') {
      const { parseTokyoDevJobsPage, parseTokyoDevJobDetail, TOKYO_DEV_ORIGIN } = await import('../lib/jobs/japan.mjs');
      let target;
      try { target = new URL(args.url); } catch { fail('TOKYO_DEV_OFFLINE_URL_INVALID'); }
      if (target.origin !== TOKYO_DEV_ORIGIN || target.search || target.hash || target.username || target.password || target.port) {
        fail('TOKYO_DEV_OFFLINE_URL_INVALID');
      }
      let info;
      try { info = await stat(path.resolve(args.input)); } catch { fail('INPUT_FILE_UNAVAILABLE'); }
      if (!info.isFile() || info.size > 8 * 1024 * 1024) fail('INPUT_FILE_TOO_LARGE');
      let raw;
      try { raw = await readFile(path.resolve(args.input)); } catch { fail('INPUT_FILE_UNAVAILABLE'); }
      if (raw.length > 8 * 1024 * 1024) { raw.fill(0); fail('INPUT_FILE_TOO_LARGE'); }
      let html;
      try { html = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
      catch { raw.fill(0); fail('INPUT_UTF8_INVALID'); }
      const sourceSha256 = createHash('sha256').update(raw).digest('hex');
      const responseBytes = raw.byteLength;
      raw.fill(0);
      const checkedAtMs = now();
      if (!Number.isFinite(checkedAtMs)) fail('TOKYO_DEV_OFFLINE_TIMESTAMP_INVALID');
      const checkedAt = new Date(checkedAtMs).toISOString();
      let projection;
      let offlineOperation;
      let scope;
      if (target.pathname === '/jobs') {
        projection = parseTokyoDevJobsPage(html, { url: args.url });
        offlineOperation = 'parse-list';
        scope = { provider: 'tokyodev', board: 'jobs', region: 'jp', filters: {} };
      } else {
        const job = parseTokyoDevJobDetail(html, { url: args.url });
        projection = { jobs: [job], coverage: { complete: false,
          reason: 'single_saved_detail_is_not_a_board_snapshot', returned: 1,
          sourceTotal: null, filteredOut: 0, pages: 1, next: null } };
        offlineOperation = 'parse-detail';
        scope = { provider: 'tokyodev', board: 'jobs', region: 'jp', filters: { id: job.id } };
      }
      result = {
        schemaVersion: 1, provider: 'tokyodev', operation: offlineOperation,
        executionMode: 'offline', networkUsed: false, provenance: 'caller_supplied_document',
        liveReplay: false, liveCurrentness: 'unknown', checkedAt, scope,
        jobs: projection.jobs, coverage: projection.coverage, requests: [],
        sourceDocument: { url: args.url, filename: path.basename(args.input),
          mediaType: 'text/html; charset=utf-8', responseBytes, sha256: sourceSha256 },
      };
    } else {
      const { createTokyoDevJobsClient } = await import('../lib/jobs/japan.mjs');
      const client = createTokyoDevJobsClient({ fetchImpl, now });
      result = operation === 'list' ? await client.list() : await client.detail({ url: args.url });
    }
    return { result, output: outputOf(args) };
  }

  if (source === 'remotive') {
    if (operation !== 'list') fail('OPERATION_INVALID');
    const args = parseFlags(tail, { query: text, category: text, company: text, output: text });
    const client = createRemotiveJobsClient({ fetchImpl, now });
    const result = await client.list({
      ...(args.query === undefined ? {} : { query: args.query }),
      ...(args.category === undefined ? {} : { category: args.category }),
      ...(args.company === undefined ? {} : { companyName: args.company }),
    });
    return { result, output: outputOf(args) };
  }

  if (source === 'reed') {
    if (!['list', 'collect'].includes(operation)) fail('OPERATION_INVALID');
    const args = parseFlags(tail, {
      'credentials-stdin': bool, query: text, location: text, 'minimum-salary': int(10_000_000),
      'maximum-salary': int(10_000_000), 'full-time': bool, permanent: bool, contract: bool,
      graduate: bool, 'page-size': int(100), offset: int(100_000), 'max-pages': int(20), output: text,
    });
    if (args['credentials-stdin'] !== true
      || args['max-pages'] !== undefined && operation !== 'collect') fail('ARGUMENT_INVALID');
    const supplied = await readCredentials('reed', credentials);
    const client = createReedJobsClient({ apiKey: supplied.apiKey, fetchImpl, now });
    const input = { filters: reedFilters(args), ...(args.offset === undefined ? {} : { offset: args.offset }) };
    const result = operation === 'list' ? await client.list(input)
      : await client.collect({ ...input, ...(args['max-pages'] === undefined ? {} : { maxPages: args['max-pages'] }) });
    return { result, output: outputOf(args) };
  }

  if (source === 'upwork') {
    if (!['search', 'detail', 'collect'].includes(operation)) fail('OPERATION_INVALID');
    const args = parseFlags(tail, { 'credentials-stdin': bool, query: text, id: text,
      cursor: { ...text, max: 8192 }, limit: int(50), 'max-pages': int(20), output: text });
    if (args['credentials-stdin'] !== true
      || operation === 'detail' && (!args.id || args.query !== undefined || args.cursor !== undefined || args.limit !== undefined || args['max-pages'] !== undefined)
      || operation !== 'detail' && !args.query || operation !== 'collect' && args['max-pages'] !== undefined
      || operation === 'search' && args.id !== undefined || operation === 'collect' && args.id !== undefined) fail('ARGUMENT_INVALID');
    const supplied = await readCredentials('upwork', credentials);
    const { createUpworkClient } = await import('../lib/freelance/upwork.mjs');
    const client = createUpworkClient({ accessToken: supplied.accessToken,
      ...(supplied.tenantId === undefined ? {} : { tenantId: supplied.tenantId }), fetchImpl, now });
    const result = operation === 'detail' ? await client.getJob({ id: args.id })
      : operation === 'collect' ? await client.collectJobs({ query: args.query, limit: args.limit, cursor: args.cursor },
        { ...(args['max-pages'] === undefined ? {} : { maxPages: args['max-pages'] }) })
        : await client.searchJobs({ query: args.query, limit: args.limit, cursor: args.cursor });
    return { result, output: outputOf(args) };
  }

  fail('SERVICE_INVALID');
}

export async function runJobsCli(argv = process.argv.slice(2), context = {}) {
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
    const parsed = await runJobsCommand(argv, context);
    if (parsed.help !== undefined) { (context.stdout ?? process.stdout).write(parsed.help); return 0; }
    if (parsed.output !== reservedPath) fail('OUTPUT_RESERVATION_MISMATCH');
    const serialized = JSON.stringify(parsed.result, null, 2) + '\n';
    if (handle) { await handle.writeFile(serialized); await handle.sync(); }
    (context.stdout ?? process.stdout).write(handle
      ? JSON.stringify({ ok: true, output: reservedPath, provider: parsed.result.provider,
        operation: parsed.result.operation, jobs: parsed.result.jobs?.length ?? parsed.result.categories?.length ?? null,
        coverage: parsed.result.coverage ?? null }) + '\n'
      : serialized);
    return 0;
  } catch (error) {
    (context.stdout ?? process.stdout).write(JSON.stringify({ ok: false, code: cliErrorCode(error),
      httpStatus: error?.receipt?.httpStatus ?? null,
      origin: error?.receipt?.origin ?? null,
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
  if (index >= 0) {
    if (!['reed', 'upwork'].includes(process.argv[2])) {
      process.stdout.write(JSON.stringify({ ok: false, code: 'CREDENTIAL_SCOPE_INVALID' }) + '\n');
      process.exitCode = 1;
    }
    try { if (!process.exitCode) credentials = await stdinJsonNoEcho(16 * 1024, { prompt: 'Enter tagged API credentials (hidden): ' }); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: cliErrorCode(error) }) + '\n'); process.exitCode = 1; }
  }
  if (!process.exitCode) process.exitCode = await runJobsCli(process.argv.slice(2), { credentials });
}
