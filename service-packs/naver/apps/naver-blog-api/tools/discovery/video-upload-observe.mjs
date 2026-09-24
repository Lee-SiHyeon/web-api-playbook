import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
const base=path.resolve('runs/2026-09-24-video-publisher');await fs.mkdir(base,{recursive:true});
const {loadNaverCookies}=await import(new URL('../../scripts/session-vault.mjs',import.meta.url));
const saved=await loadNaverCookies({env:{}});let browser;
const events=[],pending=[],blocked=[];
try{
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:900},locale:'ko-KR'});
 await context.addCookies(saved.cookies.filter(c=>['NID_AUT','NID_SES'].includes(c.name)).map(c=>({name:c.name,value:c.value,domain:'.naver.com',path:'/',secure:true,httpOnly:true})));
 await context.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(!['GET','HEAD','OPTIONS'].includes(req.method())){blocked.push({method:req.method(),origin:u.origin,path:u.pathname});return route.abort();}return route.continue();});
 context.on('response',res=>{const u=new URL(res.url());if(/video|movie|vod|uploader/i.test(u.pathname))events.push({method:res.request().method(),origin:u.origin,path:u.pathname,status:res.status()});if(u.hostname==='editor-static.pstatic.net'&&u.pathname.endsWith('.js'))pending.push(res.body().then(b=>fs.writeFile(path.join(base,path.basename(u.pathname)),b)).catch(()=>{}));});
 const page=await context.newPage();page.setDefaultTimeout(15000);
 await page.goto('https://blog.naver.com/aicandoanything/postupdate?logNo=224421338326',{waitUntil:'domcontentloaded'});
 await page.locator('.se-canvas').waitFor();
 const observed=await page.locator('button').evaluateAll(bs=>bs.map((b,i)=>({i,text:b.innerText,title:b.title,name:b.getAttribute('data-name'),visible:!!b.getClientRects().length})));
 const candidates=observed.filter(b=>b.visible&&/\uB3D9\uC601\uC0C1|video/i.test(b.text+' '+b.title+' '+b.name));
 console.log(JSON.stringify({buttons:candidates}));
 if(candidates.length===1){await page.locator('button').nth(candidates[0].i).click();await page.waitForTimeout(1800);}
 const surfaces=[];
 for(const p of context.pages()){for(const f of p.frames()){surfaces.push({url:(()=>{try{const u=new URL(f.url());return u.origin+u.pathname}catch{return f.url()}})(),inputs:await f.locator('input').evaluateAll(ns=>ns.map(n=>({type:n.type,accept:n.accept,name:n.name,placeholder:n.placeholder}))).catch(()=>[]),text:(await f.locator('body').innerText().catch(()=>'' )).slice(-8000)});}}
 await page.screenshot({path:path.join(base,'video-panel.png')});
 await Promise.allSettled(pending);
 await fs.writeFile(path.join(base,'discovery-ui.json'),JSON.stringify({checkedAt:new Date().toISOString(),events,blocked,surfaces},null,2));
 console.log(JSON.stringify({events,blocked:blocked.length,surfaces}));
}finally{await browser?.close();for(const c of saved.cookies)c.value='';}