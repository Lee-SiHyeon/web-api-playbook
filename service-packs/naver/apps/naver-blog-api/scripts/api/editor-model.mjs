import { randomUUID } from "node:crypto";
import { fingerprint } from "../../../../packages/contracts/src/index.mjs";
import {
  text,
  imageIdentity,
  renderUnits,
  tableRows,
} from "../gates/publication-document.mjs";
import {
  cellTextAlign,
  inlineRuns,
  mergeNodeStyle,
  nodeStyle,
  paragraphAlign,
  paragraphStyle,
  quotationLayout,
  styleFields,
  tableAlign,
} from "../gates/editor-style-contract.mjs";

const id = () => `SE-${randomUUID()}`;
const httpsLink = value => {let u;try{u=new URL(value);}catch{throw Error('INVALID_CLICKABLE_LINK');}if(u.protocol!=='https:'||u.username||u.password)throw Error('INVALID_CLICKABLE_LINK');return value;};
const textNode = (value, style) => ({
  id: id(),
  value: String(value),
  ...(style ? { style } : {}),
  "@ctype": "textNode",
});
const paragraphOf = (nodes, style) => ({
  id: id(),
  ...(style ? { style } : {}),
  nodes,
  "@ctype": "paragraph",
});
const paragraph = (value) => paragraphOf([textNode(value)], null);
const paragraphs = (values) => values.map(paragraph);

// Authored presentation for one text block: inline runs, a paragraph-wide
// default style, paragraph alignment and the heading bold. Blocks that author
// none of it compile to exactly the paragraph this adapter has always emitted.
function styledParagraphs(block, { bold = false } = {}) {
  const runs = inlineRuns(block), base = styleFields(block.style);
  const style = paragraphStyle(paragraphAlign(block));
  const force = bold ? { bold: true } : null;
  if (!runs) return [paragraphOf([textNode(block.text, nodeStyle(mergeNodeStyle(base, force)))], style)];
  return [paragraphOf(runs.map((run) => textNode(run.text, nodeStyle(mergeNodeStyle(base, run.style, force)))), style)];
}
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
    ...(c['@ctype']==='image'?{ai:c.ai===true}:{}),
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
      const matrix=tableRows(block),count=block.columns.length,textAlign=cellTextAlign(block),align=tableAlign(block);
      components.push({id:id(),'@ctype':'table',layout:'default',width:100,columnCount:count,align,borderStyleName:'thinLine',borderInlineStyle:'border-color: #d8dde5;',
        rows:matrix.map((row,r)=>({id:id(),'@ctype':'tableRow',cells:row.map((cell,c)=>{
          const value=paragraphs([cell]);
          value[0].nodes[0].style={'@ctype':'nodeStyle',fontSizeCode:'fs13',fontColor:'#222222',bold:r===0};
          return {id:id(),'@ctype':'tableCell',colSpan:1,rowSpan:1,width:block.columnWidths?.[c]??100/count,height:42,backgroundColor:r===0?'#edf1f5':'#ffffff',borderInlineStyle:'border-color: #d8dde5;',textAlign,value};
        })}))});
    } else if (["notice", "heading", "paragraph", "quote"].includes(block.type)) {
      if (block.type === "paragraph" && block.presentation === "caption") throw new Error("ORPHAN_IMAGE_CAPTION");
      // The disclosure panel owns its whole presentation; an authored style
      // there would be silently overwritten, so it fails closed instead.
      const noticePanel = block.type === 'notice' && block.presentation === 'panel';
      if (noticePanel && (block.runs || block.style || block.align))
        throw new Error("NOTICE_PRESENTATION_FIXED");
      const value = styledParagraphs(block, { bold: block.type === 'heading' });
      if (noticePanel)
        value[0].nodes[0].style = { '@ctype':'nodeStyle', fontColor:'#666666', fontSizeCode:'fs13', italic:false, bold:false };
      if(noticePanel){
        components.push({id:id(),'@ctype':'table',layout:'default',width:100,columnCount:1,align:'left',borderStyleName:'thinLine',borderInlineStyle:'border-color: #f2f2f2;',
          rows:[{id:id(),'@ctype':'tableRow',cells:[{id:id(),'@ctype':'tableCell',colSpan:1,rowSpan:1,width:100,height:70,backgroundColor:'#f2f2f2',borderInlineStyle:'border-color: #f2f2f2;',textAlign:'left',value}]}]});
        continue;
      }
      const quotation = block.type === "quote" || block.type === 'heading' && block.presentation === 'quotation';
      components.push({
        id: id(),
        layout: quotation ? quotationLayout(block) : "default",
        value,
        "@ctype": quotation ? "quotation" : "text",
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
      // The editor exposes `ai` (default false) as the generated-image mark.
      // Only an image whose rights are recorded as generated may claim it.
      if (block.ai === true) {
        if (block.rights?.basis !== 'generated') throw new Error("AI_MARK_REQUIRES_GENERATED_RIGHTS");
        image.ai = true;
      }
      const captionBlock = document.blocks[blockIndex + 1];
      if (captionBlock?.type === "paragraph" && captionBlock.presentation === "caption") {
        if (!text(captionBlock.text)) throw new Error("EMPTY_IMAGE_CAPTION");
        image.caption = styledParagraphs(captionBlock);
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
