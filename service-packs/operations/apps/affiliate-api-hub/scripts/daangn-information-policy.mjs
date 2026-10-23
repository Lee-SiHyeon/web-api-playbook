// Shared guard for the Naver-to-Daangn information-only mirror.
const fail = code => { throw Object.assign(new Error(code), { code }); };

const PARTNER_HOST = /(^|\.)naver\.me$|(^|\.)myrealt\.rip$|(^|\.)link\.coupang\.com$|(^|\.)coupa\.ng$|(^|\.)linkprice\.com$|(^|\.)lpweb\.kr$/i;
const TOSS_LINK = /^https:\/\/toss\.shopping\/_m\/[A-Za-z0-9]{6,12}$/;
const LINKPRICE_CLICK = /^https:\/\/click\.linkprice\.com\/click\.php\?/;
const NETWORK_DISCLOSURE = /네이버 (?:여행|쇼핑) ?커넥트 활동의 일환으로|쿠팡 ?파트너스 활동의 일환으로|마이리얼트립 파트너 활동의 일환으로|링크프라이스 제휴 활동의 일환으로|토스쇼핑 쉐어링크 활동의 일환으로/;
const APP_INSTALL_OR_SIGNUP_PROMPT = /(?:앱|애플리케이션).{0,18}(?:설치|다운로드|가입|회원\s*가입|로그인)|(?:설치|다운로드).{0,18}(?:후|하세요|해\s*보세요|받으세요)|(?:회원\s*가입|가입).{0,14}(?:하세요|하시|해\s*보|하시면|하면|해\s*주세요)|(?:install|download|sign\s?up).{0,20}(?:app|account|now)|(?:app).{0,14}(?:install|download|sign\s?up)/iu;

export const isPartnerLink = value => {
  try {
    const url = new URL(String(value));
    return PARTNER_HOST.test(url.hostname) || TOSS_LINK.test(String(value)) || LINKPRICE_CLICK.test(String(value));
  } catch {
    return false;
  }
};

export function lintDaangnInformation({ domain = null, title = '', paragraphs = [], comments = [], requireOneSource = false } = {}) {
  if (domain === 'A') fail('DAANGN_DEAL_DOMAIN_FORBIDDEN');
  const text = [title, ...paragraphs, ...comments].map(value => String(value ?? '')).join('\n');
  if (APP_INSTALL_OR_SIGNUP_PROMPT.test(text)) fail('DAANGN_APP_INSTALL_OR_SIGNUP_PROMPT');
  if (NETWORK_DISCLOSURE.test(text) || /(?:^|\s)\[(?:광고|AD)\](?:\s|$)/iu.test(text)) fail('DAANGN_AD_COPY_FORBIDDEN');
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map(match => match[0].replace(/[.,!?;:]+$/, ''));
  if (urls.some(isPartnerLink)) fail('DAANGN_PARTNER_LINK_FORBIDDEN');
  const externalUrls = urls.filter(value => {
    try { return !/(^|\.)daangn\.com$/i.test(new URL(value).hostname); }
    catch { return true; }
  });
  if (externalUrls.length > 1) fail('DAANGN_SOURCE_LINK_LIMIT');
  if (requireOneSource && externalUrls.length !== 1) fail('DAANGN_SOURCE_LINK_REQUIRED');
  return { sourceLinks: externalUrls.length };
}
