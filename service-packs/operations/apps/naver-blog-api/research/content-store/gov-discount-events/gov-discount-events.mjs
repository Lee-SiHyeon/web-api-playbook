import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeHtmlEvents } from './html-event-records.mjs';
import { collectGovPressSource, GOV_PRESS_SOURCE_URLS } from './gov-press-html.mjs';
import { pressEventsFromCollection } from './press-event-facts.mjs';

export { parseGovPressList, parseGovPressDetail, collectGovPressSource, collectGovPressArticle, collectKoreaPolicyNews, GOV_PRESS_SELECTOR_MAPS } from './gov-press-html.mjs';
import { createPublicClient, DEFAULT_CAPTURE_DIR } from './html-public.mjs';
import { collectFsaleHtml } from './fsale-html.mjs';
import { collectFoodnuriSaleList } from './foodnuri-html.mjs';

export const CAMPAIGN_LIST_URL = 'https://k-shoppingfesta.org/v1/app/dhfesta/campn/lst';
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function parseDate(value) {
  const match = String(value ?? '').match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function parsePeriod(raw, startRaw, endRaw) {
  const matches = [...String(raw ?? '').matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)].map(match => match[0]);
  return {
    startDate: parseDate(matches[0]) ?? parseDate(startRaw),
    endDate: parseDate(matches[1]) ?? parseDate(endRaw),
    periodRaw: raw == null ? null : String(raw)
  };
}

function campaignStatus(startDate, endDate, checkedAt, item) {
  if (item.useYn === 'N' || item.expsrYn === 'N') return 'not_listed';
  if (!startDate || !endDate) return 'unknown';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(checkedAt));
  if (endDate < today) return 'ended';
  if (startDate > today) return 'upcoming';
  return 'active';
}

/** Pure parser for the public campaign-list JSON. It preserves source title/period text. */
export function parseCampaignList(input, { checkedAt = new Date().toISOString(), sourceUrl = CAMPAIGN_LIST_URL } = {}) {
  const payload = typeof input === 'string' ? JSON.parse(input) : input;
  if (!payload || typeof payload !== 'object') throw new Error('CAMPAIGN_RESPONSE_INVALID');
  if (Number(payload.status?.code) !== 200) throw new Error('CAMPAIGN_APPLICATION_STATUS_NOT_OK');
  if (!Array.isArray(payload.data?.items)) throw new Error('CAMPAIGN_ITEMS_MISSING');

  const records = payload.data.items.map(item => {
    const { startDate, endDate, periodRaw } = parsePeriod(item.campnDur, item.strtDt, item.endDt);
    const year = startDate?.slice(0, 4) ?? endDate?.slice(0, 4) ?? null;
    return {
      id: item.campnId == null ? null : `dh-festival-${item.campnId}`,
      campaignId: item.campnId ?? null,
      title: item.campnNm ?? null,
      summary: item.campnTitCn ?? null,
      description: item.campnMainDesc ?? item.campnDesc ?? null,
      periodRaw,
      startDate,
      endDate,
      activitiesRaw: item.campnPrimCn ?? null,
      locationRaw: item.campnPlc ?? null,
      visible: item.expsrYn === 'Y',
      enabled: item.useYn === 'Y',
      status: campaignStatus(startDate, endDate, checkedAt, item),
      inScope2025to2026: year === '2025' || year === '2026',
      ratePercent: null,
      capAmountKrw: null,
      sourceUrl,
      checkedAt
    };
  });

  return {
    checkedAt,
    sourceUrl,
    paging: {
      pageNo: payload.data.paging?.pageNo ?? null,
      pageSize: payload.data.paging?.pageSize ?? null,
      totalCount: payload.data.paging?.totalCount ?? records.length,
      hasMore: payload.data.paging?.hasMore ?? null
    },
    receivedCount: payload.data.items.length,
    parsedCount: records.length,
    inScopeCount: records.filter(record => record.inScope2025to2026).length,
    endedCount: records.filter(record => record.status === 'ended').length,
    upcomingOrActiveCount: records.filter(record => record.status === 'upcoming' || record.status === 'active').length,
    records
  };
}

