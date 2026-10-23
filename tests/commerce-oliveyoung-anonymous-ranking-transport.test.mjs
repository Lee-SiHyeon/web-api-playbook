import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { oliveyoungTestPython } from './helpers/oliveyoung-python.mjs';
import { createOliveyoungAnonymousRankingFetch } from '../lib/commerce/oliveyoung-anonymous-ranking-transport.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'scripts/oliveyoung-anonymous-ranking-session.py');
const PYTHON = oliveyoungTestPython;
const ACCEPT = 'text/html,application/xhtml+xml';
const RANK_URL = 'https://www.oliveyoung.co.kr/store/main/getBestList.do';

test('rejects caller cookies, arbitrary headers, credentials, methods and unobserved routes before network startup', async () => {
  assert.throws(() => createOliveyoungAnonymousRankingFetch({ timeoutMs: 5000, minIntervalMs: 5000 }),
    { code: 'OLIVEYOUNG_ANONYMOUS_OPTIONS_INVALID' });
  const fetchImpl = createOliveyoungAnonymousRankingFetch({ pythonPath: '/missing/python' });
  await assert.rejects(fetchImpl(RANK_URL, {
    method: 'GET', redirect: 'manual', headers: { accept: ACCEPT, cookie: 'account=secret' },
  }), { code: 'OLIVEYOUNG_ANONYMOUS_HEADERS_REJECTED' });
  await assert.rejects(fetchImpl(RANK_URL, {
    method: 'GET', redirect: 'manual', credentials: 'include', headers: { accept: ACCEPT },
  }), { code: 'OLIVEYOUNG_ANONYMOUS_REQUEST_REJECTED' });
  await assert.rejects(fetchImpl(RANK_URL, {
    method: 'POST', redirect: 'manual', headers: { accept: ACCEPT },
  }), { code: 'OLIVEYOUNG_ANONYMOUS_REQUEST_REJECTED' });
  await assert.rejects(fetchImpl('https://www.oliveyoung.co.kr/store/main/main.do', {
    method: 'GET', redirect: 'manual', headers: { accept: ACCEPT },
  }), { code: 'OLIVEYOUNG_ANONYMOUS_TARGET_REJECTED' });
  await assert.rejects(fetchImpl(RANK_URL + '?unknown=1', {
    method: 'GET', redirect: 'manual', headers: { accept: ACCEPT },
  }), { code: 'OLIVEYOUNG_ANONYMOUS_QUERY_REJECTED' });
  await fetchImpl.close();
});

