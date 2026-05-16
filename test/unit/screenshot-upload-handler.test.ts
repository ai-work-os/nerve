import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../src/plugins/screenshot/blob-store.js";
import { ScreenshotIndex } from "../../src/plugins/screenshot/screenshot-index.js";
import { processUpload } from "../../src/plugins/screenshot/upload-handler.js";

describe("processUpload", () => {
  let dir: string;
  let blobs: BlobStore;
  let index: ScreenshotIndex;
  let logDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ss-upload-"));
    blobs = new BlobStore(join(dir, "blobs"));
    index = new ScreenshotIndex(join(dir, "index.json"));
    logDir = join(dir, "log");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("存 blob、加索引、写感知日志，返回 record 和频道文本", () => {
    const data = Buffer.from("FAKE-SCREENSHOT");
    const r = processUpload({ blobs, index, logDir }, data, {
      source: "pixel8", analyze: true, takenAtMs: 1747000000000,
    });
    expect(blobs.get(r.record.blobId)).toEqual(data);
    expect(index.all()).toHaveLength(1);
    expect(r.channelText).toContain(`blob=${r.record.blobId}`);
    expect(r.channelText).toContain("source=pixel8");
    expect(r.channelText).toContain("analyze=true");
    expect(r.channelText.startsWith("📷")).toBe(true);
  });

  it("新记录 deliveredToMac 默认为 false（进 pendingMac）", () => {
    processUpload({ blobs, index, logDir }, Buffer.from("x"), {
      source: "phone", analyze: false, takenAtMs: 1747000000000,
    });
    expect(index.pendingMac()).toHaveLength(1);
  });

  it("感知日志文件被写入一行", () => {
    const r = processUpload({ blobs, index, logDir }, Buffer.from("y"), {
      source: "phone", analyze: false, takenAtMs: new Date("2026-05-16T09:00:00+08:00").getTime(),
    });
    const log = readFileSync(join(logDir, "2026-05-16.txt"), "utf8");
    expect(log).toContain(r.record.blobId);
  });
});
