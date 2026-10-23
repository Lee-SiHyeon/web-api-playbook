import { loadWebAuth } from '../adapters/web-auth-provider.mjs';
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
async function stdinJson(limit) {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > limit) throw Error('WEB_AUTH_INPUT_TOO_LARGE'); }
  try { return JSON.parse(raw); } catch { throw Error('WEB_AUTH_INPUT_INVALID'); }
}
try {
  const [service,command='status',arg]=process.argv.slice(2);
  const auth=await loadWebAuth(service);
  const alias = command==='add-site'?'addSite':command;
  const customCps=service==='linkprice'&&alias==='cps';
  if(!['status','ensure','health','refresh','renew','dashboard','sites','merchants','cps','subscriptions','link','apply','addSite','search'].includes(alias)||alias==='search'&&service!=='coupang'||(!customCps&&typeof auth[alias]!=='function'))throw Error('WEB_AUTH_COMMAND_INVALID');
  // LinkPrice reads accept stdin JSON. `cps` joins the whole active CPS catalog with
  // optional per-site statuses; `subscriptions` is chunked to the service's 50-ID limit.
  const raw=['cps','subscriptions','link','apply','add-site','search'].includes(command)?await stdinJson(64*1024):undefined;
  const input=command==='merchants'?{kind:arg||'cps'}:command==='subscriptions'?raw.merchantIds:raw;
  const options=command==='subscriptions'&&raw.affiliateId?{affiliateId:raw.affiliateId}:undefined;
  let result;
  if(service==='linkprice'&&command==='cps') {
    const kind=raw.kind??'cps';
    if(kind!=='cps') throw Error('MERCHANT_KIND_INVALID');
    const catalog=await auth.merchants({kind});
    const merchants=catalog.merchants;
    const ids=merchants.map(m=>m.merchant_id);
    if(ids.some(id=>typeof id!=='string')) throw Error('MERCHANTS_SCHEMA_INVALID');
    const subscriptionReceipts=[];
    let subscriptions=[];
    if(raw.affiliateId!=null) {
      if(!Array.isArray(ids)||ids.length>500) throw Error('SUBSCRIPTION_INPUT_INVALID');
      for(const batch of chunks(ids,50)) {
        const page=await auth.subscriptions(batch,{affiliateId:raw.affiliateId});
        subscriptions.push(...page.subscriptions);
        if(page.receipt) subscriptionReceipts.push(page.receipt);
      }
      const byMerchant=new Map(subscriptions.map(s=>[s.merchantId,s]));
      result={kind,count:merchants.length,affiliateId:raw.affiliateId,
        merchants:merchants.map(m=>{const s=byMerchant.get(m.merchant_id);return {...m,...(s?{subscriptionStatus:s.status,linkable:s.linkable}:{})};}),
        receipt:{operation:'cps_catalog_with_subscriptions',browserUsed:false,catalog:catalog.receipt,subscriptionBatches:subscriptionReceipts}};
    } else {
      result={kind,count:merchants.length,merchants,receipt:{...catalog.receipt,operation:'cps_catalog',browserUsed:false}};
    }
  } else if(service==='linkprice'&&command==='subscriptions') {
    const ids=input;
    if(!Array.isArray(ids)||!ids.length||ids.length>500) throw Error('SUBSCRIPTION_INPUT_INVALID');
    const pages=[];
    for(const batch of chunks(ids,50)) pages.push(await auth.subscriptions(batch,options));
    result={affiliateId:pages[0].affiliateId,subscriptions:pages.flatMap(page=>page.subscriptions),
      receipt:{operation:'subscriptions',browserUsed:false,batches:pages.map(page=>page.receipt).filter(Boolean)}};
  } else {
    result=await auth[alias](input,options);
  }
  console.log(JSON.stringify({ok:true,service,command,...result}));
}catch(e){console.log(JSON.stringify({ok:false,code:/^[A-Z][A-Z_]+$/.test(e.code||e.message||'')?(e.code||e.message):'WEB_AUTH_FAILED',...(e.receipt?{receipt:e.receipt}:{})}));process.exitCode=2;}
