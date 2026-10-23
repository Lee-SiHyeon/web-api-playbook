#!/usr/bin/env python3
"""One captured Grok Imagine video POST through owner-bound curl-cffi."""

import base64
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qs, urlsplit

SOURCE = 'curl_cffi-0.16.3-chrome150'
URL = 'https://grok.com/rest/app-chat/conversations/new'
MAX_PACKET_BYTES = 128 * 1024
MAX_BODY_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_ERROR_BYTES = 64 * 1024
SAFE_HEADERS = {
    'accept', 'content-type', 'origin', 'referer', 'user-agent',
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
    'x-statsig-id', 'x-xai-request-id',
}
SAFE_RESPONSE_HEADERS = {'content-type', 'content-length', 'cf-mitigated', 'retry-after'}
SAFE_ERROR_STAGES = {'validation', 'dependency', 'session_setup', 'request', 'response_headers', 'response_body'}
RESOURCE_KEYS = {
    'requestid': 'requestIds', 'clientrequestid': 'requestIds', 'requestuuid': 'requestIds',
    'conversationid': 'conversationIds', 'conversationuuid': 'conversationIds',
    'responseid': 'responseIds', 'assistantresponseid': 'responseIds',
    'assetid': 'assetIds', 'generatedassetid': 'assetIds',
    'postid': 'postIds', 'jobid': 'postIds', 'taskid': 'postIds',
}
CONTEXT_IDS = {'conversation': 'conversationIds', 'response': 'responseIds', 'asset': 'assetIds',
    'item': 'itemIds', 'post': 'postIds', 'task': 'postIds'}
RESOURCE_ID_PATTERN = re.compile(r'^[A-Za-z0-9._:-]{1,256}$')
SAFE_HTTP_VERSIONS = {'http/1.0', 'http/1.1', 'h2', 'h3', 'other'}


def safe_content_type(value):
    if not isinstance(value, str):
        return None
    value = value.split(';', 1)[0].strip().lower()
    return value if len(value) <= 128 and re.fullmatch(r'[a-z0-9.+-]+/[a-z0-9.+-]+', value) else None


def safe_retry_after(value):
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.isdigit():
        seconds = int(text)
    else:
        try:
            target = parsedate_to_datetime(text)
            if target.tzinfo is None:
                target = target.replace(tzinfo=timezone.utc)
            seconds = int((target - datetime.now(timezone.utc)).total_seconds())
        except Exception:
            return None
    return max(0, min(86_400, seconds))


def safe_error_class(error):
    value = type(error).__name__ if error is not None else None
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,63}', value) else None


def extract_partial_resources(body):
    names = ('requestIds', 'conversationIds', 'responseIds', 'assetIds', 'itemIds', 'postIds')
    output = {name: [] for name in names}
    if not isinstance(body, (bytes, bytearray)) or not body:
        return output
    found = {name: set() for name in names}

    def add(name, value):
        if name in found and isinstance(value, str) and RESOURCE_ID_PATTERN.fullmatch(value) and len(found[name]) < 100:
            found[name].add(value)

    def walk(value, parent_context='', depth=0):
        if depth > 16:
            return
        if isinstance(value, list):
            for item in value[:512]:
                walk(item, parent_context, depth + 1)
            return
        if not isinstance(value, dict):
            return
        for key, child in list(value.items())[:512]:
            if not isinstance(key, str):
                continue
            normalized = key.lower().replace('-', '').replace('_', '')
            next_context = normalized if normalized in CONTEXT_IDS else parent_context
            if isinstance(child, str):
                target = RESOURCE_KEYS.get(normalized)
                if target is None and normalized == 'id':
                    target = CONTEXT_IDS.get(next_context)
                if target is not None:
                    add(target, child)
            walk(child, next_context, depth + 1)

    try:
        parsed = json.loads(bytes(body).decode('utf-8'))
    except Exception:
        parsed = None
    if parsed is not None:
        walk(parsed)
    else:
        text = bytes(body).decode('utf-8', 'ignore')
        key_targets = {
            'requestIds': ('requestId', 'clientRequestId', 'requestUuid'),
            'conversationIds': ('conversationId', 'conversation_id', 'conversationUuid'),
            'responseIds': ('responseId', 'response_id', 'assistantResponseId'),
            'assetIds': ('assetId', 'asset_id', 'generatedAssetId'),
            'postIds': ('postId', 'post_id', 'jobId', 'taskId'),
        }
        for target, keys in key_targets.items():
            for key in keys:
                pattern = re.compile(r'"' + re.escape(key) + r'"\s*:\s*"([A-Za-z0-9._:-]{1,256})"')
                for match in pattern.finditer(text):
                    add(target, match.group(1))
    for name in names:
        output[name] = sorted(found[name])
    return output


