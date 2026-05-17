import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../src/plugins/screenshot/blob-store.js";

describe("BlobStore", () => {
  let dir: string;
  let store: BlobStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ss-blob-"));
    store = new BlobStore(dir);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("put 返回 64 位 hex 内容地址，get 取回原字节", () => {
    const data = Buffer.from("FAKE-PNG-BYTES");
    const id = store.put(data);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(store.get(id)).toEqual(data);
  });

  it("相同内容 put 两次返回同一 id（去重）", () => {
    const data = Buffer.from("same-bytes");
    expect(store.put(data)).toBe(store.put(data));
  });

  it("不同内容返回不同 id", () => {
    expect(store.put(Buffer.from("a"))).not.toBe(store.put(Buffer.from("b")));
  });

  it("get 不存在的 id 返回 null", () => {
    expect(store.get("a".repeat(64))).toBeNull();
  });

  it("has 正确反映存在性", () => {
    const id = store.put(Buffer.from("x"));
    expect(store.has(id)).toBe(true);
    expect(store.has("b".repeat(64))).toBe(false);
  });

  it("非法 id（路径穿越）返回 null，不读到目录外文件", () => {
    expect(store.get("../../../etc/passwd")).toBeNull();
    expect(store.has("../../../etc/passwd")).toBe(false);
  });
});
