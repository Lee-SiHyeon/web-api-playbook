import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLICK_LINK, MERCHANTS, SITES } from '../scripts/linkprice-links.mjs';
import { createLinkpriceIssuer, defaultLinkBuilder, resolveMerchant } from '../scripts/linkprice-issue.mjs';

const snapshotHash = 'a'.repeat(64);
const snapshot = {
  sha256: snapshotHash,
  records: [
    { id: 'linkprice:demo', type: 'AffiliateProgram', merchantId: 'demo', name: 'Demo shop', siteUrl: 'https://shop.example.com/' },
    { id: 'offering:with-url', type: 'CommercialOffering', canonicalUrl: 'https://shop.example.com/item?productId=31' },
    { id: 'offering:no-url', type: 'CommercialOffering', title: 'Missing URL', canonicalUrl: null },
  ],
};
const tempLedger = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'linkprice-issue-')), 'issued-links.jsonl');

function issuer({ ledgerPath = tempLedger(), catalog = [{ merchant_id: 'demo', site_name: 'Demo shop', site_url: 'https://shop.example.com/' }],
  statusFor = () => 'APR', snapshotData = snapshot, buildLink = defaultLinkBuilder, getApproval = async id => ({ id, kind: 'linkprice-links', status: 'approved' }),
  getCatalog, getSubscriptions } = {}) {
  return createLinkpriceIssuer({
    ledgerPath,
    getSnapshot: async () => snapshotData,
    getApproval,
    getCatalog: getCatalog ?? (async () => catalog),
    getSubscriptions: getSubscriptions ?? (async ({ affiliateId, merchantIds }) => merchantIds.map(merchantId => ({
      affiliateId, merchantId, status: statusFor(affiliateId, merchantId),
    }))),
    buildLink,
    now: () => '2026-09-28T03:00:00.000Z',
  });
}

