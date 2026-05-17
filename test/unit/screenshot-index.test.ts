import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenshotIndex, type ScreenshotRecord } from "../../src/plugins/screenshot/screenshot-index.js";

function rec(overrides: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  return {
    blobId: "a".repeat(64),
    source: "phone",
    mimeType: "image/png",
    takenAtMs: 1747000000000,
    receivedAtMs: 1747000001000,
    analyze: false,
    deliveredToMac: false,
    ...overrides,
  };
}

describe("ScreenshotIndex", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ss-index-"));
    file = join(dir, "index.json");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("add 后 all() 能取回记录", () => {
    const idx = new ScreenshotIndex(file);
    idx.add(rec());
    expect(idx.all()).toHaveLength(1);
    expect(idx.all()[0].blobId).toBe("a".repeat(64));
  });

  it("记录持久化到磁盘，新实例能加载", () => {
    new ScreenshotIndex(file).add(rec({ blobId: "b".repeat(64) }));
    const reloaded = new ScreenshotIndex(file);
    expect(reloaded.all()).toHaveLength(1);
    expect(reloaded.all()[0].blobId).toBe("b".repeat(64));
  });

  it("pendingMac 只返回 deliveredToMac=false 的记录", () => {
    const idx = new ScreenshotIndex(file);
    idx.add(rec({ blobId: "c".repeat(64), deliveredToMac: true }));
    idx.add(rec({ blobId: "d".repeat(64), deliveredToMac: false }));
    const pending = idx.pendingMac();
    expect(pending).toHaveLength(1);
    expect(pending[0].blobId).toBe("d".repeat(64));
  });

  it("markDelivered 把记录标记为已投递并持久化", () => {
    const idx = new ScreenshotIndex(file);
    idx.add(rec({ blobId: "e".repeat(64) }));
    expect(idx.markDelivered("e".repeat(64))).toBe(true);
    expect(idx.pendingMac()).toHaveLength(0);
    expect(new ScreenshotIndex(file).pendingMac()).toHaveLength(0);
  });

  it("markDelivered 未知 blobId 返回 false", () => {
    expect(new ScreenshotIndex(file).markDelivered("f".repeat(64))).toBe(false);
  });

  it("markDelivered 标记同一 blobId 的所有重复记录（内容寻址会产生重复）", () => {
    const idx = new ScreenshotIndex(file);
    const dup = "9".repeat(64);
    idx.add(rec({ blobId: dup }));
    idx.add(rec({ blobId: dup }));
    idx.add(rec({ blobId: "8".repeat(64) }));
    expect(idx.markDelivered(dup)).toBe(true);
    // 两条 dup 记录都被标记，pendingMac 只剩下另一个 blobId
    const pending = idx.pendingMac();
    expect(pending).toHaveLength(1);
    expect(pending[0].blobId).toBe("8".repeat(64));
  });

  it("索引文件不存在时构造为空索引，不抛错", () => {
    expect(new ScreenshotIndex(join(dir, "no-such.json")).all()).toEqual([]);
  });

  it("prune 丢弃不在 keepBlobIds 里的记录，返回删除数，持久化", () => {
    const idx = new ScreenshotIndex(file);
    idx.add(rec({ blobId: "1".repeat(64) }));
    idx.add(rec({ blobId: "2".repeat(64) }));
    idx.add(rec({ blobId: "3".repeat(64) }));
    const removed = idx.prune(new Set(["2".repeat(64)]));
    expect(removed).toBe(2);
    expect(idx.all()).toHaveLength(1);
    expect(idx.all()[0].blobId).toBe("2".repeat(64));
    // persisted: reloading sees the pruned state
    const reloaded = new ScreenshotIndex(file);
    expect(reloaded.all()).toHaveLength(1);
    expect(reloaded.all()[0].blobId).toBe("2".repeat(64));
  });

  it("prune 全部保留时返回 0", () => {
    const idx = new ScreenshotIndex(file);
    idx.add(rec({ blobId: "1".repeat(64) }));
    idx.add(rec({ blobId: "2".repeat(64) }));
    expect(idx.prune(new Set(["1".repeat(64), "2".repeat(64)]))).toBe(0);
    expect(idx.all()).toHaveLength(2);
  });
});
