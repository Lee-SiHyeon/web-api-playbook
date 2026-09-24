import { createSeedDocument, validateCreateEnvelope } from '../api/create-envelope.mjs';
import { environmentSession } from '../api/environment-session.mjs';

// Explicit hybrid input provider. Ephemeral headless engine, no profile,
// extension, stealth patches, raw logs or browser publication requests.
function scopedLoginHeader(cookies) {
  const scoped = cookies.filter(c => ['NID_AUT', 'NID_SES'].includes(c.name) &&
    ['.naver.com', 'blog.naver.com', '.blog.naver.com'].includes(c.domain) &&
    c.path === '/' && (c.expires === -1 || c.expires * 1000 > Date.now()));
  const header = scoped.map(c => `${c.name}=${c.value}`).join('; ');
  const session = environmentSession({ NAVER_COOKIE: header });
  try { return session.cookieFor('https://blog.naver.com/'); } finally { session.clear(); }
}
const BLOG = 'aicandoanything';
const ORIGIN = 'https://blog.naver.com';
const fail = code => { throw Error(code); };
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createSeedClipboardHtml(document) {
  const seed=createSeedDocument(document);
  const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const links=new Map(document.blocks.filter(b=>b.type==='link').map(b=>[b.display==='label'?b.label:b.url,b.url]));
  return seed.blocks.map(b=>`<p>${links.has(b.text)?`<a href="${escape(links.get(b.text))}">${escape(b.text)}</a>`:escape(b.text)}</p>`).join('');
}

export function headlessCookies(cookies, blogId) {
  if (blogId !== BLOG) fail('HEADLESS_PROBE_SCOPE');
  scopedLoginHeader(cookies);
  return cookies.filter(c => ['NID_AUT', 'NID_SES'].includes(c.name) &&
    ['.naver.com', 'blog.naver.com', '.blog.naver.com'].includes(c.domain) &&
    c.path === '/' && (c.expires <= 0 || c.expires * 1000 > Date.now())).map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: true, httpOnly: true,
    expires: c.expires,
    sameSite: ['Lax', 'Strict', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
  }));
}

async function noChallenge(page) {
  const text = await page.locator('body').innerText({ timeout: 5000 });
  if (/자동\s*입력\s*방지|보이는\s*문자|보안\s*문자|인증번호를\s*입력|비정상적인\s*로그인|CAPTCHA/i.test(text))
    fail('HEADLESS_INTERACTIVE_VERIFICATION_REQUIRED');
  if (new URL(page.url()).origin !== ORIGIN) fail('HEADLESS_AUTH_REQUIRED');
}

