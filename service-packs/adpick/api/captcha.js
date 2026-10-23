import { AdpickClient } from "../src/client.js";
import { run, sendJson } from "../src/http.js";

export default async function handler(req, res) {
  await run(req, res, async () => {
    if (req.method !== "GET") return sendJson(res, 405, { outcome: "method_not_allowed" });
    const captcha = await new AdpickClient().fetchCaptcha();
    sendJson(res, 200, {
      status: captcha.status,
      contentType: captcha.contentType,
      imageBase64: Buffer.from(captcha.bytes).toString("base64"),
      captchaCookie: captcha.captchaCookie,
    });
  });
}
