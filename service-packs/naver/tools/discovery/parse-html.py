import sys,json,re
from html.parser import HTMLParser
from urllib.parse import urljoin,urlsplit
data=json.load(sys.stdin)
base=data['url']
class Parser(HTMLParser):
 def __init__(self):
  super().__init__(convert_charrefs=True);self.links=[];self.scripts=[];self.frames=[];self.forms=[];self.fields=[];self.inline=[];self.in_script=False
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if tag in ('a','link') and a.get('href'):self.links.append({'url':urljoin(base,a['href']) if not a['href'].lower().startswith('javascript:') else a['href'],'kind':tag})
  if tag in ('iframe','frame') and a.get('src'):self.frames.append(urljoin(base,a['src']))
  if tag=='script':
   self.in_script=True
   if a.get('src'):self.scripts.append(urljoin(base,a['src']))
  if tag=='form':self.forms.append({'method':a.get('method','GET').upper(),'action':urljoin(base,a.get('action',''))})
  if tag in ('input','select','textarea'):
   f={'name':a.get('name'),'id':a.get('id'),'type':a.get('type',tag)}
   key=a.get('name') or a.get('id')
   if key in ('startDate','timeDimension','hour','size','deviceType','exclude','_') and a.get('value') is not None:f['observedValue']=a['value']
   self.fields.append(f)
 def handle_endtag(self,tag):
  if tag=='script':self.in_script=False
 def handle_data(self,text):
  if self.in_script:self.inline.append(text)
p=Parser();p.feed(data['body'])
sources='\n'.join(p.inline)
api_candidates=sorted(set(re.findall(r'''["']((?:https://blog\.stat\.naver\.com)?/api/blog/[A-Za-z0-9_./-]+)["']''',sources)))
defaults={}
for key in ('startDate','timeDimension','hour','size','deviceType','exclude'):
 matches=re.findall(r'''(?:\b|["'])'''+key+r'''["']?\s*[:=]\s*(["'])(.*?)\1''',sources,re.S)
 vals=[v for q,v in matches if len(v)<100 and '\n' not in v]
 if vals:defaults[key]=list(dict.fromkeys(vals))
print(json.dumps({'links':p.links,'frames':p.frames,'scripts':p.scripts,'forms':p.forms,'fields':p.fields,'apiCandidates':api_candidates,'literalDefaults':defaults},ensure_ascii=False))
