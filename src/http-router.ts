import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ChannelManager } from "./channel-manager.js";
import * as log from "./logger.js";

/**
 * HTTP API router for process nodes (CLI agents) to manage channels via terminal/curl.
 * All POST endpoints accept JSON body with `from` field to identify the caller node.
 */
export class HttpRouter {
  constructor(
    private cm: ChannelManager,
    private port: number,
  ) {}

  handle(req: IncomingMessage, res: ServerResponse): void {
    // Health check (includes log path for AI access)
    if (req.method === "GET" && req.url === "/health") {
      const logPath = log.getLogPath();
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ status: "ok", logFile: logPath })
      );
      return;
    }

    // Blob content retrieval
    if (req.method === "GET" && req.url?.startsWith("/blob/")) {
      const blobId = req.url.slice(6); // strip "/blob/"
      const content = this.cm.blobStore.get(blobId);
      if (content) {
        res.writeHead(200, { "Content-Type": "text/plain" }).end(content);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "blob not found" }));
      }
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
        const result = await this.route(req.url || "", data);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }));
      }
    });
  }

  private async route(url: string, data: Record<string, unknown>): Promise<unknown> {
    const from = data.from as string;

    switch (url) {
      // --- Channel management ---
      case "/channel/create": {
        const cwd = resolve((data.cwd as string) || process.cwd());
        const ch = this.cm.createChannel(cwd, data.name as string);
        // Auto-join the calling node if identified
        if (from) {
          const node = this.cm.nodePool.getByName(from);
          if (node) this.cm.addNodeToChannel(ch.id, node.id, from);
        }
        return { channelId: ch.id, name: ch.name, cwd: ch.cwd };
      }

      case "/channel/close": {
        const channelId = data.channelId as string;
        if (!channelId) throw new Error("channelId required");
        this.cm.closeChannel(channelId);
        return { ok: true };
      }

      case "/channel/delete": {
        const channelId = data.channelId as string;
        if (!channelId) throw new Error("channelId required");
        this.cm.deleteChannel(channelId);
        return { ok: true };
      }

      case "/channel/list": {
        let channelList = this.cm.listChannels();
        const cwdFilter = data.cwd ? resolve(data.cwd as string) : undefined;
        if (cwdFilter) {
          channelList = channelList.filter(ch => ch.cwd === cwdFilter || ch.cwd.startsWith(cwdFilter + "/"));
        }
        const channels = channelList.map(ch => ({
          id: ch.id,
          name: ch.name,
          cwd: ch.cwd,
          nodes: Object.fromEntries(ch.nodes),
        }));
        return { channels };
      }

      case "/channel/listArchived": {
        const activeIds = this.cm.listChannels().map(ch => ch.id);
        const cwdFilter = data.cwd ? resolve(data.cwd as string) : undefined;
        const query = data.query as string | undefined;
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
        return { channels };
      }

      case "/channel/restore": {
        const channelId = data.channelId as string;
        if (!channelId) throw new Error("channelId required");
        const result = this.cm.restoreChannel(channelId);
        if (!result) throw new Error("channel not found");
        const { channel: ch, messages } = result;
        return {
          channelId: ch.id,
          name: ch.name,
          cwd: ch.cwd,
          messages,
          agents: this.cm.store.getChannelAgents(channelId),
        };
      }

      case "/channel/addNode": {
        const channelId = data.channelId as string;
        const nodeId = data.nodeId as string;
        const nodeName = data.nodeName as string;
        if (!channelId || !nodeId) throw new Error("channelId and nodeId required");
        this.cm.addNodeToChannel(channelId, nodeId, nodeName);
        return { ok: true };
      }

      case "/channel/removeNode": {
        const channelId = data.channelId as string;
        const nodeName = data.nodeName as string;
        if (!channelId || !nodeName) throw new Error("channelId and nodeName required");
        this.cm.removeNodeFromChannel(channelId, nodeName);
        return { ok: true };
      }

      case "/channel/post":
      case "/post": {
        const content = data.content as string;
        if (!content) throw new Error("content required");
        if (!from) throw new Error("from required");

        const channelId = data.channelId as string;
        if (channelId) {
          const msg = this.cm.postMessage(channelId, from, content);
          if (!msg) throw new Error(`channel ${channelId} not found`);
          return { ok: true, message: msg };
        } else {
          const msg = this.cm.postFromProcess(from, content);
          return { ok: true, message: msg };
        }
      }

      case "/channel/history": {
        const channelId = data.channelId as string;
        if (!channelId) throw new Error("channelId required");
        const msgs = this.cm.getHistory(channelId, data.limit as number, data.before as number);
        return { messages: msgs };
      }

      // --- Node management ---
      case "/node/spawn": {
        const adapter = data.adapter as string;
        if (!adapter) throw new Error("adapter required");
        const cwd = resolve((data.cwd as string) || process.cwd());
        const name = (data.name as string) || this.generateNodeName(adapter, cwd);

        if (this.cm.nodePool.isNameTaken(name)) {
          throw new Error(`name "${name}" already taken`);
        }

        const nodeId = this.cm.spawnNodeSync(adapter, name, cwd);
        return { nodeId, name, status: "connecting" };
      }

      case "/node/join": {
        const nodeName = data.nodeName as string;
        const channelId = data.channelId as string;
        if (!nodeName || !channelId) throw new Error("nodeName and channelId required");
        const node = this.cm.nodePool.getByName(nodeName);
        if (!node) throw new Error(`node "${nodeName}" not found`);
        this.cm.addNodeToChannel(channelId, node.id, nodeName);
        return { ok: true };
      }

      case "/node/leave": {
        const nodeName = data.nodeName as string;
        const channelId = data.channelId as string;
        if (!nodeName || !channelId) throw new Error("nodeName and channelId required");
        this.cm.removeNodeFromChannel(channelId, nodeName);
        return { ok: true };
      }

      case "/node/stop": {
        const nodeId = data.nodeId as string;
        const nodeName = data.nodeName as string;
        if (nodeId) {
          this.cm.stopNode(nodeId);
        } else if (nodeName) {
          const node = this.cm.nodePool.getByName(nodeName);
          if (node) this.cm.stopNode(node.id);
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
          const node = this.cm.nodePool.getByName(nodeName);
          if (!node) throw new Error(`node "${nodeName}" not found`);
          targetId = node.id;
        } else {
          throw new Error("nodeId or nodeName required");
        }
        return await this.cm.nodePool.cancelNode(targetId);
      }

      case "/node/list": {
        let nodes = this.cm.nodePool.listAll();
        const cwdFilter = data.cwd ? resolve(data.cwd as string) : undefined;
        if (cwdFilter) {
          nodes = nodes.filter(n =>
            n.capabilities.includes("monitor") ||
            n.cwd === cwdFilter ||
            (n.cwd && n.cwd.startsWith(cwdFilter + "/"))
          );
        }
        return { nodes: nodes.map(n => n.toInfo()) };
      }

      // --- Session management ---

      case "/session/list": {
        const nodeName = data.nodeName as string;
        if (!nodeName) throw new Error("nodeName required");
        const node = this.cm.nodePool.getByName(nodeName);
        if (!node) throw new Error(`node "${nodeName}" not found`);
        return await this.cm.nodePool.sessionList(node.id);
      }

      case "/session/load": {
        const nodeName = data.nodeName as string;
        const sessionId = data.sessionId as string;
        if (!nodeName || !sessionId) throw new Error("nodeName and sessionId required");
        const node = this.cm.nodePool.getByName(nodeName);
        if (!node) throw new Error(`node "${nodeName}" not found`);
        return await this.cm.nodePool.sessionLoad(node.id, sessionId);
      }

      case "/session/clear": {
        const nodeName = data.nodeName as string;
        if (!nodeName) throw new Error("nodeName required");
        const node = this.cm.nodePool.getByName(nodeName);
        if (!node) throw new Error(`node "${nodeName}" not found`);
        return await this.cm.nodePool.sessionClear(node.id);
      }

      case "/session/compact": {
        const nodeName = data.nodeName as string;
        if (!nodeName) throw new Error("nodeName required");
        const node = this.cm.nodePool.getByName(nodeName);
        if (!node) throw new Error(`node "${nodeName}" not found`);
        return await this.cm.nodePool.sessionCompact(node.id);
      }

      case "/session/reset": {
        const nodeName = data.nodeName as string;
        const expectedSessionId = data.expectedSessionId as string;
        const summaryPath = data.summaryPath as string;
        if (!nodeName) throw new Error("nodeName required");
        if (!expectedSessionId) throw new Error("expectedSessionId required");
        if (!summaryPath) throw new Error("summaryPath required");
        const node = this.cm.nodePool.getByName(nodeName);
        if (!node) throw new Error(`node "${nodeName}" not found`);
        const selfReset = !!data.selfReset;
        const result = await this.cm.nodePool.sessionReset(node.id, expectedSessionId, summaryPath, selfReset);
        if (result.error) throw new Error(result.error);
        return result;
      }

      default:
        throw new Error(`unknown endpoint: ${url}`);
    }
  }

  /** Generate auto name: {adapter}-{basename(cwd)}, with -2 -3 suffix for conflicts */
  generateNodeName(adapter: string, cwd: string): string {
    const dir = basename(cwd) || "agent";
    const base = `${adapter}-${dir}`;
    if (!this.cm.nodePool.isNameTaken(base)) return base;
    for (let i = 2; ; i++) {
      const name = `${base}-${i}`;
      if (!this.cm.nodePool.isNameTaken(name)) return name;
    }
  }
}
