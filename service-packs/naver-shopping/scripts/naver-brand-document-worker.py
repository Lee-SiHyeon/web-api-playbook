"""Private anonymous HTTP document transport. Metadata is stdout; body uses fd 3."""
import hashlib
import json
import os
import re
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

MAX_BYTES = 8 * 1024 * 1024
DEPS = Path(__file__).resolve().parents[1] / '.runtime' / 'http-python'
if DEPS.is_dir():
    sys.path.insert(0, str(DEPS))


class Failure(Exception):
    def __init__(self, code, message, receipt=None):
        self.code, self.message, self.receipt = code, message, receipt


def run():
    try:
        mode = os.fstat(3).st_mode
        if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)):
            raise OSError()
    except OSError:
        raise Failure('INPUT', 'Use the Naver shopping CLI; this worker requires private IPC')
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise Failure('INPUT', 'Transport input exceeded its limit')
    try:
        request = json.loads(raw)
        url = urlsplit(request['url'])
        timeout = request.get('timeoutMs', 15000)
        limit = request.get('responseByteLimit', MAX_BYTES)
        if (set(request) - {'url', 'timeoutMs', 'responseByteLimit'} or
                url.scheme != 'https' or url.hostname != 'brand.naver.com' or
                url.username or url.password or url.port or url.query or url.fragment or
                not re.fullmatch(r'/[A-Za-z0-9_-]+/products/[1-9][0-9]{0,15}', url.path) or
                type(timeout) is not int or not 100 <= timeout <= 30000 or
                type(limit) is not int or not 1 <= limit <= MAX_BYTES):
            raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError):
        raise Failure('INPUT', 'Only a canonical brand.naver.com product document is allowed')
    try:
        import curl_cffi
        from curl_cffi import requests
        from curl_cffi.const import CurlHttpVersion
    except ImportError:
        raise Failure('DEPENDENCY', 'Install requirements-http.txt into .runtime/http-python')

    chunks, size, exceeded = [], 0, False

    def consume(chunk):
        nonlocal size, exceeded
        size += len(chunk)
        if size > limit:
            exceeded = True
            return 0
        chunks.append(chunk)
        return len(chunk)

    # Honor session proxy and CA configuration; no proxy override or disabled verification.
    ca = (os.environ.get('CURL_CA_BUNDLE') or os.environ.get('REQUESTS_CA_BUNDLE') or
          os.environ.get('SSL_CERT_FILE') or True)
    try:
        with requests.Session(impersonate='chrome150', use_thread_local_curl=False) as session:
            response = session.get(request['url'], timeout=timeout / 1000,
                                   allow_redirects=False, verify=ca,
                                   http_version=CurlHttpVersion.V2_0,
                                   content_callback=consume)
            body = b''.join(chunks)
            receipt = {
                'method': 'GET', 'origin': 'https://brand.naver.com', 'path': url.path,
                'queryFields': [], 'bodyFields': [], 'httpStatus': response.status_code,
                'responseContentType': response.headers.get('content-type', ''),
                'responseDate': response.headers.get('date'), 'responseBytes': len(body),
                'responseSha256': hashlib.sha256(body).hexdigest(),
                'checkedAt': datetime.now(timezone.utc).isoformat(),
                'browserUsed': False, 'credentialsUsed': False,
                'transport': 'curl_cffi_independent_http', 'transportVersion': curl_cffi.__version__,
                'httpCompatibilityProfile': 'chrome150',
                'tlsHttp2ProfileEmulation': True, 'sourceProtocol': 'SSR_DOCUMENT',
            }
            status = response.status_code
            if status == 429:
                raise Failure('RATE_LIMITED', 'Naver returned HTTP 429; no retry was made', receipt)
            if status in (403, 418):
                raise Failure('WAF_BLOCKED', 'Naver restricted this document request', receipt)
            if status == 401:
                raise Failure('AUTH_REQUIRED', 'Naver requires an authorized session', receipt)
            if 300 <= status < 400:
                location = response.headers.get('location', '')
                code = 'AUTH_REQUIRED' if 'nid.naver.com' in location else 'REDIRECT_REJECTED'
                raise Failure(code, 'Naver returned a redirect; it was not followed', receipt)
            if status != 200:
                raise Failure('HTTP_STATUS', 'Naver returned an unexpected HTTP status', receipt)
            if not re.match(r'^text/html\b', receipt['responseContentType'], re.I):
                raise Failure('CONTENT_TYPE', 'Naver returned a non-HTML document', receipt)
            if re.search(rb'<title[^>]*>\s*' + '네이버'.encode() + rb'\s*' + '로그인'.encode(), body):
                raise Failure('AUTH_REQUIRED', 'Naver returned a login document', receipt)
    except Failure:
        raise
    except Exception:
        if exceeded:
            raise Failure('SIZE_LIMIT', 'Naver response exceeded the byte limit')
        raise Failure('TRANSPORT', 'Naver document HTTP request failed')

    # The raw document never goes to stdout, files, logs, or public CLI output.
    with os.fdopen(3, 'wb', closefd=False) as channel:
        channel.write(body)
        channel.flush()
    return {'ok': True, 'receipt': receipt}


if __name__ == '__main__':
    try:
        result = run()
    except Failure as error:
        result = {'ok': False, 'error': {'code': error.code, 'message': error.message,
                                       'receipt': error.receipt}}
    except Exception:
        result = {'ok': False, 'error': {'code': 'INTERNAL', 'message': 'Document worker failed'}}
    print(json.dumps(result, ensure_ascii=False))
