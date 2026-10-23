import { AdpickError, CrossOriginRedirect } from "./client.js";
import { affiliateLocation } from "./tools.js";

const ALLOWED = new Set(["adpick.co.kr", "www.adpick.co.kr", "deg.kr"]);
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export class AdpickSdk {
  constructor({
    apiKey = "",
    affid = "",
    fetchImpl = globalThis.fetch,
    timeoutMs = 20000,
  } = {}) {
    this.apiKey = apiKey;
    this.affid = affid;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  static fromEnv(env = process.env) {
    return new AdpickSdk({
      apiKey: env.ADPICK_API_KEY || "",
      affid: env.ADPICK_AFFID || "",
    });
  }

  async offers({ os = "", adtype = "", category = "", order = "" } = {}) {
    this.#requireAffid();
    return this.#getJson("https://adpick.co.kr/apis/offers.php", {
      affid: this.affid,
      os,
      adtype,
      category,
      order,
    });
  }

  async shopping() {
    this.#requireAffid();
    return this.#getJson("https://adpick.co.kr/apis/sdk_shopping.php", { affid: this.affid });
  }

  async hotdeal() {
    this.#requireAffid();
    return this.#getJson("https://adpick.co.kr/apis/sdk_shopping_hotdeal.php", { affid: this.affid });
  }

  async profitLink({ url, forceRedirect = false } = {}) {
    this.#requireKey();
    if (!url || !/^https:\/\//.test(url)) {
      throw new AdpickError("https product url is required", { outcome: "bad_request" });
    }
    const query = { apikey: this.apiKey, print: "1", url };
    if (forceRedirect) query.forceredirect = "true";
    const result = await this.#getJson("https://deg.kr/cps/click.php", query);
    const link = affiliateLocation(result.json?.link);
    if (!link) throw new AdpickError("profit link was rejected or had an unsafe response", { outcome: "outcome_unknown" });
    return {
      status: result.status,
      link,
      code: result.json?.status ?? null,
      message: result.json?.msg || "",
    };
  }

  #requireKey() {
    if (!this.apiKey) throw new AdpickError("ADPICK_API_KEY is not set", { outcome: "provider_missing" });
  }

  #requireAffid() {
    if (!this.affid) throw new AdpickError("ADPICK_AFFID is not set", { outcome: "provider_missing" });
  }

  async #getJson(url, query) {
    const current = new URL(url);
    if (!ALLOWED.has(current.hostname)) throw new CrossOriginRedirect(current.hostname);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") current.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await this.fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "application/json, text/plain, */*", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AdpickError("sdk request failed", { outcome: "transport_error" });
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") || "";
      let host = "";
      try {
        host = new URL(location, current).hostname;
      } catch {
        host = "";
      }
      throw new CrossOriginRedirect(host || "redirect");
    }
    const reader = response.body?.getReader();
    const chunks = [];
    let bytes = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new AdpickError("sdk response exceeds size limit", { outcome: "schema_error" });
        }
        chunks.push(Buffer.from(value));
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AdpickError("sdk response is not JSON", { outcome: "schema_error" });
    }
    if (!response.ok || !json || typeof json !== "object") throw new AdpickError("sdk response was rejected", { status: response.status, outcome: "provider_error" });
    return { status: response.status, json, bodyLength: text.length };
  }
}
