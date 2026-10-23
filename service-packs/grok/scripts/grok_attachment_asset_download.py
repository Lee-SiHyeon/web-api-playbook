#!/usr/bin/env python3
"""Download one task-owned Grok attachment using its observed SSO scope."""
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

SOURCE = 'curl_cffi-0.16.3-chrome150'
MAX_PACKET_BYTES = 32 * 1024
MAX_ATTACHMENT_ASSET_BYTES = 256 * 1024 * 1024
OUTPUT_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
SAFE_HEADERS = {
    'accept', 'accept-language', 'origin', 'referer', 'user-agent',
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
}
MIMES = {
    'text/plain', 'application/octet-stream', 'application/pdf', 'application/rtf',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm',
}


def emit(status=0, mime=None, body_bytes=0, digest=None, bytes_match=False, artifact_path=None,
         headers=None, cookie_used=False, failure=None, error_class=None):
    result = {
        'status': int(status), 'mimeType': mime, 'bodyBytes': int(body_bytes), 'sha256': digest,
        'bytesMatch': bool(bytes_match), 'artifactPath': artifact_path,
        'headersSubmittedNames': sorted(headers or []), 'cookieNamesUsed': ['sso'] if cookie_used else [],
        'source': SOURCE,
    }
    if failure:
        result['failure'] = failure
    if error_class and re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,50}', error_class):
        result['errorClass'] = error_class
    sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')


