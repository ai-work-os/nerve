#!/usr/bin/env npx tsx
/**
 * Mock Program Node — simulates a program node that connects back via WebSocket.
 *
 * Reads NERVE_PORT and NERVE_NODE_NAME from environment.
 * Connects to nerve via WS, sends node.register, stays alive.
 * Supports "ping" activity updates for testing.
 */

import WebSocket from "ws";

const PORT = process.env.NERVE_PORT || "4800";
const NAME = process.env.NERVE_NODE_NAME || "mock-program";

let reqId = 1;

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function request(ws: WebSocket, method: string, params: Record<string, unknown> = {}): number {
  const id = reqId++;
  send(ws, { jsonrpc: "2.0", id, method, params });
  return id;
}

const url = `ws://127.0.0.1:${PORT}`;
const ws = new WebSocket(url);

ws.on("open", () => {
  // Register with the name from environment
  request(ws, "node.register", {
    name: NAME,
    capabilities: ["monitor"],
    permissions: "member",
    commands: {
      status: { description: "Show status" },
      ping: { description: "Return pong" },
    },
  });
});

ws.on("message", (data) => {
  let msg: any;
  try { msg = JSON.parse(data.toString()); } catch { return; }

  // Handle incoming requests (node.command) — has both method and id
  if (msg.method && msg.id !== undefined) {
    if (msg.method === "node.command") {
      const { command, args, from } = msg.params || {};
      let result: any = {};
      if (command === "status") {
        result = { reply: `ok, from=${from || "unknown"}` };
      } else if (command === "ping") {
        result = { reply: "pong" };
      } else {
        send(ws, { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown command: ${command}` } });
        return;
      }
      send(ws, { jsonrpc: "2.0", id: msg.id, result });
      return;
    }
  }

  // Handle registration response
  if (msg.id !== undefined && msg.result?.nodeId) {
    // Successfully registered — send activity update to signal readiness
    request(ws, "node.activity", { activity: "ready" });
  }

  // Handle notifications (e.g., channel messages, DM)
  if (msg.method === "node.message") {
    // Echo back via node.log so tests can observe
    request(ws, "node.log", {
      entries: [{ level: "info", message: `dm:${msg.params?.content}:from:${msg.params?.from}` }],
    });
  }

  if (msg.method === "channel.nodeJoined") {
    request(ws, "node.log", {
      entries: [{ level: "info", message: `joined:${msg.params?.channelId}:${msg.params?.nodeName}` }],
    });
  }
});

ws.on("close", () => {
  process.exit(0);
});

ws.on("error", (err) => {
  process.stderr.write(`[mock-program] ws error: ${err.message}\n`);
  process.exit(1);
});

// Keep alive
process.stdin.resume();

// Graceful shutdown
process.on("SIGTERM", () => {
  ws.close();
  process.exit(0);
});
