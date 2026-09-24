import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
const dir='runs/2026-09-24-video-publisher';
const {loadNaverCookies}=await import(new URL('../../scripts/session-vault.mjs',import.meta.url));
const saved=await loadNaverCookies({env:{}});let browser;const captured=[],blocked=[];let injected=0;
try{
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1280,height:900},locale:'ko-KR'});
 await context.addCookies(saved.cookies.filter(c=>['NID_AUT','NID_SES'].includes(c.name)).map(c=>({name:c.name,value:c.value,domain:'.naver.com',path:'/',secure:true,httpOnly:true})));
 await context.route('**/*',async route=>{
  const q=route.request(),u=new URL(q.url());
  if(!['GET','HEAD','OPTIONS'].includes(q.method())){
   if(u.hostname==='blog.naver.com'){
    try{const f=new URLSearchParams(q.postData()||'');const m=JSON.parse(f.get('documentModel')||'null');
     if(m)captured.push({endpoint:u.pathname,videoComponents:m.document.components.filter(c=>c['@ctype']==='video'),mediaResources:JSON.parse(f.get('mediaResources')||'null')});}catch{}
   }
   blocked.push({method:q.method(),origin:u.origin,path:u.pathname});return route.abort();
  }
  if(u.origin==='https://blog.naver.com'&&u.pathname==='/PostWriteFormSeOptions.naver'){
   const res=await route.fetch(),data=await res.json(),model=JSON.parse(data.result.documentModel);
   const video={'@ctype':'video',id:'SE-'+randomUUID(),layout:'default',vid:'7D4AADB1528D017E2BC3338657EE98C82B52',
    fileSize:15700,playTime:4.508999824523926,internalResource:true,width:320,height:180,originalWidth:320,originalHeight:180,
    format:'normal',thumbnail:{'@ctype':'thumbnail',src:'https://phinf.pstatic.net/image.nmv/blog_2026_09_24_3689/tMVyOawpUE_01.jpg',alt:''},
    mediaMeta:{'@ctype':'mediaMeta',title:'Publisher completion contract check',description:'',tags:[]},ai:false,origin:{'@ctype':'videoOrigin',srcFrom:'local'},represent:false,caption:[]};
   model.document.components=[model.document.components[0],video];data.result.documentModel=JSON.stringify(model);injected++;
   return route.fulfill({response:res,json:data});
  }
  return route.continue();
 });
 const page=await context.newPage();await page.goto('https://blog.naver.com/aicandoanything/postupdate?logNo=224421338326',{waitUntil:'domcontentloaded'});
 await page.locator('.se-video').waitFor();const close=page.getByText('\uB2EB\uAE30',{exact:true});try{await close.first().waitFor({state:'visible',timeout:5000});await close.first().click()}catch(e){if(e.name!=='TimeoutError')throw e;}await page.locator('.se-video').scrollIntoViewIfNeeded();await page.waitForTimeout(1000);await fs.writeFile(dir+'/native-video-dom.html',await page.locator('.se-video').evaluate(e=>e.outerHTML));
 console.log(JSON.stringify({injected,videoCount:await page.locator('.se-video').count(),buttons:await page.locator('button').evaluateAll(bs=>bs.filter(b=>/\uc800\uc7a5|\ubc1c\ud589/.test(b.innerText)).map(b=>({text:b.innerText,cls:b.className})))}));
 const save=page.locator('button').filter({hasText:/^\uC800\uC7A5/});if(await save.count())await save.first().click();else {await page.locator('button[class^="publish_btn"]').click();console.log(JSON.stringify({publishButtons:await page.locator('button').evaluateAll(bs=>bs.filter(b=>/\uBC1C\uD589|\uD655\uC778/.test(b.innerText)).map(b=>({text:b.innerText,cls:b.className})))}));const final=page.locator('button[class*="confirm_btn"]');if(await final.count())await final.click();}
 await page.waitForTimeout(1800);await page.screenshot({path:dir+'/video-native-contract.png'});
 await fs.writeFile(dir+'/native-video-contract.json',JSON.stringify({checkedAt:new Date().toISOString(),injected,captured,blocked,postWrites:0},null,2));
 console.log(JSON.stringify({captured,postWrites:0}));
}finally{await browser?.close();for(const c of saved.cookies)c.value='';}
