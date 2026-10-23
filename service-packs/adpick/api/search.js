import { clientFrom, queryOf, run, sendJson } from "../src/http.js";

export default async function handler(req, res) {
  await run(req, res, async () => {
    if (req.method !== "GET") return sendJson(res, 405, { outcome: "method_not_allowed" });
    const query = queryOf(req);
    if (!query.q) return sendJson(res, 400, { outcome: "bad_request", message: "q is required" });
    const result = await clientFrom(req).searchProducts(query.q, {
      sort: query.sort || "rel",
      page: query.page || 1,
      offers: query.offers || "",
    });
    sendJson(res, 200, result);
  });
}
