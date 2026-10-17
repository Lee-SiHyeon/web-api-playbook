import { createHash } from 'node:crypto';

// Alibaba MTOP H5 gateway helpers shared by AliExpress (acs.aliexpress.com), Taobao and 1688 (h5api.m.*).
// Observed 2026-10-17 on ko.aliexpress.com PDP: sign = md5(`${token}&${t}&${appKey}&${data}`), where token is the
// part of the `_m_h5_tk` cookie before the first underscore. Offline HAR check of 2026-10-15 confirmed the same rule.

export function mtopToken(cookieValue) {
  if (typeof cookieValue !== 'string' || !cookieValue) return '';
  const token = cookieValue.split('_')[0];
  return /^[0-9a-f]{16,64}$/i.test(token) ? token : '';
}

export function mtopSign({ token, t, appKey, data }) {
  if (typeof token !== 'string' || typeof t !== 'string' || !/^\d{10,16}$/.test(t)
    || typeof appKey !== 'string' || !/^\d{5,12}$/.test(appKey) || typeof data !== 'string') {
    throw Object.assign(new Error('MTOP_SIGN_INPUT_INVALID'), { code: 'MTOP_SIGN_INPUT_INVALID' });
  }
  return createHash('md5').update(`${token}&${t}&${appKey}&${data}`).digest('hex');
}

// JSON, or JSONP `mtopjsonpN({...})` when the browser asked for dataType=originaljsonp.
export function parseMtopBody(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const jsonp = /^[A-Za-z_$][\w$]*\(([\s\S]*)\)\s*;?$/.exec(trimmed);
  try { return JSON.parse(jsonp ? jsonp[1] : trimmed); } catch { return null; }
}

// ret is e.g. ["SUCCESS::调用成功"], ["FAIL_SYS_TOKEN_EXOIRED::令牌过期"], ["FAIL_SYS_USER_VALIDATE", "RGV587_ERROR::SM::..."].
export function classifyMtopRet(ret) {
  const items = Array.isArray(ret) ? ret.filter(item => typeof item === 'string') : [];
  const codes = items.map(item => item.split('::')[0]);
  if (codes.includes('SUCCESS')) return 'success';
  if (codes.some(code => /^FAIL_SYS_TOKEN_(EMPTY|EXOIRED|EXPIRED|ILLEGAL)$/.test(code))) return 'token_refresh';
  if (codes.some(code => /^(FAIL_SYS_USER_VALIDATE|RGV587_ERROR|FAIL_SYS_ILLEGAL_ACCESS|FAIL_SYS_TRAFFIC_LIMIT)$/.test(code))
    || items.some(item => /punish|x5sec|captcha|baxia/i.test(item))) return 'challenge';
  if (codes.some(code => /^FAIL_SYS_SESSION_EXPIRED$/.test(code))) return 'session_expired';
  return 'error';
}

export function mtopRetSummary(ret) {
  return (Array.isArray(ret) ? ret : []).filter(item => typeof item === 'string')
    .map(item => item.split('::')[0]).slice(0, 4);
}
