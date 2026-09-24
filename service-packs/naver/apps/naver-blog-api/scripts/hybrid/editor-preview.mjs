import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { editorPresentationFingerprint, inspectEditorModel } from '../api/editor-model.mjs';
import { documentFingerprint, renderUnits, unitsFingerprint, sha256, text, imageIdentity, documentTables } from '../gates/publication-document.mjs';

const ORIGIN = 'https://blog.naver.com';
const logId = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^\d{6,}$/.test(String(value));
export function tableBoundsValid({column,tables}) {
  return !!column&&Number.isFinite(column.left)&&Number.isFinite(column.right)&&Array.isArray(tables)&&tables.every(t=>
    Number.isFinite(t.left)&&Number.isFinite(t.right)&&t.left>=column.left-2&&t.right<=column.right+2&&t.right>t.left&&
    Array.isArray(t.cells)&&t.cells.length>1&&t.cells.every(c=>c.scrollWidth<=c.clientWidth+2&&c.scrollHeight<=c.clientHeight+2));
}

// A create document stays without logNo. The explicit existing post is only a
// protected, read-only render container; it never becomes the publication target.
export function prepareEditorPreview({model, document, previewSourceLogNo}) {
  if (!/^[a-zA-Z0-9_-]{3,50}$/.test(document?.blogId || '')) throw Error('PREVIEW_TARGET');
  const updating = Object.hasOwn(document, 'logNo');
  if (updating && !logId(document.logNo)) throw Error('PREVIEW_TARGET');
  const source = previewSourceLogNo === undefined && updating ? document.logNo : previewSourceLogNo;
  if (!logId(source) || updating && String(source) !== String(document.logNo)) throw Error('PREVIEW_TARGET');
  const finalDocument = structuredClone(document), compiledModel = structuredClone(model);
  const observed = inspectEditorModel(compiledModel), expected = renderUnits(finalDocument);
  if (observed.title !== text(finalDocument.title) || unitsFingerprint(observed.units) !== unitsFingerprint(expected))
    throw Error('PREVIEW_COMPILED_DOCUMENT_MISMATCH');
  const target = {blogId: finalDocument.blogId, logNo: String(source)};
  return {
    model: compiledModel, document: finalDocument, target,
    navigationUrl: `${ORIGIN}/${target.blogId}/postupdate?logNo=${target.logNo}`,
    documentFingerprint: documentFingerprint(finalDocument),
    compiledPresentationFingerprint: editorPresentationFingerprint(compiledModel),
    observedUnitsFingerprint: unitsFingerprint(expected),
  };
}

export function createEditorPreviewRoute(preview, {blocked, onInjected}) {
  return async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      blocked.push({method: request.method(), path: url.pathname});
      return route.abort();
    }
    if (url.origin === ORIGIN && url.pathname === '/PostWriteFormSeOptions.naver') {
      if (request.method() !== 'GET' || url.searchParams.getAll('blogId').length !== 1 ||
          url.searchParams.getAll('logNo').length !== 1 ||
          url.searchParams.get('blogId') !== preview.target.blogId ||
          url.searchParams.get('logNo') !== preview.target.logNo) throw Error('PREVIEW_TARGET');
      const response = await route.fetch(), data = await response.json();
      if (data.isSuccess !== true || !data.result || typeof data.result.documentModel !== 'string')
        throw Error('PREVIEW_SCHEMA');
      data.result.documentModel = JSON.stringify(preview.model);
      onInjected();
      return route.fulfill({response, json: data});
    }
    return route.continue();
  };
}

