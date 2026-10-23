import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { editorPresentationFingerprint } from '../api/editor-model.mjs';
import { documentFingerprint, renderUnits, unitsFingerprint, sha256, text, imageIdentity } from '../gates/publication-document.mjs';

// Render the exact compiled model with Naver's own editor. Every non-read
// request is blocked, including autosave; this function never saves a draft.
export async function previewEditorModel({model,document,cookieHeader,baseDir}) {
  const origin='https://blog.naver.com';
  const cookies=cookieHeader.split(';').map(part => {
    const i=part.indexOf('=');return {name:part.slice(0,i).trim(),value:part.slice(i+1).trim(),domain:'.naver.com',path:'/',secure:true,httpOnly:true};
  }).filter(c=>['NID_AUT','NID_SES'].includes(c.name));
  if (cookies.length!==2 || cookies.some(c=>!['NID_AUT','NID_SES'].includes(c.name))) throw Error('AUTH_SCOPE');
  const browser=await chromium.launch({channel:'chromium',headless:true});
  const reviews={},blocked=[];let step='context';
  try {
    const context=await browser.newContext({viewport:{width:1280,height:5000},locale:'ko-KR'});
    await context.addCookies(cookies);
    let injected=0;
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if (!['GET','HEAD','OPTIONS'].includes(request.method())) {blocked.push({method:request.method(),path:url.pathname});return route.abort();}
      if (url.origin===origin && url.pathname==='/PostWriteFormSeOptions.naver') {
        if(url.searchParams.get('blogId')!==document.blogId || url.searchParams.get('logNo')!==String(document.logNo)) throw Error('PREVIEW_TARGET');
        const response=await route.fetch(),data=await response.json();
        if(data.isSuccess!==true || !data.result || typeof data.result.documentModel!=='string') throw Error('PREVIEW_SCHEMA');
        data.result.documentModel=JSON.stringify(model);injected++;
        return route.fulfill({response,json:data});
      }
      return route.continue();
    });
    const page=await context.newPage();page.setDefaultTimeout(12000);
    step='navigate';await page.goto(`${origin}/${document.blogId}/postupdate?logNo=${document.logNo}`,{waitUntil:'domcontentloaded'});
    step='wait_title';
    await page.getByText(document.title,{exact:true}).waitFor();
    step='close_help';
    const close=page.getByText('닫기',{exact:true});
    try {await close.waitFor({state:'visible',timeout:5000});await close.click();}
    catch(error) {if(error.name!=='TimeoutError') throw error;}
    await page.evaluate(()=>document.fonts.ready);
    if(injected!==1) throw Error('NATIVE_DOCUMENT_NOT_INJECTED');
    const headings=document.blocks.filter(b=>b.type==='heading').map(b=>({text:b.text,quotation:b.presentation==='quotation'}));
    const panelNotice=document.blocks.some(b=>b.type==='notice'&&b.presentation==='panel');
    const links=document.blocks.filter(b=>b.type==='link').map(b=>({label:b.label,url:b.url}));
    for(const device of ['desktop','mobile']) {
      step=`${device}_mode`;
      if(device==='mobile') await page.getByRole('button',{name:'PC 화면',exact:true}).click();
      const canvas=page.locator('.se-canvas');
      await canvas.locator('.se-image img').evaluateAll(imgs=>Promise.all(imgs.map(img=>img.decode().catch(()=>{}))));
      step=`${device}_observe`;const observation=await canvas.evaluate((e,{headings,links,panelNotice})=>{
        const paragraphs=[...e.querySelectorAll('.se-component:not(.se-documentTitle) p.se-text-paragraph')];
        const rect=e.getBoundingClientRect();
        // Native quote components expose an empty citation field with an editor
        // placeholder. It is not authored content and is absent from public HTML.
        const content=p=>[...p.childNodes].filter(n=>!n.classList?.contains('se-placeholder')).map(n=>n.textContent).join('');
        const nonblank=paragraphs.filter(p=>content(p).trim());
        const notice=nonblank[0]?.getBoundingClientRect();
        const componentNodes=[...e.querySelectorAll('.se-component:not(.se-documentTitle)')];
        const imageNodes=componentNodes.filter(c=>c.classList.contains('se-image')).flatMap(c=>[...c.querySelectorAll('img')]);
        const noticeComponent=nonblank[0]?.closest('.se-component');
        const noticePanels=[noticeComponent,...noticeComponent.querySelectorAll('div,blockquote,td')].map(n=>({tag:n.tagName,classes:n.className,background:getComputedStyle(n).backgroundColor,width:n.getBoundingClientRect().width,padding:getComputedStyle(n).padding}));
        const grayPanel=noticePanels.find(n=>{const rgb=/^rgb\((\d+), (\d+), (\d+)\)$/.exec(n.background);return rgb&&Number(rgb[1])>=210&&Number(rgb[1])<255&&rgb[1]===rgb[2]&&rgb[2]===rgb[3]&&n.width>=notice.width;});
        return {
          units:componentNodes.flatMap(c=>c.classList.contains('se-image')?[...c.querySelectorAll('img')].map(img=>({type:'image',value:img.currentSrc||img.src})):c.classList.contains('se-horizontalLine')?[{type:'divider',value:''}]:[...c.querySelectorAll('p.se-text-paragraph')].filter(p=>content(p).trim()).map(p=>({type:c.classList.contains('se-quotation')?'quote':'text',value:content(p)}))),
          disclosureRect:{top:notice.top-rect.top,bottom:notice.bottom-rect.top},
          headingHierarchy:headings.every(h=>paragraphs.some(p=>p.textContent===h.text && (!h.quotation||p.closest('.se-quotation')) && [...p.querySelectorAll('*')].some(n=>parseInt(getComputedStyle(n).fontWeight)>=600))),
          headingStyles:headings.map(h=>paragraphs.filter(p=>p.textContent===h.text).map(p=>({html:p.innerHTML,quotation:!!p.closest('.se-quotation'),styles:[...p.querySelectorAll('*')].map(n=>({tag:n.tagName,weight:getComputedStyle(n).fontWeight}))}))),
          disclosureStyled:!panelNotice||!!grayPanel,
          disclosurePanel:!!grayPanel&&noticeComponent.classList.contains('se-table'),
          noticePanels,
          imageCount:imageNodes.length,
          imagesLoaded:imageNodes.length>0&&imageNodes.every(img=>img.complete&&img.naturalWidth>0&&img.getBoundingClientRect().width>=200),
          imageLayouts:imageNodes.map(img=>({source:img.currentSrc||img.src,width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height,loaded:img.complete&&img.naturalWidth>0})),
          labeledLinks:links.every(l=>[...e.querySelectorAll('[data-href]')].some(n=>n.getAttribute('data-href')===l.url && n.textContent===l.label)) && !nonblank.some(p=>/^https?:\/\//.test(p.textContent.trim())),
          paragraphSpacing:nonblank.every((p,i)=>i===0 || p.getBoundingClientRect().top-nonblank[i-1].getBoundingClientRect().bottom>=12),
          noHorizontalOverflow:nonblank.every(p=>p.scrollWidth<=p.clientWidth+1)&&imageNodes.every(img=>img.getBoundingClientRect().width<=rect.width+1),
          nativeMobile:e.classList.contains('se-l-viewport-mobile'),
          contentBottom:Math.max(...componentNodes.map(n=>n.getBoundingClientRect().bottom))-rect.top,
        };
      },{headings,links,panelNotice});
      if(unitsFingerprint(observation.units.map(u=>({...u,value:u.type==='image'?imageIdentity(u.value):text(u.value)})))!==unitsFingerprint(renderUnits(document))) {
        await writeFile(path.join(baseDir,'native-preview-mismatch.json'),JSON.stringify({expected:renderUnits(document),observed:observation.units},null,2));
        throw Error('NATIVE_PREVIEW_CONTENT_MISMATCH');
      }
      if(!observation.disclosureStyled){await writeFile(path.join(baseDir,'native-panel-mismatch.json'),JSON.stringify(observation.noticePanels,null,2));throw Error('NATIVE_DISCLOSURE_STYLE_MISMATCH');}
      const box=await canvas.boundingBox(),column=await canvas.locator('.se-documentTitle .se-module-text').boundingBox(),height=device==='mobile'?844:900;
      const clip={x:Math.floor(column.x),y:Math.floor(box.y),width:Math.ceil(column.width),height};
      step=`${device}_screenshot`;const png=await page.screenshot({clip});
      await writeFile(path.join(baseDir,`native-${device}.png`),png);
      // The editor scrolls inside a fixed viewport. Enlarge it for the full
      // artifact so content below 5,000px is not silently clipped.
      const fullHeight=Math.ceil(observation.contentBottom+30);
      await page.setViewportSize({width:1280,height:Math.max(5000,Math.ceil(clip.y+fullHeight+100))});
      await page.screenshot({fullPage:true,path:path.join(baseDir,`native-${device}-full.png`),clip:{...clip,height:fullHeight}});
      await page.setViewportSize({width:1280,height:5000});
      const checks=Object.fromEntries(['headingHierarchy','labeledLinks','paragraphSpacing','noHorizontalOverflow','disclosureStyled','disclosurePanel','imagesLoaded'].map(k=>[k,observation[k]]));
      reviews[device]={source:'rendered_dom',channel:'naver_editor',checkedAt:new Date().toISOString(),
        nativeDocumentInjected:true,browserWritesBlocked:true,nativeViewportMode:device,
        browserViewport:{width:1280,height:5000},viewport:{width:clip.width,height},
        disclosureRect:observation.disclosureRect,documentFingerprint:documentFingerprint(document),
        compiledPresentationFingerprint:editorPresentationFingerprint(model),
        observedUnitsFingerprint:unitsFingerprint(renderUnits(document)),
        screenshotFile:`native-${device}.png`,screenshotSha256:sha256(png),presentationChecks:checks,headingStyles:observation.headingStyles,
        imageCount:observation.imageCount,imageLayouts:observation.imageLayouts,noticePanels:observation.noticePanels};
      if(observation.nativeMobile!==(device==='mobile')) throw Error('NATIVE_VIEWPORT_MISMATCH');
    }
    await context.close();
  } catch(error) {
    const safe=Error(/^[A-Z_]+$/.test(error.message||'')?error.message:'NATIVE_PREVIEW_FAILED');
    safe.details={step,errorType:error.name};throw safe;
  } finally {await browser.close();for(const c of cookies)c.value='';}
  return {reviews,blockedBrowserWrites:blocked,browserClosed:true,scope:'Naver native editor preview of exact HTTP-compiled model; no publication'};
}
