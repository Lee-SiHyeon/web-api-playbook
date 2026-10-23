#!/usr/bin/env python3
"""Read back only Gemini media conversations correlated to this task's goal times."""

import base64
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME_OWNER = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005/runtime-owner.json'
MEDIA_ROOT = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005/media-intents'
PAGE_MARKER = 'codex-gemini-media-20261006'
SERVICE_ORIGIN = 'https://gemini.google.com'
LIST_RPC = 'MaZiqc'
LIST_PATH = '/_/BardChatUi/data/batchexecute'
INTENT_HASHES = {
    'image': 'abfe3f954d97a45ae70bfa0680a96e2e950b3648ba0d560c3d9cc01fa08b28a4',
    'video': '798c662bed8d133dcf1804c0930ca0c2dd58a4589bd079c4cab23f8cd4a74f3c',
}
MAX_DETAIL_READS = 5
TASK_TEXTS = {}


def normalize_task_text(value):
    return str(value).replace('\r\n', '\n').replace('\r', '\n').strip()


def load_task_texts_from_stdin():
    try:
        raw = sys.stdin.read(8193)
        if not raw or len(raw.encode('utf-8')) > 8192:
            return {}
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            return {}
        result = {}
        for capability in ('image', 'video'):
            value = parsed.get(capability)
            if not isinstance(value, str) or len(value) > 1000:
                continue
            normalized = normalize_task_text(value)
            if hashlib.sha256(normalized.encode('utf-8')).hexdigest() == INTENT_HASHES[capability]:
                result[capability] = normalized
        return result
    except Exception:
        return {}

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location('media_browser_once', REPO / 'scripts' / 'media-browser-direct-once.py')
media = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(media)


def iso_epoch(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except Exception:
        return None


def epoch_value(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if 1_700_000_000 <= number <= 2_000_000_000:
            return number
        if 1_700_000_000_000 <= number <= 2_000_000_000_000:
            return number / 1000
        if 1_700_000_000_000_000 <= number <= 2_000_000_000_000_000:
            return number / 1_000_000
    if isinstance(value, str):
        try:
            return epoch_value(float(value))
        except Exception:
            return None
    return None


def visible_app_link_ids(page):
    return page.evaluate('''() => Array.from(document.querySelectorAll('a[href]'))
      .filter(a=>{const r=a.getBoundingClientRect();return r.width>0&&r.height>0})
      .map(a=>{try{const u=new URL(a.href);if(u.origin!==location.origin)return null;const m=u.pathname.match(/^\\/app\\/([A-Za-z0-9_-]{8,80})$/);return m?m[1]:null}catch{return null}})
      .filter(Boolean)''')


def decode_batch(raw):
    try:
        form = dict(urllib.parse.parse_qsl(bytes(raw).decode('utf-8'), keep_blank_values=True))
        outer = json.loads(form.get('f.req', ''))
        if isinstance(outer, list) and len(outer) == 2 and outer[0] is None and isinstance(outer[1], str):
            inner = json.loads(outer[1])
        else:
            inner = outer
        return form, inner
    except Exception:
        return {}, None


def find_rpc_argument_vector(value, rpc_id, depth=0):
    if depth > 24:
        return None
    if isinstance(value, list):
        if len(value) >= 4 and value[0] == rpc_id and value[3] == 'generic':
            return value[1]
        for item in value:
            result = find_rpc_argument_vector(item, rpc_id, depth + 1)
            if result is not None:
                return result
    elif isinstance(value, dict):
        for item in value.values():
            result = find_rpc_argument_vector(item, rpc_id, depth + 1)
            if result is not None:
                return result
    return None


def rpc_argument_template(raw_body, rpc_id, raw_candidate_id):
    _form, inner = decode_batch(raw_body)
    decoded = media.parse_nested_json(inner) if inner is not None else None
    arguments = find_rpc_argument_vector(decoded, rpc_id)
    if not isinstance(arguments, list):
        return None
    matched_paths = []

    def replace_exact(value, path=()):
        if isinstance(value, str):
            if value == raw_candidate_id:
                matched_paths.append(list(path))
                return '{{apiConversationId}}'
            raise ValueError('unclassified string argument')
        if value is None or isinstance(value, (int, float, bool)):
            return value
        if isinstance(value, list):
            return [replace_exact(item, (*path, index)) for index, item in enumerate(value)]
        if isinstance(value, dict):
            return {str(key): replace_exact(item, (*path, str(key))) for key, item in value.items()}
        raise ValueError('unsupported argument type')

    try:
        template = replace_exact(arguments)
    except Exception:
        return None
    if len(matched_paths) != 1:
        return None
    return {'length': len(template), 'arguments': template, 'identifierPath': matched_paths[0]}


def response_rpc_ids(frames):
    ids = set()

    def walk(value, depth=0):
        if depth > 24:
            return
        if isinstance(value, list):
            if len(value) >= 3 and value[0] == 'wrb.fr' and isinstance(value[1], str):
                ids.add(value[1])
                return
            for item in value:
                walk(item, depth + 1)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item, depth + 1)

    for frame in frames:
        walk(frame)
    return sorted(ids)


def parse_response_frames_strict(raw):
    try:
        text = bytes(raw).decode('utf-8')
    except Exception:
        return [], 'binary'
    if text.startswith(")]}'"):
        text = text[4:]
    text = text.lstrip('\r\n \t')
    decoder = json.JSONDecoder()
    cursor = 0
    frames = []
    while cursor < len(text):
        while cursor < len(text) and text[cursor] in '\r\n \t':
            cursor += 1
        if cursor >= len(text):
            break
        line_end = text.find('\n', cursor)
        if line_end < 0:
            break
        header = text[cursor:line_end].strip().rstrip('\r')
        if not header.isdigit():
            break
        value_start = line_end + 1
        try:
            value, value_end = decoder.raw_decode(text, value_start)
        except Exception:
            return [], 'utf16_length_frame_parse_failed'
        measured = len(text[value_start:value_end].encode('utf-16-le')) // 2
        if measured + 2 != int(header):
            return [], 'utf16_length_mismatch'
        frames.append(value)
        cursor = value_end
    if frames:
        return frames, 'utf16_length_frames'
    stripped = text.strip()
    try:
        return [json.loads(stripped)], 'json'
    except Exception:
        return [], 'unclassified'


def rpc_payloads(frames, rpc_id):
    found = []

    def walk(value):
        if isinstance(value, list):
            if len(value) >= 3 and value[0] == 'wrb.fr' and value[1] == rpc_id:
                payload = value[2]
                if isinstance(payload, str):
                    try:
                        payload = json.loads(payload)
                    except Exception:
                        pass
                found.append(media.parse_nested_json(payload))
                return
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)

    for frame in frames:
        walk(frame)
    return found


def conversation_rows(payloads):
    found = []

    def walk(value, depth=0):
        if depth > 24:
            return
        if isinstance(value, list):
            if len(value) >= 20 and all(isinstance(row, list) and len(row) == 22 for row in value[:min(5, len(value))]):
                found.append(value)
                return
            for item in value:
                walk(item, depth + 1)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item, depth + 1)

    for payload in payloads:
        walk(payload)
    return found


