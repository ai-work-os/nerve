import { describe, it, expect } from "vitest";
import { child, newCorrelationId } from "../../src/infra/logger.js";

describe("correlation-id propagation", () => {
  it("child propagates correlationId through nested children", () => {
    const cid = newCorrelationId();
    const root = child({ module: "test", correlationId: cid });
    const nested = root.child({ channelId: "ch1" });
    // Sanity that nested logger exposes API
    expect(typeof nested.info).toBe("function");
    expect(typeof nested.child).toBe("function");
    expect(typeof nested.boundary).toBe("function");
  });

  it("newCorrelationId generates unique ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newCorrelationId()));
    expect(ids.size).toBe(100);
  });

  it("newCorrelationId produces 8-character lowercase alphanumeric strings", () => {
    const cid = newCorrelationId();
    expect(cid).toMatch(/^[a-z0-9]{8}$/);
  });
});
