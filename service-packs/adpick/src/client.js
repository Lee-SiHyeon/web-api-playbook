import {
  ALLOWED_HOST,
  APPBOX_API,
  BANNER_PAGE,
  CAMPAIGN_PAGE,
  CAPTCHA_URL,
  COUPANG_API,
  DASHBOARD_URL,
  GOOGLE_AUTHORIZE,
  GOOGLE_CLIENT_ID,
  GOOGLE_REDIRECT,
  GOOGLE_SCOPE,
  GOOGLE_STATE,
  LOGIN_FAILURE_BODY,
  LOGIN_PAGE,
  LOGIN_SUCCESS_BODY,
  LOGIN_URL,
  ORIGIN,
  MEDIA_PAGE,
  REPORT_API,
  SEARCH_API,
  SHOPBOX_API,
  SHOPPING_API,
  USER_AGENT,
} from "./contract.js";
import { appboxFields, mediaQuery, omitKeys, parseBanners, parseMedia, shopboxFields } from "./tools.js";

const MAX_BODY = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;

export class CrossOriginRedirect extends Error {
  constructor(host) {
    super(`redirect left ${ALLOWED_HOST}`);
    this.name = "CrossOriginRedirect";
    this.host = host;
  }
}

export class AdpickError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = "AdpickError";
    this.status = info.status ?? 0;
    this.outcome = info.outcome ?? "transport_error";
  }
}

