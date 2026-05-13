/**
 * extractText — 从飞书 message 解析纯文本。
 * 飞书 content 字段是 JSON 字符串，结构按 message_type 而异：
 *   text     → {"text": "..."}
 *   post     → {"title": "...", "content": [[{"tag":"text","text":"..."}, ...], ...]}
 *   image/file/audio/sticker → 不支持，返回 null
 */
import { describe, it, expect } from "vitest";
import { extractText } from "../../src/plugins/feishu-bridge/text-extract.js";

describe("feishu-bridge extractText", () => {
  it("text 类型直接返回 text 字段", () => {
    const got = extractText("text", JSON.stringify({ text: "hello world" }));
    expect(got).toBe("hello world");
  });

  it("text 字段 trim 后为空 → null", () => {
    expect(extractText("text", JSON.stringify({ text: "   " }))).toBeNull();
    expect(extractText("text", JSON.stringify({ text: "" }))).toBeNull();
  });

  it("text 类型剥离 @机器人 mention 标记", () => {
    // 飞书在 text 里把 @机器人 表示为 @_user_1 等占位符
    const got = extractText("text", JSON.stringify({ text: "@_user_1 帮我看看" }));
    expect(got).toBe("帮我看看");
  });

  it("post 类型拼接所有 text 节点", () => {
    const content = {
      title: "标题",
      content: [
        [
          { tag: "text", text: "第一段" },
          { tag: "a", text: "链接", href: "x" },
        ],
        [{ tag: "text", text: "第二段" }],
      ],
    };
    const got = extractText("post", JSON.stringify(content));
    expect(got).toContain("第一段");
    expect(got).toContain("第二段");
  });

  it("不支持类型返回 null", () => {
    expect(extractText("image", JSON.stringify({ image_key: "img_xxx" }))).toBeNull();
    expect(extractText("file", JSON.stringify({ file_key: "f" }))).toBeNull();
    expect(extractText("audio", JSON.stringify({ file_key: "a" }))).toBeNull();
    expect(extractText("sticker", JSON.stringify({ file_key: "s" }))).toBeNull();
  });

  it("非法 JSON 返回 null（不抛）", () => {
    expect(extractText("text", "not json {{{")).toBeNull();
  });

  it("缺字段返回 null", () => {
    expect(extractText("text", JSON.stringify({}))).toBeNull();
  });
});
