import https from 'node:https';
// Article mutations are JSON strings. agent:false creates a new TLS socket for each request,
// rather than reusing the pool populated by the protected preflight reads.
export function freshHttpsFetch(raw,init={}){
 return new Promise((resolve,reject)=>{
  const url=new URL(raw);if(url.protocol!=='https:')return reject(new Error('HTTPS_REQUIRED'));
  const req=https.request(url,{method:init.method??'GET',headers:Object.fromEntries(new Headers(init.headers)),agent:false,signal:init.signal},res=>{
   const parts=[];let size=0;
   res.on('data',b=>{size+=b.length;if(size>5*1024*1024)req.destroy(new Error('RESPONSE_SIZE'));else parts.push(b);});
   res.on('end',()=>{const headers=new Headers();for(const [k,v] of Object.entries(res.headers)){for(const value of Array.isArray(v)?v:[v])if(value!=null)headers.append(k,value);}
    resolve(new Response(Buffer.concat(parts),{status:res.statusCode,headers}));});
   res.on('error',reject);
  });
  req.on('error',reject);req.end(init.body);
 });
}
