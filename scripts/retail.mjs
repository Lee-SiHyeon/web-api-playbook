#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { options, reserveOutput, report, safeError } from '../lib/cli.mjs';
import { createAliExpressPublicClient } from '../lib/retail/aliexpress.mjs';
import { createEbayPublicClient } from '../lib/retail/ebay.mjs';
import { createAllbirdsPublicClient } from '../lib/retail/shopify.mjs';
import { createAmazonPublicClient } from '../lib/retail/amazon.mjs';
import { createAmazonNavigationClient } from '../lib/retail/amazon-navigation.mjs';
import { crawlAmazonSearch } from '../lib/retail/amazon-crawl.mjs';
import { getAmazonProduct } from '../lib/retail/amazon-retail-session.mjs';

const services = ['aliexpress', 'amazon', 'ebay', 'walmart', 'shopify'];
const supported = { aliexpress: ['product-seo'], ebay: ['suggest'], shopify: ['product', 'predictive-search'], amazon: ['search', 'navigation', 'crawl', 'product'], walmart: [] };
let output;
try {
  const [service, operation, ...args] = process.argv.slice(2);
  if (service === 'status' && operation === undefined) {
    const manifests = await Promise.all(services.map(async name => {
      const manifest = JSON.parse(await readFile(fileURLToPath(new URL(`../checklists/services/${name}.json`, import.meta.url)), 'utf8'));
      return { service: name, supportedOperations: supported[name],
        capabilities: manifest.capabilities.filter(cap => cap.applicability === 'applicable').map(cap => ({
          id: cap.id, title: cap.title, ...(cap.blocker ? { blocker: cap.blocker } : {}),
        })) };
    }));
    await report({ schema: 'web-api-retail-status-v1', networkUsed: false, services: manifests });
  } else {
    if (!services.includes(service) || !operation) throw Object.assign(new Error(), { code: 'RETAIL_ARGUMENT_INVALID' });
    if (!supported[service].includes(operation)) {
      await report({ ok: false, service, operation, code: 'RETAIL_OPERATION_UNVERIFIED',
        supportedOperations: supported[service], networkUsed: false,
        checklist: `checklists/services/${service}.json` });
      process.exitCode = 2;
    } else {
      const flags = service === 'aliexpress' ? ['product-id', 'subject', 'output']
        : service === 'amazon' ? operation === 'navigation' ? ['output'] : operation === 'product' ? ['asin','output'] : operation === 'crawl'
          ? ['query', 'max-pages', 'checkpoint', 'output'] : ['query', 'page', 'output']
        : service === 'ebay' ? ['query', 'output']
          : operation === 'product' ? ['handle', 'output'] : ['query', 'limit', 'output'];
      const opts = options(args, flags);
      if (opts.output !== undefined && typeof opts.output !== 'string') throw Object.assign(new Error(), { code: 'RETAIL_ARGUMENT_INVALID' });
      output = await reserveOutput(opts.output);
      let data;
      if (service === 'aliexpress') data = await createAliExpressPublicClient().getProductSeo({ productId: opts['product-id'], subject: opts.subject });
      else if (service === 'ebay') data = await createEbayPublicClient().suggestCatalogHints({ query: opts.query });
      else if (service === 'amazon') {
        if (operation === 'product') data = await getAmazonProduct({ asin: opts.asin });
        else if (operation === 'navigation') data = await createAmazonNavigationClient().getNavigation();
        else if (operation === 'crawl') {
          if (opts['max-pages'] !== undefined && !/^[1-5]$/.test(opts['max-pages'])) throw Object.assign(new Error(), { code: 'RETAIL_ARGUMENT_INVALID' });
          let checkpoint = null;
          if (opts.checkpoint !== undefined) {
            if (typeof opts.checkpoint !== 'string') throw Object.assign(new Error(), { code: 'RETAIL_ARGUMENT_INVALID' });
            const saved = JSON.parse(await readFile(opts.checkpoint, 'utf8'));
            checkpoint = saved?.data?.checkpoint ?? saved;
          }
          data = await crawlAmazonSearch({ query: opts.query, maxPages: Number(opts['max-pages'] ?? 3), checkpoint });
          if (data.failure) process.exitCode = 2;
        } else {
          if (opts.page !== undefined && (typeof opts.page !== 'string' || !/^(?:[1-9]|1[0-9]|20)$/.test(opts.page))) {
            throw Object.assign(new Error(), { code: 'RETAIL_ARGUMENT_INVALID' });
          }
          data = await createAmazonPublicClient().searchProducts({ query: opts.query, page: opts.page === undefined ? 1 : Number(opts.page) });
        }
      }
      else if (operation === 'product') data = await createAllbirdsPublicClient().getProduct({ handle: opts.handle });
      else {
        if (opts.limit !== undefined && (typeof opts.limit !== 'string' || !/^(?:[1-9]|10)$/.test(opts.limit))) {
          throw Object.assign(new Error(), { code: 'RETAIL_ARGUMENT_INVALID' });
        }
        data = await createAllbirdsPublicClient().searchProducts({ query: opts.query,
          ...(opts.limit === undefined ? {} : { limit: Number(opts.limit) }) });
      }
      await report({ schema: 'web-api-retail-result-v1', ok: !data.failure, service, operation,
        executionMode: 'pure_http', anonymous: !data.receipt?.credentialsUsed,
        credentialsUsed: Boolean(data.receipt?.credentialsUsed), browserUsed: false, data }, output);
    }
  }
} catch (error) {
  await report({ ok: false, code: safeError(error), ...(error?.receipt ? { receipt: error.receipt } : {}) }, output);
  process.exitCode = 1;
} finally { await output?.close(); }