def emit_error(code, exit_code=2, *, evidence=None, response_body=None, partial_resources=None, packet=None, cookie_jar=None):
    evidence = evidence if isinstance(evidence, dict) else {}
    response_body_sha256 = hashlib.sha256(bytes(response_body)).hexdigest() if isinstance(response_body, (bytes, bytearray)) else None
    safe = {
        'stage': evidence.get('stage') if evidence.get('stage') in SAFE_ERROR_STAGES else 'validation',
        'requestStarted': evidence.get('requestStarted') is True,
        'responseReceived': evidence.get('responseReceived') is True,
        'httpStatus': evidence.get('httpStatus') if isinstance(evidence.get('httpStatus'), int)
            and 100 <= evidence.get('httpStatus') <= 599 else None,
        'contentType': safe_content_type(evidence.get('contentType')),
        'httpVersion': evidence.get('httpVersion') if evidence.get('httpVersion') in SAFE_HTTP_VERSIONS else 'other',
        'responseBytesRead': evidence.get('responseBytesRead') if isinstance(evidence.get('responseBytesRead'), int)
            and 0 <= evidence.get('responseBytesRead') <= MAX_RESPONSE_BYTES else 0,
        'requestBodyBytes': evidence.get('requestBodyBytes') if isinstance(evidence.get('requestBodyBytes'), int)
            and 0 <= evidence.get('requestBodyBytes') <= MAX_BODY_BYTES else 0,
        'cfMitigated': evidence.get('cfMitigated') is True,
        'errorClass': evidence.get('errorClass') if isinstance(evidence.get('errorClass'), str)
            and re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,63}', evidence.get('errorClass')) else None,
        'requestHeaderNames': sorted({name for name in evidence.get('requestHeaderNames', [])
            if isinstance(name, str) and name.lower() in SAFE_HEADERS}) if isinstance(evidence.get('requestHeaderNames'), list) else [],
        'responseHeaderNames': sorted({name for name in evidence.get('responseHeaderNames', [])
            if isinstance(name, str) and name.lower() in SAFE_RESPONSE_HEADERS}) if isinstance(evidence.get('responseHeaderNames'), list) else [],
        'cookieNamesUsed': ['sso'] if evidence.get('cookieNamesUsed') == ['sso'] else [],
        'source': SOURCE,
    }
    if isinstance(response_body, bytearray):
        response_body[:] = b'\0' * len(response_body)
    if isinstance(packet, dict):
        packet['bodyText'] = ''
        for cookie in packet.get('cookies', []):
            if isinstance(cookie, dict):
                cookie['value'] = ''
    if cookie_jar is not None:
        try:
            cookie_jar.clear()
        except Exception:
            pass
    partial = partial_resources if isinstance(partial_resources, dict) else {}
    safe_partial = {}
    for name in ('requestIds', 'conversationIds', 'responseIds', 'assetIds', 'itemIds', 'postIds'):
        values = partial.get(name, [])
        safe_partial[name] = sorted({value for value in values[:100] if isinstance(value, str)
            and RESOURCE_ID_PATTERN.fullmatch(value)}) if isinstance(values, list) else []
    sys.stdout.write(json.dumps({'error': code, 'transportEvidence': safe, 'partialResources': safe_partial,
        'responseBodySha256': response_body_sha256}, separators=(',', ':')) + '\n')
    raise SystemExit(exit_code)


