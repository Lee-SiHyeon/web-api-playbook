import { AdpickSdk } from "../src/sdk.js";
import { readJson, run, sendJson } from "../src/http.js";
import { affiliateLocation } from "../src/tools.js";

export default async function handler(req, res) {
  await run(req, res, async () => {
    if (req.method !== "POST") {
      return sendJson(res, 405, { outcome: "method_not_allowed" });
    }
    const body = await readJson(req);
    const result = await AdpickSdk.fromEnv().profitLink({
      url: body.url || "",
      forceRedirect: false,
    });
    const redirect = body.redirect === true;
    if (redirect) {
      const location = affiliateLocation(result.link);
      if (!location) {
        return sendJson(res, 502, { outcome: "unobserved_body", message: "affiliate host was not in the response" });
      }
      res.statusCode = 302;
      res.setHeader("Location", location);
      res.setHeader("Cache-Control", "no-store");
      res.end();
      return;
    }
    sendJson(res, 200, result);
  });
}
