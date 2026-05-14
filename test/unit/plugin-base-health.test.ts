import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import { PluginBase } from "../../src/plugins/plugin-base.js";
import type { HealthContract } from "../../src/transport/protocol.js";

class TestPlugin extends PluginBase {
  override getHealth(): HealthContract {
    return { liveness: "process", maxIdleMs: 60000, maxMemoryMB: 100 };
  }
}

class NoHealthPlugin extends PluginBase {}

describe("PluginBase getHealth contract", () => {
  let wss: WebSocketServer;
  let port: number;
  let receivedRegisterParams: any;

  beforeEach(async () => {
    receivedRegisterParams = null;
    await new Promise<void>(resolve => {
      wss = new WebSocketServer({ port: 0 }, () => {
        port = (wss.address() as any).port;
        resolve();
      });
    });
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === "node.register") {
          receivedRegisterParams = msg.params;
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { nodeId: "n1", name: msg.params.name } }));
        }
      });
    });
  });

  afterEach(() => {
    // 强制终止所有客户端连接，避免 plugin.start() 失败时连接挂起
    for (const client of wss.clients) {
      try { client.terminate(); } catch { /* ignore */ }
    }
    return new Promise<void>(resolve => wss.close(() => resolve()));
  });

  it("getHealth() result is sent in node.register payload", async () => {
    const plugin = new TestPlugin({ port, name: "test-health-plugin", capabilities: ["monitor"] });
    await plugin.start();
    expect(receivedRegisterParams.health).toEqual({
      liveness: "process", maxIdleMs: 60000, maxMemoryMB: 100,
    });
    plugin.stop();
  });

  it("default getHealth() returns empty, not sent in payload", async () => {
    const plugin = new NoHealthPlugin({ port, name: "no-health-plugin", capabilities: ["monitor"] });
    await plugin.start();
    expect(receivedRegisterParams.health).toBeUndefined();
    plugin.stop();
  });
});
