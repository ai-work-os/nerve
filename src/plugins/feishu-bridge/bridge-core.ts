/**
 * BridgeCore — feishu-bridge 的核心路由逻辑。
 *
 * 设计要点（dual-reviewer 反馈后调整）：
 *   - 入站方向：feishu → bridge.handleFeishuMessage → channel.create + node.spawn(codex)
 *     + bridge 自身 channel.join + channel.post("@<agent> ...")
 *   - 出站方向：bridge 通过 `node.message` 通知接收 codex 的回复。
 *     channel-manager 在 broadcastToChannel 里跳过 program nodes（commit 2c01c76 的"消息隔离"），
 *     所以 channel.message 不会到 bridge；只有 @mention 触发的 node.message 才会到。
 *     因此 prompt 里要明确指引 codex 用 nerve_post({ to: "feishu-bridge", content: ... }) 回复。
 *
 * 故意不继承 PluginBase，便于单测：通过 NerveTransport 接口注入 RPC，
 * 用真 MappingStore 验证持久化行为。
 */

import { extractText } from "./text-extract.js";
import type { MappingStore, ChatMapping } from "./mapping.js";
import type { IFeishuClient, ReceiveMessageEvent } from "./feishu-client.js";

export interface NerveTransport {
  /** Send a JSON-RPC request, return result */
  request(method: string, params?: Record<string, any>): Promise<any>;
}

export interface BridgeCoreOptions {
  transport: NerveTransport;
  feishu: IFeishuClient;
  mapping: MappingStore;
  /** Adapter name used to spawn the AI agent (e.g. "codex") */
  agentAdapter: string;
  /** Our own node name on nerve — receives @mention from agents in their nerve_post replies */
  bridgeNodeName: string;
  log: (level: "info" | "warn" | "error" | "debug", msg: string) => void;
  /**
   * Delay (ms) after node.spawn before posting the first user message.
   * Workaround: node.spawn returns when the process registers, but the agent's
   * ACP session is not yet ready — dispatchDirect fails with "no session" if
   * we post immediately. Observed handshake takes ~2s on home (codex). Default 4000ms.
   */
  spawnReadyDelayMs?: number;
}

/**
 * Make a stable, collision-resistant short id from a feishu chat id.
 * Truncating to 10 chars caused collisions for similarly-prefixed chat ids;
 * use a hash so 0..N chats can never collide.
 */