test('persistent session worker bootstraps once, prunes customer cookies, spaces requests and reuses issued CF cookies', () => {
  const source = String.raw`
import importlib.util, json, sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location('oy_session', sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class Cookie:
    def __init__(self, name, domain='www.oliveyoung.co.kr'):
        self.name, self.domain, self.path = name, domain, '/'

class Jar(list):
    def clear(self, *args):
        if not args:
            del self[:]
        else:
            domain, path, name = args
            self[:] = [c for c in self if (c.domain, c.path, c.name) != (domain, path, name)]

class Cookies:
    def __init__(self): self.jar = Jar()
    def clear(self): self.jar.clear()

class Headers(dict):
    def get_list(self, name):
        value = self.get(name.lower(), [])
        return value if isinstance(value, list) else ([value] if value else [])

class Response:
    def __init__(self, status, body, cookie_header='', set_cookie=(), retry_after=None):
        self.status_code = status
        self.headers = Headers({'content-type': 'text/html;charset=UTF-8'})
        if set_cookie: self.headers['set-cookie'] = list(set_cookie)
        if retry_after: self.headers['retry-after'] = retry_after
        self.request = SimpleNamespace(headers={'cookie': cookie_header} if cookie_header else {})
        self._body, self.closed = body, False
    def iter_content(self, chunk_size):
        for offset in range(0, len(self._body), chunk_size): yield self._body[offset:offset + chunk_size]
    def close(self): self.closed = True

class Session:
    def __init__(self, scenario='success'):
        self.cookies, self.calls, self.closed, self.scenario = Cookies(), [], False, scenario
    def get(self, url, headers, timeout, allow_redirects, verify, stream):
        names = sorted(c.name for c in self.cookies.jar)
        cookie_header = '; '.join(name + '=opaque' for name in names)
        path = urlsplit(url).path
        observer = getattr(self, '_anonymous_cookie_observer', None)
        if observer and cookie_header:
            observer(2, ('GET ' + url + ' HTTP/2\r\nCookie: ' + cookie_header + '\r\n\r\n').encode())
        self.calls.append({'path': path, 'url': url, 'cookieNamesSent': names, 'timeout': timeout,
                           'allowRedirects': allow_redirects, 'verify': verify, 'stream': stream,
                           'headers': dict(headers)})
        if path == module.HOME_PATH:
            if self.scenario == 'bootstrap429':
                self.last_response = Response(429, b'limited', retry_after='30')
                return self.last_response
            if self.scenario == 'oversize':
                self.last_response = Response(200, b'x' * 4096)
                return self.last_response
            for name in ('OYSESSIONID', 'SCOUTER', '__cf_bm', '_cfuvid'):
                self.cookies.jar.append(Cookie(name))
            self.last_response = Response(200, b'<html>home</html>', set_cookie=(
                'OYSESSIONID=secret-one; Path=/', 'SCOUTER=secret-two; Path=/',
                '__cf_bm=secret-three; Path=/', '_cfuvid=secret-four; Path=/'))
            return self.last_response
        return Response(200, b'<html>rank</html>')
    def close(self): self.closed = True

clock = [0.0]
sleeps = []
session = Session()
worker = module.AnonymousRankingWorker(session_factory=lambda: session,
    sleep=lambda seconds: (sleeps.append(seconds), clock.__setitem__(0, clock[0] + seconds)),
    monotonic=lambda: clock[0], utc_now=lambda: '2026-10-05T08:00:00.000Z')
worker.handle({'op':'hello', 'protocolVersion':1})
first = worker.handle({'op':'request','protocolVersion':1,
    'url':module.ORIGIN + module.RANKING_PATH,'timeoutMs':20000,'maxResponseBytes':8192,'minIntervalMs':5000})
category_url = module.ORIGIN + module.RANKING_PATH + '?dispCatNo=900000100100001&fltDispCatNo=10000010001&pageIdx=1&rowsPerPage=8'
second = worker.handle({'op':'request','protocolVersion':1,
    'url':category_url,'timeoutMs':20000,'maxResponseBytes':8192,'minIntervalMs':5000})
bootstrap = first['anonymousSessionReceipt']['bootstrapRequest']
request = first['anonymousSessionReceipt']['request']
result = {
 'statuses':[first['status'], second['status']],
 'calls':[{'path':c['path'],'queryPresent':'?' in c['url'],'cookieNamesSent':c['cookieNamesSent'],
           'accept':c['headers'].get('accept'),'verify':c['verify'],'allowRedirects':c['allowRedirects']} for c in session.calls],
 'bootstrapIssuedCookieNames':bootstrap['issuedCookieNames'],
 'bootstrapCookieSent':bootstrap['cookieSent'],
 'requestCookieNames':request['cookieNames'],
 'sentCookieNames':request['sentCookieNames'],
 'sessionKind':request['sessionKind'],
 'sleeps':sleeps,
 'customerCookiesRetained':sorted(c.name for c in session.cookies.jar if c.name in ('OYSESSIONID','SCOUTER')),
}
worker.close()
result['closeClearedCookies'] = len(session.cookies.jar) == 0 and session.closed
print(json.dumps(result, separators=(',', ':')))
`;
  const run = spawnSync(PYTHON, ['-c', source, HELPER], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.deepEqual(result.statuses, [200, 200], JSON.stringify(result));
  assert.deepEqual(result.calls.map(call => call.path), [
    '/store/main/main.do', '/store/main/getBestList.do', '/store/main/getBestList.do',
  ]);
  assert.equal(result.calls[0].cookieNamesSent.length, 0);
  assert.deepEqual(result.calls[1].cookieNamesSent, ['__cf_bm', '_cfuvid']);
  assert.deepEqual(result.calls[2].cookieNamesSent, ['__cf_bm', '_cfuvid']);
  assert.equal(result.calls[2].queryPresent, true);
  assert.equal(result.calls.every(call => call.accept === ACCEPT && call.verify === true && call.allowRedirects === false), true);
  assert.deepEqual(result.bootstrapIssuedCookieNames, ['__cf_bm', '_cfuvid']);
  assert.equal(result.bootstrapCookieSent, false);
  assert.deepEqual(result.requestCookieNames, ['__cf_bm', '_cfuvid']);
  assert.deepEqual(result.sentCookieNames, ['__cf_bm', '_cfuvid']);
  assert.equal(result.sessionKind, 'server_issued_anonymous');
  assert.deepEqual(result.sleeps, [5, 5]);
  assert.deepEqual(result.customerCookiesRetained, []);
  assert.equal(result.closeClearedCookies, true);
  assert.equal(run.stdout.includes('secret-one'), false);
  assert.equal(run.stdout.includes('secret-three'), false);
});

test('bootstrap 429 is returned once, preserves Retry-After and prevents a ranking follow-up', () => {
  const source = String.raw`
import importlib.util, json, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('oy_session', sys.argv[1]); m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m; spec.loader.exec_module(m)
class Jar(list):
 def clear(self,*args): del self[:]
class Cookies:
 def __init__(self): self.jar=Jar()
 def clear(self): self.jar.clear()
class Headers(dict):
 def get_list(self,name):
  v=self.get(name.lower(),[]); return v if isinstance(v,list) else ([v] if v else [])
class Response:
 def __init__(self): self.status_code=429; self.headers=Headers({'content-type':'text/html','retry-after':'30'}); self.request=SimpleNamespace(headers={}); self.closed=False
 def iter_content(self,chunk_size): yield b'limited'
 def close(self): self.closed=True
class Session:
 def __init__(self): self.cookies=Cookies(); self.calls=[]; self.closed=False
 def get(self,url,**kwargs): self.calls.append(url); return Response()
 def close(self): self.closed=True
s=Session(); w=m.AnonymousRankingWorker(session_factory=lambda:s)
w.handle({'op':'hello','protocolVersion':1})
r=w.handle({'op':'request','protocolVersion':1,'url':m.ORIGIN+m.RANKING_PATH,'timeoutMs':20000,'maxResponseBytes':8192,'minIntervalMs':5000})
blocked=None
try: w.handle({'op':'request','protocolVersion':1,'url':m.ORIGIN+m.RANKING_PATH,'timeoutMs':20000,'maxResponseBytes':8192,'minIntervalMs':5000})
except m.ProtocolError as e: blocked=e.code
out={'status':r['status'],'retryAfter':r['headers'].get('retry-after'),'phase':r['anonymousSessionReceipt']['phase'],
     'calls':len(s.calls),'blocked':blocked}
w.close(); out['closed']=s.closed
print(json.dumps(out,separators=(',',':')))
`;
  const run = spawnSync(PYTHON, ['-c', source, HELPER], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), {
    status: 429, retryAfter: '30', phase: 'bootstrap', calls: 1,
    blocked: 'RATE_LIMITED_UNTIL_CLOSE', closed: true,
  });
});

