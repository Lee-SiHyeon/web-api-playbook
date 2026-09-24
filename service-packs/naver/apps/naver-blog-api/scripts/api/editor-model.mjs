import { randomUUID } from "node:crypto";
import { fingerprint } from "../../../../packages/contracts/src/index.mjs";
import {
  text,
  imageIdentity,
  renderUnits,
  tableRows,
} from "../gates/publication-document.mjs";

const id = () => `SE-${randomUUID()}`;
const httpsLink = value => {let u;try{u=new URL(value);}catch{throw Error('INVALID_CLICKABLE_LINK');}if(u.protocol!=='https:'||u.username||u.password)throw Error('INVALID_CLICKABLE_LINK');return value;};
const paragraph = (value) => ({
  id: id(),
  nodes: [{ id: id(), value: String(value), "@ctype": "textNode" }],
  "@ctype": "paragraph",
});
const paragraphs = (values) => values.map(paragraph);
const plain = (values) =>
  (values || [])
    .map((p) => {
      if (
        p["@ctype"] !== "paragraph" ||
        !Array.isArray(p.nodes) ||
        p.nodes.some((n) => n["@ctype"] !== "textNode")
      )
        throw new Error("UNSUPPORTED_EDITOR_NODE");
      return text(p.nodes.map((n) => n.value || "").join(""));
    })
    .filter(Boolean);

export function editorPresentationFingerprint(model) {
  const ps = values => (values || []).map(p => ({style:p.style || null,
    nodes:(p.nodes || []).map(n => ({value:n.value || '',style:n.style || null,link:n.link?.url || null}))}));
  return fingerprint(model.document.components.map(c => ({type:c['@ctype'],layout:c.layout,
    title:ps(c.title),value:ps(c.value),caption:ps(c.caption),src:c.src ? imageIdentity(c.src) : null,link:c.link || null,
    ...(c['@ctype']==='video'?{vid:c.vid,thumbnail:c.thumbnail,mediaMeta:c.mediaMeta,playTime:c.playTime,width:c.width,height:c.height,ai:c.ai}:{}),
    ...(c['@ctype']==='table'?{width:c.width,borderInlineStyle:c.borderInlineStyle,rows:c.rows.map(r=>r.cells.map(cell=>({backgroundColor:cell.backgroundColor,width:cell.width,height:cell.height,borderInlineStyle:cell.borderInlineStyle,value:ps(cell.value)})))}:{})})));
}

// This adapter covers the component schemas observed on 2026-09-20. Unknown
// components fail closed. Existing image and signed link-card objects are reused
// only from the fresh, protected document response; signatures are never invented.
export function inspectEditorModel(model) {
  if (!model?.document?.components || !Array.isArray(model.document.components))
    throw new Error("INVALID_EDITOR_MODEL");
  const titles = model.document.components.filter(
    (c) => c["@ctype"] === "documentTitle",
  );
  if (titles.length !== 1) throw new Error("INVALID_EDITOR_TITLE");
  const units = [];
  for (const c of model.document.components) {
    switch (c["@ctype"]) {
      case "documentTitle":
        break;
      case "text":
        for (const value of plain(c.value)) units.push({ type: "text", value });
        break;
      case "quotation":
        for (const value of plain(c.value))
          units.push({ type: "quote", value });
        break;
      case "table":
        for(const row of c.rows||[])for(const cell of row.cells||[])
          for(const value of plain(cell.value))units.push({type:'text',value});
        break;
      case "horizontalLine":
        units.push({ type: "divider", value: "" });
        break;
      case "image":
        units.push({ type: "image", value: imageIdentity(c.src), ...(c.link?{href:httpsLink(c.link)}:{}) });
        for (const value of plain(c.caption))
          units.push({ type: "text", value });
        break;
      case "video":
        if(!/^[A-F0-9]{36}$/.test(c.vid||'')||c.internalResource!==true)throw Error('UNSUPPORTED_VIDEO_COMPONENT');
        units.push({type:'video',value:c.vid});
        for(const value of plain(c.caption))units.push({type:'text',value});
        break;
      case "oglink":
        units.push({ type: "linkcard", value: text(c.link) });
        break;
      default:
        throw new Error("UNSUPPORTED_EDITOR_COMPONENT");
    }
  }
  return { title: plain(titles[0].title).join(" "), units };
}

