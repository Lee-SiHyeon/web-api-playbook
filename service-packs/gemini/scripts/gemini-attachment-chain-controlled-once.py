#!/usr/bin/env python3
"""Guarded UI capture + default direct upload/text chain. Browser writes are intercepted."""

import base64
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch' / 'provider-runtime-20261005'
OWNER_FILE = RUNTIME / 'runtime-owner.json'
ROLE_FILE = RUNTIME / 'page-role-registry.json'
ROLE_LOCK = RUNTIME / 'page-role-registry.lock'
PAGE_ROLE = 'codex-gemini-attachment-chain-20261006'
SERVICE_ORIGIN = 'https://gemini.google.com'
UPLOAD_ORIGIN = 'https://push.clients6.google.com'
EXPECTED_ACCOUNT_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
UPLOAD_INTENT = 'gemini-attachment-v8-final-chain-20261006-v1'
MESSAGE_INTENT = 'gemini-attachment-v8-final-chain-message-20261006-v1'
PROMPT = 'Read the attached text file and reply with exactly its contents, with no quotes or extra text.'
FILE_NAME = 'gemini-attachment-v8-final-chain-20261006.txt'
FILE_CONTENT = b'MIME50:OK!!!'
FILE_PATH = RUNTIME / FILE_NAME
CONTRACT_FILE = REPO / 'discovery' / 'observed-contract.json'
IDENTITY_EVIDENCE = REPO / 'verification' / 'one-shot' / 'gemini-identity-session-2026-10-06.json'
RECEIPT_FILE = REPO / 'discovery' / 'gemini-attachment-v8-final-chain-2026-10-06.json'
CLI = REPO / 'src' / 'cli.mjs'
TEXT_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
HISTORY_LIST_RPC = 'MaZiqc'
# Reuse the already captured first-page RPC arguments; a live browser cursor may point past the first page.
CANONICAL_HISTORY_LIST_ARGS = [28, None, [0, None, 1]]
READ_RPC_IDS = {'MaZiqc', 'hNvQHb', 'unqWSc', 'otAQ7b', 'ESY5D', 'OXxBcc', 'ujx1Bf'}
PRIOR_ATTEMPTS = []


class SafeFailure(Exception):
    def __init__(self, code, details=None):
        self.code = code
        self.details = details or {}


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json_atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    except Exception:
        pathlib.Path(temp).unlink(missing_ok=True)
        raise


def source_snapshot():
    paths = sorted((REPO / 'src').glob('*.mjs'))
    paths.extend([CONTRACT_FILE, pathlib.Path(__file__).resolve()])
    entries = []
    for path in sorted(set(paths)):
        body = path.read_bytes()
        entries.append({'path': path.relative_to(REPO).as_posix(), 'bytes': len(body),
            'sha256': hashlib.sha256(body).hexdigest()})
    canonical = json.dumps(entries, separators=(',', ':'), sort_keys=True).encode('utf-8')
    return {'files': entries, 'aggregateSha256': hashlib.sha256(canonical).hexdigest()}


def scrub(value):
    if isinstance(value, dict):
        for key, item in list(value.items()):
            if isinstance(item, str):
                value[key] = ''
            else:
                scrub(item)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            if isinstance(item, str):
                value[index] = ''
            else:
                scrub(item)


def safe_ref(raw_url):
    parsed = urllib.parse.urlsplit(raw_url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise SafeFailure('UPLOAD_SESSION_URL_INVALID')
    path_family = '/'.join(
        '{id}' if len(segment) > 40 or re.fullmatch(r'[0-9a-f-]{16,}', segment, re.I) else segment
        for segment in parsed.path.split('/')
    )
    return {
        'origin': f'https://{parsed.hostname.lower()}',
        'pathFamily': path_family,
        'queryKeyNames': sorted({key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)}),
    }


def safe_url_projection(raw_url):
    """Keep URL identity metadata while preventing query or fragment values from reaching receipts."""
    digest = hashlib.sha256(str(raw_url).encode('utf-8')).hexdigest()
    try:
        parsed = urllib.parse.urlsplit(raw_url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('url_shape')
        origin = f'{parsed.scheme}://{parsed.netloc}'
        path_family = '/'.join(
            '{id}' if len(segment) > 40 or re.fullmatch(r'[0-9a-f-]{16,}', segment, re.I) else segment
            for segment in parsed.path.split('/')
        )
        query_key_names = sorted({key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)})
    except Exception:
        origin = None
        path_family = None
        query_key_names = []
    return {'origin': origin, 'pathFamily': path_family, 'queryKeyNames': query_key_names,
        'fullUrlSha256': digest}


def project_persisted_urls(value, key=None):
    """Recursively convert persisted URL strings into safe origin/path/key/hash records."""
    if isinstance(value, dict):
        return {name: project_persisted_urls(item, name) for name, item in value.items()}
    if isinstance(value, list):
        return [project_persisted_urls(item, key) for item in value]
    if isinstance(value, str):
        try:
            has_query = bool(urllib.parse.urlsplit(value).query)
        except Exception:
            has_query = False
        if 'url' in str(key or '').lower() or (value.startswith(('http://', 'https://')) and has_query):
            return safe_url_projection(value)
    return value


def same_upload_session_url(actual_url, issued_url):
    """Match only the server-issued resumable URL identity; query order may vary, values may not."""
    try:
        actual = urllib.parse.urlsplit(actual_url)
        issued = urllib.parse.urlsplit(issued_url)
        if (actual.scheme != 'https' or issued.scheme != 'https'
                or actual.username is not None or actual.password is not None or actual.fragment
                or issued.username is not None or issued.password is not None or issued.fragment
                or actual.hostname != issued.hostname
                or (actual.port if actual.port is not None else 443)
                  != (issued.port if issued.port is not None else 443)
                or actual.path != issued.path):
            return False
        actual_pairs = urllib.parse.parse_qsl(actual.query, keep_blank_values=True, strict_parsing=True)
        issued_pairs = urllib.parse.parse_qsl(issued.query, keep_blank_values=True, strict_parsing=True)
        if (not actual_pairs or not issued_pairs
                or len({name for name, _ in actual_pairs}) != len(actual_pairs)
                or len({name for name, _ in issued_pairs}) != len(issued_pairs)):
            return False
        return sorted(actual_pairs) == sorted(issued_pairs)
    except Exception:
        return False


def normalized_mime(value):
    if not isinstance(value, str):
        return None
    candidate = value.split(';', 1)[0].strip().lower()
    return candidate if re.fullmatch(r'[a-z0-9.+-]+/[a-z0-9.+-]+', candidate) else None


def read_rpc_args_shape_matches(rpc_id, args):
    if not isinstance(args, list):
        return False
    if rpc_id == 'MaZiqc':
        return (len(args) == 3 and isinstance(args[0], int) and 1 <= args[0] <= 200
                and args[1] is None and isinstance(args[2], list) and len(args[2]) == 3
                and isinstance(args[2][0], int) and 0 <= args[2][0] <= 1_000_000
                and args[2][1] is None and args[2][2] == 1)
    if rpc_id == 'hNvQHb':
        return (len(args) == 8 and isinstance(args[0], str) and 1 <= len(args[0]) <= 256
                and args[1] == 10 and args[2] is None and args[3] == 1
                and args[4] == [1] and args[5] == [4] and args[6] is None and args[7] == 1)
    if rpc_id == 'unqWSc':
        return len(args) == 1 and isinstance(args[0], str) and len(args[0]) <= 2048
    if rpc_id in ('otAQ7b', 'OXxBcc'):
        return args == []
    if rpc_id == 'ESY5D':
        return (len(args) == 2 and args[0] is None and isinstance(args[1], list)
                and 1 <= len(args[1]) <= 512 and all(isinstance(item, int) for item in args[1]))
    if rpc_id == 'ujx1Bf':
        return (len(args) == 3 and args[0] is None and isinstance(args[1], str)
                and 1 <= len(args[1]) <= 256 and args[2] == [4])
    return False


def parsed_read_batch_rpc_ids(request):
    parsed = urllib.parse.urlsplit(request.url)
    query_ids = []
    for value in urllib.parse.parse_qs(parsed.query, keep_blank_values=True).get('rpcids', []):
        query_ids.extend(value.split(','))
    if (request.method != 'POST' or parsed.hostname != 'gemini.google.com'
            or not parsed.path.endswith('/batchexecute') or not query_ids
            or len(set(query_ids)) != len(query_ids) or any(rpc not in READ_RPC_IDS for rpc in query_ids)):
        return None
    raw_body = request.post_data_buffer or b''
    if len(raw_body) > 2 * 1024 * 1024:
        return None
    try:
        form_pairs = urllib.parse.parse_qsl(raw_body.decode('utf-8'), keep_blank_values=True)
        f_req_values = [value for name, value in form_pairs if name == 'f.req']
        if len(f_req_values) != 1:
            return None
        outer = json.loads(f_req_values[0])
        if not isinstance(outer, list) or len(outer) != 1 or not isinstance(outer[0], list) or not outer[0]:
            return None
        calls = outer[0]
        call_ids = []
        for row in calls:
            if (not isinstance(row, list) or len(row) != 4 or not isinstance(row[0], str)
                    or row[0] not in READ_RPC_IDS or row[2] is not None or row[3] != 'generic'):
                return None
            args = json.loads(row[1]) if isinstance(row[1], str) else row[1]
            if not read_rpc_args_shape_matches(row[0], args):
                return None
            call_ids.append(row[0])
        return call_ids if call_ids == query_ids else None
    except Exception:
        return None


def cookie_names(header):
    names = []
    for item in str(header or '').split(';'):
        if '=' not in item:
            continue
        name = item.split('=', 1)[0].strip()
        if re.fullmatch(r'[A-Za-z0-9_.$-]{1,128}', name):
            names.append(name)
    return sorted(set(names))


def validate_current_cookie_jar(cookie_jar, scopes, expected_names):
    scope_by_name = {scope['name']: scope for scope in scopes}
    selected = []
    seen = set()
    now = time.time()
    for cookie in cookie_jar:
        name = cookie.get('name')
        if name not in expected_names:
            continue
        scope = scope_by_name.get(name)
        if (scope is None or cookie.get('domain') != scope['domain'] or cookie.get('path') != scope['path']
                or cookie.get('secure') is not scope['secure'] or (cookie.get('expires', -1) > 0 and cookie['expires'] <= now)
                or name in seen or not isinstance(cookie.get('value'), str) or ';' in cookie['value']
                or re.search(r'(clearance|challenge|captcha|cf[_-]|datadome)', name, re.I)):
            raise SafeFailure('UPLOAD_COOKIE_SCOPE_MISMATCH')
        selected.append({key: cookie.get(key) for key in ('name', 'value', 'domain', 'path', 'secure', 'expires') if key in cookie})
        seen.add(name)
    if sorted(seen) != sorted(expected_names):
        raise SafeFailure('UPLOAD_CURRENT_COOKIE_SET_INCOMPLETE')
    return selected


