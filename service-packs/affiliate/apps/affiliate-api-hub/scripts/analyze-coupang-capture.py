import json, re, hashlib, urllib.request
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'evidence'
REFERENCES = ROOT / 'references'
MAX_BYTES = 8 * 1024 * 1024

def classify(path):
    v = path.lower()
    rules = [
        ('catalog', r'product|search|item|catalog'),
        ('link_generation', r'link|deeplink|shorten|tracking'),
        ('reporting_or_earnings', r'report|earning|commission|revenue|performance|conversion|order|transaction'),
        ('sub_id', r'sub-?id|subid'),
        ('campaign_or_creative', r'campaign|promotion|banner|widget'),
        ('payout_or_settlement', r'payment|payout|settlement|tax|invoice'),
        ('notification', r'notification|notice|popup'),
        ('verification_or_compliance', r'affiliate-rnv|verification|kmc|compliance|policy'),
        ('configuration', r'config|configuration|region'),
        ('dashboard', r'dashboard'),
        ('account', r'member|profile|account|user'),
    ]
    for name, pattern in rules:
        if re.search(pattern, v): return name
    return 'unclassified'

def safe_url(raw):
    from urllib.parse import urljoin, urlsplit, parse_qsl
    try:
        u = urlsplit(urljoin('https://partners.coupang.com', raw))
        if u.scheme != 'https' or u.netloc != 'partners.coupang.com': return None
        return {'origin': f'{u.scheme}://{u.netloc}', 'path': u.path, 'queryFields': sorted(set(k for k, _ in parse_qsl(u.query, keep_blank_values=True) if re.fullmatch(r'[A-Za-z_$][\w$.-]{0,100}', k)))}
    except Exception:
        return None

def method_hint(context):
    for method, pattern in [
        ('DELETE', r'\.delete\s*\(|method\s*[:=]\s*["\']DELETE["\']'),
        ('PATCH', r'\.patch\s*\(|method\s*[:=]\s*["\']PATCH["\']'),
        ('PUT', r'\.put\s*\(|method\s*[:=]\s*["\']PUT["\']'),
        ('POST', r'\.post\s*\(|method\s*[:=]\s*["\']POST["\']'),
        ('GET', r'\.get\s*\(|method\s*[:=]\s*["\']GET["\']')]:
        if re.search(pattern, context, re.I): return method
    return None

def field_hints(context):
    fields = set(re.findall(r'(?:^|[{,])\s*([A-Za-z_$][\w$.-]{0,100})\s*:', context))
    fields.update(re.findall(r'[?&]([A-Za-z_$][\w$.-]{0,100})=', context))
    return sorted(fields)[:100]

def extract(source, script_url):
    rows = []
    pattern = re.compile(r'["\'`]((?:https://partners\.coupang\.com)?/api/v\d+/[A-Za-z0-9_./?=&%{}:$-]+)["\'`]')
    for match in pattern.finditer(source):
        safe = safe_url(match.group(1))
        if not safe: continue
        context = source[max(0, match.start()-500):min(len(source), match.end()+500)]
        rows.append({**safe, 'methodHint': method_hint(context), 'fieldNameHints': field_hints(context), 'capability': classify(safe['path']), 'sourceScript': script_url, 'executable': False, 'valuesObserved': False, 'confidence': 'public_bundle_literal'})
    return rows

def merge(rows):
    out = {}
    for row in rows:
        key = (row['origin'], row['path'], row.get('methodHint'), tuple(row['queryFields']))
        if key not in out:
            item = dict(row); item['sourceScripts'] = [item.pop('sourceScript')]; out[key] = item
        else:
            item = out[key]
            item['fieldNameHints'] = sorted(set(item['fieldNameHints']) | set(row['fieldNameHints']))
            item['sourceScripts'] = sorted(set(item['sourceScripts']) | {row['sourceScript']})
    return sorted(out.values(), key=lambda x: (x['capability'], x['path']))

captures = sorted(EVIDENCE.glob('coupang-partners-browser-capture-*.json'), reverse=True)
if not captures: raise SystemExit('no_capture')
capture_path = captures[0]
capture = json.loads(capture_path.read_text(encoding='utf-8'))
observed = []
for row in capture.get('requests', []):
    if row.get('origin') == 'https://partners.coupang.com' and row.get('method') == 'GET' and re.match(r'^/api/v\d+/', row.get('path', '')):
        observed.append({'origin': row['origin'], 'path': row['path'], 'method': 'GET', 'queryFields': row.get('queryFields', []), 'bodyFieldNames': [], 'capability': classify(row['path']), 'httpStatus': row.get('httpStatus'), 'mimeType': row.get('mimeType'), 'source': f'{capture_path.name}:browser_network', 'confidence': 'authenticated_browser_observed', 'executable': False, 'valuesObserved': False})
script_urls = sorted(set(row['origin'] + row['path'] for row in capture.get('requests', []) if row.get('origin') == 'https://partners.coupang.com' and row.get('method') == 'GET' and row.get('resourceType') == 'Script' and re.match(r'^/static/js/.*\.js$', row.get('path', ''))))
analyses, candidates, failures = [], [], []
for url in script_urls:
    try:
        req = urllib.request.Request(url, headers={'Accept':'application/javascript,text/javascript,*/*;q=0.1','User-Agent':'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES: raise ValueError('script_too_large')
        text = data.decode('utf-8', errors='replace')
        found = extract(text, url)
        candidates.extend(found)
        analyses.append({'url': url, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'candidateCount': len(found)})
    except Exception as exc:
        failures.append({'url': url, 'error': type(exc).__name__})
record = {'schemaVersion':1,'checkedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),'mode':'coupang_partners_authenticated_metadata_and_public_bundle_analysis','sourceCapture':capture_path.name,'observedAuthenticatedGetCount':len(observed),'publicScriptsAttempted':len(script_urls),'publicScriptsAnalyzed':len(analyses),'publicScriptFailures':len(failures),'candidateCount':len(merge(candidates)),'mutationRequestsSent':0,'cookieValuesCaptured':False,'headerValuesCaptured':False,'responseBodiesCaptured':False,'observedGets':observed,'scriptAnalyses':analyses,'candidates':merge(candidates),'failures':failures}
REFERENCES.mkdir(parents=True, exist_ok=True)
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
evidence_name = f'coupang-partners-api-analysis-{stamp}.json'
text = json.dumps(record, ensure_ascii=False, indent=2) + '\n'
(EVIDENCE / evidence_name).write_text(text, encoding='utf-8')
(REFERENCES / 'coupang-partners-observed-api.json').write_text(text, encoding='utf-8')
print(json.dumps({'completed':True,'sourceCapture':capture_path.name,'observedAuthenticatedGetCount':len(observed),'publicScriptsAnalyzed':len(analyses),'candidateCount':record['candidateCount'],'evidenceFile':evidence_name,'mutationRequestsSent':0}, ensure_ascii=False))
