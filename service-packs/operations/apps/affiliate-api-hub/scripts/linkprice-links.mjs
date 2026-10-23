// LinkPrice (링크프라이스) CPS links for one article brief (owner 2026-09-27: "온톨로지 작업 모두 적용해" — LinkPrice links
// in the publishing flow, created only after the owner's Telegram approval, as with 마이리얼트립 links).
// Usage: node linkprice-links.mjs --brief=<brief dir> [--dry-run]     build <brief>/linkprice-links.json
//        node linkprice-links.mjs --brief=<brief dir> --request      send the "🔗 링크 만들기" approval to Telegram
//
// Any unambiguous active CPS merchant domain can be resolved from the live LinkPrice catalog. Product pages become
// click.linkprice.com links for the Naver blog site (A100708014) via web-auth.mjs linkprice link (which refuses
// unapproved merchants). The link is built locally; nothing is clicked at the merchant. Mirror converters apply each
// channel's registered LinkPrice site id and disclosure rules.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = code => { throw Object.assign(new Error(code), { code }); };
export const SITES = Object.freeze({ naver: 'A100708014', tistory: 'A100708029', daangn: 'A100708123', naverCafe: 'A100708124' });
// Merchant ids by product host. Only merchants approved (APR) on both sites on 2026-09-27; 11번가 is not applied.
export const MERCHANTS = Object.freeze([
  { merchantId: 'lotteon', label: '롯데ON', host: /(^|\.)lotteon\.com$/ },
  { merchantId: 'gmarket', label: 'G마켓', host: /(^|\.)gmarket\.co\.kr$/ },
  { merchantId: 'auction', label: '옥션', host: /(^|\.)auction\.co\.kr$/ },
  { merchantId: 'myrealtrip', label: '마이리얼트립', host: /(^|\.)myrealtrip\.com$/ },
  { merchantId: 'klook', label: '클룩', host: /(^|\.)klook\.com$/ },
  { merchantId: 'agoda', label: '아고다', host: /(^|\.)agoda\.com$/ },
]);
export const DISCLOSURE = '이 포스팅은 링크프라이스 제휴 활동의 일환으로 판매 발생 시 수수료를 제공받습니다.';
export const CLICK_LINK = /^https:\/\/click\.linkprice\.com\/click\.php\?m=([a-z0-9_]+)&a=(A\d{6,12})&l=9999&l_cd1=3&l_cd2=0&tu=(https?%3A%2F%2F[^&\s]+)$/;

function hostOf(value) {
  try { return new URL(/^https?:\/\//i.test(String(value)) ? String(value) : `https://${value}`).hostname.toLowerCase(); }
  catch { return null; }
}
function hostMatches(targetHost, merchantHost) {
  const target = targetHost.replace(/^www\./, '');
  const merchant = merchantHost.replace(/^www\./, '');
  return target === merchant || target.endsWith(`.${merchant}`);
}
export function merchantFor(url, merchants = MERCHANTS) {
  const targetHost = hostOf(url);
  if (!targetHost) return null;
  const hasLiveCatalog = merchants.some(m => (m.merchantId ?? m.merchant_id) && (m.site_url ?? m.siteUrl));
  // Keep established merchant-specific overrides where LinkPrice advertises more than one program per domain.
  const fixed = MERCHANTS.filter(m => m.host.test(targetHost));
  if (fixed.length === 1) return !hasLiveCatalog || merchants.some(m => (m.merchantId ?? m.merchant_id) === fixed[0].merchantId) ? fixed[0] : null;
  if (fixed.length > 1) return null;
  const matches = merchants.map(m => {
    const host = m.host instanceof RegExp ? null : hostOf(m.site_url ?? m.siteUrl ?? m.host);
    const id = m.merchantId ?? m.merchant_id;
    if (!host || !id || !hostMatches(targetHost, host)) return null;
    return { merchantId: id, label: m.label ?? m.site_name ?? id, hostLength: host.length };
  }).filter(Boolean);
  if (!matches.length) return null;
  const longest = Math.max(...matches.map(m => m.hostLength));
  const best = [...new Map(matches.filter(m => m.hostLength === longest).map(m => [m.merchantId, m])).values()];
  return best.length === 1 ? { merchantId: best[0].merchantId, label: best[0].label, host: targetHost } : null;
}
// The same link for the Tistory site: only the a= site id changes (LinkPrice counts sales per registered site).
export function tistoryLink(url) {
  const m = CLICK_LINK.exec(String(url));
  if (!m || m[2] !== SITES.naver) return null;
  return url.replace(`&a=${SITES.naver}&`, `&a=${SITES.tistory}&`);
}
// Product pages in a brief that an approved merchant sells (grocery offers, event URLs).
export function linkableProducts(brief) {
  return linkableProductsForMerchants(brief, MERCHANTS);
}
export function linkableProductsForMerchants(brief, merchants) {
  const urls = new Set([...(brief?.evidence?.urls || []), ...(brief?.mustVerify || []).map(s => String(s).split(' ')[0])]);
  return [...urls].map(url => ({ url, merchant: merchantFor(url, merchants) })).filter(x => x.merchant).map(x => ({ url: x.url, merchantId: x.merchant.merchantId, label: x.merchant.label }));
}

function webAuth(command, input, arg) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(HUB, 'scripts', 'web-auth.mjs'), 'linkprice', command, ...(arg ? [arg] : [])], { cwd: HUB, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ ok: false, code: 'WEB_AUTH_OUTPUT' }); } });
    child.on('error', () => resolve({ ok: false, code: 'WEB_AUTH_SPAWN' }));
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}
const webAuthLink = input => webAuth('link', input);
async function currentCpsMerchants() {
  const result = await webAuth('merchants', undefined, 'cps');
  if (!result.ok || !Array.isArray(result.merchants)) throw Object.assign(new Error(result.code ?? 'LINKPRICE_CATALOG_FAILED'), { code: result.code ?? 'LINKPRICE_CATALOG_FAILED' });
  return result.merchants;
}

