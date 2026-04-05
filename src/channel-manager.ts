import { Channel } from "./channel.js";
import { ChannelStore } from "./channel-store.js";
import { NodePool } from "./node-pool.js";
import { route } from "./router.js";
import { Store } from "./store.js";
import { NerveNode } from "./node.js";
import { BlobStore } from "./blob-store.js";
import type { MessageInfo, PermissionLevel, JsonRpcNotification } from "./protocol.js";
import type { WebSocket } from "ws";
import * as log from "./logger.js";

/**
 * Build the system prompt injected into agent nodes when joining a channel.
 */
export function buildSystemPrompt(agentName: string, channelId: string, members: string[]): string {
  const memberList = members.length > 0 ? members.join(", ") : "(none yet)";
  return [
    `你是 ${agentName}，在一个多 agent 协作频道里。`,
    ``,
    `可用工具：`,
    `- nerve_post({ to: "agent名", content: "消息内容" }) 发送频道消息`,
    `- nerve_spawn({ adapter, name?, cwd? }) 创建子 agent`,
    `- nerve_create_channel({ name? }) 创建频道`,
    `- nerve_join({ agent_name, channel_id }) 把 agent 加入频道`,
    `- nerve_remove({ agent_name, channel_id }) 把 agent 移出频道`,
    ``,
    `发消息给其他 agent：使用 nerve_post 工具`,
    `  nerve_post({ to: "agent名", content: "消息内容" })`,
    ``,
    `频道规则：`,
    `- 频道消息 50 字以内，只写结论`,
    `- 长内容写文件，文件放 ~/.nerve/docs/ 目录下，频道里附文件路径`,
    `- 每个任务回复一次，然后等指令`,
    ``,
    `频道成员：${memberList}`,
    `频道 ID：${channelId}`,
  ].join("\n");
}

export interface ChannelManagerOptions {
  dataDir: string;
  port: number;
}

export class ChannelManager {
  readonly store: Store;
  readonly nodePool: NodePool;
  readonly blobStore: BlobStore;
  readonly channelStore: ChannelStore;
  readonly dataDir: string;
  private port: number;

  // External hook for server to receive node events (for direct subscriptions)
  onNodeEvent?: (event: string, node: NerveNode, detail?: Record<string, unknown>) => void;

  // External hook for channel lifecycle events (create/close)
  onChannelEvent?: (event: string, channel: Channel) => void;

  constructor(opts: ChannelManagerOptions) {
    this.port = opts.port;
    this.dataDir = opts.dataDir;
    this.store = new Store(`${opts.dataDir}/nerve.db`);
    this.blobStore = new BlobStore(opts.dataDir);
    this.channelStore = new ChannelStore(this.store);

    // Mark all old nodes as stopped on startup
    this.store.markAllNodesStopped();

    this.nodePool = new NodePool(this.store, (event, node, detail) => {
      this.handleNodeEvent(event, node, detail);
    });
  }

  // --- Channel operations ---

  createChannel(cwd: string, name?: string): Channel {
    const ch = this.channelStore.create(cwd, name);
    this.onChannelEvent?.("channel.created", ch);
    return ch;
  }

  getChannel(id: string): Channel | undefined {
    return this.channelStore.get(id);
  }

  listChannels(): Channel[] {
    return this.channelStore.list();
  }

  restoreChannel(channelId: string): { channel: Channel; messages: MessageInfo[] } | null {
    const existed = this.channelStore.has(channelId);
    const result = this.channelStore.restore(channelId);
    if (!result) return null;
    if (!existed) {
      this.onChannelEvent?.("channel.created", result.channel);
    }
    return result;
  }

  closeChannel(id: string): void {
    const ch = this.channelStore.get(id);
    if (!ch) return;

    // Remove all nodes from channel (update both sides: ch.nodes + node.channels)
    for (const [nodeName] of ch.nodes) {
      const nodeId = ch.getNodeId(nodeName);
      ch.removeNode(nodeName, this.store);
      if (nodeId) {
        const node = this.nodePool.get(nodeId);
        if (node) node.channels.delete(id);
      }
    }

    this.onChannelEvent?.("channel.closed", ch);
    this.channelStore.close(id);
  }

