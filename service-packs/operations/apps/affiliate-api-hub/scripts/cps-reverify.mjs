import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildOntologyDataset, loadReverificationBatches, ontologyJsonLines, validateOntologyDataset } from '../lib/cps-ontology-dataset.mjs';
import { acquireRunLock } from '../lib/process-run-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REFERENCES = path.join(APP, 'references');
const BATCH_DIRECTORY = path.join(REFERENCES, 'cps-reverify');
const SOURCE_MAP = path.join(REFERENCES, 'linkprice-cps-source-map-2026-09-27.json');
const CROSSWALK = path.join(REFERENCES, 'linkprice-cps-consumer-crosswalk.v1.json');
const readJson = filename => JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const relative = filename => path.relative(APP, filename).replaceAll(path.sep, '/');
const atomicWrite = (filename, value) => {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, value, { flag: 'wx' });
  renameSync(temporary, filename);
};

export function readDataset() {
  return buildOntologyDataset({ sourceMap: readJson(SOURCE_MAP), crosswalk: readJson(CROSSWALK), batches: loadReverificationBatches(BATCH_DIRECTORY) });
}

export function queryDataset(dataset, merchantId, { limit = 20, offset = 0 } = {}) {
  const coverage = dataset.coverage.find(row => row.merchantId === merchantId);
  if (!coverage) throw new Error('MERCHANT_NOT_IN_CPS_SNAPSHOT');
  const pageSize = Math.max(1, Math.min(200, Math.floor(Number(limit) || 20)));
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const rows = dataset.entities.commercialOfferings.filter(row => row.sourceId === coverage.sourceId);
  const offerings = rows.slice(start, start + pageSize).map(offering => ({ ...offering,
    prices: dataset.entities.offerObservations.filter(row => row.offeringId === offering.id),
    ratings: dataset.entities.ratingAggregates.filter(row => row.offeringId === offering.id),
    variants: dataset.entities.productVariants.filter(row => row.parentOfferingId === offering.id),
    reviewSamples: dataset.entities.reviewObservations.filter(row => row.offeringId === offering.id),
  }));
  const ids = new Set(offerings.flatMap(row => [...row.evidenceIds, ...row.prices.flatMap(value => value.evidenceIds), ...row.ratings.flatMap(value => value.evidenceIds), ...row.variants.flatMap(value => value.evidenceIds), ...row.reviewSamples.flatMap(value => value.evidenceIds)]));
  const evidence = dataset.entities.fieldEvidence.filter(row => ids.has(row.id));
  const capabilityAssessment = dataset.entities.capabilityAssessments.find(row => row.merchantId === merchantId);
  // A blocked or empty source still needs its response evidence in the query.
  // Preserve assessment references as well as this page's offering references.
  const receiptIds = new Set([...evidence.map(row => row.receiptId), ...(capabilityAssessment?.receiptIds ?? [])]);
  const receiptById = new Map(dataset.entities.evidenceReceipts.map(row => [row.id, row]));
  for (const id of receiptIds) {
    const receipt = receiptById.get(id);
    for (const predecessor of [receipt?.bootstrapReceiptId, receipt?.publicClientConfigReceiptId]) if (predecessor) receiptIds.add(predecessor);
  }
  return { ok: true, ontologyId: dataset.ontologyId, generatedAt: dataset.generatedAt, merchantId, coverage,
    total: rows.length, offset: start, limit: pageSize, nextOffset: start + offerings.length < rows.length ? start + offerings.length : null,
    offerings, evidence, receipts: dataset.entities.evidenceReceipts.filter(row => receiptIds.has(row.id)),
    capabilityAssessment };
}