export async function buildLinks(briefDir, { dryRun = false, link = webAuthLink, merchants } = {}) {
  const brief = JSON.parse(readFileSync(path.join(briefDir, 'article-brief.json'), 'utf8'));
  const file = path.join(briefDir, 'linkprice-links.json');
  const store = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { schemaVersion: 1, network: 'linkprice', affiliateId: SITES.naver, disclosure: DISCLOSURE, links: {} };
  // Test/local link providers keep the prior static registry unless a catalog was supplied explicitly.
  const catalog = merchants ?? (link === webAuthLink ? await currentCpsMerchants() : MERCHANTS);
  const products = linkableProductsForMerchants(brief, catalog);
  if (dryRun) return { ok: true, dryRun: true, products, existing: Object.keys(store.links).length };
  const made = [], failed = [];
  for (const p of products) {
    if (store.links[p.url]) continue;
    const r = await link({ affiliateId: SITES.naver, merchantId: p.merchantId, targetUrl: p.url });
    if (r.ok && CLICK_LINK.test(r.url || '') && CLICK_LINK.exec(r.url)[1] === p.merchantId) {
      store.links[p.url] = { network: 'linkprice', merchantId: p.merchantId, merchant: p.label, url: r.url, subscriptionStatus: r.subscriptionStatus ?? null, createdAt: new Date().toISOString() };
      made.push(p.url);
    } else failed.push({ url: p.url, code: r.code ?? 'LINK_INVALID' });
  }
  store.approvedAt ??= new Date().toISOString();
  store.evidenceSha256 = createHash('sha256').update(JSON.stringify(store.links)).digest('hex');
  writeFileSync(file, JSON.stringify(store, null, 2) + '\n');
  return { ok: !failed.length, made: made.length, total: Object.keys(store.links).length, failed, file };
}

// Sends the approval next to a 글감 request when the brief names products of approved merchants.
export async function requestLinks(briefDir, { approvals, notifier, approvalButtons, approvalText, merchants }) {
  const brief = JSON.parse(readFileSync(path.join(briefDir, 'article-brief.json'), 'utf8'));
  const catalog = merchants ?? await currentCpsMerchants();
  const products = linkableProductsForMerchants(brief, catalog);
  if (!products.length) return { sent: false, reason: 'NO_LINKABLE_PRODUCTS' };
  const r = approvals.create({ kind: 'linkprice-links', params: { briefDir }, title: brief.headline ?? path.basename(briefDir), ttlHours: 48,
    summary: [`링크프라이스 CPS 링크 ${products.length}개 (승인된 광고주만):`, ...products.map(p => `· ${p.label} ${p.url}`),
      `글에는 고지 문구가 들어갑니다: "${DISCLOSURE}"`, '누르면 링크를 만들어 이 글감에 붙입니다. 초안 작성 전에 눌러야 글에 들어갑니다.'].join('\n') });
  const sent = await notifier.send(approvalText(r), { buttons: approvalButtons(r.id, r.kind) });
  approvals.update(r.id, { messageId: sent.messageId ?? null, notified: sent.sent === true });
  return { sent: sent.sent === true, id: r.id, products: products.length };
}

async function main() {
  const briefDir = process.argv.find(a => a.startsWith('--brief='))?.slice(8);
  if (!briefDir) fail('BRIEF_REQUIRED');
  if (process.argv.includes('--request')) {
    const { createApprovals, approvalButtons, approvalText } = await import(pathToFileURL(path.join(HUB, 'scripts', 'approvals.mjs')).href);
    const { defaultNotifier } = await import(pathToFileURL(path.join(HUB, 'scripts', 'notify.mjs')).href);
    console.log(JSON.stringify(await requestLinks(path.resolve(briefDir), { approvals: createApprovals(), notifier: await defaultNotifier(), approvalButtons, approvalText })));
    return;
  }
  console.log(JSON.stringify(await buildLinks(path.resolve(briefDir), { dryRun: process.argv.includes('--dry-run') })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code || e.message })); process.exitCode = 1; });
