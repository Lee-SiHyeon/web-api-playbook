import {createHash} from 'node:crypto';
const idOK=s=>typeof s==='string'&&/^[a-z0-9]{1,12}$/.test(s);
export class RedditError extends Error {constructor(code,receipt={}){super(code);this.code=code;this.receipt=receipt;}}
const listing=x=>{if(x?.kind!=='Listing'||!Array.isArray(x.data?.children))throw new RedditError('SCHEMA');return x.data;};
const canonical=p=>typeof p==='string'&&p.startsWith('/')&&!p.startsWith('//')?new URL(p,'https://www.reddit.com').href:null;
const record=d=>({id:d.id,author:d.author??null,text:d.body??d.selftext??'',title:d.title??null,url:canonical(d.permalink),createdAt:Number.isFinite(d.created_utc)?new Date(d.created_utc*1000).toISOString():null,score:Number.isFinite(d.score)?d.score:null,parentId:d.parent_id??null,subreddit:d.subreddit??null});
export function decodeComments(data,postId){
  if(!Array.isArray(data)||data.length!==2)throw new RedditError('SCHEMA');
  const post=listing(data[0]).children.find(c=>c.kind==='t3'&&c.data.id===postId);if(!post)throw new RedditError('POST_MISMATCH');
  const comments=new Map(),more=[];let removed=0,visited=0;
  function walk(value,depth=0){if(depth>100)throw new RedditError('DEPTH_LIMIT');for(const c of listing(value).children){if(++visited>10000)throw new RedditError('ITEM_LIMIT');const d=c.data??{};if(c.kind==='more'){more.push({parentId:d.parent_id??null,count:d.count??null});continue;}if(c.kind!=='t1'||!idOK(d.id))continue;if(['[removed]','[deleted]'].includes(d.body))removed++;else comments.set(d.id,record(d));if(d.replies&&typeof d.replies==='object')walk(d.replies,depth+1);}}
  walk(data[1]);return {post:record(post.data),comments:[...comments.values()],unexpanded:more,removed,complete:false,representative:false};
}
export class RedditClient {
  constructor({accessToken,userAgent,fetchImpl=fetch}){
    if(typeof accessToken!=='string'||!accessToken||accessToken.length>4096||!/^[\x21-\x7e]+$/.test(accessToken))throw new RedditError('OAUTH_REQUIRED');
    if(typeof userAgent!=='string'||userAgent.length<10||userAgent.length>256||/[\r\n]/.test(userAgent))throw new RedditError('USER_AGENT_REQUIRED');
    this.headers={authorization:`Bearer ${accessToken}`,'user-agent':userAgent};this.fetch=fetchImpl;
  }
  close(){this.headers=null;}
  async request(route,params){
    if(!this.headers)throw new RedditError('CLOSED');
    if(route!=='/search'&&!/^\/comments\/[a-z0-9]{1,12}$/.test(route))throw new RedditError('ROUTE_DENIED');
    const u=new URL(route,'https://oauth.reddit.com');for(const [k,v]of Object.entries({...params,raw_json:1}))u.searchParams.set(k,String(v));
    let res,bytes;try{res=await this.fetch(u,{headers:this.headers,redirect:'error',signal:AbortSignal.timeout(20000)});const chunks=[];let size=0;for await(const c of res.body){size+=c.length;if(size>4000000)throw Error();chunks.push(c);}bytes=Buffer.concat(chunks);}catch{throw new RedditError('TRANSPORT');}
    const receipt={method:'GET',url:u.href,status:res.status,checkedAt:new Date().toISOString(),sha256:createHash('sha256').update(bytes).digest('hex'),mode:'pure_http'};
    if(!res.ok)throw new RedditError(res.status===429?'RATE_LIMITED':[401,403].includes(res.status)?'ACCESS_BLOCKED':'HTTP_ERROR',receipt);
    if(!res.headers.get('content-type')?.includes('json'))throw new RedditError('NOT_JSON',receipt);
    let data;try{data=JSON.parse(bytes);}catch{throw new RedditError('NOT_JSON',receipt);}return {data,receipt};
  }
  async search(query,{after,limit=25}={}){
    if(typeof query!=='string'||!query.trim()||query.length>256||!Number.isInteger(limit)||limit<1||limit>100||after!==undefined&&!/^t3_[a-z0-9]+$/.test(after))throw new RedditError('INPUT');
    const {data,receipt}=await this.request('/search',{q:query,type:'link',sort:'new',t:'week',limit,...after?{after}:{}}),page=listing(data);
    return {posts:page.children.filter(c=>c.kind==='t3').map(c=>record(c.data)),after:page.after??null,receipt,complete:false};
  }
  async comments(postId,{limit=100}={}){if(!idOK(postId)||!Number.isInteger(limit)||limit<1||limit>100)throw new RedditError('INPUT');const {data,receipt}=await this.request(`/comments/${postId}`,{sort:'top',limit});return {...decodeComments(data,postId),receipt};}
}
