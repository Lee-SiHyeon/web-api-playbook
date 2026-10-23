export function res(status,body,{setCookie=[]}={}){
  const buf=Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  return {status,ok:status>=200&&status<300,headers:{get:()=>'application/json',getSetCookie:()=>setCookie},
    body:(async function*(){yield buf;})(),text:async()=>buf.toString()};
}
export const profileHtml=handle=>`<html><script type="application/json">${JSON.stringify({x:[["LSD",[],{token:"lsdfixture"}],["SiteData",[],{server_revision:1,haste_session:"h",hsi:"1",__spin_r:1,__spin_b:"b",__spin_t:1}]],
  q:{queryName:"BarcelonaProfileThreadsTabDirectQuery",queryID:"123",variables:{userID:"42"}}})}</script></html>`;
export const post=(handle,code,pk,text,quoted)=>({pk,code,taken_at:1760000000,caption:{text},user:{username:handle},like_count:3,text_post_app_info:{direct_reply_count:1,repost_count:0},...(quoted?{quoted}:{})});
