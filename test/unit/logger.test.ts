import { describe, it, expect, beforeEach, vi } from "vitest";
import * as logger from "../../src/infra/logger.js";

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

describe("level filtering", () => {
  beforeEach(() => { delete process.env.NERVE_DEBUG; logger.__resetForTest?.(); });

  it("DEBUG hidden by default", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const c = logger.child({ module: "test-mod" });
    c.debug("hidden");
    expect(spy.mock.calls.map(x => x[0]).join("")).not.toContain("hidden");
    spy.mockRestore();
  });

  it("NERVE_DEBUG=mod enables DEBUG for that module only", () => {
    process.env.NERVE_DEBUG = "mod-a";
    logger.__resetForTest?.();
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.child({ module: "mod-a" }).debug("show-a");
    logger.child({ module: "mod-b" }).debug("hide-b");
    const out = spy.mock.calls.map(x => x[0]).join("");
    expect(out).toContain("show-a");
    expect(out).not.toContain("hide-b");
    spy.mockRestore();
  });

  it("NERVE_DEBUG=plugin:* matches glob", () => {
    process.env.NERVE_DEBUG = "plugin:*";
    logger.__resetForTest?.();
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.child({ module: "plugin:duty-monitor" }).debug("show-plugin");
    logger.child({ module: "core" }).debug("hide-core");
    const out = spy.mock.calls.map(x => x[0]).join("");
    expect(out).toContain("show-plugin");
    expect(out).not.toContain("hide-core");
    spy.mockRestore();
  });
});

describe("standard events", () => {
  it("lifecycle logs event + reason", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.child({ module: "test" }).lifecycle("start", "boot");
    const out = spy.mock.calls.map(x => x[0]).join("");
    expect(out).toContain("lifecycle=start");
    expect(out).toContain("reason=boot");
    spy.mockRestore();
  });

  it("stateChange logs from/to", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.child({ module: "node" }).stateChange("status", "idle", "running", "spawned");
    const out = spy.mock.calls.map(x => x[0]).join("");
    expect(out).toContain("field=status");
    expect(out).toContain("from=idle");
    expect(out).toContain("to=running");
    spy.mockRestore();
  });

  it("boundary logs direction + kind", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.child({ module: "transport" }).boundary("in", "http", { path: "/spawn", method: "POST" });
    const out = spy.mock.calls.map(x => x[0]).join("");
    expect(out).toContain("dir=in");
    expect(out).toContain("kind=http");
    expect(out).toContain("path=/spawn");
    spy.mockRestore();
  });
});

describe("correlationId", () => {
  it("newCorrelationId returns 8-char id", () => {
    const id = logger.newCorrelationId();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
  });

  it("two ids differ", () => {
    expect(logger.newCorrelationId()).not.toBe(logger.newCorrelationId());
  });

  it("correlationId visible in child log output", () => {
    const cid = logger.newCorrelationId();
    const c = logger.child({ module: "test", correlationId: cid });
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    c.info("traced");
    expect(spy.mock.calls.map(x => x[0]).join("")).toContain(`correlationId=${cid}`);
    spy.mockRestore();
  });
});
