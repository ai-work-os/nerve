/**
 * clipboard — writes an image file into the macOS clipboard via osascript.
 * PNG and JPEG are supported (the two formats AppleScript can read directly);
 * other formats are skipped (the file is still saved to disk by the caller).
 */
import { execFileSync } from "node:child_process";

const CLIPBOARD_CLASS: Record<string, string> = {
  "image/png": "«class PNGf»",
  "image/jpeg": "«class JPEG»",
};

/** Build the AppleScript to load `filePath` into the clipboard, or null if unsupported. */
export function buildClipboardScript(filePath: string, mimeType: string): string | null {
  const cls = CLIPBOARD_CLASS[mimeType];
  if (!cls) return null;
  return `set the clipboard to (read (POSIX file ${JSON.stringify(filePath)}) as ${cls})`;
}

/** Copy an image file into the macOS clipboard. Returns false on unsupported type or failure. */
export function copyImageToClipboard(filePath: string, mimeType: string): boolean {
  const script = buildClipboardScript(filePath, mimeType);
  if (!script) return false;
  try {
    execFileSync("osascript", ["-e", script], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
