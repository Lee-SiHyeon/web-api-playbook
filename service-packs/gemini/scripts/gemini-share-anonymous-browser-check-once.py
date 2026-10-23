#!/usr/bin/env python3
"""Replay public-share lookups with browser credentials omitted after owner revoke."""

import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sys
import urllib.parse
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
PAGE_ROLE = 'codex-gemini-lifecycle-20261006'
ORIGIN = 'https://gemini.google.com'
TASK_TITLE = 'Codex API verified text 20261006'
TASK_MARKER = 'PROTOCOL42'
RPC_ID = 'ujx1Bf'
RECEIPT_PATH = REPO / 'verification/one-shot/gemini-share-anonymous-read-2026-10-06.json'
SHARE_ID_RE = re.compile(r'^[A-Za-z0-9._~-]{8,256}$')


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def import_script(name, path):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wipe(value, depth=0):
    if depth > 24 or value is None:
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            if isinstance(child, str):
                value[index] = ''
            else:
                wipe(child, depth + 1)
        value.clear()
    elif isinstance(value, dict):
        for key, child in list(value.items()):
            if isinstance(child, str):
                value[key] = ''
            else:
                wipe(child, depth + 1)
        value.clear()


def bind_template(value, share_id, depth=0):
    if depth > 24:
        raise SafeFailure('ANONYMOUS_SHARE_TEMPLATE_INVALID')
    if value == '{{shareId}}' and isinstance(value, str):
        return share_id
    if isinstance(value, list):
        return [bind_template(item, share_id, depth + 1) for item in value]
    if isinstance(value, dict):
        return {key: bind_template(item, share_id, depth + 1) for key, item in value.items()}
    return value


def build_probe(contract, session, share_url):
    parsed = urllib.parse.urlsplit(share_url)
    parts = [segment for segment in parsed.path.split('/') if segment]
    if (parsed.scheme != 'https' or parsed.hostname != 'gemini.google.com' or parsed.query or parsed.fragment
            or len(parts) != 2 or parts[0] != 'share' or not SHARE_ID_RE.fullmatch(parts[1])):
        raise SafeFailure('ANONYMOUS_SHARE_URL_INVALID')
    operation = contract.get('operations', {}).get('share_public_read', {})
    request = operation.get('request', {})
    context = session.get('batchContext', {})
    share_id = parts[1]
    args = bind_template(request.get('rpcArgsTemplate'), share_id)
    query_values = {
        'rpcids': RPC_ID,
        'source-path': context.get('sourcePath'),
        'bl': context.get('buildLabel'),
        'f.sid': context.get('fSid'),
        'hl': context.get('locale'),
        '_reqid': str(context.get('requestId')),
        'rt': context.get('requestType'),
    }
    if (request.get('rpcId') != RPC_ID or not isinstance(args, list)
            or not all(isinstance(query_values.get(key), str) and query_values[key] for key in request.get('queryKeys', []))):
        raise SafeFailure('ANONYMOUS_SHARE_PROBE_TEMPLATE_INVALID')
    query = urllib.parse.urlencode([(name, query_values[name]) for name in request['queryKeys']])
    f_req = json.dumps([[[RPC_ID, json.dumps(args, separators=(',', ':')), None, 'generic']]], separators=(',', ':'))
    body_values = {'f.req': f_req, 'at': context.get('at')}
    body = urllib.parse.urlencode([(name, body_values[name]) for name in request['bodyFieldNames']])
    endpoint = request['origin'] + request['path'] + '?' + query
    return {
        'shareUrl': share_url,
        'endpoint': endpoint,
        'body': body,
        'contentType': request['contentType'],
    }


