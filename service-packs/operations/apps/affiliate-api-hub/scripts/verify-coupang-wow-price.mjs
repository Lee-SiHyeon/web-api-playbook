import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  normalizeCoupangWowPriceTargetUrl,
  verifyCoupangWowPrice,
} from '../lib/coupang-wow-price-verification.mjs';

class CliInputError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const fail = code => { throw new CliInputError(code); };
const PRICE_PATTERN = /^[1-9]\d{0,12}$/;

export function parseCoupangWowPriceArgs(args) {
  let url = null;
  let expectedWowPriceKrw = null;
  let expectedProvided = false;
  let live = false;
  let writeReceipt = false;
  const seen = new Set();
  const mark = key => { if (seen.has(key)) fail('CLI_ARGUMENTS_INVALID'); seen.add(key); };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--live') {
      mark('live');
      live = true;
      continue;
    }
    if (arg === '--write') {
      mark('write');
      writeReceipt = true;
      continue;
    }
    if (arg === '--url' || arg.startsWith('--url=')) {
      mark('url');
      const value = arg === '--url' ? args[++index] : arg.slice('--url='.length);
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) fail('CLI_ARGUMENTS_INVALID');
      url = value;
      continue;
    }
    if (arg === '--expected-wow-price' || arg.startsWith('--expected-wow-price=')) {
      mark('expectedWowPrice');
      expectedProvided = true;
      const value = arg === '--expected-wow-price' ? args[++index] : arg.slice('--expected-wow-price='.length);
      if (typeof value !== 'string' || !PRICE_PATTERN.test(value)) fail('CLI_ARGUMENTS_INVALID');
      expectedWowPriceKrw = Number(value);
      if (!Number.isSafeInteger(expectedWowPriceKrw)) fail('CLI_ARGUMENTS_INVALID');
      continue;
    }
    fail('CLI_ARGUMENTS_INVALID');
  }

  if (!url) fail('CLI_ARGUMENTS_INVALID');
  try { normalizeCoupangWowPriceTargetUrl(url); } catch { fail('CLI_ARGUMENTS_INVALID'); }
  return { url, expectedWowPriceKrw: expectedProvided ? expectedWowPriceKrw : null, live, writeReceipt };
}

async function writeRunReceipt(report, checkedAt) {
  const runKey = checkedAt.replace(/[:.]/g, '-');
  const directory = new URL(`../../../runs/coupang-wow-price-verification-${runKey}/`, import.meta.url);
  await mkdir(directory, { recursive: true });
  const target = new URL('verification.json', directory);
  await writeFile(target, JSON.stringify(report, null, 2), { flag: 'wx' });
  return fileURLToPath(target);
}

function safeErrorCode(error) {
  const allowed = new Set([
    'CLI_ARGUMENTS_INVALID',
    'EXPECTED_WOW_PRICE_INVALID',
    'LIVE_FLAG_INVALID',
    'PRODUCT_ID_INVALID',
    'PRODUCT_URL_INVALID',
    'PRODUCT_URL_SCOPE',
    'RUNNER_DEPENDENCY_INVALID',
  ]);
  return allowed.has(error?.code) ? error.code : 'VERIFICATION_FAILED';
}

