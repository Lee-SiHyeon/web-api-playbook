import { AdpickSdk } from "../src/sdk.js";
import { run, sendJson } from "../src/http.js";

export default async function handler(req, res) {
  await run(req, res, async () => {
    if (req.method !== "GET") return sendJson(res, 405, { outcome: "method_not_allowed" });
    const result = await AdpickSdk.fromEnv().shopping();
    sendJson(res, 200, { status: result.status, items: result.json });
  });
}