export function coverageMarkdown(dataset) {
  const clean = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  const states = { data_observed: '실제 데이터 확보', blocked: '접근 거절', reachable_without_offering_data: '데이터 미확보', attempt_without_response: '응답 미확보', not_reverified: '미재검증' };
  const summary = dataset.summary;
  return [`# CPS 112곳 재검증 현황`, '', `생성 시각: ${dataset.generatedAt}`, '',
    `실제 상품·서비스 데이터 ${summary.dataMerchants}곳, 가격 ${summary.priceMerchants}곳, 평점·건수 ${summary.ratingMerchants}곳, 리뷰 표본 ${summary.reviewSampleMerchants}곳.`, '',
    `상품·서비스 ${summary.entityCounts.commercialOfferings}개, 옵션 ${summary.entityCounts.productVariants}개, 가격 관측 ${summary.entityCounts.offerObservations}건, 리뷰 표본 ${summary.entityCounts.reviewObservations}건.`, '',
    `소비자 상품 URL이 관측된 항목 ${summary.offeringsWithCanonicalUrl}개, URL 없이 출처 내 상품 ID로 연결된 항목 ${summary.offeringsWithoutCanonicalUrl}개입니다. API 조회 주소를 소비자 상품 링크로 대체하지 않습니다.`, '',
    '전체 카탈로그·전체 리뷰 수집 완료를 뜻하지 않습니다. 아래 가격 수는 통화와 수치가 함께 확인된 관측 건수입니다. 데이터가 확보된 곳도 일부 경로가 차단될 수 있으며, 원본 배치와 coverage.json에 표시합니다.', '',
    `원요청 시각이 없는 기존 응답 기록은 ${summary.merchantsWithoutDatedReceipts}곳입니다. 시각을 새로 만들어 채우지 않으며, 해당 기록을 이번 실행의 새 HTTP 응답으로 간주하지 않습니다.`, '',
    '| 판매처 | ID | 상품·서비스 | 상품 URL | 숫자 가격 | 평점·건수 | 리뷰 표본 | 상태 | 최근 요청 UTC | 원본 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
    ...dataset.coverage.map(row => `| ${clean(row.name)} | ${row.merchantId} | ${row.counts.offerings} | ${row.counts.canonicalUrls} | ${row.counts.prices} | ${row.counts.ratings} | ${row.counts.reviews} | ${states[row.status] ?? row.status}${row.blockedEncountered && row.counts.offerings ? ' / 일부 접근 거절' : ''} | ${row.lastRequestObservedAt ?? '기록 시각 없음'} | [배치 ${row.batchId}](batch-${row.batchId}.json) |`), '',
    '## 사용', '',
    '- `ontology.json`: 엔티티·관계·근거 전체 그래프',
    '- `ontology.jsonl`: 데이터베이스 적재용',
    '- `coverage.json`: 상태와 수량을 프로그램에서 읽는 형식',
    '- [수집·조회 명령](../../docs/cps-commerce-ontology.md)', '',
  ].join('\n');
}

export function writeDataset({ outputDirectory = BATCH_DIRECTORY } = {}) {
  const dataset = readDataset();
  const validation = validateOntologyDataset(dataset);
  if (!validation.ok) throw Object.assign(new Error('CPS_DATASET_VALIDATION_FAILED'), { details: validation });
  mkdirSync(outputDirectory, { recursive: true });
  const graphPath = path.join(outputDirectory, 'ontology.json');
  const jsonlPath = path.join(outputDirectory, 'ontology.jsonl');
  const coveragePath = path.join(outputDirectory, 'coverage.json');
  const reportPath = path.join(outputDirectory, 'coverage.md');
  atomicWrite(graphPath, JSON.stringify(dataset, null, 2) + '\n');
  atomicWrite(jsonlPath, ontologyJsonLines(dataset));
  atomicWrite(coveragePath, JSON.stringify({ ontologyId: dataset.ontologyId, generatedAt: dataset.generatedAt, summary: dataset.summary, coverage: dataset.coverage, quarantine: dataset.quarantine }, null, 2) + '\n');
  atomicWrite(reportPath, coverageMarkdown(dataset));
  return { ok: true, summary: dataset.summary, validation, files: [graphPath, jsonlPath, coveragePath, reportPath].map(relative) };
}

const blockedStatus = row => /block|challenge|reject|rate.limit|http_(401|403|418|429)/i.test(String(row?.status ?? ''))
  || (row?.receipts ?? []).some(receipt => [401, 403, 418, 429].includes(receipt.responseStatus ?? receipt.status ?? receipt.httpStatus));

/** A rejected origin never grants permission to retry it through another recipe. */
export function independentRefreshAllowed(merchantId, adapter, previous) {
  const origins = merchantId === 'coupang' ? ['https://partners.coupang.com']
    : merchantId === 'nbtnaver' ? ['https://shopping.naver.com', 'https://vertical-api.shopping.naver.com']
      : merchantId === 'emart' ? ['https://search.ssg.com'] : null;
  if (!origins || !adapter.refreshableAfterPublicBlockMerchants?.includes(merchantId)) return false;
  return !(previous?.receipts ?? []).some(receipt => {
    if (![401, 403, 418, 429].includes(receipt.responseStatus ?? receipt.status ?? receipt.httpStatus)) return false;
    try { return origins.includes(new URL(receipt.finalUrl ?? receipt.requestUrl ?? receipt.requestedUrl ?? receipt.url).origin); }
    catch { return true; }
  });
}

