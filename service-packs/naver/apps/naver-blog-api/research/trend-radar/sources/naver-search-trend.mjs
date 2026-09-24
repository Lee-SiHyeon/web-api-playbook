import { assertStatus, fetchText, TrendSourceError } from '../lib/http.mjs';

function credentials(env = process.env) {
  const clientId = env.NAVER_CLIENT_ID || env.NAVER_OPENAPI_CLIENT_ID || '';
  const clientSecret = env.NAVER_CLIENT_SECRET || env.NAVER_OPENAPI_CLIENT_SECRET || '';
  return { clientId, clientSecret, ready: Boolean(clientId && clientSecret) };
}

export function naverSearchTrendCredentialState(env = process.env) {
  const state = credentials(env);
  return {
    ready: state.ready,
    requiredNames: ['NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET'],
    valuesPersisted: false,
  };
}

function validateGroups(groups) {
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > 5) {
    throw new TrendSourceError('INPUT', 'Naver Search Trend accepts 1-5 keyword groups');
  }
  return groups.map(group => {
    const groupName = String(group.groupName || '').trim();
    const keywords = [...new Set((group.keywords || []).map(value => String(value || '').trim()).filter(Boolean))];
    if (!groupName || !keywords.length || keywords.length > 20) {
      throw new TrendSourceError('INPUT', 'Each Naver Search Trend group requires a name and 1-20 keywords');
    }
    return { groupName, keywords };
  });
}

export async function fetchNaverSearchTrend({
  startDate,
  endDate,
  timeUnit = 'date',
  keywordGroups,
  device = '',
  gender = '',
  ages = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  const auth = credentials(env);
  if (!auth.ready) throw new TrendSourceError('BLOCKED_CREDENTIALS', 'Naver Search Trend API credentials are not configured');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)
    || !['date', 'week', 'month'].includes(timeUnit)) {
    throw new TrendSourceError('INPUT', 'Invalid Naver Search Trend date range or time unit');
  }
  const body = {
    startDate,
    endDate,
    timeUnit,
    keywordGroups: validateGroups(keywordGroups),
    ...(device ? { device } : {}),
    ...(gender ? { gender } : {}),
    ...(ages.length ? { ages } : {}),
  };
  const { response, text } = await fetchText('https://openapi.naver.com/v1/datalab/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-naver-client-id': auth.clientId,
      'x-naver-client-secret': auth.clientSecret,
    },
    body: JSON.stringify(body),
    fetchImpl,
  });
  assertStatus(response);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new TrendSourceError('SCHEMA', 'Naver Search Trend response was not JSON'); }
  if (!Array.isArray(payload?.results)) throw new TrendSourceError('SCHEMA', 'Naver Search Trend response schema was unexpected');
  auth.clientId = ''; auth.clientSecret = '';
  return {
    startDate: payload.startDate,
    endDate: payload.endDate,
    timeUnit: payload.timeUnit,
    results: payload.results,
    receipt: {
      method: 'POST',
      origin: 'https://openapi.naver.com',
      path: '/v1/datalab/search',
      requestBodyFields: Object.keys(body).sort(),
      httpStatus: response.status,
      responseBytes: Buffer.byteLength(text),
      credentialValuesPersisted: false,
      browserUsed: false,
    },
  };
}
