import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPublicPage, readPublicPage, safeUrl } from '../../lib/cps-public-reader.mjs';

const ROOT_URL = 'https://www.jestina.co.kr/';
const OBSERVED_PRODUCT_CANDIDATE = 'https://www.jestina.co.kr/products/view/G2000030770?cateCd=282';
const ROOTS = ['jestina.co.kr'];
const BATCH_URL = new URL('../../references/cps-reverify/batch-06.json', import.meta.url);
const OUTPUT_URL = new URL('../../references/cps-reverify/jestina-public-supplement.json', import.meta.url);

async function batchRow() {
  const snapshot = JSON.parse(await readFile(BATCH_URL, 'utf8'));
  const rows = Array.isArray(snapshot) ? snapshot : snapshot.merchants ?? snapshot.records ?? snapshot.rows ?? [];
  const row = rows.find(item => item.merchantId === 'jestina' || item.sourceId === 'jestina');
  if (!row) throw Object.assign(new Error('JESTINA_BATCH06_ROW_MISSING'), { code: 'JESTINA_BATCH06_ROW_MISSING' });
  return row;
}

function copyReceipt(receipt) {
  return {
    receiptId: receipt.receiptId,
    kind: receipt.kind,
    method: receipt.method,
    requestedUrl: safeUrl(receipt.requestedUrl),
    finalUrl: safeUrl(receipt.finalUrl),
    status: receipt.status,
    mime: receipt.mime ?? null,
    bytes: Number.isSafeInteger(receipt.bytes) ? receipt.bytes : 0,
    sha256: receipt.sha256 ?? null,
    checkedAt: receipt.checkedAt ?? null,
    redirects: Array.isArray(receipt.redirects) ? receipt.redirects : [],
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    stopReason: receipt.stopReason ?? null,
  };
}

function normalizeRetryReceipt(page) {
  const source = page?.receipt ?? {};
  return {
    receiptId: source.id ?? randomUUID(),
    kind: 'single_allowed_root_retry',
    method: source.requestMethod ?? 'GET',
    requestedUrl: safeUrl(source.requestUrl ?? ROOT_URL),
    finalUrl: safeUrl(page?.url ?? source.requestUrl ?? ROOT_URL),
    status: page?.status ?? source.responseStatus ?? null,
    mime: page?.contentType ?? source.contentType ?? null,
    bytes: Number.isSafeInteger(source.bytes) ? source.bytes : 0,
    sha256: source.responseSha256 ?? null,
    checkedAt: source.observedAt ?? null,
    redirects: Array.isArray(page?.redirects) ? page.redirects : [],
    browserUsed: source.browserUsed === true,
    cookiesSent: source.cookiesSent === true,
    authorizationSent: source.authorizationSent === true,
    stopReason: page?.stopReason ?? null,
    blocked: page?.blocked === true,
  };
}