def capture_history_context(request, body, contract):
    operation = contract.get('operations', {}).get('history_list', {})
    request_contract = operation.get('request', {})
    parsed = urllib.parse.urlsplit(request.url)
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query_names = [name for name, _ in query_pairs]
    expected_query_names = request_contract.get('queryKeys')
    if (request.method != 'POST' or parsed.hostname != 'gemini.google.com'
            or parsed.path != request_contract.get('path') or operation.get('response', {}).get('rpcId') != HISTORY_LIST_RPC
            or query_names != expected_query_names):
        raise SafeFailure('ATTACHMENT_CHAIN_HISTORY_TEMPLATE_MISMATCH')
    query = dict(query_pairs)
    if query.get('rpcids') != HISTORY_LIST_RPC:
        raise SafeFailure('ATTACHMENT_CHAIN_HISTORY_RPC_MISMATCH')
    try:
        form_pairs = urllib.parse.parse_qsl(bytes(body).decode('utf-8'), keep_blank_values=True)
        form_names = [name for name, _ in form_pairs]
        form = dict(form_pairs)
        if form_names != request_contract.get('bodyFieldNames') or not form.get('at'):
            raise ValueError()
        outer = json.loads(form.get('f.req', ''))
        if not isinstance(outer, list) or len(outer) != 1 or not isinstance(outer[0], list) or len(outer[0]) != 1:
            raise ValueError()
        row = outer[0][0]
        if not isinstance(row, list) or len(row) != 4 or row[0] != HISTORY_LIST_RPC or row[2] is not None or row[3] != 'generic':
            raise ValueError()
        args = json.loads(row[1]) if isinstance(row[1], str) else None
    except Exception:
        raise SafeFailure('ATTACHMENT_CHAIN_HISTORY_FORM_INVALID')
    if (not isinstance(args, list) or len(args) != 3 or not isinstance(args[0], int) or not 1 <= args[0] <= 200
            or args[1] is not None or not isinstance(args[2], list) or len(args[2]) != 3
            or not isinstance(args[2][0], int) or not 0 <= args[2][0] <= 1_000_000
            or args[2][1] is not None or args[2][2] != 1):
        raise SafeFailure('ATTACHMENT_CHAIN_HISTORY_ARGS_SHAPE_INVALID')
    for field in ('source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'):
        if not isinstance(query.get(field), str) or not query[field]:
            raise SafeFailure('ATTACHMENT_CHAIN_HISTORY_QUERY_VALUE_MISSING')
    if (not query['source-path'].startswith('/') or not re.fullmatch(r'[A-Za-z0-9._-]{1,256}', query['bl'])
            or not re.fullmatch(r'[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}', query['hl'])
            or not re.fullmatch(r'\d{1,12}', query['_reqid'])
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,16}', query['rt'])):
        raise SafeFailure('ATTACHMENT_CHAIN_HISTORY_QUERY_VALUE_INVALID')
    return {
        'at': form['at'], 'fSid': query['f.sid'], 'buildLabel': query['bl'],
        'locale': query['hl'], 'requestType': query['rt'], 'sourcePath': query['source-path'],
        'requestId': query['_reqid'], 'historyListArgs': CANONICAL_HISTORY_LIST_ARGS.copy(),
        'observedHistoryListArgs': args,
    }


def node_runtime():
    preferred = pathlib.Path.home() / '.npm/_npx/387698761821791d/node_modules/node/bin/node'
    node = os.environ.get('NODE24_BIN') or (str(preferred) if preferred.is_file() else shutil.which('node'))
    if not node:
        raise SafeFailure('NODE_RUNTIME_MISSING')
    return node


def intent_hash(capability, owner, caller_intent):
    canonical = json.dumps(['gemini-web', capability, owner.strip().lower(), caller_intent], separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def mutation_journal_summary(actor):
    root = pathlib.Path.home() / '.config' / 'gemini-web-xhr-client' / 'jobs'
    expected = {
        'attachment_upload': intent_hash('attachment_upload', actor, UPLOAD_INTENT),
        'attachment_upload_transfer': intent_hash('attachment_upload_transfer', actor, UPLOAD_INTENT),
        'text': intent_hash('text', actor, MESSAGE_INTENT),
    }
    result = {}
    if not root.is_dir():
        return result
    for path in root.glob('*.json'):
        try:
            job = read_json(path)
        except Exception:
            continue
        capability = job.get('capability')
        if capability not in expected or job.get('intentKeyHash') != expected[capability]:
            continue
        result[capability] = {
            'state': job.get('state'), 'dispatchCount': job.get('dispatchCount', 0),
            'httpStatus': job.get('httpStatus'),
        }
    return result


def child_read_json_line(process, timeout_seconds=180):
    ready, _, _ = select.select([process.stdout], [], [], timeout_seconds)
    if not ready:
        raise SafeFailure('ATTACHMENT_CHAIN_CHILD_TIMEOUT')
    line = process.stdout.readline()
    if not line or len(line) > 48 * 1024 * 1024:
        if process.poll() is not None and process.stderr is not None:
            diagnostic = process.stderr.read(512)
            matched = re.search(r'\b[A-Z][A-Z0-9_]{2,80}\b', diagnostic or '')
            if matched:
                raise SafeFailure('ATTACHMENT_CHAIN_CHILD_' + matched.group(0))
        raise SafeFailure('ATTACHMENT_CHAIN_CHILD_EOF')
    try:
        return json.loads(line)
    except Exception:
        raise SafeFailure('ATTACHMENT_CHAIN_CHILD_PROTOCOL_INVALID')


def child_send(process, value):
    wire = json.dumps(value, separators=(',', ':'))
    process.stdin.write(wire + '\n')
    process.stdin.flush()
    wire = ''
    scrub(value)


def safe_child_error(event):
    code = event.get('errorCode') if isinstance(event, dict) else None
    error_class = event.get('errorClass') if isinstance(event, dict) else None
    safe = {
        'errorCode': code if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{2,80}', code) else 'CLIENT_FAILED',
        'errorClass': error_class if isinstance(error_class, str) and re.fullmatch(r'[A-Za-z]+Error', error_class) else 'InternalError',
    }
    details = event.get('details') if isinstance(event, dict) and isinstance(event.get('details'), dict) else {}
    binding = safe_attachment_binding(details.get('attachmentBinding'))
    if binding is not None:
        safe['attachmentBinding'] = binding
    for key in ('selectedFileMimeType', 'nativeTransferMimeType', 'expectedTransferMimeType'):
        value = details.get(key)
        if isinstance(value, str):
            normalized = value.split(';', 1)[0].strip().lower()
            if re.fullmatch(r'[a-z0-9.+-]+/[a-z0-9.+-]+', normalized):
                safe[key] = normalized
    if details.get('fileMimeHeaderName') == 'content-type':
        safe['fileMimeHeaderName'] = 'content-type'
    if details.get('sourceEffectiveHeaderName') == 'content-type':
        safe['sourceEffectiveHeaderName'] = 'content-type'
    if details.get('sourceEffectiveHeaderValueSource') == 'xhr_transport_default_content_type':
        safe['sourceEffectiveHeaderValueSource'] = 'xhr_transport_default_content_type'
    for key in ('directDispatchCount', 'startDispatchCount', 'transferDispatchCount', 'httpRequestCount', 'httpStatus',
                'expectedCookieCount', 'actualCookieCount'):
        if isinstance(details.get(key), int):
            safe[key] = details[key]
    if isinstance(details.get('stage'), str) and re.fullmatch(r'[a-z_]{1,40}', details['stage']):
        safe['stage'] = details['stage']
    if isinstance(details.get('queryReadback'), dict):
        query = details['queryReadback']
        safe['queryReadback'] = {
            'httpStatus': query.get('httpStatus') if isinstance(query.get('httpStatus'), int) else None,
            'uploadStatus': query.get('uploadStatus') if isinstance(query.get('uploadStatus'), str) else None,
            'sizeReceived': query.get('sizeReceived') if isinstance(query.get('sizeReceived'), int) else None,
        }
    for key in ('expectedCookieNames', 'actualCookieNames', 'missingCookieNames', 'unexpectedCookieNames', 'valueMismatchCookieNames'):
        value = details.get(key)
        if isinstance(value, list) and all(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.$-]{1,128}', name) for name in value):
            safe[key] = value
    for key in ('nativeHeaderNames', 'installedHeaderNames', 'continuationHeaderValueMismatchNames',
                'requiredHeaderValueMismatchNames', 'unknownHeaderValueMismatchNames', 'optionalBrowserHeaderVariationNames',
                'sourceRequiredHeaderNames', 'sourceEffectiveHeaderValueMismatchNames', 'sourceEffectiveHeaderNames',
                'fileMimeHeaderMismatchNames', 'fileMimeHeaderNames', 'optionalBrowserHeaderNames'):
        value = details.get(key)
        if isinstance(value, list) and all(isinstance(name, str) and re.fullmatch(r'[a-z0-9-]{1,128}', name) for name in value):
            safe[key] = list(value)
    for key in ('expectedCookieScopes', 'currentCookieScopes'):
        value = details.get(key)
        if isinstance(value, list) and all(isinstance(item, dict) and isinstance(item.get('name'), str)
                and isinstance(item.get('domain'), str) and isinstance(item.get('path'), str)
                and isinstance(item.get('secure'), bool) for item in value):
            safe[key] = [{field: item[field] for field in ('name', 'domain', 'path', 'secure')} for item in value]
    if isinstance(details.get('headerNamesMatched'), bool): safe['headerNamesMatched'] = details['headerNamesMatched']
    for key in ('urlMatched', 'urlStringNormalized', 'methodMatched', 'bodyMatched'):
        if isinstance(details.get(key), bool): safe[key] = details[key]
    return safe


def safe_attachment_binding(details):
    if not isinstance(details, dict):
        return None
    safe = {}
    for key in ('sourceShapeMatchCount', 'responsePayloadMatchCount', 'filenameMatchCount', 'mimeTypeMatchCount',
                'fileSizeMatchCount', 'uploadedFilesArrayCount', 'candidateCount', 'sourceTupleMatchCount', 'sourceProtoTupleMatchCount',
                'sourceParentValueMatchCount',
                'expectedFileSizeBytes', 'capturedRequestBodyBytes', 'expectedFilenameBytes',
                'expectedResponsePayloadBytes'):
        if isinstance(details.get(key), int) and not isinstance(details.get(key), bool) and details[key] >= 0:
            safe[key] = details[key]
    for key in ('fileIdPresent', 'expectedFileTypePresent', 'sourceValueCorrelationMatch',
                'capturedPromptContainsReferenceValue'):
        if isinstance(details.get(key), bool):
            safe[key] = details[key]
    for key in ('capturedRequestBodySha256', 'expectedFilenameSha256', 'expectedResponsePayloadSha256'):
        value = details.get(key)
        if isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value, re.I):
            safe[key] = value.lower()
    mime = details.get('expectedMimeType')
    if isinstance(mime, str):
        normalized = mime.split(';', 1)[0].strip().lower()
        if re.fullmatch(r'[a-z0-9.+-]+/[a-z0-9.+-]+', normalized):
            safe['expectedMimeType'] = normalized
    allowed_fields = {'filename', 'name', 'mimeType', 'mime_type', 'dh', 'fileType', 'file_type',
        'gN', 'xl', 'yj', 'QG', 'fileId', 'file_id', 'uploadedFiles', 'uri', 'url'}
    candidates = details.get('candidates')
    if isinstance(candidates, list):
        safe['candidates'] = []
        for candidate in candidates[:32]:
            if not isinstance(candidate, dict):
                continue
            item = {}
            if candidate.get('kind') in ('object', 'array'):
                item['kind'] = candidate['kind']
            field_names = candidate.get('fieldNames')
            if isinstance(field_names, list) and all(name in allowed_fields for name in field_names):
                item['fieldNames'] = list(field_names)
            element_types = candidate.get('elementTypes')
            if isinstance(element_types, list) and all(name in ('string', 'number', 'boolean', 'object', 'array', 'null')
                    for name in element_types):
                item['elementTypes'] = list(element_types)
            for key in ('length', 'filenameBytes', 'dhBytes', 'fileIdLength'):
                value = candidate.get(key)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    item[key] = value
            for key in ('filenameMatched', 'mimeTypeMatched', 'dhMatched', 'fileIdPresent', 'gNPresent', 'xlPresent',
                    'yjPresent', 'QGPresent', 'uploadedFilesPresent', 'uriPresent', 'urlPresent'):
                if isinstance(candidate.get(key), bool):
                    item[key] = candidate[key]
            if isinstance(candidate.get('fileType'), int) and candidate['fileType'] >= 0:
                item['fileType'] = candidate['fileType']
            mime = candidate.get('mimeType')
            if isinstance(mime, str):
                normalized = mime.split(';', 1)[0].strip().lower()
                if re.fullmatch(r'[a-z0-9.+-]+/[a-z0-9.+-]+', normalized):
                    item['mimeType'] = normalized
            for key in ('dhSha256', 'filenameSha256'):
                value = candidate.get(key)
                if isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value, re.I):
                    item[key] = value.lower()
            safe['candidates'].append(item)
    candidates = details.get('sourceProtoCandidates')
    if isinstance(candidates, list):
        safe['sourceProtoCandidates'] = []
        for candidate in candidates[:32]:
            if not isinstance(candidate, dict):
                continue
            item = {}
            for key in ('vePath', 'dqcPath'):
                path = candidate.get(key)
                if isinstance(path, list) and len(path) <= 32 and all(
                    (isinstance(part, int) and not isinstance(part, bool) and part >= 0) or part == 'object'
                    for part in path
                ):
                    item[key] = list(path)
            for key in ('veLength', 'tupleLength', 'filenameBytes', 'dhBytes', 'sizeBytes',
                    'dhArrayIndex', 'sizeArrayIndex', 'contextArrayIndex', 'mimeArrayIndex'):
                value = candidate.get(key)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    item[key] = value
            for key in ('filenameSha256', 'dhSha256'):
                value = candidate.get(key)
                if isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value, re.I):
                    item[key] = value.lower()
            for key in ('filenameMatched', 'dhMatched', 'sizeMatched', 'mimeTypeMatched', 'sourceParentValueMatch',
                    'contextValueIsNumber', 'contextEqualsFileSize', 'matched'):
                value = candidate.get(key)
                if isinstance(value, bool) or value is None:
                    item[key] = value
            if candidate.get('tupleLayout') in ('observed_dqc_dh_context_null_mime',
                    'unclassified_nested_array', 've_parent_values_only'):
                item['tupleLayout'] = candidate['tupleLayout']
            tuple_types = candidate.get('tupleElementTypes')
            if isinstance(tuple_types, list) and all(value in ('string', 'number', 'boolean', 'object', 'array', 'null')
                    for value in tuple_types):
                item['tupleElementTypes'] = list(tuple_types)
            mime = candidate.get('mimeType')
            if isinstance(mime, str):
                normalized = mime.split(';', 1)[0].strip().lower()
                if re.fullmatch(r'[a-z0-9.+-]+/[a-z0-9.+-]+', normalized):
                    item['mimeType'] = normalized
            safe['sourceProtoCandidates'].append(item)
    tuple_candidates = details.get('uploadedFilesTupleCandidates')
    if isinstance(tuple_candidates, list):
        safe['uploadedFilesTupleCandidates'] = []
        for candidate in tuple_candidates[:32]:
            if not isinstance(candidate, dict):
                continue
            item = {}
            for key in ('index', 'responsePayloadMatchCount', 'filenameMatchCount', 'mimeTypeMatchCount',
                    'sourceShapeMatchCount'):
                value = candidate.get(key)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    item[key] = value
            shapes = candidate.get('fieldShapes')
            if isinstance(shapes, list):
                item['fieldShapes'] = []
                for shape in shapes[:8]:
                    if not isinstance(shape, dict):
                        continue
                    safe_shape = {}
                    if shape.get('kind') in ('object', 'array'):
                        safe_shape['kind'] = shape['kind']
                    field_names = shape.get('fieldNames')
                    if isinstance(field_names, list) and all(name in allowed_fields for name in field_names):
                        safe_shape['fieldNames'] = list(field_names)
                    element_types = shape.get('elementTypes')
                    if isinstance(element_types, list) and all(name in ('string', 'number', 'boolean', 'object', 'array', 'null')
                            for name in element_types):
                        safe_shape['elementTypes'] = list(element_types)
                    for key in ('length', 'filenameBytes', 'dhBytes', 'fileIdLength'):
                        value = shape.get(key)
                        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                            safe_shape[key] = value
                    for key in ('filenameMatched', 'mimeTypeMatched', 'dhMatched', 'fileIdPresent', 'gNPresent', 'xlPresent',
                            'yjPresent', 'QGPresent', 'uploadedFilesPresent', 'uriPresent', 'urlPresent'):
                        if isinstance(shape.get(key), bool):
                            safe_shape[key] = shape[key]
                    if isinstance(shape.get('fileType'), int) and shape['fileType'] >= 0:
                        safe_shape['fileType'] = shape['fileType']
                    mime = shape.get('mimeType')
                    if isinstance(mime, str):
                        normalized = mime.split(';', 1)[0].strip().lower()
                        if re.fullmatch(r'[a-z0-9.+-]+/[a-z0-9.+-]+', normalized):
                            safe_shape['mimeType'] = normalized
                    for key in ('dhSha256', 'filenameSha256'):
                        value = shape.get(key)
                        if isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value, re.I):
                            safe_shape[key] = value.lower()
                    item['fieldShapes'].append(safe_shape)
            safe['uploadedFilesTupleCandidates'].append(item)
    return safe


