import { clientFrom, readJson, run, sendJson } from "../src/http.js";
import { boxPage } from "../src/tools.js";

export default async function handler(req, res) {
  await run(req, res, async () => {
    if (req.method !== "POST") return sendJson(res, 405, { outcome: "method_not_allowed" });
    const body = await readJson(req);
    const saved = await clientFrom(req).saveShopbox(body);
    const page = boxPage("shopbox", process.env.ADPICK_AFFID || "");
    sendJson(res, 200, page ? { ...saved, page } : saved);
  });
}
