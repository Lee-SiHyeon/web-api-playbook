#!/usr/bin/env python3
"""Owner-bound, no-redirect Grok asset reader for the media CLI."""

import hashlib
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

SOURCE = 'curl_cffi-0.16.3-chrome150'
MAX_PACKET_BYTES = 32 * 1024
MAX_ASSET_BYTES = 256 * 1024 * 1024
SAFE_HEADERS = {
    'accept', 'accept-language', 'origin', 'referer', 'user-agent',
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
}
IMAGE_MIMES = {'image/jpeg', 'image/png', 'image/webp', 'image/gif'}
VIDEO_MIMES = {'video/mp4', 'video/webm'}
OUTPUT_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')


def emit(status=0, body_bytes=0, magic=False, mime=None, digest=None, *, cookies_used=True,
         headers=None, artifact_path=None, failure=None, error_class=None):
    value = {
        'assetHttpStatus': status,
        'bodyBytes': body_bytes,
        'magicVerified': bool(magic),
        'mimeType': mime,
        'sha256': digest,
        'source': SOURCE,
        'cookiesUsed': bool(cookies_used),
        'cookieNamesUsed': ['sso'] if cookies_used else [],
        'headersSubmittedNames': sorted(headers or []),
        'artifactPath': artifact_path,
    }
    if failure:
        value['failure'] = failure
    if error_class and re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,50}', error_class):
        value['errorClass'] = error_class
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')


def validate_output_target(packet):
    output_root = packet.get('outputRoot')
    output_name = packet.get('outputName')
    if output_root is None and output_name is None:
        return None, None
    if not isinstance(output_root, str) or not os.path.isabs(output_root) or not isinstance(output_name, str) or not OUTPUT_NAME.fullmatch(output_name):
        raise ValueError('OUTPUT_TARGET_INVALID')
    raw_root = Path(output_root)
    if raw_root.is_symlink() or not raw_root.is_dir():
        raise ValueError('OUTPUT_ROOT_INVALID')
    root = raw_root.resolve(strict=True)
    artifacts_home = (Path.home() / 'artifacts').resolve()
    try:
        root.relative_to(artifacts_home)
    except ValueError:
        raise ValueError('OUTPUT_ROOT_SCOPE')
    output = root / output_name
    if output.exists() or output.is_symlink():
        raise ValueError('OUTPUT_ALREADY_EXISTS')
    partial = root / f'.{output_name}.partial'
    if partial.exists() or partial.is_symlink():
        raise ValueError('OUTPUT_PARTIAL_EXISTS')
    return output, partial