function isChallenge(status, contentType, body) {
  if ([403, 418, 429, 503].includes(status)) return true;
  if (/text\/html/i.test(contentType ?? '') && /cloudflare|captcha|attention required|verify you are human/i.test(body.slice(0, 12000))) return true;
  return false;
}

function captureDirectory(env) {
  if (env.GOV_DISCOUNT_CAPTURE_DIR) return env.GOV_DISCOUNT_CAPTURE_DIR;
  const localAppData = env.LOCALAPPDATA || 'C:\\Users\\User\\AppData\\Local';
  return path.join(localAppData, 'Temp', 'gov-discount-captures');
}

async function saveResponse(body, meta, directory) {
  await fs.mkdir(directory, { recursive: true });
  const stamp = meta.time.replace(/[-:.TZ]/g, '').slice(0, 14);
  const base = `live-k-shoppingfesta-campaigns-${stamp}`;
  await fs.writeFile(path.join(directory, `${base}.raw`), body, 'utf8');
  await fs.writeFile(path.join(directory, `${base}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return { rawPath: path.join(directory, `${base}.raw`), metaPath: path.join(directory, `${base}.meta.json`) };
}

/** Performs one anonymous GET to the captured public campaign JSON endpoint. */
export async function collectCampaignList({ fetchImpl = fetch, env = process.env, now = () => new Date(), timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestedAt = now().toISOString();
  let response;
  let body = '';
  let error = null;
  try {
    response = await fetchImpl(CAMPAIGN_LIST_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-language': 'ko-KR,ko;q=0.9,en;q=0.6',
        'user-agent': BROWSER_UA
      },
      signal: controller.signal
    });
    body = await response.text();
  } catch (caught) {
    error = caught?.name === 'AbortError' ? 'TIMEOUT' : 'FETCH_FAILED';
  } finally {
    clearTimeout(timer);
  }

  const status = response?.status ?? null;
  const contentType = response?.headers?.get?.('content-type') ?? null;
  const meta = {
    url: CAMPAIGN_LIST_URL,
    method: 'GET',
    status,
    time: requestedAt,
    finalUrl: response?.url || CAMPAIGN_LIST_URL,
    contentType,
    bytes: Buffer.byteLength(body, 'utf8'),
    error
  };
  let captureFiles = null;
  try {
    captureFiles = await saveResponse(body, meta, captureDirectory(env));
  } catch {
    error = error ?? 'CAPTURE_SAVE_FAILED';
  }

  if (error) {
    return { status: error === 'FETCH_FAILED' || error === 'TIMEOUT' ? 'fetch_error' : 'capture_error', httpStatus: status, error, captureFiles };
  }
  if (isChallenge(status, contentType, body)) {
    return { status: 'challenge_blocked', httpStatus: status, captureFiles };
  }
  if (status !== 200 || !/application\/json/i.test(contentType ?? '')) {
    return { status: 'response_invalid', httpStatus: status, contentType, captureFiles };
  }

  try {
    const parsed = parseCampaignList(body, { checkedAt: requestedAt, sourceUrl: CAMPAIGN_LIST_URL });
    return { status: 'read', httpStatus: status, contentType, captureFiles, ...parsed };
  } catch {
    return { status: 'schema_error', httpStatus: status, contentType, captureFiles };
  }
}

/** Runs the anonymous Document-GET parsers for Fsale boards and Foodnuri's discount-item list. */
export async function collectHtmlSources({ client = createPublicClient({
  captureDir: DEFAULT_CAPTURE_DIR,
  requestLimit: 40,
  minIntervalMs: 2000,
  timeoutMs: 20000,
  allowedHosts: ['fsale.kr', 'sale.foodnuri.go.kr']
}) } = {}) {
  const fsale = await collectFsaleHtml({ client });
  const foodnuri = await collectFoodnuriSaleList({ client });
  const sources = {
    ...fsale.sources,
    foodnuri
  };
  const checkedAt = new Date().toISOString();
  return {
    checkedAt,
    status: Object.values(sources).every(source => source.status === 'read') ? 'read' : 'partial',
    executionMode: 'pure_http',
    remoteWrites: false,
    credentialAccess: false,
    requestCounts: Object.fromEntries(client.counts ?? []),
    sources,
    ...normalizeHtmlEvents(sources, { checkedAt })
  };
}

/** Public government article reads; raw-labeled benefits remain separate when rules differ. */
export async function collectPressSources({ sourceIds = Object.keys(GOV_PRESS_SOURCE_URLS).filter(id => id !== 'ministry-notices'), ...options } = {}) {
  const sources = {};
  const events = [];
  const checkedAt = new Date().toISOString();
  for (const sourceId of [...new Set(sourceIds)]) {
    const result = await collectGovPressSource(sourceId, options);
    sources[sourceId] = result;
    events.push(...pressEventsFromCollection(result, { checkedAt }).events);
  }
  return {
    checkedAt,
    status: Object.values(sources).every(source => source.status === 'usable_html') ? 'usable_html' : 'partial',
    executionMode: 'pure_http', remoteWrites: false, credentialAccess: false,
    sources, events,
    activeEvents: events.filter(event => event.status === 'active'),
    upcomingEvents: events.filter(event => event.status === 'upcoming')
  };
}

async function runCli(argv = process.argv.slice(2)) {
  if (argv[0] === 'collect-press') {
    const result = await collectPressSources(argv[1] ? { sourceIds: [argv[1]] } : {});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'usable_html') process.exitCode = 1;
    return;
  }
  if (argv[0] === 'collect-html') {
    const result = await collectHtmlSources();
    const fsale = result.sources['fsale-directmarket-board'];
    const coupon = result.sources['fsale-coupon-board'];
    const foodnuri = result.sources.foodnuri;
    const output = {
      status: result.status,
      executionMode: result.executionMode,
      remoteWrites: result.remoteWrites,
      credentialAccess: result.credentialAccess,
      requestCounts: result.requestCounts,
      activeEvents: result.activeEvents,
      upcomingEvents: result.upcomingEvents,
      fsale: {
        landing: result.sources['fsale-site'].status,
        couponViews: (coupon.pages ?? []).map(page => ({ categoryRaw: page.categoryRaw, totalCount: page.totalCount, parsedCount: page.parsedCount })),
        directmarket: { status: fsale.status, totalCount: fsale.totalCount, pageCount: fsale.pageCount, parsedCount: fsale.parsedCount, paginationComplete: fsale.paginationComplete },
        zero1: result.sources['fsale-zero-onnuri-boards'].boards.zero1.totalCount,
        onnuri1: result.sources['fsale-zero-onnuri-boards'].boards.onnuri1.totalCount
      },
      foodnuri: foodnuri.records?.map(({ pageType, periodRaw, periodStart, periodEnd, items, ratePercent, capAmountKrw }) => ({ pageType, periodRaw, periodStart, periodEnd, items, ratePercent, capAmountKrw })) ?? null,
      captureFiles: Object.fromEntries(Object.entries(result.sources).map(([key, source]) => [key, source.captureFiles ?? []]))
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (result.status !== 'read') process.exitCode = 1;
    return;
  }
  if (argv[0] !== 'collect') {
    process.stdout.write('Usage: node gov-discount-events.mjs collect | collect-html | collect-press [source-id]\n');
    process.exitCode = 64;
    return;
  }
  const result = await collectCampaignList();
  const output = {
    status: result.status,
    httpStatus: result.httpStatus ?? null,
    receivedCount: result.receivedCount ?? 0,
    parsedCount: result.parsedCount ?? 0,
    inScopeCount: result.inScopeCount ?? 0,
    endedCount: result.endedCount ?? 0,
    upcomingOrActiveCount: result.upcomingOrActiveCount ?? 0,
    campaignNamesAndPeriods: (result.records ?? []).map(({ title, periodRaw, status, inScope2025to2026 }) => ({ title, periodRaw, status, inScope2025to2026 })),
    captureFiles: result.captureFiles ?? null
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (result.status !== 'read') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch(error => {
    process.stderr.write((error?.message ?? 'GOV_DISCOUNT_EVENTS_FAILED') + '\n');
    process.exitCode = 1;
  });
}
