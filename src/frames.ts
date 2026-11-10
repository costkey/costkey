import { createHash } from "node:crypto";

/**
 * Screen capture: images an agent sends to the model (its screenshots) are
 * uploaded once each, keyed by SHA-256, and the call event lists them in
 * request order. Which image is the frame for a step is decided on the server.
 * Off unless enabled both locally (`captureScreens`) and for the project.
 */

/** One image in a call's request, as listed on the call event. */
export interface FrameRef {
  /** SHA-256 of the decoded image bytes, hex. */
  sha256: string;
  mediaType: string;
  /** Decoded size in bytes. */
  bytes: number;
  /** Set when the image was not uploaded. */
  omitted?: "too_large";
}

/** Image bytes waiting to be uploaded. */
export interface FrameUpload {
  sha256: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface ExtractedFrames {
  /** Every image in the request, in order (history first, newest last). */
  refs: FrameRef[];
  /** Uploadable bytes by hash; images over the size cap are not here. */
  uploads: Map<string, FrameUpload>;
  /** Hash by the request's own string value, so captured bodies can name the frame. */
  byValue: Map<string, string>;
}

/** Images larger than this are listed but not uploaded (size cap, no resizing). */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

const MAX_DEPTH = 32;
const DATA_URI = /^data:(image\/[a-z0-9.+-]+)(?:;[a-z0-9=._-]+)*;base64,/i;
const MEDIA_TYPE_KEYS = ["media_type", "mimeType", "mime_type"] as const;

/** Every base64 image in a provider request (data URIs and `{media_type, data}` parts). */
export function extractFrames(body: unknown): ExtractedFrames {
  const found: ExtractedFrames = { refs: [], uploads: new Map(), byValue: new Map() };
  walk(body, 0, found);
  return found;
}

function walk(value: unknown, depth: number, found: ExtractedFrames): void {
  if (depth > MAX_DEPTH || value == null) return;
  if (typeof value === "string") {
    const match = value.length > 64 ? value.match(DATA_URI) : null;
    if (match) addFrame(found, value, value.slice(match[0].length), match[1]!.toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, depth + 1, found);
    return;
  }
  if (typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  const data = object["data"];
  if (typeof data === "string" && data.length > 64) {
    const declared = declaredImageType(object);
    const mediaType = declared ?? (isImagePart(object) ? sniffImageType(data) : null);
    if (mediaType) addFrame(found, data, data, mediaType);
  }
  for (const [key, entry] of Object.entries(object)) {
    if (key === "data" && typeof entry === "string") continue;
    walk(entry, depth + 1, found);
  }
}

function declaredImageType(object: Record<string, unknown>): string | null {
  for (const key of MEDIA_TYPE_KEYS) {
    const value = object[key];
    if (typeof value === "string" && value.toLowerCase().startsWith("image/")) return value.toLowerCase();
  }
  return null;
}

function isImagePart(object: Record<string, unknown>): boolean {
  return object["type"] === "image" || object["type"] === "input_image" || object["type"] === "base64";
}

/** The image type from the first base64 characters, for parts that don't declare one. */
function sniffImageType(base64: string): string | null {
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  return null;
}

function addFrame(found: ExtractedFrames, original: string, base64: string, mediaType: string): void {
  const known = found.byValue.get(original);
  if (known) {
    const ref = found.refs.find((entry) => entry.sha256 === known);
    if (ref) found.refs.push(ref);
    return;
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return;
  }
  if (bytes.length === 0) return;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  found.byValue.set(original, sha256);
  if (bytes.length > MAX_FRAME_BYTES) {
    found.refs.push({ sha256, mediaType, bytes: bytes.length, omitted: "too_large" });
    return;
  }
  found.refs.push({ sha256, mediaType, bytes: bytes.length });
  if (!found.uploads.has(sha256)) found.uploads.set(sha256, { sha256, mediaType, bytes });
}
