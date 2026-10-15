import { channel } from 'node:diagnostics_channel';
import { open, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCoupangRsc, validateCoupangRscInput } from '../lib/retail/coupang-rsc.mjs';

const ORIGIN = 'https://www.coupang.com';
const BASE = new Set(['PCID','x-coupang-target-market','x-coupang-accept-language']);
// Names observed in the successful current-origin browser request on 2026-10-15.
const OBSERVED = new Set([...BASE,'sg_local_id','MARKETID','trac_src','trac_spec','trac_addtag',
  'trac_ctag','trac_lptag','trac_itime','gd1','AFATK','cf_clearance','_ga_RCWXX8WZKQ','sid',
  '_ga','_ga_MM7Y29P0HZ','travelSearchCondition','authCodeVerifier','authLoginChallenge','CT_LSID',
  'authLoginSessionId','authRedirectUri','bm_mi','bm_so','ak_bmsc','bm_lso','bm_sz','bm_s','_abck','bm_sv','x-cp-s']);
const AKAMAI = new Set(['bm_mi','bm_so','ak_bmsc','bm_lso','bm_sz','bm_s','_abck','bm_sv']);
const failure = code => Object.assign(new Error(code), { code });
const safeCode = e => /^COUPANG_[A-Z_0-9]+$/.test(e?.code ?? '') ? e.code : 'COUPANG_COOKIE_PROBE_FAILED';

export function prepareCookieComparison(envelope, now = Date.now()) {
  const input = validateCoupangRscInput(envelope);
  const age = now - Date.parse(envelope.capturedAt);
  if (!Number.isFinite(age) || age < -1000 || age > 300000
    || envelope.browserResponse?.status !== 200 || envelope.browserResponse?.mime !== 'text/x-component')
    throw failure('COUPANG_COOKIE_CAPTURE_INVALID_OR_STALE');
  const raw = envelope.cookieHeader;
  if (typeof raw !== 'string' || raw.length > 32768 || /[\r\n\0]/.test(raw)) throw failure('COUPANG_COOKIE_HEADER');
  const parts = raw.split(';').map(s => s.trim());
  const entries = parts.map(s => { const i = s.indexOf('='); return { name: s.slice(0,i), text: s, hasEquals: i > 0 }; });
  const names = entries.map(e => e.name);
  if (!entries.length || entries.some(e => !e.hasEquals || !OBSERVED.has(e.name))
    || new Set(names).size !== names.length || [...BASE].some(n => !names.includes(n))
    || !names.includes('_abck') || !names.some(n => AKAMAI.has(n))) throw failure('COUPANG_COOKIE_SCOPE');
  const build = (name, filter) => { const selected = entries.filter(e => filter(e.name));
    return { name, cookieHeader: selected.map(e => e.text).join('; '), cookieNames: selected.map(e => e.name) }; };
  return { input, capturedAt: envelope.capturedAt, browserResponse: {
    status: 200, mime: 'text/x-component', protocol: envelope.browserResponse.protocol === 'h2' ? 'h2' : 'other'
  }, variants: [build('browser_visitor_only', n => BASE.has(n)),
    build('browser_visitor_plus_akamai', n => BASE.has(n) || AKAMAI.has(n)),
    { name: 'browser_full_cookie_header', cookieHeader: raw, cookieNames: names }], initialAgeMs: age };
}

