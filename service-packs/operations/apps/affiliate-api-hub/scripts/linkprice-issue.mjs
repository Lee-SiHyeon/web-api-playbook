import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLICK_LINK, MERCHANTS, SITES } from './linkprice-links.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, '..');
const SNAPSHOT_PATH = path.join(HUB, 'references', 'cps-reverify', 'ontology.jsonl');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const CHANNELS = Object.freeze(Object.keys(SITES));
const APP_LOCAL_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const APPROVALS_DIR = path.join(os.homedir(), '.config', 'affiliate-content-operations', 'approvals');
export const DEFAULT_LEDGER_PATH = path.join(APP_LOCAL_DATA, 'affiliate-content-operations', 'linkprice', 'issued-links.jsonl');
export const DEFAULT_CHANNELS = CHANNELS;

function webAuth(command, input, arg) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(HUB, 'scripts', 'web-auth.mjs'), 'linkprice', command, ...(arg ? [arg] : [])],
      { cwd: HUB, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('close', () => {
      try { resolve(JSON.parse(out.trim().split(/\r?\n/).at(-1))); }
      catch { resolve({ ok: false, code: 'WEB_AUTH_OUTPUT' }); }
    });
    child.on('error', () => resolve({ ok: false, code: 'WEB_AUTH_SPAWN' }));
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

async function liveCatalog() {
  const result = await webAuth('merchants', undefined, 'cps');
  if (!result.ok || !Array.isArray(result.merchants)) fail(result.code ?? 'LINKPRICE_CATALOG_FAILED');
  return result.merchants;
}

async function liveSubscriptions({ affiliateId, merchantIds }) {
  const result = await webAuth('subscriptions', { affiliateId, merchantIds });
  if (!result.ok || !Array.isArray(result.subscriptions)) fail(result.code ?? 'LINKPRICE_SUBSCRIPTIONS_FAILED');
  return result.subscriptions;
}

export async function defaultLinkBuilder({ merchantId, affiliateId, targetUrl } = {}) {
  if (typeof merchantId !== 'string' || !/^[a-z0-9_]+$/.test(merchantId)) fail('LINKPRICE_MERCHANT_ID_INVALID');
  if (!Object.values(SITES).includes(affiliateId)) fail('LINKPRICE_AFFILIATE_ID_INVALID');
  let target;
  try { target = new URL(targetUrl); } catch { fail('LINK_TARGET_INVALID'); }
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.hash) fail('LINK_TARGET_INVALID');
  // Captured LinkPrice consumer contract: click.php carries merchant/site ids and an encoded target URL.
  return `https://click.linkprice.com/click.php?m=${merchantId}&a=${affiliateId}&l=9999&l_cd1=3&l_cd2=0&tu=${encodeURIComponent(target.href)}`;
}

function readSnapshot() {
  let raw;
  try { raw = readFileSync(SNAPSHOT_PATH, 'utf8'); }
  catch { fail('CATALOG_SNAPSHOT_MISSING'); }
  const records = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch { fail(`CATALOG_SNAPSHOT_INVALID_LINE_${index + 1}`); }
  }
  return { records, sha256: createHash('sha256').update(raw).digest('hex') };
}

async function lookupApproval(id) {
  if (!/^[a-f0-9]{16}$/.test(String(id))) return null;
  const file = path.join(APPROVALS_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

function rowsFromSnapshot(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot?.records)) return snapshot.records;
  return [];
}

function offeringsFromSnapshot(snapshot) {
  return rowsFromSnapshot(snapshot).filter(row => row?.type === 'CommercialOffering');
}

function merchantRows(snapshot, catalog) {
  const snapshotRows = rowsFromSnapshot(snapshot).filter(row => row?.type === 'AffiliateProgram').map(row => ({
    merchantId: row.merchantId ?? String(row.id ?? '').replace(/^linkprice:/, ''),
    site_name: row.name,
    site_url: row.siteUrl,
  }));
  const liveRows = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.merchants) ? catalog.merchants : [];
  return [...snapshotRows, ...liveRows, ...MERCHANTS];
}

function hostOf(value) {
  try {
    const raw = String(value ?? '');
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return null; }
}

function hostPatternHost(regex) {
  const source = regex.source.replace(/^\(\^\|\\\.\)/, '').replace(/\$$/, '').replace(/\\\./g, '.');
  return hostOf(source);
}

