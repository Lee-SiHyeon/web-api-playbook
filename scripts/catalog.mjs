#!/usr/bin/env node
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { options, stdinJson, reserveOutput, report, safeError } from '../lib/cli.mjs';
import { CATALOG_READERS, createCatalogReader, effectiveReviewPageSize } from '../lib/commerce/catalog-readers.mjs';
import { collectReviews, reviewsCsv, safeReviewCursor } from '../lib/commerce/reviews.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const positive = (value, fallback, maximum) => {
  const number = value === undefined ? fallback : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) fail('CATALOG_LIMIT_INVALID');
  return number;
};
const flags = ['id', 'query', 'store', 'marketplace', 'currency', 'country', 'language', 'sku-id', 'shop-id', 'item-id', 'review-url', 'product-url', 'page',
  'output', 'csv', 'credentials-stdin', 'page-size', 'catalog-page-size', 'category-id', 'max-pages', 'limit', 'resume-input'];
const argsByFlag = { 'sku-id': 'skuId', 'shop-id': 'shopId', 'item-id': 'itemId', 'review-url': 'reviewUrl', 'product-url': 'productUrl',
  'category-id': 'categoryId', 'catalog-page-size': 'pageSize' };
let output, csvOutput;
try {
  const [provider, operation, ...tail] = process.argv.slice(2);
  if (provider === 'providers' && operation === undefined && !tail.length) {
    await report({ schema: 'web-api-catalog-readers-v1', networkUsed: false, affiliateLinkGeneration: false, providers: CATALOG_READERS });
  } else {
    const opts = options(tail, flags), args = {};
    for (const flag of ['id', 'query', 'store', 'marketplace', 'currency', 'country', 'language', 'sku-id', 'shop-id', 'item-id', 'review-url', 'product-url', 'page', 'category-id', 'catalog-page-size']) {
      if (opts[flag] === undefined) continue;
      const value = opts[flag];
      if (typeof value !== 'string' || !value.trim() || value.length > (flag.endsWith('-url') ? 4096 : 256) ||
          /[\x00-\x1f\x7f]/.test(value)) fail('CATALOG_ARGUMENT_INVALID');
      args[argsByFlag[flag] ?? flag] = flag === 'page' ? positive(value, 1, 10_000)
        : flag === 'catalog-page-size' ? positive(value, 24, 48) : value;
    }
    if (opts.csv && (!opts.output || operation !== 'reviews')) fail('CATALOG_CSV_REQUIRES_REVIEW_OUTPUT');
    for (const flag of ['output', 'csv']) if (opts[flag] !== undefined && typeof opts[flag] !== 'string') fail('CATALOG_OUTPUT_INVALID');
    if (opts.csv && path.resolve(opts.csv) === path.resolve(opts.output)) fail('CATALOG_OUTPUT_INVALID');
    if (operation !== 'reviews' && ['page-size', 'max-pages', 'limit'].some(flag => opts[flag] !== undefined)) fail('CATALOG_ARGUMENT_INVALID');
    const pageSize = positive(opts['page-size'], 20, 100), maxPages = positive(opts['max-pages'], 3, 100), maxReviews = positive(opts.limit, 100, 50_000);
    const effectivePageSize = operation === 'reviews' ? effectiveReviewPageSize(provider, pageSize) : null;
    const requestContext = Object.fromEntries(Object.keys(args).sort().map(key => [key,
      key.toLowerCase().endsWith('url') ? createHash('sha256').update(args[key]).digest('hex') : args[key]]));
    requestContext.requestedPageSize = pageSize;
    requestContext.effectivePageSize = effectivePageSize;
    let initialCursor = null, initialSkipIds = [];
    if (opts['resume-input'] !== undefined) {
      if (operation !== 'reviews' || typeof opts['resume-input'] !== 'string') fail('CATALOG_RESUME_INVALID');
      const info = await stat(opts['resume-input']);
      if (!info.isFile() || info.size > 64 * 1024 * 1024) fail('CATALOG_RESUME_INVALID');
      let prior;
      try { prior = JSON.parse(await readFile(opts['resume-input'], 'utf8')); } catch { fail('CATALOG_RESUME_INVALID'); }
      if (prior?.schema !== 'web-api-product-reviews-v1' || prior.provider !== provider || prior.productId !== args.id ||
          JSON.stringify(prior.requestContext) !== JSON.stringify(requestContext) ||
          prior.collection?.sourceExhausted === true || !prior.collection?.continuation ||
          !Object.hasOwn(prior.collection.continuation, 'cursor') || !Array.isArray(prior.collection.continuation.skipReviewIds)) fail('CATALOG_RESUME_INVALID');
      initialCursor = safeReviewCursor(prior.collection.continuation.cursor);
      initialSkipIds = prior.collection.continuation.skipReviewIds;
    }
    if (maxReviews > 200 && !opts.output) fail('CATALOG_OUTPUT_REQUIRED');
    let credentials = {};
    if (opts['credentials-stdin'] !== undefined) {
      if (opts['credentials-stdin'] !== true) fail('CATALOG_CREDENTIAL_INPUT_INVALID');
      const input = await stdinJson(32 * 1024);
      if (input?.provider !== provider || !input || typeof input !== 'object' || Array.isArray(input)) fail('CATALOG_CREDENTIAL_SERVICE_MISMATCH');
      const { provider: ignored, ...values } = input; credentials = values;
    }
    output = await reserveOutput(opts.output); csvOutput = await reserveOutput(opts.csv);
    const reader = await createCatalogReader({ provider, operation, args, credentials });
    const result = operation === 'reviews'
      ? await collectReviews({ provider, productId: args.id, loadPage: cursor => reader.reviewsPage({ ...cursor, pageSize: effectivePageSize }), maxPages, maxReviews, initialCursor, initialSkipIds })
      : await reader.product();
    if (operation === 'reviews') result.requestContext = requestContext;
    if (csvOutput) await csvOutput.writeFile(reviewsCsv(result));
    if (output) {
      await output.writeFile(JSON.stringify(result, null, 2) + '\n');
      await report({ ok: true, provider, operation, requestedId: args.id, collection: result.collection ?? null,
        executionMode: result.executionMode, browserUsed: false, credentialsUsed: result.credentialsUsed,
        output: path.resolve(opts.output), csv: opts.csv ? path.resolve(opts.csv) : null });
    } else await report(result);
  }
} catch (error) {
  const result = { ok: false, code: safeError(error) };
  if (output) await output.writeFile(JSON.stringify(result) + '\n');
  await report(result); process.exitCode = 1;
} finally { await Promise.all([output?.close(), csvOutput?.close()]); }