const NATIVE_RECOVERY_ROOT_URLS = Object.freeze({
  ohouse: 'https://ohou.se/',
  kbbook: 'https://www.kyobobook.co.kr/',
});

/** Narrow evidence-backed native-recovery path for the approved observed origins with fresh anonymous success. */
export function nativeRecoveryAllowed(merchantId, adapter, previous) {
  if (!['ohouse', 'kbbook'].includes(merchantId)) return false;
  if (!adapter?.nativeRecoveryMerchants?.includes(merchantId)) return false;
  const approvedUrl = NATIVE_RECOVERY_ROOT_URLS[merchantId];
  if (!approvedUrl) return false;
  if (!previous || !Array.isArray(previous.receipts) || !Array.isArray(previous.records)) return false;

  const receipts = previous.receipts;
  const records = previous.records;

  // Must deny if any native rejection or challenge exists, or visible challenge on any receipt:
  const hasRejectionOrChallenge = receipts.some(receipt => {
    const status = receipt.responseStatus ?? receipt.status ?? receipt.httpStatus;
    const isRejection = [401, 403, 418, 429].includes(status);
    const isChallenge = receipt.stopReason === 'VISIBLE_CHALLENGE' || receipt.challenge === true;
    if (receipt.transport === 'native_recovery_fetch' && (isRejection || isChallenge)) return true;
    if (isChallenge) return true;
    return false;
  });
  if (hasRejectionOrChallenge) return false;

  // Do not start native recovery after another transport is rejected in the same run:
  const hasSameRunTransportRejection = receipts.some(receipt => {
    if (receipt.transport === 'native_recovery_fetch') return false;
    const status = receipt.responseStatus ?? receipt.status ?? receipt.httpStatus;
    if (![401, 403, 418, 429].includes(status)) return false;
    return receipt.sameRunRejection === true;
  });
  if (hasSameRunTransportRejection) return false;

  // Find an actual previous successful anonymous native root receipt on the exact approved root URL
  const validRootReceipt = receipts.find(receipt => {
    if (receipt.requestUrl !== approvedUrl) return false;
    if (receipt.finalUrl && receipt.finalUrl !== approvedUrl) return false;
    if (receipt.transport !== 'native_recovery_fetch') return false;

    const status = receipt.responseStatus ?? receipt.status ?? receipt.httpStatus;
    if (status !== 200) return false;
    if (receipt.stopReason != null || receipt.challenge === true) return false;
    if (receipt.browserUsed !== false || receipt.cookiesSent !== false || receipt.authorizationSent !== false) return false;

    // Timestamp must be a valid date string
    const observedAt = receipt.observedAt ?? receipt.checkedAt;
    if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) return false;

    // SHA-256 must be exactly 64-char hex string
    if (typeof receipt.responseSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(receipt.responseSha256)) return false;

    // Must be linked to an existing record by field evidence (real source ID/title and non-empty locator string)
    const receiptId = receipt.id ?? receipt.receiptId;
    if (!receiptId) return false;

    const hasLinkedRecord = records.some(rec => {
      if (!rec.sourceLocalId || !rec.title) return false;
      return (rec.evidence ?? []).some(ev =>
        ev.receiptId === receiptId &&
        typeof ev.locator === 'string' &&
        ev.locator.trim().length > 0 &&
        ev.fields?.includes('sourceLocalId') &&
        ev.fields?.includes('title')
      );
    });

    return hasLinkedRecord;
  });

  if (!validRootReceipt) return false;
  return true;
}

/** Appending pages retains their original evidence and observation timestamps. */
export function appendMerchantReport(previous, current) {
  if (!previous) return current;
  if (previous.merchantId !== current.merchantId) throw new Error('CANNOT_APPEND_DIFFERENT_MERCHANT');
  const unique = (rows, key) => [...new Map(rows.map(row => [key(row), row])).values()];
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { ...current,
    records: unique([...(previous.records ?? []), ...(current.records ?? [])], digest),
    receipts: unique([...(previous.receipts ?? []), ...(current.receipts ?? [])], receipt => receipt.id ?? receipt.receiptId ?? digest(receipt)),
    contracts: unique([...(previous.contracts ?? []), ...(current.contracts ?? [])], digest),
    frontier: unique([...(previous.frontier ?? []), ...(current.frontier ?? [])], digest),
    retainedObservations: { previousRecordCount: previous.records?.length ?? 0, previousCheckedAt: previous.checkedAt ?? null,
      currentRecordCount: current.records?.length ?? 0, observationTimesPreserved: true },
  };
}