  deleteChannel(id: string): void {
    const ch = this.channelStore.get(id);

    // If channel is active, remove all nodes first
    if (ch) {
      for (const [nodeName] of ch.nodes) {
        const nodeId = ch.getNodeId(nodeName);
        ch.removeNode(nodeName, this.store);
        if (nodeId) {
          const node = this.nodePool.get(nodeId);
          if (node) node.channels.delete(id);
        }
      }
      this.onChannelEvent?.("channel.deleted", ch);
    }

    this.channelStore.delete(id);
    log.info(`channel deleted: ${id}`);
  }

  // --- Node operations ---

  registerNode(ws: WebSocket, name: string, capabilities: string[], permissions: PermissionLevel): NerveNode {
    return this.nodePool.registerWebSocket(ws, name, capabilities, permissions);
  }

  async spawnNode(adapter: string, name: string, cwd: string): Promise<NerveNode> {
    return this.nodePool.spawnProcess(adapter, name, cwd, this.port);
  }

  /** Spawn node and return ID immediately (handshake runs in background) */
  spawnNodeSync(adapter: string, name: string, cwd: string): string {
    const node = this.nodePool.spawnProcessSync(adapter, name, cwd, this.port);
    return node.id;
  }

  async stopNode(nodeId: string): Promise<void> {
    // Remove from all channels first
    const node = this.nodePool.get(nodeId);
    if (node) {
      for (const chId of node.channels) {
        const ch = this.channelStore.get(chId);
        if (ch) {
          ch.removeNode(node.name, this.store);
          this.broadcastToChannel(chId, {
            jsonrpc: "2.0",
            method: "channel.nodeLeft",
            params: { channelId: chId, nodeId: node.id, nodeName: node.name },
          });
        }
      }
    }
    await this.nodePool.stopNode(nodeId);
  }

  // --- Channel-Node binding ---

  addNodeToChannel(channelId: string, nodeId: string, nodeName?: string): void {
    const ch = this.channelStore.get(channelId);
    const node = this.nodePool.get(nodeId);
    if (!ch || !node) return;

    const name = nodeName || node.name;
    ch.addNode(nodeId, name, this.store);
    node.channels.add(channelId);

    // Inject system prompt for process nodes joining a channel
    if (node.isProcess && !node.systemPrompt) {
      const members = [...ch.nodes.keys()].filter(n => n !== name);
      node.systemPrompt = this.buildSystemPromptForNode(name, channelId, members);
    }

    this.broadcastToChannel(channelId, {
      jsonrpc: "2.0",
      method: "channel.nodeJoined",
      params: { channelId, nodeId, nodeName: name },
    });
  }

  removeNodeFromChannel(channelId: string, nodeName: string): void {
    const ch = this.channelStore.get(channelId);
    if (!ch) return;

    const nodeId = ch.getNodeId(nodeName);
    ch.removeNode(nodeName, this.store);

    if (nodeId) {
      const node = this.nodePool.get(nodeId);
      if (node) node.channels.delete(channelId);
    }

    this.broadcastToChannel(channelId, {
      jsonrpc: "2.0",
      method: "channel.nodeLeft",
      params: { channelId, nodeId, nodeName },
    });
  }

