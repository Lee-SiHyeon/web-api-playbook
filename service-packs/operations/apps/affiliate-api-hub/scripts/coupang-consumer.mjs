import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CoupangConsumerError, readCoupangConsumerProduct, readCoupangConsumerReviews,
  readCoupangConsumerProfile, readCoupangConsumerOffer, readCoupangConsumerSellers, readCoupangConsumerOfferList,
} from '../adapters/coupang-consumer.mjs';
import { readCoupangConsumerWowPrice } from '../adapters/coupang-wow-prices.mjs';

const operations = { product: readCoupangConsumerProfile, reviews: readCoupangConsumerReviews,
  quantity: readCoupangConsumerOffer, sellers: readCoupangConsumerSellers, offers: readCoupangConsumerOfferList,
  document: readCoupangConsumerProduct, wow: readCoupangConsumerWowPrice };

const args = process.argv.slice(2), operation = args[0];
const flags = args.slice(1), write = flags.includes('--write');
let output;
try {
  const matches = name => flags.filter(flag => flag.startsWith(`--${name}=`));
  if (!Object.hasOwn(operations, operation) || flags.some(flag => !['--write', '--anonymous', '--visitor', '--protected'].includes(flag) && !/^--(?:url|page|sort)=/.test(flag))
    || matches('url').length !== 1 || ['url', 'page', 'sort'].some(name => matches(name).length > 1)
    || flags.filter(flag => flag === '--write').length > 1
    || flags.filter(flag => ['--anonymous', '--visitor', '--protected'].includes(flag)).length > 1
    || operation === 'wow' && flags.some(flag => ['--anonymous', '--visitor', '--protected'].includes(flag))
    || operation !== 'reviews' && (matches('page').length || matches('sort').length))
    throw new CoupangConsumerError('USAGE_COUPANG_CONSUMER_PRODUCT_REVIEWS_QUANTITY_SELLERS_OFFERS_DOCUMENT_URL');
  const options = { url: matches('url')[0].slice(6), authentication: flags.includes('--protected') ? 'protected'
    : flags.includes('--anonymous') ? 'anonymous' : flags.includes('--visitor') || ['product', 'reviews', 'sellers', 'offers'].includes(operation)
      ? 'visitor' : 'anonymous' };
  if (matches('page').length) options.page = Number(matches('page')[0].slice(7));
  if (matches('sort').length) options.sort = matches('sort')[0].slice(7);
  const result = await operations[operation](options);
  output = { schemaVersion: 1, ok: true, checkedAt: result.receipt.checkedAt, operation, execution: 'pure_http', browserUsed: false, ...result };
  if (output.ok === false) process.exitCode = 2;
} catch (error) {
  output = { schemaVersion: 1, ok: false, checkedAt: new Date().toISOString(),
    operation: Object.hasOwn(operations, operation) ? operation : null,
    code: error instanceof CoupangConsumerError ? error.code : 'COUPANG_CONSUMER_FAILED',
    execution: 'pure_http', browserUsed: false, receipt: error instanceof CoupangConsumerError ? error.receipt : null,
    states: { captured: true, client_exists: true, remnant_free: true, credential_propagated: error.receipt?.credentialPropagated === true, live_replay: false } };
  process.exitCode = 2;
}
if (write && output.receipt) {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = path.join(root, 'runs', `coupang-consumer-${output.checkedAt.replace(/[:.]/g, '-')}`);
  await mkdir(directory, { recursive: true });
  const outputFile = path.join(directory, `${operation}.json`);
  await writeFile(outputFile, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  output.outputFile = outputFile;
}
console.log(JSON.stringify(output, null, 2));