export function parseCollectOptions(merchantId, argumentsList) {
  const options = {};
  let append = false;
  const definitions = {
    wconcept: { page: ['page', 1, 10000], 'page-size': ['pageSize', 1, 60] },
    lfmall: { query: ['keyword', 'text', 40], limit: ['productLimit', 1, 40], 'detail-limit': ['detailLimit', 0, 5], 'review-limit': ['reviewPageSize', 1, 8] },
    coupang: { query: ['query', 'text', 120] },
  }[merchantId] ?? {};
  const seen = new Set();
  for (const argument of argumentsList) {
    if (argument === '--append') { append = true; continue; }
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (!match || !definitions[match[1]] || seen.has(match[1])) throw new Error('UNSUPPORTED_OR_DUPLICATE_COLLECT_OPTION');
    seen.add(match[1]);
    const [name, minimum, maximum] = definitions[match[1]];
    if (minimum === 'text') {
      if (!match[2].trim() || match[2].length > maximum || /[\u0000-\u001f\u007f]/.test(match[2])) throw new Error('COLLECT_QUERY_INVALID');
      options[name] = match[2].trim();
    } else {
      const value = /^\d+$/.test(match[2]) ? Number(match[2]) : NaN;
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('COLLECT_OPTION_OUT_OF_RANGE');
      options[name] = value;
    }
  }
  return { options, append };
}

