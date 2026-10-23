import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  COUPANG_PUBLIC_PRICE_DEFAULT_SPACING_MS,
  COUPANG_PUBLIC_PRICE_MAX_MANIFEST_BYTES,
  parseCoupangPublicPriceManifestJson,
  validateCoupangPublicPriceSpacing,
  verifyCoupangPublicPriceFrontier,
} from '../lib/coupang-public-price-verification.mjs';

class CliInputError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fail(code) { throw new CliInputError(code); }

export function parsePublicPriceVerifierArgs(args) {
  let manifestPath = null;
  let mode = null;
  let spacingMs = COUPANG_PUBLIC_PRICE_DEFAULT_SPACING_MS;
  let writeReceipt = false;
  const seen = new Set();
  const mark = key => { if (seen.has(key)) fail('CLI_ARGUMENTS_INVALID'); seen.add(key); };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--live' || arg === '--dry-run') {
      mark('mode');
      mode = arg === '--live' ? 'live' : 'dry-run';
      continue;
    }
    if (arg === '--write') {
      mark('write');
      writeReceipt = true;
      continue;
    }
    if (arg === '--manifest' || arg.startsWith('--manifest=')) {
      mark('manifest');
      const value = arg === '--manifest' ? args[++index] : arg.slice('--manifest='.length);
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) fail('CLI_ARGUMENTS_INVALID');
      manifestPath = value;
      continue;
    }
    if (arg === '--spacing-ms' || arg.startsWith('--spacing-ms=')) {
      mark('spacing');
      const value = arg === '--spacing-ms' ? args[++index] : arg.slice('--spacing-ms='.length);
      if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) fail('CLI_ARGUMENTS_INVALID');
      spacingMs = Number(value);
      try { validateCoupangPublicPriceSpacing(spacingMs); } catch { fail('CLI_ARGUMENTS_INVALID'); }
      continue;
    }
    fail('CLI_ARGUMENTS_INVALID');
  }

  if (!manifestPath || !mode) fail('CLI_ARGUMENTS_INVALID');
  return { manifestPath, mode, spacingMs, writeReceipt };
}

async function readManifest(path) {
  let fileStat;
  try { fileStat = await stat(path); } catch { fail('MANIFEST_READ_FAILED'); }
  if (!fileStat.isFile() || fileStat.size > COUPANG_PUBLIC_PRICE_MAX_MANIFEST_BYTES) fail('MANIFEST_TOO_LARGE');
  let text;
  try { text = await readFile(path, 'utf8'); } catch { fail('MANIFEST_READ_FAILED'); }
  return parseCoupangPublicPriceManifestJson(text);
}

async function writeReceipt(report, observedAt) {
  const directory = new URL(`../../../runs/coupang-public-price-verification-${observedAt.replace(/[:.]/g, '-')}/`, import.meta.url);
  await mkdir(directory, { recursive: true });
  const target = new URL('verification.json', directory);
  await writeFile(target, JSON.stringify(report, null, 2), { flag: 'wx' });
  return fileURLToPath(target);
}

function safeErrorCode(error) {
  const code = error?.code;
  const allowed = new Set([
    'CLI_ARGUMENTS_INVALID', 'MANIFEST_READ_FAILED', 'MANIFEST_TOO_LARGE', 'MANIFEST_SCHEMA',
    'MANIFEST_SCHEMA_VERSION', 'MANIFEST_JSON_INVALID', 'SOURCE_METADATA_SCHEMA', 'SOURCE_METADATA_INVALID',
    'FRONTIER_EMPTY', 'FRONTIER_TOO_LARGE', 'SKU_SCHEMA', 'SKU_URL_SCOPE', 'EXPECTED_PRICE_INVALID',
    'DUPLICATE_SKU', 'SPACING_OUT_OF_RANGE', 'RUNNER_DEPENDENCY_INVALID', 'LIVE_FLAG_INVALID',
  ]);
  return allowed.has(code) ? code : 'VERIFICATION_FAILED';
}

export async function main(args = process.argv.slice(2), runtimeDependencies = {}) {
  let options;
  let manifest;
  const observedAt = new Date().toISOString();
  try {
    options = parsePublicPriceVerifierArgs(args);
    manifest = await readManifest(options.manifestPath);
  } catch (error) {
    console.error(JSON.stringify({ status: 'invalid_input', passed: false, errorCode: safeErrorCode(error), browserUsed: false,
      ownerCredentialUsed: false, nativeRequestCount: 0 }));
    return 2;
  }

  let report;
  try {
    report = await verifyCoupangPublicPriceFrontier(manifest, {
      ...runtimeDependencies,
      live: options.mode === 'live',
      spacingMs: options.spacingMs,
    });
  } catch (error) {
    report = {
      schemaVersion: 1,
      operation: 'coupang_public_exact_sku_price_batch_verification',
      checkedAt: observedAt,
      status: 'failed',
      passed: false,
      errorCode: safeErrorCode(error),
      providedFrontierCount: manifest.items.length,
      frontierEnumerationComplete: false,
      browserUsed: false,
      ownerCredentialUsed: false,
      credentialPropagated: false,
      nativeResponseObserved: false,
      nativeOfferReadCount: 0,
      retryCount: 0,
      rawResponseStored: false,
      rawUrlStored: false,
    };
  }

  report.startedAt = observedAt;
  report.finishedAt = new Date().toISOString();
  let receiptWritten = false;
  let receiptWriteFailed = false;
  if (options.writeReceipt) {
    try { await writeReceipt(report, observedAt); receiptWritten = true; }
    catch { receiptWriteFailed = true; }
  }

  const output = {
    status: report.status,
    passed: report.passed,
    errorCode: report.errorCode ?? null,
    mode: options.mode,
    providedFrontierCount: report.providedFrontierCount,
    attemptedCount: report.attemptedCount ?? 0,
    verifiedPriceCount: report.verifiedPriceCount ?? 0,
    unverifiedCount: report.unverifiedCount ?? 0,
    unattemptedCount: report.unattemptedCount ?? report.providedFrontierCount,
    blocked403Count: report.blocked403Count ?? 0,
    rateLimitedCount: report.rateLimitedCount ?? 0,
    nativeOfferReadCount: report.nativeOfferReadCount ?? 0,
    frontierEnumerationComplete: false,
    browserUsed: false,
    ownerCredentialUsed: false,
    receiptWritten,
    receiptWriteFailed,
  };
  console.log(JSON.stringify(output));

  if (receiptWriteFailed) return 1;
  if (options.mode === 'dry-run') return 3;
  return report.passed ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  process.exitCode = await main();