export async function runCookieComparison(envelope, { onProgress = () => {} } = {}) {
  const prepared = prepareCookieComparison(envelope), report = {
    schema: 'coupang-browser-cookie-comparison-v1', checkedAt: new Date().toISOString(),
    sourceCapturedAt: prepared.capturedAt, browserResponse: prepared.browserResponse,
    source: 'actual_current_origin_browser_request_header', transport: 'node_native_fetch',
    operation: 'retail_search_rsc', inputSource: 'observed_browser_request', cookieValuesPersisted: false,
    browserUsedForTransport: false, browserUsedForInputs: true, nonCookieHeadersChanged: false,
    headerScope: 'Same five observed RSC application headers in each variant; native Node transport headers',
    tlsImpersonation: false, retries: 0, redirectsFollowed: false, visitorBootstraps: 0, writesSubmitted: 0,
    ownerAuthenticationVerified: false, wholeOperationBrowserIndependent: false, runs: []
  };
  let active = null, sent = false, wireMatched = false, requests = 0, wireHeaderNames = [];
  const dc = channel('undici:request:create');
  const listener = ({ request }) => {
    if (!active || String(request.origin) !== ORIGIN || request.path !== new URL(prepared.input.url).pathname + new URL(prepared.input.url).search) return;
    const raw = request.headers;
    const entries = Array.isArray(raw) ? Array.from({length:raw.length/2},(_,i)=>[raw[i*2],raw[i*2+1]])
      : String(raw).split('\r\n').filter(Boolean).map(s=>{const i=s.indexOf(':');return[s.slice(0,i),s.slice(i+1).trim()];});
    const headers = Object.fromEntries(entries.map(([k,v])=>[String(k).toLowerCase(),String(v)]));
    wireMatched = headers.cookie === active.cookieHeader;
    wireHeaderNames = Object.keys(headers);
  };
  dc.subscribe(listener);
  try {
    for (const variant of prepared.variants) {
      if (Date.now() - Date.parse(prepared.capturedAt) > 300000) { report.stopped = 'capture_age_limit'; break; }
      active = variant; sent = false; wireMatched = false; requests = 0; wireHeaderNames = [];
      const fetchImpl = async (url, init) => {
        if (url !== prepared.input.url || new URL(url).origin !== ORIGIN || init.method !== 'GET'
          || init.redirect !== 'manual' || ++requests !== 1) throw failure('COUPANG_COOKIE_REQUEST_SCOPE');
        sent = true;
        return globalThis.fetch(url, { ...init, headers: { ...init.headers, cookie: variant.cookieHeader } });
      };
      let result;
      try { result = await readCoupangRsc(prepared.input, { fetchImpl }); }
      catch(e) { result = { ok:false, code:safeCode(e), receipt:e.receipt??null }; }
      if (result.receipt) Object.assign(result.receipt, { authenticationMode:'observed_browser_cookie',
        cookieSent:sent, cookieNames:variant.cookieNames, ownerCredentialUsed:'not_determined_from_cookie_names',
        credentialSource:'current_origin_cdp_request', credentialPropagated:wireMatched,
        outgoingHeaderNames:wireHeaderNames });
      result.states = { captured:true, client_exists:true, remnant_free:'transport_only_browser_inputs_required',
        credential_propagated:wireMatched, live_replay:result.ok && wireMatched && requests===1 };
      const row = { name:variant.name, inputAgeMs:Date.now()-Date.parse(prepared.capturedAt),
        requestCount:requests, exactCookieHeaderSent:wireMatched, ...result };
      report.runs.push(row); onProgress({name:row.name,ok:row.ok,status:row.receipt?.status,
        cookieCount:variant.cookieNames.length,exactCookieHeaderSent:wireMatched,count:row.data?.products?.length});
      if (!wireMatched || [401,418,429].includes(row.receipt?.status)
        || row.receipt?.status===200 && !row.ok || !row.receipt?.status) { report.stopped=variant.name; break; }
      if (variant !== prepared.variants.at(-1)) await delay(750);
    }
  } finally {
    dc.unsubscribe(listener); active=null;
    for (const variant of prepared.variants) variant.cookieHeader='';
    envelope.cookieHeader='';
  }
  report.endedAt = new Date().toISOString();
  return report;
}

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2), out=args.find(a=>a.startsWith('--out='))?.slice(6);
  if(args.length!==1 || !out) throw failure('COUPANG_COOKIE_PROBE_USAGE');
  await mkdir(path.dirname(out),{recursive:true}); const file=await open(out,'wx');
  let text='', envelope;
  try {
    for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>65536)throw failure('COUPANG_COOKIE_INPUT_LIMIT');}
    envelope=JSON.parse(text);text='';
    const report=await runCookieComparison(envelope,{onProgress:r=>console.log(JSON.stringify(r))});
    await file.writeFile(JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({saved:true,output:out,runs:report.runs.length,stopped:report.stopped??null}));
  } catch(e) {
    const result={ok:false,code:safeCode(e),cookieValuesPersisted:false};
    await file.writeFile(JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));process.exitCode=2;
  } finally {text='';if(envelope)envelope.cookieHeader='';await file.close();}
}
