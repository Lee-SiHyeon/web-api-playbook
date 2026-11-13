// Store a Flow session for a second/third/... Google account of the same signed-in browser (owner 2026-10-30 "왜 계정 하나만 쓰냐").
//   FLOW_ACCOUNT=N node src/account-sync.mjs [--cdp http://127.0.0.1:9333] [--project <id>]
// Opens its own tab in the already signed-in automation browser (multi-login: one cookie jar, accounts at /u/N/), reads that account's
// owner from the page, picks the given project or the newest one in the list (creates one with 새 프로젝트 when the list is empty),
// verifies a protected project read over pure HTTP with the /u/N/ prefix, then writes google-flow-session-v1-uN and
// google-flow-google-auth-v1-uN to DPAPI. Account 0 is refused here (it keeps the existing sync-from-profile path).
import { writeCredential } from './secure-credential-store.mjs';
import { FLOW_ACCOUNT, FLOW_CREDENTIAL } from './session-name.mjs';
import { GOOGLE_FLOW_AUTH_CREDENTIAL, validateGoogleFlowAuthBundle } from './google-sso-recovery.mjs';
import { validateFlowSessionBundle } from './session-bundle.mjs';
import { scopedProfileCookies, verifyProfileBundle } from './profile-sync.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const CDP = opt('cdp', 'http://127.0.0.1:9333');
const fail = (code) => { console.log(JSON.stringify({ ok: false, code, account: FLOW_ACCOUNT })); process.exit(2); };
if (!FLOW_ACCOUNT) fail('FLOW_ACCOUNT_0_USES_SYNC_FROM_PROFILE');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const U = `/u/${FLOW_ACCOUNT}`;
let out;
try {
  await send('Network.enable');
  await send('Page.navigate', { url: `https://flow.google.com${U}/` }); await sleep(8000);
  // 2026-11-04: the project grid now renders late (empty at 8 s, filled by ~15 s) -> FLOW_ACCOUNT_NO_PROJECT on accounts that have projects; wait up to 30 s.
  for (let i = 0; i < 44 && !(await ev(`document.querySelectorAll('a[href*="/project/"]').length`)); i++) await sleep(500);
  const page = await ev(`(() => { const m = document.documentElement.innerHTML.match(/"oPEP7c"\\s*:\\s*"([^"]+)"/);
    return { host: location.hostname, path: location.pathname, owner: m ? JSON.parse('"' + m[1] + '"') : null,
      projects: [...document.querySelectorAll('a[href*="/project/"]')].map(a => a.getAttribute('href')) }; })()`);
  if (page.host !== 'flow.google.com') fail('FLOW_ACCOUNT_LOGIN_REQUIRED');
  if (!page.path.startsWith(U + '/')) fail('FLOW_ACCOUNT_NOT_SIGNED_IN'); // Flow falls back to /u/0 for an account the browser does not have
  if (!page.owner) fail('FLOW_ACCOUNT_OWNER_UNKNOWN');
  let projectId = opt('project') ?? page.projects.map((h) => h.match(/\/project\/([a-f0-9-]{16,64})/i)?.[1]).find(Boolean);
  if (!projectId) { // empty account: 새 프로젝트
    const xy = await ev(`(() => { const b = [...document.querySelectorAll('button, a, div[role=button]')].find(e => /새 프로젝트|New project/.test(e.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!xy) fail('FLOW_ACCOUNT_NO_PROJECT');
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: xy[0], y: xy[1], button: 'left', clickCount: 1 });
    for (let i = 0; i < 30 && !projectId; i++) { await sleep(500); projectId = (await ev('location.pathname')).match(/\/project\/([a-f0-9-]{16,64})/i)?.[1]; }
    if (!projectId) fail('FLOW_ACCOUNT_PROJECT_CREATE_FAILED');
  }
  const projectUrl = `https://flow.google.com${U}/project/${projectId}`;
  await send('Page.navigate', { url: projectUrl }); await sleep(6000);
  const flowCookies = (await send('Network.getCookies', { urls: [projectUrl] })).result.cookies;
  const googleCookies = (await send('Network.getCookies', { urls: ['https://accounts.google.com/ServiceLogin'] })).result.cookies;
  const flow = validateFlowSessionBundle({ origin: 'https://flow.google.com', projectId, cookies: scopedProfileCookies(flowCookies, projectUrl) });
  const google = validateGoogleFlowAuthBundle({ version: 1, origin: 'https://accounts.google.com', serviceOrigin: 'https://flow.google.com', projectId,
    owner: page.owner, capturedAt: new Date().toISOString(), cookies: scopedProfileCookies(googleCookies, 'https://accounts.google.com/ServiceLogin') });
  const verified = await verifyProfileBundle(flow, page.owner); // pure HTTP with the /u/N prefix; owner must match the account's page
  writeCredential(FLOW_CREDENTIAL, JSON.stringify(verified.bundle));
  writeCredential(GOOGLE_FLOW_AUTH_CREDENTIAL, JSON.stringify(google));
  out = { ok: true, account: FLOW_ACCOUNT, projectId, credential: FLOW_CREDENTIAL, cookieCount: flow.cookieCount, projectMediaCount: verified.projectMediaCount,
    owner: page.owner.replace(/^(.{3}).*(@.*)$/, '$1***$2'), provider: 'Windows DPAPI CurrentUser', generationRequests: 0 };
} catch (e) { out = { ok: false, account: FLOW_ACCOUNT, code: e.code ?? 'ERROR', message: String(e.message).slice(0, 200) }; }
finally { ws.close(); await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); }
console.log(JSON.stringify(out));
process.exitCode = out.ok ? 0 : 1;
