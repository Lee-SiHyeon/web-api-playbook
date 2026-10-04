#!/usr/bin/env node
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { options, stdinJson, reserveOutput, report, safeError } from '../lib/cli.mjs';
import { COMMERCE_PROVIDERS, createCommerceReader } from '../lib/commerce/providers.mjs';
import { collectOfferSnapshot, comparePriceSnapshots, snapshotCsv } from '../lib/commerce/snapshots.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const ARGUMENTS = {
  'printful-feed': ['id', 'query', 'region'], 'shopify-storefronts': ['id', 'query', 'store', 'pageSize'],
  'aliexpress-partner': ['id', 'query', 'currency', 'country', 'language', 'categoryId', 'pageSize'],
  'aliexpress-social': ['query', 'country', 'pageSize'], 'ebay-partner': ['id', 'query', 'marketplace', 'categoryId', 'pageSize'],
  'amazon-partner': ['id', 'query', 'currency', 'marketplace', 'pageSize'], cjdropshipping: ['id', 'query', 'country', 'categoryId', 'pageSize'],
  banggood: ['id', 'query', 'currency', 'categoryId'], awin: ['id', 'query', 'locale', 'advertiserId', 'pageSize'],
  impact: ['id', 'query', 'catalogId', 'pageSize'], 'printful-api': ['id', 'region', 'currency', 'productionCurrency', 'pageSize'],
};
const FLAGS = ['input', 'output', 'csv', 'baseline', 'credentials-stdin', 'limit', 'max-pages', 'id', 'query', 'store', 'region',
  'currency', 'marketplace', 'category-id', 'country', 'language', 'locale', 'advertiser-id', 'catalog-id', 'page-size', 'production-currency'];
const FLAG_ARGS = { 'category-id': 'categoryId', 'advertiser-id': 'advertiserId', 'catalog-id': 'catalogId', 'page-size': 'pageSize', 'production-currency': 'productionCurrency' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, fallback, maximum) => {
  const n = value === undefined ? fallback : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) fail('COMMERCE_LIMIT_INVALID');
  return n;
};
async function readJson(file, limit) {
  if (typeof file !== 'string') fail('COMMERCE_FILE_INVALID');
  const info = await stat(file);
  if (!info.isFile() || info.size > limit) fail('COMMERCE_FILE_TOO_LARGE');
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { fail('COMMERCE_JSON_INVALID'); }
}
function assertNoCredentialLeak(value, credentials) {
  const serialized = JSON.stringify(value);
  for (const [key, secret] of Object.entries(credentials)) {
    if (/secret|token|key|credentialid/i.test(key) && typeof secret === 'string' && secret.length >= 8 && serialized.includes(secret)) fail('COMMERCE_SECRET_IN_RESULT');
  }
}

