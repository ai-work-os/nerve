import { describe, it, expect } from "vitest";
import { NerveNode } from "../../src/node/node.js";
import type { Transport } from "../../src/transport/transport.js";
import type { HealthContract } from "../../src/transport/protocol.js";

const fakeTransport = { type: "stdio", send: () => {} } as unknown as Transport;

describe("NerveNode health contract", () => {
  it("toInfo() returns health when set", () => {
    const node = new NerveNode({ id: "n1", name: "test", transport: fakeTransport });
    const health: HealthContract = { liveness: "process", maxIdleMs: 60000, maxMemoryMB: 100 };
    node.health = health;
    expect(node.toInfo().health).toEqual(health);
  });

  it("toInfo() omits health when not set", () => {
    const node = new NerveNode({ id: "n2", name: "test2", transport: fakeTransport });
    expect(node.toInfo().health).toBeUndefined();
  });
});