def safe_schema_path(path):
    safe_path = []
    for segment in path:
        if isinstance(segment, int):
            safe_path.append(segment)
        elif re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,64}', str(segment)) and not re.fullmatch(r'[0-9a-fA-F-]{16,}|\d{5,}', str(segment)):
            safe_path.append(str(segment))
        else:
            safe_path.append('{redacted_field}')
    return safe_path


def row_visible_conversation_id(row, visible_ids):
    matches = []

    def walk(value, path=(), depth=0):
        if depth > 16:
            return
        if isinstance(value, str):
            if value in visible_ids:
                matches.append((value, list(path)))
        elif isinstance(value, list):
            for index, child in enumerate(value[:100]):
                walk(child, (*path, index), depth + 1)
        elif isinstance(value, dict):
            for key, child in list(value.items())[:100]:
                walk(child, (*path, str(key)), depth + 1)

    walk(row)
    unique = {(value, tuple(path)) for value, path in matches}
    if len(unique) != 1:
        return None, None
    value, path = next(iter(unique))
    return value, safe_schema_path(path)


def raw_candidate_route_id(raw_candidate_id, visible_ids):
    if not isinstance(raw_candidate_id, str) or not re.fullmatch(r'c_[0-9a-f]{16}', raw_candidate_id):
        return None
    route_id = raw_candidate_id[2:]
    matches = [value for value in visible_ids if value == route_id]
    return route_id if len(matches) == 1 else None


def task_exact_in_value(value, expected_hash):
    found = False
    count = 0

    def walk(item, depth=0):
        nonlocal found, count
        if depth > 30 or count > 200000 or found:
            return
        count += 1
        if isinstance(item, str):
            normalized = normalize_task_text(item)
            if (hashlib.sha256(item.encode('utf-8', 'ignore')).hexdigest() == expected_hash
                    or hashlib.sha256(normalized.encode('utf-8', 'ignore')).hexdigest() == expected_hash
                    or any(normalized == normalize_task_text(expected) for expected in TASK_TEXTS.values())):
                found = True
        elif isinstance(item, list):
            for child in item[:10000]:
                walk(child, depth + 1)
        elif isinstance(item, dict):
            for child in list(item.values())[:10000]:
                walk(child, depth + 1)

    walk(value)
    return found


def matching_task_paths(value, capability):
    expected = normalize_task_text(TASK_TEXTS.get(capability, ''))
    expected_hash = INTENT_HASHES.get(capability)
    matches = []

    def walk(item, path=(), depth=0, budget=None):
        if budget is None:
            budget = [0]
        if depth > 32 or budget[0] >= 200000 or len(matches) >= 50:
            return
        budget[0] += 1
        if isinstance(item, str):
            normalized = normalize_task_text(item)
            digest = hashlib.sha256(normalized.encode('utf-8', 'ignore')).hexdigest()
            if (expected and normalized == expected) or digest == expected_hash:
                matches.append({'path': safe_schema_path(path), '_rawPath': list(path), 'normalizedLength': len(normalized)})
        elif isinstance(item, list):
            for index, child in enumerate(item[:10000]):
                walk(child, (*path, index), depth + 1, budget)
        elif isinstance(item, dict):
            for key, child in list(item.items())[:10000]:
                walk(child, (*path, str(key)), depth + 1, budget)

    walk(value)
    return matches


def value_at_path(value, path):
    current = value
    try:
        for segment in path:
            current = current[segment]
        return current
    except Exception:
        return None


def collect_https_values(value, path=(), found=None, depth=0):
    if found is None:
        found = []
    if depth > 24 or len(found) >= 100:
        return found
    if isinstance(value, str):
        if value.startswith('https://'):
            found.append((value, safe_schema_path(path)))
    elif isinstance(value, list):
        for index, child in enumerate(value[:5000]):
            collect_https_values(child, (*path, index), found, depth + 1)
    elif isinstance(value, dict):
        for key, child in list(value.items())[:5000]:
            collect_https_values(child, (*path, str(key)), found, depth + 1)
    return found


def task_response_candidate(value, capability):
    for match in matching_task_paths(value, capability):
        path = match.get('_rawPath', [])
        if len(path) < 3 or path[-3:] != [2, 0, 0]:
            continue
        turn_path = path[:-3]
        turn = value_at_path(value, turn_path)
        try:
            candidate = turn[3][0]
        except Exception:
            candidate = None
        if candidate is not None:
            return {
                'intentMatch': True,
                'intentPath': path,
                'intentLength': match['normalizedLength'],
                'turnPath': safe_schema_path(turn_path),
                'candidatePath': safe_schema_path((*turn_path, 3, 0)),
                'turn': turn,
                'candidate': candidate,
            }
    return {'intentMatch': False, 'candidate': None, 'turn': None, 'intentPath': None, 'candidatePath': None}


def persist_verified_media_bytes(data, mime, capability):
    saved = media.save_media_verified(data, mime, capability)
    if not isinstance(saved, dict) or saved.get('saved') is not True:
        return {'saved': False, 'mime': mime, 'bytes': len(data), 'reason': saved.get('reason') if isinstance(saved, dict) else 'format_rejected'}
    target = pathlib.Path(saved.get('path', ''))
    try:
        readback = target.read_bytes()
    except Exception:
        return {'saved': False, 'mime': mime, 'bytes': len(data), 'reason': 'readback_failed'}
    magic_ok = media.validate_media_bytes(readback, mime, capability) == mime
    return {
        'saved': bool(magic_ok), 'filename': target.name,
        'mime': mime, 'bytes': len(readback), 'magicVerified': bool(magic_ok),
        'independentFileReadback': bool(magic_ok),
    }


def inspect_task_candidate_media(candidate, capability):
    urls = collect_https_values(candidate)
    refs = []
    eligible = []
    blocked = 0
    for url, path in urls[:20]:
        origin = observed_google_media_origin(url)
        if not origin:
            blocked += 1
            continue
        ref = safe_media_ref(url)
        if ref:
            ref['fieldPath'] = path
            refs.append(ref)
            eligible.append((url, origin, path))
    inline = media.collect_media_candidates(candidate, capability)
    return {'urls': eligible, 'refs': refs, 'blockedOriginCount': blocked, 'inline': inline}


def first_party_google_media_origin(url):
    origin = observed_google_media_origin(url)
    if not origin:
        return None
    host = urllib.parse.urlsplit(origin).hostname or ''
    if not (host == 'googleusercontent.com' or host.endswith('.googleusercontent.com')
            or host == 'gstatic.com' or host.endswith('.gstatic.com')
            or host == 'usercontent.google.com' or host.endswith('.usercontent.google.com')):
        return None
    return origin


