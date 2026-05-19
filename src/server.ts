import { createServer } from "node:http";
import { resolve } from "node:path";
import { nanoid } from "nanoid";
import { WebSocketServer, WebSocket } from "ws";
import type { PromptAttachment } from "./agent/acp-client.js";
import { ChannelManager } from "./channel/channel-manager.js";
import { SubscriptionManager } from "./channel/subscription-manager.js";
import { HttpRouter } from "./transport/http-router.js";
import { SceneManager } from "./scene/scene-manager.js";
import type { JsonRpcRequest, JsonRpcMessage, Message } from "./transport/protocol.js";
import { handleRpcRequest } from "./channel/request-handler.js";
import * as log from "./infra/logger.js";
import { child as childLogger } from "./infra/logger.js";
import { localIso, localTimeOnly } from "./infra/time-util.js";

const PROGRAM_LOG_MESSAGE_LIMIT = 5000;

const WS_HEARTBEAT_INTERVAL_MS = parseInt(process.env.NERVE_WS_HEARTBEAT_INTERVAL_MS || "30000", 10);

export class Server {
  private log = childLogger({ module: "server" });
  private cm: ChannelManager;
  private wss!: WebSocketServer;
  private httpServer!: ReturnType<typeof createServer>;
  private port: number;

  // Track which WebSocket belongs to which node
  private wsNodeMap = new Map<WebSocket, string>(); // ws → nodeId
  private memSampler?: ReturnType<typeof setInterval>;

  // Server-side WS heartbeat: detect half-open / dead connections.
  // Stored in a WeakMap so entries are GC'd automatically when WS is closed.
  private wsAlive = new WeakMap<WebSocket, boolean>();
  private wsHeartbeat?: ReturnType<typeof setInterval>;

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

  async startScene(name: string): Promise<void> {
    await this.scenes.start(name);
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

    this.cm.onSpawnEvent = (event, detail) => {
      this.broadcastToAllWsClients({
        jsonrpc: "2.0",
        method: event,
        params: detail,
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
          this.log.debug(`dm event routed: ${event} for ${node.name}`);
        });
      }
    };

