import json,re,urllib.request
from pathlib import Path
from urllib.parse import urljoin
ROOT = Path(__file__).resolve().parents[1]
capture=json.loads(sorted((ROOT/'evidence').glob('coupang-partners-browser-capture-*.json'), reverse=True)[0].read_text(encoding='utf-8'))
urls=sorted(set(r['origin']+r['path'] for r in capture.get('requests',[]) if r.get('origin')=='https://partners.coupang.com' and r.get('resourceType')=='Script' and r.get('path','').endswith('.js')))
patterns=[
 re.compile(r'["\'](#[A-Za-z0-9_./?=&%-]{2,160})["\']'),
 re.compile(r'["\'](/(?:affiliate|link|report|open-api|search|product|promotion|widget|subid|earning|performance|payout|settlement)[A-Za-z0-9_./?=&%${}-]{0,160})["\']',re.I),
]
routes=set(); sources={}
for url in urls:
 try:
  req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
  with urllib.request.urlopen(req,timeout=20) as resp: text=resp.read(8*1024*1024).decode('utf-8','replace')
 except Exception: continue
 for pat in patterns:
  for m in pat.finditer(text):
   value=m.group(1)
   if '/api/' in value: continue
   if len(value)>180 or '${' in value: continue
   routes.add(value); sources.setdefault(value,set()).add(url.rsplit('/',1)[-1])
record={'schemaVersion':1,'mode':'coupang_partners_frontend_route_candidates','sourceCapture':sorted((ROOT/'evidence').glob('coupang-partners-browser-capture-*.json'), reverse=True)[0].name,'candidateCount':len(routes),'candidates':[{'route':r,'sourceBundles':sorted(sources[r])} for r in sorted(routes)]}
out=ROOT/'references'/'coupang-partners-route-candidates.json';out.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'completed':True,'candidateCount':len(routes),'reference':str(out)},ensure_ascii=False))
for r in sorted(routes): print(r)
