#!/usr/bin/env node
/**
 * nerve-channel — Claude Code "channel" MCP server.
 *
 * Bridges a single Claude Code session to a nerve server:
 *   - Registers itself as a WS-node in nerve (default name: claude-ext-<hostname>)
 *   - Forwards nerve channel/DM notifications into Claude Code as
 *     `notifications/claude/channel` events
 *   - Exposes nerve_* tools so Claude can post back, create channels, spawn agents
 *
 * Env:
 *   NERVE_PORT (default 4800)
 *   NERVE_HOST (default 127.0.0.1)
 *   NERVE_EXTERNAL_NODE_NAME (default claude-ext-<hostname>)
 *
 * Logging goes to stderr. stdio is reserved for the MCP transport.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { hostname } from "node:os";

import { NerveWsClient } from "./ws-client.js";
import { notificationToChannelEvent } from "./push.js";
import { TOOLS, handleTool, type Ctx } from "./tools.js";

const NERVE_PORT = process.env.NERVE_PORT || "4800";
const NERVE_HOST = process.env.NERVE_HOST || "127.0.0.1";
const DEFAULT_NAME = `claude-ext-${hostname().split(".")[0]}`;
const NODE_NAME = process.env.NERVE_EXTERNAL_NODE_NAME || DEFAULT_NAME;
const WS_URL = `ws://${NERVE_HOST}:${NERVE_PORT}`;

function log(msg: string): void {
  process.stderr.write(`[nerve-channel] ${msg}\n`);
}

const INSTRUCTIONS = [
  "You have joined a nerve instance as an external AI node.",
  "Incoming events arrive as <channel source=\"nerve\" event=\"...\" channel_id=\"...\" from_node=\"...\">body</channel>.",
  "When the event is channel.message or channel.mention, reply using the nerve_post tool with the same channel_id.",
  "When the event is node.message (a 1:1 DM), reply using nerve_dm with the from_node name.",
  "You can also create channels, spawn agents, and DM other nodes proactively via the nerve_* tools.",
  "Other nerve agents are AI peers, not the human user; coordinate with them like teammates.",
].join(" ");

const mcp = new Server(
  { name: "nerve-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
);

let ctx: Ctx | null = null;
let wsClient: NerveWsClient | null = null;
let reconnectScheduled = false;

async function pushNotification(event: { content: string; meta: Record<string, string> }): Promise<void> {
  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content: event.content, meta: event.meta },
    });
  } catch (e) {
    log(`failed to push notification: ${(e as Error).message}`);
  }
}

async function connectAndRegister(): Promise<void> {
  const client = new NerveWsClient(WS_URL, { requestTimeoutMs: 15000 });
  client.onNotification((n) => {
    if (!ctx) return;
    const evt = notificationToChannelEvent(ctx.nodeName, n);
    if (evt) {
      void pushNotification(evt);
    }
  });
  client.onClose(() => {
    log("websocket closed, scheduling reconnect");
    ctx = null;
    wsClient = null;
    if (!reconnectScheduled) {
      reconnectScheduled = true;
      setTimeout(() => {
        reconnectScheduled = false;
        void connectAndRegister().catch((e) => log(`reconnect failed: ${e.message}`));
      }, 2000);
    }
  });

  await client.connect();
  const reg = await client.register(NODE_NAME, ["ui"]);
  log(`registered as ${reg.name} (nodeId=${reg.nodeId})`);
  wsClient = client;
  ctx = { wsClient: client, nodeId: reg.nodeId, nodeName: reg.name };
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as { name: string; description: string; inputSchema: object }[] }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!ctx) {
    return { content: [{ type: "text", text: "error: not connected to nerve yet" }], isError: true };
  }
  return handleTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, ctx);
});

async function main(): Promise<void> {
  log(`starting; nerve=${WS_URL} node_name=${NODE_NAME}`);
  await mcp.connect(new StdioServerTransport());
  try {
    await connectAndRegister();
  } catch (e) {
    log(`initial connect failed: ${(e as Error).message}; will keep retrying`);
    if (!reconnectScheduled) {
      reconnectScheduled = true;
      setTimeout(() => {
        reconnectScheduled = false;
        void connectAndRegister().catch((err) => log(`reconnect failed: ${err.message}`));
      }, 2000);
    }
  }
}

void main().catch((e) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
