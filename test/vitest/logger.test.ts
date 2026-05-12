import { describe, it, expect, beforeEach, vi } from "vitest";
import * as logger from "../../src/logger.js";

describe("logger.child", () => {
  beforeEach(() => {
    logger.__resetForTest?.();
  });

  it("creates child logger with module tag", () => {
    const child = logger.child({ module: "node-pool" });
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    child.info("test message");
    const written = spy.mock.calls.map(c => c[0]).join("");
    expect(written).toContain("[node-pool]");
    expect(written).toContain("test message");
    spy.mockRestore();
  });

  it("child inherits module, allows extra context", () => {
    const child = logger.child({ module: "channel-manager", channelId: "ch1" });
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    child.info("posted");
    const out = spy.mock.calls.map(c => c[0]).join("");
    expect(out).toContain("[channel-manager]");
    expect(out).toContain("channelId=ch1");
    spy.mockRestore();
  });

  it("legacy info/warn/error/debug still work", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.info("legacy");
    expect(spy.mock.calls.map(c => c[0]).join("")).toContain("legacy");
    spy.mockRestore();
  });
});