def validate_body(body_text):
    if not isinstance(body_text, str) or not body_text or len(body_text.encode('utf-8')) > MAX_BODY_BYTES:
        emit_error('VIDEO_BODY_INVALID')
    try:
        body = json.loads(body_text)
    except Exception:
        emit_error('VIDEO_BODY_INVALID')
    expected_fields = {
        'enableImageStreaming', 'enableSideBySide', 'kind', 'mediaGenInput',
        'message', 'modelName', 'responseMetadata', 'sendFinalMetadata',
    }
    if not isinstance(body, dict) or set(body) != expected_fields:
        emit_error('VIDEO_BODY_SCHEMA_INVALID')
    media_input = body.get('mediaGenInput')
    modes = list(media_input) if isinstance(media_input, dict) else []
    text_mode = modes == ['textToVideo']
    image_mode = modes == ['imageToVideo']
    video = media_input.get('textToVideo') if text_mode else media_input.get('imageToVideo') if image_mode else None
    image_base_fields = {'aspectRatio', 'duration', 'inputAssets', 'mode', 'prompt', 'resolutionName', 'skipAudio'}
    image_fields_valid = image_mode and isinstance(video, dict) and (set(video) == image_base_fields
        or set(video) == image_base_fields | {'useFirstFrame'})
    text_fields_valid = text_mode and isinstance(video, dict) and set(video) == {'aspectRatio', 'duration', 'prompt', 'resolutionName', 'skipAudio'}
    if body.get('modelName') != 'imagine-video-gen' or body.get('kind') != 'CONVERSATION_KIND_IMAGINE' \
        or body.get('enableImageStreaming') is not True or body.get('enableSideBySide') is not True \
        or body.get('sendFinalMetadata') is not True or not isinstance(body.get('message'), str) \
        or not body['message'].strip() or not isinstance(video, dict) or not (image_fields_valid or text_fields_valid) \
        or not isinstance(video.get('prompt'), str) or body['message'] != f"{video['prompt'].strip()} --mode=custom" \
        or video.get('aspectRatio') != '2:3' \
        or video.get('duration') != 6 or video.get('resolutionName') != '480p' or video.get('skipAudio') is not True \
        or image_mode and (video.get('mode') != 'custom' or not isinstance(video.get('inputAssets'), list) \
            or len(video['inputAssets']) != 1 or not isinstance(video['inputAssets'][0], str) \
            or not video['inputAssets'][0] or len(video['inputAssets'][0]) > 256 \
            or 'useFirstFrame' in video and not isinstance(video['useFirstFrame'], bool)):
        emit_error('VIDEO_BODY_PROFILE_INVALID')
    metadata = body.get('responseMetadata')
    if not isinstance(metadata, dict) or set(metadata) != {'experiments', 'modelConfigOverride'} \
        or metadata.get('experiments') != [] or not isinstance(metadata.get('modelConfigOverride'), dict) \
        or set(metadata['modelConfigOverride']) != {'modelMap'} \
        or metadata['modelConfigOverride'].get('modelMap') != {}:
        emit_error('VIDEO_BODY_PROFILE_INVALID')


