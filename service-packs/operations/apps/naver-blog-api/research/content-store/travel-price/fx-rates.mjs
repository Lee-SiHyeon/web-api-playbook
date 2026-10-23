import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEcbCsv } from '../../../../affiliate-api-hub/adapters/ecb-exchange-rates.mjs';
import { CAPTURE_DIR, readPublic, UA } from './probes/anonymous-http.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const ECB_ORIGIN = 'https://data-api.ecb.europa.eu';
const ECB_SERIES = Object.freeze({ USD: 'D.USD.EUR.SP00.A', KRW: 'D.KRW.EUR.SP00.A' });
const ECB_DAILY_XML_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DAILY_XML_BYTES = 512 * 1024;

function validDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function dayNumber(date) {
  return Date.parse(`${date}T00:00:00.000Z`) / 86400000;
}

function receiptFor(capture, currency, url, metadataCapture = null, queryFields = ['startPeriod', 'format'], responseFormat = 'text/csv') {
  const meta = capture?.meta ?? {};
  return {
    currency,
    method: meta.method ?? 'GET',
    url: meta.url ?? url,
    queryFields,
    checkedAt: meta.checkedAt ?? null,
    httpStatus: meta.status ?? null,
    responseContentType: meta.contentType ?? null,
    responseBytes: Number.isFinite(meta.bytes) ? meta.bytes : null,
    sha256: meta.sha256 ?? null,
    capture: meta.capture ?? null,
    metadataCapture: meta.capture ? meta.capture.replace(/\.[^.]+$/, '.meta.json') : metadataCapture,
    responseFormat,
    error: meta.error ?? null,
    requestHeaderNames: meta.requestHeaderNames ?? ['user-agent', 'accept-language', 'accept'],
    userAgent: UA,
    acceptLanguage: 'ko-KR,ko;q=0.9',
    minimumPerHostIntervalMs: 2050,
    browserUsed: false,
    credentialsUsed: false,
  };
}

async function findMetadataCapture(meta) {
  if (!meta?.checkedAt || !meta?.url || !meta?.seller || !meta?.name) return null;
  try {
    const names = await readdir(CAPTURE_DIR);
    for (const name of names) {
      if (!name.startsWith(`${meta.seller}-${meta.name}`) || !name.endsWith('.meta.json')) continue;
      const fullPath = path.join(CAPTURE_DIR, name);
      try {
        const saved = JSON.parse(await readFile(fullPath, 'utf8'));
        if (saved.checkedAt === meta.checkedAt && saved.url === meta.url) return fullPath;
      } catch {
        // Ignore incomplete or unrelated capture metadata files.
      }
    }
  } catch {
    // The read receipt still embeds its safe metadata if the temp capture directory is unavailable.
  }
  return null;
}

function ecbUrl(currency, startPeriod) {
  const url = new URL(`/service/data/EXR/${ECB_SERIES[currency]}`, ECB_ORIGIN);
  url.searchParams.set('startPeriod', startPeriod);
  url.searchParams.set('format', 'csvdata');
  return url;
}

function parseXmlAttributes(source) {
  const attributes = Object.create(null);
  const expression = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(expression)) attributes[match[1]] = match[2] ?? match[3];
  return attributes;
}

