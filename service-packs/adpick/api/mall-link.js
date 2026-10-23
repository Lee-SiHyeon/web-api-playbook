import { clientFrom, readJson, run, sendJson } from "../src/http.js";

export default async function handler(req, res) {
  await run(req, res, async () => {
    if (req.method !== "POST") return sendJson(res, 405, { outcome: "method_not_allowed" });
    const body = await readJson(req);
    sendJson(res, 200, await clientFrom(req).createMallLink(body.offer));
  });
}