def validate_packet(packet):
    required = {'assetUrl', 'cookies', 'headers', 'maxBytes', 'mimeType', 'observedCookieNames', 'requestTimeoutMs'}
    allowed = required | {'outputRoot', 'outputName'}
    if not isinstance(packet, dict) or not required.issubset(packet) or set(packet) - allowed:
        raise ValueError('PACKET_SHAPE_INVALID')
    url = packet['assetUrl']
    mime = packet['mimeType']
    if not isinstance(url, str) or len(url) > 16_384 or not isinstance(mime, str):
        raise ValueError('PACKET_VALUE_INVALID')
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname != 'assets.grok.com' or parsed.username or parsed.password \
        or parsed.fragment or parsed.query != 'cache=1' or not parsed.path.startswith('/users/') or '/generated/' not in parsed.path:
        raise ValueError('ASSET_URL_SCOPE')
    if mime.lower() not in IMAGE_MIMES | VIDEO_MIMES:
        raise ValueError('MIME_SCOPE')
    if not isinstance(packet['maxBytes'], int) or packet['maxBytes'] < 64 or packet['maxBytes'] > MAX_ASSET_BYTES \
        or not isinstance(packet['requestTimeoutMs'], int) or packet['requestTimeoutMs'] < 100 or packet['requestTimeoutMs'] > 90_000:
        raise ValueError('REQUEST_LIMIT_INVALID')
    if packet['observedCookieNames'] != ['sso']:
        raise ValueError('COOKIE_OBSERVATION_REQUIRED')
    cookies = packet['cookies']
    if not isinstance(cookies, list) or len(cookies) != 1 or not isinstance(cookies[0], dict) \
        or set(cookies[0]) != {'domain', 'httpOnly', 'name', 'path', 'secure', 'value'}:
        raise ValueError('COOKIE_SHAPE_INVALID')
    cookie = cookies[0]
    domain = cookie.get('domain')
    path = cookie.get('path')
    if cookie.get('name') != 'sso' or not isinstance(cookie.get('value'), str) or not cookie['value'] \
        or len(cookie['value']) > 8192 or re.search(r'[\r\n\0]', cookie['value']) \
        or not isinstance(domain, str) or domain.lstrip('.').lower() not in {'grok.com', 'assets.grok.com'} \
        or not isinstance(path, str) or not path.startswith('/') or not parsed.path.startswith(path) \
        or cookie.get('secure') is not True or not isinstance(cookie.get('httpOnly'), bool):
        raise ValueError('COOKIE_SCOPE_INVALID')
    headers = packet['headers']
    if not isinstance(headers, dict) or not headers or any(not isinstance(name, str) or name.lower() not in SAFE_HEADERS
        or not isinstance(value, str) or not value.strip() or len(value) > 2048 or re.search(r'[\r\n\0]', value)
        for name, value in headers.items()):
        raise ValueError('HEADER_SCOPE_INVALID')
    normalized = {name.lower(): value for name, value in headers.items()}
    if normalized.get('origin') not in (None, 'https://grok.com'):
        raise ValueError('ORIGIN_SCOPE_INVALID')
    referer = normalized.get('referer')
    if not isinstance(referer, str):
        raise ValueError('REFERER_REQUIRED')
    referer_url = urlsplit(referer)
    try:
        referer_query = parse_qs(referer_url.query, keep_blank_values=True, strict_parsing=True) if referer_url.query else {}
    except ValueError as error:
        raise ValueError('REFERER_SCOPE_INVALID') from error
    valid_referer_path = referer_url.path in {'/', '/imagine'} or re.fullmatch(r'/imagine/post/[A-Za-z0-9._~-]{1,256}', referer_url.path)
    valid_referer_query = set(referer_query).issubset({'scope', 'conversation'}) \
        and len(referer_query.get('scope', [])) <= 1 and len(referer_query.get('conversation', [])) <= 1 \
        and (not referer_query.get('scope') or referer_query['scope'] == ['asset']) \
        and (not referer_query.get('conversation') or re.fullmatch(r'[A-Za-z0-9._~-]{1,128}', referer_query['conversation'][0]) is not None)
    if referer_url.scheme != 'https' or referer_url.hostname != 'grok.com' or referer_url.username or referer_url.password \
        or referer_url.fragment or not valid_referer_path or not valid_referer_query:
        raise ValueError('REFERER_SCOPE_INVALID')
    if 'user-agent' not in normalized or 'sec-ch-ua-platform' not in normalized:
        raise ValueError('NATIVE_HEADER_BINDING_REQUIRED')
    output, partial = validate_output_target(packet)
    return parsed, mime.lower(), cookie, normalized, output, partial, packet['maxBytes'], packet['requestTimeoutMs']


def magic_for(prefix, mime):
    if mime == 'image/jpeg':
        return len(prefix) >= 3 and prefix[:3] == b'\xff\xd8\xff'
    if mime == 'image/png':
        return len(prefix) >= 24 and prefix[:8] == b'\x89PNG\r\n\x1a\n' and prefix[12:16] == b'IHDR'
    if mime == 'image/webp':
        return len(prefix) >= 12 and prefix[:4] == b'RIFF' and prefix[8:12] == b'WEBP'
    if mime == 'image/gif':
        return len(prefix) >= 10 and prefix[:6] in (b'GIF87a', b'GIF89a')
    if mime == 'video/mp4':
        return len(prefix) >= 12 and prefix[4:8] == b'ftyp'
    if mime == 'video/webm':
        return len(prefix) >= 4 and prefix[:4] == b'\x1aE\xdf\xa3'
    return False


