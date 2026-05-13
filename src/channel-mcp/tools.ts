/**
 * MCP tools exposed by nerve-channel to the external Claude Code.
 *
 * Each tool maps cleanly onto a nerve JSON-RPC method, with light
 * convenience (auto-resolve node names to ids, auto-join on create).
 */

import type { NerveWsClient } from "./ws-client.js";

export type Ctx = {
  wsClient: NerveWsClient;
  nodeId: string;
  nodeName: string;
};

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const TOOLS = [
  {
    name: "nerve_post",
    description: "Post a message to a nerve channel you are a member of.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Channel id (from channel notification's channel_id attribute)" },
        text: { type: "string", description: "Message text. Use @nodeName to mention." },
      },
      required: ["channel_id", "text"],
    },
  },
  {
    name: "nerve_create_channel",
    description: "Create a new channel and join it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional channel name" },
        cwd: { type: "string", description: "Optional cwd for grouping" },
      },
    },
  },
  {
    name: "nerve_close_channel",
    description: "Close (archive) a channel.",
    inputSchema: {
      type: "object",
      properties: { channel_id: { type: "string" } },
      required: ["channel_id"],
    },
  },
  {
    name: "nerve_channels",
    description: "List all active channels.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nerve_join",
    description: "Add another node (by name) to a channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        node_name: { type: "string" },
      },
      required: ["channel_id", "node_name"],
    },
  },
  {
    name: "nerve_leave",
    description: "Leave a channel ourselves.",
    inputSchema: {
      type: "object",
      properties: { channel_id: { type: "string" } },
      required: ["channel_id"],
    },
  },
  {
    name: "nerve_remove",
    description: "Remove a node (by name) from a channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        node_name: { type: "string" },
      },
      required: ["channel_id", "node_name"],
    },
  },
  {
    name: "nerve_members",
    description: "List the names of nodes in a channel.",
    inputSchema: {
      type: "object",
      properties: { channel_id: { type: "string" } },
      required: ["channel_id"],
    },
  },
  {
    name: "nerve_spawn",
    description: "Spawn a new agent node (codex, claude, gemini, etc).",
    inputSchema: {
      type: "object",
      properties: {
        adapter: { type: "string", description: "Adapter: claude / codex / gemini / mock" },
        name: { type: "string", description: "Optional node name" },
        cwd: { type: "string", description: "Optional working directory" },
        channel_id: { type: "string", description: "Optional channel to add the new node to" },
      },
      required: ["adapter"],
    },
  },
  {
    name: "nerve_node_list",
    description: "List all known nerve nodes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nerve_dm",
    description: "DM a node by name (1:1, not via a channel).",
    inputSchema: {
      type: "object",
      properties: {
        node_name: { type: "string" },
        content: { type: "string" },
      },
      required: ["node_name", "content"],
    },
  },
  {
    name: "nerve_history",
    description: "Fetch recent messages in a channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        limit: { type: "number" },
        before: { type: "number" },
      },
      required: ["channel_id"],
    },
  },
] as const;

function ok(value: unknown): ToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
}

async function findNodeIdByName(ws: NerveWsClient, name: string): Promise<string | undefined> {
  const r = (await ws.request("node.list", {})) as { nodes?: { id: string; name: string }[] };
  return r.nodes?.find((n) => n.name === name)?.id;
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: Ctx,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "nerve_post": {
        const channelId = args.channel_id as string;
        const content = args.text as string;
        if (!channelId || !content) return err("channel_id and text required");
        const r = await ctx.wsClient.request("channel.post", { channelId, content });
        return ok(r);
      }
      case "nerve_create_channel": {
        const params: Record<string, unknown> = {};
        if (args.name) params.name = args.name;
        if (args.cwd) params.cwd = args.cwd;
        const r = (await ctx.wsClient.request("channel.create", params)) as { channelId: string };
        if (r?.channelId) {
          await ctx.wsClient.request("channel.join", { channelId: r.channelId });
        }
        return ok(r);
      }
      case "nerve_close_channel": {
        const channelId = args.channel_id as string;
        if (!channelId) return err("channel_id required");
        const r = await ctx.wsClient.request("channel.close", { channelId });
        return ok(r);
      }
      case "nerve_channels": {
        const r = await ctx.wsClient.request("channel.list", {});
        return ok(r);
      }
      case "nerve_join": {
        const channelId = args.channel_id as string;
        const nodeName = args.node_name as string;
        if (!channelId || !nodeName) return err("channel_id and node_name required");
        const nodeId = await findNodeIdByName(ctx.wsClient, nodeName);
        if (!nodeId) return err(`node not found: ${nodeName}`);
        const r = await ctx.wsClient.request("channel.addNode", { channelId, nodeId, name: nodeName });
        return ok(r);
      }
      case "nerve_leave": {
        const channelId = args.channel_id as string;
        if (!channelId) return err("channel_id required");
        const r = await ctx.wsClient.request("channel.leave", { channelId });
        return ok(r);
      }
      case "nerve_remove": {
        const channelId = args.channel_id as string;
        const nodeName = args.node_name as string;
        if (!channelId || !nodeName) return err("channel_id and node_name required");
        const r = await ctx.wsClient.request("channel.removeNode", { channelId, nodeName });
        return ok(r);
      }
      case "nerve_members": {
        const channelId = args.channel_id as string;
        if (!channelId) return err("channel_id required");
        const r = (await ctx.wsClient.request("channel.list", {})) as { channels?: { id: string; nodes?: Record<string, string> }[] };
        const ch = r.channels?.find((c) => c.id === channelId);
        if (!ch) return err(`channel not found: ${channelId}`);
        const members = Object.keys(ch.nodes ?? {});
        return ok({ channelId, members });
      }
      case "nerve_spawn": {
        const adapter = args.adapter as string;
        if (!adapter) return err("adapter required");
        const params: Record<string, unknown> = { adapter };
        if (args.name) params.name = args.name;
        if (args.cwd) params.cwd = args.cwd;
        if (args.channel_id) params.channelId = args.channel_id;
        const r = await ctx.wsClient.request("node.spawn", params);
        return ok(r);
      }
      case "nerve_node_list": {
        const r = await ctx.wsClient.request("node.list", {});
        return ok(r);
      }
      case "nerve_dm": {
        const nodeName = args.node_name as string;
        const content = args.content as string;
        if (!nodeName || !content) return err("node_name and content required");
        const nodeId = await findNodeIdByName(ctx.wsClient, nodeName);
        if (!nodeId) return err(`node not found: ${nodeName}`);
        const r = await ctx.wsClient.request("node.message", { nodeId, content });
        return ok(r);
      }
      case "nerve_history": {
        const channelId = args.channel_id as string;
        if (!channelId) return err("channel_id required");
        const params: Record<string, unknown> = { channelId };
        if (typeof args.limit === "number") params.limit = args.limit;
        if (typeof args.before === "number") params.before = args.before;
        const r = await ctx.wsClient.request("channel.history", params);
        return ok(r);
      }
      default:
        return err(`unknown tool: ${name}`);
    }
  } catch (e) {
    return err(String((e as Error).message || e));
  }
}
