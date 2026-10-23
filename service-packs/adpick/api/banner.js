import { clientFrom, queryOf, readJson, run, sendJson } from "../src/http.js";

export default async function handler(req, res) {
  await run(req, res, async () => {
    if (req.method === "GET") {
      const query = queryOf(req);
      return sendJson(res, 200, await clientFrom(req).banners({ page: query.page || 1 }));
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      return sendJson(res, 200, await clientFrom(req).createBanner({ url: body.url, offer: body.offer || "rand" }));
    }
    return sendJson(res, 405, { outcome: "method_not_allowed" });
  });
}