  /**
   * Clean up a stale guardian node before re-spawning.
   * Identity check: must be a program node (spawned via spawnProgramNode, tracked in programProcesses).
   * Returns: "cleaned" if stale node was removed, "alive" if a live guardian exists, "none" if no guardian found.
   */
  cleanupStaleGuardian(name: string): "cleaned" | "alive" | "none" {
    const node = this.nodePool.getByName(name);
    if (!node) return "none";

    // Identity check: must be a program node (spawned by server, not an external WS client)
    if (!this.nodePool.isProgramNode(node.id)) {
      log.info(`cleanupStaleGuardian: ${name} (${node.id}) is not a program node, removing impostor`);
      for (const chId of node.channels) {
        this.removeNodeFromChannel(chId, node.name);
      }
      this.nodePool.remove(node.id);
      return "none"; // Non-program node cannot be a real guardian
    }

    if (node.transport.alive) {
      log.info(`cleanupStaleGuardian: ${name} (${node.id}) transport alive, skipping`);
      return "alive";
    }

    // Transport dead — full cleanup: channels first, then remove
    log.info(`cleanupStaleGuardian: cleaning stale program node ${name} (${node.id})`);
    for (const chId of node.channels) {
      this.removeNodeFromChannel(chId, node.name);
    }
    this.nodePool.remove(node.id);
    return "cleaned";
  }

  // --- Messaging ---

  postMessage(channelId: string, from: string, content: string): MessageInfo | null {
    const ch = this.channelStore.get(channelId);
    if (!ch) return null;

    // Auto-convert long content to blob
    const blobRef = this.blobStore.maybeStore(content);
    const storedContent = blobRef
      ? JSON.stringify(blobRef)
      : content;

    // Resolve nodeType from sender name
    const senderNode = this.nodePool.getByName(from);
    let nodeType: string | undefined;
    if (senderNode) {
      if (this.nodePool.isProgramNode(senderNode.id)) {
        nodeType = "program";
      } else {
        nodeType = senderNode.transport.type; // "stdio" or "websocket"
      }
    }
    const metadata = nodeType ? { nodeType } : undefined;

    const msg = ch.postMessage(from, storedContent, this.store, metadata);

    // Broadcast to all nodes in channel
    this.broadcastToChannel(channelId, {
      jsonrpc: "2.0",
      method: "channel.message",
      params: { channelId, message: msg },
    });

    // Route @mentions
    const targets = route(ch, msg);
    for (const target of targets) {
      const node = this.nodePool.get(target.nodeId);
      if (!node) continue;

      if (node.isProcess) {
        this.dispatchDirect(target.nodeId, node, msg.content, channelId, msg.from);
      } else {
        // Direct mention notification for WS nodes
        node.transport.send({
          jsonrpc: "2.0",
          method: "channel.mention",
          params: { channelId, message: msg },
        } as any);
      }
    }

    return msg;
  }

  /** Post from a Process Node (via MCP tool / HTTP endpoint) */
  postFromProcess(nodeName: string, content: string): MessageInfo {
    const node = this.nodePool.getByName(nodeName);
    if (!node) throw new Error(`node "${nodeName}" not found`);

    if (node.channels.size === 0) {
      throw new Error(`node "${nodeName}" has not joined any channel`);
    }

    if (node.channels.size > 1) {
      throw new Error(`node "${nodeName}" is in ${node.channels.size} channels, specify channelId`);
    }

    const chId = [...node.channels][0];
    const msg = this.postMessage(chId, nodeName, content);
    if (!msg) throw new Error(`failed to post to channel ${chId}`);
    return msg;
  }

  getHistory(channelId: string, limit?: number, before?: number): MessageInfo[] {
    return this.store.getMessages(channelId, limit, before);
  }

  getNodeUpdates(nodeName: string): Record<string, unknown>[] {
    const node = this.nodePool.getByName(nodeName);
    return node ? [...node.updateBuffer] : [];
  }

  // --- Internal ---

