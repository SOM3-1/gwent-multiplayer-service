import { allowedOrigin } from "./config.mjs";

export function sendJson(res, statusCode, payload, origin = "*") {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(payload));
}

export function getOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return allowedOrigin === "*" ? "*" : allowedOrigin;
  }
  if (allowedOrigin === "*" || origin === allowedOrigin) {
    return origin;
  }
  return allowedOrigin;
}

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
