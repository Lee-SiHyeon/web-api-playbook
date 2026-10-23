import { AdpickClient } from "../src/client.js";
import { readJson, run, sendJson } from "../src/http.js";

export default async function handler(req, res) {
  await run(req, res, async () => {
    if (req.method !== "POST") return sendJson(res, 405, { outcome: "method_not_allowed" });
    const body = await readJson(req);
    const client = new AdpickClient();
    const result = await client.login({
      email: body.email,
      password: body.password,
      captcha: body.captcha,
      captchaCookie: body.captchaCookie,
    });
    sendJson(res, result.outcome === "login_succeeded" ? 200 : 401, {
      outcome: result.outcome,
      status: result.status,
      cookieNames: result.cookieNames,
      cookieHeader: result.cookieHeader,
    });
  });
}
