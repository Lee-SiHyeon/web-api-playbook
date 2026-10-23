import { createHash } from "node:crypto";
import { run, sendJson, clientFrom } from "../src/http.js";

export default async function handler(req, res) {
  await run(req, res, async () => {
    if (req.method !== "GET") return sendJson(res, 405, { outcome: "method_not_allowed" });
    const env = process.env;
    const cookieConfigured = Boolean(env.ADPICK_COOKIE);
    const accountDigest = env.ADPICK_AFFID
      ? createHash("sha256").update(env.ADPICK_AFFID).digest("hex") : null;
    const session = cookieConfigured ? await clientFrom(req).session() : null;
    sendJson(res, 200, {
      execution: "pure_http", accountDigest,
      configured: { sdk: Boolean(env.ADPICK_AFFID), link: Boolean(env.ADPICK_API_KEY), cookie: cookieConfigured },
      session: session ? { status: session.status, outcome: session.outcome } : { outcome: "not_configured" },
    });
  });
}
