/**
 * upload-handler — composes blob store + index + perception log for one
 * incoming screenshot. Pure of network concerns so it is unit-testable;
 * the caller posts `channelText` to the channel.
 */
import { BlobStore } from "./blob-store.js";
import { ScreenshotIndex, type ScreenshotRecord } from "./screenshot-index.js";
import { appendPerceptionLog } from "./perception-log.js";

export interface UploadDeps {
  blobs: BlobStore;
  index: ScreenshotIndex;
  logDir: string;
}

export interface UploadMeta {
  source: string;
  analyze: boolean;
  takenAtMs: number;
}

export interface UploadResult {
  record: ScreenshotRecord;
  channelText: string;
}

/** Store `data`, index it, log it, and build the `#screenshots` channel text. */
export function processUpload(deps: UploadDeps, data: Buffer, meta: UploadMeta): UploadResult {
  const blobId = deps.blobs.put(data);
  const record: ScreenshotRecord = {
    blobId,
    source: meta.source,
    takenAtMs: meta.takenAtMs,
    receivedAtMs: Date.now(),
    analyze: meta.analyze,
    deliveredToMac: false,
  };
  deps.index.add(record);
  appendPerceptionLog(deps.logDir, record);
  const channelText =
    `📷 screenshot | blob=${blobId} | source=${meta.source} | analyze=${meta.analyze}`;
  return { record, channelText };
}
