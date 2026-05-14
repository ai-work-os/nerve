import { describe, it, beforeAll, afterAll } from "vitest";
import { assertEq, WsClient, startServer, stopServer } from "../helpers/vitest.js";

describe("node.register accepts health contract", () => {
  beforeAll(startServer);
  afterAll(stopServer);

  it("registers with health, returns it via node.list", async () => {
    const c = new WsClient("health-test");
    await c.connect();
    const r = await c.request("node.register", {
      name: "health-test-node",
      capabilities: ["monitor"],
      health: { liveness: "process", maxIdleMs: 60000, maxMemoryMB: 200 },
    });
    c.nodeId = r.nodeId;

    const list = await c.request("node.list");
    const me = list.nodes.find((n: any) => n.name === "health-test-node");
    assertEq(me.health.liveness, "process", "health.liveness round-tripped");
    assertEq(me.health.maxIdleMs, 60000, "health.maxIdleMs round-tripped");
    assertEq(me.health.maxMemoryMB, 200, "health.maxMemoryMB round-tripped");

    await c.disconnect();
  });
});
