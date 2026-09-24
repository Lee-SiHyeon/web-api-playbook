import json, re
from collections import Counter, defaultdict
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
REF = ROOT / 'references' / 'coupang-partners-observed-api.json'
EVIDENCE = ROOT / 'evidence'
DOCS = ROOT / 'docs'

data = json.loads(REF.read_text(encoding='utf-8'))

priority_rules = [
    ('P0', re.compile(r'^/api/v1/(?:search(?:/|$)|url/|discovery/|open-api(?:/|$)|report/(?:daily|monthly|payout|settlement)|earning/summary|performance/summary|subId(?:/|$))')),
    ('P1', re.compile(r'^/api/v1/(?:banner/|widgets/|downloads/async/reports/|configuration/content/|dashboard|earning/notification|notification/|home-banners)')),
    ('P2', re.compile(r'^/api/v1/(?:payment|company-invoice|labor-report|verification|kmc|affiliate|agency|penalty|referral)')),
]

def priority(path):
    for p, pattern in priority_rules:
        if pattern.search(path): return p
    return 'P3'

def family(path):
    if re.search(r'^/api/v1/search', path): return 'catalog_search'
    if re.search(r'^/api/v1/discovery/', path): return 'product_discovery'
    if re.search(r'^/api/v1/url/', path): return 'link_generation'
    if re.search(r'^/api/v1/(banner|widgets)/', path): return 'creative_widget'
    if re.search(r'^/api/v1/open-api', path): return 'open_api_access'
    if re.search(r'^/api/v1/(report|earning|performance|downloads/async/reports)', path): return 'reporting_earnings'
    if re.search(r'^/api/v1/subId', path): return 'sub_id'
    if re.search(r'^/api/v1/(payment|company-invoice|labor-report)', path): return 'payout_settlement'
    if re.search(r'^/api/v1/(verification|kmc)', path): return 'verification_compliance'
    if re.search(r'^/api/v1/(notification|configuration/content|home-banners)', path): return 'notifications_content'
    if re.search(r'^/api/v1/(affiliate|agency|penalty|referral)', path): return 'account_agency'
    if re.search(r'^/api/v1/(config|region|wdpop/config|dashboard)', path): return 'configuration_dashboard'
    return 'other'

observed_map = {(x['path'], x.get('method')): x for x in data.get('observedGets', [])}
rows = []
for item in data.get('candidates', []):
    path = item['path']
    if '${' in path or path.startswith('/api/v1/${'):
        dynamic = True
    else:
        dynamic = False
    method = item.get('methodHint')
    observed = (path, method) in observed_map or (path, 'GET') in observed_map
    row = {
        'path': path,
        'methodHint': method,
        'queryFields': item.get('queryFields', []),
        'fieldNameHints': item.get('fieldNameHints', []),
        'family': family(path),
        'priority': priority(path),
        'authenticatedObserved': bool(observed),
        'dynamicPathTemplate': dynamic,
        'confidence': 'authenticated_observed' if observed else item.get('confidence', 'public_bundle_literal'),
        'executable': False,
        'valuesObserved': False,
    }
    rows.append(row)

for item in data.get('observedGets', []):
    if not any(x['path'] == item['path'] and x.get('methodHint') == 'GET' for x in rows):
        rows.append({
            'path': item['path'], 'methodHint': 'GET', 'queryFields': item.get('queryFields', []),
            'fieldNameHints': [], 'family': family(item['path']), 'priority': priority(item['path']),
            'authenticatedObserved': True, 'dynamicPathTemplate': False,
            'confidence': 'authenticated_observed', 'executable': False, 'valuesObserved': False,
        })

# Merge exact contracts, preserving only field-name metadata.
merged = {}
for row in rows:
    key = (row['path'], row.get('methodHint'), tuple(row.get('queryFields', [])))
    if key not in merged:
        merged[key] = row
    else:
        prior = merged[key]
        prior['fieldNameHints'] = sorted(set(prior['fieldNameHints']) | set(row['fieldNameHints']))
        prior['authenticatedObserved'] = prior['authenticatedObserved'] or row['authenticatedObserved']
        if prior['authenticatedObserved']:
            prior['confidence'] = 'authenticated_observed'

curated = sorted(merged.values(), key=lambda x: (x['priority'], x['family'], x['path'], x.get('methodHint') or ''))
# Hide high-risk identity/payment fields from the main implementation shortlist, but retain metadata in full catalog.
implementation = [x for x in curated if x['priority'] in {'P0','P1'} and x['family'] not in {'payout_settlement','verification_compliance','account_agency'}]

