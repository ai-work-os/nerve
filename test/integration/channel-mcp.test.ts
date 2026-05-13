/**
 * nerve-channel end-to-end integration test.
 *
 *  nerve server (real)
 *     ▲                 ▲
 *     │ WS              │ WS
 *     │                 │
 *  WsClient ("agent")  nerve-channel.ts (MCP server, spawned as child)
 *                                ▲
 *                                │ stdio MCP
 *                                │
 *                         Client SDK (mock external Claude Code)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

import {
  WsClient, sleep, ROOT, startServer, stopServer, getTestPort,
} from "../helpers/vitest.js";

const ChannelEventSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()).optional(),
  }),
});

const EXT_NAME = "claude-ext-itest";

describe("nerve-channel integration", () => {
  beforeAll(startServer);
  afterAll(stopServer);

  let mcpClient: Client | null = null;
  let mcpTransport: StdioClientTransport | null = null;
  const received: { content: string; meta: Record<string, string> }[] = [];

  async function spawnChannelMcp(): Promise<void> {
    mcpClient = new Client({ name: "itest", version: "0.0.1" });
    mcpTransport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/channel-mcp/nerve-channel.ts"],
      cwd: ROOT,
      env: {
        ...process.env,
        NERVE_PORT: String(getTestPort()),
        NERVE_HOST: "127.0.0.1",
        NERVE_EXTERNAL_NODE_NAME: EXT_NAME,
      } as Record<string, string>,
      stderr: "pipe",
    });
    mcpClient.setNotificationHandler(ChannelEventSchema, async (n) => {
      received.push({
        content: n.params.content,
        meta: (n.params.meta ?? {}) as Record<string, string>,
      });
    });
    await mcpClient.connect(mcpTransport);
  }

  async function waitForExtNode(agent: WsClient, timeoutMs = 8000): Promise<{ id: string; name: string } | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await agent.request("node.list", {});
      const node = r.nodes?.find((n: any) => n.name === EXT_NAME);
      if (node) return { id: node.id, name: node.name };
      await sleep(100);
    }
    return null;
  }

  async function waitForReceived(predicate: (e: { content: string; meta: Record<string, string> }) => boolean, timeoutMs = 5000): Promise<{ content: string; meta: Record<string, string> } | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = received.find(predicate);
      if (hit) return hit;
      await sleep(50);
    }
    return null;
  }

  it("registers as a nerve node after MCP server starts", async () => {
    await spawnChannelMcp();
    // Use a separate WsClient as an inspecting "agent"
    const agent = new WsClient("itest-agent");
    await agent.connect();
    await agent.request("node.register", { name: "itest-agent", capabilities: ["ui"] });

    const ext = await waitForExtNode(agent);
    expect(ext, "claude-ext-itest should appear in node.list").not.toBeNull();

    await agent.disconnect();
  }, 30000);

  it("pushes channel.message into Claude Code as channel notification", async () => {
    received.length = 0;
    const agent = new WsClient("itest-agent2");
    await agent.connect();
    const reg = await agent.request("node.register", { name: "itest-agent2", capabilities: ["ui"] });

    const ext = await waitForExtNode(agent);
    expect(ext).not.toBeNull();

    // Build a channel containing both nodes
    const ch = await agent.request("channel.create", { cwd: "/tmp", name: "itest-room" });
    await agent.request("channel.join", { channelId: ch.channelId });
    await agent.request("channel.addNode", { channelId: ch.channelId, nodeId: ext!.id, name: EXT_NAME });

    // Post a message that mentions claude-ext-itest
    await agent.request("channel.post", { channelId: ch.channelId, content: `@${EXT_NAME} hello from agent` });

    // Expect: channel-mcp pushed a channel notification with the message text
    const evt = await waitForReceived((e) => e.content.includes("hello from agent"));
    expect(evt, "should receive channel notification").not.toBeNull();
    expect(evt!.meta.event).toMatch(/^channel\.(message|mention)$/);
    expect(evt!.meta.channel_id).toBe(ch.channelId);
    expect(evt!.meta.from_node).toBe("itest-agent2");

    await agent.disconnect();
  }, 30000);

  it("allows Claude Code (via MCP tool) to post back into the channel", async () => {
    const agent = new WsClient("itest-agent3");
    await agent.connect();
    await agent.request("node.register", { name: "itest-agent3", capabilities: ["ui"] });

    const ext = await waitForExtNode(agent);
    const ch = await agent.request("channel.create", { cwd: "/tmp", name: "itest-reply" });
    await agent.request("channel.join", { channelId: ch.channelId });
    await agent.request("channel.addNode", { channelId: ch.channelId, nodeId: ext!.id, name: EXT_NAME });

    // Simulate external Claude calling nerve_post tool
    const callResult = await mcpClient!.callTool({
      name: "nerve_post",
      arguments: { channel_id: ch.channelId, text: "reply via mcp" },
    });
    expect(callResult.isError).toBeFalsy();

    // Verify channel history now contains our reply
    await sleep(200);
    const hist = await agent.request("channel.history", { channelId: ch.channelId, limit: 20 });
    const ours = hist.messages.find((m: any) => m.from === EXT_NAME && m.content === "reply via mcp");
    expect(ours, "agent should see our message in channel history").toBeDefined();

    await agent.disconnect();
  }, 30000);

  it("delivers node.message (1:1 DM) as a channel notification", async () => {
    received.length = 0;
    const agent = new WsClient("itest-agent4");
    await agent.connect();
    await agent.request("node.register", { name: "itest-agent4", capabilities: ["ui"] });

    const ext = await waitForExtNode(agent);
    await agent.request("node.message", { nodeId: ext!.id, content: "psst, dm only" });

    const evt = await waitForReceived((e) => e.content.includes("psst, dm only"));
    expect(evt, "DM should arrive as channel notification").not.toBeNull();
    expect(evt!.meta.event).toBe("node.message");
    expect(evt!.meta.from_node).toBe("itest-agent4");
    expect(evt!.meta.channel_id).toBeUndefined();

    await agent.disconnect();
  }, 30000);

  it("exposes the expected set of tools to Claude Code", async () => {
    const list = await mcpClient!.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toContain("nerve_post");
    expect(names).toContain("nerve_dm");
    expect(names).toContain("nerve_create_channel");
    expect(names).toContain("nerve_spawn");
  });

  afterAll(async () => {
    if (mcpClient) await mcpClient.close().catch(() => undefined);
    if (mcpTransport) await mcpTransport.close().catch(() => undefined);
  });
});