let jsonOutput, csvOutput;
try {
  const [providerArg, operationArg, ...tail] = process.argv.slice(2);
  if (providerArg === 'providers' && operationArg === undefined) {
    await report({ schema: 'web-api-commerce-providers-v1', networkUsed: false, providers: COMMERCE_PROVIDERS });
  } else {
    const opts = options(tail, FLAGS);
    let provider = providerArg, operation = operationArg, args = {}, job;
    if (opts.input) {
      if (providerArg !== 'run' || operationArg !== 'job') fail('COMMERCE_JOB_ARGUMENT_INVALID');
      if (Object.keys(opts).some(key => !['input', 'output', 'csv', 'baseline', 'credentials-stdin', 'limit', 'max-pages'].includes(key))) fail('COMMERCE_JOB_ARGUMENT_INVALID');
      job = await readJson(opts.input, 2 * 1024 * 1024);
      if (!object(job) || job.schema !== 'web-api-commerce-job-v1' || Object.keys(job).some(key =>
        !['schema', 'provider', 'operation', 'args', 'maxPages', 'maxOffers'].includes(key))) fail('COMMERCE_JOB_INVALID');
      ({ provider, operation, args = {} } = job);
    } else {
      for (const flag of FLAGS.filter(key => !['input', 'output', 'csv', 'baseline', 'credentials-stdin', 'limit', 'max-pages'].includes(key))) {
        if (opts[flag] !== undefined) args[FLAG_ARGS[flag] ?? flag] = opts[flag];
      }
    }
    if (!COMMERCE_PROVIDERS[provider]?.operations.includes(operation) || !object(args) || Object.keys(args).some(key => !ARGUMENTS[provider].includes(key))) fail('COMMERCE_JOB_INVALID');
    for (const [key, value] of Object.entries(args)) {
      if (key === 'pageSize') args[key] = integer(value, 20, 100);
      else if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) fail('COMMERCE_ARGUMENT_INVALID');
    }
    if (provider === 'cjdropshipping' && args.id && args.country) fail('COMMERCE_DESTINATION_UNSUPPORTED_FOR_DETAIL');
    if (operation === 'product' && !args.id) fail('COMMERCE_PRODUCT_ID_REQUIRED');
    if (operation === 'search' && args.id) fail('COMMERCE_JOB_INVALID');
    const maxOffers = integer(opts.limit ?? job?.maxOffers, 100, 50_000);
    const maxPages = integer(opts['max-pages'] ?? job?.maxPages, operation === 'product' ? 1 : 3, 100);
    if (maxOffers > 200 && !opts.output) fail('COMMERCE_OUTPUT_REQUIRED');
    for (const file of [opts.output, opts.csv, opts.baseline].filter(v => v !== undefined)) if (typeof file !== 'string') fail('COMMERCE_FILE_INVALID');
    if (opts.csv && !opts.output || opts.csv && path.resolve(opts.csv) === path.resolve(opts.output)) fail('COMMERCE_OUTPUT_PATH_INVALID');
    let credentials = {};
    if (opts['credentials-stdin'] !== undefined) {
      if (opts['credentials-stdin'] !== true) fail('COMMERCE_CREDENTIAL_INPUT_INVALID');
      const packet = await stdinJson(32 * 1024);
      if (!object(packet) || packet.provider !== provider) fail('COMMERCE_CREDENTIAL_SERVICE_MISMATCH');
      const { provider: ignored, ...values } = packet; credentials = values;
    }
    const baseline = opts.baseline ? await readJson(opts.baseline, 64 * 1024 * 1024) : null;
    jsonOutput = await reserveOutput(opts.output); csvOutput = await reserveOutput(opts.csv);
    const context = Object.fromEntries(['store', 'region', 'marketplace', 'locale', 'currency', 'country', 'productionCurrency', 'advertiserId', 'catalogId', 'query']
      .filter(key => args[key] !== undefined).map(key => [key, args[key]]));
    const loadPage = await createCommerceReader({ provider, args, credentials });
    const snapshot = await collectOfferSnapshot({ provider, context: { ...context, operation }, loadPage, maxPages, maxOffers });
    snapshot.credentialsUsed = snapshot.receipts.some(receipt => receipt.credentialsUsed === true);
    snapshot.secretsPersistedInEvidence = false;
    if (baseline) snapshot.comparison = comparePriceSnapshots(baseline, snapshot);
    assertNoCredentialLeak(snapshot, credentials);
    const csv = opts.csv ? snapshotCsv(snapshot) : null;
    if (jsonOutput) await jsonOutput.writeFile(JSON.stringify(snapshot, null, 2) + '\n');
    if (csvOutput) await csvOutput.writeFile(csv);
    if (jsonOutput) await report({ ok: true, schema: 'web-api-commerce-collection-result-v1', provider,
      checkedAt: snapshot.checkedAt, executionMode: snapshot.executionMode, credentialsUsed: snapshot.credentialsUsed,
      collection: snapshot.collection, changes: snapshot.comparison?.changes.length ?? null,
      output: path.resolve(opts.output), csv: opts.csv ? path.resolve(opts.csv) : null });
    else await report(snapshot);
  }
} catch (error) {
  const result = { ok: false, code: safeError(error) };
  if (jsonOutput) await jsonOutput.writeFile(JSON.stringify(result) + '\n');
  await report(result); process.exitCode = 1;
} finally { await Promise.all([jsonOutput?.close(), csvOutput?.close()]); }
