#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { options, reserveOutput, report, safeError } from '../lib/cli.mjs';
import { createSheinPublicClient } from '../lib/retail/shein.mjs';
import { createOverseasSitemapClient } from '../lib/retail/overseas-sitemaps.mjs';

const supported = {
  aliexpress: ['sitemap-index', 'sitemap-products'],
  iherb: ['sitemap-index', 'sitemap-products'],
  shein: ['home'],
  temu: [],
};
let output;
try {
  const [service, operation, ...args] = process.argv.slice(2);
  if (service === 'status' && operation === undefined) {
    const scope = JSON.parse(await readFile(new URL('../references/overseas-retail-frontier.json', import.meta.url), 'utf8'));
    await report({ schema: 'web-api-overseas-retail-status-v1', networkUsed: false, supported,
      observationTime: scope.checkedAt, services: scope.services });
  } else if (!Object.hasOwn(supported, service) || !supported[service].includes(operation)) {
    await report({ ok: false, code: 'OVERSEAS_OPERATION_UNVERIFIED', networkUsed: false, supported });
    process.exitCode = 2;
  } else {
    const opts = options(args, ['output', ...(operation === 'sitemap-products' ? ['shard-index', 'offset', 'limit', 'snapshot-sha'] : [])]);
    if (opts.output !== undefined && typeof opts.output !== 'string') throw Object.assign(new Error(), { code: 'ARGUMENT_INVALID' });
    const integer = (key, fallback, max, min = 0) => {
      if (opts[key] === undefined) return fallback;
      if (typeof opts[key] !== 'string' || !/^(0|[1-9]\d*)$/.test(opts[key]) || Number(opts[key]) > max || Number(opts[key]) < min)
        throw Object.assign(new Error(), { code: 'ARGUMENT_INVALID' });
      return Number(opts[key]);
    };
    const shardIndex = integer('shard-index', 0, 100_000);
    const offset = integer('offset', 0, 1_000_000);
    const limit = integer('limit', 100, 1000, 1);
    if (opts['snapshot-sha'] !== undefined && !/^[a-f0-9]{64}$/.test(opts['snapshot-sha'])
      || offset > 0 && opts['snapshot-sha'] === undefined) throw Object.assign(new Error(), { code: 'SNAPSHOT_REQUIRED_FOR_RESUME' });
    output = await reserveOutput(opts.output);
    let data;
    let requests;
    if (service === 'shein') {
      data = await createSheinPublicClient().getHomeCatalog();
      requests = [data.receipt];
    } else {
      const client = createOverseasSitemapClient(service);
      const shards = await client.listShards();
      if (!shards.length) throw Object.assign(new Error(), { code: 'SITEMAP_INDEX_EMPTY' });
      if (operation === 'sitemap-index') data = { shards, completeCatalog: false };
      else {
        if (!shards[shardIndex]) throw Object.assign(new Error(), { code: 'SHARD_INDEX_INVALID' });
        data = await client.listProductsPage(shards[shardIndex].path, { offset, limit, expectedSnapshotSha256: opts['snapshot-sha'] });
        data.frontier = { totalShards: shards.length, selectedShardIndex: shardIndex,
          next: data.nextOffset === null
            ? shardIndex + 1 < shards.length ? { shardIndex: shardIndex + 1, offset: 0 } : null
            : { shardIndex, offset: data.nextOffset, snapshotSha256: data.snapshotSha256 },
          priorShardsVerifiedByThisRun: false };
      }
      requests = client.getReceipts();
    }
    await report({ schema: 'web-api-overseas-retail-result-v1', ok: true, service, operation,
      checkedAt: new Date().toISOString(), executionMode: 'pure_http', anonymous: true,
      credentialsUsed: false, browserUsed: false, writesSubmitted: 0, data, requests,
      fiveStates: { captured: false, client_exists: true, remnant_free: true,
        credential_propagated: 'not_applicable_anonymous', live_replay: true },
      note: 'Current direct HTTP execution. Browser network capture is not asserted; sitemap identities are not priced offers.' }, output);
  }
} catch (error) {
  await report({ ok: false, code: safeError(error), ...(error?.receipt ? { receipt: error.receipt } : {}) }, output);
  process.exitCode = 1;
} finally { await output?.close(); }
