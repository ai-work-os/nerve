import { createServer } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { ChannelManager } from "./channel-manager.js";
import { SubscriptionManager } from "./subscription-manager.js";
import { HttpRouter } from "./http-router.js";
import { SceneManager } from "./scene-manager.js";
import type { JsonRpcRequest, JsonRpcMessage } from "./protocol.js";
import { handleRpcRequest } from "./request-handler.js";
import * as log from "./logger.js";

export class Server {
  private cm: ChannelManager;
  private wss!: WebSocketServer;
  private httpServer!: ReturnType<typeof createServer>;
  private port: number;

  // Track which WebSocket belongs to which node
  private wsNodeMap = new Map<WebSocket, string>(); // ws → nodeId
  private memSampler?: ReturnType<typeof setInterval>;

  // Direct node subscriptions (node.subscribe / node.unsubscribe)
  private subs = new SubscriptionManager();
  private httpRouter: HttpRouter;
  private scenes: SceneManager;

  constructor(cm: ChannelManager, port: number) {
    this.cm = cm;
    this.port = port;
    this.httpRouter = new HttpRouter(cm, port);
    this.scenes = new SceneManager(cm, cm.dataDir);
    this.httpRouter.setSceneManager(this.scenes);
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

    // Hook into member events for global broadcast (so TUI not in channel sees join/leave)
    this.cm.onMemberEvent = (event, channelId, nodeId, nodeName) => {
      this.broadcastToAllWsClients({
        jsonrpc: "2.0",
        method: event,
        params: { channelId, nodeId, nodeName },
      });
    };

    // Hook into node events for direct subscriber push
    this.cm.onNodeEvent = (event, node, detail) => {
      if (event === "node.update" || event === "node.statusChanged") {
        // Extract excludeWs if present (set by promptNode to avoid echoing user_message back to sender)
        const excludeWs = detail?._excludeWs as WebSocket | undefined;
        const cleanDetail = excludeWs ? { ...detail, _excludeWs: undefined } : detail;
        this.subs.notify(node.id, event, node, cleanDetail, excludeWs);
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
      if (event === "node.statusChanged") {
        this.broadcastToAllWsClients({
          jsonrpc: "2.0",
          method: "node.statusChanged",
          params: { nodeId: node.id, name: node.name, status: node.status, activity: node.activity },
        });
      }
      if (event === "node.stopped") {
        this.broadcastToAllWsClients({
          jsonrpc: "2.0",
          method: "node.stopped",
          params: { nodeId: node.id, name: node.name, exitCode: detail?.exitCode ?? null, reason: detail?.reason ?? null },
        });
      }

      // DM capture: route dm.prompt/dm.response to observer nodes
      if (event === "dm.prompt" || event === "dm.response") {
        const notification = {
          jsonrpc: "2.0" as const,
          method: event,
          params: { nodeId: node.id, name: node.name, ...detail },
        };
        setImmediate(() => {
          for (const obsNode of this.cm.nodePool.listAll()) {
            if (obsNode.permissions === "observer" && obsNode.id !== node.id && obsNode.transport.alive) {
              try {
                obsNode.transport.send(notification);
              } catch { /* best-effort, observer may have disconnected */ }
            }
          }
          log.debug(`dm event routed: ${event} for ${node.name}`);
        });
      }
    };

    this.wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as JsonRpcMessage;
          // Response from program node (for node.command)
          if ("id" in msg && !("method" in msg)) {
            this.cm.nodePool.handleCommandResponse(msg.id as number, (msg as any).result, (msg as any).error);
            return;
          }
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
          // Program nodes: don't remove on WS close — process exit handler manages lifecycle
          if (!this.cm.nodePool.isProgramNode(nodeId)) {
            this.cm.nodePool.remove(nodeId);
          }
          this.wsNodeMap.delete(ws);
        }
        // Clean up any node subscriptions this WS had
        this.subs.removeSubscriber(ws);
      });
    });

    this.httpServer.listen(this.port, () => {
      log.info(`nerve started on port ${this.port}`);

      // Memory sampling — log process memory every 30s for trend analysis
      const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
      const memInterval = parseInt(process.env.NERVE_MEM_INTERVAL_MS || "30000", 10);
      const logMem = () => {
        const mem = process.memoryUsage();
        log.info(`[mem] rss=${mb(mem.rss)}mb heap=${mb(mem.heapUsed)}mb/${mb(mem.heapTotal)}mb ext=${mb(mem.external)}mb buf=${mb(mem.arrayBuffers)}mb`);
      };
      logMem(); // immediate first sample
      this.memSampler = setInterval(logMem, memInterval);
      this.memSampler.unref(); // don't block process exit
    });
  }

  private handleRequest(ws: WebSocket, req: JsonRpcRequest): void {
    const { id, method, params } = req;
    const p = (params || {}) as Record<string, unknown>;

    try {
      // Dispatch to pure request handler for WS-independent methods
      const rpcResult = handleRpcRequest(this.cm, method, p, { callerNodeId: this.wsNodeMap.get(ws) });
      if (rpcResult !== null) {
        if (rpcResult.ok) {
          this.sendResult(ws, id, rpcResult.data);
        } else {
          this.sendError(ws, id, rpcResult.code, rpcResult.message);
        }
        return;
      }

      switch (method) {
        case "node.register": {
          let name = p.name as string;
          if (!name) { this.sendError(ws, id, -32602, "name required"); return; }

          const commands = p.commands as Record<string, { description: string; args?: Record<string, string> }> | undefined;
          const events = p.events as string[] | undefined;

          // Check if this is a spawned program node reconnecting
          const pendingNodeId = this.cm.nodePool.claimPendingProgram(name);
          if (pendingNodeId) {
            // Bind the WS transport to the existing placeholder node
            this.cm.nodePool.bindProgramTransport(pendingNodeId, ws);
            const pendingNode = this.cm.nodePool.get(pendingNodeId);
            if (pendingNode) {
              if (commands) pendingNode.commands = commands;
              if (events) pendingNode.events = events;
              if (p.source) pendingNode.source = p.source as string;
            }
            this.wsNodeMap.set(ws, pendingNodeId);
            log.info(`node.register: program node ${name} claimed pending slot ${pendingNodeId}`);
            this.sendResult(ws, id, { nodeId: pendingNodeId, name });

            // Replay channel joins — program node was added to channels before WS connected,
            // so it missed the channel.nodeJoined notifications
            if (pendingNode && pendingNode.channels.size > 0) {
              for (const chId of pendingNode.channels) {
                pendingNode.transport.send({
                  jsonrpc: "2.0",
                  method: "channel.nodeJoined",
                  params: { channelId: chId, nodeId: pendingNodeId, nodeName: name },
                } as any);
              }
              log.info(`node.register: replayed ${pendingNode.channels.size} channel join(s) for ${name}`);
            }
            break;
          }

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
          if (commands) node.commands = commands;
          if (events) node.events = events;
          if (p.source) node.source = p.source as string;
          this.wsNodeMap.set(ws, node.id);
          this.sendResult(ws, id, { nodeId: node.id, name: node.name });
          break;
        }

        // channel.create, channel.close, channel.delete, channel.list, channel.history
        // handled by handleRpcRequest above

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
          const standalone = p.standalone as boolean | undefined;
          const model = typeof p.model === "string" && p.model.trim() ? p.model.trim() : undefined;
          if (p.model !== undefined && typeof p.model !== "string") {
            this.sendError(ws, id, -32602, "model must be a string");
            return;
          }
          let channelId = p.channelId as string | undefined;

          // Auto-inherit caller's channel if not explicitly provided and not standalone
          if (!channelId && !standalone) {
            const callerNodeId = this.wsNodeMap.get(ws);
            if (callerNodeId) {
              const callerNode = this.cm.nodePool.get(callerNodeId);
              if (callerNode && callerNode.channels.size === 1) {
                channelId = [...callerNode.channels][0];
                log.info(`[node.spawn] auto-inherit channel ${channelId} from caller ${callerNode.name}`);
              }
            }
          }

          if (this.cm.nodePool.isNameTaken(name)) {
            this.sendError(ws, id, -32602, `name "${name}" already taken`);
            return;
          }

          this.cm.spawnNode(adapter, name, cwd, { model }).then(node => {
            // Auto-join channel if resolved (explicit or inherited)
            if (channelId) {
              this.cm.addNodeToChannel(channelId, node.id, node.name);
            }
            this.sendResult(ws, id, { nodeId: node.id, name: node.name });
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        case "node.stop": {
          this.cm.stopNode(p.nodeId as string).then(() => {
            this.sendResult(ws, id, { ok: true });
          }).catch((err) => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        // node.list handled by handleRpcRequest above

        case "node.log": {
          // Program nodes emit log entries — broadcast live only, not replayed on reconnect
          const callerNodeId = this.wsNodeMap.get(ws);
          if (!callerNodeId) { this.sendError(ws, id, -32600, "not registered"); return; }
          const node = this.cm.nodePool.get(callerNodeId);
          if (!node) { this.sendError(ws, id, -32600, "node not found"); return; }

          const entries = p.entries as Array<{ level: string; message: string; ts?: string }> | undefined;
          if (!Array.isArray(entries) || entries.length === 0) {
            this.sendError(ws, id, -32602, "entries must be a non-empty array");
            return;
          }
          // Fill in timestamps for entries missing them
          const now = new Date().toISOString();
          for (const entry of entries) {
            if (!entry.ts) entry.ts = now;
          }

          // Program logs are broadcast live to subscribers only — not stored for replay.
          // (nerve is a live message router; program logs are stream-shaped, not conversational.
          // If history is needed, the program should persist to its own file.)
          const updateParams = { update: { sessionUpdate: "node_log", entries } };
          this.cm.nodePool.emitEvent("node.update", node, updateParams);
          this.sendResult(ws, id, { ok: true });
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

          const callerNodeId = this.wsNodeMap.get(ws);
          const callerNode = callerNodeId ? this.cm.nodePool.get(callerNodeId) : undefined;
          const from = callerNode ? { nodeId: callerNode.id, name: callerNode.name } : undefined;
          this.cm.nodePool.promptNode(nodeId, content, from, ws).then(result => {
            this.sendResult(ws, id, result);
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        case "node.message": {
          const nodeId = p.nodeId as string;
          const content = p.content as string;
          if (!nodeId || !content) { this.sendError(ws, id, -32602, "nodeId and content required"); return; }
          const node = this.cm.nodePool.get(nodeId);
          if (!node) { this.sendError(ws, id, -32602, "node not found"); return; }

          // kill command on spawned program nodes: server-side SIGTERM
          if (content.trim().toLowerCase() === "kill" && this.cm.nodePool.isProgramNode(nodeId)) {
            void this.cm.stopNode(nodeId);
            this.sendResult(ws, id, { ok: true, action: "killed" });
            break;
          }

          // Forward as notification to the target node
          if (!node.transport.alive) {
            this.sendError(ws, id, -32000, "node transport not connected");
            break;
          }
          const callerNodeId = this.wsNodeMap.get(ws);
          const callerNode = callerNodeId ? this.cm.nodePool.get(callerNodeId) : undefined;
          node.transport.send({
            jsonrpc: "2.0",
            method: "node.message",
            params: { content, from: callerNode?.name || "unknown" },
          } as any);
          this.sendResult(ws, id, { ok: true });
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

        // node.updates, blob.get handled by handleRpcRequest above

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
          this.cm.nodePool.sessionReset(node.id, expectedSessionId, summaryPath, false, "ws_api").then(result => {
            if (result.error) { this.sendError(ws, id, -32000, result.error); return; }
            this.sendResult(ws, id, result);
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        case "scene.list": {
          const scenes = this.scenes.list();
          this.sendResult(ws, id, { scenes });
          break;
        }

        case "scene.start": {
          const sceneName = p.name as string;
          if (!sceneName) { this.sendError(ws, id, -32602, "name required"); return; }
          const cwd = p.cwd as string | undefined;

          this.scenes.start(sceneName, cwd).then(scene => {
            this.sendResult(ws, id, {
              name: scene.name,
              nodeIds: scene.nodeIds,
              channelId: scene.channelId,
              warnings: scene.warnings,
            });
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        case "scene.stop": {
          const sceneName = p.name as string;
          if (!sceneName) { this.sendError(ws, id, -32602, "name required"); return; }

          this.scenes.stop(sceneName).then(() => {
            this.sendResult(ws, id, { ok: true });
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
    if (this.memSampler) clearInterval(this.memSampler);
    // Close all WS connections
    for (const ws of this.wss.clients) {
      ws.close();
    }
    this.wss.close();
    this.httpServer.close();
    await this.cm.shutdown();
  }
}
