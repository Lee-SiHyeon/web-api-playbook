import {createHash} from 'node:crypto';
import {requestPartners} from './partners-transport.mjs';

export const operations={dashboard:{path:'/api/v1/dashboard',method:'GET'},search:{path:'/api/v1/search',method:'POST'},productLink:{path:'/api/v1/banner/iframe/url',method:'POST'}};

export async function requestPartnerOperation({operation,payload,evidenceOnly=true},{cookie=process.env.COUPANG_COOKIE,xToken=process.env.COUPANG_X_TOKEN,fetchImpl=globalThis.fetch,now=()=>new Date()}={}){
 const spec=operations[operation];if(!spec)throw Error('Unknown operation');
 if(!cookie||!xToken)throw Error('Current authorized cookie and x-token required');
 if(operation==='search'&&(!payload||typeof payload.filter!=='string'||!Number.isInteger(payload.page?.pageNumber)||payload.page.pageNumber<0||!Number.isInteger(payload.page?.size)||payload.page.size<1||payload.page.size>36||!Array.isArray(payload.deliveryTypes)))throw Error('Invalid captured search payload');
 if(operation==='productLink'&&(!payload?.product||typeof payload.product!=='object'))throw Error('Observed product payload required');
 const {response,raw}=await requestPartners(spec.path,{method:spec.method,cookie,xToken,body:spec.method==='POST'?payload:undefined,referer:'https://partners.coupang.com/',fetchImpl});
 if(response.status!==200||!response.headers.get('content-type')?.includes('json'))throw Error('Transport or authentication failure: HTTP '+response.status);
 const d=JSON.parse(raw);if(d.rCode!=='0'||!d.data)throw Error('Service rejected operation');
 if(operation==='search'&&(!Array.isArray(d.data.products)||typeof d.data.total!=='number'))throw Error('Search schema mismatch');
 if(operation==='dashboard'&&(!d.data.dailyTrend||!d.data.monthlyAggregation))throw Error('Dashboard schema mismatch');
 if(operation==='productLink'){const u=new URL(d.data.shortUrl);if(u.protocol!=='https:'||!['link.coupang.com','coupa.ng'].includes(u.hostname))throw Error('Unexpected affiliate link');}
 const evidence={operation,path:spec.path,httpStatus:response.status,applicationStatus:d.rCode,verified:true,checkedAt:now().toISOString(),responseHash:createHash('sha256').update(raw).digest('hex'),dataKeys:Object.keys(d.data),...(operation==='search'?{productCount:d.data.products.length}:{} )};
 return evidenceOnly?evidence:{...evidence,data:d.data};
}
