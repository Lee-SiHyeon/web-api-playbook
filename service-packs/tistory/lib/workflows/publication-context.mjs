// Ported from affiliate-content-automation/src/tistory-publication-context.mjs (2026-10-14) into the playbook Tistory pack.
// Journal-first writes, no automatic retry of a business write, explicit ledger status states.
// Read editor bootstrap data without evaluating its scripts or publishing.
export function parsePublicationContext(html){
 const blogLine=html.match(/^\s*blog:\s*(\{[^\r\n]*\}),?\s*$/m);
 const captcha=html.match(/\bneedCaptcha:\s*(true|false)\b/);
 if(!blogLine||!captcha)throw Error('Editor bootstrap shape changed');
 const blog=JSON.parse(blogLine[1]);
 if(!Array.isArray(blog.categories)||!Number.isInteger(blog.visibility))throw Error('Blog settings schema mismatch');
 const allowed=['visibilityType','visibility','uselessMargin','cclCommercial','cclDerive'];
 const postLine=html.match(/^\s*post:\s*(\{[^\r\n]*\}|null),?\s*$/m);
 const post=postLine?JSON.parse(postLine[1]):null;
 const postFields=['id','visibility','category','acceptComment','published','cclCommercial','cclDerive'];
 return {settings:Object.fromEntries(allowed.filter(k=>Object.hasOwn(blog,k)).map(k=>[k,blog[k]])),needCaptcha:captcha[1]==='true',
  initialPost:post?Object.fromEntries(postFields.filter(k=>Object.hasOwn(post,k)).map(k=>[k,post[k]])):null,
  categories:blog.categories.map(c=>({id:c.id,name:c.name,visibility:c.visibility})),
  state:'bootstrap-observed-not-publication-verified',
  limitations:['HTML bootstrap read, not an XHR contract','No scripts evaluated','Visibility semantics and final request values require separate verification','A later publication request can still require a challenge']};
}
