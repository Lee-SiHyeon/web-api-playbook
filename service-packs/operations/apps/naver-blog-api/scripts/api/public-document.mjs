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
  const units = [], imageResources = [];
  for (const component of root?.childNodes || []) {
    if (!hasClass(component, "se-component")) continue;
    if (hasClass(component, "se-horizontalLine"))
      units.push({ type: "divider", value: "" });
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
          units.push({ type: "image", value: imageIdentity(source) });
          // Preserve the observed transformation query for byte verification.
          // Removing it may return an 80px placeholder instead of the displayed asset.
          imageResources.push({ position: units.length, url: source });
        }
      }
    } else {
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
    imageResources,
    links: root ? walk(root, n => n.tagName === 'a' && attrs(n).href).map(n => attrs(n).href) : [],
    htmlSha256: sha256(html),
  };
}