test('ranking 429 does not rebootstrap or retry and blocks future reads until close', () => {
  const source = String.raw`
import importlib.util,json,sys
from types import SimpleNamespace
from urllib.parse import urlsplit
spec=importlib.util.spec_from_file_location('oy_session',sys.argv[1]);m=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=m;spec.loader.exec_module(m)
class Cookie:
 def __init__(self,name): self.name=name;self.domain='www.oliveyoung.co.kr';self.path='/'
class Jar(list):
 def clear(self,*args):
  if not args: del self[:]
  else: d,p,n=args;self[:]=[c for c in self if (c.domain,c.path,c.name)!=(d,p,n)]
class Cookies:
 def __init__(self): self.jar=Jar()
 def clear(self): self.jar.clear()
class Headers(dict):
 def get_list(self,name):
  v=self.get(name.lower(),[]);return v if isinstance(v,list) else ([v] if v else [])
class Response:
 def __init__(self,status,body,cookies=(),retry=None):
  self.status_code=status;self.headers=Headers({'content-type':'text/html'})
  if cookies:self.headers['set-cookie']=list(cookies)
  if retry:self.headers['retry-after']=retry
  self.request=SimpleNamespace(headers={});self.body=body
 def iter_content(self,chunk_size):yield self.body
 def close(self):pass
class Session:
 def __init__(self):self.cookies=Cookies();self.calls=[];self.closed=False
 def get(self,url,headers,timeout,allow_redirects,verify,stream):
  path=urlsplit(url).path;self.calls.append(path)
  names=sorted(c.name for c in self.cookies.jar);cookie='; '.join(n+'=private' for n in names)
  if path==m.HOME_PATH:
   for n in ('OYSESSIONID','__cf_bm','_cfuvid'):self.cookies.jar.append(Cookie(n))
   return Response(200,b'home',('__cf_bm=value; Path=/','_cfuvid=value; Path=/'))
  self._anonymous_cookie_observer(2,('GET '+url+' HTTP/2\r\nCookie: '+cookie+'\r\n\r\n').encode())
  return Response(429,b'limited',retry='30')
 def close(self):self.closed=True
s=Session();clock=[0.0]
w=m.AnonymousRankingWorker(session_factory=lambda:s,sleep=lambda sec:clock.__setitem__(0,clock[0]+sec),monotonic=lambda:clock[0])
w.handle({'op':'hello','protocolVersion':1})
first=w.handle({'op':'request','protocolVersion':1,'url':m.ORIGIN+m.RANKING_PATH,'timeoutMs':20000,'maxResponseBytes':8192,'minIntervalMs':5000})
try:w.handle({'op':'request','protocolVersion':1,'url':m.ORIGIN+m.RANKING_PATH,'timeoutMs':20000,'maxResponseBytes':8192,'minIntervalMs':5000})
except m.ProtocolError as e:blocked=e.code;failure=e.receipt
out={'status':first['status'],'retryAfter':first['headers'].get('retry-after'),
 'firstPhase':first['anonymousSessionReceipt']['phase'],'calls':s.calls,
 'blocked':blocked,'failurePhase':failure['phase'],'failureRetryAfter':failure['retryAfter'],
 'failureRequestStatus':failure['request']['httpStatus']}
w.close();out['closed']=s.closed
print(json.dumps(out,separators=(',',':')))
`;
  const run = spawnSync(PYTHON, ['-c', source, HELPER], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), {
    status: 429, retryAfter: '30', firstPhase: 'ranking',
    calls: ['/store/main/main.do', '/store/main/getBestList.do'],
    blocked: 'RATE_LIMITED_UNTIL_CLOSE', failurePhase: 'ranking',
    failureRetryAfter: '30', failureRequestStatus: 429, closed: true,
  });
});

