#!/usr/bin/env node
/**
 * Nerve MCP Server — injected into each agent via session/new mcpServers.
 * Exposes orchestration tools for agent-to-agent communication and coordination.
 * Communicates with nerve server via HTTP.
 *
 * Env: NERVE_PORT, NERVE_NODE_NAME
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const NERVE_PORT = process.env.NERVE_PORT || "4800";
const NERVE_NODE_NAME = process.env.NERVE_NODE_NAME || "unknown";
const BASE_URL = `http://127.0.0.1:${NERVE_PORT}`;

function log(msg: string): void {
  process.stderr.write(`[nerve-mcp] ${msg}\n`);
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok || json.error) {
    throw new Error(String(json.error || `HTTP ${res.status}`));
  }
  return json;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text: `error: ${text}` }], isError: true };
}

async function findNodeByName(name: string): Promise<Record<string, unknown>> {
  const result = await post("/node/list", {});
  const node = (result.nodes as Record<string, unknown>[] | undefined)?.find((n) => n.name === name);
  if (!node) throw new Error(`node not found: ${name}`);
  return node;
}

const server = new Server(
  { name: "nerve", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "nerve_post",
      description: "Send a message to another agent in the channel. The message will be routed via @mention.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Target agent name" },
          content: { type: "string", description: "Message content" },
        },
        required: ["to", "content"],
      },
    },
    {
      name: "nerve_spawn",
      description: "Spawn a worker agent process managed by nerve.",
      inputSchema: {
        type: "object" as const,
        properties: {
          adapter: { type: "string", description: "Adapter name", default: "claude" },
          name: { type: "string", description: "Optional agent name" },
          cwd: { type: "string", description: "Optional working directory" },
        },
      },
    },
    {
      name: "nerve_create_channel",
      description: "Create a new collaboration channel and auto-join the calling agent.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Optional channel name" },
        },
      },
    },
    {
      name: "nerve_join",
      description: "Add an existing agent into a channel by agent name.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_name: { type: "string", description: "Agent name to join" },
          channel_id: { type: "string", description: "Target channel id" },
        },
        required: ["agent_name", "channel_id"],
      },
    },
    {
      name: "nerve_remove",
      description: "Remove an agent from a channel by agent name.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_name: { type: "string", description: "Agent name to remove" },
          channel_id: { type: "string", description: "Target channel id" },
        },
        required: ["agent_name", "channel_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "nerve_post") {
    const { to, content } = args as { to: string; content: string };
    if (!to || !content) {
      return fail("to and content are required");
    }

    try {
      log(`nerve_post from=${NERVE_NODE_NAME} to=${to}`);
      await post("/post", {
        from: NERVE_NODE_NAME,
        content: `@${to} ${content}`,
      });
      return ok(`sent to @${to}`);
    } catch (err) {
      log(`nerve_post failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_spawn") {
    const { adapter, name: agentName, cwd } = (args || {}) as { adapter?: string; name?: string; cwd?: string };
    try {
      const useAdapter = adapter || "claude";
      log(`nerve_spawn adapter=${useAdapter} name=${agentName || "auto"} cwd=${cwd || process.cwd()}`);
      const result = await post("/node/spawn", {
        adapter: useAdapter,
        name: agentName,
        cwd: cwd || process.cwd(),
      });
      return ok(`spawned ${String(result.name || agentName || "agent")} (${String(result.nodeId || "?")})`);
    } catch (err) {
      log(`nerve_spawn failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_create_channel") {
    const { name: channelName } = (args || {}) as { name?: string };
    try {
      log(`nerve_create_channel from=${NERVE_NODE_NAME} name=${channelName || "unnamed"}`);
      const result = await post("/channel/create", {
        from: NERVE_NODE_NAME,
        name: channelName,
        cwd: process.cwd(),
      });
      return ok(`created channel ${String(result.channelId)}${result.name ? ` (${String(result.name)})` : ""}`);
    } catch (err) {
      log(`nerve_create_channel failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_join") {
    const { agent_name, channel_id } = args as { agent_name: string; channel_id: string };
    if (!agent_name || !channel_id) {
      return fail("agent_name and channel_id are required");
    }

    try {
      log(`nerve_join agent=${agent_name} channel=${channel_id}`);
      const node = await findNodeByName(agent_name);
      await post("/channel/addNode", {
        channelId: channel_id,
        nodeId: node.id,
        nodeName: agent_name,
      });
      return ok(`joined ${agent_name} to ${channel_id}`);
    } catch (err) {
      log(`nerve_join failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_remove") {
    const { agent_name, channel_id } = args as { agent_name: string; channel_id: string };
    if (!agent_name || !channel_id) {
      return fail("agent_name and channel_id are required");
    }

    try {
      log(`nerve_remove agent=${agent_name} channel=${channel_id}`);
      await findNodeByName(agent_name);
      await post("/channel/removeNode", {
        channelId: channel_id,
        nodeName: agent_name,
      });
      return ok(`removed ${agent_name} from ${channel_id}`);
    } catch (err) {
      log(`nerve_remove failed: ${err}`);
      return fail(String(err));
    }
  }

  return fail(`unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
