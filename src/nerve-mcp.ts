#!/usr/bin/env node
/**
 * Nerve MCP Server — injected into each node via session/new mcpServers.
 * Exposes orchestration tools for node-to-node communication and coordination.
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
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { filterNodes, mapNodes } from "./nerve-mcp-node-list.js";

const NERVE_PORT = process.env.NERVE_PORT || "4800";
const NERVE_NODE_NAME = process.env.NERVE_NODE_NAME || "unknown";
const MCP_CONFIG = readMcpConfig();
const DEFAULT_AI_ADAPTER = process.env.NERVE_DEFAULT_AI_ADAPTER || readStringConfig(MCP_CONFIG, "default_ai_adapter", "defaultAiAdapter") || "codex";
const BASE_URL = `http://127.0.0.1:${NERVE_PORT}`;

// Track the current channel this agent is in (set on create/join)
let currentChannelId: string | undefined;

function log(msg: string): void {
  process.stderr.write(`[nerve-mcp] ${msg}\n`);
}

function readMcpConfig(): Record<string, unknown> {
  try {
    const raw = readFileSync(join(homedir(), ".nerve", "config.json"), "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    return config && typeof config === "object" ? config : {};
  } catch {
    return {};
  }
}

function readStringConfig(config: Record<string, unknown>, snakeKey: string, camelKey: string): string | undefined {
  const value = config[snakeKey] ?? config[camelKey];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function findNodeByName(name: string): Promise<Record<string, unknown>> {
  const result = await post("/node/list", {});
  const node = (result.nodes as Record<string, unknown>[] | undefined)?.find((n) => n.name === name);
  if (!node) throw new Error(`node not found: ${name}`);
  return node;
}

async function waitForNodeReady(name: string, timeoutMs = 8000): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await post("/node/list", {});
    const node = (result.nodes as Record<string, unknown>[] | undefined)?.find((n) => n.name === name);
    if (node && node.status !== "connecting") return node;
    await sleep(250);
  }
  return undefined;
}

const server = new Server(
  { name: "nerve", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "nerve_post",
      description: "Send a message to another node in the channel. The message will be routed via @mention.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Target node name" },
          content: { type: "string", description: "Message content" },
          channel_id: { type: "string", description: "Target channel id (auto-detected if omitted)" },
        },
        required: ["to", "content"],
      },
    },
    {
      name: "nerve_spawn",
      description: "Spawn a worker node process managed by nerve.",
      inputSchema: {
        type: "object" as const,
        properties: {
          adapter: { type: "string", description: "Adapter name", default: DEFAULT_AI_ADAPTER },
          name: { type: "string", description: "Optional node name" },
          cwd: { type: "string", description: "Optional working directory. Defaults to this MCP process cwd if omitted." },
          model: { type: "string", description: "Optional model override for the new node" },
          channel_id: { type: "string", description: "Optional channel id to auto-join after spawn" },
          standalone: { type: "boolean", description: "If true, do not auto-join any channel after spawn" },
        },
      },
    },
    {
      name: "nerve_create_channel",
      description: "Create a new collaboration channel and auto-join the calling node.",
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
      description: "Add an existing node into a channel by node name.",
      inputSchema: {
        type: "object" as const,
        properties: {
          node_name: { type: "string", description: "Node name to join" },
          channel_id: { type: "string", description: "Target channel id" },
        },
        required: ["node_name", "channel_id"],
      },
    },
    {
      name: "nerve_remove",
      description: "Remove a node from a channel by node name.",
      inputSchema: {
        type: "object" as const,
        properties: {
          node_name: { type: "string", description: "Node name to remove" },
          channel_id: { type: "string", description: "Target channel id" },
        },
        required: ["node_name", "channel_id"],
      },
    },
    {
      name: "nerve_stop",
      description: "Stop/shutdown a node process by name. Removes it from all channels and terminates the process.",
      inputSchema: {
        type: "object" as const,
        properties: {
          node_name: { type: "string", description: "Node name to stop" },
        },
        required: ["node_name"],
      },
    },
    {
      name: "nerve_members",
      description: "List members of a channel. If channel_id is given, returns members of that channel. If omitted, returns members from all channels the caller is in.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel_id: { type: "string", description: "Channel id to query (optional — omit to get all caller's channels)" },
        },
      },
    },
    {
      name: "nerve_channels",
      description: "List all active channels. Returns channel id, name, cwd, and member count.",
      inputSchema: {
        type: "object" as const,
        properties: {
          cwd: { type: "string", description: "Filter channels by working directory (optional)" },
        },
      },
    },
    {
      name: "nerve_node_list",
      description: "List active nodes. Defaults to all node types; program nodes include commands, AI agents usually do not.",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string",
            enum: ["program", "agent", "all"],
            description: "Filter by node type (default: all)",
          },
          status: {
            type: "string",
            enum: ["idle", "busy", "error", "connecting"],
            description: "Filter by node status",
          },
        },
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
    {
      name: "nerve_command",
      description: "Send a structured command to a program node. AI agent nodes do not expose program commands; use nerve_post or nerve_members for agent communication checks.",
      inputSchema: {
        type: "object" as const,
        properties: {
          node: { type: "string", description: "Target program node name" },
          command: { type: "string", description: "Command name (e.g. start, stop, status)" },
          args: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Command arguments as key-value pairs",
          },
        },
        required: ["node", "command"],
      },
    },
    {
      name: "nerve_capabilities",
      description: "List available program node capabilities (adapters). Returns name, description, and supported commands for each capability. Use this to discover what program nodes are available before spawning them.",
      inputSchema: {
        type: "object" as const,
        properties: {},
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
    const { adapter, name: agentName, cwd, model, channel_id, standalone } = (args || {}) as { adapter?: string; name?: string; cwd?: string; model?: string; channel_id?: string; standalone?: boolean };
    try {
      const useAdapter = adapter || DEFAULT_AI_ADAPTER;
      const effectiveCwd = resolve(cwd || process.cwd());
      log(`nerve_spawn adapter=${useAdapter} name=${agentName || "auto"} cwd=${effectiveCwd} model=${model || ""} standalone=${!!standalone}`);
      const result = await post("/node/spawn", {
        adapter: useAdapter,
        name: agentName,
        cwd: effectiveCwd,
        model,
      });
      const spawnedName = String(result.name || agentName || "agent");
      const spawnedId = String(result.nodeId || "?");

      // Auto-join spawned agent to explicit channel_id or caller's current channel (unless standalone)
      const targetChannel = standalone ? undefined : (channel_id || currentChannelId);
      let joinNote = "";
      let joined = false;
      if (targetChannel && spawnedId !== "?") {
        try {
          await post("/channel/addNode", {
            channelId: targetChannel,
            nodeId: spawnedId,
            nodeName: spawnedName,
          });
          log(`nerve_spawn: auto-joined ${spawnedName} to channel ${targetChannel}`);
          joinNote = `, joined channel ${targetChannel}`;
          joined = true;
        } catch (joinErr) {
          const errStr = String(joinErr);
          log(`nerve_spawn: auto-join failed: ${errStr}`);
          if (!channel_id && errStr.includes("not found")) {
            currentChannelId = undefined;
            log(`nerve_spawn: cleared stale currentChannelId`);
          }
          joinNote = ` (auto-join channel failed: ${errStr})`;
        }
      }

      const readyNode = await waitForNodeReady(spawnedName);
      const registered = !!readyNode;
      const summary = {
        spawned: true,
        registered,
        ready: registered && (!targetChannel || joined),
        ...(registered ? {} : { reason: "handshake timeout" }),
        name: spawnedName,
        nodeId: spawnedId,
        cwd: effectiveCwd,
        status: typeof readyNode?.status === "string" ? readyNode.status : String(result.status || "connecting"),
        channel: targetChannel ? { id: targetChannel, joined } : null,
        message: `spawned ${spawnedName} (${spawnedId})${joinNote}`,
      };
      return ok(JSON.stringify(summary));
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
    const { node_name, channel_id } = args as { node_name: string; channel_id: string };
    if (!node_name || !channel_id) {
      return fail("node_name and channel_id are required");
    }

    try {
      log(`nerve_join node=${node_name} channel=${channel_id}`);
      const node = await findNodeByName(node_name);
      await post("/channel/addNode", {
        channelId: channel_id,
        nodeId: node.id,
        nodeName: node_name,
      });
      // If joining self, track the channel
      if (node_name === NERVE_NODE_NAME) {
        currentChannelId = channel_id;
      }
      return ok(`joined ${node_name} to ${channel_id}`);
    } catch (err) {
      log(`nerve_join failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_remove") {
    const { node_name, channel_id } = args as { node_name: string; channel_id: string };
    if (!node_name || !channel_id) {
      return fail("node_name and channel_id are required");
    }

    try {
      log(`nerve_remove node=${node_name} channel=${channel_id}`);
      await findNodeByName(node_name);
      await post("/channel/removeNode", {
        channelId: channel_id,
        nodeName: node_name,
      });
      // If removing self from tracked channel, clear it
      if (node_name === NERVE_NODE_NAME && channel_id === currentChannelId) {
        currentChannelId = undefined;
        log(`nerve_remove: cleared currentChannelId (removed self)`);
      }
      return ok(`removed ${node_name} from ${channel_id}`);
    } catch (err) {
      log(`nerve_remove failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_stop") {
    const { node_name } = args as { node_name: string };
    if (!node_name) {
      return fail("node_name is required");
    }

    try {
      log(`nerve_stop node=${node_name}`);
      await post("/node/stop", { nodeName: node_name });
      return ok(`stopped ${node_name}`);
    } catch (err) {
      log(`nerve_stop failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_members") {
    const { channel_id } = (args || {}) as { channel_id?: string };
    try {
      if (channel_id) {
        log(`nerve_members channel=${channel_id}`);
        const result = await post("/channel/members", { channelId: channel_id });
        return ok(JSON.stringify(result));
      } else {
        log(`nerve_members caller=${NERVE_NODE_NAME} (all channels)`);
        const result = await post("/channel/members", { nodeName: NERVE_NODE_NAME });
        return ok(JSON.stringify(result));
      }
    } catch (err) {
      log(`nerve_members failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_channels") {
    const { cwd } = (args || {}) as { cwd?: string };
    try {
      log(`nerve_channels cwd=${cwd || "all"}`);
      const result = await post("/channel/list", cwd ? { cwd } : {});
      const channels = (result.channels as Array<{ id: string; name?: string; cwd: string; nodes: Record<string, string> }>) || [];
      const mapped = channels.map(ch => ({
        id: ch.id,
        name: ch.name || null,
        cwd: ch.cwd,
        member_count: Object.keys(ch.nodes).length,
      }));
      return ok(JSON.stringify({ channels: mapped }));
    } catch (err) {
      log(`nerve_channels failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_node_list") {
    const { type: nodeType, status: statusFilter } = (args || {}) as {
      type?: "program" | "agent" | "all";
      status?: string;
    };
    try {
      log(`nerve_node_list type=${nodeType || "all"} status=${statusFilter || "all"}`);
      const result = await post("/node/list", { cwd: process.cwd() });
      const nodes = (result.nodes as Array<{ id: string; name: string; status: string; commands?: Record<string, { description: string; args?: Record<string, string> }>; events?: string[]; channels: string[] }>) || [];

      const filtered = filterNodes(nodes, nodeType, statusFilter);

      const channelResult = await post("/channel/list", {});
      const channelMap = new Map<string, string>();
      for (const ch of (channelResult.channels as Array<{ id: string; name?: string }>) || []) {
        if (ch.name) channelMap.set(ch.id, ch.name);
      }

      const mapped = mapNodes(filtered, channelMap);
      return ok(JSON.stringify({ nodes: mapped }));
    } catch (err) {
      log(`nerve_node_list failed: ${err}`);
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
        source: `mcp_tool:${NERVE_NODE_NAME}`,
      });
      return ok(`session reset: ${result.sessionId} (previous: ${result.previousSessionId})`);
    } catch (err) {
      log(`nerve_session_reset failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_command") {
    const { node, command, args: cmdArgs } = args as { node: string; command: string; args?: Record<string, string> };
    if (!node || !command) return fail("node and command are required");
    try {
      log(`nerve_command node=${node} command=${command} args=${JSON.stringify(cmdArgs || {})}`);
      const result = await post("/node/command", {
        nodeName: node,
        command,
        args: cmdArgs || {},
        from: NERVE_NODE_NAME,
      });
      if (result.error) return fail(String(result.error));
      if (result.reply) return ok(String(result.reply));
      return ok(`command "${command}" dispatched to ${node}`);
    } catch (err) {
      log(`nerve_command failed: ${err}`);
      return fail(String(err));
    }
  }

  if (name === "nerve_capabilities") {
    try {
      log("nerve_capabilities");
      const result = await post("/node/capabilities", {});
      return ok(JSON.stringify(result.capabilities || result));
    } catch (err) {
      log(`nerve_capabilities failed: ${err}`);
      return fail(String(err));
    }
  }

  return fail(`unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
