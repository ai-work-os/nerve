import { describe, it, expect } from "vitest";
import { PluginBase } from "../../src/plugins/plugin-base.js";

class TestPlugin extends PluginBase {}

describe("PluginBase host option", () => {
  it("host 默认为 127.0.0.1", () => {
    const p = new TestPlugin({ port: 4800, name: "t-default" });
    expect((p as any).options.host).toBe("127.0.0.1");
  });

  it("可通过 options.host 覆盖", () => {
    const p = new TestPlugin({ port: 4800, name: "t-host", host: "100.75.43.90" });
    expect((p as any).options.host).toBe("100.75.43.90");
  });

  it("NERVE_SPAWNED=1 时 NERVE_HOST 环境变量优先", () => {
    const prevSpawned = process.env.NERVE_SPAWNED;
    const prevHost = process.env.NERVE_HOST;
    process.env.NERVE_SPAWNED = "1";
    process.env.NERVE_HOST = "10.0.0.5";
    try {
      const p = new TestPlugin({ port: 4800, name: "t-env", host: "1.2.3.4" });
      expect((p as any).options.host).toBe("10.0.0.5");
    } finally {
      if (prevSpawned === undefined) delete process.env.NERVE_SPAWNED; else process.env.NERVE_SPAWNED = prevSpawned;
      if (prevHost === undefined) delete process.env.NERVE_HOST; else process.env.NERVE_HOST = prevHost;
    }
  });
});
