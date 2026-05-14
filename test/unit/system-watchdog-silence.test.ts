import { describe, it, expect } from "vitest";
import { shouldEmit, alertKey, type SilenceState } from "../../src/plugins/system-watchdog/silence.js";

const NOW = 1_700_000_000_000;
const WINDOW = 60 * 60 * 1000;  // 1h

describe("alertKey", () => {
  it("拼接 nodeName + metric", () => {
    expect(alertKey({ nodeName: "duty-monitor", metric: "idle", detail: "x" })).toBe("duty-monitor:idle");
  });
});

describe("shouldEmit", () => {
  it("没历史记录 → 第一次 emit", () => {
    const state: SilenceState = {};
    expect(shouldEmit("a:idle", state, WINDOW, NOW)).toBe(true);
  });

  it("窗口内 → 不 emit", () => {
    const state: SilenceState = { "a:idle": NOW - 1000 };
    expect(shouldEmit("a:idle", state, WINDOW, NOW)).toBe(false);
  });

  it("窗口外 → emit", () => {
    const state: SilenceState = { "a:idle": NOW - WINDOW - 1 };
    expect(shouldEmit("a:idle", state, WINDOW, NOW)).toBe(true);
  });

  it("不同 key 互不影响", () => {
    const state: SilenceState = { "a:idle": NOW - 1000 };
    expect(shouldEmit("b:idle", state, WINDOW, NOW)).toBe(true);
    expect(shouldEmit("a:memory", state, WINDOW, NOW)).toBe(true);
  });
});