/** Refresh explicit merchant recipes. Prior rejected hosts are left stopped. */
async function collectMerchantReportsUnlocked(merchantId, { onProgress = () => {}, options = {}, append = false } = {}) {
  const ids = new Set(readJson(SOURCE_MAP).merchants.map(row => row.affiliateProgram.merchantId));
  if (merchantId !== 'all' && !ids.has(merchantId)) throw new Error('MERCHANT_NOT_IN_CPS_SNAPSHOT');
  const outcomes = [];
  for (let index = 1; index <= 8; index += 1) {
    const batchId = String(index).padStart(2, '0');
    const file = path.join(BATCH_DIRECTORY, `batch-${batchId}.json`);
    const prior = existsSync(file) ? readJson(file) : { schemaVersion: 2, batchId, merchants: [] };
    // The verified snapshot has fourteen assigned merchants per batch. A scoped
    // refresh need not load unrelated adapters while they are being maintained.
    if (merchantId !== 'all' && prior.merchants.length === 14 && !prior.merchants.some(row => row.merchantId === merchantId)) continue;
    const adapterFile = path.join(APP, 'adapters', 'cps-vendors', `batch-${batchId}.mjs`);
    if (!existsSync(adapterFile)) continue;
    const adapter = await import(pathToFileURL(adapterFile).href);
    if (!Array.isArray(adapter.merchantIds) || typeof adapter.collectMerchant !== 'function') throw new Error(`BATCH_INTERFACE_MISSING:${batchId}`);
    const selected = adapter.merchantIds.filter(id => merchantId === 'all' || id === merchantId);
    for (const id of selected) {
      const previous = prior.merchants.find(row => row.merchantId === id);
      const independentRoute = independentRefreshAllowed(id, adapter, previous);
      const nativeRoute = nativeRecoveryAllowed(id, adapter, previous);
      if (blockedStatus(previous) && !independentRoute && !nativeRoute) {
        const skipped = { merchantId: id, status: 'previous_rejection_retained', attempted: false };
        outcomes.push(skipped); onProgress(skipped); continue;
      }
      const attemptStartedAt = Date.now();
      let report = await adapter.collectMerchant(id, options);
      if (report?.merchantId !== id || !Array.isArray(report.receipts) || !Array.isArray(report.records)) throw new Error(`BATCH_RESULT_INVALID:${id}`);
      const freshReceipts = report.receipts.filter(receipt => {
        const observedAt = receipt.observedAt ?? receipt.checkedAt;
        return typeof observedAt === 'string' && Date.parse(observedAt) >= attemptStartedAt;
      });
      if (independentRoute && previous) {
        const receiptIds = new Set(report.receipts.map(receipt => receipt.id ?? receipt.receiptId));
        const rejections = (previous.receipts ?? []).filter(receipt => [401, 403, 418, 429].includes(receipt.responseStatus ?? receipt.status ?? receipt.httpStatus));
        for (const receipt of rejections) if (!receiptIds.has(receipt.id ?? receipt.receiptId)) report.receipts.push(receipt);
        if (rejections.length) report.frontier = [...(report.frontier ?? []), {
          operation: 'public_consumer_http', state: 'previous_origin_rejection_retained', retry: false,
          note: id === 'coupang' ? 'The independent owner-verified Partners web search does not request the rejected public consumer origin.'
            : id === 'emart' ? 'The observed public search.ssg.com API does not request the rejected www.ssg.com product detail origin.'
              : 'The public Shopping listing recipe does not request the rejected search, brand-review, or SmartStore detail origins.',
        }];
      }
      if (nativeRoute && previous) {
        const receiptIds = new Set(report.receipts.map(receipt => receipt.id ?? receipt.receiptId));
        const rejections = (previous.receipts ?? []).filter(receipt => [401, 403, 418, 429].includes(receipt.responseStatus ?? receipt.status ?? receipt.httpStatus));
        for (const receipt of rejections) if (!receiptIds.has(receipt.id ?? receipt.receiptId)) report.receipts.push(receipt);
        if (report.records.length > 0) {
          report.frontier = [...(report.frontier ?? []), {
            operation: 'native_http_recovery', state: 'previous_rejection_retained_ordinary_native_http', retry: false,
            note: 'Ordinary native Node fetch observed public offering data; does not assert that the prior block was solved.',
          }];
        }
      }
      if (append) report = appendMerchantReport(previous, report);
      const position = prior.merchants.findIndex(row => row.merchantId === id);
      if (previous) {
        const historyDirectory = path.join(BATCH_DIRECTORY, 'history');
        mkdirSync(historyDirectory, { recursive: true });
        atomicWrite(path.join(historyDirectory, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`), JSON.stringify(previous, null, 2) + '\n');
      }
      if (position >= 0) prior.merchants[position] = report; else prior.merchants.push(report);
      prior.checkedAt = new Date().toISOString();
      prior.checkedAtSemantics = 'batch_last_updated_at; use merchant and evidence timestamps for data freshness';
      prior.refreshScope = { requested: merchantId, partial: merchantId !== 'all',
        refreshedMerchantIds: [...outcomes.filter(row => row.attempted).map(row => row.merchantId).filter(value => adapter.merchantIds.includes(value)), ...(freshReceipts.length ? [id] : [])] };
      mkdirSync(BATCH_DIRECTORY, { recursive: true });
      atomicWrite(file, JSON.stringify(prior, null, 2) + '\n');
      const outcome = { merchantId: id, status: report.status, records: report.records.length, attempted: freshReceipts.length > 0,
        freshReceiptCount: freshReceipts.length, ...(freshReceipts.length ? {} : { evidenceReuse: 'no_new_request_receipt' }) };
      outcomes.push(outcome); onProgress(outcome);
    }
  }
  if (!outcomes.length) throw new Error('MERCHANT_ADAPTER_NOT_REGISTERED');
  return { ok: true, outcomes, export: writeDataset() };
}

export async function collectMerchantReports(merchantId, settings = {}) {
  const release = await acquireRunLock(path.join(BATCH_DIRECTORY, '.locks'));
  try { return await collectMerchantReportsUnlocked(merchantId, settings); }
  finally { await release(); }
}

export async function runCpsReverify(args = process.argv.slice(2)) {
  const [command, merchantId] = args;
  if (command === 'export') return writeDataset();
  if (command === 'coverage') {
    const dataset = readDataset();
    return { ok: true, summary: dataset.summary, coverage: dataset.coverage.filter(row => !merchantId || row.merchantId === merchantId), quarantine: dataset.quarantine };
  }
  if (command === 'query' && merchantId) return queryDataset(readDataset(), merchantId, {
    limit: args.find(value => value.startsWith('--limit='))?.slice(8),
    offset: args.find(value => value.startsWith('--offset='))?.slice(9),
  });
  if (command === 'collect' && merchantId) return collectMerchantReports(merchantId, {
    ...parseCollectOptions(merchantId, args.slice(2)),
    onProgress: value => process.stderr.write(JSON.stringify(value) + '\n'),
  });
  throw Object.assign(new Error('USAGE: cps-reverify.mjs export | coverage [merchantId] | query <merchantId> [--limit=N --offset=N] | collect <merchantId|all> [--append; source-specific options documented]'), { code: 'USAGE' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCpsReverify().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ ok: false, error: String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 300), details: error.details ?? null }));
    process.exitCode = 2;
  });
}
