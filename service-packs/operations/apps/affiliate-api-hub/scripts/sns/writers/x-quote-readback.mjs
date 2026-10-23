export function quoteTargetId(value) {
 try{
  const u=new URL(value);
  if(!['https://x.com','https://twitter.com'].includes(u.origin)||u.username||u.password||u.search||u.hash)return null;
  return u.pathname.match(/^\/[A-Za-z0-9_]{1,15}\/status\/([0-9]{1,25})$/)?.[1]||null;
 }catch{return null;}
}
export function quoteTextMatches(item,text,quoteUrl) {
 const expectedId=quoteTargetId(quoteUrl);
 if(!expectedId||item?.quotedPostId!==expectedId||item.parentId||typeof item.text!=='string')return false;
 if(item.text===text)return true;
 if(!item.text.startsWith(text))return false;
 const tail=item.text.slice(text.length);
 return /^\s+https?:\/\/\S+$/.test(tail)&&quoteTargetId(tail.trim())===expectedId;
}