function summary(report) {
  return {
    status: report.status,
    passed: report.passed,
    errorCode: report.errorCode,
    productId: report.productId,
    itemId: report.itemId,
    vendorItemId: report.vendorItemId,
    observedAt: report.observedAt,
    observedGeneralAt: report.observedGeneralAt,
    observedWowAt: report.observedWowAt,
    httpStatus: report.httpStatus,
    accountHttpStatus: report.accountHttpStatus,
    selectedIdentityMatched: report.selectedIdentityMatched,
    observedGeneralPriceKrw: report.observedGeneralPriceKrw,
    generalPriceVerified: report.generalPriceVerified,
    advertisedWowPriceKrw: report.advertisedWowPriceKrw,
    advertisedWowPriceLabel: report.advertisedWowPriceLabel,
    advertisedWowPriceSourcePath: report.advertisedWowPriceSourcePath,
    advertisedWowPriceVerified: report.advertisedWowPriceVerified,
    wowPriceReadStatus: report.wowPriceReadStatus,
    wowMembershipRequired: report.wowMembershipRequired,
    memberPriceVerified: report.memberPriceVerified,
    accountContextPriceReadStatus: report.accountContextPriceReadStatus,
    accountContextPriceReadCode: report.accountContextPriceReadCode,
    accountContextSalePriceReadStatus: report.accountContextSalePriceReadStatus ?? null,
    accountGeneralPriceMatchesPublic: report.accountGeneralPriceMatchesPublic ?? null,
    wowGeneralBoundSource: report.wowGeneralBoundSource ?? null,
    accountCredentialPropagated: report.accountCredentialPropagated,
    expectedWowPriceKrw: report.expectedWowPriceKrw,
    expectedWowPriceMatched: report.expectedWowPriceMatched,
    nativeOfferListRead: report.nativeOfferListRead,
    nativeGeneralStatesVerified: report.nativeGeneralStatesVerified,
    nativeWowStatesVerified: report.nativeWowStatesVerified,
    nativeStatesVerified: report.nativeStatesVerified,
    browserUsed: false,
    ownerCredentialUsed: report.ownerCredentialUsed,
    receiptWritten: report.receiptWritten,
    receiptWriteFailed: report.receiptWriteFailed,
  };
}

export async function main(args = process.argv.slice(2), runtimeDependencies = {}) {
  let options;
  try {
    options = parseCoupangWowPriceArgs(args);
  } catch (error) {
    console.error(JSON.stringify({ status: 'invalid_input', passed: false, errorCode: safeErrorCode(error), browserUsed: false,
      ownerCredentialUsed: false, nativeRequestCount: 0 }));
    return 2;
  }

  let report;
  const startedAt = new Date().toISOString();
  try {
    report = await verifyCoupangWowPrice({
      url: options.url,
      expectedWowPriceKrw: options.expectedWowPriceKrw,
      live: options.live,
      ...(runtimeDependencies.readOfferList ? { readOfferList: runtimeDependencies.readOfferList } : {}),
    });
  } catch (error) {
    const target = normalizeCoupangWowPriceTargetUrl(options.url);
    report = {
      schemaVersion: 1,
      operation: 'coupang_exact_selected_sku_wow_price_verification',
      checkedAt: new Date().toISOString(),
      observedAt: null,
      liveRequested: options.live,
      status: 'failed',
      passed: false,
      errorCode: safeErrorCode(error),
      productId: target.productId,
      itemId: target.itemId,
      vendorItemId: target.vendorItemId,
      selectedIdentityMatched: false,
      observedGeneralPriceKrw: null,
      generalPriceVerified: false,
      advertisedWowPriceKrw: null,
      advertisedWowPriceVerified: false,
      wowPriceReadStatus: 'unknown',
      wowMembershipRequired: null,
      memberPriceVerified: false,
      accountContextPriceReadStatus: 'unknown',
      accountContextPriceReadCode: null,
      accountCredentialPropagated: false,
      expectedWowPriceKrw: options.expectedWowPriceKrw,
      expectedWowPriceMatched: options.expectedWowPriceKrw === null ? null : false,
      nativeOfferListRead: false,
      nativeGeneralStatesVerified: false,
      nativeWowStatesVerified: false,
      nativeStatesVerified: false,
      httpStatus: null,
      ownerCredentialUsed: false,
      rawResponseStored: false,
      rawUrlStored: false,
      retryCount: 0,
    };
  }

  report.startedAt = startedAt;
  report.finishedAt = new Date().toISOString();
  let receiptWritten = false;
  let receiptWriteFailed = false;
  if (options.writeReceipt) {
    const writeReceipt = runtimeDependencies.writeReceipt ?? writeRunReceipt;
    try {
      await writeReceipt(report, report.checkedAt);
      receiptWritten = true;
    } catch {
      receiptWriteFailed = true;
    }
  }
  report.receiptWritten = receiptWritten;
  report.receiptWriteFailed = receiptWriteFailed;

  console.log(JSON.stringify(summary(report)));
  if (receiptWriteFailed) return 1;
  if (!options.live) return 3;
  return report.passed ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  process.exitCode = await main();
