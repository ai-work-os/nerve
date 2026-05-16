/**
 * blob-client — HTTP client for the `screenshot` plugin's endpoints.
 * Used by mac-clipboard to fetch screenshots, list pending deliveries, and ack.
 */
export interface DownloadedBlob {
  data: Buffer;
  mimeType: string;
}

export interface PendingEntry {
  blobId: string;
  takenAtMs: number;
  source: string;
}

/** Download a blob by id. Returns null on 404 / non-2xx. */
export async function downloadBlob(httpBase: string, blobId: string): Promise<DownloadedBlob | null> {
  const res = await fetch(`${httpBase}/screenshot/blob/${encodeURIComponent(blobId)}`);
  if (!res.ok) return null;
  const data = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") || "application/octet-stream";
  return { data, mimeType };
}

/** List screenshots not yet delivered to Mac. */
export async function fetchPendingMac(httpBase: string): Promise<PendingEntry[]> {
  const res = await fetch(`${httpBase}/screenshot/pending-mac`);
  if (!res.ok) return [];
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

/** Tell the screenshot plugin a screenshot has been delivered to Mac. */
export async function ackMac(httpBase: string, blobId: string): Promise<void> {
  await fetch(`${httpBase}/screenshot/ack-mac`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blobId }),
  });
}