/** Parse ECB daily XML without a general XML entity-expanding parser. */
export function parseEcbDailyXml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw new TypeError('ECB daily XML response must be a non-empty string');
  if (Buffer.byteLength(xml) > MAX_DAILY_XML_BYTES) throw new TypeError('ECB daily XML response exceeded the size budget');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || /<!\[CDATA\[/i.test(xml)) {
    throw new TypeError('ECB daily XML must not contain a document type, entity, or CDATA section');
  }
  const source = xml.replace(/<!--[\s\S]*?-->/g, '');
  const tags = [...source.matchAll(/<\s*(\/?)\s*Cube\b([^>]*)>/gi)];
  if (!tags.length) throw new TypeError('ECB daily XML did not contain Cube observations');

  const stack = [];
  const contexts = [];
  for (const match of tags) {
    const closing = match[1] === '/';
    const tagTail = match[2];
    if (closing) {
      if (!stack.length) throw new TypeError('ECB daily XML Cube nesting is malformed');
      stack.pop();
      continue;
    }
    const attributes = parseXmlAttributes(tagTail);
    const selfClosing = /\/\s*$/.test(tagTail);
    if (attributes.time !== undefined) {
      if (!validDateOnly(attributes.time)) throw new TypeError('ECB daily XML contains an invalid Cube date');
      const context = { date: attributes.time, rates: Object.create(null) };
      contexts.push(context);
      if (!selfClosing) stack.push(context);
      continue;
    }
    if (attributes.currency !== undefined) {
      const currency = attributes.currency.toUpperCase();
      if (currency === 'USD' || currency === 'KRW') {
        const parent = [...stack].reverse().find(item => item.date);
        const rawRate = attributes.rate;
        if (!parent || typeof rawRate !== 'string' || !/^\d+(?:\.\d+)?$/.test(rawRate)) {
          throw new TypeError(`ECB daily XML contains an invalid ${currency} rate`);
        }
        const rate = Number(rawRate);
        if (!Number.isFinite(rate) || rate <= 0 || parent.rates[currency] !== undefined) {
          throw new TypeError(`ECB daily XML contains an invalid or duplicate ${currency} rate`);
        }
        parent.rates[currency] = rate;
      }
    }
    if (!selfClosing) stack.push({ date: null, rates: null });
  }
  if (stack.length) throw new TypeError('ECB daily XML Cube nesting is incomplete');

  const observations = contexts
    .filter(item => Number.isFinite(item.rates.USD) && Number.isFinite(item.rates.KRW))
    .map(item => ({ date: item.date, usdPerEur: item.rates.USD, krwPerEur: item.rates.KRW }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!observations.length) throw new TypeError('ECB daily XML did not contain same-date USD and KRW observations');
  return {
    baseCurrency: 'EUR',
    referenceDate: observations.at(-1).date,
    observationCount: observations.length,
    observations,
    sourceKind: 'official_reference_rate',
    settlementRate: false,
  };
}

async function readSeries(currency, startPeriod, readPublicImpl) {
  const url = ecbUrl(currency, startPeriod);
  let capture;
  try {
    capture = await readPublicImpl('ecb-exchange-rates', `usdkrw-${currency.toLowerCase()}-eur`, url.href, {
      method: 'GET',
      accept: 'text/csv',
    });
  } catch (error) {
    return {
      currency,
      receipt: receiptFor(null, currency, url.href),
      data: null,
      errorCode: error?.code ?? error?.name ?? 'READ_FAILED',
    };
  }

  const receipt = receiptFor(capture, currency, url.href, await findMetadataCapture(capture?.meta));
  const text = typeof capture?.text === 'string' ? capture.text : '';
  const responseBytes = Number.isFinite(receipt.responseBytes) ? receipt.responseBytes : Buffer.byteLength(text);
  if (receipt.httpStatus !== 200 || receipt.error) {
    return {
      currency,
      receipt,
      data: null,
      errorCode: receipt.error?.code ?? receipt.error?.name ?? (receipt.httpStatus === null ? 'TRANSPORT' : 'HTTP_STATUS'),
    };
  }
  if (responseBytes > MAX_RESPONSE_BYTES) {
    return { currency, receipt, data: null, errorCode: 'SIZE' };
  }
  try {
    return { currency, receipt, data: parseEcbCsv(text, { currency }), errorCode: null };
  } catch (error) {
    return { currency, receipt, data: null, errorCode: error?.code ?? 'SCHEMA' };
  }
}

function pairedObservations(usd, krw, observationDate) {
  if (!usd || !krw) return [];
  const usdByDate = new Map(usd.observations.map(item => [item.date, item]));
  return krw.observations
    .filter(item => item.date <= observationDate && usdByDate.has(item.date))
    .map(krwItem => ({ date: krwItem.date, usdPerEur: usdByDate.get(krwItem.date).value, krwPerEur: krwItem.value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Fetches the two ECB daily reference series needed for the same-date USD/KRW
 * cross rate. The only network access is an anonymous GET through the shared
 * travel-price public reader, which retains response captures and metadata.
 */
export async function fetchUsdKrwReference({
  observationDate,
  startPeriod = '2026-09-12',
  maxStalenessDays = 3,
  readPublicImpl = readPublic,
} = {}) {
  if (!validDateOnly(observationDate)) throw new TypeError('observationDate must be a real YYYY-MM-DD date');
  if (!validDateOnly(startPeriod) || startPeriod > observationDate) throw new TypeError('startPeriod must be a real date on or before observationDate');
  if (!Number.isInteger(maxStalenessDays) || maxStalenessDays < 0) throw new TypeError('maxStalenessDays must be a non-negative integer');
  if (typeof readPublicImpl !== 'function') throw new TypeError('readPublicImpl must be a function');

  const usdRead = await readSeries('USD', startPeriod, readPublicImpl);
  const krwRead = await readSeries('KRW', startPeriod, readPublicImpl);
  const pairs = pairedObservations(usdRead.data, krwRead.data, observationDate);
  const latestPair = pairs.at(-1) ?? null;
  const ageDays = latestPair ? dayNumber(observationDate) - dayNumber(latestPair.date) : null;
  const observedCross = latestPair ? latestPair.krwPerEur / latestPair.usdPerEur : null;
  const usable = latestPair !== null && ageDays >= 0 && ageDays <= maxStalenessDays;
  const observationDay = new Date(`${observationDate}T00:00:00.000Z`).getUTCDay();
  const weekendObservation = observationDay === 0 || observationDay === 6;
  let note;
  if (!latestPair) {
    const failedSeries = [usdRead, krwRead].filter(item => !item.data);
    note = failedSeries.length
      ? `A same-date ECB pair could not be established because ${failedSeries.map(item => `${item.currency}/EUR failed (${item.errorCode})`).join(' and ')}. No FX rate was inferred.`
      : 'No same-date USD/EUR and KRW/EUR ECB observations were available on or before the observation date; no FX rate was inferred.';
  } else if (weekendObservation && latestPair.date < observationDate) {
    note = `The observation date ${observationDate} is a weekend. ${latestPair.date} is the latest paired ECB business-day reference date (${ageDays} calendar day(s) old); no weekend rate was synthesized.`;
  } else if (latestPair.date < observationDate) {
    note = `The latest paired ECB reference date is ${latestPair.date}, ${ageDays} calendar day(s) before observation date ${observationDate}; this is an official reference rate, not a card or settlement rate.`;
  } else {
    note = 'The paired ECB reference date matches the observation date; this is an official reference rate, not a card or settlement rate.';
  }
  if (latestPair && !usable) note += ` It exceeds the ${maxStalenessDays}-day freshness limit, so payable conversion is blocked.`;

  const checkedAt = [usdRead.receipt.checkedAt, krwRead.receipt.checkedAt].filter(Boolean).sort().at(-1) ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    sourceKind: 'official_reference_rate',
    provider: 'European Central Bank',
    observationDate,
    requestedStartPeriod: startPeriod,
    checkedAt,
    baseCurrency: 'USD',
    quoteCurrency: 'KRW',
    status: !latestPair ? 'unavailable' : usable ? 'usable' : 'stale',
    reason: !latestPair ? 'no_paired_reference_observation' : usable ? null : 'stale_reference_rate',
    quotePerBase: usable ? observedCross : null,
    observedQuotePerBase: observedCross,
    referenceDate: latestPair?.date ?? null,
    ageDays,
    maxStalenessDays,
    usable,
    stale: latestPair !== null && latestPair.date < observationDate,
    weekendObservation,
    settlementRate: false,
    note,
    crossRate: {
      formula: 'KRW per USD = same-date KRW per EUR / USD per EUR',
      usdPerEur: latestPair?.usdPerEur ?? null,
      krwPerEur: latestPair?.krwPerEur ?? null,
      pairedObservationCount: pairs.length,
      latestProviderDates: {
        usdEur: usdRead.data?.referenceDate ?? null,
        krwEur: krwRead.data?.referenceDate ?? null,
      },
    },
    receipts: [usdRead.receipt, krwRead.receipt],
    readErrors: [usdRead, krwRead].filter(item => item.errorCode).map(({ currency, errorCode }) => ({ currency, errorCode })),
    browserUsed: false,
    credentialsUsed: false,
  };
}

/** One-request ECB daily XML fallback for cases where the paired EXR CSV series cannot be read. */
export async function fetchUsdKrwDailyXmlReference({
  observationDate,
  maxStalenessDays = 3,
  readPublicImpl = readPublic,
} = {}) {
  if (!validDateOnly(observationDate)) throw new TypeError('observationDate must be a real YYYY-MM-DD date');
  if (!Number.isInteger(maxStalenessDays) || maxStalenessDays < 0) throw new TypeError('maxStalenessDays must be a non-negative integer');
  if (typeof readPublicImpl !== 'function') throw new TypeError('readPublicImpl must be a function');

  let capture;
  let thrownError = null;
  try {
    capture = await readPublicImpl('ecb-exchange-rates', 'usdkrw-daily-xml', ECB_DAILY_XML_URL, {
      method: 'GET',
      accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1',
    });
  } catch (error) {
    thrownError = error;
  }
  const receipt = receiptFor(capture, 'USD+KRW', ECB_DAILY_XML_URL, await findMetadataCapture(capture?.meta), [], 'text/xml');
  let parsed = null;
  let readErrorCode = thrownError?.code ?? thrownError?.name ?? null;
  if (!thrownError && receipt.httpStatus === 200 && !receipt.error) {
    const xml = typeof capture?.text === 'string' ? capture.text : '';
    const byteLength = Number.isFinite(receipt.responseBytes) ? receipt.responseBytes : Buffer.byteLength(xml);
    if (byteLength > MAX_DAILY_XML_BYTES) readErrorCode = 'SIZE';
    else {
      try {
        parsed = parseEcbDailyXml(xml);
      } catch (error) {
        readErrorCode = error?.name === 'TypeError' ? 'XML_SCHEMA' : error?.code ?? 'XML_SCHEMA';
      }
    }
  } else if (!thrownError) {
    readErrorCode = receipt.error?.code ?? receipt.error?.name ?? (receipt.httpStatus === null ? 'TRANSPORT' : 'HTTP_STATUS');
  }

  const pairs = (parsed?.observations ?? []).filter(item => item.date <= observationDate);
  const latestPair = pairs.at(-1) ?? null;
  const ageDays = latestPair ? dayNumber(observationDate) - dayNumber(latestPair.date) : null;
  const observedCross = latestPair ? latestPair.krwPerEur / latestPair.usdPerEur : null;
  const usable = latestPair !== null && ageDays >= 0 && ageDays <= maxStalenessDays;
  const weekendObservation = [0, 6].includes(new Date(`${observationDate}T00:00:00.000Z`).getUTCDay());
  let note;
  if (!latestPair && readErrorCode) {
    note = `The ECB daily XML fallback could not provide a paired USD/KRW observation (${readErrorCode}); no FX rate was inferred.`;
  } else if (!latestPair) {
    note = 'The ECB daily XML contained no paired USD/EUR and KRW/EUR observation on or before the observation date; no FX rate was inferred.';
  } else if (weekendObservation && latestPair.date < observationDate) {
    note = `The observation date ${observationDate} is a weekend. ${latestPair.date} is the latest paired ECB business-day reference date (${ageDays} calendar day(s) old); no weekend rate was synthesized.`;
  } else if (latestPair.date < observationDate) {
    note = `The latest paired ECB daily XML reference date is ${latestPair.date}, ${ageDays} calendar day(s) before observation date ${observationDate}; this is an official reference rate, not a card or settlement rate.`;
  } else {
    note = 'The paired ECB daily XML reference date matches the observation date; this is an official reference rate, not a card or settlement rate.';
  }
  if (latestPair && !usable) note += ` It exceeds the ${maxStalenessDays}-day freshness limit, so payable conversion is blocked.`;

  const readErrors = readErrorCode ? [{ currency: 'USD+KRW', errorCode: readErrorCode }] : [];
  return {
    schemaVersion: 1,
    sourceKind: 'official_reference_rate',
    provider: 'European Central Bank',
    source: 'daily XML reference rates',
    observationDate,
    checkedAt: receipt.checkedAt ?? new Date().toISOString(),
    baseCurrency: 'USD',
    quoteCurrency: 'KRW',
    status: !latestPair ? 'unavailable' : usable ? 'usable' : 'stale',
    reason: !latestPair ? 'no_paired_reference_observation' : usable ? null : 'stale_reference_rate',
    quotePerBase: usable ? observedCross : null,
    observedQuotePerBase: observedCross,
    referenceDate: latestPair?.date ?? null,
    ageDays,
    maxStalenessDays,
    usable,
    stale: latestPair !== null && latestPair.date < observationDate,
    weekendObservation,
    settlementRate: false,
    note,
    crossRate: {
      formula: 'KRW per USD = same-date KRW per EUR / USD per EUR',
      usdPerEur: latestPair?.usdPerEur ?? null,
      krwPerEur: latestPair?.krwPerEur ?? null,
      pairedObservationCount: pairs.length,
      latestProviderDates: {
        usdEur: parsed?.referenceDate ?? null,
        krwEur: parsed?.referenceDate ?? null,
      },
    },
    receipt,
    receipts: [receipt],
    readErrors,
    browserUsed: false,
    credentialsUsed: false,
  };
}

/** Run the EXR CSV pair first, then use the single-request XML fallback when needed. */
export async function fetchUsdKrwReferenceWithFallback({
  observationDate,
  startPeriod = '2026-09-12',
  maxStalenessDays = 3,
  readPublicImpl = readPublic,
  primaryFetch = fetchUsdKrwReference,
  fallbackFetch = fetchUsdKrwDailyXmlReference,
} = {}) {
  if (typeof primaryFetch !== 'function') throw new TypeError('primaryFetch must be a function');
  const primary = await primaryFetch({ observationDate, startPeriod, maxStalenessDays, readPublicImpl });
  if (primary.usable || typeof fallbackFetch !== 'function') {
    return { ...primary, fallbackAttempted: false, fallbackUsed: false };
  }
  const fallback = await fallbackFetch({ observationDate, maxStalenessDays, readPublicImpl });
  const selected = fallback.usable ? fallback : primary;
  return {
    ...selected,
    fallbackAttempted: true,
    fallbackUsed: fallback.usable,
    primaryResult: primary,
    fallbackResult: fallback,
    fallbackReceipt: fallback.receipt ?? fallback.receipts?.[0] ?? null,
    receipts: [...(primary.receipts ?? []), ...(fallback.receipts ?? [])],
    primaryReadErrors: primary.readErrors ?? [],
    fallbackReadErrors: fallback.readErrors ?? [],
  };
}

/** Convert a known USD local fee to whole KRW; return null when evidence or FX is unusable. */
export function convertLocalFee(fee, fx) {
  if (!fee || typeof fee !== 'object' || Array.isArray(fee)) return null;
  const amount = fee.amount;
  const currency = typeof fee.currency === 'string' ? fee.currency.trim().toUpperCase() : '';
  if (!Number.isFinite(amount) || amount < 0 || currency !== 'USD') return null;
  if (!fx || fx.usable !== true || fx.baseCurrency !== 'USD' || fx.quoteCurrency !== 'KRW') return null;
  if (!Number.isFinite(fx.quotePerBase) || fx.quotePerBase <= 0) return null;
  const converted = Math.round(amount * fx.quotePerBase);
  return Number.isSafeInteger(converted) ? converted : null;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) {
  const result = await fetchUsdKrwReferenceWithFallback({ observationDate: '2026-10-03', startPeriod: '2026-09-12' });
  await writeFile(path.join(directory, 'fx-reference.result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    completed: true,
    observationDate: result.observationDate,
    referenceDate: result.referenceDate,
    usdKrwPerUsd: result.quotePerBase,
    usable: result.usable,
    requestCount: result.receipts.length,
    resultFile: 'fx-reference.result.json',
  }));
}
