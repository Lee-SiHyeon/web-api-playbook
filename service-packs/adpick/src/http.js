import { AdpickClient, AdpickError } from "./client.js";
import { createHash, timingSafeEqual } from "node:crypto";

export function authorized(req, expected = process.env.ADPICK_SERVICE_TOKEN) {
  if (!expected || expected.length < 32) return false;
  const header = req.headers.authorization || "";
  if (typeof header !== "string" || header.length > 512) return false;
  const provided = /^Bearer ([^\s]+)$/.exec(header)?.[1];
  if (!provided) return false;
  const hash = value => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(provided), hash(expected));
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 65536) throw new AdpickError("request body is too large", { outcome: "bad_request" });
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AdpickError("JSON body is required", { outcome: "bad_request" });
  }
}

export function clientFrom(req) {
  if (!process.env.ADPICK_COOKIE) throw new AdpickError("ADPICK_COOKIE is not set", { outcome: "provider_missing" });
  return AdpickClient.fromEnv();
}

export function queryOf(req) {
  return Object.fromEntries(new URL(req.url, "https://local").searchParams);
}

export async function run(req, res, work) {
  if (!process.env.ADPICK_SERVICE_TOKEN || process.env.ADPICK_SERVICE_TOKEN.length < 32) {
    return sendJson(res, 503, { outcome: "provider_missing", message: "ADPICK_SERVICE_TOKEN is not set" });
  }
  if (!authorized(req)) return sendJson(res, 401, { outcome: "unauthorized" });
  try {
    await work();
  } catch (error) {
    const known = error?.name === "AdpickError" || error?.name === "CrossOriginRedirect";
    const status = error?.outcome === "bad_request" ? 400 : error?.outcome === "provider_missing" ? 503 : 502;
    sendJson(res, status, {
      outcome: error?.outcome || "transport_error",
      message: known ? error.message : "request failed",
    });
  }
}