def main():
    raw = bytearray(sys.stdin.buffer.read(MAX_PACKET_BYTES + 1))
    if len(raw) > MAX_PACKET_BYTES:
        for index in range(len(raw)):
            raw[index] = 0
        emit_error('PACKET_SIZE_LIMIT')
    try:
        packet = json.loads(raw.decode('utf-8'))
    except Exception:
        for index in range(len(raw)):
            raw[index] = 0
        emit_error('PACKET_INVALID')
    finally:
        for index in range(len(raw)):
            raw[index] = 0
    if not isinstance(packet, dict) or set(packet) != {'bodyText', 'cookies', 'headers', 'method', 'observedCookieNames', 'timeoutMs', 'url'}:
        emit_error('PACKET_SHAPE_INVALID')
    if packet.get('url') != URL or packet.get('method') != 'POST' or packet.get('observedCookieNames') != ['sso']:
        emit_error('REQUEST_SCOPE_INVALID')
    timeout_ms = packet.get('timeoutMs')
    if not isinstance(timeout_ms, int) or timeout_ms < 500 or timeout_ms > 60_000:
        emit_error('TIMEOUT_INVALID')
    validate_body(packet.get('bodyText'))
    headers = packet.get('headers')
    if not isinstance(headers, dict) or not headers or any(not isinstance(name, str) or name.lower() not in SAFE_HEADERS
        or not isinstance(value, str) or not value.strip() or len(value) > 2_048 or re.search(r'[\r\n\0]', value)
        for name, value in headers.items()):
        emit_error('HEADER_SCOPE_INVALID')
    lowered = {name.lower(): value for name, value in headers.items()}
    if lowered.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json' \
        or lowered.get('origin') != 'https://grok.com' or 'referer' not in lowered:
        emit_error('BASIC_HEADER_BINDING_INVALID')
    referer = urlsplit(lowered['referer'])
    try:
        referer_query = parse_qs(referer.query, keep_blank_values=True, strict_parsing=True) if referer.query else {}
    except ValueError:
        emit_error('REFERER_SCOPE_INVALID')
    allowed_referer_path = referer.path == '/imagine' or re.fullmatch(r'/imagine/post/[A-Za-z0-9._~-]{1,256}', referer.path)
    valid_referer_query = set(referer_query).issubset({'scope', 'conversation'}) \
        and len(referer_query.get('scope', [])) <= 1 and len(referer_query.get('conversation', [])) <= 1 \
        and (not referer_query.get('scope') or referer_query['scope'] == ['asset']) \
        and (not referer_query.get('conversation') or re.fullmatch(r'[A-Za-z0-9._~-]{1,128}', referer_query['conversation'][0]) is not None)
    if referer.scheme != 'https' or referer.hostname != 'grok.com' or referer.username or referer.password \
        or referer.fragment or not allowed_referer_path or not valid_referer_query:
        emit_error('REFERER_SCOPE_INVALID')
    if any(name not in lowered for name in ('user-agent', 'sec-ch-ua-platform', 'x-statsig-id', 'x-xai-request-id')):
        emit_error('NATIVE_HEADER_BINDING_REQUIRED')
    cookies = packet.get('cookies')
    if not isinstance(cookies, list) or len(cookies) != 1 or not isinstance(cookies[0], dict) \
        or set(cookies[0]) != {'domain', 'httpOnly', 'name', 'path', 'secure', 'value'}:
        emit_error('COOKIE_SHAPE_INVALID')
    cookie = cookies[0]
    if cookie.get('name') != 'sso' or not isinstance(cookie.get('value'), str) or not cookie['value'] \
        or len(cookie['value']) > 8_192 or re.search(r'[\r\n\0;]', cookie['value']) \
        or not isinstance(cookie.get('domain'), str) or cookie['domain'].lstrip('.').lower() not in {'grok.com', 'assets.grok.com'} \
        or cookie.get('path') != '/' or cookie.get('secure') is not True or cookie.get('httpOnly') is not True:
        emit_error('COOKIE_SCOPE_INVALID')
    try:
        import curl_cffi
        from curl_cffi import requests
    except Exception as error:
        emit_error('CFFI_DEPENDENCY_MISSING', evidence={'stage': 'dependency', 'errorClass': safe_error_class(error)}, packet=packet)
    if getattr(curl_cffi, '__version__', None) != '0.16.3':
        emit_error('CFFI_VERSION_MISMATCH', evidence={'stage': 'dependency'}, packet=packet)
    status = None
    content_type = None
    body = bytearray()
    http_version = 'other'
    cf_mitigated = False
    request_started = False
    response_received = False
    request_body_bytes = len(packet['bodyText'].encode('utf-8'))
    request_header_names = sorted(lowered)
    cookie_jar = None
    response = None
    response_header_names = []
    response_content_length = None
    retry_after_seconds = None
    try:
        try:
            session = requests.Session(impersonate='chrome150', verify=True, trust_env=False, retry=0)
        except Exception as error:
            emit_error('CFFI_SESSION_CREATE_FAILED', evidence={
                'stage': 'session_setup', 'requestStarted': False, 'requestBodyBytes': request_body_bytes,
                'errorClass': safe_error_class(error), 'requestHeaderNames': request_header_names,
            }, packet=packet)
        with session:
            cookie_jar = session.cookies
            try:
                session.cookies.clear()
                session.cookies.set('sso', cookie['value'], domain=cookie['domain'], path=cookie['path'])
            except Exception as error:
                emit_error('CFFI_COOKIE_BIND_FAILED', evidence={
                    'stage': 'session_setup', 'requestStarted': False, 'requestBodyBytes': request_body_bytes,
                    'errorClass': safe_error_class(error), 'requestHeaderNames': request_header_names,
                }, packet=packet, cookie_jar=cookie_jar)
            request_started = True
            try:
                response = session.post(URL, data=packet['bodyText'].encode('utf-8'), headers=lowered,
                    timeout=timeout_ms / 1000, allow_redirects=False, stream=True)
            except Exception as error:
                emit_error('CFFI_REQUEST_FAILED', evidence={
                    'stage': 'request', 'requestStarted': True, 'requestBodyBytes': request_body_bytes,
                    'requestHeaderNames': request_header_names, 'cookieNamesUsed': ['sso'],
                    'errorClass': safe_error_class(error),
                }, packet=packet, cookie_jar=cookie_jar)
            response_received = True
            try:
                status = response.status_code if isinstance(response.status_code, int) else None
                content_type = safe_content_type(response.headers.get('content-type'))
                cf_mitigated = response.headers.get('cf-mitigated', '').lower() == 'challenge'
                retry_after_seconds = safe_retry_after(response.headers.get('retry-after'))
                content_length = response.headers.get('content-length')
                response_content_length = int(content_length) if isinstance(content_length, str) and content_length.isdigit() else None
                http_version = {1: 'http/1.0', 2: 'http/1.1', 3: 'h2', 30: 'h3'}.get(response.http_version, 'other')
                response_header_names = sorted(name.lower() for name in response.headers.keys()
                    if isinstance(name, str) and name.lower() in SAFE_RESPONSE_HEADERS)
            except Exception as error:
                emit_error('CFFI_RESPONSE_HEADERS_FAILED', evidence={
                    'stage': 'response_headers', 'requestStarted': True, 'responseReceived': True,
                    'httpStatus': status, 'contentType': content_type, 'httpVersion': http_version,
                    'responseBytesRead': len(body), 'requestBodyBytes': request_body_bytes,
                    'cfMitigated': cf_mitigated, 'errorClass': safe_error_class(error),
                    'requestHeaderNames': request_header_names, 'cookieNamesUsed': ['sso'],
                }, response_body=body, packet=packet, cookie_jar=cookie_jar)
            limit = MAX_RESPONSE_BYTES if isinstance(status, int) and 200 <= status <= 299 else MAX_ERROR_BYTES
            declared = response.headers.get('content-length')
            if declared is not None and (not declared.isdigit() or int(declared) > limit):
                response.close()
                emit_error('RESPONSE_SIZE_LIMIT', evidence={
                    'stage': 'response_headers', 'requestStarted': True, 'responseReceived': True,
                    'httpStatus': status, 'contentType': content_type, 'httpVersion': http_version,
                    'responseBytesRead': len(body), 'requestBodyBytes': request_body_bytes,
                    'cfMitigated': cf_mitigated, 'requestHeaderNames': request_header_names,
                    'responseHeaderNames': response_header_names, 'cookieNamesUsed': ['sso'],
                }, response_body=body, packet=packet, cookie_jar=cookie_jar)
            try:
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    if not chunk:
                        continue
                    body.extend(chunk)
                    if len(body) > limit:
                        response.close()
                        emit_error('RESPONSE_SIZE_LIMIT', evidence={
                            'stage': 'response_body', 'requestStarted': True, 'responseReceived': True,
                            'httpStatus': status, 'contentType': content_type, 'httpVersion': http_version,
                            'responseBytesRead': len(body), 'requestBodyBytes': request_body_bytes,
                            'cfMitigated': cf_mitigated, 'requestHeaderNames': request_header_names,
                            'responseHeaderNames': response_header_names, 'cookieNamesUsed': ['sso'],
                        }, response_body=body, partial_resources=extract_partial_resources(body),
                            packet=packet, cookie_jar=cookie_jar)
            except SystemExit:
                raise
            except Exception as error:
                emit_error('CFFI_RESPONSE_STREAM_FAILED', evidence={
                    'stage': 'response_body', 'requestStarted': True, 'responseReceived': True,
                    'httpStatus': status, 'contentType': content_type, 'httpVersion': http_version,
                    'responseBytesRead': len(body), 'requestBodyBytes': request_body_bytes,
                    'cfMitigated': cf_mitigated, 'errorClass': safe_error_class(error),
                    'requestHeaderNames': request_header_names, 'responseHeaderNames': response_header_names,
                    'cookieNamesUsed': ['sso'],
                }, response_body=body, partial_resources=extract_partial_resources(body),
                    packet=packet, cookie_jar=cookie_jar)
            response.close()
            session.cookies.clear()
    except SystemExit:
        raise
    except Exception as error:
        stage = 'response_body' if response_received else 'request' if request_started else 'session_setup'
        code = 'CFFI_RESPONSE_STREAM_FAILED' if response_received else 'CFFI_REQUEST_FAILED' if request_started else 'CFFI_SESSION_SETUP_FAILED'
        emit_error(code, evidence={
            'stage': stage, 'requestStarted': request_started, 'responseReceived': response_received,
            'httpStatus': status, 'contentType': content_type, 'httpVersion': http_version,
            'responseBytesRead': len(body), 'requestBodyBytes': request_body_bytes,
            'cfMitigated': cf_mitigated, 'errorClass': safe_error_class(error),
            'requestHeaderNames': request_header_names,
            'responseHeaderNames': response_header_names if response_received else [],
            'cookieNamesUsed': ['sso'] if request_started else [],
        }, response_body=body, partial_resources=extract_partial_resources(body),
            packet=packet, cookie_jar=cookie_jar)
    body_base64 = base64.b64encode(body).decode('ascii')
    response_body_sha256 = hashlib.sha256(body).hexdigest()
    response_body_bytes = len(body)
    packet['bodyText'] = ''
    cookie['value'] = ''
    body[:] = b'\0' * len(body)
    sys.stdout.write(json.dumps({
        'status': status,
        'contentType': content_type or '',
        'httpVersion': http_version,
        'bodyBase64': body_base64,
        'bodyBytes': response_body_bytes,
        'responseBodySha256': response_body_sha256,
        'contentLength': response_content_length,
        'retryAfterSeconds': retry_after_seconds,
        'cfMitigated': cf_mitigated,
        'requestHeaderNames': sorted(lowered),
        'responseHeaderNames': response_header_names,
        'cookieNamesUsed': ['sso'],
        'source': SOURCE,
    }, separators=(',', ':')) + '\n')
    body_base64 = ''


if __name__ == '__main__':
    main()
