import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCoupangVisitorContext } from '../service-packs/affiliate/apps/affiliate-api-hub/lib/coupang-visitor-context.mjs';
import { readCoupangConsumerOfferList } from '../service-packs/affiliate/apps/affiliate-api-hub/adapters/coupang-consumer.mjs';
import { readCoupangRetailSearch, readCoupangDocument } from '../lib/retail/coupang-public.mjs';

const args = process.argv.slice(2), out = args.find(x => x.startsWith('--out='))?.slice(6);
if (args.length !== 1 || !out) throw new Error('USAGE_coupang-retail-visitor-check_--out=NEW_FILE');
const visitorContext = createCoupangVisitorContext({ allowRebootstrap: false });
const options = { authentication: 'visitor', visitorContext };
const productUrl = 'https://www.coupang.com/vp/products/6247736560?itemId=12646874013&vendorItemId=79914317500';
const probes = [
  ['offer_list', () => readCoupangConsumerOfferList({ ...options, url: productUrl })],
  ['retail_search_document', () => readCoupangRetailSearch('무선 마우스', { ...options, sorter: 'salePriceAsc', freeDelivery: true })],
  ['retail_category_document', () => readCoupangDocument('https://www.coupang.com/np/categories/178255?page=2', options)],
];
const report = { schema: 'coupang-retail-visitor-check-v1', checkedAt: new Date().toISOString(), executionMode: 'pure_http',
  browserUsed: false, ownerCredentialUsed: false, visitorValuesPersisted: false, visitorContextCount: 1,
  rebootstrapAllowed: false, writesSubmitted: 0, productUrl, runs: [], deferred: [], complete: false };
for (const [operation, run] of probes) {
  try {
    const result = await run();
    report.runs.push({ operation, ok: true, ...result });
  } catch (error) {
    const receipt = error.receipt ?? null;
    report.runs.push({ operation, ok: false, code: /^COUPANG_[A-Z_0-9]+$/.test(error.code ?? '') ? error.code : 'COUPANG_CLIENT_FAILED', receipt });
    report.deferred = probes.slice(report.runs.length).map(([next]) => ({ operation: next, reason: 'prior_probe_failed_no_retry_or_identity_rotation' }));
    break;
  }
}
report.complete = report.runs.length === probes.length && report.runs.every(x => x.ok);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output: out, complete: report.complete, runs: report.runs.map(run => {
  const receipt = run.receipt ?? run.request;
  return { operation: run.operation, ok: run.ok, code: run.code, status: receipt?.status ?? receipt?.httpStatus,
    count: run.count ?? run.data?.products?.length, bootstrapStatus: receipt?.visitorBootstrap?.status ?? null,
    visitorCookiesSent: receipt?.visitorCookiesSent ?? receipt?.cookieSent ?? false };
}), deferred: report.deferred }));
if (!report.complete) process.exitCode = 2;