def main():
    raw = bytearray(sys.stdin.buffer.read(MAX_PACKET_BYTES + 1))
    if len(raw) > MAX_PACKET_BYTES:
        for index in range(len(raw)):
            raw[index] = 0
        emit(failure='PACKET_SIZE_LIMIT', cookies_used=False)
        return 2
    try:
        packet = json.loads(raw.decode('utf-8'))
        parsed, expected_mime, cookie, headers, output, partial, max_bytes, request_timeout_ms = validate_packet(packet)
    except Exception as error:
        for index in range(len(raw)):
            raw[index] = 0
        code = str(error) if str(error).isupper() and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', str(error)) else 'PACKET_INVALID'
        emit(failure=code, cookies_used=False)
        return 2
    finally:
        if 'raw' in locals():
            for index in range(len(raw)):
                raw[index] = 0
    try:
        import curl_cffi
        from curl_cffi import requests
    except Exception as error:
        emit(failure='CFFI_IMPORT_FAILED', error_class=type(error).__name__, headers=headers,
             cookies_used=True)
        return 2
    if getattr(curl_cffi, '__version__', None) != '0.16.3':
        emit(failure='CFFI_VERSION_MISMATCH', headers=headers, cookies_used=True)
        return 2
    status = 0
    actual_mime = None
    body_bytes = 0
    magic = False
    digest = None
    prefix = bytearray()
    response = None
    writer = None
    saved_path = None
    session = None
    try:
        with requests.Session(impersonate='chrome150', verify=True, trust_env=False, retry=0) as session:
            session.cookies.clear()
            session.cookies.set('sso', cookie['value'], domain=cookie['domain'], path=cookie['path'])
            response = session.get(urlsplit(packet['assetUrl']).geturl(), headers=headers, timeout=min(60, request_timeout_ms / 1000),
                                   allow_redirects=False, stream=True)
            status = response.status_code
            actual_mime = response.headers.get('content-type', '').split(';', 1)[0].strip().lower()
            aliases = {'image/jpg': 'image/jpeg'}
            actual_mime = aliases.get(actual_mime, actual_mime)
            declared = response.headers.get('content-length')
            if declared is not None and (not declared.isdigit() or int(declared) < 1 or int(declared) > max_bytes):
                raise ValueError('ASSET_SIZE_LIMIT')
            complete = status == 200
            if status == 206:
                match = re.fullmatch(r'bytes 0-(\d+)/(\d+)', response.headers.get('content-range', ''), re.I)
                complete = bool(match and int(match.group(1)) + 1 == int(match.group(2)))
            if status in (200, 206) and complete and actual_mime == expected_mime:
                digest_state = hashlib.sha256()
                if partial is not None:
                    descriptor = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
                    writer = os.fdopen(descriptor, 'wb')
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    if not chunk:
                        continue
                    body_bytes += len(chunk)
                    if body_bytes > max_bytes:
                        raise ValueError('ASSET_SIZE_LIMIT')
                    digest_state.update(chunk)
                    if len(prefix) < 64:
                        prefix.extend(chunk[:64 - len(prefix)])
                    if writer is not None:
                        writer.write(chunk)
                digest = digest_state.hexdigest()
                magic = magic_for(bytes(prefix), expected_mime)
                if writer is not None:
                    writer.flush()
                    os.fsync(writer.fileno())
                    writer.close()
                    writer = None
                if partial is not None and magic and digest:
                    os.link(partial, output)
                    os.unlink(partial)
                    saved_path = str(output)
                elif partial is not None:
                    partial.unlink(missing_ok=True)
    except Exception as error:
        if writer is not None:
            writer.close()
        if partial is not None:
            partial.unlink(missing_ok=True)
        emit(status, body_bytes, False, actual_mime, None, cookies_used=True, headers=headers,
             failure='ASSET_READ_FAILED', error_class=type(error).__name__)
        return 2
    finally:
        if response is not None:
            response.close()
        try:
            session.cookies.clear()
        except Exception:
            pass
        for index in range(len(prefix)):
            prefix[index] = 0
    emit(status, body_bytes, magic, actual_mime, digest, cookies_used=True, headers=headers, artifact_path=saved_path)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