    // Server-side heartbeat: ping all clients every WS_HEARTBEAT_INTERVAL_MS.
    // Clients that don't respond with a pong are terminated (triggering ws.on("close")
    // → markOffline for persistent nodes, remove for transient nodes).
    this.wsHeartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (this.wsAlive.get(ws) === false) {
          const nodeId = this.wsNodeMap.get(ws);
          const nodeName = nodeId ? this.cm.nodePool.get(nodeId)?.name ?? nodeId : "<unregistered>";
          this.log.warn(`heartbeat: no pong from ${nodeName}, terminating dead connection`);
          ws.terminate();
          continue;
        }
        this.wsAlive.set(ws, false);
        ws.ping();
      }
    }, WS_HEARTBEAT_INTERVAL_MS);
    this.wsHeartbeat.unref(); // don't block process exit

    this.wss.on("connection", (ws) => {
      // Initialize alive state for new connection
      this.wsAlive.set(ws, true);
      ws.on("pong", () => {
        this.wsAlive.set(ws, true);
      });

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
          // Persistent nodes: stay in pool + all channels, flip status to "offline".
          // (e.g. mac-clipboard on a sleeping Mac — keeps "showing up" in #screenshots)
          if (node && node.persistent) {
            // Stale-close guard: if the node has already rebound to a newer
            // socket (register-before-close race), this close belongs to an
            // obsolete transport — ignore it, just drop the dead wsNodeMap entry.
            const currentSocket = (node.transport as { socket?: unknown }).socket;
            if (currentSocket !== undefined && currentSocket !== ws) {
              this.log.info(`ws.on(close): stale close for ${node.name} (${nodeId}) — node already rebound to a newer socket, ignoring`);
              this.wsNodeMap.delete(ws);
            } else {
              this.log.info(`ws.on(close): persistent node ${node.name} (${nodeId}) disconnected, marking offline (channels stay)`);
              this.cm.nodePool.markOffline(nodeId);
              this.wsNodeMap.delete(ws);
            }
          } else {
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
        }
        // Clean up any node subscriptions this WS had
        this.subs.removeSubscriber(ws);
      });
    });

    this.httpServer.listen(this.port, () => {
      this.log.info(`nerve started on port ${this.port}`);

      // Memory sampling — log process memory every 30s for trend analysis
      const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
      const memInterval = parseInt(process.env.NERVE_MEM_INTERVAL_MS || "30000", 10);
      const logMem = () => {
        const mem = process.memoryUsage();
        this.log.info(`[mem] rss=${mb(mem.rss)}mb heap=${mb(mem.heapUsed)}mb/${mb(mem.heapTotal)}mb ext=${mb(mem.external)}mb buf=${mb(mem.arrayBuffers)}mb`);
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
          const health = p.health as import("./transport/protocol.js").HealthContract | undefined;

          // Check if this is a spawned program node reconnecting
          const pendingNodeId = this.cm.nodePool.claimPendingProgram(name);
          if (pendingNodeId) {
            // Bind the WS transport to the existing placeholder node
            this.cm.nodePool.bindProgramTransport(pendingNodeId, ws);
            const pendingNode = this.cm.nodePool.get(pendingNodeId);
            if (pendingNode) {
              if (commands) pendingNode.commands = commands;
              if (events) pendingNode.events = events;
              if (health) pendingNode.health = health;
              if (p.source) pendingNode.source = p.source as string;
            }
            this.wsNodeMap.set(ws, pendingNodeId);
            this.log.info(`node.register: program node ${name} claimed pending slot ${pendingNodeId}`);
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
              this.log.info(`node.register: replayed ${pendingNode.channels.size} channel join(s) for ${name}`);
            }
            break;
          }

          const persistent = p.persistent === true;

          // Persistent node reconnecting: rebind to the existing node (same
          // name, same nodeId) instead of creating a new one — regardless of
          // its current status. A new connection for a persistent identity
          // always wins (last-writer-wins), so a register that arrives before
          // the old socket's close is processed still rebinds correctly
          // instead of falling through to auto-suffix and spawning a ghost.
          if (persistent) {
            const existing = this.cm.nodePool.findPersistentByName(name);
            if (existing) {
              this.cm.nodePool.rebindWebSocket(existing.id, ws);
              if (commands) existing.commands = commands;
              if (events) existing.events = events;
              if (health) existing.health = health;
              if (p.source) existing.source = p.source as string;
              this.wsNodeMap.set(ws, existing.id);
              this.log.info(`node.register: persistent node ${name} rebound to existing node ${existing.id} (reconnect)`);
              this.sendResult(ws, id, { nodeId: existing.id, name });

              // Replay channel joins — node missed channel.nodeJoined while disconnected
              if (existing.channels.size > 0) {
                for (const chId of existing.channels) {
                  existing.transport.send({
                    jsonrpc: "2.0",
                    method: "channel.nodeJoined",
                    params: { channelId: chId, nodeId: existing.id, nodeName: name },
                  } as any);
                }
                this.log.info(`node.register: replayed ${existing.channels.size} channel join(s) for persistent node ${name}`);
              }
              break;
            }
          }

          // Auto-suffix if name taken (tui → tui-2 → tui-3 ...)
          if (this.cm.nodePool.isNameTaken(name)) {
            let suffix = 2;
            while (this.cm.nodePool.isNameTaken(`${name}-${suffix}`)) suffix++;
            name = `${name}-${suffix}`;
            this.log.info(`node.register: name taken, assigned ${name}`);
          }

          const node = this.cm.registerNode(
            ws,
            name,
            (p.capabilities as string[]) || ["ui"],
            (p.permissions as any) || "operator",
            persistent,
          );
          if (commands) node.commands = commands;
          if (events) node.events = events;
          if (health) node.health = health;
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
                this.log.info(`[node.spawn] auto-inherit channel ${channelId} from caller ${callerNode.name}`);
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
            const callerNodeId = this.wsNodeMap.get(ws);
            const callerNode = callerNodeId ? this.cm.nodePool.get(callerNodeId) : undefined;
            if (callerNode) {
              this.cm.notifyNodeSpawned({
                nodeId: node.id,
                name: node.name,
                adapter,
                spawnedByNodeId: callerNode.id,
                spawnedByNodeName: callerNode.name,
                channelId: channelId ?? null,
              });
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
          const callerNodeId = this.wsNodeMap.get(ws);
          if (!callerNodeId) { this.sendError(ws, id, -32600, "not registered"); return; }
          const node = this.cm.nodePool.get(callerNodeId);
          if (!node) { this.sendError(ws, id, -32600, "node not found"); return; }

          const entries = p.entries as Array<{ level: string; message: string; ts?: string }> | undefined;
          if (!Array.isArray(entries) || entries.length === 0) {
            this.sendError(ws, id, -32602, "entries must be a non-empty array");
            return;
          }
          // Fill in timestamps for entries missing them. Use localIso so the
          // ts field on the wire is human-readable in local TZ + still valid
          // ISO 8601 (clients can parse it as a Date round-trip).
          const now = localIso();
          for (const entry of entries) {
            if (!entry.ts) entry.ts = now;
          }

          const messages: Message[] = entries.map(entry => {
            const entryTime = Date.parse(entry.ts || now);
            const ts = Number.isFinite(entryTime) ? entryTime : Date.now();
            // localTimeOnly (NOT toISOString().slice(11,19)) — the latter forces
            // UTC and made local-time cron fires display as if 8h earlier.
            const time = localTimeOnly(new Date(ts));
            const level = (entry.level || "info").toUpperCase();
            return {
              id: nanoid(16),
              nodeId: node.id,
              role: "system",
              sender: node.name,
              text: `[${time}] [${level}] ${entry.message || ""}`,
              ts,
            };
          });
          for (const message of messages) {
            node.appendMessage(message);
          }
          if (node.messageStore.length > PROGRAM_LOG_MESSAGE_LIMIT) {
            node.messageStore.splice(0, node.messageStore.length - PROGRAM_LOG_MESSAGE_LIMIT);
            this.log.info(`[node.log] trimmed ${node.name} messageStore to ${PROGRAM_LOG_MESSAGE_LIMIT}`);
          }

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
          const attachments = Array.isArray(p.attachments)
            ? (p.attachments as Record<string, unknown>[])
              .filter(a => a.type === "image" && typeof a.mimeType === "string" && typeof a.data === "string")
              .map(a => ({ type: "image" as const, mimeType: a.mimeType as string, data: a.data as string }) satisfies PromptAttachment)
            : [];
          if (!nodeId || !content) { this.sendError(ws, id, -32602, "nodeId and content required"); return; }
          const node = this.cm.nodePool.get(nodeId);
          if (!node) { this.sendError(ws, id, -32602, `node not found`); return; }
          if (!node.isProcess) { this.sendError(ws, id, -32602, "can only prompt process nodes"); return; }

          const callerNodeId = this.wsNodeMap.get(ws);
          const callerNode = callerNodeId ? this.cm.nodePool.get(callerNodeId) : undefined;
          const from = callerNode ? { nodeId: callerNode.id, name: callerNode.name } : undefined;
          this.log.debug(`node.prompt: nodeId=${nodeId} attachments=${attachments.length}`);
          this.cm.nodePool.promptNode(nodeId, content, from, ws, attachments).then(result => {
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
    if (this.wsHeartbeat) clearInterval(this.wsHeartbeat);
    // Close all WS connections
    for (const ws of this.wss.clients) {
      ws.close();
    }
    this.wss.close();
    this.httpServer.close();
    await this.cm.shutdown();
  }
}
