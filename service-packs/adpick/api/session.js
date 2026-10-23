import { clientFrom, run, sendJson } from "../src/http.js";

export default async function handler(req, res) {
  await run(req, res, async () => {
    if (req.method !== "GET") return sendJson(res, 405, { outcome: "method_not_allowed" });
    const session = await clientFrom(req).session();
    sendJson(res, 200, session);
  });
}