function makeShortId(feishuChatId: string): string {
  // FNV-1a 32-bit hash → 8 hex chars. Cheap, collision-free at our scale.
  let h = 0x811c9dc5;
  for (let i = 0; i < feishuChatId.length; i++) {
    h ^= feishuChatId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export class BridgeCore {
  private opts: BridgeCoreOptions;
  /** agentName → feishuChatId for reverse lookup when codex's node.message arrives */
  private agentToChat = new Map<string, string>();
  /** feishuChatId → most recent feishu message_id to use for reply() */
  private latestUserMessageId = new Map<string, string>();
  /** In-flight create promises to prevent racing on concurrent first messages */
  private creating = new Map<string, Promise<ChatMapping>>();

  constructor(opts: BridgeCoreOptions) {
    this.opts = opts;
    // Rebuild reverse index from persisted mapping
    for (const m of opts.mapping.all()) {
      this.agentToChat.set(m.agentName, m.feishuChatId);
    }
  }

  /** Handle an inbound feishu message — extract, ensure mapping, post to channel. */
  async handleFeishuMessage(evt: ReceiveMessageEvent): Promise<void> {
    const text = extractText(evt.messageType, evt.contentJson);
    if (!text) {
      this.opts.log("debug", `skip non-text message (type=${evt.messageType}, chat=${evt.chatId})`);
      return;
    }

    let mapping = this.opts.mapping.get(evt.chatId);
    if (!mapping) {
      mapping = await this.ensureMapping(evt.chatId);
    }

    // Remember latest user message id for AI reply forwarding
    this.latestUserMessageId.set(evt.chatId, evt.messageId);

    // Tell codex how to reply back. The hint persists across turns because
    // the agent's ACP session retains it; we still include it each time for safety.
    const content = [
      `@${mapping.agentName} ${text}`,
      ``,
      `[bridge hint] 回复用户请使用 nerve_post({ to: "${this.opts.bridgeNodeName}", content: "..." })。`,
      `nerve_post 的内容会被回填到飞书原会话。频道里的其他 @ 消息不会送达飞书。`,
    ].join("\n");

    try {
      await this.opts.transport.request("channel.post", {
        channelId: mapping.channelId,
        content,
      });
      this.opts.log("info", `feishu→channel: chat=${evt.chatId} msg=${evt.messageId} (${text.length} chars)`);
    } catch (err: any) {
      this.opts.log("error", `channel.post failed: ${err?.message || err}`);
    }
  }

  /**
   * Handle a `node.message` notification — codex's nerve_post reply lands here
   * because the agent @mentioned this bridge in its post.
   * params: { content, from }
   */
  handleNodeMessage(params: any): void {
    const content = params?.content as string | undefined;
    const from = params?.from as string | undefined;
    if (!content || !from) return;

    const feishuChatId = this.agentToChat.get(from);
    if (!feishuChatId) {
      // Either a stray @mention or from someone other than our spawned agents.
      this.opts.log("debug", `node.message from unknown source ${from}, ignoring`);
      return;
    }

    const replyTo = this.latestUserMessageId.get(feishuChatId);
    if (!replyTo) {
      this.opts.log("warn", `agent reply for chat=${feishuChatId} but no pending user message_id`);
      return;
    }

    this.opts.feishu.reply(replyTo, content).then(() => {
      this.opts.log("info", `agent→feishu: chat=${feishuChatId} msg=${replyTo} (${content.length} chars)`);
    }).catch(err => {
      this.opts.log("error", `feishu reply failed: ${err?.message || err}`);
    });
  }

  /** For testing — peek at internal mapping state */
  getMapping(feishuChatId: string): ChatMapping | undefined {
    return this.opts.mapping.get(feishuChatId);
  }

  /** Ensure channel + agent exist for this feishu chat. Concurrent-safe per chatId. */
  private async ensureMapping(feishuChatId: string): Promise<ChatMapping> {
    const existing = this.opts.mapping.get(feishuChatId);
    if (existing) return existing;
    const inflight = this.creating.get(feishuChatId);
    if (inflight) return inflight;

    const p = this.createMapping(feishuChatId);
    this.creating.set(feishuChatId, p);
    try {
      return await p;
    } finally {
      this.creating.delete(feishuChatId);
    }
  }

  private async createMapping(feishuChatId: string): Promise<ChatMapping> {
    const shortId = makeShortId(feishuChatId);
    const channelName = `feishu-${shortId}`;
    const agentName = `codex-feishu-${shortId}`;

    this.opts.log("info", `creating channel + agent for feishu chat ${feishuChatId} (shortId=${shortId})`);

    const ch = await this.opts.transport.request("channel.create", { name: channelName });
    const channelId = ch.channelId as string;

    try {
      // Bridge joins so route() can find it for @feishu-bridge mentions
      await this.opts.transport.request("channel.join", { channelId });

      // Spawn AI agent into the channel
      await this.opts.transport.request("node.spawn", {
        adapter: this.opts.agentAdapter,
        name: agentName,
        channelId,
      });

      // Wait for agent's ACP session to be ready before any prompt arrives.
      // See spawnReadyDelayMs docstring above.
      const delay = this.opts.spawnReadyDelayMs ?? 4000;
      if (delay > 0) {
        this.opts.log("debug", `waiting ${delay}ms for ${agentName} session handshake`);
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (err: any) {
      // Best-effort cleanup if the bridge join or agent spawn failed mid-flight
      this.opts.log("warn", `setup failed mid-flight, attempting channel cleanup: ${err?.message || err}`);
      try { await this.opts.transport.request("channel.delete", { channelId }); } catch {}
      throw err;
    }

    const mapping: ChatMapping = {
      feishuChatId,
      channelId,
      agentName,
      createdAt: new Date().toISOString(),
    };
    await this.opts.mapping.set(mapping);
    this.agentToChat.set(agentName, feishuChatId);
    return mapping;
  }
}
