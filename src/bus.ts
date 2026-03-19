import { Channel } from "./channel.js";
import { NodePool } from "./node-pool.js";
import { Scheduler } from "./scheduler.js";
import { route } from "./router.js";
import { Store } from "./store.js";
import { BusNode } from "./node.js";
import type { MessageInfo, PermissionLevel, JsonRpcNotification } from "./protocol.js";
import type { WebSocket } from "ws";
import * as log from "./logger.js";

export interface BusOptions {
  dataDir: string;
  port: number;
}

export class Bus {
  readonly store: Store;
  readonly nodePool: NodePool;
  readonly scheduler: Scheduler;
  private channels = new Map<string, Channel>();
  private port: number;

  // External hook for server to receive node events (for direct subscriptions)
  onNodeEvent?: (event: string, node: BusNode, detail?: Record<string, unknown>) => void;

  constructor(opts: BusOptions) {
    this.port = opts.port;
    this.store = new Store(`${opts.dataDir}/bus.db`);

    // Mark all old nodes as stopped on startup
    this.store.markAllNodesStopped();

    this.nodePool = new NodePool(this.store, (event, node, detail) => {
      this.handleNodeEvent(event, node, detail);
    });

    this.scheduler = new Scheduler((nodeId, text, onDone) => {
      const node = this.nodePool.get(nodeId);
      let prompt = text;
      if (node && !node.prompted && node.systemPrompt) {
        prompt = node.systemPrompt + "\n\n" + text;
        node.prompted = true;
      }
      this.nodePool.promptNode(nodeId, prompt).then(() => onDone());
    });
  }

  // --- Channel operations ---

  createChannel(cwd: string, name?: string): Channel {
    const ch = new Channel({ cwd, name, store: this.store });
    this.channels.set(ch.id, ch);
    return ch;
  }

  getChannel(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  listChannels(): Channel[] {
    return [...this.channels.values()];
  }

  closeChannel(id: string): void {
    const ch = this.channels.get(id);
    if (!ch) return;

    // Remove all nodes from channel
    for (const [nodeName] of ch.nodes) {
      ch.removeNode(nodeName, this.store);
    }

    this.store.closeChannel(id);
    this.channels.delete(id);
  }

  // --- Node operations ---

  registerNode(ws: WebSocket, name: string, capabilities: string[], permissions: PermissionLevel): BusNode {
    return this.nodePool.registerWebSocket(ws, name, capabilities, permissions);
  }

  async spawnNode(adapter: string, name: string, cwd: string): Promise<BusNode> {
    return this.nodePool.spawnProcess(adapter, name, cwd, this.port);
  }

  /** Spawn node and return ID immediately (handshake runs in background) */
  spawnNodeSync(adapter: string, name: string, cwd: string): string {
    const node = this.nodePool.spawnProcessSync(adapter, name, cwd, this.port);
    return node.id;
  }

  stopNode(nodeId: string): void {
    // Remove from all channels first
    const node = this.nodePool.get(nodeId);
    if (node) {
      for (const chId of node.channels) {
        const ch = this.channels.get(chId);
        if (ch) {
          ch.removeNode(node.name, this.store);
          this.broadcastToChannel(chId, {
            jsonrpc: "2.0",
            method: "channel.nodeLeft",
            params: { channelId: chId, nodeId: node.id, nodeName: node.name },
          });
        }
      }
      this.scheduler.clearQueue(nodeId);
    }
    this.nodePool.stopNode(nodeId);
  }

  // --- Channel-Node binding ---

  addNodeToChannel(channelId: string, nodeId: string, nodeName?: string): void {
    const ch = this.channels.get(channelId);
    const node = this.nodePool.get(nodeId);
    if (!ch || !node) return;

    const name = nodeName || node.name;
    ch.addNode(nodeId, name, this.store);
    node.channels.add(channelId);

    // Inject system prompt for process nodes joining a channel
    if (node.isProcess && !node.systemPrompt) {
      const members = [...ch.nodes.keys()].filter(n => n !== name);
      node.systemPrompt = this.buildSystemPrompt(name, channelId, members);
    }

    this.broadcastToChannel(channelId, {
      jsonrpc: "2.0",
      method: "channel.nodeJoined",
      params: { channelId, nodeId, nodeName: name },
    });
  }

  removeNodeFromChannel(channelId: string, nodeName: string): void {
    const ch = this.channels.get(channelId);
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

  // --- Messaging ---

  postMessage(channelId: string, from: string, content: string): MessageInfo | null {
    const ch = this.channels.get(channelId);
    if (!ch) return null;

    const msg = ch.postMessage(from, content, this.store);

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
        // Queue for serial processing
        this.scheduler.enqueue(target.nodeId, channelId, msg);
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

  /** Post from a Process Node (via terminal/curl HTTP endpoint) */
  postFromProcess(nodeName: string, content: string): void {
    // Find which channel this node is in (use first channel for MVP)
    const node = this.nodePool.getByName(nodeName);
    if (!node) return;

    for (const chId of node.channels) {
      this.postMessage(chId, nodeName, content);
      break; // MVP: post to first channel only
    }
  }

  getHistory(channelId: string, limit?: number, before?: number): MessageInfo[] {
    return this.store.getMessages(channelId, limit, before);
  }

  getNodeUpdates(nodeName: string): Record<string, unknown>[] {
    const node = this.nodePool.getByName(nodeName);
    return node ? [...node.updateBuffer] : [];
  }

  // --- Internal ---

  private buildSystemPrompt(agentName: string, channelId: string, members: string[]): string {
    const memberList = members.length > 0 ? members.join(", ") : "(none yet)";
    return [
      `你是 ${agentName}，在一个多 agent 协作频道里。`,
      ``,
      `发消息到频道：`,
      `nerve-post "@收件人 消息内容"`,
      ``,
      `频道规则：`,
      `- @收件人 开头，默认 @main`,
      `- 频道消息 50 字以内，只写结论`,
      `- 长内容写文件，频道附路径`,
      `- 每个任务回复一次，然后等指令`,
      ``,
      `频道成员：${memberList}`,
      `频道 ID：${channelId}`,
    ].join("\n");
  }

  private broadcastToChannel(channelId: string, notification: JsonRpcNotification): void {
    const ch = this.channels.get(channelId);
    if (!ch) return;

    for (const [, nodeId] of ch.nodes) {
      const node = this.nodePool.get(nodeId);
      if (node && node.isProcess) continue; // process nodes only speak ACP, skip bus broadcasts
      if (node && node.transport.alive) {
        node.transport.send(notification as any);
      }
    }
  }

  private handleNodeEvent(event: string, node: BusNode, detail?: Record<string, unknown>): void {
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
          const ch = this.channels.get(chId);
          if (ch) {
            ch.removeNode(node.name, this.store);
            // Post system message
            this.postMessage(chId, "系统", `${node.name} 已断开 (exit: ${detail?.exitCode})`);
          }
        }
        this.scheduler.clearQueue(node.id);
        break;
      }

      case "node.error":
        log.error(`node error: ${node.name}: ${detail?.error}`);
        break;

      case "node.update":
        // Broadcast agent output to all channels the node is in
        log.info(`node.update: ${node.name} channels=[${[...node.channels].join(",")}] detail=${JSON.stringify(detail || {}).slice(0, 300)}`);
        for (const chId of node.channels) {
          this.broadcastToChannel(chId, {
            jsonrpc: "2.0",
            method: "node.update",
            params: {
              nodeId: node.id,
              name: node.name,
              ...(detail || {}),
            },
          });
        }
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
