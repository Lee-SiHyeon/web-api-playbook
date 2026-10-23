import { clientFrom, queryOf, run, sendJson } from "../src/http.js";

export default async function handler(req, res) {
  await run(req, res, async () => {
    if (req.method !== "GET") return sendJson(res, 405, { outcome: "method_not_allowed" });
    const query = queryOf(req);
    sendJson(res, 200, await clientFrom(req).hotdeal({ page: query.page || 1, viewlist: query.viewlist || 10 }));
  });
}
