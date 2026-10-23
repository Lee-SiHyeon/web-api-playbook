import { NATIVE_FRAME, NATIVE_SCRIPT } from "./contract.js";

function reject(message, outcome) {
  const error = new Error(message);
  error.name = "AdpickError";
  error.outcome = outcome;
  return error;
}

const SHOP_CATEGORY = new Set(["all", "hot", "recom"]);
const SHOP_COUNT = new Set(["6", "12", "18", "24"]);
const SHOP_STYLE = new Set(["grid", "list"]);
const APP_CATEGORY = new Set(["0", "1", "2"]);
const APP_COUNT = new Set(["2", "4", "6", "8", "10"]);
const APP_ORDER = new Set(["rand", "hot", "payout", "new"]);
const NATIVE_TYPES = new Set([
  "type1", "type2", "type3", "type4", "type5", "type6", "type7", "type8", "type9", "type10",
  "type11", "type12", "type13",
]);
const POPUP_TYPES = new Set(["type12", "type13"]);
const MEDIA_TYPES = new Set(["", "facebook", "instagram", "blog", "youtube", "twitter", "threads", "etc"]);

function decode(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function omitKeys(value, names) {
  if (Array.isArray(value)) return value.map((item) => omitKeys(item, names));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (names.includes(key)) continue;
    out[key] = omitKeys(item, names);
  }
  return out;
}

export function parseBanners(html) {
  const items = [];
  for (const row of String(html).matchAll(/<li class="table-tr">([\s\S]*?)<\/li>/g)) {
    const block = row[1];
    const code = /md=modify&code=(\d+)/.exec(block)?.[1] || "";
    const selected = /<option value=["']([^"']+)["'] selected>/.exec(block);
    const source = /<div class="td second">[\s\S]*?<a href="([^"]*)"[^>]*>([^<]*)<\/a>/.exec(block);
    const link = /<span class="label">링크<\/span>[\s\S]*?<a href="([^"]+)"/.exec(block);
    items.push({
      code,
      offer: selected?.[1] || "",
      offerLabel: /selected>([^<]+)/.exec(block)?.[1]?.trim() || "",
      sourceUrl: decode(source?.[1] || ""),
      sourceTitle: decode(source?.[2] || "").trim(),
      clicks: /<span class="label">클릭<\/span>\s*([0-9]+)/.exec(block)?.[1] || "0",
      createdOn: /<span class="label">등록일<\/span>\s*([^<]+)/.exec(block)?.[1]?.trim() || "",
      link: decode(link?.[1] || ""),
    });
  }
  return items;
}

export function parseMedia(html) {
  const items = [];
  for (const row of String(html).matchAll(/<li>\s*<span class="subject">([\s\S]*?)<\/li>/g)) {
    const block = row[1];
    const page = /bookmark\('([^']+)'\)/.exec(block)?.[1] || "";
    const kind = /class="type_([a-z]+)"/.exec(block)?.[1] || "";
    const titleLink = /<span class="txt-title">([\s\S]*?)<\/span>/.exec(block)?.[1] || "";
    const href = /<a href="(https?:\/\/[^"]+)"/.exec(titleLink);
    const title = decode(titleLink.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim());
    const followers = /<span class="label">팔로워<\/span>\s*([^<]+)/.exec(block)?.[1]?.trim() || "";
    const updated = /<span class="label">갱신일<\/span>\s*([^<]+)/.exec(block)?.[1]?.trim() || "";
    const code = /md=reg&code=(\d+)/.exec(block)?.[1] || "";
    if (!page && !title) continue;
    items.push({
      code,
      pageId: page,
      kind,
      title,
      url: href?.[1] || "",
      followers,
      updated,
    });
  }
  const count = /<span class="label">\s*내 매체\s*<\/span>\s*<span class="num">\s*(\d+)/.exec(html)?.[1] || "";
  return { count, items };
}

export function nativeSource({ affid, bannerType = "type5", limit = 1 } = {}) {
  if (!affid || !/^[A-Za-z0-9]+$/.test(affid)) {
    throw reject("ADPICK_AFFID is not set", "provider_missing");
  }
  if (!NATIVE_TYPES.has(bannerType)) {
    throw reject("bannerType is not one of the native types", "bad_request");
  }
  const count = Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > 5) {
    throw reject("limit must be 1 through 5", "bad_request");
  }
  const popup = POPUP_TYPES.has(bannerType);
  const shown = popup ? 1 : count;
  const src = new URL(NATIVE_FRAME);
  src.searchParams.set("affid", affid);
  src.searchParams.set("bannerType", bannerType);
  src.searchParams.set("limit", String(shown));
  const popupAttr = popup ? ' data-adpick_nativeAD_popup="true"' : "";
  const html = `<iframe src="${src}" width="100%" frameborder="0" scrolling="no" data-adpick_nativeAD id="AdpickAdContentFrame" referrerpolicy="unsafe-url"${popupAttr}></iframe><script src="${NATIVE_SCRIPT}" async="true"></script>`;
  return { bannerType, limit: shown, popup, html };
}

export function shopboxFields({ title = "", description = "", category = "all", listnum = "18", style = "grid" } = {}) {
  const fields = {
    title: String(title),
    description: String(description),
    category: String(category),
    listnum: String(listnum),
    style: String(style),
    md: "save",
  };
  if (!SHOP_CATEGORY.has(fields.category) || !SHOP_COUNT.has(fields.listnum) || !SHOP_STYLE.has(fields.style)) {
    throw reject("shopbox option is outside the form", "bad_request");
  }
  return fields;
}

export function appboxFields({ category = "0", listnum = "10", listorder = "rand" } = {}) {
  const fields = {
    category: String(category),
    listnum: String(listnum),
    listorder: String(listorder),
    md: "save",
  };
  if (!APP_CATEGORY.has(fields.category) || !APP_COUNT.has(fields.listnum) || !APP_ORDER.has(fields.listorder)) {
    throw reject("appbox option is outside the form", "bad_request");
  }
  return fields;
}

export function boxPage(kind, affid) {
  if (kind !== "shopbox" && kind !== "appbox") throw reject("box kind is unknown", "bad_request");
  if (!affid || !/^[A-Za-z0-9]+$/.test(affid)) return "";
  return `https://deg.kr/${kind}/${affid}`;
}

export function mediaQuery(mtype = "") {
  if (!MEDIA_TYPES.has(mtype)) throw reject("media type is outside the tabs", "bad_request");
  return mtype;
}

const AFFILIATE_HOSTS = new Set(["bitl.bz", "deg.kr"]);

export function affiliateLocation(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return "";
  if ([...url.searchParams.keys()].some((key) => /^(apikey|api_key|token|access_token|password|cookie|signature)$/i.test(key))) return "";
  if (!AFFILIATE_HOSTS.has(url.hostname)) return "";
  return url.toString();
}
