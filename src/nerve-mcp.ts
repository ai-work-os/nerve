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

// Track the current channel this agent is in (set on create/join)
let currentChannelId: string | undefined;

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
          channel_id: { type: "string", description: "Target channel id (auto-detected if omitted)" },
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
      name: "nerve_delete_channel",
      description: "Delete a channel permanently. Removes all members, messages, and the channel record.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel_id: { type: "string", description: "Channel id to delete" },
        },
        required: ["channel_id"],
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
    {
      name: "nerve_stop",
      description: "Stop/shutdown an agent process by name. Removes it from all channels and terminates the process.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_name: { type: "string", description: "Agent name to stop" },
        },
        required: ["agent_name"],
      },
    },
    {
      name: "nerve_session_reset",
      description: "Reset current session after writing context summary. Creates a new session with initial prompt pointing to the summary file. Call this after you have written the summary file.",
      inputSchema: {
        type: "object" as const,
        properties: {
          summary_path: { type: "string", description: "Absolute path to the context summary file you just wrote" },
        },
        required: ["summary_path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "nerve_post") {
    const { to, content, channel_id } = args as { to: string; content: string; channel_id?: string };
    if (!to || !content) {
      return fail("to and content are required");
    }

    const targetChannel = channel_id || currentChannelId;
    try {
      log(`nerve_post from=${NERVE_NODE_NAME} to=${to} channel=${targetChannel || "auto"}`);
      await post("/post", {
        from: NERVE_NODE_NAME,
        content: `@${to} ${content}`,
        ...(targetChannel ? { channelId: targetChannel } : {}),
      });
      return ok(`sent to @${to}`);
    } catch (err) {
      // If the tracked channel is stale (not found), clear it
      if (!channel_id && currentChannelId && String(err).includes("not found")) {
        log(`nerve_post: clearing stale currentChannelId=${currentChannelId}`);
        currentChannelId = undefined;
      }
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
      const spawnedName = String(result.name || agentName || "agent");
      const spawnedId = String(result.nodeId || "?");

      // Auto-join spawned agent to caller's current channel
      let joinNote = "";
      if (currentChannelId && spawnedId !== "?") {
        try {
          await post("/channel/addNode", {
            channelId: currentChannelId,
            nodeId: spawnedId,
            nodeName: spawnedName,
          });
          log(`nerve_spawn: auto-joined ${spawnedName} to channel ${currentChannelId}`);
          joinNote = `, joined channel ${currentChannelId}`;
        } catch (joinErr) {
          const errStr = String(joinErr);
          log(`nerve_spawn: auto-join failed: ${errStr}`);
          if (errStr.includes("not found")) {
            currentChannelId = undefined;
            log(`nerve_spawn: cleared stale currentChannelId`);
          }
          joinNote = ` (auto-join channel failed: ${errStr})`;
        }
      }

      return ok(`spawned ${spawnedName} (${spawnedId})${joinNote}`);
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
      // Remember the channel so subsequent nerve_post auto-targets it
      currentChannelId = String(result.channelId);
      log(`nerve_create_channel ok, currentChannelId=${currentChannelId}`);
      return ok(`created channel ${currentChannelId}${result.name ? ` (${String(result.name)})` : ""}`);
    } catch (err) {
      log(`nerve_create_channel failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_delete_channel") {
    const { channel_id } = args as { channel_id: string };
    if (!channel_id) return fail("channel_id is required");
    try {
      log(`nerve_delete_channel channel=${channel_id}`);
      await post("/channel/delete", { channelId: channel_id });
      if (currentChannelId === channel_id) {
        currentChannelId = undefined;
        log(`nerve_delete_channel: cleared currentChannelId (deleted)`);
      }
      return ok(`deleted channel ${channel_id}`);
    } catch (err) {
      log(`nerve_delete_channel failed: ${err}`);
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
      // If joining self, track the channel
      if (agent_name === NERVE_NODE_NAME) {
        currentChannelId = channel_id;
      }
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
      // If removing self from tracked channel, clear it
      if (agent_name === NERVE_NODE_NAME && channel_id === currentChannelId) {
        currentChannelId = undefined;
        log(`nerve_remove: cleared currentChannelId (removed self)`);
      }
      return ok(`removed ${agent_name} from ${channel_id}`);
    } catch (err) {
      log(`nerve_remove failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_stop") {
    const { agent_name } = args as { agent_name: string };
    if (!agent_name) {
      return fail("agent_name is required");
    }

    try {
      log(`nerve_stop agent=${agent_name}`);
      await post("/node/stop", { nodeName: agent_name });
      return ok(`stopped ${agent_name}`);
    } catch (err) {
      log(`nerve_stop failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_session_reset") {
    const { summary_path } = args as { summary_path: string };
    if (!summary_path) return fail("summary_path is required");
    try {
      // Get current sessionId from node info to fill expectedSessionId
      const listResult = await post("/node/list", {});
      const self = (listResult.nodes as Record<string, unknown>[] | undefined)?.find((n) => n.name === NERVE_NODE_NAME);
      if (!self) return fail(`cannot find self node: ${NERVE_NODE_NAME}`);
      const expectedSessionId = self.sessionId as string;
      if (!expectedSessionId) return fail("no current session to reset");

      log(`nerve_session_reset from=${NERVE_NODE_NAME} session=${expectedSessionId} summary=${summary_path}`);
      const result = await post("/session/reset", {
        nodeName: NERVE_NODE_NAME,
        expectedSessionId,
        summaryPath: summary_path,
        selfReset: true,
      });
      return ok(`session reset: ${result.sessionId} (previous: ${result.previousSessionId})`);
    } catch (err) {
      log(`nerve_session_reset failed: ${err}`);
      return fail(String(err));
    }
  }

  return fail(`unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
