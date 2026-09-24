import { parse } from "parse5";
import { text, imageIdentity, sha256 } from "../gates/publication-document.mjs";

const attrs = (node) =>
  Object.fromEntries((node.attrs || []).map((a) => [a.name, a.value]));
const hasClass = (node, name) =>
  (attrs(node).class || "").split(/\s+/).includes(name);
function walk(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes || []) walk(child, predicate, out);
  return out;
}
function innerText(node) {
  if (["script", "style", "noscript"].includes(node.tagName)) return "";
  return node.nodeName === "#text"
    ? node.value
    : (node.childNodes || []).map(innerText).join("");
}
const paragraphs = (node) =>
  walk(node, (n) => n.tagName === "p" && hasClass(n, "se-text-paragraph"))
    .map((n) => text(innerText(n)))
    .filter(Boolean);

// Naver's public image links use href="#" and a delegated __se_link handler.
// Resolve only the observed enabled image contract, never arbitrary data fields.
function imageAnchorLink(anchor) {
  if (anchor?.tagName !== "a") return { native: false, href: null };
  const a = attrs(anchor);
  const native = a["data-linktype"] != null || a["data-linkdata"] != null ||
    hasClass(anchor, "__se_image_link") || hasClass(anchor, "se-module-image-link-use");
  if (!native) return { native: false, href: a.href || null };
  const disabled = { native: true, href: null };
  if (a["data-linktype"] !== "img" ||
      !hasClass(anchor, "se-module-image-link-use") ||
      !hasClass(anchor, "__se_link")) return disabled;
  try {
    const data = JSON.parse(a["data-linkdata"]);
    // The current viewer tests linkUse == "true"; JSON boolean true does not pass.
    if (!data || Array.isArray(data) || data.linkUse !== "true" ||
        typeof data.link !== "string" || /[\s\u0000-\u001f\u007f]/u.test(data.link)) return disabled;
    const target = new URL(data.link);
    if (target.protocol !== "https:" || !target.hostname || target.username || target.password)
      return disabled;
    return { native: true, href: data.link };
  } catch {
    return disabled;
  }
}
export function parsePublicDocument(
  html,
  { url, httpStatus = 200, checkedAt = new Date().toISOString() } = {},
) {
  const target = new URL(url);
  if (
    target.origin !== "https://blog.naver.com" ||
    target.pathname !== "/PostView.naver"
  )
    throw new Error("Unsupported public read-back URL");
  const dom = parse(html);
  const post = walk(
    dom,
    (n) => attrs(n).id === `post-view${target.searchParams.get("logNo")}`,
  )[0];
  const root = post
    ? walk(post, (n) => hasClass(n, "se-main-container"))[0]
    : null;
  const identity = walk(
    dom,
    (n) => n.tagName === "meta" && attrs(n).property === "og:url",
  )[0];
  let identityMatches = false;
  try {
    const u = new URL(attrs(identity || {}).content);
    identityMatches =
      u.origin === target.origin &&
      u.pathname ===
        `/${target.searchParams.get("blogId")}/${target.searchParams.get("logNo")}`;
  } catch {}
  const titleNode = walk(
    dom,
    (n) => n.tagName === "meta" && attrs(n).property === "og:title",
  )[0];
  const fallback = walk(dom, (n) => n.tagName === "title")[0];
  const title = text(
    titleNode ? attrs(titleNode).content : innerText(fallback || {}),
  ).replace(/\s*:\s*네이버 블로그$/, "");
  const units = [], imageResources = [], nativeImageLinks = new Map(), tables=[], imageCaptions=[], videoResources=[], videoCaptions=[];
  const tagArea = post ? walk(post, node => attrs(node).id === `tagList_${target.searchParams.get('logNo')}`)[0] : null;
  const tags = tagArea ? walk(tagArea, node => node.tagName === 'a' && hasClass(node, 'itemTagfont')).map(anchor => {
    const label = walk(anchor, node => hasClass(node, 'ell'))[0];
    return label ? text(innerText(label)).replace(/^#/, '') : '';
  }).filter(Boolean) : [];
  for (const component of root?.childNodes || []) {
    if (!hasClass(component, "se-component")) continue;
    if (hasClass(component, "se-horizontalLine"))
      units.push({ type: "divider", value: "" });
    else if(hasClass(component,'se-video')){
      const modules=walk(component,n=>n.tagName==='script'&&hasClass(n,'__se_module_data'));
      let observed=null;
      for(const script of modules){
        try{const a=attrs(script),m=JSON.parse(a['data-module-v2']||a['data-module']);
          if(m.type==='v2_video'&&m.data?.videoType==='player'&&/^[A-F0-9]{36}$/.test(m.data.vid)){
            const u=new URL(m.data.thumbnail);
            if(u.origin==='https://phinf.pstatic.net'&&u.pathname.startsWith('/image.nmv/'))
              observed={videoId:m.data.vid,thumbnail:u.origin+u.pathname,
                width:Number(m.data.width),height:Number(m.data.height),title:text(m.data.mediaMeta?.title)};
          }
        }catch{}
      }
      if(!observed)throw Error('PUBLIC_VIDEO_SCHEMA_UNOBSERVED');
      units.push({type:'video',value:observed.videoId});videoResources.push(observed);
      const caption=paragraphs(component);videoCaptions.push(caption);
      for(const value of caption)units.push({type:'text',value});
    }
    else if (hasClass(component, "se-oglink")) {
      const anchors = walk(
        component,
        (n) => n.tagName === "a" && attrs(n).href,
      );
      const href = anchors
        .map((a) => attrs(a).href)
        .find((v) => v.startsWith("https://link.coupang.com/"));
      units.push({
        type: "linkcard",
        value: href || attrs(anchors[0] || {}).href || "",
      });
    } else if (
      ["se-image", "se-imageStrip", "se-imageGroup"].some((c) =>
        hasClass(component, c),
      )
    ) {
      for (const img of walk(component, (n) => n.tagName === "img")) {
        const a = attrs(img);
        const source = a["data-lazy-src"] || a["data-src"] || a.src;
        if (source) {
          let anchor=img.parentNode;
          while(anchor&&anchor!==component&&anchor.tagName!=='a')anchor=anchor.parentNode;
          const link = imageAnchorLink(anchor);
          if (link.native) nativeImageLinks.set(anchor, link.href);
          const href = link.href;
          const linked=href&&/^https:\/\//.test(href)&&imageIdentity(href)!==imageIdentity(source);
          units.push({ type: "image", value: imageIdentity(source),...(linked?{href}:{}) });
          // Preserve the observed transformation query for byte verification.
          // Removing it may return an 80px placeholder instead of the displayed asset.
          imageResources.push({ position: units.length, url: source });
        }
      }
      const caption = paragraphs(component);
      imageCaptions.push(caption);
      for (const value of caption) units.push({ type: 'text', value });
    } else {
      if(hasClass(component,'se-table')) {
        const rows=walk(component,n=>n.tagName==='tr').map(row=>(row.childNodes||[]).filter(n=>['td','th'].includes(n.tagName)).map(cell=>paragraphs(cell).join(' ')));
        if(rows.some(row=>row.length>1))tables.push(rows);
      }
      const type = hasClass(component, "se-quotation") ? "quote" : "text";
      for (const value of paragraphs(component)) units.push({ type, value });
    }
  }
  return {
    schemaVersion: 1,
    source: "independent_http",
    url: target.href,
    httpStatus,
    checkedAt,
    blogId: target.searchParams.get("blogId"),
    logNo: target.searchParams.get("logNo"),
    targetIdentityVerified: Boolean(post) && identityMatches,
    title,
    smartEditorBodyPresent: Boolean(root),
    units,
    tables,
    imageResources,
    imageCaptions,
    videoResources,
    videoCaptions,
    tags,
    tagsObserved: tags.length > 0,
    links: root ? walk(root, n => n.tagName === 'a' && attrs(n).href).flatMap(n => {
      if (!nativeImageLinks.has(n)) return [attrs(n).href];
      const href = nativeImageLinks.get(n);
      return href ? [href] : [];
    }) : [],
    htmlSha256: sha256(html),
  };
}