def observed_redirect_edges(state, source_url):
    events = state.get('redirect_chain_events', [])
    request_ids = {item.get('requestId') for item in events if item.get('sourceUrl') == source_url}
    edges = {}
    for item in events:
        if item.get('requestId') not in request_ids:
            continue
        from_url = item.get('sourceUrl')
        to_url = item.get('targetUrl')
        source_origin = first_party_google_media_origin(from_url or '')
        target_origin = first_party_google_media_origin(to_url or '')
        if source_origin and target_origin:
            edges.setdefault(from_url, set()).add(target_origin)
    return edges


def safe_observed_redirect_receipts(state, source_url):
    events = state.get('redirect_chain_events', [])
    request_ids = {item.get('requestId') for item in events if item.get('sourceUrl') == source_url}
    safe = []
    for item in events:
        if item.get('requestId') not in request_ids:
            continue
        target = item.get('targetUrl')
        try:
            parsed = urllib.parse.urlsplit(target or '')
        except Exception:
            continue
        origin = first_party_google_media_origin(target or '')
        if not origin:
            continue
        safe.append({
            'httpStatus': item.get('status'), 'origin': origin,
            'pathFamily': media.safe_path(parsed.path),
            'queryKeyNames': [key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)],
            'destinationOriginObservedInOwnedTaskRedirect': True,
        })
    return safe[:3]


def download_task_asset_bounded(url, capability, state):
    parsed = urllib.parse.urlsplit(url)
    source_origin = first_party_google_media_origin(url)
    if (source_origin is None or parsed.scheme != 'https' or not parsed.hostname
            or parsed.username or parsed.password or parsed.fragment):
        return {'status': 'asset_url_rejected', 'redirects': [], 'artifact': None}
    edges = observed_redirect_edges(state, url)
    current = url
    redirect_receipts = []
    started = time.monotonic()
    max_bytes = 256 * 1024 * 1024
    opener = urllib.request.build_opener(media.NoRedirect())
    for hop in range(4):
        if time.monotonic() - started > 45:
            return {'status': 'asset_time_limit', 'redirectCount': len(redirect_receipts),
                    'redirects': redirect_receipts, 'artifact': None}
        current_parsed = urllib.parse.urlsplit(current)
        current_origin = first_party_google_media_origin(current)
        if (current_origin is None or current_parsed.scheme != 'https'
                or current_parsed.username or current_parsed.password or current_parsed.fragment):
            return {'status': 'redirect_url_rejected', 'redirectCount': len(redirect_receipts),
                    'redirects': redirect_receipts, 'artifact': None}
        request = urllib.request.Request(current, method='GET')
        try:
            response = opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            location = error.headers.get('Location') if error.headers else None
            if error.code not in (301, 302, 303, 307, 308) or not location:
                return {'status': 'asset_http_rejected', 'httpStatus': error.code,
                        'redirectCount': len(redirect_receipts), 'redirects': redirect_receipts,
                        'mime': (error.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
                                 if error.headers else None), 'artifact': None}
            if hop >= 3:
                return {'status': 'redirect_limit', 'httpStatus': error.code,
                        'redirectCount': len(redirect_receipts), 'redirects': redirect_receipts,
                        'artifact': None}
            target = urllib.parse.urljoin(current, location)
            target_parsed = urllib.parse.urlsplit(target)
            target_origin = first_party_google_media_origin(target)
            observed_for_current = edges.get(current, set())
            if (target_origin is None or target_parsed.scheme != 'https'
                    or target_parsed.username or target_parsed.password or target_parsed.fragment
                    or target_origin not in observed_for_current):
                return {'status': 'redirect_origin_unobserved', 'httpStatus': error.code,
                        'redirectCount': len(redirect_receipts), 'redirects': redirect_receipts,
                        'artifact': None}
            redirect_receipts.append({
                'httpStatus': error.code, 'origin': target_origin,
                'pathFamily': media.safe_path(target_parsed.path),
                'queryKeyNames': [key for key, _ in urllib.parse.parse_qsl(target_parsed.query, keep_blank_values=True)],
                'destinationOriginObservedInOwnedTaskRedirect': True,
            })
            current = target
            continue
        except Exception as error:
            return {'status': 'asset_transport_failed', 'errorClass': type(error).__name__,
                    'redirectCount': len(redirect_receipts), 'redirects': redirect_receipts,
                    'artifact': None}
        with response:
            status = response.status
            mime = response.headers.get('content-type', '').split(';', 1)[0].strip().lower()
            declared = response.headers.get('content-length')
            if status != 200 or (declared and declared.isdigit() and int(declared) > max_bytes):
                return {'status': 'asset_response_rejected', 'httpStatus': status,
                        'redirectCount': len(redirect_receipts), 'redirects': redirect_receipts,
                        'mime': mime, 'artifact': None}
            data = bytearray()
            while True:
                if time.monotonic() - started > 45:
                    data[:] = b'\0' * len(data)
                    return {'status': 'asset_time_limit', 'httpStatus': status,
                            'redirectCount': len(redirect_receipts), 'redirects': redirect_receipts,
                            'mime': mime, 'artifact': None}
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > max_bytes:
                    data[:] = b'\0' * len(data)
                    return {'status': 'asset_too_large', 'httpStatus': status,
                            'redirectCount': len(redirect_receipts), 'redirects': redirect_receipts,
                            'mime': mime, 'artifact': None}
            valid_mime = media.validate_media_bytes(data, mime, capability)
            saved = media.save_media_verified(data, valid_mime, capability) if valid_mime else None
            artifact = None
            if saved and saved.get('saved'):
                target_path = pathlib.Path(saved['path'])
                try:
                    readback = target_path.read_bytes()
                    magic_ok = media.validate_media_bytes(readback, valid_mime, capability) == valid_mime
                    artifact = {
                        'saved': bool(magic_ok), 'filename': target_path.name,
                        'mime': valid_mime, 'bytes': len(readback), 'magicVerified': bool(magic_ok),
                        'independentFileReadback': bool(magic_ok),
                    }
                except Exception:
                    artifact = {'saved': False, 'reason': 'file_readback_failed'}
            size = len(data)
            data[:] = b'\0' * len(data)
            return {'status': 'asset_verified' if artifact and artifact.get('saved') else 'asset_format_rejected',
                    'httpStatus': status, 'mime': valid_mime or mime, 'bytes': size,
                    'redirectCount': len(redirect_receipts), 'redirects': redirect_receipts,
                    'artifact': artifact}
    return {'status': 'redirect_limit', 'redirectCount': len(redirect_receipts),
            'redirects': redirect_receipts, 'artifact': None}