by_family = Counter(x['family'] for x in curated)
by_priority = Counter(x['priority'] for x in curated)
method_counts = Counter(x.get('methodHint') or 'UNKNOWN' for x in curated)

record = {
    'schemaVersion': 1,
    'checkedAt': datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
    'mode': 'coupang_partners_api_candidate_curation',
    'sourceReference': REF.name,
    'observedAuthenticatedGetCount': len(data.get('observedGets', [])),
    'rawCandidateCount': len(data.get('candidates', [])),
    'curatedContractCount': len(curated),
    'implementationShortlistCount': len(implementation),
    'countsByPriority': dict(sorted(by_priority.items())),
    'countsByFamily': dict(sorted(by_family.items())),
    'countsByMethodHint': dict(sorted(method_counts.items())),
    'mutationRequestsSent': 0,
    'cookieValuesCaptured': False,
    'headerValuesCaptured': False,
    'responseBodiesCaptured': False,
    'contracts': curated,
    'implementationShortlist': implementation,
}

REF_OUT = ROOT / 'references' / 'coupang-partners-curated-api.json'
REF_OUT.write_text(json.dumps(record, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
(EVIDENCE / f'coupang-partners-api-curation-{stamp}.json').write_text(json.dumps(record, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

# Human-readable concise report.
DOCS.mkdir(parents=True, exist_ok=True)
lines = [
    '# 쿠팡 파트너스 API 탐색 결과 — 2026-09-19', '',
    '## 세션과 안전 경계', '',
    '- 기존 Stable Chrome의 로그인된 쿠팡 파트너스 탭을 제자리에서 재사용했다.',
    '- 쿠키·세션 토큰·인증 헤더 값은 추출하거나 파일에 저장하지 않았다.',
    '- 브라우저 캡처 중 GET/HEAD/OPTIONS만 허용했고 POST/PUT/PATCH/DELETE는 전송 전에 차단했다.',
    '- 응답 본문과 요청 값은 저장하지 않았고, 경로·메서드·필드 이름·상태 코드만 기록했다.',
    '', '## 수집량', '',
    f'- 로그인 세션에서 실제 HTTP 200으로 관측한 GET API: {len(data.get("observedGets", []))}개',
    f'- 공개 JS 번들 분석: {data.get("publicScriptsAnalyzed", 0)}개',
    f'- 원시 문자열 후보: {len(data.get("candidates", []))}개',
    f'- 정규화 계약: {len(curated)}개',
    f'- 1차 구현 후보(P0/P1): {len(implementation)}개',
    '', '## P0 구현 후보', '',
]
for x in implementation:
    if x['priority'] != 'P0': continue
    fields = ', '.join((x.get('queryFields') or []) + (x.get('fieldNameHints') or [])[:12]) or '-'
    lines.append(f'- `{x.get("methodHint") or "?"} {x["path"]}` — `{x["family"]}` — 필드: {fields}')
lines += ['', '## P1 구현 후보', '']
for x in implementation:
    if x['priority'] != 'P1': continue
    fields = ', '.join((x.get('queryFields') or []) + (x.get('fieldNameHints') or [])[:10]) or '-'
    lines.append(f'- `{x.get("methodHint") or "?"} {x["path"]}` — `{x["family"]}` — 필드: {fields}')
lines += ['', '## 아직 실행하지 않은 것', '',
          '- 상품 검색 POST, 링크 생성 POST, 리포트 POST 등 쓰기 메서드 힌트가 있는 내부 요청은 실제로 보내지 않았다.',
          '- Open API 키 발급·갱신·폐기, 정산 정보 변경, 계정 정보 변경은 실행하지 않았다.',
          '- 공개 번들의 메서드 힌트는 후보이며, 실제 계약은 각 화면에서 값 없는 테스트 또는 공식 Open API 문서와 대조해야 한다.', '']
(DOCS / 'coupang-partners-api-discovery-2026-09-19.md').write_text('\n'.join(lines), encoding='utf-8')

print(json.dumps({
    'completed': True,
    'curatedContractCount': len(curated),
    'implementationShortlistCount': len(implementation),
    'countsByPriority': dict(sorted(by_priority.items())),
    'countsByFamily': dict(sorted(by_family.items())),
    'reference': str(REF_OUT),
    'doc': str(DOCS / 'coupang-partners-api-discovery-2026-09-19.md'),
    'mutationRequestsSent': 0,
}, ensure_ascii=False))
