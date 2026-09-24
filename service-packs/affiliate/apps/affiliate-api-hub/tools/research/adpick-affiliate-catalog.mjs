// Public catalog read discovered in campaignShoppingMall.js on 2026-09-21.
// This does not enroll a publisher, generate tracking links, or prove payout eligibility.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out') {
  throw new Error('Usage: node tools/research/adpick-affiliate-catalog.mjs --out <public-json-path>');
}
const url = 'https://www.adpick.co.kr/apis/shopping.php?md=mall_list&order=starttime&search_value=';
const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
const body = await response.text();
if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('Unexpected catalog size');
const data = JSON.parse(body);
if (!Array.isArray(data.list) || !data.list.length) throw new Error('Missing catalog list');
const hash = value => createHash('sha256').update(value).digest('hex');
const seen = new Set();
const merchants = data.list.map(item => {
  if (typeof item.offer !== 'string' || seen.has(item.offer) || typeof item.apptitle !== 'string'
      || typeof item.domain !== 'string' || !Number.isFinite(Number(item.commission_per))) {
    throw new Error('Unexpected or duplicate merchant record');
  }
  seen.add(item.offer);
  return {
    offerId: item.offer,
    name: item.apptitle,
    domain: item.domain,
    category: item.mall_category_name,
    headlineCommissionPct: Number(item.commission_per),
    secondHeadlineCommissionPct: Number(item.commission_per2),
    displayedAttributionWindow: item.return_day_desc,
    displayedConfirmationTiming: item.fix_desc,
    sourceStatusCode: item.status,
    sourceOpenCode: item.open,
    termsSha256: hash(`${item.non_payment_desc || ''}\n${item.service_policy_desc || ''}`),
    detailUrl: `https://www.adpick.co.kr/?ac=offer&tac=shopping&md=mall_detail&offer=${encodeURIComponent(item.offer)}`,
  };
});
const result = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  host: hostname(),
  scope: 'Public shopping affiliate merchant catalog; not account approval or link generation',
  discovery: {
    page: 'https://www.adpick.co.kr/?ac=offer&tac=mall',
    script: 'https://www.adpick.co.kr/res/vue/dist/campaignShoppingMall.js?t=20260917@scrollbar10',
    evidence: 'Frontend axios GET call followed by independent Node HTTP replay; no browser network capture',
  },
  execution: { mode: 'pure_http', browserUsed: false, credentialsUsed: false },
  verification: {
    captured: 'request_shape_observed_in_public_frontend_source',
    client_exists: true,
    clientScope: 'this public catalog read only',
    remnant_free: true,
    remnantFreeScope: 'complete recurring public catalog read',
    credential_propagated: 'not_applicable_public_read',
    live_replay: true,
    authenticatedLinkGeneration: 'not_verified',
  },
  receipt: {
    method: 'GET', url, httpStatus: response.status,
    contentType: response.headers.get('content-type'),
    responseBytes: Buffer.byteLength(body), responseSha256: hash(body),
    responseKeys: Object.keys(data), count: merchants.length,
  },
  caveats: [
    'Headline rates and window labels are summaries; category, device and exclusion rules can override them.',
    'Source status codes are retained without guessing their semantics.',
    'A catalog listing does not prove approval of this publisher, a specific product, or a promotional channel.',
    'Use the maintained research report for observed detailed exceptions; refresh terms before publishing.',
  ],
  merchants,
};
const output = resolve(args[1]);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: true, count: merchants.length, checkedAt: result.checkedAt, output }));