def inspect_browser_or_direct_asset(cdp, state, url, origin, capability):
    network_ids = [request_id for request_id, info in state['network_info'].items()
                   if info.get('url') == url]
    redirect_request_ids = {item.get('requestId') for item in state.get('redirect_chain_events', [])
                            if item.get('sourceUrl') == url}
    network_ids.extend(request_id for request_id in redirect_request_ids if request_id not in network_ids)
    for request_id in network_ids[:2]:
        response = state['response_info'].get(request_id, {})
        if response.get('status') != 200:
            continue
        try:
            body = cdp.send('Network.getResponseBody', {'requestId': request_id})
            data = bytearray(base64.b64decode(body.get('body', '')) if body.get('base64Encoded') else body.get('body', '').encode('utf-8'))
        except Exception:
            continue
        mime = media.validate_media_bytes(data, response.get('mime'), capability)
        artifact = persist_verified_media_bytes(data, mime, capability) if mime else None
        size = len(data)
        data[:] = b'\0' * len(data)
        if artifact and artifact.get('saved'):
            return {'source': 'browser_network', 'httpStatus': response.get('status'),
                    'mime': mime, 'bytes': size,
                    'redirects': safe_observed_redirect_receipts(state, url),
                    'redirectCount': len(safe_observed_redirect_receipts(state, url)),
                    'artifact': artifact}
    downloaded = download_task_asset_bounded(url, capability, state)
    return {'source': 'direct_observed_redirect_read', **downloaded}