function allowedHost(hostname) {
  return hostname === ALLOWED_HOST || hostname === "adpick.co.kr";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CookieJar {
  constructor(header = "") {
    this.pairs = new Map();
    this.load(header);
  }

  load(header) {
    if (!header) return;
    for (const part of String(header).split(";")) {
      const trimmed = part.trim();
      if (!trimmed || !trimmed.includes("=")) continue;
      const eq = trimmed.indexOf("=");
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (name) this.pairs.set(name, value);
    }
  }

  header() {
    return [...this.pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  names() {
    return [...this.pairs.keys()];
  }

  get(name) {
    return this.pairs.get(name);
  }

  applySetCookie(line) {
    if (!line) return;
    const [pair, ...attrs] = line.split(";").map((part) => part.trim());
    if (!pair || !pair.includes("=")) return;
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if (!name) return;
    let domain = "";
    for (const attr of attrs) {
      const lower = attr.toLowerCase();
      if (lower.startsWith("domain=")) domain = attr.slice(7).trim().replace(/^\./, "");
    }
    if (domain && domain !== "adpick.co.kr" && !domain.endsWith(".adpick.co.kr")) return;
    if (value === "" || attrs.some((attr) => attr.toLowerCase() === "max-age=0")) {
      this.pairs.delete(name);
      return;
    }
    this.pairs.set(name, value);
  }
}

export class AdpickClient {
  constructor({ cookie = "", fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
    this.jar = new CookieJar(cookie);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  static fromEnv(env = process.env) {
    return new AdpickClient({ cookie: env.ADPICK_COOKIE || "" });
  }

  googleAuthorizeUrl() {
    const query = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT,
      state: GOOGLE_STATE,
      scope: GOOGLE_SCOPE,
      response_type: "code",
    });
    return `${GOOGLE_AUTHORIZE}?${query}`;
  }

  async exchangeGoogleCode(code) {
    if (!code || /[\r\n]/.test(code)) {
      throw new AdpickError("code is empty or contains a line break", { outcome: "bad_request" });
    }
    const result = await this.request(GOOGLE_REDIRECT, {
      query: { state: GOOGLE_STATE, code },
      referer: LOGIN_PAGE,
    });
    const text = result.text();
    return {
      status: result.status,
      outcome: text === LOGIN_FAILURE_BODY ? "login_failed" : "unobserved_body",
      bodyLength: result.body.length,
    };
  }

  async fetchCaptcha() {
    const result = await this.request(CAPTCHA_URL, { accept: "image/*,*/*" });
    const value = this.jar.get("ADPICK_CAPTCHA");
    return {
      status: result.status,
      contentType: result.contentType,
      bytes: result.body,
      captchaCookie: value ? `ADPICK_CAPTCHA=${value}` : "",
    };
  }

  async login({ email, password, captcha, captchaCookie = "" }) {
    if (captchaCookie) this.jar.load(captchaCookie);
    if (!email || !password || !captcha) {
      throw new AdpickError("email, password, and captcha are required", { outcome: "bad_request" });
    }
    if (/[\r\n]/.test(password) || /[\r\n]/.test(captcha)) {
      throw new AdpickError("credential contains a line break", { outcome: "bad_request" });
    }
    const body = new URLSearchParams({
      nurl: "",
      memid: email,
      mempwd: password,
      captcha_str: captcha,
      loginChk: "on",
    });
    const result = await this.request(LOGIN_URL, {
      method: "POST",
      body,
      referer: LOGIN_PAGE,
    });
    const text = result.text();
    let outcome = "unobserved_body";
    if (text === LOGIN_SUCCESS_BODY) outcome = "login_succeeded";
    return {
      status: result.status,
      outcome,
      bodyLength: result.body.length,
      cookieNames: this.jar.names(),
      cookieHeader: this.jar.header(),
    };
  }

  async session() {
    const result = await this.request(DASHBOARD_URL, { referer: LOGIN_PAGE });
    const text = result.text();
    const loginForm = text.includes('id="loginform"') || text.includes('name="mempwd"');
    let authenticated = text.includes("로그아웃") && !loginForm;
    let probe = "dashboard";
    // Some Vercel requests receive a small script instead of the dashboard.
    // The protected link-list API rejects anonymous callers and provides an
    // independently observed JSON schema, including accounts with no links.
    if (!authenticated && !loginForm && this.jar.header()) {
      try {
        const links = await this.links({ viewlist: 1 });
        const value = links.json;
        authenticated = value && Number.isSafeInteger(value.total_all) && value.total_all >= 0
          && Number.isSafeInteger(value.total_cnt) && value.total_cnt >= 0 && Array.isArray(value.list)
          && value.list.every(row => row && typeof row.indexno === "string" && row.indexno.length > 0
            && typeof row.offer === "string" && typeof row.product_url === "string");
        if (authenticated) probe = "private_link_list";
      } catch { authenticated = false; }
    }
    return {
      status: result.status,
      outcome: authenticated ? "authenticated" : loginForm ? "reauth_required" : "auth_unverified",
      bodyLength: result.body.length,
      probe,
      cookieNames: this.jar.names(),
    };
  }

  async malls() {
    const result = await this.jsonGet(SHOPPING_API, { md: "mall_list" });
    return { ...result, json: omitKeys(result.json, ["affid"]) };
  }

  async categories() {
    return this.jsonGet(SHOPPING_API, { md: "get_categorys" });
  }

  async keywords() {
    return this.jsonGet(SHOPPING_API, { md: "search_keyword_list" });
  }

  async recommend({ page = 1, viewlist = 10 } = {}) {
    return this.jsonGet(SHOPPING_API, { md: "recommend_item", page, viewlist });
  }

  async hotdeal({ page = 1, viewlist = 10 } = {}) {
    return this.jsonGet(SHOPPING_API, { md: "hotdeal", page, viewlist });
  }

  async searchProducts(word, { sort = "rel", page = 1, offers = "" } = {}) {
    const started = await this.postForm(SEARCH_API, {
      md: "search",
      search_word: word,
      sort,
    });
    const listed = await this.postForm(SEARCH_API, {
      md: "get_search_result_list",
      page: String(page),
      offers,
      search_word: word,
      sort,
    });
    return {
      startStatus: started.json?.status ?? null,
      status: listed.json?.status ?? null,
      message: listed.json?.msg ?? "",
      totalCount: listed.json?.total_cnt ?? null,
      malls: listed.json?.mall_list ?? [],
      items: listed.json?.list ?? [],
    };
  }

  async coupangSearch(keyword, { page = 1 } = {}) {
    return this.jsonGet(COUPANG_API, { md: "list", keyword, page });
  }

  async checkProductUrl(productUrl) {
    return this.jsonGet(SHOPPING_API, { md: "domain_check_mall", product_url: productUrl });
  }

  async createProductLinks(urls) {
    const list = (Array.isArray(urls) ? urls : [urls]).map((url) => String(url).trim()).filter(Boolean);
    if (!list.length) throw new AdpickError("product url is required", { outcome: "bad_request" });
    const created = await this.postForm(SHOPPING_API, {
      md: "makeMultiProducturl",
      urls: list.join(","),
    });
    const stamp = created.json?.time;
    if (stamp == null) {
      return { outcome: "unobserved_body", created: created.json ?? null, items: [] };
    }
    let last = null;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await sleep(1000);
      last = await this.jsonGet(SHOPPING_API, { md: "makeMultiProducturlList", time: String(stamp) });
      const count = Number(last.json?.listCnt ?? 0);
      const status = Number(last.json?.status ?? 0);
      if (count === list.length || status < 0 || (attempt > 2 && count === 0)) break;
    }
    const count = Number(last?.json?.listCnt ?? 0);
    return {
      outcome: count === list.length ? "created" : "outcome_unknown",
      time: stamp,
      status: last?.json?.status ?? null,
      count,
      items: last?.json?.list ?? [],
    };
  }

  async createMallLink(offer) {
    if (!offer) throw new AdpickError("offer is required", { outcome: "bad_request" });
    const result = await this.jsonGet(SHOPPING_API, { md: "getSlink", offer });
    const json = omitKeys(result.json, ["affid"]);
    return { outcome: json?.slink || json?.trackinglink ? "created" : "unobserved_body", status: result.status, json, bodyLength: result.body.length };
  }

  async links({ page = 1, viewlist = 20, keyword = "", offer = "", order = "" } = {}) {
    return this.jsonGet(SHOPPING_API, {
      md: "link_list",
      page,
      viewlist,
      keyword,
      offer,
      order,
    });
  }

  async reportSummary({ sdate = "", edate = "", offer = "", productId = "" } = {}) {
    return this.jsonGet(REPORT_API, {
      md: "get_summary_data",
      sdate,
      edate,
      offer,
      product_id: productId,
    });
  }

  async banners({ page = 1 } = {}) {
    const result = await this.request(BANNER_PAGE, {
      query: { ac: "tools", tac: "banner", page: String(page) },
      accept: "text/html",
      referer: BANNER_PAGE,
    });
    const html = result.text();
    const items = parseBanners(html);
    return {
      status: result.status,
      outcome: html.includes("로그아웃") ? "listed" : "auth_unverified",
      empty: html.includes("생성된 내역이 없습니다."),
      count: items.length,
      items,
    };
  }

  async createBanner({ url, offer = "rand" } = {}) {
    if (!url || !/^https:\/\//.test(url)) {
      throw new AdpickError("https content url is required", { outcome: "bad_request" });
    }
    if (!/^[A-Za-z0-9]+$/.test(String(offer))) {
      throw new AdpickError("offer is required", { outcome: "bad_request" });
    }
    const result = await this.request(`${BANNER_PAGE}&md=save`, {
      method: "POST",
      body: new URLSearchParams({ url, offer: String(offer) }),
      accept: "text/html",
      referer: BANNER_PAGE,
    });
    const html = result.text();
    const items = parseBanners(html);
    return {
      status: result.status,
      outcome: items.length ? "created" : html.includes("생성된 내역이 없습니다.") ? "empty" : "unobserved_body",
      count: items.length,
      items,
    };
  }

  async saveShopbox(options) {
    const result = await this.postAjax(SHOPBOX_API, shopboxFields(options), `${ORIGIN}/?ac=tools&tac=shopbox`);
    return boxResult(result);
  }

  async saveAppbox(options) {
    const result = await this.postAjax(APPBOX_API, appboxFields(options), `${ORIGIN}/?ac=tools&tac=appbox`);
    return boxResult(result);
  }

  async media({ mtype = "" } = {}) {
    const type = mediaQuery(mtype);
    const query = { ac: "tools", tac: "media" };
    if (type) query.mtype = type;
    const result = await this.request(MEDIA_PAGE, {
      query,
      accept: "text/html",
      referer: MEDIA_PAGE,
    });
    const html = result.text();
    const parsed = parseMedia(html);
    return {
      status: result.status,
      outcome: html.includes("로그아웃") ? "listed" : "auth_unverified",
      count: parsed.items.length,
      reportedCount: parsed.count,
      items: parsed.items,
    };
  }

  async campaigns({ word = "", admenu = "" } = {}) {
    const query = new URLSearchParams({ ac: "offer", tac: "campaign" });
    if (word) query.set("fword", word);
    if (admenu) query.set("admenu", admenu);
    const result = await this.request(`${ORIGIN}/?${query}`, { referer: CAMPAIGN_PAGE });
    const html = result.text();
    const items = [];
    const pattern =
      /<div class='item adtype-(\d+)' data-offer='([^']+)'>[\s\S]*?<h5 class='title'>([^<]*)<\/h5>[\s\S]*?<span class='point icon-point has-number\s*'>([^<]*)<\/span>/g;
    for (const match of html.matchAll(pattern)) {
      items.push({
        adtype: match[1],
        offer: match[2],
        title: match[3].trim(),
        point: match[4].trim(),
      });
    }
    return {
      status: result.status,
      outcome: html.includes("로그아웃") ? "listed" : "auth_unverified",
      count: items.length,
      items,
    };
  }

  async jsonGet(url, params) {
    const result = await this.request(url, { query: params });
    return { status: result.status, json: result.json(), bodyLength: result.body.length };
  }

  async postForm(url, fields) {
    const result = await this.request(url, {
      method: "POST",
      body: new URLSearchParams(fields),
      referer: `${ORIGIN}/?ac=offer&tac=shopping`,
    });
    return { status: result.status, json: result.json(), bodyLength: result.body.length };
  }

  async postAjax(url, fields, referer) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const result = await this.request(url, {
      method: "POST",
      body: form,
      referer,
      accept: "application/json, text/javascript, */*; q=0.01",
    });
    return { status: result.status, json: result.json(), bodyLength: result.body.length };
  }

  async request(url, { method = "GET", query, body, accept, referer } = {}) {
    let current = new URL(url);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) current.searchParams.set(key, String(value));
      }
    }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!allowedHost(current.hostname) || current.protocol !== 'https:' || current.port || current.username || current.password) throw new CrossOriginRedirect(current.hostname);
      const headers = {
        Accept: accept || "application/json, text/html, */*",
        "User-Agent": USER_AGENT,
        Referer: referer || `${ORIGIN}/?ac=dashboard`,
      };
      const cookie = this.jar.header();
      if (cookie) headers.Cookie = cookie;
      let payload;
      if (body instanceof URLSearchParams) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        headers.Origin = ORIGIN;
        payload = body.toString();
      } else if (typeof FormData !== "undefined" && body instanceof FormData) {
        headers.Origin = ORIGIN;
        headers["X-Requested-With"] = "XMLHttpRequest";
        payload = body;
      }
      const response = await this.fetchImpl(current, {
        method,
        headers,
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const setCookies = typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
      for (const line of setCookies) this.jar.applySetCookie(line);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new AdpickError("redirect without location", { status: response.status });
        const next = new URL(location, current);
        if (!allowedHost(next.hostname) || next.protocol !== 'https:' || next.port || next.username || next.password) throw new CrossOriginRedirect(next.hostname);
        current = next;
        method = "GET";
        payload = undefined;
        continue;
      }
      if (!response.ok) throw new AdpickError("provider request was rejected", { status: response.status, outcome: "provider_error" });
      const reader = response.body?.getReader(), chunks = [];
      let size = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) { await reader.cancel(); throw new AdpickError("provider response exceeds size limit", { outcome: "schema_error" }); }
        chunks.push(Buffer.from(value));
      }
      const limited = Buffer.concat(chunks);
      const contentType = response.headers.get("content-type") || "";
      return new ResponseResult(response.status, contentType, limited);
    }
    throw new AdpickError("too many redirects", { outcome: "transport_error" });
  }
}

function boxResult(result) {
  const json = result.json || {};
  const ok = json.ret === "success" || json.status === 1 || json.status === "1";
  return {
    status: result.status,
    outcome: ok ? "saved" : json.ret || json.msg || json.message ? "rejected" : "unobserved_body",
    ret: json.ret ?? null,
    message: json.msg || json.message || "",
    bodyLength: result.bodyLength,
  };
}

class ResponseResult {
  constructor(status, contentType, body) {
    this.status = status;
    this.contentType = contentType;
    this.body = body;
  }

  text() {
    return this.body.toString("utf8");
  }

  json() {
    const text = this.text().trim();
    if (!text) throw new AdpickError("provider response was empty", { outcome: "schema_error" });
    try {
      return JSON.parse(text);
    } catch {
      throw new AdpickError("provider response is not JSON", { outcome: "schema_error" });
    }
  }
}
