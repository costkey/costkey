import { gunzipSync } from "node:zlib";

/** A request body as the server reads it: gzipped deliveries unpacked. */
export function wireBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) {
    const headers = new Headers(init?.headers);
    return headers.get("content-encoding") === "gzip" ? gunzipSync(body).toString("utf8") : Buffer.from(body).toString("utf8");
  }
  return String(body);
}
