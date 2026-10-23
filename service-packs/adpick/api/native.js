import { AdpickSdk } from "../src/sdk.js";
import { queryOf, run, sendJson } from "../src/http.js";
import { nativeSource } from "../src/tools.js";

export default async function handler(req, res) {
  await run(req, res, async () => {
    if (req.method !== "GET") return sendJson(res, 405, { outcome: "method_not_allowed" });
    const query = queryOf(req);
    const source = nativeSource({
      affid: AdpickSdk.fromEnv().affid,
      bannerType: query.bannerType || "type5",
      limit: query.limit || 1,
    });
    sendJson(res, 200, source);
  });
}
