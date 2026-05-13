/**
 * channel-mcp tools.ts — MCP tool dispatch.
 *
 * Each tool call is exercised against a fake ws-client that records the
 * underlying JSON-RPC call.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TOOLS, handleTool } from "../../src/channel-mcp/tools.js";

class FakeWsClient {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  responses = new Map<string, unknown>();
  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.responses.has(method)) return this.responses.get(method);
    return { ok: true };
  }
}

function makeCtx(overrides: Partial<{ nodeName: string; nodeId: string }> = {}) {
  return {
    wsClient: new FakeWsClient() as any,
    nodeId: overrides.nodeId ?? "n_self",
    nodeName: overrides.nodeName ?? "claude-ext",
  };
}

describe("TOOLS list", () => {
  it("exposes the expected tools", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "nerve_post",
        "nerve_create_channel",
        "nerve_close_channel",
        "nerve_channels",
        "nerve_join",
        "nerve_leave",
        "nerve_remove",
        "nerve_members",
        "nerve_spawn",
        "nerve_node_list",
        "nerve_dm",
        "nerve_history",
      ].sort(),
    );
  });

  it("every tool has a description and inputSchema with type=object", () => {
    for (const tool of TOOLS) {
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect((tool.inputSchema as any).type).toBe("object");
    }
  });
});

describe("handleTool", () => {
  it("nerve_post forwards channelId + content to channel.post", async () => {
    const ctx = makeCtx();
    const fake = ctx.wsClient as unknown as FakeWsClient;
    fake.responses.set("channel.post", { message: { id: "m1", from: "claude-ext", content: "hi" } });
    const result = await handleTool("nerve_post", { channel_id: "ch_abc", text: "hi" }, ctx);
    expect(fake.calls[0]).toEqual({ method: "channel.post", params: { channelId: "ch_abc", content: "hi" } });
    expect(result.isError).toBeFalsy();
  });

  it("nerve_create_channel creates and auto-joins ourselves", async () => {
    const ctx = makeCtx();
    const fake = ctx.wsClient as unknown as FakeWsClient;
    fake.responses.set("channel.create", { channelId: "ch_new", name: "main" });
    const result = await handleTool("nerve_create_channel", { name: "main", cwd: "/tmp" }, ctx);
    const methods = fake.calls.map((c) => c.method);
    expect(methods).toContain("channel.create");
    expect(methods).toContain("channel.join");
    expect(result.isError).toBeFalsy();
  });

  it("nerve_channels calls channel.list", async () => {
    const ctx = makeCtx();
    const fake = ctx.wsClient as unknown as FakeWsClient;
    fake.responses.set("channel.list", { channels: [] });
    await handleTool("nerve_channels", {}, ctx);
    expect(fake.calls[0].method).toBe("channel.list");
  });

  it("nerve_join adds the named node to the channel", async () => {
    const ctx = makeCtx();
    const fake = ctx.wsClient as unknown as FakeWsClient;
    fake.responses.set("node.list", { nodes: [{ id: "n_other", name: "codex" }] });
    await handleTool("nerve_join", { channel_id: "ch_abc", node_name: "codex" }, ctx);
    const last = fake.calls[fake.calls.length - 1];
    expect(last.method).toBe("channel.addNode");
    expect(last.params).toMatchObject({ channelId: "ch_abc", nodeId: "n_other", name: "codex" });
  });

  it("nerve_remove removes the named node from the channel", async () => {
    const ctx = makeCtx();
    const fake = ctx.wsClient as unknown as FakeWsClient;
    await handleTool("nerve_remove", { channel_id: "ch_abc", node_name: "codex" }, ctx);
    expect(fake.calls[0]).toEqual({ method: "channel.removeNode", params: { channelId: "ch_abc", nodeName: "codex" } });
  });

  it("nerve_leave leaves the channel ourselves", async () => {
    const ctx = makeCtx();
    const fake = ctx.wsClient as unknown as FakeWsClient;
    await handleTool("nerve_leave", { channel_id: "ch_abc" }, ctx);
    expect(fake.calls[0]).toEqual({ method: "channel.leave", params: { channelId: "ch_abc" } });
  });

  it("nerve_close_channel closes a channel by id", async () => {
    const ctx = makeCtx();
    const fake = ctx.wsClient as unknown as FakeWsClient;
    await handleTool("nerve_close_channel", { channel_id: "ch_abc" }, ctx);
    expect(fake.calls[0]).toEqual({ method: "channel.close", params: { channelId: "ch_abc" } });
  });

  it("nerve_spawn calls node.spawn with adapter", async () => {
    const ctx = makeCtx();
    const fake = ctx.wsClient as unknown as FakeWsClient;
    fake.responses.set("node.spawn", { nodeId: "n_codex", name: "codex-1" });
    await handleTool("nerve_spawn", { adapter: "codex", cwd: "/tmp" }, ctx);
    expect(fake.calls[0]).toMatchObject({ method: "node.spawn", params: { adapter: "codex", cwd: "/tmp" } });
  });

  it("nerve_node_list calls node.list", async () => {
    const ctx = makeCtx();
    const fake = ctx.wsClient as unknown as FakeWsClient;
    fake.responses.set("node.list", { nodes: [] });
    await handleTool("nerve_node_list", {}, ctx);
    expect(fake.calls[0].method).toBe("node.list");
  });

  it("nerve_dm sends node.message to a named node", async () => {
    const ctx = makeCtx();
    const fake = ctx.wsClient as unknown as FakeWsClient;
    fake.responses.set("node.list", { nodes: [{ id: "n_codex", name: "codex" }] });
    await handleTool("nerve_dm", { node_name: "codex", content: "ping" }, ctx);
    const last = fake.calls[fake.calls.length - 1];
    expect(last.method).toBe("node.message");
    expect(last.params).toMatchObject({ nodeId: "n_codex", content: "ping" });
  });

  it("nerve_history calls channel.history with limit", async () => {
    const ctx = makeCtx();
    const fake = ctx.wsClient as unknown as FakeWsClient;
    await handleTool("nerve_history", { channel_id: "ch_abc", limit: 20 }, ctx);
    expect(fake.calls[0]).toEqual({ method: "channel.history", params: { channelId: "ch_abc", limit: 20 } });
  });

  it("nerve_members returns members from channel.list", async () => {
    const ctx = makeCtx();
    const fake = ctx.wsClient as unknown as FakeWsClient;
    fake.responses.set("channel.list", {
      channels: [{ id: "ch_abc", name: "main", nodes: { codex: "n_codex", "claude-ext": "n_self" } }],
    });
    const r = await handleTool("nerve_members", { channel_id: "ch_abc" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r)).toContain("codex");
    expect(JSON.stringify(r)).toContain("claude-ext");
  });

  it("returns isError=true for unknown tool", async () => {
    const ctx = makeCtx();
    const r = await handleTool("nerve_bogus", {}, ctx);
    expect(r.isError).toBe(true);
  });

  it("returns isError=true if the ws request rejects", async () => {
    const ctx = makeCtx();
    const fake = ctx.wsClient as unknown as FakeWsClient;
    fake.request = async () => { throw new Error("boom"); };
    const r = await handleTool("nerve_post", { channel_id: "x", text: "y" }, ctx);
    expect(r.isError).toBe(true);
  });
});
