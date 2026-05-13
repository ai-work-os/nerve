/**
 * channel-mcp push.ts — pure transformer from nerve JSON-RPC notification
 * to Claude Code channel notification payload.
 */
import { describe, it, expect } from "vitest";
import { notificationToChannelEvent } from "../../src/channel-mcp/push.js";

describe("notificationToChannelEvent", () => {
  it("converts channel.message into channel notification payload", () => {
    const out = notificationToChannelEvent("claude-ext", {
      method: "channel.message",
      params: {
        channelId: "ch_abc",
        channelName: "main",
        message: {
          id: "msg_1",
          channelId: "ch_abc",
          from: "codex-alice",
          content: "hello @claude-ext, look at this",
          timestamp: 1700000000,
        },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.content).toBe("hello @claude-ext, look at this");
    expect(out!.meta.event).toBe("channel.message");
    expect(out!.meta.channel_id).toBe("ch_abc");
    expect(out!.meta.channel_name).toBe("main");
    expect(out!.meta.from_node).toBe("codex-alice");
    expect(out!.meta.message_id).toBe("msg_1");
  });

  it("converts channel.mention into channel notification with event=channel.mention", () => {
    const out = notificationToChannelEvent("claude-ext", {
      method: "channel.mention",
      params: {
        channelId: "ch_abc",
        channelName: "main",
        message: {
          id: "msg_2",
          channelId: "ch_abc",
          from: "codex-alice",
          content: "@claude-ext can you help?",
          timestamp: 1700000001,
        },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.meta.event).toBe("channel.mention");
    expect(out!.content).toBe("@claude-ext can you help?");
  });

  it("converts node.message (1v1 DM) into channel notification", () => {
    const out = notificationToChannelEvent("claude-ext", {
      method: "node.message",
      params: {
        content: "ping",
        from: "codex-alice",
      },
    });
    expect(out).not.toBeNull();
    expect(out!.content).toBe("ping");
    expect(out!.meta.event).toBe("node.message");
    expect(out!.meta.from_node).toBe("codex-alice");
    expect(out!.meta.channel_id).toBeUndefined();
  });

  it("drops own echo on channel.message (we said it ourselves)", () => {
    const out = notificationToChannelEvent("claude-ext", {
      method: "channel.message",
      params: {
        channelId: "ch_abc",
        message: {
          id: "msg_3",
          channelId: "ch_abc",
          from: "claude-ext",
          content: "i posted this myself",
          timestamp: 1700000002,
        },
      },
    });
    expect(out).toBeNull();
  });

  it("returns null for irrelevant notifications", () => {
    expect(
      notificationToChannelEvent("claude-ext", {
        method: "channel.nodeJoined",
        params: { channelId: "ch_abc", nodeId: "n1", nodeName: "alice" },
      }),
    ).toBeNull();
    expect(
      notificationToChannelEvent("claude-ext", {
        method: "node.statusChanged",
        params: { nodeId: "n1", status: "busy" },
      }),
    ).toBeNull();
  });

  it("only emits identifier-safe meta keys (channels spec requires letters/digits/underscores)", () => {
    const out = notificationToChannelEvent("claude-ext", {
      method: "channel.message",
      params: {
        channelId: "ch_abc",
        channelName: "main",
        message: {
          id: "msg_x",
          channelId: "ch_abc",
          from: "codex-alice",
          content: "hi",
          timestamp: 1700000003,
        },
      },
    });
    expect(out).not.toBeNull();
    for (const key of Object.keys(out!.meta)) {
      expect(key).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });

  it("meta values must all be strings", () => {
    const out = notificationToChannelEvent("claude-ext", {
      method: "channel.message",
      params: {
        channelId: "ch_abc",
        message: {
          id: "msg_y",
          channelId: "ch_abc",
          from: "codex-alice",
          content: "hi",
          timestamp: 1700000004,
        },
      },
    });
    expect(out).not.toBeNull();
    for (const v of Object.values(out!.meta)) {
      expect(typeof v).toBe("string");
    }
  });
});