function hostMatches(target, base) {
  const targetHost = hostOf(target);
  const baseHost = hostOf(base);
  return Boolean(targetHost && baseHost && (targetHost === baseHost || targetHost.endsWith(`.${baseHost}`)));
}

function matchesMerchantHost(targetHost, row) {
  const pattern = row?.host instanceof RegExp ? row.host : null;
  if (pattern && pattern.test(targetHost)) return hostPatternHost(pattern) ?? targetHost;
  const source = row?.site_url ?? row?.siteUrl ?? (typeof row?.host === 'string' ? row.host : null);
  const sourceHost = hostOf(source);
  return sourceHost && hostMatches(targetHost, sourceHost) ? sourceHost : null;
}

export function resolveMerchant(url, merchants) {
  let target;
  try { target = new URL(url); } catch { return { merchant: null, reason: 'PRODUCT_URL_INVALID' }; }
  const targetHost = target.hostname.toLowerCase().replace(/^www\./, '');
  const candidates = [];
  for (const row of merchants ?? []) {
    const merchantId = row?.merchantId ?? row?.merchant_id;
    if (typeof merchantId !== 'string' || !merchantId) continue;
    const baseHost = matchesMerchantHost(targetHost, row);
    if (!baseHost) continue;
    candidates.push({
      merchantId,
      label: row.label ?? row.site_name ?? row.name ?? merchantId,
      siteUrl: row.site_url ?? row.siteUrl ?? null,
      hostLength: baseHost.length,
    });
  }
  if (!candidates.length) return { merchant: null, reason: 'MERCHANT_HOST_UNKNOWN' };
  const longest = Math.max(...candidates.map(row => row.hostLength));
  const best = [...new Map(candidates.filter(row => row.hostLength === longest).map(row => [row.merchantId, row])).values()];
  if (best.length !== 1) return { merchant: null, reason: 'MERCHANT_HOST_AMBIGUOUS' };
  const selected = best[0];
  const sameMerchantRows = candidates.filter(row => row.merchantId === selected.merchantId);
  const parsedSiteUrls = sameMerchantRows.map(row => {
    try { return new URL(row.siteUrl); } catch { return null; }
  }).filter(Boolean);
  return {
    merchant: {
      merchantId: selected.merchantId,
      label: selected.label,
      httpOnly: parsedSiteUrls.length > 0 && parsedSiteUrls.every(site => site.protocol === 'http:'),
    },
    reason: null,
  };
}

export function canonicalTargetUrl(raw, { httpOnly = false } = {}) {
  let target;
  try { target = new URL(raw); } catch { fail('PRODUCT_URL_INVALID'); }
  if (target.username || target.password || !['https:', 'http:'].includes(target.protocol)) fail('PRODUCT_URL_INVALID');
  if (target.protocol !== 'https:' && !httpOnly) fail('HTTPS_REQUIRED');
  target.hash = '';
  for (const key of [...target.searchParams.keys()]) {
    const productIdentity = /(?:^|_)(?:product|item|goods|sku|id|code|no)(?:_|$)/i.test(key);
    const tracking = /^utm_/i.test(key) || /^(?:fbclid|gclid|napm)$/i.test(key) ||
      (/^(?:n_|nt_)/i.test(key) && !productIdentity);
    if (tracking) target.searchParams.delete(key);
  }
  return target.href;
}

export function parseChannels(value) {
  if (value == null || value === '') return [...CHANNELS];
  const channels = String(value).split(',').map(channel => channel.trim()).filter(Boolean);
  if (!channels.length || channels.some(channel => !Object.hasOwn(SITES, channel)) || new Set(channels).size !== channels.length)
    fail('CHANNELS_INVALID');
  return channels;
}

function verifiedLink(url, merchantId, affiliateId, canonicalUrl) {
  const match = CLICK_LINK.exec(String(url ?? ''));
  if (!match || match[1] !== merchantId || match[2] !== affiliateId) fail('LINK_INVALID');
  let decoded;
  try { decoded = decodeURIComponent(match[3]); } catch { fail('LINK_TARGET_ENCODING_INVALID'); }
  if (decoded !== canonicalUrl) fail('LINK_TARGET_MISMATCH');
  return String(url);
}

function normalizeSubscriptions(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.subscriptions) ? value.subscriptions : [];
}

function readLedgerFile(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, 'utf8');
  const rows = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch { fail(`LEDGER_INVALID_LINE_${index + 1}`); }
  }
  return rows;
}

