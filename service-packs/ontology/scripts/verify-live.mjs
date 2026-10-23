#!/usr/bin/env node
// Bounded read-only verification. Output deliberately contains no response bodies or runtime context.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectPublicNotices, noticeCollectionCanExitZero } from '../src/rental-housing/public-notices.mjs';
import { collectLive } from '../src/travel-price/collect-live.mjs';

const outArg = process.argv.slice(2).find(arg => arg.startsWith('--out='));
if (process.argv.slice(2).some(arg => !arg.startsWith('--out='))) throw new Error('ARGUMENT_INVALID');
const target = path.resolve(outArg?.slice(6) || 'work/live-verification.json');
const states = live => ({
  captured: false,
  client_exists: true,
  remnant_free: true,
  remnant_free_scope: 'recurring_http_without_browser_engine',
  credential_propagated: 'not_applicable_anonymous',
  live_replay: live,
});
const safeCode = error => /^[A-Z0-9_:-]{1,80}$/.test(error?.code ?? '') ? error.code : 'READ_FAILED';
const operations = {};

try {
  const notices = await collectPublicNotices({ limit: 12, maxPages: 1, detailLimit: 1 });
  for (const [source, result] of Object.entries(notices.sources)) {
    const receipt = result.receipt;
    operations[source] = {
      status: receipt.status,
      count: result.items.length,
      error: receipt.error ?? null,
      registeredBlocked: receipt.registeredBlocked === true,
      ...states(receipt.ok === true && result.items.length > 0),
    };
  }
  operations.publicNotices = { ok: noticeCollectionCanExitZero(notices), snapshotComplete: notices.snapshotComplete };
} catch (error) {
  operations.publicNotices = { ok: false, error: safeCode(error) };
}

try {
  const result = await collectLive('yanolja-search', ['강릉']);
  operations['yanolja-search'] = {
    status: result.receipt.status,
    httpStatus: result.receipt.response.status,
    counts: result.receipt.counts,
    observedResultContext: result.receipt.observedResultContext,
    coverage: result.receipt.coverage,
    challengeScan: result.receipt.challengeScan,
    ...states(result.items.length > 0 && result.receipt.response.status === 200),
  };
} catch (error) {
  operations['yanolja-search'] = { error: safeCode(error), ...states(false) };
}

try {
  const result = await collectLive('modetour-packages', ['다낭']);
  operations['modetour-packages'] = {
    verdict: result.verdict,
    recommendationCount: result.recommendationCount ?? 0,
    productCount: result.products?.length ?? 0,
    detailCount: result.products?.filter(product => product.detailReadStatus === 'live_detail_read').length ?? 0,
    requestCount: result.requestCount,
    requests: result.requests.map(row => ({ method: row.method, origin: row.origin, pathname: row.pathname, status: row.status })),
    contractSourceObserved: result.contractSourceObserved === true,
    anonymousSdkContextPropagated: result.fiveStates.anonymous_sdk_context_propagated === true,
    ...states(result.fiveStates.live_replay === true),
  };
} catch (error) {
  operations['modetour-packages'] = { error: safeCode(error), ...states(false) };
}

const ok = operations.publicNotices.ok === true && operations['yanolja-search'].live_replay === true
  && operations['modetour-packages'].live_replay === true;
const receipt = {
  schemaVersion: 1, checkedAt: new Date().toISOString(), verifier: 'scripts/verify-live.mjs',
  ok, operations, writesSubmitted: 0, browserUsed: false, accountCredentialsPersisted: false,
  scope: 'Policy and SH one page/one detail, NOL first keyword page, Mode recommendation feed/one matching detail; no exhaustive coverage',
};
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok, out: target, operations }));
if (!ok) process.exitCode = 1;