// Naver replaces below-fold SVG placeholders only after their image enters the
// editor's scroll viewport. Wait for that observed resource, never copy a URL
// from the submitted model into the DOM or the observation.
export async function loadEditorPreviewImages(canvas, {timeoutMs = 12000, selector = '.se-image img'} = {}) {
  const sources = [];
  for (const image of await canvas.locator(selector).all()) {
    if(selector.includes('.se-video'))await image.evaluate(img=>img.closest('.se-video').scrollIntoView({block:'center'}));
    else await image.scrollIntoViewIfNeeded();
    sources.push(await image.evaluate((img, timeoutMs) => new Promise((resolve, reject) => {
      let checking = false, finished = false;
      const stop = () => {finished = true; clearInterval(poll); clearTimeout(timer);};
      const timer = setTimeout(() => {stop(); reject(Error('NATIVE_IMAGE_NOT_LOADED'));}, timeoutMs);
      const check = async () => {
        if (checking || finished) return;
        const source = img.currentSrc || img.src;
        if (!/^https:\/\//.test(source) || !img.complete || img.naturalWidth <= 0) return;
        checking = true;
        try {
          await img.decode();
          if (!finished && source === (img.currentSrc || img.src) && img.complete && img.naturalWidth > 0) {
            stop(); resolve(source);
          }
        } catch { /* A changed or failed resource must not count as loaded. */ }
        finally {checking = false;}
      };
      const poll = setInterval(check, 25);
      check();
    }), timeoutMs));
  }
  return sources;
}


export async function loadEditorPreviewVideos(canvas,{timeoutMs=12000}={}){
  const records={};
  for(const component of await canvas.locator('.se-component.se-video').all()){
    await component.scrollIntoViewIfNeeded();
    const record=await component.evaluate((element,timeoutMs)=>new Promise((resolve,reject)=>{
      const node=element.querySelector('.se-video-thumbnail');
      const raw=node?getComputedStyle(node).backgroundImage:'';
      const match=/^url\(["']?(https:\/\/[^"')]+)["']?\)$/.exec(raw);
      if(!match){reject(Error('NATIVE_VIDEO_BACKGROUND_MISSING'));return;}
      const source=match[1],image=new Image(),timer=setTimeout(()=>reject(Error('NATIVE_VIDEO_THUMBNAIL_TIMEOUT')),timeoutMs);
      image.onload=async()=>{try{await image.decode();clearTimeout(timer);
        const box=node.getBoundingClientRect();
        if(image.naturalWidth<=0||box.width<=0||box.height<=0)throw Error('NATIVE_VIDEO_THUMBNAIL_INVALID');
        resolve({componentId:element.getAttribute('data-compid'),source,width:image.naturalWidth,height:image.naturalHeight,loaded:true,
          sourceKind:'observed_native_css_background'});
      }catch{clearTimeout(timer);reject(Error('NATIVE_VIDEO_THUMBNAIL_INVALID'));}};
      image.onerror=()=>{clearTimeout(timer);reject(Error('NATIVE_VIDEO_THUMBNAIL_NOT_LOADED'));};image.src=source;
    }),timeoutMs);
    records[record.componentId]=record;
  }
  return records;
}

// Render the exact compiled model with Naver's own editor. Every non-read
// request is blocked, including autosave; this function never saves a draft.
export async function previewEditorModel({model,document,previewSourceLogNo,cookieHeader,baseDir}) {
  const preview = prepareEditorPreview({model, document, previewSourceLogNo});
  model = preview.model; document = preview.document;
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
    await context.route('**/*', createEditorPreviewRoute(preview, {blocked, onInjected: () => {injected++;}}));
    const page=await context.newPage();page.setDefaultTimeout(12000);
    step='navigate';await page.goto(preview.navigationUrl,{waitUntil:'domcontentloaded'});
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
    const videoSpecs=model.document.components.filter(c=>c['@ctype']==='video').map(c=>({id:c.id,vid:c.vid,
      thumbnail:c.thumbnail.src,title:c.mediaMeta?.title||'',playTime:c.playTime,time:[Math.floor(c.playTime/60),Math.floor(c.playTime%60)].map(n=>String(n).padStart(2,'0')).join(':')}));
    const links=document.blocks.filter(b=>b.type==='link').map(b=>({label:b.label,url:b.url}));
    for(const device of ['desktop','mobile']) {
      step=`${device}_mode`;
      if(device==='mobile') await page.getByRole('button',{name:'PC 화면',exact:true}).click();
      const canvas=page.locator('.se-canvas');
      // Long documents hydrate in batches. Visit the currently rendered tail
      // before reading the complete DOM; equality below still fails closed.
      const expectedComponents=model.document.components.filter(c=>c['@ctype']!=='documentTitle').length;
      for(let pass=0;pass<80;pass++) {
        const count=await canvas.locator('.se-component:not(.se-documentTitle)').count();
        await canvas.locator('.se-component:not(.se-documentTitle)').last().scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        const next=await canvas.locator('.se-component:not(.se-documentTitle)').count();
        if(next===expectedComponents&&next===count&&pass>=3)break;
      }
      if(await canvas.locator('.se-component:not(.se-documentTitle)').count()!==expectedComponents)throw Error('NATIVE_COMPONENTS_NOT_LOADED');
      step=`${device}_load_images`;
      await loadEditorPreviewImages(canvas);
      step=device+'_load_video_thumbnails';const videoThumbnailRecords=await loadEditorPreviewVideos(canvas);
      step=device+'_link_observation';
      // The native editor renders a link icon, not a clickable anchor. Read the
      // actual image-link field without applying it; never infer the URL from
      // the submitted model. All browser writes remain blocked by the route.
      const imageLinkRecords={};
      for(const component of await canvas.locator('.se-component.se-image').all()) {
        if(await component.locator('.se-image-link-icon').count()) {
          await component.locator('img').click();
          const toggle=page.locator('button[data-name="image-link"]:visible');
          await toggle.waitFor();await toggle.click();
          const input=page.locator('input.se-custom-layer-link-input:visible');
          await input.waitFor();
          imageLinkRecords[await component.getAttribute('data-compid')]=await input.inputValue();
          await toggle.click();
        }
      }
      const title=page.getByText(document.title,{exact:true});
      await title.click();
      await title.scrollIntoViewIfNeeded();
      step=`${device}_observe`;const observation=await canvas.evaluate((e,{headings,links,panelNotice,imageLinkRecords,videoSpecs,videoThumbnailRecords})=>{
        const paragraphs=[...e.querySelectorAll('.se-component:not(.se-documentTitle) p.se-text-paragraph')];
        const rect=e.getBoundingClientRect();
        // Native quote components expose an empty citation field with an editor
        // placeholder. It is not authored content and is absent from public HTML.
        const content=p=>[...p.childNodes].filter(n=>!n.classList?.contains('se-placeholder')).map(n=>n.textContent).join('');
        const nonblank=paragraphs.filter(p=>content(p).trim());
        const prose=nonblank.filter(p=>!p.closest('td,th'));
        const paragraphGapViolations=prose.slice(1).map((p,index)=>{
          const previous=prose[index],gap=p.getBoundingClientRect().top-previous.getBoundingClientRect().bottom;
          const component=node=>node.closest('.se-component');
          const sameComponent=component(previous)===component(p);
          // Naver renders consecutive list items as paragraphs in one text
          // component with zero outer gap. Require non-overlap there; retain
          // the 12px spacing rule between independent content components.
          if(gap>=(sameComponent?-1:12))return null;
          return {gapPx:Math.round(gap*100)/100,previousText:content(previous).slice(0,80),
            currentText:content(p).slice(0,80),previousComponent:component(previous)?.className,
            currentComponent:component(p)?.className,sameComponent};
        }).filter(Boolean);
        const notice=nonblank[0]?.getBoundingClientRect();
        const componentNodes=[...e.querySelectorAll('.se-component:not(.se-documentTitle)')];
        const imageNodes=componentNodes.filter(c=>c.classList.contains('se-image')).flatMap(c=>[...c.querySelectorAll('img')]);
        const videoNodes=componentNodes.filter(c=>c.classList.contains('se-video'));
        const videoLayouts=videoNodes.map(c=>{const img=c.querySelector('.se-video-thumbnail-resource'),spec=videoSpecs.find(s=>s.id===c.getAttribute('data-compid'));
          return {componentId:c.getAttribute('data-compid'),videoId:spec?.vid||null,identityMethod:'component_id_and_thumbnail',
            thumbnail:videoThumbnailRecords[c.getAttribute('data-compid')]?.source||'',title:c.querySelector('.se-video-title-text')?.textContent||'',
            time:c.querySelector('.se-video-time')?.textContent||'',loaded:videoThumbnailRecords[c.getAttribute('data-compid')]?.loaded===true,
            width:c.getBoundingClientRect().width,expected:spec};});
        const nativeVideos=videoLayouts.length===videoSpecs.length&&videoLayouts.every(v=>v.expected&&v.loaded&&
          v.thumbnail===v.expected.thumbnail&&v.title===v.expected.title&&/^(?:\d+:)?\d{1,2}:\d{2}$/.test(v.time)&&v.time.split(':').reduce((total,part)=>total*60+Number(part),0)===Math.floor(v.expected.playTime)&&v.width<=rect.width+1);
        const noticeComponent=nonblank[0]?.closest('.se-component');
        const tableNodes=componentNodes.filter(c=>c.classList.contains('se-table')&&[...c.querySelectorAll('tr')].some(r=>r.querySelectorAll('td,th').length>1));
        const bodyColumn=e.querySelector('.se-documentTitle .se-module-text').getBoundingClientRect();
        const tableBounds={column:{left:bodyColumn.left,right:bodyColumn.right},tables:tableNodes.map(c=>{
          const box=c.querySelector('table').getBoundingClientRect();return {left:box.left,right:box.right,cells:[...c.querySelectorAll('td,th')].map(cell=>({scrollWidth:cell.scrollWidth,clientWidth:cell.clientWidth,scrollHeight:cell.scrollHeight,clientHeight:cell.clientHeight}))};
        })};
        const tables=tableNodes.map(c=>[...c.querySelectorAll('tr')].map(r=>[...r.querySelectorAll('td,th')].map(cell=>[...cell.querySelectorAll('p.se-text-paragraph')].map(content).filter(s=>s.trim()).join(' ').replace(/\s+/g,' ').trim())));
        const tableGeometry=tableNodes.every(c=>[...c.querySelectorAll('tr')].every(r=>{
          const cells=[...r.querySelectorAll('td,th')];return cells.every((cell,i)=>{
            const box=cell.getBoundingClientRect();
            return box.width>=40&&box.height>=30&&(i===0||box.left>=cells[i-1].getBoundingClientRect().right-1)&&cell.scrollWidth<=cell.clientWidth+2;
          });
        }));
        const noticePanels=[noticeComponent,...noticeComponent.querySelectorAll('div,blockquote,td')].map(n=>({tag:n.tagName,classes:n.className,background:getComputedStyle(n).backgroundColor,width:n.getBoundingClientRect().width,padding:getComputedStyle(n).padding}));
        const grayPanel=noticePanels.find(n=>{const rgb=/^rgb\((\d+), (\d+), (\d+)\)$/.exec(n.background);return rgb&&Number(rgb[1])>=210&&Number(rgb[1])<255&&rgb[1]===rgb[2]&&rgb[2]===rgb[3]&&n.width>=notice.width;});
        return {
          tables,tableGeometry,tableBounds,
          units:componentNodes.flatMap(c=>c.classList.contains('se-image')?[...[...c.querySelectorAll('img')].map(img=>{const href=imageLinkRecords[c.getAttribute('data-compid')];return {type:'image',value:img.currentSrc||img.src,...(href?{href}:{})};}),...[...c.querySelectorAll('p.se-text-paragraph')].filter(p=>content(p).trim()).map(p=>({type:'text',value:content(p)}))]:c.classList.contains('se-video')?[{type:'video',value:videoSpecs.find(s=>s.id===c.getAttribute('data-compid'))?.vid||''},
            ...[...c.querySelectorAll('.se-caption p.se-text-paragraph')].filter(p=>content(p).trim()).map(p=>({type:'text',value:content(p)}))]:c.classList.contains('se-horizontalLine')?[{type:'divider',value:''}]:[...c.querySelectorAll('p.se-text-paragraph')].filter(p=>content(p).trim()).map(p=>({type:c.classList.contains('se-quotation')?'quote':'text',value:content(p)}))),
          disclosureRect:{top:notice.top-rect.top,bottom:notice.bottom-rect.top},
          headingHierarchy:headings.every(h=>paragraphs.some(p=>p.textContent===h.text && (!h.quotation||p.closest('.se-quotation')) && [...p.querySelectorAll('*')].some(n=>parseInt(getComputedStyle(n).fontWeight)>=600))),
          headingStyles:headings.map(h=>paragraphs.filter(p=>p.textContent===h.text).map(p=>({html:p.innerHTML,quotation:!!p.closest('.se-quotation'),styles:[...p.querySelectorAll('*')].map(n=>({tag:n.tagName,weight:getComputedStyle(n).fontWeight}))}))),
          disclosureStyled:!panelNotice||!!grayPanel,
          disclosurePanel:!!grayPanel&&noticeComponent.classList.contains('se-table'),
          noticePanels,
          videoCount:videoNodes.length,videoLayouts,nativeVideos,
          videoCaptions:videoNodes.map(c=>[...c.querySelectorAll('.se-caption p.se-text-paragraph')].map(content).map(s=>s.trim()).filter(Boolean)),
          imageCount:imageNodes.length,
          imageComponents:componentNodes.filter(c=>c.classList.contains('se-image')).map(c=>c.outerHTML),
          imageCaptions:componentNodes.filter(c=>c.classList.contains('se-image')).map(c=>[...c.querySelectorAll('p.se-text-paragraph')].map(content).map(s=>s.trim()).filter(Boolean)),
          imagesLoaded:imageNodes.every(img=>img.complete&&img.naturalWidth>0&&img.getBoundingClientRect().width>=200),
          imageLayouts:imageNodes.map(img=>({source:img.currentSrc||img.src,width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height,loaded:img.complete&&img.naturalWidth>0})),
          labeledLinks:links.every(l=>[...e.querySelectorAll('[data-href]')].some(n=>n.getAttribute('data-href')===l.url && n.textContent===l.label)) && !nonblank.some(p=>/^https?:\/\//.test(p.textContent.trim())),
          paragraphSpacing:paragraphGapViolations.length===0,
          paragraphGapViolations,
          noHorizontalOverflow:nonblank.every(p=>p.scrollWidth<=p.clientWidth+1)&&imageNodes.every(img=>img.getBoundingClientRect().width<=rect.width+1),
          nativeMobile:e.classList.contains('se-l-viewport-mobile'),
          contentBottom:Math.max(...componentNodes.map(n=>n.getBoundingClientRect().bottom))-rect.top,
        };
      },{headings,links,panelNotice,imageLinkRecords,videoSpecs,videoThumbnailRecords});
      if(unitsFingerprint(observation.units.map(u=>({...u,value:u.type==='image'?imageIdentity(u.value):text(u.value)})))!==unitsFingerprint(renderUnits(document))) {
        await writeFile(path.join(baseDir,'native-preview-mismatch.json'),JSON.stringify({expected:renderUnits(document),observed:observation.units,imageComponents:observation.imageComponents},null,2));
        throw Error('NATIVE_PREVIEW_CONTENT_MISMATCH');
      }
      const expectedCaptions=document.blocks.map((b,i)=>b.type==='image'?(document.blocks[i+1]?.presentation==='caption'?[text(document.blocks[i+1].text)]:[]):null).filter(Boolean);
      if(JSON.stringify(observation.imageCaptions.map(values=>values.map(text)))!==JSON.stringify(expectedCaptions)) {
        await writeFile(path.join(baseDir,'native-caption-mismatch.json'),JSON.stringify({expected:expectedCaptions,observed:observation.imageCaptions},null,2));
        throw Error('NATIVE_IMAGE_CAPTION_MISMATCH');
      }
      const expectedVideoCaptions=document.blocks.map((b,i)=>b.type==='video'?(document.blocks[i+1]?.presentation==='caption'?[text(document.blocks[i+1].text)]:[]):null).filter(Boolean);
      if(JSON.stringify(observation.videoCaptions.map(values=>values.map(text)))!==JSON.stringify(expectedVideoCaptions))throw Error('NATIVE_VIDEO_CAPTION_MISMATCH');
      if(videoSpecs.length&&!observation.nativeVideos)throw Error('NATIVE_VIDEO_PREVIEW_MISMATCH');
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
      checks.nativeImageCaptions=true;
      if(videoSpecs.length){checks.nativeVideos=observation.nativeVideos;checks.nativeVideoCaptions=true;}
      if(document.blocks.some(b=>b.type==='table'))checks.nativeTables=observation.tableGeometry&&tableBoundsValid(observation.tableBounds)&&JSON.stringify(observation.tables)===JSON.stringify(documentTables(document));
      reviews[device]={source:'rendered_dom',channel:'naver_editor',checkedAt:new Date().toISOString(),
        nativeDocumentInjected:true,browserWritesBlocked:true,nativeViewportMode:device,
        browserViewport:{width:1280,height:5000},viewport:{width:clip.width,height},
        disclosureRect:observation.disclosureRect,documentFingerprint:preview.documentFingerprint,
        compiledPresentationFingerprint:preview.compiledPresentationFingerprint,
        observedUnitsFingerprint:preview.observedUnitsFingerprint,
        renderContainer:{...preview.target,readOnly:true},
        screenshotFile:`native-${device}.png`,screenshotSha256:sha256(png),presentationChecks:checks,headingStyles:observation.headingStyles,
        videoCount:observation.videoCount,videoLayouts:observation.videoLayouts.map(({expected,...v})=>v),videoCaptions:observation.videoCaptions,
        imageCount:observation.imageCount,imageLayouts:observation.imageLayouts,imageCaptions:observation.imageCaptions,noticePanels:observation.noticePanels,imageLinkRecords,tables:observation.tables,tableBounds:observation.tableBounds,
        paragraphGapViolations:observation.paragraphGapViolations};
      if(observation.nativeMobile!==(device==='mobile')) throw Error('NATIVE_VIEWPORT_MISMATCH');
    }
    await context.close();
  } catch(error) {
    const safe=Error(/^[A-Z_]+$/.test(error.message||'')?error.message:'NATIVE_PREVIEW_FAILED');
    safe.details={step,errorType:error.name};throw safe;
  } finally {await browser.close();for(const c of cookies)c.value='';}
  return {reviews,blockedBrowserWrites:blocked,browserClosed:true,renderContainer:{...preview.target,readOnly:true},scope:'Naver native editor preview of exact HTTP-compiled model; no publication'};
}