export function createLinkpriceIssuer({
  getCatalog = liveCatalog,
  getSubscriptions = liveSubscriptions,
  getSnapshot = readSnapshot,
  getApproval = lookupApproval,
  buildLink = defaultLinkBuilder,
  ledgerPath = DEFAULT_LEDGER_PATH,
  now = () => new Date().toISOString(),
} = {}) {
  async function check({ url, channels = CHANNELS } = {}) {
    if (typeof url !== 'string' || !url) fail('URL_REQUIRED');
    if (Array.isArray(channels) && !channels.length) fail('CHANNELS_INVALID');
    const selectedChannels = parseChannels(Array.isArray(channels) ? channels.join(',') : channels);
    const [snapshot, catalog] = await Promise.all([getSnapshot(), getCatalog()]);
    const catalogSnapshotSha256 = snapshot?.sha256 ?? null;
    if (!/^[a-f0-9]{64}$/i.test(String(catalogSnapshotSha256 ?? ''))) fail('CATALOG_SNAPSHOT_HASH_INVALID');
    const resolved = resolveMerchant(url, merchantRows(snapshot, catalog));
    if (!resolved.merchant) {
      return { ok: false, url, catalogSnapshotSha256, channels: selectedChannels.map(channel => ({
        channel, affiliateId: SITES[channel], merchantId: null, merchant: null, canonicalUrl: null,
        subscriptionStatus: null, link: null, reason: resolved.reason,
      })) };
    }
    let canonicalUrl;
    try { canonicalUrl = canonicalTargetUrl(url, { httpOnly: resolved.merchant.httpOnly }); }
    catch (error) {
      const reason = error.code ?? 'PRODUCT_URL_INVALID';
      return { ok: false, url, catalogSnapshotSha256, merchant: resolved.merchant, merchantId: resolved.merchant.merchantId,
        canonicalUrl: null, channels: selectedChannels.map(channel => ({ channel, affiliateId: SITES[channel], merchantId: resolved.merchant.merchantId,
          merchant: resolved.merchant, canonicalUrl: null, subscriptionStatus: null, link: null, reason })) };
    }
    const results = await Promise.all(selectedChannels.map(async channel => {
      const affiliateId = SITES[channel];
      const subscriptionRows = normalizeSubscriptions(await getSubscriptions({ affiliateId, merchantIds: [resolved.merchant.merchantId] }));
      const subscription = subscriptionRows.find(row => (row.merchantId ?? row.merchant_id) === resolved.merchant.merchantId &&
        (row.affiliateId == null || row.affiliateId === affiliateId));
      const subscriptionStatus = typeof subscription?.status === 'string' ? subscription.status :
        typeof subscription?.subscriptionStatus === 'string' ? subscription.subscriptionStatus : 'UNKNOWN';
      if (subscriptionStatus !== 'APR') return {
        channel, affiliateId, merchantId: resolved.merchant.merchantId, merchant: resolved.merchant, canonicalUrl,
        subscriptionStatus, link: null, reason: subscriptionStatus === 'UNKNOWN' ? 'SUBSCRIPTION_STATUS_MISSING' : 'MERCHANT_NOT_APPROVED',
      };
      let link;
      try {
        link = verifiedLink(await buildLink({ merchantId: resolved.merchant.merchantId, affiliateId, targetUrl: canonicalUrl }),
          resolved.merchant.merchantId, affiliateId, canonicalUrl);
      } catch (error) {
        return { channel, affiliateId, merchantId: resolved.merchant.merchantId, merchant: resolved.merchant, canonicalUrl,
          subscriptionStatus, link: null, reason: error.code ?? 'LINK_INVALID' };
      }
      return { channel, affiliateId, merchantId: resolved.merchant.merchantId, merchant: resolved.merchant, canonicalUrl,
        subscriptionStatus, link, reason: null };
    }));
    return { ok: results.every(row => row.reason === null), url, canonicalUrl, merchant: resolved.merchant,
      merchantId: resolved.merchant.merchantId, catalogSnapshotSha256, channels: results };
  }

  async function issue({ url, channels = CHANNELS, approval, dryRun = false, source = 'linkprice-issue' } = {}) {
    if (typeof approval !== 'string' || !approval.trim()) fail('APPROVAL_REQUIRED');
    const approvalRecord = await getApproval(approval.trim());
    if (approvalRecord?.id !== approval.trim() || approvalRecord?.kind !== 'linkprice-links' || approvalRecord?.status !== 'approved')
      fail('APPROVAL_NOT_APPROVED');
    const result = await check({ url, channels });
    const existingRows = readLedgerFile(ledgerPath);
    const issued = [];
    const refused = [];
    const pendingWrites = [];
    for (const channelResult of result.channels) {
      if (!channelResult.merchantId || !channelResult.canonicalUrl) {
        refused.push(channelResult);
        continue;
      }
      const existing = existingRows.find(row => row.canonicalUrl === channelResult.canonicalUrl && row.affiliateId === channelResult.affiliateId);
      if (existing) {
        issued.push({ record: existing, existing: true });
        continue;
      }
      if (channelResult.subscriptionStatus !== 'APR' || !channelResult.link) {
        refused.push(channelResult);
        continue;
      }
      const record = {
        issuedAt: now(),
        url,
        canonicalUrl: channelResult.canonicalUrl,
        merchantId: channelResult.merchantId,
        channel: channelResult.channel,
        affiliateId: channelResult.affiliateId,
        link: verifiedLink(channelResult.link, channelResult.merchantId, channelResult.affiliateId, channelResult.canonicalUrl),
        subscriptionStatus: channelResult.subscriptionStatus,
        catalogSnapshotSha256: result.catalogSnapshotSha256,
        approvalId: approval.trim(),
        source,
      };
      pendingWrites.push(record);
      issued.push({ record, existing: false });
    }
    if (!dryRun && pendingWrites.length) {
      mkdirSync(path.dirname(ledgerPath), { recursive: true });
      for (const record of pendingWrites) appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
    }
    return { ok: refused.length === 0, dryRun: Boolean(dryRun), ledgerPath,
      issued, refused, written: dryRun ? 0 : pendingWrites.length };
  }

  async function fromOffering({ offering, channels = CHANNELS } = {}) {
    if (typeof offering !== 'string' || !offering) fail('OFFERING_REQUIRED');
    const snapshot = await getSnapshot();
    const row = offeringsFromSnapshot(snapshot).find(item => item.id === offering);
    if (!row) return { ok: false, offering, reason: 'OFFERING_NOT_FOUND' };
    if (typeof row.canonicalUrl !== 'string' || !row.canonicalUrl.trim())
      return { ok: false, offering, reason: 'CANONICAL_URL_MISSING', title: row.title ?? null };
    return check({ url: row.canonicalUrl, channels });
  }

  function ledger({ channel, merchant } = {}) {
    if (channel && !Object.hasOwn(SITES, channel)) fail('CHANNEL_INVALID');
    const records = readLedgerFile(ledgerPath).filter(row => (!channel || row.channel === channel) && (!merchant || row.merchantId === merchant));
    return { ok: true, count: records.length, ledgerPath, records };
  }

  return { check, issue, fromOffering, ledger };
}