def validate_packet(p):
    required = {
        'assetUrl', 'assetOrigin', 'mimeType', 'expectedBytes', 'expectedSha256', 'assetCookieScope',
        'ssoCookieValue', 'headers', 'ownerIdentityDigest', 'outputRoot', 'outputName', 'maxBytes',
    }
    if not isinstance(p, dict) or set(p) != required:
        raise ValueError('PACKET_SHAPE_INVALID')
    url, origin, mime = p['assetUrl'], p['assetOrigin'], str(p['mimeType']).lower()
    if not isinstance(url, str) or len(url) > 16384 or origin != 'https://assets.grok.com' or mime not in MIMES:
        raise ValueError('PACKET_VALUE_INVALID')
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname != 'assets.grok.com' or parsed.username or parsed.password \
       or parsed.fragment or parsed.query != 'cache=1' or not parsed.path.startswith('/users/') \
       or any(part in {'.', '..'} for part in parsed.path.split('/')):
        raise ValueError('ASSET_URL_SCOPE')
    if not isinstance(p['expectedBytes'], int) or p['expectedBytes'] < 1 or p['expectedBytes'] > MAX_ATTACHMENT_ASSET_BYTES \
       or not isinstance(p['maxBytes'], int) or p['maxBytes'] < p['expectedBytes'] or p['maxBytes'] > MAX_ATTACHMENT_ASSET_BYTES \
       or not isinstance(p['expectedSha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', p['expectedSha256']) \
       or not isinstance(p['ownerIdentityDigest'], str) or not re.fullmatch(r'[a-f0-9]{64}', p['ownerIdentityDigest']):
        raise ValueError('REQUEST_LIMIT_INVALID')
    scope = p['assetCookieScope']
    if not isinstance(scope, dict) or set(scope) != {'domain', 'httpOnly', 'path', 'secure'} \
       or not isinstance(scope.get('domain'), str) or scope['domain'].lower() not in {'.grok.com', '.assets.grok.com', 'assets.grok.com'} \
       or not isinstance(scope.get('path'), str) or not scope['path'].startswith('/') or not parsed.path.startswith(scope['path']) \
       or scope.get('secure') is not True or not isinstance(scope.get('httpOnly'), bool):
        raise ValueError('COOKIE_SCOPE_INVALID')
    cookie = p['ssoCookieValue']
    if not isinstance(cookie, str) or not cookie or len(cookie) > 8192 or re.search(r'[\r\n\0;]', cookie):
        raise ValueError('COOKIE_VALUE_INVALID')
    headers = p['headers']
    if not isinstance(headers, dict) or not headers or any(
        not isinstance(k, str) or k.lower() not in SAFE_HEADERS or not isinstance(v, str)
        or not v.strip() or len(v) > 2048 or re.search(r'[\r\n\0]', v) for k, v in headers.items()
    ):
        raise ValueError('HEADER_SCOPE_INVALID')
    normalized = {k.lower(): v for k, v in headers.items()}
    if normalized.get('origin') not in (None, 'https://grok.com'):
        raise ValueError('ORIGIN_SCOPE_INVALID')
    referer = urlsplit(normalized.get('referer', ''))
    if referer.scheme != 'https' or referer.hostname != 'grok.com' or referer.username or referer.password \
       or referer.query or referer.fragment or 'user-agent' not in normalized \
       or 'sec-ch-ua-platform' not in normalized or not re.search(r'Chrome/', normalized['user-agent']):
        raise ValueError('NATIVE_HEADER_BINDING_REQUIRED')
    if not isinstance(p['outputRoot'], str) or not os.path.isabs(p['outputRoot']) \
       or not isinstance(p['outputName'], str) or not OUTPUT_NAME.fullmatch(p['outputName']):
        raise ValueError('OUTPUT_TARGET_INVALID')
    root = Path(p['outputRoot'])
    if root.is_symlink() or not root.is_dir():
        raise ValueError('OUTPUT_ROOT_INVALID')
    real_root = root.resolve(strict=True)
    artifacts = (Path.home() / 'artifacts').resolve()
    try:
        real_root.relative_to(artifacts)
    except ValueError:
        raise ValueError('OUTPUT_ROOT_SCOPE')
    output = real_root / p['outputName']
    partial = real_root / f'.{p["outputName"]}.partial'
    if output.exists() or output.is_symlink() or partial.exists() or partial.is_symlink():
        raise ValueError('OUTPUT_ALREADY_EXISTS')
    return parsed, mime, cookie, normalized, output, partial, p['expectedBytes'], p['expectedSha256'], p['maxBytes']


def main():
    raw = bytearray(sys.stdin.buffer.read(MAX_PACKET_BYTES + 1))
    if len(raw) > MAX_PACKET_BYTES:
        raw[:] = b'\0' * len(raw)
        emit(failure='PACKET_SIZE_LIMIT')
        return 2
    try:
        packet = json.loads(raw.decode('utf-8'))
        parsed, expected_mime, cookie, headers, output, partial, expected_bytes, expected_sha, max_bytes = validate_packet(packet)
    except Exception as error:
        raw[:] = b'\0' * len(raw)
        code = str(error) if str(error).isupper() and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', str(error)) else 'PACKET_INVALID'
        emit(failure=code)
        return 2
    finally:
        if 'raw' in locals(): raw[:] = b'\0' * len(raw)
        if 'packet' in locals() and isinstance(packet, dict): packet['ssoCookieValue'] = ''
    try:
        import curl_cffi
        from curl_cffi import requests
    except Exception as error:
        emit(failure='CFFI_IMPORT_FAILED', error_class=type(error).__name__, headers=headers)
        return 2
    if getattr(curl_cffi, '__version__', None) != '0.16.3':
        emit(failure='CFFI_VERSION_MISMATCH', headers=headers)
        return 2
    response = None
    session = None
    writer = None
    status = 0
    actual_mime = None
    body_bytes = 0
    digest = None
    bytes_match = False
    saved_path = None
    prefix = bytearray()
    try:
        with requests.Session(impersonate='chrome150', verify=True, trust_env=False, retry=0) as session:
            session.cookies.clear()
            domain = packet.get('assetCookieScope', {}).get('domain', '.grok.com') if isinstance(packet, dict) else '.grok.com'
            path = packet.get('assetCookieScope', {}).get('path', '/') if isinstance(packet, dict) else '/'
            # The packet copy was cleared; retain only the scoped cookie value in this stack frame.
            if not cookie:
                raise ValueError('COOKIE_VALUE_INVALID')
            session.cookies.set('sso', cookie, domain=domain, path=path)
            response = session.get(parsed.geturl(), headers=headers, timeout=45, allow_redirects=False, stream=True)
            status = response.status_code
            actual_mime = response.headers.get('content-type', '').split(';', 1)[0].strip().lower()
            aliases = {'image/jpg': 'image/jpeg'}
            actual_mime = aliases.get(actual_mime, actual_mime)
            if status != 200 or actual_mime != expected_mime:
                emit(status, actual_mime, 0, None, False, None, headers, True, failure='HTTP_OR_MIME_MISMATCH')
                return 2
            declared = response.headers.get('content-length')
            if declared is not None and (not declared.isdigit() or int(declared) != expected_bytes or int(declared) > max_bytes):
                raise ValueError('CONTENT_LENGTH_MISMATCH')
            descriptor = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            writer = os.fdopen(descriptor, 'wb')
            hash_state = hashlib.sha256()
            for chunk in response.iter_content(chunk_size=8192):
                if not chunk: continue
                body_bytes += len(chunk)
                if body_bytes > max_bytes: raise ValueError('ASSET_SIZE_LIMIT')
                hash_state.update(chunk)
                if len(prefix) < 64: prefix.extend(chunk[:64-len(prefix)])
                writer.write(chunk)
            digest = hash_state.hexdigest()
            bytes_match = body_bytes == expected_bytes and digest == expected_sha
            writer.flush(); os.fsync(writer.fileno()); writer.close(); writer = None
            if bytes_match:
                os.link(partial, output)
                partial.unlink(missing_ok=True)
                saved_path = str(output)
            else:
                partial.unlink(missing_ok=True)
    except Exception as error:
        if writer is not None: writer.close()
        partial.unlink(missing_ok=True)
        code = str(error) if str(error).isupper() and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', str(error)) else 'ASSET_DOWNLOAD_FAILED'
        emit(status, actual_mime, body_bytes, digest, False, None, headers, True, failure=code, error_class=type(error).__name__)
        return 2
    finally:
        if response is not None: response.close()
        try:
            if session is not None: session.cookies.clear()
        except Exception: pass
        prefix[:] = b'\0' * len(prefix)
        cookie = ''
    emit(status, actual_mime, body_bytes, digest, bytes_match, saved_path, headers, True,
         failure=None if bytes_match else 'BODY_HASH_OR_SIZE_MISMATCH')
    return 0 if bytes_match else 2


if __name__ == '__main__':
    raise SystemExit(main())
