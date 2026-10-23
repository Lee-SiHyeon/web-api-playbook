import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = 'https://data-api.ecb.europa.eu/service/data/EXR';

export class EcbRateError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EcbRateError';
    this.code = code;
    this.details = details;
  }
}

function splitCsvLine(line) {
  const output = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index++;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      output.push(current);
      current = '';
    } else current += character;
  }
  output.push(current);
  return output;
}

export function parseEcbCsv(text, { currency = 'KRW' } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new EcbRateError('EMPTY', 'ECB response was empty');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new EcbRateError('SCHEMA', 'ECB response did not contain observations');
  const headers = splitCsvLine(lines[0]);
  const index = Object.fromEntries(headers.map((header, position) => [header, position]));
  for (const field of ['KEY', 'CURRENCY', 'CURRENCY_DENOM', 'TIME_PERIOD', 'OBS_VALUE']) {
    if (!(field in index)) throw new EcbRateError('SCHEMA', `ECB response is missing ${field}`);
  }
  const observations = lines.slice(1).map(line => splitCsvLine(line)).map(values => ({
    key: values[index.KEY],
    currency: values[index.CURRENCY],
    denominator: values[index.CURRENCY_DENOM],
    date: values[index.TIME_PERIOD],
    value: Number(values[index.OBS_VALUE]),
    status: index.OBS_STATUS === undefined ? null : values[index.OBS_STATUS] || null,
  })).filter(item => (
    item.currency === currency
    && item.denominator === 'EUR'
    && /^\d{4}-\d{2}-\d{2}$/.test(item.date)
    && Number.isFinite(item.value)
    && item.value > 0
  ));
  if (!observations.length) throw new EcbRateError('SCHEMA', `No ECB ${currency}/EUR observations were found`);
  observations.sort((a, b) => a.date.localeCompare(b.date));
  const latest = observations.at(-1);
  return {
    baseCurrency: 'EUR',
    quoteCurrency: currency,
    quotePerBase: latest.value,
    referenceDate: latest.date,
    observationCount: observations.length,
    observations,
    sourceKind: 'official_reference_rate',
    settlementRate: false,
  };
}

export async function fetchEcbReferenceRate({
  currency = 'KRW',
  startPeriod = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!/^[A-Z]{3}$/.test(currency)) throw new EcbRateError('INPUT', 'currency must be a three-letter ISO code');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startPeriod)) throw new EcbRateError('INPUT', 'startPeriod must be YYYY-MM-DD');
  const key = `D.${currency}.EUR.SP00.A`;
  const url = new URL(`${endpoint}/${key}`);
  url.searchParams.set('startPeriod', startPeriod);
  url.searchParams.set('format', 'csvdata');
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'text/csv' },
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new EcbRateError('TRANSPORT', 'ECB reference-rate request failed');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new EcbRateError('HTTP_STATUS', 'ECB reference-rate request returned an unexpected status', {
      httpStatus: response.status,
    });
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new EcbRateError('SIZE', 'ECB response exceeded the size budget');
  return {
    ...parseEcbCsv(text, { currency }),
    checkedAt: new Date().toISOString(),
    receipt: {
      method: 'GET',
      origin: url.origin,
      path: url.pathname,
      queryFields: ['format', 'startPeriod'],
      httpStatus: response.status,
      responseContentType: response.headers.get('content-type') || null,
      responseBytes: Buffer.byteLength(text),
      browserUsed: false,
      credentialsUsed: false,
    },
  };
}

export function convertEurToKrw(amountEur, rate) {
  if (!Number.isFinite(amountEur) || amountEur < 0) throw new EcbRateError('INPUT', 'amountEur must be non-negative');
  if (!rate || rate.baseCurrency !== 'EUR' || rate.quoteCurrency !== 'KRW' || !Number.isFinite(rate.quotePerBase)) {
    throw new EcbRateError('INPUT', 'a valid EUR/KRW ECB rate is required');
  }
  return Math.round(amountEur * rate.quotePerBase);
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  const rate = await fetchEcbReferenceRate();
  const evidenceDir = path.join(root, 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  const stamp = rate.checkedAt.replace(/[-:.]/g, '').replace('Z', 'Z');
  const file = `ecb-eur-krw-${stamp}.json`;
  await writeFile(path.join(evidenceDir, file), JSON.stringify(rate, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({
    completed: true,
    referenceDate: rate.referenceDate,
    krwPerEur: rate.quotePerBase,
    evidenceFile: file,
    browserUsed: false,
    credentialsUsed: false,
  }));
}
