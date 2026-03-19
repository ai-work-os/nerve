import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { Bus } from "./bus.js";
import type { JsonRpcRequest, JsonRpcMessage } from "./protocol.js";
import * as log from "./logger.js";

export class Server {
  private bus: Bus;
  private wss!: WebSocketServer;
  private httpServer!: ReturnType<typeof createServer>;
  private port: number;

  // Track which WebSocket belongs to which node
  private wsNodeMap = new Map<WebSocket, string>(); // ws → nodeId

  // Direct node subscriptions (node.subscribe): nodeId → Set<WebSocket>
  private nodeSubscribers = new Map<string, Set<WebSocket>>();

  constructor(bus: Bus, port: number) {
    this.bus = bus;
    this.port = port;
  }

  start(): void {
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });

    // Hook into bus node events for direct subscriber push
    this.bus.onNodeEvent = (event, node, detail) => {
      if (event === "node.update" || event === "node.statusChanged") {
        this.notifyNodeSubscribers(node.id, event, node, detail);
      }
      if (event === "node.stopped" || event === "node.removed") {
        this.nodeSubscribers.delete(node.id);
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
          // Remove node from all channels
          const node = this.bus.nodePool.get(nodeId);
          if (node) {
            for (const chId of node.channels) {
              this.bus.removeNodeFromChannel(chId, node.name);
            }
          }
          this.bus.nodePool.remove(nodeId);
          this.wsNodeMap.delete(ws);
        }
        // Clean up any node subscriptions this WS had
        for (const [, subs] of this.nodeSubscribers) {
          subs.delete(ws);
        }
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
          const name = p.name as string;
          if (!name) { this.sendError(ws, id, -32602, "name required"); return; }
          if (this.bus.nodePool.isNameTaken(name)) { this.sendError(ws, id, -32602, `name "${name}" already taken`); return; }

          const node = this.bus.registerNode(
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
          const cwd = (p.cwd as string) || process.cwd();
          const ch = this.bus.createChannel(cwd, p.name as string);
          this.sendResult(ws, id, { channelId: ch.id, name: ch.name, cwd: ch.cwd });
          break;
        }

        case "channel.close": {
          this.bus.closeChannel(p.channelId as string);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "channel.list": {
          const channels = this.bus.listChannels().map(ch => ({
            id: ch.id,
            name: ch.name,
            cwd: ch.cwd,
            nodes: Object.fromEntries(ch.nodes),
          }));
          this.sendResult(ws, id, { channels });
          break;
        }

        case "channel.history": {
          const msgs = this.bus.getHistory(
            p.channelId as string,
            p.limit as number,
            p.before as number,
          );
          this.sendResult(ws, id, { messages: msgs });
          break;
        }

        case "channel.join": {
          const nodeId = this.wsNodeMap.get(ws);
          if (!nodeId) { this.sendError(ws, id, -32600, "not registered"); return; }
          const channelId = p.channelId as string;
          this.bus.addNodeToChannel(channelId, nodeId, p.name as string);
          this.sendResult(ws, id, { ok: true });

          // Replay buffered updates from process nodes already in this channel
          this.replayToClient(ws, channelId);
          break;
        }

        case "channel.leave": {
          const nodeId = this.wsNodeMap.get(ws);
          if (!nodeId) { this.sendError(ws, id, -32600, "not registered"); return; }
          const node = this.bus.nodePool.get(nodeId);
          if (node) this.bus.removeNodeFromChannel(p.channelId as string, node.name);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "channel.addNode": {
          const channelId = p.channelId as string;
          const addNodeId = p.nodeId as string;
          this.bus.addNodeToChannel(channelId, addNodeId, p.name as string);
          this.sendResult(ws, id, { ok: true });

          // If the added node is a process node with buffered updates,
          // replay them to all WS clients already in this channel
          this.replayNodeUpdatesToChannel(channelId, addNodeId);
          break;
        }

        case "channel.removeNode": {
          this.bus.removeNodeFromChannel(p.channelId as string, p.nodeName as string);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "channel.post": {
          const nodeId = this.wsNodeMap.get(ws);
          if (!nodeId) { this.sendError(ws, id, -32600, "not registered"); return; }
          const node = this.bus.nodePool.get(nodeId);
          if (!node) { this.sendError(ws, id, -32600, "node not found"); return; }

          const msg = this.bus.postMessage(
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
          const targetNode = this.bus.nodePool.get(targetId);
          if (!targetNode) { this.sendError(ws, id, -32602, "node not found"); return; }

          if (!this.nodeSubscribers.has(targetId)) {
            this.nodeSubscribers.set(targetId, new Set());
          }
          this.nodeSubscribers.get(targetId)!.add(ws);

          // Replay existing buffer to subscriber
          if (targetNode.updateBuffer.length > 0) {
            for (const update of targetNode.updateBuffer) {
              ws.send(JSON.stringify({
                jsonrpc: "2.0",
                method: "node.update",
                params: { nodeId: targetNode.id, name: targetNode.name, ...update },
              }));
            }
          }

          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "node.unsubscribe": {
          const targetId = p.nodeId as string;
          if (!targetId) { this.sendError(ws, id, -32602, "nodeId required"); return; }
          const subs = this.nodeSubscribers.get(targetId);
          if (subs) subs.delete(ws);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "node.spawn": {
          const adapter = p.adapter as string;
          const cwd = (p.cwd as string) || process.cwd();
          const name = (p.name as string) || this.generateNodeName(adapter, cwd);

          if (this.bus.nodePool.isNameTaken(name)) {
            this.sendError(ws, id, -32602, `name "${name}" already taken`);
            return;
          }

          this.bus.spawnNode(adapter, name, cwd).then(node => {
            this.sendResult(ws, id, { nodeId: node.id, name: node.name });
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        case "node.stop": {
          this.bus.stopNode(p.nodeId as string);
          this.sendResult(ws, id, { ok: true });
          break;
        }

        case "node.list": {
          let nodes = this.bus.nodePool.listAll();
          const cwdFilter = p.cwd as string;
          if (cwdFilter) {
            nodes = nodes.filter(n => n.cwd === cwdFilter);
          }
          this.sendResult(ws, id, { nodes: nodes.map(n => n.toInfo()) });
          break;
        }

        case "node.prompt": {
          const nodeId = p.nodeId as string;
          const content = p.content as string;
          if (!nodeId || !content) { this.sendError(ws, id, -32602, "nodeId and content required"); return; }
          const node = this.bus.nodePool.get(nodeId);
          if (!node) { this.sendError(ws, id, -32602, `node not found`); return; }
          if (!node.isProcess) { this.sendError(ws, id, -32602, "can only prompt process nodes"); return; }

          this.bus.nodePool.promptNode(nodeId, content).then(result => {
            this.sendResult(ws, id, result);
          }).catch(err => {
            this.sendError(ws, id, -32000, String(err));
          });
          break;
        }

        case "node.cancel": {
          const nodeId = p.nodeId as string;
          if (!nodeId) { this.sendError(ws, id, -32602, "nodeId required"); return; }
          const node = this.bus.nodePool.get(nodeId);
          if (!node) { this.sendError(ws, id, -32602, "node not found"); return; }
          if (!node.isProcess) { this.sendError(ws, id, -32602, "can only cancel process nodes"); return; }

          this.bus.nodePool.cancelNode(nodeId).then(result => {
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
          const updates = this.bus.getNodeUpdates(nodeName);
          this.sendResult(ws, id, { updates });
          break;
        }

        case "session.list": {
          const nodeName = p.nodeName as string;
          if (!nodeName) { this.sendError(ws, id, -32602, "nodeName required"); return; }
          const node = this.bus.nodePool.getByName(nodeName);
          if (!node) { this.sendError(ws, id, -32602, `node "${nodeName}" not found`); return; }
          this.bus.nodePool.sessionList(node.id).then(result => {
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
          const node = this.bus.nodePool.getByName(nodeName);
          if (!node) { this.sendError(ws, id, -32602, `node "${nodeName}" not found`); return; }
          this.bus.nodePool.sessionLoad(node.id, sessionId).then(result => {
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

  /**
   * HTTP API for Process Nodes (CLI agents) to manage Bus via terminal/curl.
   * All POST endpoints accept JSON body with `from` field to identify the caller node.
   */
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    // Health check (includes log path for AI access)
    if (req.method === "GET" && req.url === "/health") {
      const logPath = log.getLogPath();
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ status: "ok", logFile: logPath })
      );
      return;
    }

    // Log tail (AI can read recent logs via HTTP)
    if (req.method === "GET" && req.url?.startsWith("/log")) {
      const logPath = log.getLogPath();
      if (!logPath) {
        res.writeHead(200, { "Content-Type": "text/plain" }).end("no log file");
        return;
      }
      try {
        const content = readFileSync(logPath, "utf8");
        const lines = content.split("\n");
        const url = new URL(req.url, `http://localhost:${this.port}`);
        const tail = parseInt(url.searchParams.get("tail") || "100");
        const result = lines.slice(-tail).join("\n");
        res.writeHead(200, { "Content-Type": "text/plain" }).end(result);
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "text/plain" }).end(e.message);
      }
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(404).end('{"error":"not found"}');
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body) as Record<string, unknown>;
        const result = await this.handleHttpRoute(req.url || "", data);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }));
      }
    });
  }

  private async handleHttpRoute(url: string, data: Record<string, unknown>): Promise<unknown> {
    const from = data.from as string;

    switch (url) {
      // --- Channel management ---
      case "/channel/create": {
        const cwd = (data.cwd as string) || process.cwd();
        const ch = this.bus.createChannel(cwd, data.name as string);
        // Auto-join the calling node if identified
        if (from) {
          const node = this.bus.nodePool.getByName(from);
          if (node) this.bus.addNodeToChannel(ch.id, node.id, from);
        }
        return { channelId: ch.id, name: ch.name, cwd: ch.cwd };
      }

      case "/channel/close": {
        const channelId = data.channelId as string;
        if (!channelId) throw new Error("channelId required");
        this.bus.closeChannel(channelId);
        return { ok: true };
      }

      case "/channel/list": {
        const channels = this.bus.listChannels().map(ch => ({
          id: ch.id,
          name: ch.name,
          cwd: ch.cwd,
          nodes: Object.fromEntries(ch.nodes),
        }));
        return { channels };
      }

      case "/channel/addNode": {
        const channelId = data.channelId as string;
        const nodeId = data.nodeId as string;
        const nodeName = data.nodeName as string;
        if (!channelId || !nodeId) throw new Error("channelId and nodeId required");
        this.bus.addNodeToChannel(channelId, nodeId, nodeName);
        return { ok: true };
      }

      case "/channel/removeNode": {
        const channelId = data.channelId as string;
        const nodeName = data.nodeName as string;
        if (!channelId || !nodeName) throw new Error("channelId and nodeName required");
        this.bus.removeNodeFromChannel(channelId, nodeName);
        return { ok: true };
      }

      case "/channel/post":
      case "/post": {
        const content = data.content as string;
        if (!content) throw new Error("content required");
        if (!from) throw new Error("from required");

        const channelId = data.channelId as string;
        if (channelId) {
          // Post to specific channel
          const msg = this.bus.postMessage(channelId, from, content);
          return { ok: true, message: msg };
        } else {
          // Post to first channel this node is in
          this.bus.postFromProcess(from, content);
          return { ok: true };
        }
      }

      case "/channel/history": {
        const channelId = data.channelId as string;
        if (!channelId) throw new Error("channelId required");
        const msgs = this.bus.getHistory(channelId, data.limit as number, data.before as number);
        return { messages: msgs };
      }

      // --- Node management ---
      case "/node/spawn": {
        const adapter = data.adapter as string;
        if (!adapter) throw new Error("adapter required");
        const cwd = (data.cwd as string) || process.cwd();
        const name = (data.name as string) || this.generateNodeName(adapter, cwd);

        if (this.bus.nodePool.isNameTaken(name)) {
          throw new Error(`name "${name}" already taken`);
        }

        const nodeId = this.bus.spawnNodeSync(adapter, name, cwd);
        return { nodeId, name, status: "connecting" };
      }

      case "/node/join": {
        const nodeName = data.nodeName as string;
        const channelId = data.channelId as string;
        if (!nodeName || !channelId) throw new Error("nodeName and channelId required");
        const node = this.bus.nodePool.getByName(nodeName);
        if (!node) throw new Error(`node "${nodeName}" not found`);
        this.bus.addNodeToChannel(channelId, node.id, nodeName);
        return { ok: true };
      }

      case "/node/leave": {
        const nodeName = data.nodeName as string;
        const channelId = data.channelId as string;
        if (!nodeName || !channelId) throw new Error("nodeName and channelId required");
        this.bus.removeNodeFromChannel(channelId, nodeName);
        return { ok: true };
      }

      case "/node/stop": {
        const nodeId = data.nodeId as string;
        const nodeName = data.nodeName as string;
        if (nodeId) {
          this.bus.stopNode(nodeId);
        } else if (nodeName) {
          const node = this.bus.nodePool.getByName(nodeName);
          if (node) this.bus.stopNode(node.id);
          else throw new Error(`node "${nodeName}" not found`);
        } else {
          throw new Error("nodeId or nodeName required");
        }
        return { ok: true };
      }

      case "/node/cancel": {
        const nodeId = data.nodeId as string;
        const nodeName = data.nodeName as string;
        let targetId: string | undefined;
        if (nodeId) {
          targetId = nodeId;
        } else if (nodeName) {
          const node = this.bus.nodePool.getByName(nodeName);
          if (!node) throw new Error(`node "${nodeName}" not found`);
          targetId = node.id;
        } else {
          throw new Error("nodeId or nodeName required");
        }
        return await this.bus.nodePool.cancelNode(targetId);
      }

      case "/node/list": {
        let nodes = this.bus.nodePool.listAll();
        const cwdFilter = data.cwd as string;
        if (cwdFilter) {
          nodes = nodes.filter(n => n.cwd === cwdFilter);
        }
        return { nodes: nodes.map(n => n.toInfo()) };
      }

      // --- Session management ---

      case "/session/list": {
        const nodeName = data.nodeName as string;
        if (!nodeName) throw new Error("nodeName required");
        const node = this.bus.nodePool.getByName(nodeName);
        if (!node) throw new Error(`node "${nodeName}" not found`);
        return await this.bus.nodePool.sessionList(node.id);
      }

      case "/session/load": {
        const nodeName = data.nodeName as string;
        const sessionId = data.sessionId as string;
        if (!nodeName || !sessionId) throw new Error("nodeName and sessionId required");
        const node = this.bus.nodePool.getByName(nodeName);
        if (!node) throw new Error(`node "${nodeName}" not found`);
        return await this.bus.nodePool.sessionLoad(node.id, sessionId);
      }

      default:
        throw new Error(`unknown endpoint: ${url}`);
    }
  }

  /** Replay buffered updates from process nodes already in a channel to a single WS client (on join) */
  private replayToClient(ws: WebSocket, channelId: string): void {
    const ch = this.bus.getChannel(channelId);
    if (!ch) return;

    for (const [, nodeId] of ch.nodes) {
      const node = this.bus.nodePool.get(nodeId);
      if (!node || !node.isProcess || node.updateBuffer.length === 0) continue;

      log.info(`replay: ${node.name} → new client in ${channelId} (${node.updateBuffer.length} updates)`);
      for (const update of node.updateBuffer) {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "node.update",
          params: { nodeId: node.id, name: node.name, ...update },
        }));
      }
    }
  }

  /** Replay a specific node's buffer to all WS clients in a channel (after addNode) */
  private replayNodeUpdatesToChannel(channelId: string, nodeId: string): void {
    const node = this.bus.nodePool.get(nodeId);
    if (!node || !node.isProcess || node.updateBuffer.length === 0) return;

    const ch = this.bus.getChannel(channelId);
    if (!ch) return;

    log.info(`replay: ${node.name} addNode → channel ${channelId} (${node.updateBuffer.length} updates to WS clients)`);

    for (const [, memberId] of ch.nodes) {
      const member = this.bus.nodePool.get(memberId);
      if (!member || member.isProcess || !member.transport.alive) continue;
      for (const update of node.updateBuffer) {
        member.transport.send({
          jsonrpc: "2.0",
          method: "node.update",
          params: {
            nodeId: node.id,
            name: node.name,
            ...update,
          },
        } as any);
      }
    }
  }

  /** Generate auto name: {adapter}-{basename(cwd)}, with -2 -3 suffix for conflicts */
  private generateNodeName(adapter: string, cwd: string): string {
    const dir = basename(cwd) || "agent";
    const base = `${adapter}-${dir}`;
    if (!this.bus.nodePool.isNameTaken(base)) return base;
    for (let i = 2; ; i++) {
      const name = `${base}-${i}`;
      if (!this.bus.nodePool.isNameTaken(name)) return name;
    }
  }

  /** Notify direct subscribers of a node's events */
  private notifyNodeSubscribers(
    nodeId: string,
    event: string,
    node: { id: string; name: string; status: string; activity?: string },
    detail?: Record<string, unknown>,
  ): void {
    const subs = this.nodeSubscribers.get(nodeId);
    if (!subs || subs.size === 0) return;

    let notification: Record<string, unknown>;
    if (event === "node.update") {
      notification = {
        jsonrpc: "2.0",
        method: "node.update",
        params: { nodeId: node.id, name: node.name, ...(detail || {}) },
      };
    } else {
      notification = {
        jsonrpc: "2.0",
        method: "node.statusChanged",
        params: { nodeId: node.id, name: node.name, status: node.status, activity: node.activity },
      };
    }

    const msg = JSON.stringify(notification);
    for (const ws of subs) {
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
    await this.bus.shutdown();
  }
}
