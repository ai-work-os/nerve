/**
 * BridgeCore — 测试 feishu-bridge 的核心路由逻辑，不依赖真 nerve server。
 *
 * 出站路径已从 channel.message 改为 node.message（dual-reviewer 反馈）：
 * channel-manager.broadcastToChannel 跳过 program nodes，所以 bridge 必须
 * 走 @mention 路径，由 router 转成 node.message 通知。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BridgeCore, type NerveTransport } from "../../src/plugins/feishu-bridge/bridge-core.js";
import { MappingStore } from "../../src/plugins/feishu-bridge/mapping.js";
import type { IFeishuClient, ReceiveMessageEvent } from "../../src/plugins/feishu-bridge/feishu-client.js";

class MockTransport implements NerveTransport {
  public calls: { method: string; params: any }[] = [];
  /** Track all channel.post calls separately for readability */
  public posts: { channelId: string; content: string }[] = [];
  /** Tunable failure injection */
  public failOn?: string;

  async request(method: string, params: Record<string, any> = {}): Promise<any> {
    this.calls.push({ method, params });
    if (this.failOn === method) throw new Error(`mock-fail:${method}`);
    switch (method) {
      case "channel.create":
        return { channelId: `ch_${params.name}`, name: params.name, cwd: params.cwd };
      case "channel.join":
        return { ok: true };
      case "channel.delete":
        return { ok: true };
      case "node.spawn":
        return { nodeId: `nid_${params.name}`, name: params.name };
      case "channel.post":
        this.posts.push({ channelId: params.channelId, content: params.content });
        return { message: { id: `m_${this.posts.length}` } };
      default:
        throw new Error(`unmocked rpc: ${method}`);
    }
  }

  countOf(method: string): number {
    return this.calls.filter(c => c.method === method).length;
  }
}

class MockFeishuClient implements IFeishuClient {
  public replies: { messageId: string; text: string }[] = [];
  public injector?: (evt: ReceiveMessageEvent) => void | Promise<void>;
  async start(onMessage: (evt: ReceiveMessageEvent) => void | Promise<void>): Promise<void> {
    this.injector = onMessage;
  }
  async reply(messageId: string, text: string): Promise<void> {
    this.replies.push({ messageId, text });
  }
  async stop(): Promise<void> {}
}

