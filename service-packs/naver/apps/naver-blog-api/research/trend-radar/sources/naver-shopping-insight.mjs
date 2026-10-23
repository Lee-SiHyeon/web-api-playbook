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

function isAllowedAnonymousCookieHeader(value) {
  if (typeof value !== 'string') return false;
  const pairs = value.split(';').map(pair => pair.trim());
  if (!pairs.length || pairs.some(pair => !/^(?:NNB|BUC)=[^\s;\r\n]+$/.test(pair))) return false;
  const names = pairs.map(pair => pair.slice(0, pair.indexOf('=')));
  return names.includes('NNB') && new Set(names).size === names.length;
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
  const names = [...new Set(pairs.map(pair => pair.slice(0, pair.indexOf('='))))].sort();
  const nnbPair = pairs.findLast(pair => pair.startsWith('NNB='));
  if (!nnbPair || nnbPair === 'NNB=') {
    throw new TrendSourceError('SESSION_BOOTSTRAP', 'Naver anonymous bootstrap did not issue the required NNB cookie', {
      cookieNamesPresent: names,
    });
  }
  return {
    cookieHeader: nnbPair,
    evidence: {
      provider: 'naver_anonymous_cookie_bootstrap',
      cookieNamesPresent: names,
      requiredCookieNames: ['NNB'],
      cookieNamesSent: ['NNB'],
      bucObserved: names.includes('BUC'),
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
  if (!isAllowedAnonymousCookieHeader(cookieHeader)) {
    throw new TrendSourceError('SESSION_MISSING', 'A server-issued NNB cookie and no unapproved Naver cookies are required for ranking reads');
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
  let session;
  let bootstrapCount = 0;
  const safeErrorCode = error => {
    const candidate = typeof error?.code === 'string' ? error.code
      : typeof error?.name === 'string' ? error.name : 'ERROR';
    return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(candidate) ? candidate : 'ERROR';
  };
  const safeHttpStatus = error => Number.isInteger(error?.details?.httpStatus) &&
    error.details.httpStatus >= 100 && error.details.httpStatus <= 599
    ? error.details.httpStatus : null;
  const safeCookieNames = error => Array.isArray(error?.details?.cookieNamesPresent)
    ? error.details.cookieNamesPresent.filter(name => typeof name === 'string' && /^[A-Za-z0-9_!#$%&'*+.^`|~-]+$/.test(name))
    : [];
  try {
    session = await bootstrapAnonymousNaverSession({ fetchImpl });
    bootstrapCount = 1;
  } catch (error) {
    const code = safeErrorCode(error);
    const httpStatus = safeHttpStatus(error);
    const cookieNamesPresent = safeCookieNames(error);
    for (const current of queue) {
      failures.push({
        categoryId: current.id,
        categoryName: current.name,
        timeUnit: current.timeUnit,
        code,
        httpStatus,
      });
    }
    return {
      sessionEvidence: {
        provider: 'naver_anonymous_cookie_bootstrap',
        cookieNamesPresent: [...new Set(cookieNamesPresent)].sort(),
        requiredCookieNames: ['NNB'],
        cookieNamesSent: [],
        bucObserved: cookieNamesPresent.includes('BUC'),
        cookieValuesPersisted: false,
        browserUsed: false,
        bootstrapCount,
        bootstrapFailureCode: code,
      },
      requestedContracts: queue.length,
      successfulContracts: 0,
      failures,
      results,
    };
  }
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const current = queue[queueIndex];
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
          try {
            session = await bootstrapAnonymousNaverSession({ fetchImpl });
            bootstrapCount++;
          } catch (refreshError) {
            const bootstrapFailureCode = safeErrorCode(refreshError);
            const httpStatus = safeHttpStatus(refreshError);
            const cookieNamesPresent = [...new Set([
              ...(session?.evidence?.cookieNamesPresent || []),
              ...safeCookieNames(refreshError),
            ])].sort();
            for (let failedIndex = queueIndex; failedIndex < queue.length; failedIndex++) {
              const failedContract = queue[failedIndex];
              const currentFailure = failedIndex === queueIndex;
              failures.push({
                categoryId: failedContract.id,
                categoryName: failedContract.name,
                timeUnit: failedContract.timeUnit,
                code: 'SESSION_BOOTSTRAP',
                httpStatus: currentFailure ? safeHttpStatus(lastError) : null,
                bootstrapHttpStatus: httpStatus,
                failureStage: currentFailure ? 'session_refresh' : 'session_unavailable_after_refresh_failure',
                bootstrapFailureCode,
                ...(currentFailure ? { rankFailureCode: safeErrorCode(lastError) } : {}),
              });
            }
            const sessionEvidence = {
              provider: 'naver_anonymous_cookie_bootstrap',
              cookieNamesPresent,
              requiredCookieNames: ['NNB'],
              cookieNamesSent: ['NNB'],
              bucObserved: cookieNamesPresent.includes('BUC'),
              cookieValuesPersisted: false,
              browserUsed: false,
              bootstrapCount,
              bootstrapFailureCode,
              bootstrapFailureHttpStatus: httpStatus,
            };
            session.cookieHeader = '';
            return {
              sessionEvidence,
              requestedContracts: queue.length,
              successfulContracts: results.length,
              failures,
              results,
            };
          }
        }
      }
    }
    if (!completed) {
      failures.push({
        categoryId: current.id,
        categoryName: current.name,
        timeUnit: current.timeUnit,
        code: safeErrorCode(lastError),
        httpStatus: safeHttpStatus(lastError),
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
