/**
 * message-parser — extracts the blobId from a #screenshots channel message
 * posted by the `screenshot` plugin: "📷 screenshot | blob=<id> | source=... | analyze=...".
 */
export interface ParsedScreenshot {
  blobId: string;
}

const BLOB_RE = /blob=([a-f0-9]{64})\b/;

/** Return the screenshot reference, or null if `content` is not a screenshot message. */
export function parseScreenshotMessage(content: string): ParsedScreenshot | null {
  if (!content || !content.includes("📷 screenshot")) return null;
  const m = content.match(BLOB_RE);
  if (!m) return null;
  return { blobId: m[1] };
}
