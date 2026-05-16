import { describe, it, expect } from "vitest";
import { buildClipboardScript, copyImageToClipboard } from "../../src/plugins/mac-clipboard/clipboard.js";

describe("buildClipboardScript", () => {
  it("PNG 用 «class PNGf»", () => {
    const s = buildClipboardScript("/tmp/a.png", "image/png");
    expect(s).not.toBeNull();
    expect(s).toContain("/tmp/a.png");
    expect(s).toContain("«class PNGf»");
  });

  it("JPEG 用 «class JPEG»", () => {
    const s = buildClipboardScript("/tmp/a.jpg", "image/jpeg");
    expect(s).toContain("«class JPEG»");
  });

  it("不支持的 MIME 返回 null（跳过剪切板，文件仍已保存）", () => {
    expect(buildClipboardScript("/tmp/a.webp", "image/webp")).toBeNull();
    expect(buildClipboardScript("/tmp/a.bin", "application/octet-stream")).toBeNull();
  });
});

describe("copyImageToClipboard", () => {
  it("不支持的 MIME 返回 false，不抛错", () => {
    expect(copyImageToClipboard("/tmp/nonexistent.webp", "image/webp")).toBe(false);
  });
});
