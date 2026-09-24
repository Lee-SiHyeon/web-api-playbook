import { JSDOM } from 'jsdom';

const rcOrigin = 'https://rcaptcha.nid.naver.com';
const submitUrl = 'https://nid.naver.com/nidlogin.rcaptcha';
const fields = ['dynamicKey', 'wtm_ncaptcha_sitekey', 'logintp', 'sessionKey', 'show_pk', 'wtoken',
  'svctype', 'bvsd', 'locale', 'chptchakey', 'captcha_type', 'url', 'rcaptchakey', 'template_url',
  'next_step', 'prx', 'template_type', 'smart_LEVEL', 'pra', 'captcha', 'chptcha'];

async function text(response, limit = 2 * 1024 * 1024) {
  if (response.status !== 200) throw new Error('LOGIN_CHALLENGE_RESOURCE_REJECTED');
  const chunks = []; let length = 0;
  for await (const chunk of response.body || []) {
    length += chunk.length;
    if (length > limit) throw new Error('LOGIN_CHALLENGE_RESOURCE_SIZE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function literalUrl(source, path, key, suffix = '') {
  const matches = [...source.matchAll(/["'](https:\/\/rcaptcha\.nid\.naver\.com\/[^"']+)["']/g)]
    .map(match => new URL(match[1])).filter(url => url.pathname === path && url.searchParams.get('key') === key
      && (!suffix || url.href.endsWith(suffix)));
  const unique = [...new Set(matches.map(url => url.href))];
  if (unique.length !== 1) throw new Error('LOGIN_CHALLENGE_SCRIPT_CHANGED');
  return unique[0];
}

function usableToken(result) {
  const token = result?.token;
  if (typeof token !== 'string' || !token || token.length > 8192 || /[\r\n\0]/.test(token)
    || /^(?:timeout|error\d*\|)/i.test(token)) throw new Error('LOGIN_CHALLENGE_TOKEN_MISSING');
  result.token = null;
  return token;
}

// Observed rcapt.js/captcha.js contract; live Node completion verified 2026-09-23.
export async function answerNaverLoginChallenge(context, answerProvider) {
  if (typeof answerProvider !== 'function') throw new Error('IMAGE_CHALLENGE_REQUIRED');
  const { request, tokenIssuer, receipt, pageUrl } = context;
  const dom = new JSDOM(context.html, { url: pageUrl });
  context.html = '';
  let imageBytes;
  try {
    const doc = dom.window.document;
    const form = doc.getElementById('frmNIDLogin');
    if (!form || form.action !== submitUrl || form.method !== 'post') throw new Error('LOGIN_CHALLENGE_FORM_CHANGED');
    const script = [...doc.scripts].find(script => {
      try { const url = new URL(script.src); return url.origin === rcOrigin && url.pathname === '/rcapt.js'; }
      catch { return false; }
    });
    const loader = [...doc.scripts].find(script => {
      try { const url = new URL(script.src); return url.origin === 'https://ncpt.naver.com' && url.pathname === '/static/ncaptcha-api.js'; }
      catch { return false; }
    });
    if (!script || !loader) throw new Error('LOGIN_CHALLENGE_SCRIPT_CHANGED');
    const challengeKey = new URL(script.src).searchParams.get('key');
    if (!challengeKey || challengeKey !== doc.getElementById('rcaptchakey')?.value) throw new Error('LOGIN_CHALLENGE_SCRIPT_CHANGED');
    const source = await text(await request(script.src));
    const uiUrl = literalUrl(source, '/rcaptUi', challengeKey);
    const questionUrl = literalUrl(source, '/question', challengeKey, '&svc=nid');
    const container = doc.getElementById('rcapt');
    if (!container) throw new Error('LOGIN_CHALLENGE_FORM_CHANGED');
    container.innerHTML = await text(await request(uiUrl));
    const params = new URLSearchParams([...new dom.window.FormData(form)]);
    if ([...params.keys()].length !== fields.length || fields.some(name => params.getAll(name).length !== 1)
      || params.get('captcha_type') !== 'receipt' || params.get('bvsd')
      || params.get('url') !== 'https://admin.blog.naver.com/aicandoanything') throw new Error('LOGIN_CHALLENGE_FORM_CHANGED');
    const question = JSON.parse(await text(await request(questionUrl)));
    const data = question?.receiptData;
    if (typeof data?.question !== 'string' || data.question.length > 500
      || typeof data.image !== 'string') throw new Error('LOGIN_CHALLENGE_QUESTION_SCHEMA');
    const image = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(data.image);
    if (!image || image[1].length > 1400000) throw new Error('LOGIN_CHALLENGE_IMAGE_SCHEMA');
    imageBytes = Buffer.from(image[1], 'base64');
    receipt.challenge = { preparedBy: 'direct_http', browserEngineUsed: false, imageType: 'image/png',
      questionFetched: true, answerSubmitted: false, additionalTokenIssued: false };

    const jsSiteKey = /new homz\.Koop\(\{siteKey:"([^"\r\n]+)"\}\)/.exec(source)?.[1];
    const jsLoader = /script\.src\s*=\s*"(https:\/\/ncpt\.naver\.com\/static\/ncaptcha-api\.js\?[^"\r\n]+)"/.exec(source)?.[1];
    if (!jsSiteKey || !jsLoader) throw new Error('LOGIN_CHALLENGE_SCRIPT_CHANGED');
    const jsResult = await tokenIssuer({ pageUrl, sdk: { loaderUrl: jsLoader, siteKey: jsSiteKey, keyboardIds: [] } });
    receipt.challenge.verificationTokenReceipt = jsResult.receipt;
    const verifyUrl = new URL(literalUrl(source, '/verifyJs', challengeKey, '&tokenId='));
    verifyUrl.searchParams.set('tokenId', usableToken(jsResult));
    const verified = await request(verifyUrl.href);
    receipt.challenge.sdkVerificationStatus = verified.status;
    const verificationBody = await text(verified);
    try {
      const body = JSON.parse(verificationBody);
      receipt.challenge.sdkVerificationShape = typeof body === 'boolean' ? { result: body }
        : { keys: Object.keys(body || {}).slice(0, 20), booleanFields: Object.fromEntries(Object.entries(body || {}).filter(([, value]) => typeof value === 'boolean')) };
    } catch { receipt.challenge.sdkVerificationShape = { textLength: verificationBody.length }; }
    receipt.challenge.additionalTokenIssued = true;

    const answer = await answerProvider({ question: data.question, imageBytes, mime: 'image/png' });
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 64 || /[\r\n\0]/.test(answer)) throw new Error('LOGIN_CHALLENGE_ANSWER_INVALID');
    params.set('captcha', answer.trim());
    const token = await tokenIssuer({ pageUrl, sdk: { loaderUrl: loader.src, siteKey: params.get('wtm_ncaptcha_sitekey') } });
    receipt.challenge.answerTokenReceipt = token.receipt;
    params.set('wtoken', usableToken(token));
    receipt.challengePostCount = 1;
    receipt.challenge.answerSubmitted = true;
    return await request(submitUrl, { method: 'POST', headers: {
      accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://nid.naver.com', referer: pageUrl,
    }, body: params.toString() });
  } finally { imageBytes?.fill(0); dom.window.close(); }
}