test('bootstrap/network failures report normalized phase metadata and leave unknown HTTP status null', () => {
  const source = String.raw`
import importlib.util,json,sys
from types import SimpleNamespace
from urllib.parse import urlsplit
spec=importlib.util.spec_from_file_location('oy_session',sys.argv[1]);m=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=m;spec.loader.exec_module(m)
class Jar(list):
 def clear(self,*args):
  if not args:del self[:]
  else:d,p,n=args;self[:]=[c for c in self if (c.domain,c.path,c.name)!=(d,p,n)]
class Cookies:
 def __init__(self):self.jar=Jar()
 def clear(self):self.jar.clear()
class Headers(dict):
 def get_list(self,name):
  v=self.get(name.lower(),[]);return v if isinstance(v,list) else ([v] if v else [])
class Cookie:
 def __init__(self,name):self.name=name;self.domain='www.oliveyoung.co.kr';self.path='/'
class Response:
 def __init__(self,body,cookies=()):
  self.status_code=200;self.headers=Headers({'content-type':'text/html'})
  if cookies:self.headers['set-cookie']=list(cookies)
  self.body=body;self.request=SimpleNamespace(headers={})
 def iter_content(self,chunk_size):yield self.body
 def close(self):pass
class Session:
 def __init__(self,scenario):self.cookies=Cookies();self.scenario=scenario;self.calls=[]
 def get(self,url,headers,timeout,allow_redirects,verify,stream):
  p=urlsplit(url).path;self.calls.append(p)
  if p==m.HOME_PATH and self.scenario=='network_home':raise OSError('secret transport detail')
  if p==m.HOME_PATH and self.scenario=='no_cf':return Response(b'home')
  if p==m.HOME_PATH:
   for n in ('__cf_bm','_cfuvid'):self.cookies.jar.append(Cookie(n))
   return Response(b'home',('__cf_bm=value; Path=/','_cfuvid=value; Path=/'))
  if self.scenario=='network_rank':
   names=sorted(c.name for c in self.cookies.jar);cookie='; '.join(n+'=private' for n in names)
   self._anonymous_cookie_observer(2,('GET '+url+' HTTP/2\r\nCookie: '+cookie+'\r\n\r\n').encode())
   raise OSError('secret transport detail')
  return Response(b'rank')
 def close(self):pass
def run(scenario):
 s=Session(scenario);w=m.AnonymousRankingWorker(session_factory=lambda:s,sleep=lambda _:None)
 w.handle({'op':'hello','protocolVersion':1})
 try:w.handle({'op':'request','protocolVersion':1,'url':m.ORIGIN+m.RANKING_PATH,'timeoutMs':20000,'maxResponseBytes':8192,'minIntervalMs':5000})
 except m.ProtocolError as e:return {'code':e.code,'receipt':e.receipt,'calls':s.calls}
 return {'code':'none'}
home=run('network_home');missing=run('no_cf');rank=run('network_rank')
print(json.dumps({'homeCode':home['code'],'homePhase':home['receipt']['phase'],
 'homePath':home['receipt']['bootstrapRequest']['path'],'homeStatus':home['receipt']['bootstrapRequest']['httpStatus'],
 'missingCode':missing['code'],'missingPhase':missing['receipt']['phase'],
 'missingStatus':missing['receipt']['bootstrapRequest']['httpStatus'],
 'rankCode':rank['code'],'rankPhase':rank['receipt']['phase'],
 'rankBootstrapStatus':rank['receipt']['bootstrapRequest']['httpStatus'],
 'rankRequestStatus':rank['receipt']['request']['httpStatus'],
 'rankRequestCookieSent':rank['receipt']['request']['cookieSent']},separators=(',',':')))
`;
  const run = spawnSync(PYTHON, ['-c', source, HELPER], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), {
    homeCode: 'NETWORK_FAILED', homePhase: 'bootstrap', homePath: '/store/main/main.do', homeStatus: null,
    missingCode: 'ANONYMOUS_COOKIE_UNAVAILABLE', missingPhase: 'bootstrap', missingStatus: 200,
    rankCode: 'NETWORK_FAILED', rankPhase: 'ranking', rankBootstrapStatus: 200,
    rankRequestStatus: null, rankRequestCookieSent: true,
  });
  assert.equal(run.stdout.includes('secret transport detail'), false);
});