function baseRow(previous, retryPage = null) {
  const previousReceipts = (previous.receipts ?? []).map(copyReceipt);
  const priorRoot = previousReceipts.find(receipt => receipt.kind === 'landing');
  const priorDetail = previousReceipts.find(receipt => receipt.kind === 'observed_detail_candidate');
  const retryReceipt = retryPage ? normalizeRetryReceipt(retryPage) : null;
  const row = {
    merchantId: 'jestina',
    merchantName: previous.merchantName ?? '제이에스티나',
    siteUrl: previous.siteUrl ?? 'http://www.jestina.co.kr/',
    verticalHint: previous.verticalHint ?? 'fashion',
    receipts: [...previousReceipts, ...(retryReceipt ? [retryReceipt] : [])],
    records: [],
    contracts: [
      {
        operation: 'landing_document_get', method: 'GET', requestUrl: ROOT_URL,
        status: priorRoot?.status ?? null, mime: priorRoot?.mime ?? null,
        parser: null, sourceLinkText: null,
      },
      ...(retryReceipt ? [{
        operation: 'single_exact_root_retry_get', method: 'GET', requestUrl: ROOT_URL,
        finalUrl: retryReceipt.finalUrl, status: retryReceipt.status, mime: retryReceipt.mime,
        parser: retryPage?.ok ? 'extractPublicPage' : null,
      }] : []),
      {
        operation: 'observed_product_candidate_document_get', method: 'GET', requestUrl: OBSERVED_PRODUCT_CANDIDATE,
        status: priorDetail?.status ?? null, mime: priorDetail?.mime ?? null,
        parser: null, sourceLinkText: 'Observed product card (recorded in batch-06; original anchor markup unavailable)',
      },
    ],
    operations: {},
    frontier: [],
    status: 'unavailable',
  };

  const evidenceIds = row.receipts.map(receipt => receipt.receiptId);
  const retrySucceeded = retryPage?.ok === true && retryReceipt?.status === 200;
  let extracted = null;
  if (retrySucceeded) {
    // Parsing remains in-memory; only sanitized extracted fields/links survive.
    extracted = extractPublicPage({
      ...retryPage,
      receipt: { id: retryReceipt.receiptId },
    }, { merchantId: 'jestina', typeHint: 'fashion' });
    row.records = extracted.records;
    row.frontier.push(...extracted.links
      .filter(link => {
        try {
          const url = new URL(link.url);
          return url.protocol === 'https:' && (url.hostname === 'jestina.co.kr' || url.hostname.endsWith('.jestina.co.kr'));
        } catch { return false; }
      })
      .filter(link => link.url !== ROOT_URL)
      .slice(0, 30)
      .map(link => ({ url: safeUrl(link.url), text: link.text, state: 'observed_first_party_link_not_fetched' })));
  }

  if (retryReceipt) {
    row.frontier.unshift({
      url: ROOT_URL,
      text: null,
      state: retrySucceeded ? 'root_retry_reachable' : 'page_unavailable_after_single_root_retry',
      status: retryReceipt.status,
      stopReason: retryReceipt.stopReason,
      bytes: retryReceipt.bytes,
      note: retrySucceeded ? 'One exact-root retry was parsed; no raw HTML was retained.' : 'One ordinary anonymous retry of the exact observed HTTPS root returned no readable HTML.',
    });
  } else {
    row.frontier.unshift({
      url: ROOT_URL,
      text: null,
      state: priorRoot?.status === 500 ? 'single_root_retry_available' : 'page_unavailable',
      status: priorRoot?.status ?? null,
      note: 'The root retry is deliberately opt-in and bounded to the exact observed root URL.',
    });
  }

  row.frontier.push({
    url: OBSERVED_PRODUCT_CANDIDATE,
    text: 'Observed product card',
    state: 'previously_observed_but_unavailable',
    status: priorDetail?.status ?? null,
    note: 'Exact first-party candidate was already requested in batch-06 and returned 500; not retried in this bounded pass.',
  });
  if (!retrySucceeded || extracted?.records?.length === 0) {
    row.frontier.push({
      url: null,
      text: null,
      state: 'mobile_redirect_or_catalog_path_not_observed',
      note: 'Neither 500 root response supplied readable HTML, redirects, or a first-party link from which another path could be established.',
    });
  }

  const recordEvidence = row.records.flatMap(record => record.evidence ?? []).map(item => item.receiptId).filter(Boolean);
  const observedEvidence = [...new Set([...evidenceIds, ...recordEvidence])];
  row.operations = {
    landingAndObservedPages: {
      state: retrySucceeded ? 'live_replay_partial' : 'unavailable',
      evidenceReceiptIds: evidenceIds,
      note: retrySucceeded ? 'Exact root retry succeeded; the earlier linked detail candidate remains unavailable.' : 'Initial root and product candidate returned 500; exact root retry also returned 500.',
    },
    productOrServiceRecord: {
      state: row.records.length ? 'live_replay' : 'not_observed',
      evidenceReceiptIds: row.records.length ? recordEvidence : observedEvidence,
      note: row.records.length ? null : 'No offering fields were retrievable; the first-party candidate page returned 500 and no raw body was available.',
    },
    productSearch: { state: 'not_observed', evidenceReceiptIds: [], note: 'No search endpoint was observed; none was guessed.' },
    price: { state: 'not_observed', evidenceReceiptIds: observedEvidence, note: null },
    ratingSummary: { state: 'not_observed', evidenceReceiptIds: observedEvidence, note: null },
    variants: { state: 'not_observed', evidenceReceiptIds: observedEvidence, note: null },
    reviewSamples: { state: 'not_observed', evidenceReceiptIds: observedEvidence, note: 'No review data was available.' },
  };
  row.checkedAt = retryReceipt?.checkedAt ?? null;
  row.status = row.records.length ? 'reachable_with_ontology_records'
    : retrySucceeded ? 'reachable_without_ontology_records' : 'unavailable';
  return row;
}

/**
 * Inspect only the exact first-party URLs already recorded in batch-06.
 * Each explicit refresh makes one anonymous GET of the observed root. Historical
 * access rejections remain stopped. No detail/API path is guessed.
 */
export async function collectJestinaPublic({ useStored = false } = {}) {
  const previous = existsSync(fileURLToPath(OUTPUT_URL)) ? JSON.parse(await readFile(OUTPUT_URL, 'utf8')) : await batchRow();
  if (useStored) return previous;
  if (previous.receipts?.some(receipt => [401, 403, 418, 429].includes(receipt.status) || /CHALLENGE/i.test(receipt.stopReason ?? ''))) {
    return { ...previous, status: 'blocked_stopped', retry: false };
  }

  const retryPage = await readPublicPage(ROOT_URL, {
    allowedHosts: ROOTS,
    maxRedirects: 3,
    maxBytes: 8 * 1024 * 1024,
    timeoutMs: 20_000,
  });
  const row = baseRow(previous, retryPage);
  const temporary = fileURLToPath(OUTPUT_URL) + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, `${JSON.stringify(row, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, fileURLToPath(OUTPUT_URL));
  return row;
}

async function main() {
  const row = await collectJestinaPublic({ useStored: process.argv.includes('--cached') });
  if (!existsSync(fileURLToPath(OUTPUT_URL))) {
    await writeFile(OUTPUT_URL, `${JSON.stringify(row, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify({ status: row.status, records: row.records.length, receipts: row.receipts.length })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