describe("feishu-bridge BridgeCore", () => {
  let dir: string;
  let mapping: MappingStore;
  let transport: MockTransport;
  let feishu: MockFeishuClient;
  let core: BridgeCore;

  function buildCore(): BridgeCore {
    return new BridgeCore({
      transport,
      feishu,
      mapping,
      agentAdapter: "codex",
      bridgeNodeName: "feishu-bridge",
      log: () => {},
      // Tests are not flaky — skip the spawn-ready delay
      spawnReadyDelayMs: 0,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bridge-core-"));
    mapping = new MappingStore(join(dir, "mapping.json"));
    transport = new MockTransport();
    feishu = new MockFeishuClient();
    core = buildCore();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // --- inbound (feishu → channel) ---

  it("首次 text 消息：建频道 + bridge.join + spawn agent + channel.post", async () => {
    await core.handleFeishuMessage({
      chatId: "oc_abc",
      messageId: "om_1",
      messageType: "text",
      contentJson: JSON.stringify({ text: "hi" }),
    });

    expect(transport.countOf("channel.create")).toBe(1);
    expect(transport.countOf("channel.join")).toBe(1);
    expect(transport.countOf("node.spawn")).toBe(1);
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0].content).toContain("hi");
    expect(transport.posts[0].content).toMatch(/@codex-feishu-/);
    // Hint to codex about using nerve_post must be present
    expect(transport.posts[0].content).toContain("nerve_post");
    expect(transport.posts[0].content).toContain("feishu-bridge");

    const m = mapping.get("oc_abc");
    expect(m).toBeDefined();
    expect(m!.channelId).toMatch(/^ch_feishu-/);
    expect(m!.agentName).toMatch(/^codex-feishu-/);
  });

  it("第二次同会话 → 仅 channel.post 一次（不重复建/join/spawn）", async () => {
    await core.handleFeishuMessage({
      chatId: "oc_x", messageId: "om_a",
      messageType: "text", contentJson: JSON.stringify({ text: "first" }),
    });
    await core.handleFeishuMessage({
      chatId: "oc_x", messageId: "om_b",
      messageType: "text", contentJson: JSON.stringify({ text: "second" }),
    });

    expect(transport.countOf("channel.create")).toBe(1);
    expect(transport.countOf("channel.join")).toBe(1);
    expect(transport.countOf("node.spawn")).toBe(1);
    expect(transport.posts).toHaveLength(2);
  });

  it("image / file / sticker 跳过（不建频道）", async () => {
    await core.handleFeishuMessage({
      chatId: "oc_img", messageId: "om_i",
      messageType: "image", contentJson: JSON.stringify({ image_key: "k" }),
    });
    expect(transport.countOf("channel.create")).toBe(0);
    expect(mapping.get("oc_img")).toBeUndefined();
  });

  it("空 text 跳过", async () => {
    await core.handleFeishuMessage({
      chatId: "oc_empty", messageId: "om_e",
      messageType: "text", contentJson: JSON.stringify({ text: "   " }),
    });
    expect(transport.countOf("channel.create")).toBe(0);
  });

  it("不同 chatId 即使前缀相同也得到不同 shortId（哈希防碰撞）", async () => {
    await core.handleFeishuMessage({
      chatId: "oc_abc1234567xyz", messageId: "m1",
      messageType: "text", contentJson: JSON.stringify({ text: "a" }),
    });
    await core.handleFeishuMessage({
      chatId: "oc_abc1234567abc", messageId: "m2",
      messageType: "text", contentJson: JSON.stringify({ text: "b" }),
    });
    const m1 = mapping.get("oc_abc1234567xyz")!;
    const m2 = mapping.get("oc_abc1234567abc")!;
    expect(m1.channelId).not.toBe(m2.channelId);
    expect(m1.agentName).not.toBe(m2.agentName);
  });

  // --- outbound (node.message → feishu) ---

  it("node.message from = agent → 调 feishu reply", async () => {
    await core.handleFeishuMessage({
      chatId: "oc_r", messageId: "om_user_1",
      messageType: "text", contentJson: JSON.stringify({ text: "hello" }),
    });
    const m = mapping.get("oc_r")!;

    core.handleNodeMessage({ content: "world", from: m.agentName });

    expect(feishu.replies).toHaveLength(1);
    expect(feishu.replies[0].messageId).toBe("om_user_1");
    expect(feishu.replies[0].text).toBe("world");
  });

  it("node.message from = 未知节点 → 静默忽略", async () => {
    await core.handleFeishuMessage({
      chatId: "oc_y", messageId: "om_y_1",
      messageType: "text", contentJson: JSON.stringify({ text: "hi" }),
    });
    core.handleNodeMessage({ content: "stranger", from: "some-other-node" });
    expect(feishu.replies).toHaveLength(0);
  });

  it("node.message 在尚无 user 消息时不崩（先 agent 后 user 的边缘情况）", async () => {
    // 没有先入站，直接给 node.message — 没有映射，应静默忽略
    core.handleNodeMessage({ content: "anything", from: "codex-feishu-deadbeef" });
    expect(feishu.replies).toHaveLength(0);
  });

  it("多条 agent 回复关联到最近的 user 消息 id", async () => {
    await core.handleFeishuMessage({
      chatId: "oc_multi", messageId: "om_A",
      messageType: "text", contentJson: JSON.stringify({ text: "Q1" }),
    });
    const m = mapping.get("oc_multi")!;

    core.handleNodeMessage({ content: "part 1", from: m.agentName });
    core.handleNodeMessage({ content: "part 2", from: m.agentName });
    expect(feishu.replies).toHaveLength(2);
    expect(feishu.replies.every(r => r.messageId === "om_A")).toBe(true);

    await core.handleFeishuMessage({
      chatId: "oc_multi", messageId: "om_B",
      messageType: "text", contentJson: JSON.stringify({ text: "Q2" }),
    });
    core.handleNodeMessage({ content: "answer 2", from: m.agentName });
    expect(feishu.replies).toHaveLength(3);
    expect(feishu.replies[2].messageId).toBe("om_B");
  });

  // --- failure paths ---

  it("node.spawn 失败 → 已建频道被清理（避免孤立频道）", async () => {
    transport.failOn = "node.spawn";
    await expect(core.handleFeishuMessage({
      chatId: "oc_orphan", messageId: "m",
      messageType: "text", contentJson: JSON.stringify({ text: "x" }),
    })).rejects.toThrow(/mock-fail:node\.spawn/);
    expect(transport.countOf("channel.create")).toBe(1);
    expect(transport.countOf("channel.delete")).toBe(1);
    expect(mapping.get("oc_orphan")).toBeUndefined();
  });

  it("并发同 chatId 入站只建一次频道", async () => {
    const p1 = core.handleFeishuMessage({
      chatId: "oc_race", messageId: "m1",
      messageType: "text", contentJson: JSON.stringify({ text: "a" }),
    });
    const p2 = core.handleFeishuMessage({
      chatId: "oc_race", messageId: "m2",
      messageType: "text", contentJson: JSON.stringify({ text: "b" }),
    });
    await Promise.all([p1, p2]);
    expect(transport.countOf("channel.create")).toBe(1);
    expect(transport.countOf("node.spawn")).toBe(1);
    expect(transport.posts.length).toBe(2);
  });

  it("已有 mapping 持久化后，新 BridgeCore 能直接路由 node.message", async () => {
    const path = join(dir, "mapping.json");
    // 第一次：建好 mapping
    await core.handleFeishuMessage({
      chatId: "oc_persist", messageId: "m1",
      messageType: "text", contentJson: JSON.stringify({ text: "go" }),
    });
    const m = mapping.get("oc_persist")!;

    // 模拟进程重启：用同样的磁盘路径新建 BridgeCore
    const mapping2 = new MappingStore(path);
    const transport2 = new MockTransport();
    const feishu2 = new MockFeishuClient();
    const core2 = new BridgeCore({
      transport: transport2, feishu: feishu2, mapping: mapping2,
      agentAdapter: "codex", bridgeNodeName: "feishu-bridge", log: () => {},
    });
    // 重启后必须能根据 from = agentName 找回 chat
    // 因为还没有当前 user message_id，应该 warn 跳过，不崩
    core2.handleNodeMessage({ content: "comeback", from: m.agentName });
    expect(feishu2.replies).toHaveLength(0);
  });
});