function parseArgs(args) {
  const options = {};
  for (const arg of args) {
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (!arg.startsWith('--') || !arg.includes('=')) fail('ARGUMENT_INVALID');
    const separator = arg.indexOf('=');
    const key = arg.slice(2, separator);
    const value = arg.slice(separator + 1);
    if (!value) fail(`${key.toUpperCase()}_REQUIRED`);
    options[key] = value;
  }
  return options;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseArgs(args);
  const issuer = createLinkpriceIssuer({ ledgerPath: options.ledger ?? DEFAULT_LEDGER_PATH });
  let result;
  if (command === 'check') {
    if (!options.url) fail('URL_REQUIRED');
    result = await issuer.check({ url: options.url, channels: parseChannels(options.channels) });
  } else if (command === 'issue') {
    if (!options.url) fail('URL_REQUIRED');
    result = await issuer.issue({ url: options.url, channels: parseChannels(options.channels), approval: options.approval, dryRun: options.dryRun });
  } else if (command === 'from-offering') {
    if (!options.offering) fail('OFFERING_REQUIRED');
    result = await issuer.fromOffering({ offering: options.offering, channels: parseChannels(options.channels) });
  } else if (command === 'ledger') {
    result = issuer.ledger({ channel: options.channel, merchant: options.merchant });
  } else fail('COMMAND_INVALID');
  console.log(JSON.stringify(result));
  if (result.ok === false) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.log(JSON.stringify({ ok: false, code: error.code ?? error.message })); process.exitCode = 1; });
