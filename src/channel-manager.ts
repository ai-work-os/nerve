import { Channel } from "./channel.js";
import { ChannelStore } from "./storage/channel-store.js";
import { NodePool } from "./node-pool.js";
import type { SpawnOptions } from "./node-pool.js";
import { route } from "./router.js";
import { Store } from "./storage/store.js";
import { NerveNode } from "./node.js";
import { BlobStore } from "./storage/blob-store.js";
import type { MessageInfo, PermissionLevel, JsonRpcNotification, Message } from "./protocol.js";
import type { WebSocket } from "ws";
import { EventLogger } from "./infra/event-logger.js";
import { PeerClient } from "./peer-client.js";
import { loadPeerConfig } from "./peer-config.js";
import { isRemoteMemberId } from "./channel-member.js";
import { RemoteRegistry, type RemoteMemberRecord, type RemoteOriginRecord } from "./remote-registry.js";
import * as log from "./infra/logger.js";

/**
 * Build the system prompt injected into agent nodes when joining a channel.
 */
export function buildSystemPrompt(agentName: string, channelId: string, members: string[]): string {
  const memberList = members.length > 0 ? members.join(", ") : "(none yet)";
  return [
    `你是 ${agentName}，在一个多 node 协作频道里。`,
    ``,
    `可用工具：`,
    `- nerve_post({ to: "node名", content: "消息内容" }) 发送频道消息`,
    `- nerve_spawn({ adapter, name?, cwd? }) 创建子 node`,
    `- nerve_create_channel({ name? }) 创建频道`,
    `- nerve_join({ node_name, channel_id }) 把 node 加入频道`,
    `- nerve_remove({ node_name, channel_id }) 把 node 移出频道`,
    ``,
    `发消息给其他 node：使用 nerve_post 工具`,
    `  nerve_post({ to: "node名", content: "消息内容" })`,
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
  eventLogPath?: string;
}

export class ChannelManager {
  readonly store: Store;
  readonly nodePool: NodePool;
  readonly blobStore: BlobStore;
  readonly channelStore: ChannelStore;
  readonly eventLogger: EventLogger;
  readonly remoteRegistry = new RemoteRegistry();
  readonly dataDir: string;
  private port: number;

  // External hook for server to receive node events (for direct subscriptions)
  onNodeEvent?: (event: string, node: NerveNode, detail?: Record<string, unknown>) => void;

  // External hook for channel lifecycle events (create/close)
  onChannelEvent?: (event: string, channel: Channel) => void;

  // External hook for channel member changes (join/leave) — broadcast globally
  onMemberEvent?: (event: string, channelId: string, nodeId: string, nodeName: string) => void;

  // External hook for node spawn actions — broadcast globally for clients with DM actions.
  onSpawnEvent?: (event: string, detail: {
    nodeId: string;
    name: string;
    adapter?: string | null;
    spawnedByNodeId: string;
    spawnedByNodeName: string;
    channelId?: string | null;
  }) => void;

  constructor(opts: ChannelManagerOptions) {
    this.port = opts.port;
    this.dataDir = opts.dataDir;
    this.store = new Store(`${opts.dataDir}/nerve.db`);
    this.blobStore = new BlobStore(opts.dataDir);
    this.channelStore = new ChannelStore(this.store);
    this.eventLogger = new EventLogger(opts.eventLogPath);

    // Mark all old nodes as stopped on startup
    this.store.markAllNodesStopped();

    this.nodePool = new NodePool(this.store, (event, node, detail) => {
      this.handleNodeEvent(event, node, detail);
    });
  }

  // --- Channel operations ---

  createChannel(cwd: string, name?: string): Channel {
    const ch = this.channelStore.create(cwd, name);
    this.eventLogger.log("channel.created", { channelId: ch.id, name: ch.name, cwd: ch.cwd });
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

  async spawnNode(adapter: string, name: string, cwd: string, options: SpawnOptions = {}): Promise<NerveNode> {
    return this.nodePool.spawnProcess(adapter, name, cwd, this.port, options);
  }

  async spawnRemoteNode(input: { peer: string; adapter: string; name: string; cwd?: string; channelId: string; model?: string }): Promise<{ nodeId: string; name: string }> {
    const config = loadPeerConfig();
    const peer = config.peers[input.peer];
    if (!peer) throw new Error(`peer not configured: ${input.peer}`);

    const client = new PeerClient(peer);
    const result = await client.post("/peer/remote-spawn", {
      adapter: input.adapter,
      name: input.name,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      originPeer: config.name || "local",
      originChannelId: input.channelId,
      model: input.model,
    }) as { nodeId: string; name: string; channelId: string };

    const proxy = this.remoteRegistry.registerRemoteMember({
      localChannelId: input.channelId,
      remoteChannelId: result.channelId,
      peer: input.peer,
      remoteNode: result.name,
    });
    const ch = this.channelStore.get(input.channelId);
    if (!ch) throw new Error(`channel not found: ${input.channelId}`);

    this.store.insertNode(proxy.localId, proxy.localName, "remote", "remote", ["remote"], input.cwd);
    this.store.updateNodeStatus(proxy.localId, "idle");
    ch.addNode(proxy.localId, proxy.localName, this.store);
    this.broadcastToChannel(input.channelId, {
      jsonrpc: "2.0",
      method: "channel.nodeJoined",
      params: { channelId: input.channelId, nodeId: proxy.localId, nodeName: proxy.localName },
    });
    this.onMemberEvent?.("channel.nodeJoined", input.channelId, proxy.localId, proxy.localName);
    this.eventLogger.log("remote.spawn", { peer: input.peer, remoteNode: result.name, localChannelId: input.channelId });
    return { nodeId: proxy.localId, name: proxy.localName };
  }

  /** Spawn node and return ID immediately (handshake runs in background) */
  spawnNodeSync(adapter: string, name: string, cwd: string, options: SpawnOptions = {}): string {
    const node = this.nodePool.spawnProcessSync(adapter, name, cwd, this.port, options);
    return node.id;
  }

  notifyNodeSpawned(detail: {
    nodeId: string;
    name: string;
    adapter?: string | null;
    spawnedByNodeId: string;
    spawnedByNodeName: string;
    channelId?: string | null;
  }): void {
    const parent = this.nodePool.get(detail.spawnedByNodeId);
    if (parent) {
      this.nodePool.appendSystemMessage(parent, `已创建 ${detail.name}`, {
        type: "open_dm",
        nodeId: detail.nodeId,
        nodeName: detail.name,
      });
    }
    this.onSpawnEvent?.("node.spawned", detail);
    this.eventLogger.log("node.spawned", detail);
  }

  async stopNode(nodeId: string): Promise<void> {
    // Remove from all channels first
    const node = this.nodePool.get(nodeId);
    if (node) {
      for (const chId of [...node.channels]) {
        this.removeNodeFromChannel(chId, node.name);
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
    // Broadcast globally so all WS clients (including TUI not in channel) see member changes
    this.onMemberEvent?.("channel.nodeJoined", channelId, nodeId, name);
    this.eventLogger.log("channel.nodeJoined", { channelId, nodeId, nodeName: name });
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
    // Broadcast globally so all WS clients (including TUI not in channel) see member changes
    this.onMemberEvent?.("channel.nodeLeft", channelId, nodeId || "", nodeName);
    this.eventLogger.log("channel.nodeLeft", { channelId, nodeId, nodeName });
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

    // Resolve nodeType and source from sender name
    const senderNode = this.nodePool.getByName(from);
    let nodeType: string | undefined;
    let source: string | undefined;
    if (senderNode) {
      if (this.nodePool.isProgramNode(senderNode.id)) {
        nodeType = "program";
      } else {
        nodeType = senderNode.transport.type; // "stdio" or "websocket"
      }
      source = senderNode.source;
    }
    const metadata: Record<string, unknown> | undefined =
      (nodeType || source) ? { ...(nodeType ? { nodeType } : {}), ...(source ? { source } : {}) } : undefined;

    const msg = ch.postMessage(from, storedContent, this.store, metadata);

    // Broadcast to all nodes in channel
    this.broadcastToChannel(channelId, {
      jsonrpc: "2.0",
      method: "channel.message",
      params: { channelId, message: msg },
    });
    this.eventLogger.log("channel.message", {
      channelId,
      messageId: msg.id,
      from: msg.from,
      content: msg.content,
      metadata: msg.metadata,
    });

    // Route @mentions
    const targets = route(ch, msg);
    if (targets.length > 0) {
      log.info(`route: ${msg.from} → [${targets.map(t => t.nodeName).join(", ")}] in channel ${channelId}`);
    }
    for (const target of targets) {
      if (isRemoteMemberId(target.nodeId)) {
        const remote = this.remoteRegistry.getRemoteMember(target.nodeName);
        if (remote) {
          void this.dispatchRemote(remote, msg.content, msg.id, msg.from);
        }
        continue;
      }

      const node = this.nodePool.get(target.nodeId);
      if (!node) continue;

      if (node.isProcess) {
        this.eventLogger.log("channel.mention", {
          channelId,
          messageId: msg.id,
          from: msg.from,
          content: msg.content,
          targetNodeId: target.nodeId,
          targetNodeName: target.nodeName,
          delivery: "direct_prompt",
        });
        this.dispatchDirect(target.nodeId, node, msg.content, channelId, msg.from);
      } else if (this.nodePool.isProgramNode(target.nodeId)) {
        // Program nodes handle commands via node.message — strip @mention prefix
        const mentionPrefix = `@${target.nodeName}`;
        const cmdContent = msg.content.startsWith(mentionPrefix)
          ? msg.content.slice(mentionPrefix.length).trim()
          : msg.content;
        if (node.transport.alive) {
          node.transport.send({
            jsonrpc: "2.0",
            method: "node.message",
            params: { content: cmdContent, from: msg.from },
          } as any);
        }
        this.eventLogger.log("channel.mention", {
          channelId,
          messageId: msg.id,
          from: msg.from,
          content: msg.content,
          targetNodeId: target.nodeId,
          targetNodeName: target.nodeName,
          delivery: "program_node_message",
        });
        log.info(`mention routed to program node ${target.nodeName} via node.message: "${cmdContent.slice(0, 50)}"`);
      } else {
        // Direct mention notification for WS nodes
        node.transport.send({
          jsonrpc: "2.0",
          method: "channel.mention",
          params: { channelId, message: msg },
        } as any);
        this.eventLogger.log("channel.mention", {
          channelId,
          messageId: msg.id,
          from: msg.from,
          content: msg.content,
          targetNodeId: target.nodeId,
          targetNodeName: target.nodeName,
          delivery: "ws_notification",
        });
      }
    }

    const origin = this.remoteRegistry.getRemoteOrigin(channelId, from);
    if (origin) {
      void this.bridgeRemoteReply(origin, content, msg.id);
    }

    return msg;
  }

  private async bridgeRemoteReply(origin: RemoteOriginRecord, content: string, messageId: string): Promise<void> {
    try {
      const config = loadPeerConfig();
      const peer = config.peers[origin.originPeer];
      if (!peer) throw new Error(`peer not configured: ${origin.originPeer}`);

      const client = new PeerClient(peer);
      await client.post("/peer/remote-reply", {
        originChannelId: origin.originChannelId,
        fromPeer: config.name || "local",
        fromNode: origin.localNode,
        content,
        messageId,
      });
      this.eventLogger.log("remote.reply", {
        peer: origin.originPeer,
        localChannelId: origin.localChannelId,
        originChannelId: origin.originChannelId,
        messageId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.eventLogger.log("remote.reply.error", {
        peer: origin.originPeer,
        localChannelId: origin.localChannelId,
        originChannelId: origin.originChannelId,
        messageId,
        error: message,
      });
    }
  }

  private async dispatchRemote(remote: RemoteMemberRecord, content: string, messageId: string, from: string): Promise<void> {
    try {
      const config = loadPeerConfig();
      const peer = config.peers[remote.peer];
      if (!peer) throw new Error(`peer not configured: ${remote.peer}`);

      const client = new PeerClient(peer);
      await client.post("/peer/remote-prompt", {
        remoteNode: remote.remoteNode,
        content,
        localChannelId: remote.remoteChannelId,
        originPeer: config.name || "local",
        originChannelId: remote.localChannelId,
        messageId,
        from,
      });
      this.eventLogger.log("remote.mention", {
        peer: remote.peer,
        remoteNode: remote.remoteNode,
        localChannelId: remote.localChannelId,
        messageId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage(remote.localChannelId, "系统", `@${from} [error] ${remote.peer} ${message.slice(0, 80)}`);
      this.eventLogger.log("remote.mention.error", {
        peer: remote.peer,
        remoteNode: remote.remoteNode,
        localChannelId: remote.localChannelId,
        messageId,
        error: message,
      });
    }
  }

  async promptRemoteOriginNode(localChannelId: string, remoteNode: string, content: string): Promise<{ ok: true }> {
    const node = this.nodePool.getByName(remoteNode);
    if (!node) throw new Error(`node not found: ${remoteNode}`);

    const beforeIds = new Set(this.store.getMessages(localChannelId, 100).map(m => m.id));
    const result = await this.nodePool.promptNode(node.id, content);
    if (result.error) throw new Error(result.error);

    const postedDuringPrompt = this.store
      .getMessages(localChannelId, 100)
      .some(m => m.from === remoteNode && !beforeIds.has(m.id));
    const dmText = result.text?.trim();
    if (!postedDuringPrompt && dmText) {
      const origin = this.remoteRegistry.getRemoteOrigin(localChannelId, remoteNode);
      if (origin) {
        await this.bridgeRemoteReply(origin, dmText, `dm:${Date.now()}`);
      }
    }

    return { ok: true };
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

  /** Returns the node's assembled message history (user + agent messages).
   *  Used by the node.updates RPC for tests and programmatic inspection. */
  getNodeUpdates(nodeName: string): Message[] {
    const node = this.nodePool.getByName(nodeName);
    return node ? [...node.messageStore] : [];
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
      // Record store position before prompting (for diff logging only)
      const storeStart = node.messageStore.length;
      log.info(`dispatch: prompting ${node.name} (store@${storeStart}, channel=${channelId || "none"})`);

      this.nodePool.promptNode(nodeId, prompt).then((result) => {
        if (!channelId) return;

        if (result.error) {
          log.warn(`prompt ${node.name} returned error: ${result.error}`);
          this.postMessage(channelId, node.name, `[error: ${String(result.error).slice(0, 100)}]`);
          return;
        }

        const newEntries = node.messageStore.length - storeStart;
        log.info(`dispatch: ${node.name} done, ${newEntries} new messages (agent replies via nerve_post)`);
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
      if (node && node.isProcess) continue; // ACP process nodes only speak ACP, skip channel broadcasts
      if (node && this.nodePool.isProgramNode(nodeId)) continue; // program nodes handle messages via node.message, skip channel broadcasts
      if (node && node.transport.alive) {
        node.transport.send(notification as any);
      }
    }
  }

  private handleNodeEvent(event: string, node: NerveNode, detail?: Record<string, unknown>): void {
    // Notify external hook (server's direct subscribers)
    this.onNodeEvent?.(event, node, detail);
    this.eventLogger.logNode(event, node, detail);

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
    this.eventLogger.close();
    this.store.close();
  }
}
