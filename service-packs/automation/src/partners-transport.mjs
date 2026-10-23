const ORIGIN='https://partners.coupang.com';

// Shared transport for the observed Partners endpoints. Credentials are request-only values.
export async function requestPartners(path,{method='GET',cookie,xToken,body,referer,fetchImpl=globalThis.fetch}={}){
 if(typeof path!=='string'||!path.startsWith('/api/v1/'))throw Error('Unsupported Partners path');
 const headers={cookie,'x-token':xToken,lang:'ko',accept:'application/json','content-type':'application/json'};
 if(referer)headers.referer=referer;
 const response=await fetchImpl(ORIGIN+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(20000)});
 return {response,raw:await response.text()};
}

export {ORIGIN as PARTNERS_ORIGIN};