export async function collectHeadlessEnvelope({ cookies, blogId, document, publishSettings, onStage = () => {} }, {
  loadChromium = async () => (await import('playwright')).chromium,
} = {}) {
  const seedDocument = createSeedDocument(document);
  if (seedDocument.blogId !== blogId) fail('CREATE_SCOPE');
  const seed = headlessCookies(cookies, blogId);
  if (process.env.DEBUG || process.env.PWDEBUG) fail('DEBUG_UNSAFE');
  let browser, page, result, timer, step = 'launch';
  const pending = [], issuer = [], sdkAssets = [], blocked = [];
  let capturedCount = 0, settleCapture;
  const capture = new Promise(resolve => { settleCapture = resolve; });
  try {
    const chromium = await loadChromium();
    browser = await chromium.launch({ channel: 'chromium', headless: true,
      args: ['--enable-automation'], timeout: 20000 });
    const context = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul',
      acceptDownloads: false });
    await context.addCookies(seed);
    await context.route(`${ORIGIN}/**`, async route => {
      const request = route.request(), url = new URL(request.url());
      if (SAFE_METHODS.has(request.method())) return route.continue();
      blocked.push({ method: request.method(), path: url.pathname });
      // Abort before returning the form; the browser must never publish or save.
      const body = request.method() === 'POST' && url.pathname === '/RabbitWrite.naver'
        ? request.postData() : null;
      await route.abort('aborted');
      if (body !== null) {
        capturedCount++;
        settleCapture({ blogId, body, observedAt: new Date().toISOString(), browserRequestCancelled: true });
      }
    });
    page = await context.newPage();
    page.setDefaultTimeout(12000); page.setDefaultNavigationTimeout(25000);
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    page.on('response', response => {
      const url = new URL(response.url());
      if ((url.origin === 'https://ncpt.naver.com' && url.pathname === '/static/ncaptcha-api.js') ||
          (url.origin === 'https://wtm.pstatic.net' && url.pathname.endsWith('.wasm'))) {
        sdkAssets.push({ url: url.origin + url.pathname, status: response.status() });
      }
      if (url.origin !== 'https://ncpt.naver.com' || url.pathname !== '/v2/tokens') return;
      pending.push((async () => {
        const summary = { status: response.status(), mime: response.headers()['content-type']?.split(';')[0] };
        try {
          const bytes = await response.body();
          if (bytes.length > 64 * 1024) fail('ISSUER_BODY_LIMIT');
          const data = JSON.parse(bytes.toString('utf8'));
          summary.keys = Object.keys(data).sort();
          summary.tokenType = typeof data.tokenId;
          summary.tokenLength = typeof data.tokenId === 'string' ? data.tokenId.length : null;
        } catch { summary.bodyVerified = false; }
        issuer.push(summary);
      })());
    });
    const cdp = await context.newCDPSession(page);
    const version = await cdp.send('Browser.getVersion');
    const command = await cdp.send('Browser.getBrowserCommandLine');
    const runtime = { product: version.product,
      headless: command.arguments.some(value => value.startsWith('--headless')),
      extensionsDisabled: command.arguments.includes('--disable-extensions'),
      automationDisclosed: command.arguments.includes('--enable-automation') };
    if (!runtime.headless || !runtime.extensionsDisabled || !runtime.automationDisclosed)
      fail('HEADLESS_RUNTIME_UNVERIFIED');
    step = 'navigate_editor';
    await page.goto(`${ORIGIN}/PostWriteForm.naver?blogId=${blogId}`, { waitUntil: 'domcontentloaded' });
    step = 'wait_title';
    await page.getByText('제목', { exact: true }).waitFor({ state: 'visible' });
    await noChallenge(page);
    step = 'close_help';
    const helpClose = page.getByText('닫기', { exact: true });
    // In a fresh context the help drawer mounts after the title becomes visible.
    // An immediate isVisible() races that mount and leaves Publish covered.
    let helpVisible = false;
    try { await helpClose.waitFor({ state: 'visible', timeout: 5000 }); helpVisible = true; }
    catch (error) { if (error.name !== 'TimeoutError') throw error; }
    if (helpVisible) await helpClose.click();
    step = 'enter_title';
    await page.getByText('제목', { exact: true }).click();
    await page.keyboard.insertText(seedDocument.title);
    step = 'enter_body';
    await page.getByText('글감과 함께 나의 일상을 기록해보세요!', { exact: true }).click();
    // Paste the complete seed as one edit for both linked and link-free articles.
    // Per-paragraph keyboard inserts can race SmartEditor's asynchronous edits
    // and silently lose an entire paragraph. Exact envelope equality still gates
    // every capture before any independent HTTP publication is possible.
    await context.grantPermissions(['clipboard-read','clipboard-write'], { origin: ORIGIN });
    await page.evaluate(async html => navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }) })]), createSeedClipboardHtml(document));
    await page.keyboard.press('Control+V');
    await page.getByText(seedDocument.blocks.at(-1).text, { exact: true }).waitFor({ state: 'visible' });
    step = 'open_publication_settings';
    if (await helpClose.isVisible()) await helpClose.click();
    await page.getByRole('button', { name: '발행', exact: true }).click();
    step = 'select_private';
    await page.getByText('비공개', { exact: true }).click();
    await page.getByText('이 글을 나만 볼 수 있습니다.', { exact: true }).waitFor({ state: 'visible' });
    if (publishSettings?.categoryName) {
      step = 'select_category';
      await page.getByText('낙서장', { exact: true }).click();
      await page.getByText(publishSettings.categoryName, { exact: true }).click();
    }
    await noChallenge(page);
    onStage('private_document_prepared');
    step = 'issue_sdk_token';
    // Exact selector observed on 2026-09-20; UI drift fails closed.
    await page.locator('button.confirm_btn__byZZW').click();
    const envelope = await Promise.race([capture, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('HEADLESS_CAPTURE_TIMEOUT')), 20000);
    })]);
    clearTimeout(timer);
    step = 'validate_capture';
    await Promise.all(pending);
    validateCreateEnvelope(envelope, { blogId, document, requireClosed: false });
    if (capturedCount !== 1 || issuer.length !== 1 || issuer[0].status !== 200 ||
        issuer[0].mime !== 'application/json' || issuer[0].tokenType !== 'string' ||
        JSON.stringify(issuer[0].keys) !== '["tokenId"]') fail('HEADLESS_ISSUER_UNVERIFIED');
    result = { envelope, cookieHeader: scopedLoginHeader(await context.cookies([ORIGIN])),
      metadata: { checkedAt: new Date().toISOString(), runtime, issuer, sdkAssets,
        blockedBrowserWrites: blocked, browserPublishCount: 0, cancelledPublishCount: capturedCount } };
    onStage('sdk_token_captured');
  } catch (error) {
    const code = /^[A-Z_]+$/.test(error.code || error.message || '') ? error.code || error.message :
      error.name === 'TimeoutError' ? 'HEADLESS_UI_TIMEOUT' : 'HEADLESS_CAPTURE_FAILED';
    const safe = Error(code);
    safe.details = { step, cancelledPublishCount: capturedCount, browserPublishCount: 0 };
    if (code === 'CREATE_FRESH_PRIVATE_SEED_REQUIRED') safe.details.shape = error.details;
    if (code === 'CREATE_SEED_CONTENT_MISMATCH') safe.details.contentComparison = error.details;
    if (page && !page.isClosed()) {
      safe.details.visibleButtons = await page.locator('button:visible').allTextContents()
        .then(values => values.filter(v => /닫기|취소|확인|발행|작성|불러오기/.test(v)).map(v => v.trim().slice(0,80)).slice(0,15))
        .catch(() => []);
    }
    throw safe;
  } finally {
    clearTimeout(timer);
    if (browser) {
      await browser.close();
      if (browser.isConnected()) fail('HEADLESS_BROWSER_NOT_CLOSED');
      if (result) { result.metadata.browserClosed = true; result.envelope.browserClosed = true; }
    }
    for (const cookie of seed) cookie.value = '';
  }
  return result;
}
