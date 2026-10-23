import { AdpickSdk } from "../src/sdk.js";
import { queryOf, run, sendJson } from "../src/http.js";

export default async function handler(req, res) {
  await run(req, res, async () => {
    if (req.method !== "GET") return sendJson(res, 405, { outcome: "method_not_allowed" });
    const query = queryOf(req);
    const result = await AdpickSdk.fromEnv().offers({
      os: query.os || "",
      adtype: query.adtype || "",
      category: query.category || "",
      order: query.order || "",
    });
    sendJson(res, 200, { status: result.status, items: result.json });
  });
}
