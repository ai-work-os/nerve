#!/usr/bin/env npx tsx
/**
 * Mock ACP Agent — simulates a CLI agent for testing.
 * Communicates via stdin/stdout JSON-RPC 2.0 (ACP protocol).
 *
 * Behavior:
 * - Responds to initialize, authenticate, session/new
 * - On session/prompt: echoes back with "@main" prefix (simulates channel reply)
 * - If prompt contains "curl", executes terminal/create to post to Nerve HTTP API
 */

import { createInterface } from "node:readline";
import http from "node:http";

const NERVE_PORT = process.env.NERVE_PORT || "4800";
const NODE_NAME = process.env.NERVE_NODE_NAME || "mock";

let sessionId = "mock-session-" + Date.now();
let receivedMcpServers: unknown = null;
let pendingPromptId: number | string | null = null;
let pendingPromptTimer: ReturnType<typeof setTimeout> | null = null;

const rl = createInterface({ input: process.stdin });

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResponse(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendNotification(method: string, params: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

rl.on("line", (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line.trim());
  } catch {
    return;
  }

  const { id, method, params } = msg;

  // Handle responses to our requests (if any)
  if (!method && id !== undefined) return;

  switch (method) {
    case "initialize":
      sendResponse(id, {
        protocolVersion: 1,
        agentInfo: { name: "mock-agent", version: "0.1.0" },
        capabilities: {},
      });
      break;

    case "authenticate":
      sendResponse(id, {});
      break;

    case "session/new":
      sessionId = "mock-session-" + Date.now();
      receivedMcpServers = params?.mcpServers ?? null;
      sendResponse(id, { sessionId });
      // Emit session/update with mcpServers info so tests can verify injection
      if (receivedMcpServers) {
        sendNotification("session/update", {
          sessionId,
          update: { sessionUpdate: "mcpServers_received", mcpServers: receivedMcpServers },
        });
      }
      break;

    case "session/prompt": {
      const promptParts = params?.prompt as Array<{ type: string; text: string }> | undefined;
      const text = promptParts?.[0]?.text || params?.text || "";

      // Simulate thinking
      sendNotification("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `[mock processing: "${text.slice(0, 50)}"]` },
        },
      });

      // "activity" prompts: simulate tool_call then delay 3s before end_turn
      if (text.includes("activity")) {
        sendNotification("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            title: "mock_tool",
          },
        });
        setTimeout(() => {
          sendResponse(id, { stopReason: "end_turn" });
        }, 3000);
        break;
      }

      // "mcpServers?" query — return what was received on session/new
      if (text.includes("mcpServers?")) {
        sendResponse(id, { stopReason: "end_turn", mcpServers: receivedMcpServers });
        break;
      }

      // "fail" prompts return error (for error-handling testing)
      if (text.includes("fail")) {
        sendResponse(id, { error: "simulated prompt failure" });
        break;
      }

      // "slow" prompts delay 10s (for cancel testing)
      if (text.includes("slow")) {
        pendingPromptId = id;
        pendingPromptTimer = setTimeout(() => {
          pendingPromptId = null;
          pendingPromptTimer = null;
          sendResponse(id, { stopReason: "end_turn" });
        }, 10000);
        break;
      }

      // "send-usage" prompts: emit two usage_updates with different sizes to trigger size-change warn
      if (text.includes("send-usage")) {
        sendNotification("session/update", {
          sessionId,
          update: { sessionUpdate: "usage_update", used: 100, size: 50000, cost: null },
        });
        sendNotification("session/update", {
          sessionId,
          update: { sessionUpdate: "usage_update", used: 200, size: 80000, cost: null },
        });
        sendResponse(id, { stopReason: "end_turn" });
        break;
      }

      // Generate reply
      const reply = `@main mock回复: 收到 "${text.slice(0, 80)}"`;

      // Post reply to Nerve via HTTP (simulating what a real agent would do via terminal)
      const postData = JSON.stringify({ from: NODE_NAME, content: reply });
      const req = http.request(
        {
          hostname: "localhost",
          port: parseInt(NERVE_PORT),
          path: "/post",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res: any) => {
          let body = "";
          res.on("data", (c: string) => (body += c));
          res.on("end", () => {
            // Complete the prompt
            sendResponse(id, { stopReason: "end_turn" });
          });
        }
      );
      req.on("error", (e: Error) => {
        process.stderr.write(`[mock] HTTP error: ${e.message}\n`);
        // If HTTP fails, still complete the prompt
        sendResponse(id, { stopReason: "end_turn" });
      });
      req.write(postData);
      req.end();
      break;
    }

    case "session/cancel":
      // session/cancel is a NOTIFICATION (no id) per ACP spec.
      // Resolve the pending prompt with stopReason: "cancelled".
      if (pendingPromptId !== null) {
        if (pendingPromptTimer) clearTimeout(pendingPromptTimer);
        sendResponse(pendingPromptId, { stopReason: "cancelled" });
        pendingPromptId = null;
        pendingPromptTimer = null;
      }
      // No response for notifications (id is undefined)
      if (id !== undefined) {
        sendResponse(id, {});
      }
      break;

    default:
      // Unknown method
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
  }
});

// Keep alive
process.stdin.resume();
