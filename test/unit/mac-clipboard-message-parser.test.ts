import { describe, it, expect } from "vitest";
import { parseScreenshotMessage } from "../../src/plugins/mac-clipboard/message-parser.js";

const HEX = "a".repeat(64);

describe("parseScreenshotMessage", () => {
  it("解析标准截图消息，提取 blobId", () => {
    const r = parseScreenshotMessage(`📷 screenshot | blob=${HEX} | source=pixel8 | analyze=false`);
    expect(r).toEqual({ blobId: HEX });
  });

  it("blobId 必须是 64 位 hex —— 非法返回 null", () => {
    expect(parseScreenshotMessage("📷 screenshot | blob=not-hex | source=p | analyze=false")).toBeNull();
  });

  it("非截图消息返回 null（如 AI 分析结果、普通聊天）", () => {
    expect(parseScreenshotMessage("🔍 截图分析 (abc)\n内容")).toBeNull();
    expect(parseScreenshotMessage("hello world")).toBeNull();
    expect(parseScreenshotMessage("")).toBeNull();
  });

  it("@mention 前缀也能解析（频道消息可能带 @）", () => {
    const r = parseScreenshotMessage(`@mac-clipboard 📷 screenshot | blob=${HEX} | source=p | analyze=true`);
    expect(r).toEqual({ blobId: HEX });
  });
});
