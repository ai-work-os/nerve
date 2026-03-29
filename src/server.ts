import { createServer } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { ChannelManager } from "./channel-manager.js";
import { SubscriptionManager } from "./subscription-manager.js";
import { HttpRouter } from "./http-router.js";
import type { JsonRpcRequest, JsonRpcMessage } from "./protocol.js";
import * as log from "./logger.js";

export class Server {
  private cm: ChannelManager;
  private wss!: WebSocketServer;
  private httpServer!: ReturnType<typeof createServer>;
  private port: number;

  // Track which WebSocket belongs to which node
  private wsNodeMap = new Map<WebSocket, string>(); // ws → nodeId

  // Direct node subscriptions (node.subscribe / node.unsubscribe)
  private subs = new SubscriptionManager();
  private httpRouter: HttpRouter;

  constructor(cm: ChannelManager, port: number) {
    this.cm = cm;
    this.port = port;
    this.httpRouter = new HttpRouter(cm, port);
  }

  start(): void {
    this.httpServer = createServer((req, res) => this.httpRouter.handle(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });

    // Hook into channel events for global broadcast
    this.cm.onChannelEvent = (event, channel) => {
      this.broadcastToAllWsClients({
        jsonrpc: "2.0",
        method: event,
        params: { channelId: channel.id, name: channel.name, cwd: channel.cwd },
      });
    };

    // Hook into node events for direct subscriber push
    this.cm.onNodeEvent = (event, node, detail) => {
      if (event === "node.update" || event === "node.statusChanged") {
        this.subs.notify(node.id, event, node, detail);
      }
      if (event === "node.stopped" || event === "node.removed") {
        this.subs.removeNode(node.id);
      }
      if (event === "node.registered") {
        this.broadcastToAllWsClients({
          jsonrpc: "2.0",
          method: "node.registered",
          params: { nodeId: node.id, name: node.name, adapter: node.adapter ?? null, transport: node.transport.type },
        });
      }
      if (event === "node.stopped") {
        this.broadcastToAllWsClients({
          jsonrpc: "2.0",
          method: "node.stopped",
          params: { nodeId: node.id, name: node.name, exitCode: detail?.exitCode ?? null },
        });
      }
    };

    this.wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as JsonRpcMessage;
          if ("method" in msg && "id" in msg) {
            this.handleRequest(ws, msg as JsonRpcRequest);
          }
        } catch {
          // ignore malformed
        }
      });

      ws.on("close", () => {
        const nodeId = this.wsNodeMap.get(ws);
        if (nodeId) {
          const node = this.cm.nodePool.get(nodeId);
          if (node) {
            // Clear activity on disconnect
            node.activity = undefined;
            // Remove node from all channels
            for (const chId of node.channels) {
              this.cm.removeNodeFromChannel(chId, node.name);
            }
          }
          this.cm.nodePool.remove(nodeId);
          this.wsNodeMap.delete(ws);
        }
        // Clean up any node subscriptions this WS had
        this.subs.removeSubscriber(ws);
      });
    });

    this.httpServer.listen(this.port, () => {
      log.info(`nerve started on port ${this.port}`);
    });
  }

  private handleRequest(ws: WebSocket, req: JsonRpcRequest): void {
    const { id, method, params } = req;
    const p = (params || {}) as Record<string, unknown>;

    try {
      switch (method) {
        case "node.register": {
          let name = p.name as string;
          if (!name) { this.sendError(ws, id, -32602, "name required"); return; }
          // Auto-suffix if name taken (tui → tui-2 → tui-3 ...)
          if (this.cm.nodePool.isNameTaken(name)) {
            let suffix = 2;
            while (this.cm.nodePool.isNameTaken(`${name}-${suffix}`)) suffix++;
            name = `${name}-${suffix}`;
            log.info(`node.register: name taken, assigned ${name}`);
          }

          const node = this.cm.registerNode(
            ws,
            name,
            (p.capabilities as string[]) || ["ui"],
            (p.permissions as any) || "operator",
          );
          this.wsNodeMap.set(ws, node.id);
          this.sendResult(ws, id, { nodeId: node.id, name: node.name });
          break;
        }

        case "channel.create": {
          const cwd = resolve((p.cwd as string) || process.cwd());
          const ch = this.cm.createChannel(cwd, p.name as string);
          this.sendResult(ws, id, { channelId: ch.id, name: ch.name, cwd: ch.cwd });
          break;
        }

        case "channel.close": {
          this.cm.closeChannel(p.channelId as string);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "channel.delete": {
          const channelId = p.channelId as string;
          if (!channelId) { this.sendError(ws, id, -32602, "channelId required"); return; }
          this.cm.deleteChannel(channelId);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "channel.list": {
          let channelList = this.cm.listChannels();
          const cwdFilter = p.cwd ? resolve(p.cwd as string) : undefined;
          if (cwdFilter) {
            channelList = channelList.filter(ch => ch.cwd === cwdFilter || ch.cwd.startsWith(cwdFilter + "/"));
          }
          const channels = channelList.map(ch => ({
            id: ch.id,
            name: ch.name,
            cwd: ch.cwd,
            nodes: Object.fromEntries(ch.nodes),
          }));
          this.sendResult(ws, id, { channels });
          break;
        }

        case "channel.history": {
          const msgs = this.cm.getHistory(
            p.channelId as string,
            p.limit as number,
            p.before as number,
          );
          this.sendResult(ws, id, { messages: msgs });
          break;
        }

        case "channel.listArchived": {
          const activeIds = this.cm.listChannels().map(ch => ch.id);
          const cwdFilter = p.cwd ? resolve(p.cwd as string) : undefined;
          const query = p.query as string | undefined;
          const rows = this.cm.store.listArchivedChannels(activeIds, cwdFilter, query);
          const channels = rows.map(r => ({
            id: r.id,
            name: r.name,
            cwd: r.cwd,
            createdAt: r.createdAt,
            memberCount: r.memberCount,
            memberNames: r.memberNames ? r.memberNames.split(",") : [],
            lastMessage: r.lastFrom ? { from: r.lastFrom, content: r.lastContent, timestamp: r.lastTs } : null,
            agents: r.agents,
          }));
          this.sendResult(ws, id, { channels });
          break;
        }

        case "channel.restore": {
          const channelId = p.channelId as string;
          if (!channelId) { this.sendError(ws, id, -32602, "channelId required"); return; }
          const result = this.cm.restoreChannel(channelId);
          if (!result) { this.sendError(ws, id, -32602, "channel not found"); return; }
          const { channel: ch, messages } = result;
          this.sendResult(ws, id, {
            channelId: ch.id,
            name: ch.name,
            cwd: ch.cwd,
            messages,
            agents: this.cm.store.getChannelAgents(channelId),
          });
          break;
        }

        case "channel.join": {
          const nodeId = this.wsNodeMap.get(ws);
          if (!nodeId) { this.sendError(ws, id, -32600, "not registered"); return; }
          const channelId = p.channelId as string;
          this.cm.addNodeToChannel(channelId, nodeId, p.name as string);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "channel.leave": {
          const nodeId = this.wsNodeMap.get(ws);
          if (!nodeId) { this.sendError(ws, id, -32600, "not registered"); return; }
          const node = this.cm.nodePool.get(nodeId);
          if (node) this.cm.removeNodeFromChannel(p.channelId as string, node.name);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "channel.addNode": {
          const channelId = p.channelId as string;
          const addNodeId = p.nodeId as string;
          this.cm.addNodeToChannel(channelId, addNodeId, p.name as string);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "channel.removeNode": {
          this.cm.removeNodeFromChannel(p.channelId as string, p.nodeName as string);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "channel.post": {
          const nodeId = this.wsNodeMap.get(ws);
          if (!nodeId) { this.sendError(ws, id, -32600, "not registered"); return; }
          const node = this.cm.nodePool.get(nodeId);
          if (!node) { this.sendError(ws, id, -32600, "node not found"); return; }

          const msg = this.cm.postMessage(
            p.channelId as string,
            node.name,
            p.content as string,
          );
          this.sendResult(ws, id, { message: msg });
          break;
        }

        case "node.subscribe": {
          const targetId = p.nodeId as string;
          if (!targetId) { this.sendError(ws, id, -32602, "nodeId required"); return; }
          const targetNode = this.cm.nodePool.get(targetId);
          if (!targetNode) { this.sendError(ws, id, -32602, "node not found"); return; }
          this.subs.subscribe(ws, targetId, targetNode);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "node.unsubscribe": {
          const targetId = p.nodeId as string;
          if (!targetId) { this.sendError(ws, id, -32602, "nodeId required"); return; }
          this.subs.unsubscribe(ws, targetId);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "node.spawn": {
          const adapter = p.adapter as string;
          const cwd = resolve((p.cwd as string) || process.cwd());
          const name = (p.name as string) || this.httpRouter.generateNodeName(adapter, cwd);

          if (this.cm.nodePool.isNameTaken(name)) {
            this.sendError(ws, id, -32602, `name "${name}" already taken`);
            return;
          }

          this.cm.spawnNode(adapter, name, cwd).then(node => {
            this.sendResult(ws, id, { nodeId: node.id, name: node.name });
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        case "node.stop": {
          this.cm.stopNode(p.nodeId as string);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "node.list": {
          let nodes = this.cm.nodePool.listAll();
          const cwdFilter = p.cwd ? resolve(p.cwd as string) : undefined;
          if (cwdFilter) {
            // Monitor nodes (e.g. context-guardian) are global — don't filter by cwd
            nodes = nodes.filter(n =>
              n.capabilities.includes("monitor") ||
              n.cwd === cwdFilter ||
              (n.cwd && n.cwd.startsWith(cwdFilter + "/"))
            );
          }
          this.sendResult(ws, id, { nodes: nodes.map(n => n.toInfo()) });
          break;
        }

        case "node.activity": {
          // Only the node itself can update its own activity
          const callerNodeId = this.wsNodeMap.get(ws);
          if (!callerNodeId) { this.sendError(ws, id, -32600, "not registered"); return; }
          const node = this.cm.nodePool.get(callerNodeId);
          if (!node) { this.sendError(ws, id, -32600, "node not found"); return; }
          const activity = p.activity as string | null;
          // Normalize empty string / null to undefined so toInfo() omits the field
          node.activity = activity || undefined;
          node.touch();
          // Emit statusChanged to propagate activity update via existing pipeline
          this.cm.nodePool.emitEvent("node.statusChanged", node);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "node.prompt": {
          const nodeId = p.nodeId as string;
          const content = p.content as string;
          if (!nodeId || !content) { this.sendError(ws, id, -32602, "nodeId and content required"); return; }
          const node = this.cm.nodePool.get(nodeId);
          if (!node) { this.sendError(ws, id, -32602, `node not found`); return; }
          if (!node.isProcess) { this.sendError(ws, id, -32602, "can only prompt process nodes"); return; }

          this.cm.nodePool.promptNode(nodeId, content).then(result => {
            this.sendResult(ws, id, result);
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        case "node.cancel": {
          const nodeId = p.nodeId as string;
          if (!nodeId) { this.sendError(ws, id, -32602, "nodeId required"); return; }
          const node = this.cm.nodePool.get(nodeId);
          if (!node) { this.sendError(ws, id, -32602, "node not found"); return; }
          if (!node.isProcess) { this.sendError(ws, id, -32602, "can only cancel process nodes"); return; }

          this.cm.nodePool.cancelNode(nodeId).then(result => {
            if (result.error) {
              this.sendError(ws, id, -32000, result.error);
            } else {
              this.sendResult(ws, id, { ok: true });
            }
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        case "node.updates": {
          const nodeName = p.nodeName as string;
          if (!nodeName) { this.sendError(ws, id, -32602, "nodeName required"); return; }
          const updates = this.cm.getNodeUpdates(nodeName);
          this.sendResult(ws, id, { updates });
          break;
        }

        case "blob.get": {
          const blobId = p.blobId as string;
          if (!blobId) { this.sendError(ws, id, -32602, "blobId required"); return; }
          const content = this.cm.blobStore.get(blobId);
          if (content) {
            this.sendResult(ws, id, { content });
          } else {
            this.sendError(ws, id, -32602, "blob not found");
          }
          break;
        }

        case "session.list": {
          const nodeName = p.nodeName as string;
          if (!nodeName) { this.sendError(ws, id, -32602, "nodeName required"); return; }
          const node = this.cm.nodePool.getByName(nodeName);
          if (!node) { this.sendError(ws, id, -32602, `node "${nodeName}" not found`); return; }
          this.cm.nodePool.sessionList(node.id).then(result => {
            this.sendResult(ws, id, result);
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        case "session.load": {
          const nodeName = p.nodeName as string;
          const sessionId = p.sessionId as string;
          if (!nodeName || !sessionId) { this.sendError(ws, id, -32602, "nodeName and sessionId required"); return; }
          const node = this.cm.nodePool.getByName(nodeName);
          if (!node) { this.sendError(ws, id, -32602, `node "${nodeName}" not found`); return; }
          this.cm.nodePool.sessionLoad(node.id, sessionId).then(result => {
            this.sendResult(ws, id, result);
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        case "session.clear": {
          const nodeName = p.nodeName as string;
          if (!nodeName) { this.sendError(ws, id, -32602, "nodeName required"); return; }
          const node = this.cm.nodePool.getByName(nodeName);
          if (!node) { this.sendError(ws, id, -32602, `node "${nodeName}" not found`); return; }
          this.cm.nodePool.sessionClear(node.id).then(result => {
            this.sendResult(ws, id, result);
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        case "session.compact": {
          const nodeName = p.nodeName as string;
          if (!nodeName) { this.sendError(ws, id, -32602, "nodeName required"); return; }
          const node = this.cm.nodePool.getByName(nodeName);
          if (!node) { this.sendError(ws, id, -32602, `node "${nodeName}" not found`); return; }
          this.cm.nodePool.sessionCompact(node.id).then(result => {
            this.sendResult(ws, id, result);
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        case "session.reset": {
          const nodeName = p.nodeName as string;
          const expectedSessionId = p.expectedSessionId as string;
          const summaryPath = p.summaryPath as string;
          if (!nodeName) { this.sendError(ws, id, -32602, "nodeName required"); return; }
          if (!expectedSessionId) { this.sendError(ws, id, -32602, "expectedSessionId required"); return; }
          if (!summaryPath) { this.sendError(ws, id, -32602, "summaryPath required"); return; }
          const node = this.cm.nodePool.getByName(nodeName);
          if (!node) { this.sendError(ws, id, -32602, `node "${nodeName}" not found`); return; }
          this.cm.nodePool.sessionReset(node.id, expectedSessionId, summaryPath).then(result => {
            if (result.error) { this.sendError(ws, id, -32000, result.error); return; }
            this.sendResult(ws, id, result);
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        default:
          this.sendError(ws, id, -32601, `method not found: ${method}`);
      }
    } catch (err) {
      this.sendError(ws, id, -32000, String(err));
    }
  }

  /** Broadcast a notification to ALL connected WS clients (for global events like channel create/close) */
  private broadcastToAllWsClients(notification: Record<string, unknown>): void {
    const msg = JSON.stringify(notification);
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  private sendResult(ws: WebSocket, id: number | string, result: unknown): void {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private sendError(ws: WebSocket, id: number | string, code: number, message: string): void {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  async shutdown(): Promise<void> {
    // Close all WS connections
    for (const ws of this.wss.clients) {
      ws.close();
    }
    this.wss.close();
    this.httpServer.close();
    await this.cm.shutdown();
  }
}
