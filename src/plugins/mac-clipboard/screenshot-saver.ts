/**
 * screenshot-saver — writes screenshot bytes to the Mac inbox folder.
 * Filename: <YYYY-MM-DD_HHmmss>_<blobId-prefix>.<ext>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Map a MIME type to a file extension; unknown types fall back to "bin". */
export function extensionFor(mimeType: string): string {
  return EXT[mimeType] ?? "bin";
}

function pad(n: number): string { return String(n).padStart(2, "0"); }

function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Write `data` into `dir`, returning the full file path written. */
export function saveScreenshot(
  dir: string, blobId: string, data: Buffer, mimeType: string, takenAtMs: number,
): string {
  mkdirSync(dir, { recursive: true });
  const name = `${stamp(takenAtMs)}_${blobId.slice(0, 8)}.${extensionFor(mimeType)}`;
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}