def safe_direct_upload_summary(upload):
    if not isinstance(upload, dict):
        return None
    safe = {}
    for key in ('status',):
        value = upload.get(key)
        if value in ('verified', 'upload_rejected', 'server_response_needs_readback'):
            safe[key] = value
    for key in ('directDispatchCount', 'startDispatchCount', 'transferDispatchCount', 'httpRequestCount',
                'transferHttpStatus', 'transferResponseBytes', 'fileBytes'):
        value = upload.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            safe[key] = value
    for key in ('uploadedFileReadbackVerified', 'journalReconciled', 'attachmentReferenceAvailable'):
        if isinstance(upload.get(key), bool):
            safe[key] = upload[key]
    for key in ('transferContentType', 'fileMimeType'):
        value = upload.get(key)
        normalized = normalized_mime(value)
        if normalized:
            safe[key] = normalized
    for key in ('transferResponseSha256', 'fileSha256'):
        value = upload.get(key)
        if isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value, re.I):
            safe[key] = value.lower()
    continuation_template = upload.get('continuationTemplate')
    if isinstance(continuation_template, dict):
        safe['continuationTemplateUrlIdentity'] = {
            key: continuation_template[key]
            for key in ('serverIssuedUrlIdentityMatched', 'serverIssuedUrlStringNormalized')
            if isinstance(continuation_template.get(key), bool)
        }
    query = upload.get('query')
    if isinstance(query, dict):
        item = {}
        for key in ('httpStatus', 'responseBytes', 'sizeReceived'):
            value = query.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                item[key] = value
        if isinstance(query.get('uploadStatus'), str) and re.fullmatch(r'[a-z_]{1,40}', query['uploadStatus']):
            item['uploadStatus'] = query['uploadStatus']
        if isinstance(query.get('responseSha256'), str) and re.fullmatch(r'[a-f0-9]{64}', query['responseSha256'], re.I):
            item['responseSha256'] = query['responseSha256'].lower()
        header_names = query.get('responseHeaderNames')
        if isinstance(header_names, list) and all(isinstance(name, str) and re.fullmatch(r'[a-z0-9-]{1,128}', name)
                for name in header_names):
            item['responseHeaderNames'] = list(header_names)
        safe['query'] = item
    metadata = upload.get('transferMetadata')
    if isinstance(metadata, dict):
        item = {}
        for key in ('fileNameMatched', 'fileSizeMatched', 'fileMimeMatched', 'fileIdPresent'):
            if isinstance(metadata.get(key), bool):
                item[key] = metadata[key]
        if isinstance(metadata.get('fileIdLength'), int) and metadata['fileIdLength'] >= 0:
            item['fileIdLength'] = metadata['fileIdLength']
        safe['transferMetadata'] = item
    return safe


def read_source_binding_resolution(binding, control_socket_path, timeout_seconds=90):
    """Accept only a plan selecting an already-reported, exact-match VE/dqc candidate."""
    path = pathlib.Path(control_socket_path)
    if path.exists():
        if path.is_socket(): path.unlink()
        else: raise SafeFailure('ATTACHMENT_BINDING_CONTROL_PATH_CONFLICT')
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(path))
    os.chmod(path, 0o600)
    server.listen(1)
    server.settimeout(timeout_seconds)
    try:
        connection, _ = server.accept()
        with connection:
            connection.settimeout(5)
            raw = connection.recv(64 * 1024 + 1)
    except (socket.timeout, TimeoutError):
        return None
    finally:
        server.close()
        path.unlink(missing_ok=True)
    if len(raw) > 64 * 1024:
        return None
    try: control = json.loads(raw.decode('utf-8'))
    except Exception: return None
    raw = b''
    if isinstance(control, dict) and control.get('event') == 'attachment-recovery-abandon' and set(control) == {'event'}:
        scrub(control)
        return None
    if (not isinstance(control, dict) or control.get('event') != 'attachment-binding-resolution'
            or set(control) != {'event', 'vePath', 'dqcPath', 'tupleLayout'}):
        scrub(control)
        return None
    ve_path = control.get('vePath')
    dqc_path = control.get('dqcPath')
    layout = control.get('tupleLayout')
    valid_path = lambda value: isinstance(value, list) and 1 <= len(value) <= 32 and all(
        (isinstance(part, int) and not isinstance(part, bool) and part >= 0) or part == 'object'
        for part in value)
    if not valid_path(ve_path) or not valid_path(dqc_path) or layout != 'observed_dqc_dh_context_null_mime':
        scrub(control)
        return None
    candidates = binding.get('sourceProtoCandidates') if isinstance(binding, dict) else None
    expected_types = ('string', 'number', 'null', 'string')
    candidate_match = isinstance(candidates, list) and any(
        item.get('vePath') == ve_path and item.get('dqcPath') == dqc_path
        and item.get('filenameMatched') is True and item.get('sourceParentValueMatch') is True
        and (item.get('tupleLayout') == layout or item.get('tupleLayout') == 'unclassified_nested_array')
        and isinstance(item.get('tupleElementTypes'), list)
        and tuple(item['tupleElementTypes'][:len(expected_types)]) == expected_types
        for item in candidates if isinstance(item, dict))
    if not candidate_match:
        scrub(control)
        return None
    result = {'vePath': list(ve_path), 'dqcPath': list(dqc_path), 'tupleLayout': layout}
    scrub(control)
    return result


def persist_receipt(value):
    prior = list(PRIOR_ATTEMPTS)
    current_attempt = {
        'recordedAt': value.get('recordedAt'),
        'outputStatus': value.get('outputStatus'),
        'failureCode': value.get('failureCode'),
        'directDispatchCount': value.get('directMutationDispatchCount', value.get('directDispatchCount', 0)),
        'nativeStartObserved': value.get('nativeStartObserved', value.get('nativeStart') is not None),
        'nativeContinuationObserved': value.get('nativeContinuationObserved', value.get('nativeContinuation') is not None),
        'nativeAttachmentMessageObserved': value.get('nativeAttachmentMessageObserved', value.get('nativeAttachmentMessage') is not None),
        'historyArgsMismatch': value.get('historyArgsMismatch'),
        'childError': value.get('childError'),
        'directUploadSafeSummary': value.get('directUploadSafeSummary'),
        'attachmentBindingDiagnostics': value.get('attachmentBindingDiagnostics'),
        'bindingDiagnosticAttempts': value.get('bindingDiagnosticAttempts'),
        'nativeAttachmentMessageCaptureAttempts': value.get('nativeAttachmentMessageCaptureAttempts'),
        'sourceBindingResolutionPlan': value.get('sourceBindingResolutionPlan'),
        'attachmentReferenceRecovery': value.get('attachmentReferenceRecovery'),
        'nativeContinuation': value.get('nativeContinuation'),
        'continuationCookieSnapshot': value.get('continuationCookieSnapshot'),
        'mutationJournal': value.get('mutationJournal', {}),
        'guardLifecycle': value.get('guardLifecycle', {}),
    }
    prior.append(current_attempt)
    value['attemptCount'] = len(prior)
    value['attempts'] = prior
    value['urlPersistencePolicy'] = {
        'urlFieldsProjected': True,
        'rawUrlQueryValuesPersisted': False,
        'projectionKeys': ['origin', 'pathFamily', 'queryKeyNames', 'fullUrlSha256'],
    }
    write_json_atomic(RECEIPT_FILE, project_persisted_urls(value))


