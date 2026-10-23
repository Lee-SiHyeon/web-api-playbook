import {randomUUID,createHash} from 'node:crypto';
import {CafeApiError} from './session.mjs';
const id=()=>`SE-${randomUUID()}`;
const LINK=/\[([^\]\n]{1,200})\]\((https:\/\/[^\s)]+)\)/g;
export function cafeParagraph(text,{bold=false,size}={}){
 const nodes=[];let at=0;
 const node=(value,url)=>({id:id(),'@ctype':'textNode',value,...(url?{link:{'@ctype':'urlLink',url}}:{}),...(bold||size?{style:{'@ctype':'nodeStyle',bold,...(size?{fontSizeCode:size}:{})}}:{})});
 for(const m of String(text).matchAll(LINK)){if(m.index>at)nodes.push(node(text.slice(at,m.index)));nodes.push(node(m[1],m[2]));at=m.index+m[0].length;}
 if(at<text.length||!nodes.length)nodes.push(node(text.slice(at)));
 return {id:id(),'@ctype':'paragraph',nodes};
}
export const cafeText=(text,style={})=>({id:id(),'@ctype':'text',layout:'default',value:String(text).split('\n').map(x=>cafeParagraph(x,style))});
export function cafeTable(columns,rows){
 if(!columns.length||!rows.length||rows.some(r=>!Array.isArray(r)||r.length!==columns.length))throw new CafeApiError('TABLE_SCHEMA');
 return {id:id(),'@ctype':'table',layout:'default',width:100,columnCount:columns.length,align:'left',borderStyleName:'thinLine',borderInlineStyle:'border-color: #d9d9d9;',
  rows:[columns,...rows].map((r,i)=>({id:id(),'@ctype':'tableRow',cells:r.map(x=>({id:id(),'@ctype':'tableCell',colSpan:1,rowSpan:1,width:100/columns.length,height:43,backgroundColor:i===0?'#f2f2f2':'#ffffff',borderInlineStyle:'border-color: #d9d9d9;',value:[cafeParagraph(String(x),{bold:i===0})]}))}))};
}
export function documentText(components){
 const paragraphs=ps=>(ps??[]).map(p=>(p.nodes??[]).map(n=>n.value??'').join('')).join('\n');
 return components.flatMap(c=>c['@ctype']==='table'?c.rows.flatMap(r=>r.cells.map(x=>paragraphs(x.value))):c['@ctype']==='image'?[paragraphs(c.caption)]:[paragraphs(c.value)]).filter(Boolean).join('\n');
}
export function richDocument(components){return {document:{version:'2.10.2',theme:'default',language:'ko-KR',id:randomUUID().replaceAll('-','').slice(0,26).toUpperCase(),components},documentId:''};}
export function documentFingerprint(model){
 const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).filter(k=>k!=='id').sort().map(k=>[k,stable(x[k])])):x;
 return createHash('sha256').update(JSON.stringify(stable(model.document.components))).digest('hex');
}
export function validateCafeDocument(raw){
 let model;try{model=JSON.parse(raw);}catch{throw new CafeApiError('CONTENT_JSON');}
 const cs=model.document?.components;
 if(!Array.isArray(cs)||!cs.length||raw.length>2_000_000||cs.some(c=>!['text','quotation','table','image','horizontalLine'].includes(c['@ctype'])))throw new CafeApiError('CONTENT_JSON');
 const images=cs.filter(c=>c['@ctype']==='image');
 for(const image of images){const u=new URL(image.src);if(u.origin!=='https://cafeptthumb-phinf.pstatic.net'||u.search!=='?type=w1'||u.hash||image.internalResource!==true)throw new CafeApiError('CONTENT_IMAGE_SCOPE');
   if(image.link!=null&&(typeof image.link!=='string'||!/^https:\/\//.test(image.link)))throw new CafeApiError('CONTENT_IMAGE_LINK_SCHEMA');
 }
 if(images.filter(x=>x.represent===true).length>1)throw new CafeApiError('CONTENT_REPRESENTATIVE');
 return {model,images,text:documentText(cs),fingerprint:documentFingerprint(model)};
}
