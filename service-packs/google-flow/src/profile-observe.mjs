import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectProfileCdp, profileError, windowsChildEnvironment } from './profile-cdp.mjs';
import { readCredential } from './secure-credential-store.mjs';
import { FLOW_CREDENTIAL } from './session-name.mjs';

export const CAPTURE_DIR = path.join(process.env.LOCALAPPDATA ?? 'C:\\Users\\User\\AppData\\Local',
  'affiliate-content-operations', 'flow-captures', '2026-10-10');
const helper = fileURLToPath(new URL('./flow-capture-store.ps1', import.meta.url));
const KNOWN_FIELDS = new Set(['clientContext','requests','aspectRatio','videoModelKey','textInput','prompt','seed',
  'startImage','endImage','imageInput','mediaId','name','character','references','referenceImages',
  'audio','generateAudio','dialogue','duration','resolution','sessionId','projectId','recaptchaContext',
  'token','model','extendVideo','videoInput','metadata','requestId','upload','mimeType','fileName']);

export function bodyShape(value, depth = 0) {
  if (depth > 18) return '[depth-limit]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return '[string]';
  if (Array.isArray(value)) return value.slice(0, 100).map(v => bodyShape(v, depth + 1));
  if (value && typeof value === 'object') return Object.entries(value).slice(0, 100)
    .map(([k, v]) => ({ field: KNOWN_FIELDS.has(k) ? k : '[field]', shape: bodyShape(v, depth + 1) }));
  return '[unknown]';
}

export function safeEndpoint(value) {
  try {
    const url = new URL(value);
    if (!['flow.google.com','accounts.google.com','labs.google','aisandbox-pa.googleapis.com'].includes(url.hostname)) return null;
    let endpoint = 'other';
    if (/^\/(?:RotateCookiesPage|RotateCookies)\/?$/.test(url.pathname)) endpoint = url.pathname;
    else if (/^\/_\/AiSandboxAngularFrontend\/data\/batchexecute$/.test(url.pathname)) endpoint = url.pathname;
    else if (/^\/project\/[a-f0-9-]+\/?$/i.test(url.pathname)) endpoint = '/project/{id}';
    else if (/^\/(?:ServiceLogin|accounts\/SetOSID)\/?$/i.test(url.pathname)) endpoint = url.pathname;
    else if (/^\/v1\/(?:video|projects|media)[A-Za-z/:.-]*$/.test(url.pathname)) endpoint = url.pathname;
    else if (/refresh|dbsc|session/i.test(url.pathname)) endpoint = '/[session-endpoint]';
    else if (url.pathname === '/') endpoint = '/';
    return { host: url.hostname, endpoint };
  } catch { return null; }
}

function headerNames(headers) {
  return Object.keys(headers ?? {}).filter(k => /^[A-Za-z0-9_-]{1,80}$/.test(k)).map(k => k.toLowerCase()).sort();
}

export function safeNetworkRecord(record) {
  const request = record.request ?? {};
  const endpoint = safeEndpoint(request.url);
  if (!endpoint) return null;
  const requestHeaderNames = headerNames({ ...request.headers, ...record.requestExtra?.headers });
  const responseHeaderNames = headerNames({ ...record.response?.headers, ...record.responseExtra?.headers });
  let requestBodyShape = null;
  if (typeof request.postData === 'string') {
    try {
      const contentType = Object.entries(request.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
      if (/application\/x-www-form-urlencoded/i.test(contentType)) {
        const form = new URLSearchParams(request.postData);
        // Never parse binary CAPTCHA inputs as form-field names.
        if (form.has('f.req')) {
          const envelope = JSON.parse(form.get('f.req'));
          const rpc = envelope?.[0]?.[0];
          requestBodyShape = { formFields: ['f.req', ...(form.has('at') ? ['at'] : [])],
            rpc: /^[A-Za-z0-9_-]{2,32}$/.test(rpc?.[0]) ? rpc[0] : null,
            payloadShape: bodyShape(JSON.parse(rpc[1])) };
        }
      } else if (/application\/json/i.test(contentType)) requestBodyShape = bodyShape(JSON.parse(request.postData));
    } catch { requestBodyShape = '[unparsed]'; }
  }
  const sessions = record.requestExtra?.deviceBoundSessions ?? record.requestExtra?.deviceBoundSessionUsages;
  return { version: 1, observedAt: record.observedAt, ...endpoint,
    method: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'].includes(request.method) ? request.method : 'other',
    status: Number.isInteger(record.response?.status) ? record.response.status : record.responseExtra?.statusCode ?? null,
    requestHeaderNames, responseHeaderNames, requestBodyShape,
    deviceSignatureHeaderPresent: requestHeaderNames.some(k => /^(?:sec-)?(?:secure-)?session-response$/.test(k)),
    dbscHeaderNames: [...new Set([...requestHeaderNames,...responseHeaderNames].filter(k => /session-(?:registration|challenge|response|id)/.test(k)))],
    deviceBoundSessionUsageCount: Array.isArray(sessions) ? sessions.length : null,
    plaintextPersisted: false };
}

export function changedCookieNames(before, after) {
  const key = c => `${c.domain}\0${c.path}\0${c.name}`;
  const previous = new Map(before.map(c => [key(c), c]));
  const current = new Map(after.map(c => [key(c), c]));
  return [...new Set([...before, ...after].filter(c => {
    const a = previous.get(key(c)), b = current.get(key(c));
    return !a || !b || a.value !== b.value || a.expires !== b.expires;
  }).map(c => c.name))].filter(name => /^[A-Za-z0-9_-]{1,101}$/.test(name));
}

export function protectCapture(target, record) {
  const input = Buffer.from(JSON.stringify(record)).toString('base64');
  if (input.length > 12_000_000) throw profileError('FLOW_CAPTURE_RAW_TOO_LARGE');
  try {
    const result = execFileSync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-File',helper,'-Target',target],
      { input, env: windowsChildEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024, stdio: ['pipe','pipe','pipe'] });
    if (JSON.parse(result).stored !== true) throw new Error();
  } catch (error) {
    const failure = profileError('FLOW_CAPTURE_PROTECTED_STORE_FAILED');
    const safe = /^FLOW_CAPTURE_PROTECTED_STORE_FAILED:([a-z_]{1,40}):([A-Za-z]{1,80})$/.exec(String(error?.stderr ?? '').trim());
    if (safe) { failure.storeStage = safe[1]; failure.storeExceptionClass = safe[2]; }
    throw failure;
  }
}