test('APR subscriptions build one verified link per channel using each channel site id', async () => {
  const result = await issuer().check({ url: 'https://shop.example.com/item?productId=31' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.channels.map(row => [row.channel, row.affiliateId]), Object.entries(SITES));
  assert.ok(result.channels.every(row => row.subscriptionStatus === 'APR' && row.reason === null));
  assert.ok(result.channels.every(row => {
    const match = CLICK_LINK.exec(row.link);
    return match && match[1] === 'demo' && match[2] === row.affiliateId && decodeURIComponent(match[3]) === result.canonicalUrl;
  }));
});

test('non-APR status is returned verbatim with a refusal reason', async () => {
  const result = await issuer({ statusFor: affiliateId => affiliateId === SITES.naver ? 'REQ' : 'APR' })
    .check({ url: 'https://shop.example.com/item?productId=31', channels: ['naver'] });
  assert.equal(result.ok, false);
  assert.equal(result.channels[0].subscriptionStatus, 'REQ');
  assert.equal(result.channels[0].reason, 'MERCHANT_NOT_APPROVED');
  assert.equal(result.channels[0].link, null);
});

test('ambiguous and unknown hosts are refused', async () => {
  const ambiguous = issuer({ catalog: [
    { merchant_id: 'first', site_url: 'https://shop.example.com/' },
    { merchant_id: 'second', site_url: 'https://shop.example.com/' },
  ] });
  const ambiguousResult = await ambiguous.check({ url: 'https://shop.example.com/item' });
  assert.equal(ambiguousResult.channels[0].reason, 'MERCHANT_HOST_AMBIGUOUS');

  const unknownResult = await issuer().check({ url: 'https://elsewhere.invalid/item' });
  assert.equal(unknownResult.channels[0].reason, 'MERCHANT_HOST_UNKNOWN');
  assert.equal(resolveMerchant('https://www.lotteon.com/item/1', MERCHANTS).merchant.merchantId, 'lotteon');
});

test('tracking parameters are removed, product identifiers remain, and link tu round-trips', async () => {
  const result = await issuer().check({ url: 'https://shop.example.com/item?productId=31&n_product_id=32&utm_source=news&fbclid=click&gclid=ad&n_media=blog&color=blue#reviews', channels: ['tistory'] });
  assert.equal(result.canonicalUrl, 'https://shop.example.com/item?productId=31&n_product_id=32&color=blue');
  const link = result.channels[0].link;
  const match = CLICK_LINK.exec(link);
  assert.ok(match);
  assert.equal(decodeURIComponent(match[3]), result.canonicalUrl);
});

test('HTTP is accepted only when the matched merchant is HTTP-only in the catalog', async () => {
  const httpCatalog = [{ merchant_id: 'demo', site_name: 'Demo shop', site_url: 'http://shop.example.com/' }];
  const httpSnapshot = { ...snapshot, records: [
    { id: 'linkprice:demo', type: 'AffiliateProgram', merchantId: 'demo', name: 'Demo shop', siteUrl: 'http://shop.example.com/' },
  ] };
  const allowed = await issuer({ catalog: httpCatalog, snapshotData: httpSnapshot })
    .check({ url: 'http://shop.example.com/item?id=31', channels: ['naver'] });
  assert.equal(allowed.channels[0].reason, null);
  assert.equal(decodeURIComponent(CLICK_LINK.exec(allowed.channels[0].link)[3]), 'http://shop.example.com/item?id=31');

  const refused = await issuer().check({ url: 'http://shop.example.com/item?id=31', channels: ['naver'] });
  assert.equal(refused.channels[0].reason, 'HTTPS_REQUIRED');
});

test('issue ledger is idempotent and dry-run never creates a ledger file', async () => {
  const ledgerPath = tempLedger();
  const tool = issuer({ ledgerPath });
  const first = await tool.issue({ url: 'https://shop.example.com/item?productId=31&utm_medium=post', channels: ['naver', 'tistory'], approval: 'a1b2c3d4e5f60718' });
  assert.equal(first.written, 2);
  assert.equal(first.issued.length, 2);
  const repeated = await tool.issue({ url: 'https://shop.example.com/item?productId=31', channels: ['naver', 'tistory'], approval: 'a1b2c3d4e5f60718' });
  assert.equal(repeated.written, 0);
  assert.ok(repeated.issued.every(item => item.existing));
  assert.equal(tool.ledger().count, 2);
  assert.equal(tool.ledger({ channel: 'naver', merchant: 'demo' }).count, 1);
  const ledgerRows = readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(ledgerRows.map(row => Object.keys(row).sort()), Array.from({ length: 2 }, () =>
    ['affiliateId', 'approvalId', 'canonicalUrl', 'catalogSnapshotSha256', 'channel', 'issuedAt', 'link', 'merchantId', 'source', 'subscriptionStatus', 'url'].sort()));

  const dryPath = tempLedger();
  const dry = await issuer({ ledgerPath: dryPath }).issue({ url: 'https://shop.example.com/item?productId=31', channels: ['naver'], approval: 'a1b2c3d4e5f60718', dryRun: true });
  assert.equal(dry.written, 0);
  assert.equal(existsSync(dryPath), false);
});

test('issue requires an approval id before any catalog read', async () => {
  let catalogCalls = 0;
  const tool = issuer({ getCatalog: async () => { catalogCalls++; return []; } });
  await assert.rejects(() => tool.issue({ url: 'https://shop.example.com/item?productId=31' }), { code: 'APPROVAL_REQUIRED' });
  assert.equal(catalogCalls, 0);
});

test('issue refuses an id that is not an approved LinkPrice Telegram request', async () => {
  const tool = issuer({ getApproval: async id => ({ id, kind: 'linkprice-links', status: 'pending' }) });
  await assert.rejects(() => tool.issue({ url: 'https://shop.example.com/item?productId=31', approval: 'a1b2c3d4e5f60718' }),
    { code: 'APPROVAL_NOT_APPROVED' });
});

test('from-offering refuses offerings with a null canonical URL', async () => {
  const tool = issuer({ getCatalog: async () => { throw new Error('catalog must not be read'); } });
  const result = await tool.fromOffering({ offering: 'offering:no-url' });
  assert.deepEqual(result, { ok: false, offering: 'offering:no-url', reason: 'CANONICAL_URL_MISSING', title: 'Missing URL' });
});

test('local click URL builder accepts only registered site ids and absolute credential-free targets', async () => {
  const link = await defaultLinkBuilder({ merchantId: 'demo', affiliateId: SITES.naver, targetUrl: 'https://shop.example.com/item?id=31' });
  assert.ok(CLICK_LINK.test(link));
  await assert.rejects(() => defaultLinkBuilder({ merchantId: 'demo', affiliateId: 'A999999999', targetUrl: 'https://shop.example.com/' }),
    { code: 'LINKPRICE_AFFILIATE_ID_INVALID' });
  await assert.rejects(() => defaultLinkBuilder({ merchantId: 'demo', affiliateId: SITES.naver, targetUrl: 'https://user:secret@shop.example.com/' }),
    { code: 'LINK_TARGET_INVALID' });
});
