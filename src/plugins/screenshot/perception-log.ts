/**
 * perception-log — appends one line per screenshot to a per-day text file.
 * This is the "home knows what's around me" passive-awareness output.
 */
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { localIso } from "../../infra/time-util.js";
import type { ScreenshotRecord } from "./screenshot-index.js";

function pad(n: number): string { return String(n).padStart(2, "0"); }

function dayFile(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.txt`;
}

/** Append a perception-log line for `rec`. Returns the file path written. */
export function appendPerceptionLog(logDir: string, rec: ScreenshotRecord): string {
  mkdirSync(logDir, { recursive: true });
  const path = join(logDir, dayFile(rec.receivedAtMs));
  const line = `${localIso()} [${rec.source}] screenshot blob=${rec.blobId} analyze=${rec.analyze}`;
  appendFileSync(path, line + "\n");
  return path;
}