def register_page_role(registry, target_id):
    with open(ROLE_LOCK, 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        latest = read_json(ROLE_FILE)
        if latest.get('taskOwned') is not True or latest.get('runtimeChromePid') != registry.get('runtimeChromePid'):
            raise SafeFailure('UPLOAD_RUNTIME_ROLE_REGISTRY_CHANGED')
        roles = latest.setdefault('activePageRoles', {})
        if PAGE_ROLE in roles:
            raise SafeFailure('ATTACHMENT_CHAIN_ROLE_ALREADY_REGISTERED')
        roles[PAGE_ROLE] = {
            'origin': SERVICE_ORIGIN,
            'exactMarkerCount': 1,
            'selection': 'owned_target_id_and_exact_marker',
            'targetId': target_id,
            'targetIdObservedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        write_json_atomic(ROLE_FILE, latest)
        fcntl.flock(lock, fcntl.LOCK_UN)


def mark_page_role_closed(target_id, runtime_pid, reason):
    if not isinstance(target_id, str) or not target_id or reason != 'reset_quiet_unverified':
        raise SafeFailure('ATTACHMENT_CHAIN_CLOSED_ROLE_INVALID')
    with open(ROLE_LOCK, 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        latest = read_json(ROLE_FILE)
        if latest.get('taskOwned') is not True or latest.get('runtimeChromePid') != runtime_pid:
            raise SafeFailure('UPLOAD_RUNTIME_ROLE_REGISTRY_CHANGED')
        roles = latest.get('activePageRoles')
        current = roles.get(PAGE_ROLE) if isinstance(roles, dict) else None
        if not isinstance(current, dict) or current.get('targetId') != target_id:
            raise SafeFailure('ATTACHMENT_CHAIN_ROLE_REGISTRY_CHANGED')
        roles.pop(PAGE_ROLE)
        closed = latest.setdefault('closedPageRoles', [])
        if not isinstance(closed, list):
            raise SafeFailure('ATTACHMENT_CHAIN_CLOSED_ROLE_REGISTRY_INVALID')
        closed.append({
            'role': PAGE_ROLE,
            'origin': SERVICE_ORIGIN,
            'targetId': target_id,
            'closedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'reason': reason,
        })
        latest['closedPageRoles'] = closed[-64:]
        write_json_atomic(ROLE_FILE, latest)
        fcntl.flock(lock, fcntl.LOCK_UN)


def main_inner():
    global PRIOR_ATTEMPTS
    if FILE_CONTENT.decode('utf-8') in PROMPT:
        raise SafeFailure('ATTACHMENT_CHAIN_PROMPT_CONTAINS_FILE_CONTENT')
    if RECEIPT_FILE.exists():
        previous = read_json(RECEIPT_FILE)
        if previous.get('callerIntent') != UPLOAD_INTENT or previous.get('messageCallerIntent') != MESSAGE_INTENT:
            raise SafeFailure('ATTACHMENT_CHAIN_RECEIPT_CONFLICT')
        previous_count = previous.get('directMutationDispatchCount', previous.get('directDispatchCount', 0))
        previous_journal = previous.get('mutationJournal', {})
        journal_dispatches = sum(entry.get('dispatchCount', 0) for entry in previous_journal.values() if isinstance(entry, dict))
        if not isinstance(previous_count, int) or previous_count > 0 or journal_dispatches > 0:
            raise SafeFailure('ATTACHMENT_CHAIN_INTENT_ALREADY_DISPATCHED')
        PRIOR_ATTEMPTS = previous.get('attempts') if isinstance(previous.get('attempts'), list) else [previous]
    if len(FILE_CONTENT) != 12 or FILE_PATH.exists():
        raise SafeFailure('ATTACHMENT_CHAIN_TEST_FILE_STATE_INVALID')
    identity = read_json(IDENTITY_EVIDENCE)
    if (identity.get('ownerMatched') is not True or identity.get('anonymousOwnerAbsent') is not True
            or identity.get('credentialPropagated') is not True):
        raise SafeFailure('EXISTING_GEMINI_OWNER_EVIDENCE_MISMATCH')
    contract = read_json(CONTRACT_FILE)
    upload_contract = contract.get('attachmentUpload')
    if not isinstance(upload_contract, dict) or not isinstance(contract.get('operations', {}).get('text'), dict):
        raise SafeFailure('ATTACHMENT_CHAIN_CONTRACT_NOT_INSTALLED')
    owner = read_json(OWNER_FILE)
    if owner.get('taskOwned') is not True or not isinstance(owner.get('chromePid'), int):
        raise SafeFailure('OWNED_RUNTIME_INVALID')
    process_args = pathlib.Path(f"/proc/{owner['chromePid']}/cmdline").read_bytes().split(b'\0')
    if ('--user-data-dir=' + owner['profile']).encode() not in process_args:
        raise SafeFailure('OWNED_RUNTIME_PROFILE_MISMATCH')
    registry = read_json(ROLE_FILE)
    if registry.get('taskOwned') is not True or registry.get('runtimeChromePid') != owner['chromePid']:
        raise SafeFailure('ATTACHMENT_CHAIN_ROLE_REGISTRY_INVALID')
    registered_role = registry.get('activePageRoles', {}).get(PAGE_ROLE)
    if registered_role is not None and (registered_role.get('origin') != SERVICE_ORIGIN
            or registered_role.get('exactMarkerCount') != 1 or not isinstance(registered_role.get('targetId'), str)):
        raise SafeFailure('ATTACHMENT_CHAIN_ROLE_REGISTRY_INVALID')

    FILE_PATH.write_bytes(FILE_CONTENT)
    FILE_PATH.chmod(0o600)
    state = {
        'nativeStartCount': 0, 'nativeContinuationCount': 0, 'nativeTextCount': 0,
        'otherBlockedCount': 0, 'lateRequestCount': 0, 'lateBlockedCount': 0,
        'resetStarted': False, 'resetQuiet': False, 'routeHandlerError': None,
        'startCapture': None, 'continuationCapture': None, 'messageCapture': None,
        'messageCaptureHistory': [], 'bindingDiagnosticAttempts': [], 'allowTextRecapture': False,
        'sourceBindingResolutionPlan': None,
        'startResponseSummary': None, 'transferResponseSummary': None, 'chainResult': None,
        'childErrorSummary': None, 'attachmentBindingDiagnostics': None,
        'attachmentReferenceRecovery': None, 'directUploadSummary': None,
        'batchContext': None, 'batchContextSummary': None,
        'historyArgsMismatch': None,
        'continuationCookieSummary': None,
        'selectedFileType': None, 'selectedFileTypeReadCount': 0, 'selectedFileTypeReadMimeValues': [],
        'nativeContinuationSummary': None,
        'directDispatchCount': 0, 'child': None, 'session': None, 'uploadCookies': None,
        'expectedOwner': '', 'targetIdMatched': False,
        'targetClosedFailClosed': False, 'roleRegistryMarkedClosed': False,
        'serverIssuedSessionUrlStringNormalized': False,
        'continuationCaptureTimedOut': False,
        'sourceSnapshotBeforeChain': None,
    }
    blocked_requests = []
    page = context = browser = None
    route_handler = None
    receipt_written = False
    error_code = None
    target_id = None

    def target_id_for(candidate):
        session = context.new_cdp_session(candidate)
        try:
            return session.send('Target.getTargetInfo').get('targetInfo', {}).get('targetId')
        finally:
            session.detach()

    def reset_owned_page_to_blank():
        if page is None or context is None or target_id_for(page) != target_id:
            raise SafeFailure('ATTACHMENT_CHAIN_TARGET_ID_CHANGED')
        state['resetStarted'] = True
        try:
            page.evaluate("""() => {
              if ('__codexSelectedFileRef' in window) window.__codexSelectedFileRef = null;
              if (Array.isArray(window.__codexFileTypeReads)) window.__codexFileTypeReads.length = 0;
            }""")
        except Exception:
            pass
        if page.url != 'about:blank':
            try:
                page.goto('about:blank', wait_until='commit', timeout=15000)
            except Exception:
                try:
                    stop_session = context.new_cdp_session(page)
                    try:
                        stop_session.send('Page.stopLoading')
                    finally:
                        stop_session.detach()
                except Exception:
                    pass
                session = context.new_cdp_session(page)
                try:
                    session.send('Page.navigate', {'url': 'about:blank'})
                finally:
                    session.detach()
                deadline = time.monotonic() + 10
                while page.url != 'about:blank' and time.monotonic() < deadline:
                    page.wait_for_timeout(100)
        page.evaluate('(marker) => window.name = marker', PAGE_ROLE)
        page.wait_for_timeout(1800)
        state['resetQuiet'] = page.url == 'about:blank' and page.evaluate('() => window.name') == PAGE_ROLE \
            and target_id_for(page) == target_id and state['lateRequestCount'] == 0 and state['lateBlockedCount'] == 0
        if not state['resetQuiet']:
            raise SafeFailure('ATTACHMENT_CHAIN_RESET_QUIET_FAILED')

    def close_owned_target_fail_closed():
        if page is None or context is None or browser is None:
            raise SafeFailure('ATTACHMENT_CHAIN_TARGET_ID_CHANGED')
        def target_is_absent():
            browser_cdp = browser.new_browser_cdp_session()
            try:
                targets = browser_cdp.send('Target.getTargets').get('targetInfos', [])
                return not any(item.get('targetId') == target_id for item in targets if isinstance(item, dict))
            finally:
                browser_cdp.detach()

        if not page.is_closed() and target_id_for(page) != target_id:
            raise SafeFailure('ATTACHMENT_CHAIN_TARGET_ID_CHANGED')

        closed = False
        for _ in range(10):
            try:
                page.close(run_before_unload=False)
                closed = page.is_closed() and target_is_absent()
            except Exception:
                closed = False
            if not closed:
                try:
                    browser_cdp = browser.new_browser_cdp_session()
                    try:
                        browser_cdp.send('Target.closeTarget', {'targetId': target_id})
                        targets = browser_cdp.send('Target.getTargets').get('targetInfos', [])
                        closed = not any(item.get('targetId') == target_id for item in targets if isinstance(item, dict))
                    finally:
                        browser_cdp.detach()
                except Exception:
                    closed = False
            if closed:
                break
            time.sleep(0.25)
        if not closed:
            raise SafeFailure('ATTACHMENT_CHAIN_FAIL_CLOSED_TARGET_CLOSE_FAILED')
        mark_page_role_closed(target_id, owner['chromePid'], 'reset_quiet_unverified')
        state['targetClosedFailClosed'] = True
        state['roleRegistryMarkedClosed'] = True

    def ensure_child_started(route, capture):
        if state['child'] is not None:
            raise SafeFailure('ATTACHMENT_CHAIN_CHILD_ALREADY_STARTED')
        node = node_runtime()
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR') if key in os.environ}
        env['GEMINI_ATTACHMENT_CHAIN_ORCHESTRATOR'] = '1'
        process = subprocess.Popen(
            [node, str(CLI), 'attachment-chain', '--envelope-stdin', '--expect-owner', state['expectedOwner'],
             '--caller-intent', UPLOAD_INTENT, '--message-intent', MESSAGE_INTENT, '--prompt', PROMPT, '--confirm'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, env=env,
        )
        state['child'] = process
        payload = {
            'session': state['session'],
            'capture': {
                'url': capture['url'], 'method': capture['method'], 'contentType': capture['contentType'],
                'bodyBase64': base64.b64encode(capture['body']).decode('ascii'),
                'declaredFileBytes': capture['declaredFileBytes'], 'headerNames': capture['headerNames'],
                'headers': capture['headers'],
            },
            'uploadCookies': state['uploadCookies'],
            'file': {'name': FILE_NAME, 'mimeType': state['selectedFileType'],
                'bodyBase64': base64.b64encode(FILE_CONTENT).decode('ascii')},
        }
        payload_copy = json.loads(json.dumps(payload, separators=(',', ':')))
        child_send(process, payload_copy)
        capture['body'][:] = b'\0' * len(capture['body'])
        event = child_read_json_line(process)
        if event.get('event') == 'error':
            state['childErrorSummary'] = safe_child_error(event)
            raise SafeFailure('ATTACHMENT_CHAIN_CHILD_' + str(event.get('errorCode', 'CLIENT_FAILED')))
        if event.get('event') != 'start-response' or event.get('httpStatus') != 200:
            scrub(event)
            raise SafeFailure('ATTACHMENT_CHAIN_START_RESPONSE_INVALID')
        session_ref = safe_ref(event.get('uploadUrl', ''))
        if session_ref['origin'] != UPLOAD_ORIGIN or session_ref['pathFamily'] != '/upload/' \
                or not {'upload_id', 'upload_protocol'}.issubset(set(session_ref['queryKeyNames'])):
            scrub(event)
            raise SafeFailure('ATTACHMENT_CHAIN_SESSION_URL_UNOBSERVED')
        try:
            body = bytearray(base64.b64decode(event.get('responseBodyBase64', ''), validate=True))
        except Exception:
            scrub(event)
            raise SafeFailure('ATTACHMENT_CHAIN_START_RESPONSE_INVALID')
        headers = event.get('responseHeaders')
        if not isinstance(headers, dict):
            body[:] = b'\0' * len(body)
            scrub(event)
            raise SafeFailure('ATTACHMENT_CHAIN_START_RESPONSE_INVALID')
        state['startResponseSummary'] = {
            'httpStatus': event['httpStatus'], 'responseHeaderNames': sorted(headers),
            'contentType': str(headers.get('content-type', '')).split(';', 1)[0].strip().lower(),
            'responseBytes': len(body), 'responseSha256': hashlib.sha256(body).hexdigest(),
            'sessionUrlRef': session_ref,
        }
        state['_uploadUrl'] = event['uploadUrl']
        route.fulfill(status=event['httpStatus'], headers=headers, body=bytes(body))
        body[:] = b'\0' * len(body)
        scrub(event)

    def route_handler_fn(route):
        request = route.request
        if state['resetStarted'] and request.url != 'about:blank':
            state['lateRequestCount'] += 1
        parsed = urllib.parse.urlsplit(request.url)
        if request.method in ('GET', 'HEAD', 'OPTIONS'):
            route.continue_()
            return
        read_rpc_ids = parsed_read_batch_rpc_ids(request)
        if read_rpc_ids:
            if read_rpc_ids == [HISTORY_LIST_RPC]:
                body = bytearray(request.post_data_buffer or b'')
                state['batchContext'] = capture_history_context(request, body, contract)
                observed_history_args = state['batchContext'].pop('observedHistoryListArgs')
                state['batchContextSummary'] = {
                    'captured': True,
                    'rpcId': HISTORY_LIST_RPC,
                    'queryKeys': list(contract['operations']['history_list']['request']['queryKeys']),
                    'bodyFieldNames': list(contract['operations']['history_list']['request']['bodyFieldNames']),
                    'observedHistoryListArgs': observed_history_args,
                    'directReadHistoryListArgs': CANONICAL_HISTORY_LIST_ARGS.copy(),
                    'cursorAdjustedToCapturedFirstPageTemplate': observed_history_args != CANONICAL_HISTORY_LIST_ARGS,
                    'canonicalFirstPageTemplateSource': 'scripts/run-linux-text-smoke.py:FIRST_PAGE_HISTORY_ARGS',
                    'atPresentInMemory': True,
                    'rawQueryAndTokenValuesPersisted': False,
                }
                body[:] = b'\0' * len(body)
            route.continue_()
            return
        native_request_headers = {str(name).lower(): str(value)
            for name, value in request.all_headers().items()}
        header_values = dict(native_request_headers)
        body = bytearray(request.post_data_buffer or b'')
        is_start = (parsed.hostname == 'push.clients6.google.com' and parsed.path == '/upload/'
                    and request.method == 'POST' and header_values.get('x-goog-upload-command') == 'start'
                    and header_values.get('x-goog-upload-protocol') == 'resumable')
        if is_start:
            state['nativeStartCount'] += 1
            if state['nativeStartCount'] != 1:
                state['otherBlockedCount'] += 1
                route.abort('blockedbyclient')
                return
            state['startCapture'] = {
                'url': request.url, 'method': request.method,
                'contentType': header_values.get('content-type', '').split(';', 1)[0].strip().lower(),
                'body': bytearray(body), 'headerNames': sorted(header_values),
                'headers': {name: value for name, value in header_values.items()
                    if name in upload_contract['source']['headerNames'] and name != 'cookie'},
                'cookieNames': cookie_names(header_values.get('cookie', '')),
                'declaredFileBytes': int(header_values.get('x-goog-upload-header-content-length', '0') or '0'),
            }
            selected_probe = page.evaluate("""() => {
              const file = window.__codexSelectedFileRef;
              const reads = (window.__codexFileTypeReads || []).slice(0, 40);
              return {file: file ? {name: file.name, size: file.size, type: file.type} : null, reads};
            }""")
            selected_file = selected_probe.get('file') if isinstance(selected_probe, dict) else None
            selected_file_type = normalized_mime(selected_file.get('type')) if isinstance(selected_file, dict) else None
            sdk_reads = [item for item in selected_probe.get('reads', []) if isinstance(item, dict)
                and item.get('name') == FILE_NAME and item.get('size') == len(FILE_CONTENT)] if isinstance(selected_probe, dict) else []
            sdk_mime_values = sorted({normalized_mime(item.get('type')) for item in sdk_reads
                if normalized_mime(item.get('type'))})
            state['selectedFileType'] = selected_file_type
            state['selectedFileTypeReadCount'] = len(sdk_reads)
            state['selectedFileTypeReadMimeValues'] = sdk_mime_values
            capture = state['startCapture']
            expected_body = (upload_contract['source']['metadataBodyPrefix'] + FILE_NAME).encode('utf-8')
            if (capture['contentType'] != upload_contract['source']['contentType']
                    or bytes(capture['body']) != expected_body or capture['declaredFileBytes'] != len(FILE_CONTENT)
                    or capture['cookieNames'] != sorted(upload_contract['source']['cookieNames'])
                    or capture['headerNames'] != sorted(upload_contract['source']['headerNames'])
                    or not isinstance(selected_file, dict) or selected_file.get('name') != FILE_NAME
                    or selected_file.get('size') != len(FILE_CONTENT) or selected_file_type is None
                    or not sdk_mime_values or sdk_mime_values != [selected_file_type]):
                route.abort('blockedbyclient')
                raise SafeFailure('ATTACHMENT_CHAIN_NATIVE_START_MISMATCH')
            state['uploadCookies'] = validate_current_cookie_jar(context.cookies(capture['url']),
                upload_contract['source']['cookieScopes'], upload_contract['source']['cookieNames'])
            ensure_child_started(route, capture)
            body[:] = b'\0' * len(body)
            return

        session_url_matched = (state.get('_uploadUrl') is not None
                               and same_upload_session_url(request.url, state.get('_uploadUrl')))
        is_continuation = (state.get('_uploadUrl') is not None and parsed.hostname == 'push.clients6.google.com'
                           and request.method == 'POST' and session_url_matched
                           and header_values.get('x-goog-upload-command') == 'upload, finalize')
        if is_continuation:
            state['nativeContinuationCount'] += 1
            if state['nativeContinuationCount'] != 1 or state['child'] is None:
                state['otherBlockedCount'] += 1
                route.abort('blockedbyclient')
                return
            native_request_headers = {str(name).lower(): str(value) for name, value in native_request_headers.items()}
            continuation_header_copy = dict(native_request_headers)
            state['continuationCapture'] = {
                'url': request.url, 'method': request.method, 'headerNames': sorted(header_values),
                'headers': continuation_header_copy, 'body': bytearray(body), 'bodyBytes': len(body),
                'bodySha256': hashlib.sha256(body).hexdigest(),
                'command': header_values.get('x-goog-upload-command'),
                'offset': header_values.get('x-goog-upload-offset'),
                'cookieNames': cookie_names(header_values.get('cookie', '')),
            }
            captured = state['continuationCapture']
            state['nativeContinuationSummary'] = {
                'serverIssuedSessionUrlIdentityMatched': True,
                'serverIssuedSessionUrlStringNormalized': request.url != state.get('_uploadUrl'),
                'selectedFileType': state['selectedFileType'],
                'selectedFileTypeReadCount': state['selectedFileTypeReadCount'],
                'selectedFileTypeReadMimeValues': list(state['selectedFileTypeReadMimeValues']),
                'nativeTransferMimeType': normalized_mime(native_request_headers.get('content-type')),
                'nativeContentTypeHeaderPresent': 'content-type' in native_request_headers,
                'command': captured['command'], 'offset': captured['offset'],
                'bodyBytes': captured['bodyBytes'], 'bodySha256': captured['bodySha256'],
                'bodyMatchesSelectedFile': captured['bodyBytes'] == len(FILE_CONTENT)
                    and captured['bodySha256'] == hashlib.sha256(FILE_CONTENT).hexdigest(),
                'headerNames': list(captured['headerNames']),
                'ordinaryCookieNames': list(captured['cookieNames']),
                'nativeRequestHeadersIndependentFromStartCapture': captured['headers'] is not state['startCapture']['headers'],
            }
            refreshed_upload_cookies = validate_current_cookie_jar(context.cookies(captured['url']),
                upload_contract['source']['cookieScopes'], upload_contract['source']['cookieNames'])
            initial_cookie_values = {item['name']: item['value'] for item in (state['uploadCookies'] or [])}
            rotated_names = sorted(item['name'] for item in refreshed_upload_cookies
                if initial_cookie_values.get(item['name']) != item['value'])
            state['continuationCookieSummary'] = {
                'currentCookieCount': len(refreshed_upload_cookies),
                'currentCookieNames': sorted(item['name'] for item in refreshed_upload_cookies),
                'currentCookieScopes': sorted([{'name': item['name'], 'domain': item['domain'], 'path': item['path'],
                    'secure': item['secure']} for item in refreshed_upload_cookies], key=lambda item: item['name']),
                'nativeCookieNames': captured['cookieNames'],
                'rotatedCookieNamesSinceStart': rotated_names,
                'cookieValuesPersisted': False,
            }
            child_send(state['child'], {'event': 'continuation-capture', 'capture': {
                'url': captured['url'], 'method': captured['method'], 'headerNames': captured['headerNames'],
                'headers': dict(captured['headers']), 'bodyBase64': base64.b64encode(captured['body']).decode('ascii'),
            }, 'uploadCookies': refreshed_upload_cookies})
            captured['body'][:] = b'\0' * len(captured['body'])
            for name in list(captured['headers']):
                captured['headers'][name] = ''
            for name in list(native_request_headers):
                native_request_headers[name] = ''
            body[:] = b'\0' * len(body)
            event = child_read_json_line(state['child'], timeout_seconds=180)
            if event.get('event') == 'error':
                state['childErrorSummary'] = safe_child_error(event)
                scrub(event)
                route.abort('blockedbyclient')
                raise SafeFailure('ATTACHMENT_CHAIN_CHILD_' + str(state['childErrorSummary']['errorCode']))
            if event.get('event') != 'transfer-response' or not isinstance(event.get('httpStatus'), int):
                scrub(event)
                route.abort('blockedbyclient')
                raise SafeFailure('ATTACHMENT_CHAIN_TRANSFER_RESPONSE_INVALID')
            try:
                response_body = bytearray(base64.b64decode(event.get('responseBodyBase64', ''), validate=True))
            except Exception:
                scrub(event)
                route.abort('blockedbyclient')
                raise SafeFailure('ATTACHMENT_CHAIN_TRANSFER_RESPONSE_INVALID')
            headers = event.get('responseHeaders')
            if not isinstance(headers, list) or any(not isinstance(pair, list) or len(pair) != 2
                    or not all(isinstance(part, str) for part in pair) for pair in headers):
                response_body[:] = b'\0' * len(response_body)
                scrub(event)
                route.abort('blockedbyclient')
                raise SafeFailure('ATTACHMENT_CHAIN_TRANSFER_RESPONSE_INVALID')
            header_map = {name.lower(): value for name, value in headers}
            if 'set-cookie' in header_map:
                response_body[:] = b'\0' * len(response_body)
                scrub(event)
                route.abort('blockedbyclient')
                raise SafeFailure('ATTACHMENT_CHAIN_UNEXPECTED_RESPONSE_COOKIE')
            state['transferResponseSummary'] = {
                'httpStatus': event['httpStatus'], 'responseHeaderNames': sorted(header_map),
                'contentType': header_map.get('content-type', '').split(';', 1)[0].strip().lower(),
                'responseBytes': len(response_body), 'responseSha256': hashlib.sha256(response_body).hexdigest(),
                'uploadStatus': header_map.get('x-goog-upload-status'),
            }
            route.fulfill(status=event['httpStatus'], headers=header_map, body=bytes(response_body))
            response_body[:] = b'\0' * len(response_body)
            scrub(event)
            child_send(state['child'], {'event': 'transfer-fulfilled'})
            return

        is_text = (parsed.hostname == 'gemini.google.com' and parsed.path == TEXT_PATH and request.method == 'POST')
        if is_text:
            state['nativeTextCount'] += 1
            if state['nativeTextCount'] > 2 or (state['nativeTextCount'] == 2 and not state['allowTextRecapture']) \
                    or state['child'] is None:
                state['otherBlockedCount'] += 1
                route.abort('blockedbyclient')
                return
            state['messageCapture'] = {
                'url': request.url, 'method': request.method, 'bodyBytes': len(body),
                'bodySha256': hashlib.sha256(body).hexdigest(), 'headerNames': sorted(header_values),
                'contentType': header_values.get('content-type', '').split(';', 1)[0].strip().lower(),
            }
            state['messageCaptureHistory'].append(dict(state['messageCapture']))
            if state['nativeTextCount'] == 2:
                state['allowTextRecapture'] = False
            safe_headers = {name: value for name, value in header_values.items()
                if name in contract['operations']['text']['request']['headerNames']
                and name not in ('cookie', 'authorization', 'proxy-authorization', 'host', 'content-length')}
            capture = {
                'url': request.url, 'method': request.method, 'bodyBase64': base64.b64encode(body).decode('ascii'),
                'headers': safe_headers,
            }
            route.abort('blockedbyclient')
            child_send(state['child'], {'event': 'attachment-message', 'capture': capture})
            for name in list(safe_headers):
                safe_headers[name] = ''
            for name in list(capture['headers']):
                capture['headers'][name] = ''
            capture['bodyBase64'] = ''
            body[:] = b'\0' * len(body)
            return

        state['otherBlockedCount'] += 1
        if state['resetStarted']:
            state['lateBlockedCount'] += 1
        blocked_requests.append({
            'method': request.method, 'origin': f'{parsed.scheme}://{parsed.netloc}',
            'pathFamily': re.sub(r'[A-Za-z0-9_-]{40,}', '{id}', parsed.path),
            'queryKeyNames': sorted({key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)}),
            'bodyBytes': len(body), 'bodySha256': hashlib.sha256(body).hexdigest(), 'headerNames': sorted(header_values),
        })
        route.abort('blockedbyclient')
        body[:] = b'\0' * len(body)

    def guarded_route(route):
        try:
            return route_handler_fn(route)
        except Exception as error:
            state['routeHandlerError'] = error.code if isinstance(error, SafeFailure) else 'ATTACHMENT_CHAIN_ROUTE_HANDLER_FAILED'
            if isinstance(error, SafeFailure) and error.details:
                state['historyArgsMismatch'] = error.details
            try:
                route.abort('blockedbyclient')
            except Exception:
                pass

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{owner['cdpPort']}")
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]
            if registered_role is not None:
                target_id = registered_role['targetId']
                pages = [candidate for candidate in context.pages if target_id_for(candidate) == target_id]
                if len(pages) != 1:
                    raise SafeFailure('ATTACHMENT_CHAIN_REGISTERED_TARGET_NOT_FOUND')
                page = pages[0]
            else:
                page = context.new_page()
                target_id = target_id_for(page)
                if page.url != 'about:blank' or not isinstance(target_id, str) or len(target_id) < 8:
                    raise SafeFailure('ATTACHMENT_CHAIN_TARGET_CREATE_FAILED')
                page.evaluate('(marker) => window.name = marker', PAGE_ROLE)
                register_page_role(registry, target_id)
            saved_role = read_json(ROLE_FILE).get('activePageRoles', {}).get(PAGE_ROLE, {})
            if saved_role.get('origin') != SERVICE_ORIGIN or saved_role.get('exactMarkerCount') != 1 \
                    or saved_role.get('targetId') != target_id:
                raise SafeFailure('ATTACHMENT_CHAIN_ROLE_REGISTRATION_MISMATCH')
            if target_id_for(page) != target_id:
                raise SafeFailure('ATTACHMENT_CHAIN_ROLE_BINDING_FAILED')
            if page.evaluate('() => window.name') != PAGE_ROLE:
                raise SafeFailure('ATTACHMENT_CHAIN_LIVE_MARKER_MISMATCH')
            state['targetIdMatched'] = True
            state['sourceSnapshotBeforeChain'] = source_snapshot()
            route_handler = guarded_route
            page.route('**/*', route_handler)
            reset_owned_page_to_blank()
            state['resetStarted'] = False
            state['lateRequestCount'] = 0
            state['lateBlockedCount'] = 0
            page.goto(SERVICE_ORIGIN + '/app', wait_until='domcontentloaded', timeout=60000)
            if not page.url.startswith(SERVICE_ORIGIN + '/'):
                raise SafeFailure('GEMINI_APP_NOT_REACHED')
            page.evaluate('(marker) => window.name = marker', PAGE_ROLE)
            if page.evaluate('() => window.name') != PAGE_ROLE or target_id_for(page) != target_id:
                raise SafeFailure('ATTACHMENT_CHAIN_MARKER_MISMATCH')
            page.wait_for_timeout(5000)
            template_deadline = time.monotonic() + 20
            while state['batchContext'] is None and state['routeHandlerError'] is None and time.monotonic() < template_deadline:
                page.wait_for_timeout(250)
            if state['routeHandlerError']:
                raise SafeFailure(state['routeHandlerError'])
            if state['batchContext'] is None:
                raise SafeFailure('ATTACHMENT_CHAIN_HISTORY_TEMPLATE_NOT_CAPTURED')
            html = page.content()
            owner_matches = [email for email in re.findall(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', html)
                if hashlib.sha256(email.strip().casefold().encode('utf-8')).hexdigest() == EXPECTED_ACCOUNT_SHA256]
            html = ''
            if not owner_matches:
                raise SafeFailure('UPLOAD_OWNER_MISMATCH')
            state['expectedOwner'] = owner_matches[0]
            previous_intents = mutation_journal_summary(state['expectedOwner'])
            if any(entry.get('dispatchCount', 0) > 0
                    or entry.get('state') not in ('preflight_failed', 'confirmed_rejected', 'reconciled')
                    for entry in previous_intents.values()):
                raise SafeFailure('ATTACHMENT_CHAIN_INTENT_ALREADY_DISPATCHED_OR_UNRESOLVED')
            required_auth = set(contract['auth']['cookieNames'])
            auth_jar = context.cookies(SERVICE_ORIGIN)
            auth_values = {cookie.get('name'): cookie.get('value') for cookie in auth_jar
                if cookie.get('name') in required_auth and isinstance(cookie.get('value'), str)}
            if set(auth_values) != required_auth:
                raise SafeFailure('GEMINI_SESSION_COOKIE_SET_INCOMPLETE')
            state['session'] = {
                'version': 1, 'service': contract['service'], 'origin': SERVICE_ORIGIN,
                'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'cookies': [{'name': name, 'value': value} for name, value in auth_values.items()],
                'headers': {}, 'requestHeaders': {}, 'batchContext': state['batchContext'],
            }
            page.evaluate("""() => {
              window.__codexSelectedFileRef = null;
              window.__codexFileTypeReads = [];
              document.addEventListener('change', event => {
                const input = event.target;
                if (input && input.type === 'file' && input.files && input.files[0]) {
                  window.__codexSelectedFileRef = input.files[0];
                }
              }, true);
              const descriptor = Object.getOwnPropertyDescriptor(Blob.prototype, 'type');
              try {
                if (descriptor && typeof descriptor.get === 'function') {
                  Object.defineProperty(Blob.prototype, 'type', {
                    configurable: descriptor.configurable,
                    enumerable: descriptor.enumerable,
                    get() {
                      const value = descriptor.get.call(this);
                      if (typeof this.name === 'string' && Number.isSafeInteger(this.size)
                          && window.__codexFileTypeReads.length < 40) {
                        window.__codexFileTypeReads.push({ name: this.name, size: this.size, type: value });
                      }
                      return value;
                    },
                  });
                }
              } catch {}
            }""")
            inputs = page.locator('input[type=file]')
            if inputs.count() == 0:
                menu = page.locator('button[aria-label="업로드 및 도구"]')
                if menu.count() != 1 or not menu.is_visible() or not menu.is_enabled():
                    raise SafeFailure('UPLOAD_MENU_NOT_FOUND')
                menu.click()
                deadline = time.monotonic() + 8
                while inputs.count() == 0 and time.monotonic() < deadline:
                    page.wait_for_timeout(250)
            inputs = page.locator('input[type=file]')
            if inputs.count() == 0 or '.txt' not in (inputs.first.get_attribute('accept') or '').lower():
                raise SafeFailure('UPLOAD_FILE_INPUT_NOT_FOUND')
            inputs.first.set_input_files(str(FILE_PATH))
            page.wait_for_timeout(4500)
            if state['routeHandlerError']:
                raise SafeFailure(state['routeHandlerError'])
            if state['startCapture'] is None:
                raise SafeFailure('ATTACHMENT_CHAIN_NATIVE_START_CAPTURE_MISSING')
            continuation_deadline = time.monotonic() + 30
            while state['continuationCapture'] is None and state['routeHandlerError'] is None \
                    and time.monotonic() < continuation_deadline:
                page.wait_for_timeout(250)
            if state['routeHandlerError']:
                raise SafeFailure(state['routeHandlerError'])
            if state['continuationCapture'] is None:
                state['continuationCaptureTimedOut'] = True
                if state['child'] is not None and state['child'].poll() is None:
                    child_send(state['child'], {'event': 'continuation-not-captured'})
                    event = child_read_json_line(state['child'], timeout_seconds=120)
                    if event.get('event') == 'error':
                        state['childErrorSummary'] = safe_child_error(event)
                        scrub(event)
                    else:
                        scrub(event)
                raise SafeFailure('ATTACHMENT_CHAIN_NATIVE_CONTINUATION_CAPTURE_MISSING')
            if state['transferResponseSummary'] is None:
                raise SafeFailure('ATTACHMENT_CHAIN_DIRECT_TRANSFER_RESPONSE_MISSING')
            page.wait_for_timeout(2500)
            body_text = page.locator('body').inner_text(timeout=10000)
            filename_visible = FILE_NAME in body_text
            body_text = ''
            if not filename_visible:
                raise SafeFailure('ATTACHMENT_CHAIN_FILE_NOT_STAGED_IN_SDK')
            box = page.get_by_role('textbox', name='Gemini 프롬프트 입력')
            if box.count() != 1 or not box.is_visible() or not box.is_enabled():
                raise SafeFailure('ATTACHMENT_CHAIN_COMPOSER_NOT_FOUND')
            box.fill(PROMPT)
            box.press('Enter')
            page.wait_for_timeout(4000)
            if state['nativeTextCount'] != 1 or state['messageCapture'] is None:
                raise SafeFailure('ATTACHMENT_CHAIN_MESSAGE_CAPTURE_MISSING')
            if state['child'] is None:
                raise SafeFailure('ATTACHMENT_CHAIN_CHILD_MISSING')
            event = child_read_json_line(state['child'], timeout_seconds=240)
            while event.get('event') == 'attachment-binding-recapture-needed':
                binding = safe_attachment_binding(event.get('attachmentBinding'))
                state['bindingDiagnosticAttempts'].append({
                    'attempt': event.get('attempt') if isinstance(event.get('attempt'), int) else None,
                    'diagnostics': binding,
                    'directTextDispatchCountBeforeRecapture': 0,
                })
                scrub(event)
                review = {
                    'event': 'attachment_binding_review_required',
                    'attempt': 1,
                    'controlSocketPath': str(RUNTIME / ('attach-' + hashlib.sha256(UPLOAD_INTENT.encode()).hexdigest()[:10] + '.sock')),
                    'diagnostics': binding,
                    'nativeMessageBodyBytes': state['messageCapture']['bodyBytes'],
                    'nativeMessageBodySha256': state['messageCapture']['bodySha256'],
                    'nativeMessageBrowserDispatchCount': 0,
                    'uploadReferenceRetainedInNodeProcess': True,
                    'fileBytesWillNotBeResent': True,
                }
                sys.stdout.write(json.dumps(review, separators=(',', ':')) + '\n')
                sys.stdout.flush()
                plan = read_source_binding_resolution(binding, review['controlSocketPath'], timeout_seconds=90)
                if plan:
                    state['sourceBindingResolutionPlan'] = plan
                    child_send(state['child'], {'event': 'attachment-binding-resolution', 'plan': plan})
                else:
                    child_send(state['child'], {'event': 'attachment-recovery-abandon'})
                event = child_read_json_line(state['child'], timeout_seconds=240)
            if event.get('event') == 'error':
                state['childErrorSummary'] = safe_child_error(event)
                scrub(event)
                raise SafeFailure('ATTACHMENT_CHAIN_CHILD_' + str(state['childErrorSummary']['errorCode']))
            if event.get('operation') != 'attachment_chain':
                state['chainResult'] = event
                raise SafeFailure('ATTACHMENT_CHAIN_DIRECT_READBACK_INVALID')
            state['chainResult'] = event
            state['directUploadSummary'] = safe_direct_upload_summary(event.get('upload'))
            if state['child'].poll() is None:
                state['child'].wait(timeout=30)
            state['mutationJournal'] = mutation_journal_summary(state['expectedOwner'])
            state['directDispatchCount'] = sum(item.get('dispatchCount', 0) for item in state['mutationJournal'].values())
            if event.get('outputStatus') == 'upload_verified_attachment_message_unbound':
                binding = event.get('attachmentMessage', {}).get('bindingDiagnostics')
                state['attachmentBindingDiagnostics'] = safe_attachment_binding(binding)
                recovery = event.get('attachmentReferenceRecovery')
                if isinstance(recovery, dict):
                    state['attachmentReferenceRecovery'] = {
                        'referenceAvailableNonEnumerablyAtApiReturn': recovery.get('referenceAvailableNonEnumerably') is True,
                        'capturedRequestAvailableNonEnumerablyAtApiReturn': recovery.get('capturedRequestAvailableNonEnumerably') is True,
                        'clientAvailableNonEnumerablyAtApiReturn': recovery.get('clientAvailableNonEnumerably') is True,
                        'sessionRetainedUntilRelease': recovery.get('sessionRetainedUntilRelease') is True,
                        'releaseAvailableNonEnumerablyAtApiReturn': recovery.get('releaseAvailableNonEnumerably') is True,
                        'rawReferencePersisted': recovery.get('rawReferencePersisted') is True,
                        'rawCapturePersisted': recovery.get('rawCapturePersisted') is True,
                        'directTextDispatchCount': recovery.get('directTextDispatchCount')
                            if isinstance(recovery.get('directTextDispatchCount'), int) else 0,
                        'recoverableByOrchestratorAfterCliSerialization': False,
                    }
                state['childErrorSummary'] = {'errorCode': 'TEXT_ATTACHMENT_CAPTURE_MISMATCH',
                    'errorClass': 'GeminiClientError', 'attachmentBinding': state['attachmentBindingDiagnostics']}
                scrub(event)
                raise SafeFailure('ATTACHMENT_CHAIN_ATTACHMENT_MESSAGE_BINDING_MISMATCH')
            if state['directDispatchCount'] != 3:
                raise SafeFailure('ATTACHMENT_CHAIN_JOURNAL_DISPATCH_MISMATCH')

            reset_owned_page_to_blank()

            transfer = state['chainResult']
            upload = transfer.get('upload', {})
            text = transfer.get('text', {})
            journal = state['mutationJournal']
            source_stable = source_snapshot()['aggregateSha256'] == state['sourceSnapshotBeforeChain']['aggregateSha256']
            receipt = {
                'schema': 1,
                'service': 'gemini-web',
                'operation': 'attachment_chain',
                'sourceSnapshotBeforeChain': state['sourceSnapshotBeforeChain'],
                'purpose': 'distinct default API upload to SDK attachment-message capture, with raw decoded reply, assistant role, and response ID binding validation',
                'callerIntent': UPLOAD_INTENT,
                'messageCallerIntent': MESSAGE_INTENT,
                'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'ownerDigestMatchedApproved': True,
                'file': {'name': FILE_NAME, 'mimeType': state['selectedFileType'], 'bytes': len(FILE_CONTENT),
                    'sha256': hashlib.sha256(FILE_CONTENT).hexdigest()},
                'promptSha256': hashlib.sha256(PROMPT.encode('utf-8')).hexdigest(),
                'normalHistoryTemplate': state['batchContextSummary'],
                'nativeStart': {
                    'method': state['startCapture']['method'], 'origin': UPLOAD_ORIGIN, 'pathFamily': '/upload/',
                    'bodyBytes': len((upload_contract['source']['metadataBodyPrefix'] + FILE_NAME).encode('utf-8')),
                    'bodySha256': hashlib.sha256((upload_contract['source']['metadataBodyPrefix'] + FILE_NAME).encode('utf-8')).hexdigest(),
                    'headerNames': state['startCapture']['headerNames'],
                    'ordinaryCookieNames': state['startCapture']['cookieNames'],
                    'declaredFileBytes': state['startCapture']['declaredFileBytes'], 'browserNetworkDispatchCount': 0,
                },
                'directStart': state['startResponseSummary'],
                'nativeContinuation': {
                    'method': 'POST', 'origin': UPLOAD_ORIGIN, 'pathFamily': '/upload/',
                    'queryKeyNames': ['upload_id', 'upload_protocol'],
                    'headerNames': state['continuationCapture']['headerNames'],
                    'ordinaryCookieNames': state['continuationCapture']['cookieNames'],
                    'command': state['continuationCapture']['command'],
                    'offset': state['continuationCapture']['offset'],
                    'bodyBytes': state['continuationCapture']['bodyBytes'],
                    'bodySha256': state['continuationCapture']['bodySha256'],
                    'selectedFileType': state['nativeContinuationSummary']['selectedFileType'],
                    'selectedFileTypeReadCount': state['nativeContinuationSummary']['selectedFileTypeReadCount'],
                    'selectedFileTypeReadMimeValues': state['nativeContinuationSummary']['selectedFileTypeReadMimeValues'],
                    'nativeTransferMimeType': state['nativeContinuationSummary']['nativeTransferMimeType'],
                    'nativeContentTypeHeaderPresent': state['nativeContinuationSummary']['nativeContentTypeHeaderPresent'],
                    'bodyMatchesSelectedFile': state['nativeContinuationSummary']['bodyMatchesSelectedFile'],
                    'nativeRequestHeadersIndependentFromStartCapture': state['nativeContinuationSummary']['nativeRequestHeadersIndependentFromStartCapture'],
                    'browserNetworkDispatchCount': 0,
                },
                'continuationCookieSnapshot': state['continuationCookieSummary'],
                'directUpload': {
                    'status': upload.get('status'), 'directDispatchCount': upload.get('directDispatchCount'),
                    'httpRequestCount': upload.get('httpRequestCount'),
                    'httpStatus': upload.get('transferHttpStatus'),
                    'contentType': upload.get('transferContentType'),
                    'responseHeaderNames': upload.get('transferResponseHeaderNames'),
                    'responseBytes': upload.get('responseBytes'), 'responseSha256': upload.get('responseSha256'),
                    'uploadStatus': upload.get('transferUploadStatus'),
                    'transferMetadata': upload.get('transferMetadata'),
                    'query': upload.get('query'),
                    'forwardedNativeResponse': state['transferResponseSummary'],
                    'uploadedFileReadbackVerified': upload.get('uploadedFileReadbackVerified'),
                    'attachmentReferenceAvailable': upload.get('attachmentReferenceAvailable'),
                    'continuationTemplate': upload.get('continuationTemplate'),
                    'journalReconciled': upload.get('journalReconciled'),
                    'cookieValuesPersisted': False, 'sessionUrlPersisted': False, 'responseBodyPersisted': False,
                },
                'directUploadSafeSummary': state['directUploadSummary'],
                'nativeAttachmentMessage': {
                    'method': 'POST', 'origin': SERVICE_ORIGIN, 'pathFamily': TEXT_PATH,
                    'bodyBytes': state['messageCapture']['bodyBytes'], 'bodySha256': state['messageCapture']['bodySha256'],
                    'contentType': state['messageCapture']['contentType'],
                    'headerNames': state['messageCapture']['headerNames'], 'browserNetworkDispatchCount': 0,
                },
                'nativeAttachmentMessageCaptureAttempts': state['messageCaptureHistory'],
                'bindingDiagnosticAttempts': state['bindingDiagnosticAttempts'],
                'attachmentReferenceBinding': {
                    'matched': transfer.get('attachmentMessage', {}).get('nativeCaptureBoundToUploadResponse'),
                    'sdkSourceShapeMatchCount': transfer.get('attachmentMessage', {}).get('sdkSourceShapeMatchCount'),
                    'sourceProtoTupleMatchCount': transfer.get('attachmentMessage', {}).get('sourceProtoTupleMatchCount'),
                    'sourceValueCorrelationMatch': transfer.get('attachmentMessage', {}).get('sourceValueCorrelationMatch'),
                    'sourceParentValueMatchCount': transfer.get('attachmentMessage', {}).get('sourceParentValueMatchCount'),
                    'responsePayloadMatchCount': transfer.get('attachmentMessage', {}).get('responsePayloadMatchCount'),
                    'uploadedFilesArrayCount': transfer.get('attachmentMessage', {}).get('uploadedFilesArrayCount'),
                    'fileSizeMatchCount': transfer.get('attachmentMessage', {}).get('fileSizeMatchCount'),
                    'localFileIdPresent': transfer.get('attachmentMessage', {}).get('localFileIdPresent'),
                    'messageRecaptureCount': transfer.get('attachmentMessage', {}).get('recaptureCount'),
                    'bindingResolutionCount': transfer.get('attachmentMessage', {}).get('bindingResolutionCount'),
                    'sourceLayout': transfer.get('attachmentMessage', {}).get('sourceLayout'),
                    'firstBindingDiagnostics': safe_attachment_binding(
                        transfer.get('attachmentMessage', {}).get('firstBindingDiagnostics')),
                    'sourcePathResolution': state['sourceBindingResolutionPlan'],
                    'rawReferencePersisted': False,
                },
                'directText': {
                    'status': text.get('httpStatus'), 'directDispatchCount': text.get('directDispatchCount'),
                    'contentType': text.get('responseContentType'), 'responseBytes': text.get('responseBytes'),
                    'responseSha256': text.get('responseSha256'), 'wireBodySha256': text.get('wireBodySha256'),
                    'responseDecoded': text.get('responseDecoded'), 'replyMatchedExactFileText': text.get('directReplyMatchedFile'),
                    'replyNormalizedToFileText': text.get('directReplyNormalizedFileMatch'),
                    'replyRawUtf8Bytes': text.get('directReplyRawUtf8Bytes'),
                    'replyRawCharLength': text.get('directReplyRawCharLength'),
                    'replyRawSha256': text.get('directReplyRawSha256'),
                    'replyNormalizationMatches': text.get('directReplyNormalizationMatches'),
                    'answerMatched': text.get('answerMatched'),
                    'historySummaryPromptAvailable': text.get('historySummaryPromptAvailable'),
                    'conversationIdMatched': text.get('conversationIdMatched'),
                    'hNvHttpStatus': text.get('historyDetailHttpStatus'),
                    'hNvPromptMatched': text.get('historyDetailPromptMatched'),
                    'hNvFileTextMatched': text.get('historyDetailFileTextMatched'),
                    'hNvAssistantPath': text.get('historyDetailAssistantPath'),
                    'hNvAssistantStringCount': text.get('historyDetailAssistantStringCount'),
                    'hNvExactAnswerPathCount': text.get('historyDetailExactAnswerPathCount'),
                    'hNvNormalizedAnswerPaths': text.get('historyDetailNormalizedAnswerPaths'),
                    'hNvResponseIdMatchedInAssistantRole': text.get('historyDetailResponseIdMatchedInAssistantRole'),
                    'journalReconciled': text.get('journalReconciled'),
                    'promptPersisted': False, 'responseTextPersisted': False,
                },
                'mutationJournal': journal,
                'sourceSnapshotStableThroughReceipt': source_stable,
                'directMutationDispatchCount': state['directDispatchCount'],
                'childError': state['childErrorSummary'],
                'directUploadSafeSummary': state['directUploadSummary'],
                'attachmentBindingDiagnostics': state['attachmentBindingDiagnostics'],
                'bindingDiagnosticAttempts': state['bindingDiagnosticAttempts'],
                'nativeAttachmentMessageCaptureAttempts': state['messageCaptureHistory'],
                'sourceBindingResolutionPlan': state['sourceBindingResolutionPlan'],
                'attachmentReferenceRecovery': state['attachmentReferenceRecovery'],
                'selectedFileType': state['selectedFileType'],
                'nativeContinuation': state['nativeContinuationSummary'],
                'guardLifecycle': {
                    'registeredTargetIdMatched': state['targetIdMatched'],
                    'resetQuietVerifiedThroughDisconnect': state['resetQuiet'],
                    'lateBlockedRequestCount': state['lateBlockedCount'],
                    'targetClosedFailClosed': state['targetClosedFailClosed'],
                    'roleRegistryMarkedClosed': state['roleRegistryMarkedClosed'],
                    'browserClosed': False, 'contextClosed': False,
                },
                'blockedNonReadOnlyRequestCount': state['otherBlockedCount'],
                'blockedNonReadOnlyRequestFamilies': blocked_requests[:12],
                'rawBodiesOrCredentialValuesPersisted': False,
                'rawOwnerEmailPersisted': False,
                'rawUploadSessionUrlPersisted': False,
                'rawAttachmentReferencePersisted': False,
                'rawPromptOrFileContentsPersisted': False,
                'outputStatus': transfer.get('outputStatus') if source_stable else 'needs_review_source_changed',
            }
            persist_receipt(receipt)
            receipt_written = True
            return {'status': receipt['outputStatus'], 'receiptPath': str(RECEIPT_FILE),
                'directMutationDispatchCount': state['directDispatchCount'], 'resetQuietVerified': state['resetQuiet']}
    except SafeFailure as error:
        error_code = error.code
        raise
    finally:
        child = state.get('child')
        if child is not None:
            if child.poll() is None:
                try:
                    child.stdin.close()
                except Exception:
                    pass
                try:
                    child.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=5)
            for stream in (child.stdin, child.stdout, child.stderr):
                try:
                    if stream and not stream.closed:
                        stream.close()
                except Exception:
                    pass
        if context is not None and page is not None and target_id is not None:
            reset_verified = False
            try:
                reset_owned_page_to_blank()
                reset_verified = state['resetQuiet'] is True
            except Exception:
                state['resetQuiet'] = False
            if reset_verified and route_handler is not None:
                try:
                    page.unroute('**/*', route_handler)
                except Exception:
                    pass
            elif not reset_verified:
                # Keep the request guard installed until the exact owned target is closed.
                try:
                    close_owned_target_fail_closed()
                except Exception as close_error:
                    state['targetClosedFailClosed'] = False
                    state['roleRegistryMarkedClosed'] = False
                    state['failClosedCloseError'] = (
                        close_error.code if isinstance(close_error, SafeFailure) else 'TARGET_CLOSE_FAILED')
        if not receipt_written and (state['directDispatchCount'] > 0 or state['startCapture'] is not None
                                    or state['historyArgsMismatch'] is not None):
            actor = state.get('expectedOwner')
            journal = mutation_journal_summary(actor) if actor else {}
            attempt = {
                'schema': 1, 'service': 'gemini-web', 'operation': 'attachment_chain',
                'sourceSnapshotBeforeChain': state['sourceSnapshotBeforeChain'],
                'sourceSnapshotStableThroughReceipt': source_snapshot()['aggregateSha256']
                    == state['sourceSnapshotBeforeChain']['aggregateSha256'],
                'callerIntent': UPLOAD_INTENT, 'messageCallerIntent': MESSAGE_INTENT,
                'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'outputStatus': 'incomplete', 'failureCode': error_code or 'ATTACHMENT_CHAIN_INCOMPLETE',
                'ownerDigestMatchedApproved': bool(actor),
                'file': {'name': FILE_NAME, 'mimeType': state['selectedFileType'], 'bytes': len(FILE_CONTENT),
                    'sha256': hashlib.sha256(FILE_CONTENT).hexdigest()},
                'directDispatchCount': sum(item.get('dispatchCount', 0) for item in journal.values()),
                'mutationJournal': journal,
                'childError': state['childErrorSummary'],
                'directUploadSafeSummary': state['directUploadSummary'],
                'attachmentMessage': ({
                    'method': 'POST', 'pathFamily': TEXT_PATH,
                    'bodyBytes': state['messageCapture']['bodyBytes'],
                    'bodySha256': state['messageCapture']['bodySha256'],
                    'contentType': state['messageCapture']['contentType'],
                    'headerNames': state['messageCapture']['headerNames'],
                    'browserNetworkDispatchCount': 0,
                } if state['messageCapture'] else None),
                'attachmentBindingDiagnostics': state['attachmentBindingDiagnostics'],
                'bindingDiagnosticAttempts': state['bindingDiagnosticAttempts'],
                'nativeAttachmentMessageCaptureAttempts': state['messageCaptureHistory'],
                'attachmentReferenceRecovery': state['attachmentReferenceRecovery'],
                'selectedFileType': state['selectedFileType'],
                'nativeContinuation': state['nativeContinuationSummary'],
                'nativeStartObserved': state['startCapture'] is not None,
                'nativeContinuationObserved': state['continuationCapture'] is not None,
                'nativeContinuationCaptureTimedOut': state['continuationCaptureTimedOut'],
                'continuationCookieSnapshot': state['continuationCookieSummary'],
                'nativeAttachmentMessageObserved': state['messageCapture'] is not None,
                'normalHistoryTemplate': state['batchContextSummary'],
                'historyArgsMismatch': state['historyArgsMismatch'],
                'directStart': state['startResponseSummary'],
                'directTransferResponse': state['transferResponseSummary'],
                'guardLifecycle': {'registeredTargetIdMatched': state['targetIdMatched'],
                    'resetQuietVerifiedThroughDisconnect': state['resetQuiet'],
                    'lateBlockedRequestCount': state['lateBlockedCount'],
                    'targetClosedFailClosed': state['targetClosedFailClosed'],
                    'roleRegistryMarkedClosed': state['roleRegistryMarkedClosed'],
                    'failClosedCloseError': state.get('failClosedCloseError'),
                    'browserClosed': False, 'contextClosed': False},
                'rawBodiesOrCredentialValuesPersisted': False, 'rawOwnerEmailPersisted': False,
                'rawUploadSessionUrlPersisted': False, 'rawAttachmentReferencePersisted': False,
                'rawPromptOrFileContentsPersisted': False,
            }
            try:
                persist_receipt(attempt)
            except Exception:
                pass
        if state.get('session'):
            for item in state['session'].get('cookies', []):
                item['value'] = ''
            state['session'].clear()
        if state.get('batchContext'):
            for key, value in list(state['batchContext'].items()):
                if isinstance(value, str):
                    state['batchContext'][key] = ''
        if state.get('uploadCookies'):
            scrub(state['uploadCookies'])
        if state.get('startCapture'):
            state['startCapture']['url'] = ''
            if isinstance(state['startCapture'].get('body'), bytearray):
                state['startCapture']['body'][:] = b'\0' * len(state['startCapture']['body'])
            for name in list(state['startCapture'].get('headers', {})):
                state['startCapture']['headers'][name] = ''
        if state.get('continuationCapture'):
            state['continuationCapture']['url'] = ''
            if isinstance(state['continuationCapture'].get('body'), bytearray):
                state['continuationCapture']['body'][:] = b'\0' * len(state['continuationCapture']['body'])
            for name in list(state['continuationCapture'].get('headers', {})):
                state['continuationCapture']['headers'][name] = ''
        if state.get('expectedOwner'):
            state['expectedOwner'] = ''
        if state.get('_uploadUrl'):
            state['_uploadUrl'] = ''
        FILE_PATH.unlink(missing_ok=True)


def main():
    try:
        result = main_inner()
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + '\n')
        return 0 if result.get('status') == 'verified' else 3
    except SafeFailure as error:
        sys.stdout.write(json.dumps({'status': 'failed', 'errorCode': error.code}) + '\n')
        return 3
    except Exception as error:
        sys.stdout.write(json.dumps({'status': 'failed', 'errorCode': 'ATTACHMENT_CHAIN_RUNNER_FAILED',
            'errorClass': type(error).__name__}) + '\n')
        return 3


if __name__ == '__main__':
    sys.exit(main())
