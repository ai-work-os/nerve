import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveScreenshot, extensionFor } from "../../src/plugins/mac-clipboard/screenshot-saver.js";

describe("extensionFor", () => {
  it("已知 MIME 映射到扩展名", () => {
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("image/webp")).toBe("webp");
  });
  it("未知 MIME 落为 bin", () => {
    expect(extensionFor("application/octet-stream")).toBe("bin");
  });
});

describe("saveScreenshot", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mc-save-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("把字节写到 dir 下，文件名含时间戳和 blobId 前缀，扩展名按 MIME", () => {
    const data = Buffer.from("PNG-DATA");
    const takenAt = new Date("2026-05-16T14:30:05+08:00").getTime();
    const path = saveScreenshot(dir, "abcdef0123456789".repeat(4), data, "image/png", takenAt);
    expect(existsSync(path)).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(path).toContain("abcdef01"); // blobId 前 8 位
    expect(readFileSync(path)).toEqual(data);
  });

  it("dir 不存在时自动创建", () => {
    const nested = join(dir, "from-phone");
    const path = saveScreenshot(nested, "f".repeat(64), Buffer.from("x"), "image/jpeg", Date.now());
    expect(existsSync(path)).toBe(true);
    expect(path.endsWith(".jpg")).toBe(true);
  });
});
