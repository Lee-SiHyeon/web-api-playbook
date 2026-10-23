import { assertStatus, fetchText, TrendSourceError } from '../lib/http.mjs';

export const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

export const SHOPPING_CATEGORIES = Object.freeze([
  { id: '50000000', name: '패션의류' },
  { id: '50000001', name: '패션잡화' },
  { id: '50000002', name: '화장품/미용' },
  { id: '50000003', name: '디지털/가전' },
  { id: '50000004', name: '가구/인테리어' },
  { id: '50000005', name: '출산/육아' },
  { id: '50000006', name: '식품' },
  { id: '50000007', name: '스포츠/레저' },
  { id: '50000008', name: '생활/건강' },
  { id: '50000009', name: '여가/생활편의' },
  { id: '50000010', name: '면세점' },
  { id: '50005542', name: '도서' },
]);

const allowedUnits = new Set(['date', 'week', 'month']);

function setCookieLines(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  if (!raw) return [];
  return raw.split(/,(?=\s*[A-Za-z0-9_!#$%&'*+.^`|~-]+=)/);
}

function cookiePair(line) {
  const pair = String(line || '').split(';', 1)[0].trim();
  return /^[A-Za-z0-9_!#$%&'*+.^`|~-]+=[^\r\n;]*$/.test(pair) ? pair : null;
}

export async function bootstrapAnonymousNaverSession({ fetchImpl = globalThis.fetch } = {}) {
  const { response } = await fetchText('https://lcs.naver.com/m?u=https%3A%2F%2Fdatalab.naver.com%2F', {
    headers: {
      'user-agent': CHROME_USER_AGENT,
      referer: 'https://datalab.naver.com/',
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
    fetchImpl,
  });
  assertStatus(response);
  const pairs = setCookieLines(response.headers).map(cookiePair).filter(Boolean);
  const names = pairs.map(pair => pair.slice(0, pair.indexOf('=')));
  if (!names.includes('NNB') || !names.includes('BUC')) {
    throw new TrendSourceError('SESSION_BOOTSTRAP', 'Naver anonymous trend session cookies were not issued', {
      cookieNamesPresent: names,
    });
  }
  return {
    cookieHeader: pairs.join('; '),
    evidence: {
      provider: 'naver_anonymous_cookie_bootstrap',
      cookieNamesPresent: names.sort(),
      cookieValuesPersisted: false,
      browserUsed: false,
    },
  };
}

export function parseShoppingRankResponse(text, { categoryId, categoryName, timeUnit }) {
  if (/<!doctype|<html/i.test(text)) {
    throw new TrendSourceError('APPLICATION_HTML', 'Naver Shopping Insight returned an HTML fallback instead of rank data');
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new TrendSourceError('SCHEMA', 'Naver Shopping Insight response was not valid JSON');
  }
  if (!Array.isArray(payload) || payload.some(item => !item || !Array.isArray(item.ranks))) {
    throw new TrendSourceError('SCHEMA', 'Naver Shopping Insight response did not match the observed rank schema');
  }
  const periods = payload.map(item => {
    if (item.returnCode !== 0 || item.statusCode !== 200) {
      throw new TrendSourceError('APPLICATION', 'Naver Shopping Insight returned an application error', {
        returnCode: item.returnCode ?? null,
        statusCode: item.statusCode ?? null,
      });
    }
    return {
      date: String(item.date || ''),
      datetime: String(item.datetime || ''),
      range: String(item.range || ''),
      ranks: item.ranks.map(rank => ({
        rank: Number(rank.rank),
        keyword: String(rank.keyword || '').trim(),
      })).filter(rank => Number.isInteger(rank.rank) && rank.rank > 0 && rank.keyword),
    };
  });
  return {
    categoryId,
    categoryName,
    timeUnit,
    periodCount: periods.length,
    periods,
  };
}

export async function fetchShoppingRanks({
  categoryId,
  categoryName,
  timeUnit = 'date',
  cookieHeader,
  fetchImpl = globalThis.fetch,
}) {
  if (!/^\d{8}$/.test(String(categoryId)) || !allowedUnits.has(timeUnit)) {
    throw new TrendSourceError('INPUT', 'Invalid Naver Shopping Insight category or time unit');
  }
  if (typeof cookieHeader !== 'string' || !cookieHeader) {
    throw new TrendSourceError('SESSION_MISSING', 'Naver anonymous trend session is required');
  }
  const url = new URL('https://datalab.naver.com/shoppingInsight/getKeywordRank.naver');
  url.searchParams.set('timeUnit', timeUnit);
  url.searchParams.set('cid', String(categoryId));
  const { response, text } = await fetchText(url, {
    method: 'POST',
    headers: {
      'user-agent': CHROME_USER_AGENT,
      accept: 'application/json, text/javascript, */*; q=0.01',
      'accept-language': 'ko-KR,ko;q=0.9',
      referer: 'https://datalab.naver.com/',
      'x-requested-with': 'XMLHttpRequest',
      cookie: `${cookieHeader}; _datalab_cid=${categoryId}`,
    },
    fetchImpl,
  });
  assertStatus(response);
  return {
    ...parseShoppingRankResponse(text, { categoryId, categoryName, timeUnit }),
    receipt: {
      method: 'POST',
      origin: url.origin,
      path: url.pathname,
      queryFields: ['cid', 'timeUnit'],
      requestBodyFields: [],
      httpStatus: response.status,
      responseContentType: response.headers.get('content-type') || null,
      responseBytes: Buffer.byteLength(text),
      browserUsed: false,
      cookieValuesPersisted: false,
    },
  };
}

export async function collectShoppingTrends({
  categories = SHOPPING_CATEGORIES,
  timeUnits = ['date', 'week', 'month'],
  delayMs = 650,
  fetchImpl = globalThis.fetch,
} = {}) {
  const queue = [];
  for (const category of categories) {
    for (const timeUnit of timeUnits) queue.push({ ...category, timeUnit });
  }
  const results = [];
  const failures = [];
  let session = await bootstrapAnonymousNaverSession({ fetchImpl });
  let bootstrapCount = 1;
  for (const current of queue) {
    let completed = false;
    let lastError = null;
    for (let attempt = 0; attempt < 2 && !completed; attempt++) {
      try {
        results.push(await fetchShoppingRanks({
          categoryId: current.id,
          categoryName: current.name,
          timeUnit: current.timeUnit,
          cookieHeader: session.cookieHeader,
          fetchImpl,
        }));
        completed = true;
      } catch (error) {
        lastError = error;
        const refreshable = ['HTTP_STATUS', 'APPLICATION_HTML', 'SESSION_MISSING'].includes(error?.code);
        if (attempt === 0 && refreshable) {
          session.cookieHeader = '';
          await new Promise(resolve => setTimeout(resolve, Math.max(1000, delayMs)));
          session = await bootstrapAnonymousNaverSession({ fetchImpl });
          bootstrapCount++;
        }
      }
    }
    if (!completed) {
      failures.push({
        categoryId: current.id,
        categoryName: current.name,
        timeUnit: current.timeUnit,
        code: lastError?.code || lastError?.name || 'ERROR',
        httpStatus: Number.isInteger(lastError?.details?.httpStatus) ? lastError.details.httpStatus : null,
      });
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  const sessionEvidence = { ...session.evidence, bootstrapCount };
  session.cookieHeader = '';
  return {
    sessionEvidence,
    requestedContracts: queue.length,
    successfulContracts: results.length,
    failures,
    results,
  };
}