test('response byte cap fails closed before ranking and closes the oversized response', () => {
  const source = String.raw`
import importlib.util, json, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('oy_session', sys.argv[1]); m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m; spec.loader.exec_module(m)
class Jar(list):
 def clear(self,*args): del self[:]
class Cookies:
 def __init__(self): self.jar=Jar()
 def clear(self): self.jar.clear()
class Headers(dict):
 def get_list(self,name):
  v=self.get(name.lower(),[]); return v if isinstance(v,list) else ([v] if v else [])
class Response:
 def __init__(self): self.status_code=200; self.headers=Headers({'content-type':'text/html'}); self.request=SimpleNamespace(headers={}); self.closed=False
 def iter_content(self,chunk_size): yield b'x'*4096
 def close(self): self.closed=True
class Session:
 def __init__(self): self.cookies=Cookies(); self.calls=[]; self.response=Response()
 def get(self,url,**kwargs): self.calls.append(url); return self.response
 def close(self): pass
s=Session(); w=m.AnonymousRankingWorker(session_factory=lambda:s); w.handle({'op':'hello','protocolVersion':1})
try: w.handle({'op':'request','protocolVersion':1,'url':m.ORIGIN+m.RANKING_PATH,'timeoutMs':20000,'maxResponseBytes':1024,'minIntervalMs':5000})
except m.ProtocolError as e: code=e.code
print(json.dumps({'code':code,'calls':len(s.calls),'responseClosed':s.response.closed},separators=(',',':')))
w.close()
`;
  const run = spawnSync(PYTHON, ['-c', source, HELPER], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { code: 'RESPONSE_TOO_LARGE', calls: 1, responseClosed: true });
});

test('worker spawn failure is bounded and `.close()` remains idempotent', async () => {
  const fetchImpl = createOliveyoungAnonymousRankingFetch({ pythonPath: '/missing/python', timeoutMs: 10_000 });
  const operation = fetchImpl(RANK_URL, {
    method: 'GET', redirect: 'manual', credentials: 'omit', headers: { accept: ACCEPT },
  });
  await assert.rejects(operation, { code: 'OLIVEYOUNG_ANONYMOUS_PYTHON_UNAVAILABLE' });
  await fetchImpl.close();
  await fetchImpl.close();
});