  /** Direct dispatch: if node is busy, cancel first then prompt.
   *  After prompt completes, auto-post agent's reply back to channel. */
  private dispatchDirect(nodeId: string, node: NerveNode, content: string, channelId?: string, fromName?: string): void {
    // Prepend source info so agent knows context
    let prompt = content;
    if (channelId && fromName) {
      prompt = `[channel: ${channelId}] from: ${fromName}\n\n${content}`;
    }
    if (!node.prompted && node.systemPrompt) {
      prompt = node.systemPrompt + "\n\n" + prompt;
      node.prompted = true;
    }

    const doPrompt = () => {
      // Record buffer position before prompting
      const bufferStart = node.updateBuffer.length;
      log.info(`dispatch: prompting ${node.name} (buffer@${bufferStart}, channel=${channelId || "none"})`);

      this.nodePool.promptNode(nodeId, prompt).then((result) => {
        if (!channelId) return;

        if (result.error) {
          log.warn(`prompt ${node.name} returned error: ${result.error}`);
          this.postMessage(channelId, node.name, `[error: ${String(result.error).slice(0, 100)}]`);
          return;
        }

        const newEntries = node.updateBuffer.length - bufferStart;
        log.info(`dispatch: ${node.name} done, ${newEntries} updates (agent replies via nerve_post)`);
      }).catch(err => {
        log.warn(`prompt ${node.name} exception: ${err}`);
        if (channelId) {
          this.postMessage(channelId, node.name, `[error: prompt failed — ${String(err).slice(0, 100)}]`);
        }
      });
    };

    if (node.status === "busy") {
      log.info(`dispatch: ${node.name} is busy, cancelling before new prompt`);
      this.nodePool.cancelNode(nodeId).then(() => doPrompt()).catch(err => {
        log.warn(`cancel ${node.name} failed: ${err}, prompting anyway`);
        doPrompt();
      });
    } else {
      doPrompt();
    }
  }

  /** @deprecated auto-reply removed — agents reply via nerve_post */
  // extractReplyFromUpdates removed: agents are responsible for replying via nerve_post

  // Delegates to the exported standalone function
  private buildSystemPromptForNode(agentName: string, channelId: string, members: string[]): string {
    return buildSystemPrompt(agentName, channelId, members);
  }

  private broadcastToChannel(channelId: string, notification: JsonRpcNotification): void {
    const ch = this.channelStore.get(channelId);
    if (!ch) return;

    for (const [, nodeId] of ch.nodes) {
      const node = this.nodePool.get(nodeId);
      if (node && node.isProcess) continue; // process nodes only speak ACP, skip channel broadcasts
      if (node && node.transport.alive) {
        node.transport.send(notification as any);
      }
    }
  }

  private handleNodeEvent(event: string, node: NerveNode, detail?: Record<string, unknown>): void {
    // Notify external hook (server's direct subscribers)
    this.onNodeEvent?.(event, node, detail);

    switch (event) {
      case "node.registered":
        log.info(`node registered: ${node.name} (${node.transport.type})`);
        break;

      case "node.ready":
        log.info(`node ready: ${node.name} (session: ${node.sessionId})`);
        break;

      case "node.stopped": {
        log.info(`node stopped: ${node.name} (exit: ${detail?.exitCode})`);
        // Notify channels
        for (const chId of node.channels) {
          const ch = this.channelStore.get(chId);
          if (ch) {
            ch.removeNode(node.name, this.store);
            // Post system message
            this.postMessage(chId, "系统", `${node.name} 已退出 (原因: ${detail?.reason || "unknown"}, exit: ${detail?.exitCode})`);
          }
        }
        break;
      }

      case "node.error":
        log.error(`node error: ${node.name}: ${detail?.error}`);
        break;

      case "node.update":
        // Session output (thinking/tool_call/message_chunk) stays in node.subscribe path only.
        // Channels only carry channel.message / channel.mention — no DM session leakage.
        break;

      case "node.statusChanged":
        // Broadcast status to all channels the node is in
        for (const chId of node.channels) {
          this.broadcastToChannel(chId, {
            jsonrpc: "2.0",
            method: "node.statusChanged",
            params: {
              nodeId: node.id,
              name: node.name,
              status: node.status,
              activity: node.activity,
            },
          });
        }
        break;

      case "node.removed":
        log.info(`node removed: ${node.name}`);
        break;
    }
  }

  async shutdown(): Promise<void> {
    await this.nodePool.shutdown();
    this.store.close();
  }
}
