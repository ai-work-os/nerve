import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenshotStore } from "../../src/plugins/screenshot/screenshot-store.js";

/** Per-day filename helper — mirrors store's local-date logic. */
function dayFileFor(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.txt`;
}

describe("ScreenshotStore", () => {
  let dir: string;
  let store: ScreenshotStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ss-store-"));
    store = new ScreenshotStore(dir);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe("store()", () => {
    it("写 blob + 加索引 + 写感知日志 + 返回频道文本", () => {
      const data = Buffer.from("FAKE-SCREENSHOT");
      const r = store.store(data, {
        source: "pixel8", analyze: true, takenAtMs: 1747000000000, mimeType: "image/jpeg",
      });
      expect(r.record.blobId).toMatch(/^[a-f0-9]{64}$/);
      expect(store.get(r.record.blobId)?.data).toEqual(data);
      expect(store.all()).toHaveLength(1);
      expect(r.record.mimeType).toBe("image/jpeg");
      expect(r.channelText).toContain(`blob=${r.record.blobId}`);
      expect(r.channelText).toContain("source=pixel8");
      expect(r.channelText).toContain("analyze=true");
      expect(r.channelText.startsWith("📷")).toBe(true);
    });

    it("缺 mimeType 时 record.mimeType 默认 image/png", () => {
      const r = store.store(Buffer.from("z"), {
        source: "phone", analyze: false, takenAtMs: 1747000000000,
      });
      expect(r.record.mimeType).toBe("image/png");
    });

    it("新记录 deliveredToMac 默认 false（进 pendingMac）", () => {
      store.store(Buffer.from("x"), { source: "phone", analyze: false, takenAtMs: 1747000000000 });
      expect(store.pendingMac()).toHaveLength(1);
    });

    it("感知日志按天文件名写入一行，含 source / blobId / analyze", () => {
      const r = store.store(Buffer.from("y"), {
        source: "pixel8", analyze: true,
        takenAtMs: new Date("2026-05-16T09:00:00+08:00").getTime(),
      });
      const path = join(dir, "log", dayFileFor(r.record.receivedAtMs));
      expect(existsSync(path)).toBe(true);
      const line = readFileSync(path, "utf8").trim();
      expect(line).toContain("pixel8");
      expect(line).toContain(r.record.blobId);
      expect(line).toContain("analyze=true");
    });

    it("感知日志追加而非覆盖", () => {
      store.store(Buffer.from("a"), { source: "phone", analyze: false, takenAtMs: Date.now() });
      const r = store.store(Buffer.from("b"), { source: "phone", analyze: false, takenAtMs: Date.now() });
      const path = join(dir, "log", dayFileFor(r.record.receivedAtMs));
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
    });
  });

  describe("blob content-addressing", () => {
    it("相同内容 store 两次返回同一 blobId（去重）", () => {
      const a = store.store(Buffer.from("same"), { source: "p", analyze: false, takenAtMs: 0 });
      const b = store.store(Buffer.from("same"), { source: "p", analyze: false, takenAtMs: 0 });
      expect(a.record.blobId).toBe(b.record.blobId);
    });

    it("不同内容返回不同 blobId", () => {
      const a = store.store(Buffer.from("a"), { source: "p", analyze: false, takenAtMs: 0 });
      const b = store.store(Buffer.from("b"), { source: "p", analyze: false, takenAtMs: 0 });
      expect(a.record.blobId).not.toBe(b.record.blobId);
    });
  });

  describe("get()", () => {
    it("get 不存在 id 返回 null", () => {
      expect(store.get("a".repeat(64))).toBeNull();
    });

    it("get 非法 id（路径穿越）返回 null，不读到目录外文件", () => {
      expect(store.get("../../../etc/passwd")).toBeNull();
    });

    it("blob 存在但无 index 记录时回退到 application/octet-stream", () => {
      // 通过 store 写入产生 blob 文件
      const r = store.store(Buffer.from("orphan"), {
        source: "p", analyze: false, takenAtMs: 0, mimeType: "image/jpeg",
      });
      // 把索引清空（模拟 blob 残留 + 索引丢失）
      const removed = store.prune(new Set<string>());
      expect(removed).toBe(1);
      const got = store.get(r.record.blobId);
      expect(got?.data).toEqual(Buffer.from("orphan"));
      expect(got?.mimeType).toBe("application/octet-stream");
    });
  });

  describe("markDelivered() / pendingMac()", () => {
    it("markDelivered 把记录标为已投递并持久化", () => {
      const r = store.store(Buffer.from("x"), { source: "p", analyze: false, takenAtMs: 0 });
      expect(store.markDelivered(r.record.blobId)).toBe(true);
      expect(store.pendingMac()).toHaveLength(0);
      // 持久化：新实例加载也是空 pending
      expect(new ScreenshotStore(dir).pendingMac()).toHaveLength(0);
    });

    it("markDelivered 未知 blobId 返回 false", () => {
      expect(store.markDelivered("f".repeat(64))).toBe(false);
    });

    it("markDelivered 标记同一 blobId 的所有重复记录", () => {
      // 同一内容写两遍 → 两条 record 共享一个 blobId（内容寻址会产生重复）
      const a = store.store(Buffer.from("dup"), { source: "p", analyze: false, takenAtMs: 0 });
      store.store(Buffer.from("dup"), { source: "p", analyze: false, takenAtMs: 0 });
      store.store(Buffer.from("other"), { source: "p", analyze: false, takenAtMs: 0 });
      expect(store.markDelivered(a.record.blobId)).toBe(true);
      // 两条 dup 都被标记，pendingMac 只剩 other
      const pending = store.pendingMac();
      expect(pending).toHaveLength(1);
      expect(pending[0].blobId).not.toBe(a.record.blobId);
    });

    it("pendingMac 只返回未投递的", () => {
      const a = store.store(Buffer.from("a"), { source: "p", analyze: false, takenAtMs: 0 });
      store.store(Buffer.from("b"), { source: "p", analyze: false, takenAtMs: 0 });
      store.markDelivered(a.record.blobId);
      expect(store.pendingMac()).toHaveLength(1);
    });
  });

  describe("persistence", () => {
    it("记录持久化到磁盘，新实例能加载", () => {
      store.store(Buffer.from("p1"), { source: "p", analyze: false, takenAtMs: 0 });
      const reloaded = new ScreenshotStore(dir);
      expect(reloaded.all()).toHaveLength(1);
    });

    it("索引文件不存在时构造为空索引，不抛错", () => {
      const fresh = mkdtempSync(join(tmpdir(), "ss-fresh-"));
      try {
        expect(new ScreenshotStore(fresh).all()).toEqual([]);
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    });
  });

  describe("prune()", () => {
    it("丢弃不在 keepBlobIds 里的记录，返回删除数，持久化", () => {
      const a = store.store(Buffer.from("a"), { source: "p", analyze: false, takenAtMs: 0 });
      const b = store.store(Buffer.from("b"), { source: "p", analyze: false, takenAtMs: 0 });
      const c = store.store(Buffer.from("c"), { source: "p", analyze: false, takenAtMs: 0 });
      const removed = store.prune(new Set([b.record.blobId]));
      expect(removed).toBe(2);
      expect(store.all()).toHaveLength(1);
      expect(store.all()[0].blobId).toBe(b.record.blobId);
      // persisted
      expect(new ScreenshotStore(dir).all()).toHaveLength(1);
      // unused vars to silence linter
      void a; void c;
    });

    it("全部保留时返回 0", () => {
      const a = store.store(Buffer.from("a"), { source: "p", analyze: false, takenAtMs: 0 });
      const b = store.store(Buffer.from("b"), { source: "p", analyze: false, takenAtMs: 0 });
      expect(store.prune(new Set([a.record.blobId, b.record.blobId]))).toBe(0);
      expect(store.all()).toHaveLength(2);
    });
  });
});