// Network event values are kept in memory and written only through DPAPI. JSON is schema-only.
export function createNetworkCapture(cdp, sessionId, { captureDir = CAPTURE_DIR, protectImpl = protectCapture } = {}) {
  const records = new Map();
  const rawDbsc = [];
  let dbscSupported = false;
  let dbscEventCount = 0;
  const unsubscribe = cdp.onEvent(event => {
    if (event.sessionId !== sessionId) return;
    const p = event.params ?? {};
    if (/^Network\.deviceBoundSession/.test(event.method)) {
      const googleSite = value => { try { return ['google.com','flow.google.com','accounts.google.com','labs.google'].includes(new URL(value).hostname); } catch { return false; } };
      if (event.method === 'Network.deviceBoundSessionsAdded') {
        const sessions = (p.sessions ?? []).filter(s => googleSite(s.key?.site ?? s.site));
        if (!sessions.length) return;
        rawDbsc.push({ ...event, params: { sessions } });
      } else {
        if (!googleSite(p.site)) return;
        rawDbsc.push(event);
      }
      dbscEventCount += 1; return;
    }
    if (!/^Network\.(requestWillBeSent|responseReceived)(ExtraInfo)?$/.test(event.method)) return;
    let record = records.get(p.requestId);
    if (!record) { record = { observedAt: new Date().toISOString(), events: [] }; records.set(p.requestId, record); }
    record.events.push(event);
    if (event.method === 'Network.requestWillBeSent') record.request = p.request;
    if (event.method === 'Network.requestWillBeSentExtraInfo') record.requestExtra = p;
    if (event.method === 'Network.responseReceived') record.response = p.response;
    if (event.method === 'Network.responseReceivedExtraInfo') record.responseExtra = p;
  });
  return {
    stop() { unsubscribe(); records.clear(); rawDbsc.length = 0; },
    async enable() {
      await cdp.send('Network.enable', {}, sessionId);
      try { await cdp.send('Network.enableDeviceBoundSessions', {}, sessionId); dbscSupported = true; } catch {}
    },
    async finish() {
      unsubscribe();
      await mkdir(captureDir, { recursive: true });
      let count = 0;
      for (const record of records.values()) {
        const safe = safeNetworkRecord(record); if (!safe) continue;
        const id = randomUUID();
        await writeFile(path.join(captureDir, id + '.json'), JSON.stringify(safe, null, 2) + '\n', { flag: 'wx' });
        protectImpl(path.join(captureDir, id + '.dpapi'), record);
        count += 1;
      }
      if (rawDbsc.length) protectImpl(path.join(captureDir, randomUUID() + '.dbsc.dpapi'), rawDbsc);
      records.clear(); rawDbsc.length = 0;
      return { captureDir, requestCount: count, dbscSupported, dbscEventCount, plaintextPersisted: false };
    },
  };
}

export async function observeProfile({ profileDir, seconds = 60, connectImpl = connectProfileCdp } = {}) {
  if (!Number.isInteger(Number(seconds)) || Number(seconds) < 1 || Number(seconds) > 300) throw profileError('FLOW_OBSERVE_DURATION_INVALID');
  let bundle; try { bundle = JSON.parse(readCredential(FLOW_CREDENTIAL)); } catch {}
  if (!/^[a-f0-9-]{16,64}$/i.test(bundle?.projectId)) throw profileError('FLOW_PROFILE_PROJECT_MISMATCH');
  const cdp = await connectImpl({ profileDir, launch: true });
  let targetId, capture;
  try {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true }));
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    capture = createNetworkCapture(cdp, sessionId);
    await capture.enable();
    const urls = [`https://flow.google.com/project/${bundle.projectId}`, 'https://accounts.google.com/ServiceLogin'];
    const before = (await cdp.send('Network.getCookies', { urls }, sessionId)).cookies;
    await cdp.send('Page.navigate', { url: urls[0] }, sessionId);
    const deadline = Date.now() + Number(seconds) * 1000;
    while (Date.now() < deadline) {
      const state = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({host:location.hostname,challenge:[...document.querySelectorAll(\'iframe[src*="/bframe"]\')].some(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=="hidden"})})', returnByValue: true }, sessionId);
      const pageState = JSON.parse(state.result.value);
      if (pageState.challenge) throw profileError('FLOW_PROFILE_CHALLENGE_REQUIRED');
      if (pageState.host === 'accounts.google.com') throw profileError('FLOW_PROFILE_LOGIN_REQUIRED');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const after = (await cdp.send('Network.getCookies', { urls }, sessionId)).cookies;
    const result = { ...await capture.finish(), elapsedSeconds: Number(seconds), changedCookieNames: changedCookieNames(before, after),
      generationRequests: 0, dbscCauseConfirmed: false };
    capture = null;
    await writeFile(path.join(CAPTURE_DIR, randomUUID() + '.summary.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return result;
  } finally {
    if (capture) await capture.finish();
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    cdp.close();
  }
}
