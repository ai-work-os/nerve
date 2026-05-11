import { describe, it, expect } from "vitest";
import type { AudioSource, PcmCallback } from "../../src/plugins/ai-life-log/sources/audio-source.js";
import { MacMicSource } from "../../src/plugins/ai-life-log/sources/mac-mic-source.js";

describe("AudioSource contract", () => {
  it("接口定义包含 tag / start / stop", () => {
    // 编译期检查 — 这里只是确保导入成功
    const stub: AudioSource = {
      tag: "stub",
      start: async (_: PcmCallback) => {},
      stop: async () => {},
    };
    expect(stub.tag).toBe("stub");
  });
});

describe("MacMicSource", () => {
  it("tag 是 'mac'", () => {
    const s = new MacMicSource();
    expect(s.tag).toBe("mac");
  });
  // 实际 capture 启动需 macOS 真机 + 权限，由 integration test 兜底
});