export function compileEditorModel(freshModel, document, { uploadedComponents = [] } = {}) {
  inspectEditorModel(freshModel);
  const original = freshModel.document.components;
  const title = structuredClone(
    original.find((c) => c["@ctype"] === "documentTitle"),
  );
  title.title = paragraphs([document.title]);
  const components = [title];
  for (let blockIndex = 0; blockIndex < document.blocks.length; blockIndex++) {
    const block = document.blocks[blockIndex];
    if(block.type==='table') {
      const matrix=tableRows(block),count=block.columns.length;
      components.push({id:id(),'@ctype':'table',layout:'default',width:100,columnCount:count,align:'left',borderStyleName:'thinLine',borderInlineStyle:'border-color: #d8dde5;',
        rows:matrix.map((row,r)=>({id:id(),'@ctype':'tableRow',cells:row.map((cell,c)=>{
          const value=paragraphs([cell]);
          value[0].nodes[0].style={'@ctype':'nodeStyle',fontSizeCode:'fs13',fontColor:'#222222',bold:r===0};
          return {id:id(),'@ctype':'tableCell',colSpan:1,rowSpan:1,width:block.columnWidths?.[c]??100/count,height:42,backgroundColor:r===0?'#edf1f5':'#ffffff',borderInlineStyle:'border-color: #d8dde5;',textAlign:'left',value};
        })}))});
    } else if (["notice", "heading", "paragraph", "quote"].includes(block.type)) {
      if (block.type === "paragraph" && block.presentation === "caption") throw new Error("ORPHAN_IMAGE_CAPTION");
      const value = paragraphs([block.text]);
      // nodeStyle.bold was observed in the protected owner model. Preserve the
      // heading's visible hierarchy instead of flattening it to ordinary prose.
      if (block.type === 'heading') value[0].nodes[0].style = { '@ctype':'nodeStyle', bold:true };
      // Native table/tableRow/tableCell fields and percentage widths are
      // observed in editor 1.78.1. A shaded one-cell table provides a full
      // disclosure panel; inline highlighting is not a substitute.
      const noticePanel = block.type === 'notice' && block.presentation === 'panel';
      if (noticePanel)
        value[0].nodes[0].style = { '@ctype':'nodeStyle', fontColor:'#666666', fontSizeCode:'fs13', italic:false, bold:false };
      if(noticePanel){
        components.push({id:id(),'@ctype':'table',layout:'default',width:100,columnCount:1,align:'left',borderStyleName:'thinLine',borderInlineStyle:'border-color: #f2f2f2;',
          rows:[{id:id(),'@ctype':'tableRow',cells:[{id:id(),'@ctype':'tableCell',colSpan:1,rowSpan:1,width:100,height:70,backgroundColor:'#f2f2f2',borderInlineStyle:'border-color: #f2f2f2;',textAlign:'left',value}]}]});
        continue;
      }
      components.push({
        id: id(),
        layout: "default",
        value,
        "@ctype": block.type === "quote" || block.type === 'heading' && block.presentation === 'quotation' ? "quotation" : "text",
      });
    } else if (["list", "numbered"].includes(block.type)) {
      components.push({
        id: id(),
        layout: "default",
        value: paragraphs(
          block.items.map(
            (v, i) => `${block.type === "numbered" ? `${i + 1}. ` : "• "}${v}`,
          ),
        ),
        "@ctype": "text",
      });
    } else if (block.type === "link") {
      const observed = original.flatMap(c => (c.value || []).flatMap(p => p.nodes || []))
        .find(n => n['@ctype'] === 'textNode' && n.link?.url === block.url);
      const linked = paragraph(block.display === 'label' ? block.label : block.url);
      // 1.78.1 textNode.changeLink serializes {ctype:'urlLink',url:value}.
      linked.nodes[0].link = observed ? structuredClone(observed.link) : {'@ctype':'urlLink',url:httpsLink(block.url)};
      components.push({
        id: id(),
        layout: "default",
        value: block.display === 'label' ? [linked] : [paragraph(block.label), linked],
        "@ctype": "text",
      });
    } else if (block.type === "image") {
      const asset = [...original, ...uploadedComponents].find(
        (c) =>
          c["@ctype"] === "image" &&
          imageIdentity(c.src) === imageIdentity(block.publishedUrl),
      );
      if (!asset || !block.publishedUrl)
        throw new Error("UNOBSERVED_MEDIA_UPLOAD_REQUIRED");
      // ImageStore.changeLink stores the URL string in _link; toPlainJSON
      // serializes link:this.link. Captured from first-party SDK on 2026-09-21.
      const image=structuredClone(asset);
      image.link=block.href?httpsLink(block.href):null;
      const captionBlock = document.blocks[blockIndex + 1];
      if (captionBlock?.type === "paragraph" && captionBlock.presentation === "caption") {
        if (!text(captionBlock.text)) throw new Error("EMPTY_IMAGE_CAPTION");
        image.caption = paragraphs([captionBlock.text]);
        blockIndex++;
      } else image.caption = [];
      components.push(image);
    } else if(block.type==='video'){
      const asset=[...original,...uploadedComponents].find(c=>c['@ctype']==='video'&&c.vid===block.videoId);
      if(!asset)throw Error('UNOBSERVED_VIDEO_UPLOAD_REQUIRED');
      const video=structuredClone(asset),caption=document.blocks[blockIndex+1];
      if(caption?.type==='paragraph'&&caption.presentation==='caption'){
        if(!text(caption.text))throw Error('EMPTY_VIDEO_CAPTION');
        video.caption=paragraphs([caption.text]);blockIndex++;
      }else video.caption=[];
      components.push(video);
    } else if (block.type === "oglink") {
      const card = original.find(
        (c) => c["@ctype"] === "oglink" && c.link === block.url,
      );
      if (!card) throw new Error("UNOBSERVED_LINK_CARD_REQUIRED");
      components.push(structuredClone(card));
    } else if (block.type === "divider") {
      components.push({
        id: id(),
        layout: "default",
        "@ctype": "horizontalLine",
      });
    } else if (block.type === 'spacer') {
      const previous=components.at(-1);
      if(previous['@ctype']==='text') previous.value.push(paragraph(''));
      else components.push({id:id(),layout:'default',value:paragraphs(['']), '@ctype':'text'});
    } else
      throw new Error("UNSUPPORTED_PUBLICATION_BLOCK");
  }
  const result = structuredClone(freshModel);
  result.document.components = components;
  const observed = inspectEditorModel(result);
  if (
    observed.title !== text(document.title) ||
    fingerprint(observed.units) !== fingerprint(renderUnits(document))
  )
    throw new Error("COMPILED_DOCUMENT_MISMATCH");
  return result;
}
