/**
 * TranscriptFilter — 去掉 ASR 在静音/噪声上的幻听输出 + 连续复读。
 * 真实 2026-05-12 日志：3410 行中 2742 行是 `。`/`Yeah.`/`.` 这类单符号或语气词。
 */
import { describe, it, expect } from "vitest";
import { TranscriptFilter } from "../../src/plugins/ai-life-log/transcript-filter.js";

describe("TranscriptFilter", () => {
  it("接受正常中文 / 英文句子", () => {
    const f = new TranscriptFilter();
    expect(f.accept("今天去了公园")).toBe(true);
    expect(f.accept("对，然后我直接丢")).toBe(true);
    expect(f.accept("This is a sentence.")).toBe(true);
  });

  it("丢弃纯标点和空白", () => {
    const f = new TranscriptFilter();
    expect(f.accept(".")).toBe(false);
    expect(f.accept("。")).toBe(false);
    expect(f.accept("...")).toBe(false);
    expect(f.accept("   ")).toBe(false);
    expect(f.accept("。。、")).toBe(false);
    expect(f.accept("？！")).toBe(false);
  });

  it("丢弃单短语气词白名单（大小写无关，允许尾标点）", () => {
    const f = new TranscriptFilter();
    expect(f.accept("Yeah.")).toBe(false);
    expect(f.accept("yeah")).toBe(false);
    expect(f.accept("YEAH")).toBe(false);
    expect(f.accept("Oh.")).toBe(false);
    expect(f.accept("Okay")).toBe(false);
    expect(f.accept("ok.")).toBe(false);
    expect(f.accept("嗯。")).toBe(false);
    expect(f.accept("啊")).toBe(false);
    expect(f.accept("う")).toBe(false);
    expect(f.accept("そ")).toBe(false);
    expect(f.accept("so")).toBe(false);
    expect(f.accept("The.")).toBe(false);
    expect(f.accept("Hmm")).toBe(false);
  });

  it("保留中文单字（语义性的）", () => {
    const f = new TranscriptFilter();
    expect(f.accept("对")).toBe(true);
    expect(f.accept("好")).toBe(true);
    expect(f.accept("是")).toBe(true);
    expect(f.accept("不")).toBe(true);
  });

  it("丢弃连续重复（trim 后等于上一条接受的）", () => {
    const f = new TranscriptFilter();
    expect(f.accept("学AI，然后用它")).toBe(true);
    expect(f.accept("学AI，然后用它")).toBe(false);
    expect(f.accept("学AI，然后用它  ")).toBe(false); // trim 后相同
    expect(f.accept("换一句")).toBe(true);
    expect(f.accept("学AI，然后用它")).toBe(true); // 中间隔了别的，不算连续重复
  });

  it("被规则丢弃的不更新 lastAccepted 基线", () => {
    // 被任一规则丢弃的不会更新 lastAccepted，避免规则 A 丢的内容造成规则 C 误判
    const f = new TranscriptFilter();
    expect(f.accept("正常一")).toBe(true);
    expect(f.accept(".")).toBe(false);   // punct 丢
    expect(f.accept("正常一")).toBe(false); // 与最后接受的还是相同 → dup 丢
  });

  it("getStats 分桶计数 + resetStats 归零", () => {
    const f = new TranscriptFilter();
    f.accept("正常");
    f.accept(".");          // punct
    f.accept("Yeah.");      // filler
    f.accept("Oh");         // filler
    f.accept("正常");        // dup
    expect(f.getStats()).toEqual({
      dropped: 4,
      byReason: { punct: 1, filler: 2, dup: 1 },
    });
    f.resetStats();
    expect(f.getStats()).toEqual({
      dropped: 0,
      byReason: { punct: 0, filler: 0, dup: 0 },
    });
  });
});