def observed_google_media_origin(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        origin = media.canonical_https_origin(parsed.scheme, parsed.netloc)
    except Exception:
        return None
    host = parsed.hostname or ''
    if (origin is None or host == 'gemini.google.com'
            or not (host == 'googleusercontent.com' or host.endswith('.googleusercontent.com')
                    or host == 'gstatic.com' or host.endswith('.gstatic.com')
                    or host == 'usercontent.google.com' or host.endswith('.usercontent.google.com'))):
        return None
    return origin


def browser_task_media(page, expected_hash, expected_text=''):
    return page.evaluate('''async (options)=>{
      const expectedHash=options.expectedHash, expectedText=options.expectedText||'';
      const hex=b=>Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');
      const digest=async s=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
      const normalize=s=>String(s||'').replace(/\\r\\n/g,'\\n').replace(/\\r/g,'\\n').trim();
      const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};
      const leaves=Array.from(document.querySelectorAll('body *')).filter(e=>e.childElementCount===0&&visible(e)&&!e.closest('[role="textbox"],[contenteditable="true"]'));
      const matches=[];
      for(const e of leaves){const t=e.textContent||'';if(t&&(normalize(t)===normalize(expectedText)||await digest(t)===expectedHash||await digest(normalize(t))===expectedHash))matches.push(e)}
      const urls=[];
      for(const match of matches.slice(0,3)){
        let p=match;
        for(let i=0;i<12&&p;i++,p=p.parentElement){
          const media=Array.from(p.querySelectorAll('img,video,source'));
          if(media.length){for(const el of media){const u=el.currentSrc||el.src||el.getAttribute('src')||'';if(u)urls.push(u)}break}
        }
      }
      return {exactTaskMessageVisible:matches.length>0,exactTaskMessageNodeCount:matches.length,taskMediaUrls:[...new Set(urls)].slice(0,20)};
    }''', {'expectedHash': expected_hash, 'expectedText': expected_text})


def find_task_urls(value, expected_hash, cap, found=None, depth=0):
    if found is None:
        found = []
    if depth > 20 or len(found) >= 50:
        return found
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(item, str) and re.search(r'(image|video|media|artifact|source|download|url|uri)', str(key), re.I):
                try:
                    parsed = urllib.parse.urlsplit(item)
                    if parsed.scheme == 'https' and parsed.hostname:
                        found.append(item)
                except Exception:
                    pass
            find_task_urls(item, expected_hash, cap, found, depth + 1)
    elif isinstance(value, list):
        for item in value[:2000]:
            find_task_urls(item, expected_hash, cap, found, depth + 1)
    return found


def safe_media_ref(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        return None
    return {
        'origin': parsed.scheme + '://' + (parsed.hostname or ''),
        'pathFamily': media.safe_path(parsed.path),
        'queryKeyNames': [key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)],
    }


def load_task_goals():
    goals = {}
    job_root = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005/media-dispatch-journal'
    jobs = {}
    try:
        for path in job_root.glob('*.json'):
            record = json.loads(path.read_text())
            capability = record.get('capability')
            if capability in ('image', 'video') and record.get('dispatchCount') == 1 and record.get('state') == 'response_received':
                jobs[capability] = record
    except Exception:
        jobs = {}
    for capability in ('image', 'video'):
        try:
            record = json.loads((MEDIA_ROOT / f'{capability}.intent.json').read_text())
        except Exception:
            continue
        job = jobs.get(capability)
        start = iso_epoch(job.get('createdAt')) if job else None
        end = iso_epoch(job.get('updatedAt')) if job else None
        if (record.get('state') == 'response_received' and record.get('networkDispatchCount') == 1
                and start and end):
            goals[capability] = {
                'goalEpoch': (start + end) / 2,
                'windowStart': start - 10,
                'windowEnd': end + 60,
                'goalStart': job.get('createdAt'),
                'goalEnd': job.get('updatedAt'),
            }
    return goals


def safe_rpc_request(raw, url, headers, method, network_id, candidate_id, state):
    parsed = urllib.parse.urlsplit(url)
    ids = media.rpc_ids_from_body(raw)
    query_ids = urllib.parse.parse_qs(parsed.query, keep_blank_values=True).get('rpcids', [])
    all_ids = sorted(set(ids + query_ids))
    fields, inner = decode_batch(raw)
    decoded_inner = media.parse_nested_json(inner) if inner is not None else None
    query_values = [v for vals in urllib.parse.parse_qs(parsed.query, keep_blank_values=True).values() for v in vals]
    exact_id_match = candidate_id in query_values or bool(media.string_paths(decoded_inner, candidate_id))
    intent_hash_match = any(task_exact_in_value(decoded_inner, value) for value in INTENT_HASHES.values())
    allowed_reads = bool(all_ids) and all(rpc_id in media.READ_RPC_IDS for rpc_id in all_ids)
    task_detail = (state.get('phase') == 'candidate_navigation' and candidate_id
                   and parsed.path == LIST_PATH and method.upper() == 'POST'
                   and all_ids == ['hNvQHb']
                   and exact_id_match
                   and state.get('candidate_read_count', 0) < 1
                   and not intent_hash_match
                   and {'at', 'f.req'}.issubset(set(fields))
                   and set(fields).issubset({'at', 'f.req'}))
    if allowed_reads and 'hNvQHb' not in all_ids and not intent_hash_match:
        return True, all_ids, fields, exact_id_match, 'known_read'
    if task_detail and len(state['detail_request_records']) < state.get('detail_read_limit', MAX_DETAIL_READS):
        return True, all_ids, fields, True, 'candidate_scoped_detail_read'
    return False, all_ids, fields, exact_id_match, 'blocked_unclassified_post'


def main():
    global TASK_TEXTS
    parser = argparse.ArgumentParser(description='Bounded, task-correlated Gemini history and artifact readback')
    parser.add_argument('--capability', choices=('image', 'video'), help='restrict candidate rows to one dispatch window')
    parser.add_argument('--max-detail-reads', type=int, default=MAX_DETAIL_READS)
    parser.add_argument('--prior-detail-reads', type=int, default=0,
                        help='detail reads already consumed under the same bounded recovery authorization')
    options = parser.parse_args()
    if (options.max_detail_reads < 0 or options.max_detail_reads > MAX_DETAIL_READS
            or options.prior_detail_reads < 0 or options.prior_detail_reads > MAX_DETAIL_READS):
        print(json.dumps({'status': 'stopped', 'code': 'DETAIL_READ_BUDGET_INVALID'}))
        return 2
    detail_read_limit = min(options.max_detail_reads, MAX_DETAIL_READS - options.prior_detail_reads)
    if detail_read_limit < 1:
        print(json.dumps({'status': 'stopped', 'code': 'DETAIL_READ_BUDGET_EXHAUSTED'}))
        return 2
    TASK_TEXTS = load_task_texts_from_stdin()
    goals = load_task_goals()
    if not goals:
        print(json.dumps({'status': 'stopped', 'code': 'NO_COMPLETED_MEDIA_GOAL'}))
        return 2
    owner = json.loads(RUNTIME_OWNER.read_text())
    pid = owner.get('chromePid')
    if not isinstance(pid, int):
        print(json.dumps({'status': 'stopped', 'code': 'OWNED_RUNTIME_INVALID'}))
        return 2
    args = pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
    port = next((int(x.split(b'=', 1)[1]) for x in args if x.startswith(b'--remote-debugging-port=')), None)
    if not isinstance(port, int) or not 1 <= port <= 65535:
        print(json.dumps({'status': 'stopped', 'code': 'OWNED_RUNTIME_PORT_MISSING'}))
        return 2
    state = {
        'phase': 'list_refresh', 'candidate_id': None, 'network_to_request': {},
        'network_info': {}, 'response_info': {}, 'body_targets': {}, 'response_bodies': {},
        'detail_request_records': [], 'blocked_posts': [], 'list_raw': None,
        'list_framing': None, 'list_status': None, 'list_mime': None,
        'history_read_contract': None, 'redirect_chain_events': [],
        'detail_read_limit': detail_read_limit,
    }
    receipt = {
        'schema': 1, 'service': 'gemini-web', 'pageRoleMatched': True,
        'readOnlyCandidateReads': [], 'verifiedArtifacts': [],
        'rawIdsPersisted': False, 'rawResponseBodiesPersisted': False,
        'signedUrlValuesPersisted': False,
    }
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
        if len(browser.contexts) != 1:
            print(json.dumps({'status': 'stopped', 'code': 'OWNED_CONTEXT_COUNT_INVALID'}))
            return 2
        context = browser.contexts[0]
        pages = []
        for page in context.pages:
            parsed = urllib.parse.urlsplit(page.url)
            if parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com':
                try:
                    if page.evaluate('() => window.name') == PAGE_MARKER:
                        pages.append(page)
                except Exception:
                    pass
        if len(pages) != 1:
            print(json.dumps({'status': 'stopped', 'code': 'MEDIA_PAGE_ROLE_AMBIGUOUS'}))
            return 2
        page = pages[0]
        current = urllib.parse.urlsplit(page.url)
        current_route_candidate = re.fullmatch(r'/app/[A-Za-z0-9_-]{8,80}', current.path)
        if current.path != '/app' and not current_route_candidate:
            print(json.dumps({'status': 'stopped', 'code': 'MEDIA_PAGE_NOT_AT_APP'}))
            return 2
        cdp = context.new_cdp_session(page)
        cdp.send('Network.enable')
        cdp.send('Fetch.enable', {'patterns': [{'urlPattern': 'https://gemini.google.com/*', 'requestStage': 'Request'}]})

        def on_request(event):
            request = event.get('request') or {}
            url = request.get('url', '')
            parsed = urllib.parse.urlsplit(url)
            request_id = event.get('requestId')
            if not request_id:
                return
            redirect = event.get('redirectResponse')
            if isinstance(redirect, dict) and isinstance(redirect.get('url'), str):
                state['redirect_chain_events'].append({
                    'requestId': request_id,
                    'sourceUrl': redirect.get('url'),
                    'targetUrl': url,
                    'status': redirect.get('status'),
                })
            state['network_info'][request_id] = {
                'url': url, 'method': str(request.get('method', 'GET')).upper(),
                'host': parsed.hostname, 'path': parsed.path,
                'resourceType': event.get('type'),
            }

        def on_response(event):
            request_id = event.get('requestId')
            response = event.get('response') or {}
            if request_id in state['network_info']:
                state['response_info'][request_id] = {
                    'status': response.get('status'),
                    'mime': str(response.get('mimeType', '')).split(';', 1)[0].strip().lower(),
                    'encodedBytes': response.get('encodedDataLength'),
                }
            if request_id in state['body_targets']:
                entry = state['body_targets'][request_id]
                entry['status'] = response.get('status')
                entry['mime'] = str(response.get('mimeType', '')).split(';', 1)[0].strip().lower()
                if entry.get('kind') == 'list':
                    state['list_status'] = response.get('status')
                    state['list_mime'] = entry['mime']

        def on_loading_finished(event):
            request_id = event.get('requestId')
            if request_id not in state['body_targets']:
                return
            entry = state['body_targets'][request_id]
            try:
                result = cdp.send('Network.getResponseBody', {'requestId': request_id})
                raw = base64.b64decode(result.get('body', '')) if result.get('base64Encoded') else result.get('body', '').encode('utf-8')
                body = bytearray(raw)
                entry['bodyBytes'] = len(body)
                if entry.get('kind') == 'list':
                    state['list_raw'] = body
                    state['list_bytes'] = len(body)
                else:
                    state['response_bodies'].setdefault(entry.get('candidateId'), []).append((entry, body))
            except Exception:
                entry['bodyUnavailable'] = True

        def continue_request(request_id):
            try:
                cdp.send('Fetch.continueRequest', {'requestId': request_id})
            except Exception:
                pass

        def abort_request(request_id):
            try:
                cdp.send('Fetch.failRequest', {'requestId': request_id, 'errorReason': 'BlockedByClient'})
            except Exception:
                pass

        def on_paused(event):
            request = event.get('request') or {}
            url = request.get('url', '')
            method = str(request.get('method', 'GET')).upper()
            parsed = urllib.parse.urlsplit(url)
            request_id = event.get('requestId')
            network_id = event.get('networkId')
            if not request_id:
                return
            if method in ('GET', 'HEAD', 'OPTIONS'):
                continue_request(request_id)
                return
            if parsed.hostname == 'gemini.google.com' and parsed.path in {
                '/_/BardChatUi/jserror', '/_/BardChatUi/cspreport', '/_/BardChatUi/cspreport/fine-allowlist'
            }:
                continue_request(request_id)
                return
            if parsed.hostname == 'gemini.google.com' and parsed.path == LIST_PATH and method == 'POST':
                body_text = request.get('postData')
                if body_text is None:
                    try: body_text = cdp.send('Fetch.getRequestPostData', {'requestId': request_id}).get('postData', '')
                    except Exception: body_text = ''
                raw = str(body_text).encode('utf-8')
                headers = request.get('headers') or {}
                allowed, rpc_ids, fields, id_match, classification = safe_rpc_request(
                    raw, url, headers, method, network_id, state.get('candidate_id'), state
                )
                if state['phase'] == 'list_refresh' and LIST_RPC in rpc_ids and allowed:
                    if network_id:
                        state['body_targets'][network_id] = {
                            'kind': 'list', 'rpcIds': rpc_ids,
                            'queryKeys': [k for k, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)],
                            'headerNames': sorted(str(k).lower() for k in headers),
                            'formFields': list(fields.keys()),
                        }
                    continue_request(request_id)
                    return
                if state['phase'] == 'candidate_navigation' and allowed and classification == 'candidate_scoped_detail_read':
                    request_form, request_inner = decode_batch(raw)
                    request_outer = None
                    try: request_outer = json.loads(request_form.get('f.req', ''))
                    except Exception: pass
                    record = {
                        'timeWindowHints': state.get('candidate_time_window_hints', []), 'rpcIds': rpc_ids,
                        'method': method, 'origin': 'https://gemini.google.com',
                        'pathFamily': media.safe_path(parsed.path),
                        'queryKeys': [key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)],
                        'headerNames': sorted(str(key).lower() for key in headers.keys()),
                        'formFields': list(request_form.keys()), 'bodyBytes': len(raw),
                        'contentType': next((str(value).split(';', 1)[0].strip().lower()
                                             for key, value in headers.items()
                                             if str(key).lower() == 'content-type'), None),
                        'requestOuterFReqShape': media.receipt_shape(request_outer),
                        'requestInnerFReqShape': media.receipt_shape(media.parse_nested_json(request_inner)),
                        'requestArgsTemplate': rpc_argument_template(raw, 'hNvQHb', state.get('candidate_id')),
                        'candidateRowIdLength': state.get('candidate_row_id_length'),
                        'candidateRouteIdLength': len(state.get('candidate_route_id') or ''),
                        'candidateRowIdMatchedInMemory': id_match,
                        'triggeredBySelectedGoalTimeHistoryLink': state.get('candidate_route_loaded') is True,
                    }
                    state['detail_request_records'].append(record)
                    state['candidate_read_count'] = state.get('candidate_read_count', 0) + 1
                    if record.get('requestArgsTemplate') and not state.get('history_read_contract'):
                        state['history_read_contract'] = {
                            'rpcId': 'hNvQHb', 'responseSelector': "wrb.fr[0]=='wrb.fr' && wrb.fr[1]=='hNvQHb'",
                            'method': method, 'origin': 'https://gemini.google.com',
                            'pathFamily': media.safe_path(parsed.path),
                            'queryKeys': record['queryKeys'], 'headerNames': record['headerNames'],
                            'formFieldNames': record['formFields'],
                            'contentType': record['contentType'],
                            'rpcArgsTemplate': record['requestArgsTemplate'],
                        }
                    if network_id:
                        state['body_targets'][network_id] = {
                            'kind': 'detail', 'candidateId': state.get('candidate_id'),
                            'record': record, 'rpcIds': rpc_ids,
                        }
                    continue_request(request_id)
                    return
                if allowed and classification == 'known_read':
                    continue_request(request_id)
                    return
                state['blocked_posts'].append({
                    'pathFamily': media.safe_path(parsed.path), 'rpcIds': rpc_ids,
                    'bodyBytes': len(raw), 'candidateIdMatched': id_match,
                })
                abort_request(request_id)
                return
            state['blocked_posts'].append({'pathFamily': media.safe_path(parsed.path), 'rpcIds': [], 'method': method})
            abort_request(request_id)

        cdp.on('Network.requestWillBeSent', on_request)
        cdp.on('Network.responseReceived', on_response)
        cdp.on('Network.loadingFinished', on_loading_finished)
        cdp.on('Fetch.requestPaused', on_paused)

        if current.path == '/app':
            page.reload(wait_until='domcontentloaded', timeout=30000)
        else:
            page.goto(SERVICE_ORIGIN + '/app', wait_until='domcontentloaded', timeout=30000)
        page.wait_for_timeout(8000)
        if page.evaluate('() => window.name') != PAGE_MARKER:
            print(json.dumps({'status': 'stopped', 'code': 'MEDIA_PAGE_MARKER_CHANGED'}))
            return 2
        if state.get('list_raw') is None:
            print(json.dumps({'status': 'stopped', 'code': 'LIST_RESPONSE_NOT_CAPTURED'}))
            return 2
        frames, list_framing = parse_response_frames_strict(state['list_raw'])
        if list_framing in {'utf16_length_frame_parse_failed', 'utf16_length_mismatch'}:
            print(json.dumps({'status': 'stopped', 'code': 'LIST_FRAME_VALIDATION_FAILED', 'framing': list_framing}))
            state['list_raw'][:] = b'\0' * len(state['list_raw'])
            return 2
        payloads = rpc_payloads(frames, LIST_RPC)
        row_groups = conversation_rows(payloads)
        if not row_groups:
            print(json.dumps({'status': 'stopped', 'code': 'LIST_ROW_SCHEMA_NOT_RECOGNIZED'}))
            return 2
        rows = row_groups[0]
        link_ids = visible_app_link_ids(page)
        candidate_jobs = []
        goal_time_candidate_count = 0
        candidate_mismatch_count = 0
        for index, row in enumerate(rows):
            cell = None
            try:
                cell = row[5][0]
            except Exception:
                pass
            row_epoch = epoch_value(cell)
            if row_epoch is None:
                continue
            window_hints = [capability for capability, goal in goals.items()
                            if (options.capability is None or capability == options.capability)
                            if goal['windowStart'] <= row_epoch <= goal['windowEnd']]
            if not window_hints:
                continue
            goal_time_candidate_count += 1
            row_candidate_id = row[0] if row and isinstance(row[0], str) else None
            if not row_candidate_id or not re.fullmatch(r'c_[0-9a-f]{16}', row_candidate_id):
                candidate_mismatch_count += 1
                continue
            route_id = raw_candidate_route_id(row_candidate_id, link_ids)
            binding = 'literal_c_prefix_bijection' if route_id else 'raw_id_prefix_relation'
            if not route_id:
                route_id = row_candidate_id[2:]
            candidate_id_path = [0]
            exact_id, exact_path = row_visible_conversation_id(row, link_ids)
            if exact_id == route_id:
                candidate_id_path = exact_path
                binding = 'literal_c_prefix_bijection'
            candidate_jobs.append({
                'windowHints': window_hints, 'rowIndex': index,
                'candidateId': row_candidate_id, 'candidateRouteId': route_id,
                'candidateRowIdFieldIndex': 0,
                'candidateRowIdLength': len(row_candidate_id),
                'candidateTimestamp': row_epoch, 'rowCorrelationFieldPath': candidate_id_path,
                'candidateLinkBinding': binding,
                'candidateLinkVisible': route_id in link_ids,
                'startDeltaSeconds': round(min(abs(row_epoch - goals[cap]['goalEpoch']) for cap in window_hints), 3),
            })
        if not candidate_jobs:
            summary = {
                'status': 'inconclusive', 'code': 'NO_GOAL_TIME_CANDIDATE',
                'listStatus': state['list_status'], 'listMime': state['list_mime'],
                'listBytes': len(state['list_raw']), 'listFraming': list_framing,
                'summaryCount': len(rows), 'candidateIdLinkMatches': 0,
                'goalTimeCandidateIdMismatches': candidate_mismatch_count,
            }
            state['list_raw'][:] = b'\0' * len(state['list_raw'])
            receipt.update({
                'listResponse': {
                    'rpcId': LIST_RPC, 'httpStatus': state['list_status'],
                    'mime': state['list_mime'], 'responseBytes': state.get('list_bytes'),
                    'framing': list_framing, 'summaryCount': len(rows),
                    'timestampFieldPath': [5, 0],
                },
                'candidateSelection': {
                    'goalTimeCandidateCount': goal_time_candidate_count,
                    'visibleConversationLinkMatches': sum(1 for item in candidate_jobs if item['candidateLinkVisible']),
                    'detailReadCount': 0,
                    'reason': 'no_valid_row_in_bounded_dispatch_windows',
                },
                'recordedAt': datetime.now(timezone.utc).isoformat(),
            })
            receipt['scriptSha256'] = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
            path = REPO / 'discovery' / 'media-browser-readback-2026-10-06.json'
            temp = path.with_name(path.name + f'.{os.getpid()}.tmp')
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(receipt, stream, ensure_ascii=False, indent=2)
                stream.write('\n')
            os.replace(temp, path)
            summary['receiptPath'] = str(path.resolve())
            print(json.dumps(summary, ensure_ascii=False))
            return 0
        # Inspect at most five history rows in the two bounded dispatch windows.
        candidate_jobs.sort(key=lambda item: (item['startDeltaSeconds'], item['candidateTimestamp'], item['rowIndex']))
        unique_jobs = []
        seen_ids = set()
        for item in candidate_jobs:
            if item['candidateId'] not in seen_ids:
                unique_jobs.append(item)
                seen_ids.add(item['candidateId'])
            if len(unique_jobs) >= detail_read_limit:
                break
        results = []
        for candidate in unique_jobs:
            state['phase'] = 'candidate_navigation'
            state['candidate_id'] = candidate['candidateId']
            state['candidate_time_window_hints'] = candidate['windowHints']
            state['candidate_row_id_length'] = candidate['candidateRowIdLength']
            state['candidate_route_id'] = candidate['candidateRouteId']
            state['candidate_read_count'] = 0
            # Route IDs are the observed 16-hex suffix of the raw c_<id> history value.
            state['candidate_route_loaded'] = True
            before = len(state['detail_request_records'])
            page.goto(SERVICE_ORIGIN + '/app/' + candidate['candidateRouteId'], wait_until='domcontentloaded', timeout=30000)
            current_after_click = urllib.parse.urlsplit(page.url)
            state['candidate_route_opened'] = (
                current_after_click.scheme == 'https'
                and current_after_click.hostname == 'gemini.google.com'
                and current_after_click.path == '/app/' + candidate['candidateRouteId']
            )
            page.wait_for_timeout(9000)
            dom_matches = {
                capability: browser_task_media(page, expected_hash, TASK_TEXTS.get(capability, ''))
                for capability, expected_hash in INTENT_HASHES.items()
            }
            detail_body_entries = state['response_bodies'].get(candidate['candidateId'], [])
            detail_evidence = []
            exact_matches = {capability: False for capability in INTENT_HASHES}
            task_response_values = {capability: [] for capability in INTENT_HASHES}
            response_id_bound = False
            for entry, body in detail_body_entries:
                response_frames, framing = parse_response_frames_strict(body)
                decoded = [media.parse_nested_json(frame) for frame in response_frames]
                response_ids = response_rpc_ids(response_frames)
                candidate_id_present_in_response = any(
                    bool(media.string_paths(frame, entry.get('candidateId', '')))
                    for frame in decoded if entry.get('candidateId')
                )
                response_has_expected_selector = 'hNvQHb' in response_ids
                response_id_bound = response_id_bound or (response_has_expected_selector and candidate_id_present_in_response)
                response_hash = hashlib.sha256(body).hexdigest()
                matched_capabilities = []
                if response_has_expected_selector and candidate_id_present_in_response:
                    for capability, expected_hash in INTENT_HASHES.items():
                        for frame in decoded:
                            if task_exact_in_value(frame, expected_hash):
                                exact_matches[capability] = True
                                matched_capabilities.append(capability)
                                task_turn = task_response_candidate(frame, capability)
                                if task_turn.get('candidate') is not None:
                                    task_response_values[capability].append(task_turn.get('turn') or task_turn['candidate'])
                                break
                payload_types = []
                status_fields = []
                for decoded_frame in decoded[:8]:
                    payload_types.append(media.receipt_shape(decoded_frame))
                    media.collect_status_enum_fields(decoded_frame, found=status_fields)
                detail_evidence.append({
                    'rpcIds': entry.get('rpcIds', []), 'httpStatus': entry.get('status'),
                    'mime': entry.get('mime'), 'responseBytes': entry.get('bodyBytes'),
                    'responseSha256': response_hash,
                    'framing': framing, 'responseShape': payload_types[:4],
                    'responseFrameCount': len(response_frames),
                    'responseRpcIds': response_ids,
                    'statusErrorEnums': status_fields[:30],
                    'taskMessageExactHashMatches': sorted(set(matched_capabilities)),
                    'candidateConversationIdPresentInResponse': candidate_id_present_in_response,
                })
            task_receipts = []
            for capability, verified in exact_matches.items():
                if not verified:
                    continue
                raw_urls = []
                inline_artifact = None
                for task_value in task_response_values[capability]:
                    raw_urls.extend(value for value, _path in collect_https_values(task_value))
                    inline_candidates = media.collect_media_candidates(task_value, capability).get('inline', [])
                    for inline_mime, inline_data, _inline_path in inline_candidates[:1]:
                        inline_buffer = bytearray(inline_data)
                        try:
                            inline_summary = persist_verified_media_bytes(inline_buffer, inline_mime, capability)
                            if inline_summary and inline_summary.get('saved'):
                                inline_artifact = {'source': 'history_inline', 'artifact': inline_summary}
                        finally:
                            inline_buffer[:] = b'\0' * len(inline_buffer)
                        break
                if dom_matches[capability].get('exactTaskMessageVisible'):
                    raw_urls.extend(dom_matches[capability].get('taskMediaUrls', []))
                unique_task_urls = list(dict.fromkeys(raw_urls))[:100]
                eligible = []
                blocked_origin_count = 0
                for source_url in unique_task_urls:
                    origin = first_party_google_media_origin(source_url)
                    if not origin:
                        blocked_origin_count += 1
                        continue
                    ref = safe_media_ref(source_url)
                    if ref:
                        parsed_url = urllib.parse.urlsplit(source_url)
                        hostname = parsed_url.hostname or ''
                        path_lower = parsed_url.path.lower()
                        score = 0
                        if capability == 'video' and (hostname == 'usercontent.google.com' or hostname.endswith('.usercontent.google.com')):
                            score += 100
                        if capability == 'video' and any(token in path_lower for token in ('video', 'mp4', 'download', 'media')):
                            score += 50
                        if capability == 'image' and hostname.endswith('.googleusercontent.com'):
                            score += 20
                        if capability == 'image' and any(token in path_lower for token in ('gg-dl', 'image', 'download')):
                            score += 50
                        eligible.append((score, source_url, origin, ref))
                eligible.sort(key=lambda item: item[0], reverse=True)
                artifact_summary = None
                artifact_attempted = False
                selected_ref = None
                if inline_artifact:
                    artifact_attempted = True
                    artifact_summary = inline_artifact
                elif eligible:
                    # Inspect all correlated URL positions, then make one bounded fetch for this candidate.
                    _score, source_url, origin, selected_ref = eligible[0]
                    artifact_attempted = True
                    artifact_summary = inspect_browser_or_direct_asset(cdp, state, source_url, origin, capability)
                task_receipts.append({
                    'capability': capability,
                    'domTaskMessageExactMatch': bool(dom_matches[capability].get('exactTaskMessageVisible')),
                    'responseTaskMessageExactHashMatch': True,
                    'taskMessageVerified': bool(response_id_bound),
                    'taskMediaUrlCandidateCount': len(unique_task_urls),
                    'taskMediaReferences': [ref for _score, _url, _origin, ref in eligible[:20]],
                    'selectedAssetReference': selected_ref,
                    'blockedOriginCandidateCount': blocked_origin_count,
                    'artifactFetchAttempted': artifact_attempted,
                    'artifactReadback': artifact_summary,
                })
            for _entry, body in detail_body_entries:
                body[:] = b'\0' * len(body)
            results.append({
                'goalTimeCorrelatedCandidate': True,
                'candidateRowIndex': candidate['rowIndex'],
                'candidateRowIdFieldIndex': candidate['candidateRowIdFieldIndex'],
                'candidateRowIdLength': candidate['candidateRowIdLength'],
                'candidateRouteIdLength': len(candidate['candidateRouteId']),
                'candidateRowIdPreservedVerbatim': True,
                'candidatePrefixRelationVerified': state.get('candidate_route_opened') is True,
                'rowCorrelationFieldPath': candidate['rowCorrelationFieldPath'],
                'candidateLinkBinding': candidate['candidateLinkBinding'],
                'candidateLinkVisible': candidate['candidateLinkVisible'],
                'candidateRouteReadOpened': state.get('candidate_route_opened') is True,
                'timeWindowHints': candidate['windowHints'],
                'timeDeltaFromWindowMidpointSeconds': candidate['startDeltaSeconds'],
                'candidateDetailRequestCount': len(state['detail_request_records']) - before,
                'detailRequests': state['detail_request_records'][before:before + 1],
                'detailResponses': detail_evidence[:1],
                'matchedTaskCapabilities': [item['capability'] for item in task_receipts],
                'taskReadbacks': task_receipts,
                'detailResponseIdBound': response_id_bound,
            })
            if state['blocked_posts']:
                results[-1]['blockedPostCount'] = len(state['blocked_posts'])
        if state['list_raw'] is not None:
            state['list_raw'][:] = b'\0' * len(state['list_raw'])
        verified_artifacts = []
        for candidate_result in results:
            for task_result in candidate_result.get('taskReadbacks', []):
                fetch_result = task_result.get('artifactReadback') or {}
                artifact = fetch_result.get('artifact') if isinstance(fetch_result, dict) else None
                if isinstance(artifact, dict) and artifact.get('saved') is True:
                    verified_artifacts.append({
                        'capability': task_result.get('capability'),
                        'filename': artifact.get('filename'), 'mime': artifact.get('mime'),
                        'bytes': artifact.get('bytes'), 'magicVerified': artifact.get('magicVerified'),
                        'independentFileReadback': artifact.get('independentFileReadback'),
                    })
        receipt.update({
            'listResponse': {
                'rpcId': LIST_RPC, 'httpStatus': state['list_status'],
                'mime': state['list_mime'], 'responseBytes': state['list_bytes'] if 'list_bytes' in state else None,
                'framing': list_framing, 'summaryCount': len(rows),
                'timestampFieldPath': [5, 0], 'candidateIdFieldIndex': 0,
            },
            'candidateSelection': {
                'windowRule': 'dispatch_start_minus_10s_through_response_plus_60s',
                'candidateRowsInWindows': goal_time_candidate_count,
                'validCandidateRows': len(candidate_jobs),
                'detailReadLimit': detail_read_limit,
                'detailReadCount': len(state['detail_request_records']),
                'priorDetailReadCount': options.prior_detail_reads,
                'totalDetailReadCountWithinAuthorization': options.prior_detail_reads + len(state['detail_request_records']),
                'candidateRowsMissingRawId': candidate_mismatch_count,
            },
            'historyReadContract': state.get('history_read_contract'),
            'readOnlyCandidateReads': results,
            'candidateReads': results,
            'verifiedArtifacts': verified_artifacts,
            'blockedPostFamilies': state['blocked_posts'][:10],
            'recordedAt': datetime.now(timezone.utc).isoformat(),
        })
        receipt['scriptSha256'] = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
        path = REPO / 'discovery' / 'media-browser-readback-2026-10-06.json'
        temp = path.with_name(path.name + f'.{os.getpid()}.tmp')
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(receipt, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(temp, path)
        try:
            cdp.send('Fetch.disable')
            cdp.send('Network.disable')
        except Exception:
            pass
        print(json.dumps({
            'status': 'readback_complete',
            'listResponse': {'httpStatus': state['list_status'], 'mime': state['list_mime'], 'responseBytes': len(state['list_raw']) if state['list_raw'] else receipt['listResponse']['responseBytes'], 'framing': list_framing, 'summaryCount': len(rows)},
            'candidateReads': [{k: v for k, v in item.items() if k not in ('detailRequests', 'detailResponses', 'taskMediaReferences')} | {
                'detailRequestCount': item.get('candidateDetailRequestCount'),
                'rpcIds': sorted({rpc for detail in item.get('detailRequests', []) for rpc in detail.get('rpcIds', [])}),
                'detailResponseCount': len(item.get('detailResponses', [])),
                'detailResponseShapes': [entry.get('responseShape') for entry in item.get('detailResponses', [])[:2]],
                'statusErrorEnums': [field for entry in item.get('detailResponses', []) for field in entry.get('statusErrorEnums', [])][:20],
                'matchedTaskCapabilities': item.get('matchedTaskCapabilities', []),
                'taskMediaOrigins': sorted({ref['origin'] for task in item.get('taskReadbacks', []) for ref in task.get('taskMediaReferences', [])}),
            } for item in results],
            'historyReadContract': state.get('history_read_contract'),
            'receiptPath': str(path.resolve()),
        }, ensure_ascii=False))
        return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as error:
        print(json.dumps({'status': 'stopped', 'code': 'READBACK_FLOW_FAILED', 'errorClass': type(error).__name__}))
        raise SystemExit(2)
