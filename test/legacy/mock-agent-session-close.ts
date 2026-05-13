#!/usr/bin/env npx tsx
/**
 * Mock ACP Agent with session.close support.
 *
 * Behavior:
 * - Responds to initialize with agentCapabilities.session.close = {}
 * - Responds to session/close normally
 * - If HANG_ON_CLOSE=1, hangs forever on session/close (for timeout testing)
 */

import { createInterface } from "node:readline";

const HANG_ON_CLOSE = process.env.HANG_ON_CLOSE === "1";

let sessionId = "mock-sc-session-" + Date.now();

const rl = createInterface({ input: process.stdin });

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResponse(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

rl.on("line", (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line.trim());
  } catch {
    return;
  }

  const { id, method, params } = msg;

  // Handle responses (ignore)
  if (!method && id !== undefined) return;

  switch (method) {
    case "initialize":
      sendResponse(id, {
        protocolVersion: 1,
        agentInfo: { name: "mock-session-close-agent", version: "0.1.0" },
        agentCapabilities: {
          sessionCapabilities: {
            close: {},
          },
        },
      });
      break;

    case "authenticate":
      sendResponse(id, {});
      break;

    case "session/new":
      sessionId = "mock-sc-session-" + Date.now();
      sendResponse(id, { sessionId });
      break;

    case "session/prompt":
      sendResponse(id, { stopReason: "end_turn" });
      break;

    case "session/close":
      if (HANG_ON_CLOSE) {
        // Don't respond — simulate hang
        process.stderr.write("[mock-sc] hanging on session/close\n");
      } else {
        // Normal close
        process.stderr.write("[mock-sc] session/close received, responding\n");
        sendResponse(id, {});
      }
      break;

    case "session/cancel":
      if (id !== undefined) {
        sendResponse(id, {});
      }
      break;

    default:
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
  }
});

process.stdin.resume();