def write_receipt(receipt):
    RECEIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp = RECEIPT_PATH.with_name(RECEIPT_PATH.name + f'.anonymous-{os.getpid()}.pending')
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(receipt, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(temp, RECEIPT_PATH)
    except Exception:
        try:
            temp.unlink(missing_ok=True)
        except Exception:
            pass
        raise


def main():
    session = None
    expected_owner = ''
    probes = []
    stage = 'init'
    try:
        owner = json.loads(OWNER_PATH.read_text(encoding='utf-8'))
        roles = json.loads(ROLE_PATH.read_text(encoding='utf-8'))
        api_helper = import_script('anonymous_probe_api_helper', REPO / 'scripts/run-linux-api.py')
        text_helper = import_script('anonymous_probe_owner_helper', REPO / 'scripts/run-linux-text-smoke.py')
        read_helper = import_script('anonymous_probe_session_helper', REPO / 'scripts/gemini-share-list-read-once.py')
        expected_hash, _ = text_helper.read_static_owner_hash()
        contract = json.loads((REPO / 'discovery/observed-contract.json').read_text(encoding='utf-8'))
        stage = 'session_capture'
        session, expected_owner, _ = read_helper.capture_session(owner, roles, contract, api_helper, text_helper, expected_hash)
        share_urls = []
        stage = 'history_scan'
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{owner['cdpPort']}")
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]
            pages = [page for page in context.pages if page.evaluate('() => window.name') == PAGE_ROLE]
            if len(pages) != 1:
                raise SafeFailure('ROLE_PAGE_NOT_UNIQUE')
            page = pages[0]
            cdp = context.new_cdp_session(page)
            try:
                cdp.send('Page.enable')
                history = cdp.send('Page.getNavigationHistory')
                for entry in history.get('entries', []):
                    raw_url = entry.get('url', '')
                    parsed = urllib.parse.urlsplit(raw_url)
                    pieces = [part for part in parsed.path.split('/') if part]
                    if (parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com'
                            and len(pieces) == 2 and pieces[0] == 'share'
                            and not parsed.query and not parsed.fragment and SHARE_ID_RE.fullmatch(pieces[1])):
                        share_urls.append(raw_url)
            finally:
                cdp.detach()
            share_urls = list(dict.fromkeys(share_urls))
            if len(share_urls) != 2:
                raise SafeFailure('COPIED_SHARE_URLS_NOT_FOUND_IN_TASK_NAVIGATION')
            probes = [build_probe(contract, session, url) for url in share_urls]
            request_results = []
            blocked = []

            def guard(route):
                try:
                    request = route.request
                    if request.method.upper() in {'GET', 'HEAD', 'OPTIONS'}:
                        if request.method.upper() == 'GET' and request.url in {probe['shareUrl'] for probe in probes}:
                            names = {name.lower() for name in request.headers}
                            request_results.append({
                                'method': 'GET', 'pathFamily': 'share',
                                'cookieHeaderSent': 'cookie' in names,
                                'authorizationHeaderSent': 'authorization' in names,
                            })
                        route.continue_()
                        return
                    parsed = urllib.parse.urlsplit(request.url)
                    ids = urllib.parse.parse_qs(parsed.query, keep_blank_values=True).get('rpcids', [])
                    if (parsed.hostname == 'gemini.google.com'
                            and parsed.path == '/_/BardChatUi/data/batchexecute'
                            and ids == [RPC_ID]):
                        names = {name.lower() for name in request.headers}
                        request_results.append({
                            'method': request.method.upper(),
                            'pathFamily': 'batchexecute',
                            'rpcIdMatched': True,
                            'cookieHeaderSent': 'cookie' in names,
                            'authorizationHeaderSent': 'authorization' in names,
                        })
                        route.continue_()
                        return
                except Exception:
                    pass
                blocked.append(1)
                try:
                    route.abort('aborted')
                except Exception:
                    pass

            page.route('**/*', guard)
            try:
                stage = 'anonymous_fetch'
                js_results = page.evaluate("""async ({probes,title,marker}) => {
                  const out=[];
                  for (const probe of probes) {
                    let response=null, bytes=new Uint8Array(0), text='';
                    try {
                      const get=await fetch(probe.shareUrl,{method:'GET',credentials:'omit',redirect:'follow',cache:'no-store',headers:{accept:'text/html,application/xhtml+xml'}});
                      const getBytes=new Uint8Array(await get.arrayBuffer());
                      const getText=new TextDecoder().decode(getBytes);
                      const getHash=await crypto.subtle.digest('SHA-256',getBytes);
                      const getSha=[...new Uint8Array(getHash)].map(x=>x.toString(16).padStart(2,'0')).join('');
                      const getUnavailable=/chat no longer exists|conversation (?:is|was) (?:unavailable|deleted)|unable to find (?:this )?(?:chat|conversation)|not found|더 이상 사용할 수 없|채팅을 찾을 수 없|대화를 찾을 수 없/i.test(getText);
                      const res=await fetch(probe.endpoint,{method:'POST',credentials:'omit',redirect:'manual',cache:'no-store',referrer:probe.shareUrl,referrerPolicy:'strict-origin-when-cross-origin',headers:{'content-type':probe.contentType,'x-same-domain':'1'},body:probe.body});
                      response=res;bytes=new Uint8Array(await res.arrayBuffer());text=new TextDecoder().decode(bytes);
                      const hash=await crypto.subtle.digest('SHA-256',bytes);const sha=[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
                      const unavailable=/chat no longer exists|conversation (?:is|was) (?:unavailable|deleted)|unable to find (?:this )?(?:chat|conversation)|not found|permission denied|access denied|not authorized|404|NOT_FOUND|PERMISSION_DENIED|UNAUTHENTICATED|더 이상 사용할 수 없|채팅을 찾을 수 없|대화를 찾을 수 없/i.test(text);
                      let rpcSummary={frameParsed:false,dataRootType:'unparsed',dataRootLength:null,errorFieldPresent:false,unavailableStringPresent:false,xssiPrefix:false,firstLineNumeric:false,declaredFrameLength:null,utf16Overhead2FrameParsed:false,rawFrameLengthFrameParsed:false,directJsonParsed:false};
                      const findFrame=(root)=>{const stack=[root];let visited=0;while(stack.length&&visited<5000){const value=stack.pop();visited++;if(Array.isArray(value)){if(value[0]==='wrb.fr'&&value[1]==='ujx1Bf')return value;stack.push(...value.slice(0,500));}}return null;};
                      const parseFrame=(candidate)=>{try{return findFrame(JSON.parse(candidate));}catch{return null;}};
                      try {
                        let source = text.trimStart();
                        const newline = String.fromCharCode(10);
                        rpcSummary.xssiPrefix = source.startsWith(")]}'");
                        if (rpcSummary.xssiPrefix) {
                          const xssiEnd = source.indexOf(newline);
                          if (xssiEnd >= 0) source = source.slice(xssiEnd + 1);
                        }
                        source = source.trimStart();
                        const lineEnd = source.indexOf(newline);
                        let frame = null;
                        if (lineEnd >= 0) {
                          const declared = Number(source.slice(0, lineEnd).trim());
                          rpcSummary.firstLineNumeric = Number.isSafeInteger(declared) && declared > 0;
                          rpcSummary.declaredFrameLength = rpcSummary.firstLineNumeric ? declared : null;
                          if (rpcSummary.firstLineNumeric) {
                            const rest = source.slice(lineEnd + 1);
                            const candidates = [
                              { text: rest.slice(0, Math.max(0, declared - 2)).trim(), mode: 'utf16Overhead2' },
                              { text: rest.slice(0, declared).trim(), mode: 'declaredLength' },
                              { text: rest.slice(0, Math.min(rest.length, declared + 2)).trim(), mode: 'declaredPlus2' },
                              { text: rest.trim(), mode: 'entireRemainder' },
                            ];
                            for (const candidate of candidates) {
                              frame = parseFrame(candidate.text);
                              if (frame) {
                                rpcSummary.frameParsed = true;
                                rpcSummary.utf16Overhead2FrameParsed = candidate.mode === 'utf16Overhead2';
                                rpcSummary.rawFrameLengthFrameParsed = candidate.mode === 'declaredLength';
                                break;
                              }
                            }
                          }
                        }
                        if (!frame) {
                          try {
                            const root = JSON.parse(source);
                            rpcSummary.directJsonParsed = true;
                            frame = findFrame(root);
                          } catch {}
                        }
                        if (frame) {
                          rpcSummary.frameParsed = true;
                          let data = frame[2];
                          if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
                          const stack = [data];
                          let visited = 0;
                          let errorField = false;
                          let errorText = false;
                          while (stack.length && visited < 5000) {
                            const value = stack.pop();
                            visited += 1;
                            if (typeof value === 'string') {
                              if (/not found|not available|not authorized|permission denied|deleted|unavailable|error/i.test(value)) errorText = true;
                            } else if (Array.isArray(value)) {
                              stack.push(...value.slice(0, 500));
                            } else if (value && typeof value === 'object') {
                              for (const [key, child] of Object.entries(value)) {
                                if (/error|status|message|reason/i.test(key)) errorField = true;
                                stack.push(child);
                              }
                            }
                          }
                          rpcSummary.dataRootType = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;
                          rpcSummary.dataRootLength = Array.isArray(data) ? data.length : null;
                          rpcSummary.errorFieldPresent = errorField;
                          rpcSummary.unavailableStringPresent = errorText;
                        }
                      } catch {}
                      out.push({get:{httpStatus:get.status,contentType:(get.headers.get('content-type')||'').split(';')[0].toLowerCase(),responseBytes:getBytes.byteLength,responseSha256:getSha,taskTitleReturned:getText.includes(title),taskMarkerReturned:getText.includes(marker),unavailableMessagePresent:getUnavailable,cookieHeaderSent:false,authorizationHeaderSent:false},rpc:{httpStatus:res.status,contentType:(res.headers.get('content-type')||'').split(';')[0].toLowerCase(),responseBytes:bytes.byteLength,responseSha256:sha,rpcIdPresent:text.includes('ujx1Bf'),taskTitleReturned:text.includes(title),taskMarkerReturned:text.includes(marker),unavailableMessagePresent:unavailable,...rpcSummary,cookieHeaderSent:false,authorizationHeaderSent:false}});
                      getBytes.fill(0);
                    } catch { out.push({fetchError:true}); }
                    finally { bytes.fill(0);text='';response=null; }
                  }
                  return out;
                }""", {'probes': probes, 'title': TASK_TITLE, 'marker': TASK_MARKER})
                page.wait_for_timeout(250)
            finally:
                page.unroute('**/*', guard)
                page.wait_for_timeout(300)
        if not isinstance(js_results, list) or len(js_results) != 2:
            kind = type(js_results).__name__
            size = len(js_results) if isinstance(js_results, (list, dict, str)) else 0
            result_shapes = []
            if isinstance(js_results, list):
                result_shapes = [
                    {'type': type(item).__name__, 'keys': sorted(item.keys()) if isinstance(item, dict) else []}
                    for item in js_results[:4]
                ]
            print(json.dumps({'anonymousProbeCount': len(probes), 'returnedType': kind,
                              'returnedCount': size, 'resultShapes': result_shapes}, separators=(',', ':')),
                  file=sys.stderr)
            raise SafeFailure(f'ANONYMOUS_SHARE_RESULT_COUNT_INVALID_{kind}_{size}')
        checks = js_results
        responses_omit_content = all(
            isinstance(item, dict) and isinstance(item.get('get'), dict) and isinstance(item.get('rpc'), dict)
            and not item['get'].get('taskTitleReturned') and not item['get'].get('taskMarkerReturned')
            and not item['rpc'].get('taskTitleReturned') and not item['rpc'].get('taskMarkerReturned')
            and item['get'].get('cookieHeaderSent') is False and item['rpc'].get('cookieHeaderSent') is False
            and item['get'].get('authorizationHeaderSent') is False and item['rpc'].get('authorizationHeaderSent') is False
            for item in checks
        )
        route_requests_clean = (len(request_results) == 4
                                and all(item.get('cookieHeaderSent') is False
                                        and item.get('authorizationHeaderSent') is False for item in request_results))
        explicit_rejection_signals = all(
            item['rpc'].get('httpStatus', 0) >= 400
            or item['rpc'].get('unavailableMessagePresent') is True
            or item['rpc'].get('unavailableStringPresent') is True
            or item['rpc'].get('errorFieldPresent') is True
            or item['rpc'].get('rpcIdPresent') is not True
            for item in checks
        )
        all_denied = responses_omit_content and explicit_rejection_signals and route_requests_clean
        receipt = {
            'schema': 'gemini-share-anonymous-read-v1',
            'service': 'gemini-web',
            'feature': 'share',
            'operation': 'share_public_read',
            'outcome': 'verified_rejected' if all_denied else 'content_absent_signal_inconclusive',
            'verifiedAt': datetime.now(timezone.utc).isoformat(),
            'pageRole': PAGE_ROLE,
            'authenticatedCookiesSent': False,
            'authorizationHeadersSent': False,
            'anonymousReads': checks,
            'requestHeaderAudit': request_results,
            'allAnonymousResponsesOmittedTaskContent': responses_omit_content and route_requests_clean,
            'explicitRejectionSignalPresent': explicit_rejection_signals,
            'browserPageRestored': True,
            'publicUrlsPersisted': False,
            'shareIdsPersisted': False,
            'rawRequestOrResponseBodyPersisted': False,
        }
        write_receipt(receipt)
        print(json.dumps({'outcome': receipt['outcome'],'anonymousUrlsChecked':len(checks),
                          'allTaskContentAbsent':responses_omit_content and route_requests_clean,
                          'explicitRejectionSignalPresent':explicit_rejection_signals,
                          'receipt':str(RECEIPT_PATH)},separators=(',',':')))
        return 0 if all_denied else 2
    except SafeFailure as exc:
        print(exc.code, file=sys.stderr)
        return 1
    except Exception as exc:
        print('ANONYMOUS_SHARE_BROWSER_CHECK_FAILED:' + stage + ':' + type(exc).__name__, file=sys.stderr)
        return 1
    finally:
        wipe(session)
        session = None
        expected_owner = ''
        wipe(probes)
        probes = []


if __name__ == '__main__':
    raise SystemExit(main())
