/**
 * channel-mcp ws-client.ts — JSON-RPC over WebSocket with auto reconnect.
 *
 * These tests run against an in-process mock WS server so we exercise the
 * client's protocol handling (request/response, notifications) without
 * depending on a real nerve server. End-to-end behavior is covered by
 * channel-mcp.integration.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as WsServerSocket } from "ws";
import { NerveWsClient } from "../../src/channel-mcp/ws-client.js";

async function findFreePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

describe("NerveWsClient", () => {
  let port: number;
  let server: WebSocketServer;
  let lastSocket: WsServerSocket | null = null;
  let received: { id?: number; method: string; params?: unknown }[] = [];

  beforeEach(async () => {
    port = await findFreePort();
    received = [];
    server = new WebSocketServer({ port });
    server.on("connection", (ws) => {
      lastSocket = ws;
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        received.push(msg);
        // Echo handler for tests: respond to node.register with nodeId
        if (msg.method === "node.register" && msg.id !== undefined) {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { nodeId: "n_test", name: msg.params.name },
            }),
          );
        } else if (msg.method === "channel.post" && msg.id !== undefined) {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { message: { id: "m1", from: msg.params.name ?? "x", content: msg.params.content } },
            }),
          );
        } else if (msg.method === "throws" && msg.id !== undefined) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom" } }));
        }
      });
    });
    await new Promise<void>((r) => server.on("listening", () => r()));
  });

  afterEach(async () => {
    server.close();
    lastSocket = null;
  });

  it("connects and registers a node", async () => {
    const client = new NerveWsClient(`ws://localhost:${port}`);
    await client.connect();
    const res = await client.register("claude-ext-test", ["ui"]);
    expect(res.nodeId).toBe("n_test");
    expect(res.name).toBe("claude-ext-test");
    expect(received.find((m) => m.method === "node.register")).toBeDefined();
    await client.close();
  });

  it("forwards request/response with auto-incrementing ids", async () => {
    const client = new NerveWsClient(`ws://localhost:${port}`);
    await client.connect();
    const r1 = await client.request("channel.post", { channelId: "ch1", content: "hi", name: "claude-ext-test" });
    expect(r1.message.content).toBe("hi");
    const r2 = await client.request("channel.post", { channelId: "ch1", content: "yo", name: "claude-ext-test" });
    expect(r2.message.content).toBe("yo");
    await client.close();
  });

  it("propagates server errors as rejections", async () => {
    const client = new NerveWsClient(`ws://localhost:${port}`);
    await client.connect();
    await expect(client.request("throws", {})).rejects.toThrow(/boom/);
    await client.close();
  });

  it("delivers notifications to the registered handler", async () => {
    const client = new NerveWsClient(`ws://localhost:${port}`);
    const events: { method: string; params: any }[] = [];
    client.onNotification((n) => events.push(n));
    await client.connect();
    // Push a notification from the server side
    lastSocket!.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "channel.message",
        params: { channelId: "ch1", message: { id: "m1", from: "a", content: "ping", timestamp: 1 } },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(1);
    expect(events[0].method).toBe("channel.message");
    expect(events[0].params.message.content).toBe("ping");
    await client.close();
  });

  it("rejects pending requests when connection closes", async () => {
    const client = new NerveWsClient(`ws://localhost:${port}`);
    await client.connect();
    const pending = client.request("throws", {});
    // Close before server can respond
    lastSocket!.close();
    await expect(pending).rejects.toThrow();
    await client.close();
  });
});
