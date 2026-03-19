import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import * as log from "./logger.js";
export class Server {
    bus;
    wss;
    httpServer;
    port;
    // Track which WebSocket belongs to which node
    wsNodeMap = new Map(); // ws → nodeId
    constructor(bus, port) {
        this.bus = bus;
        this.port = port;
    }
    start() {
        this.httpServer = createServer((req, res) => this.handleHttp(req, res));
        this.wss = new WebSocketServer({ server: this.httpServer });
        this.wss.on("connection", (ws) => {
            ws.on("message", (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if ("method" in msg && "id" in msg) {
                        this.handleRequest(ws, msg);
                    }
                }
                catch {
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
            });
        });
        this.httpServer.listen(this.port, () => {
            log.info(`nerve started on port ${this.port}`);
        });
    }
    handleRequest(ws, req) {
        const { id, method, params } = req;
        const p = (params || {});
        try {
            switch (method) {
                case "node.register": {
                    const name = p.name;
                    if (!name) {
                        this.sendError(ws, id, -32602, "name required");
                        return;
                    }
                    if (this.bus.nodePool.isNameTaken(name)) {
                        this.sendError(ws, id, -32602, `name "${name}" already taken`);
                        return;
                    }
                    const node = this.bus.registerNode(ws, name, p.capabilities || ["ui"], p.permissions || "operator");
                    this.wsNodeMap.set(ws, node.id);
                    this.sendResult(ws, id, { nodeId: node.id, name: node.name });
                    break;
                }
                case "channel.create": {
                    const cwd = p.cwd || process.cwd();
                    const ch = this.bus.createChannel(cwd, p.name);
                    this.sendResult(ws, id, { channelId: ch.id, name: ch.name, cwd: ch.cwd });
                    break;
                }
                case "channel.close": {
                    this.bus.closeChannel(p.channelId);
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
                    const msgs = this.bus.getHistory(p.channelId, p.limit, p.before);
                    this.sendResult(ws, id, { messages: msgs });
                    break;
                }
                case "channel.join": {
                    const nodeId = this.wsNodeMap.get(ws);
                    if (!nodeId) {
                        this.sendError(ws, id, -32600, "not registered");
                        return;
                    }
                    this.bus.addNodeToChannel(p.channelId, nodeId, p.name);
                    this.sendResult(ws, id, { ok: true });
                    break;
                }
                case "channel.leave": {
                    const nodeId = this.wsNodeMap.get(ws);
                    if (!nodeId) {
                        this.sendError(ws, id, -32600, "not registered");
                        return;
                    }
                    const node = this.bus.nodePool.get(nodeId);
                    if (node)
                        this.bus.removeNodeFromChannel(p.channelId, node.name);
                    this.sendResult(ws, id, { ok: true });
                    break;
                }
                case "channel.addNode": {
                    this.bus.addNodeToChannel(p.channelId, p.nodeId, p.name);
                    this.sendResult(ws, id, { ok: true });
                    break;
                }
                case "channel.removeNode": {
                    this.bus.removeNodeFromChannel(p.channelId, p.nodeName);
                    this.sendResult(ws, id, { ok: true });
                    break;
                }
                case "channel.post": {
                    const nodeId = this.wsNodeMap.get(ws);
                    if (!nodeId) {
                        this.sendError(ws, id, -32600, "not registered");
                        return;
                    }
                    const node = this.bus.nodePool.get(nodeId);
                    if (!node) {
                        this.sendError(ws, id, -32600, "node not found");
                        return;
                    }
                    const msg = this.bus.postMessage(p.channelId, node.name, p.content);
                    this.sendResult(ws, id, { message: msg });
                    break;
                }
                case "node.spawn": {
                    const adapter = p.adapter;
                    const name = p.name || `${adapter}-${Date.now() % 10000}`;
                    const cwd = p.cwd || process.cwd();
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
                    this.bus.stopNode(p.nodeId);
                    this.sendResult(ws, id, { ok: true });
                    break;
                }
                case "node.list": {
                    const nodes = this.bus.nodePool.listAll().map(n => n.toInfo());
                    this.sendResult(ws, id, { nodes });
                    break;
                }
                case "node.prompt": {
                    const nodeId = p.nodeId;
                    const content = p.content;
                    if (!nodeId || !content) {
                        this.sendError(ws, id, -32602, "nodeId and content required");
                        return;
                    }
                    const node = this.bus.nodePool.get(nodeId);
                    if (!node) {
                        this.sendError(ws, id, -32602, `node not found`);
                        return;
                    }
                    if (!node.isProcess) {
                        this.sendError(ws, id, -32602, "can only prompt process nodes");
                        return;
                    }
                    this.bus.nodePool.promptNode(nodeId, content).then(result => {
                        this.sendResult(ws, id, result);
                    }).catch(err => {
                        this.sendError(ws, id, -32000, String(err));
                    });
                    break;
                }
                case "session.list": {
                    const nodeName = p.nodeName;
                    if (!nodeName) {
                        this.sendError(ws, id, -32602, "nodeName required");
                        return;
                    }
                    const node = this.bus.nodePool.getByName(nodeName);
                    if (!node) {
                        this.sendError(ws, id, -32602, `node "${nodeName}" not found`);
                        return;
                    }
                    this.bus.nodePool.sessionList(node.id).then(result => {
                        this.sendResult(ws, id, result);
                    }).catch(err => {
                        this.sendError(ws, id, -32000, String(err));
                    });
                    break;
                }
                case "session.load": {
                    const nodeName = p.nodeName;
                    const sessionId = p.sessionId;
                    if (!nodeName || !sessionId) {
                        this.sendError(ws, id, -32602, "nodeName and sessionId required");
                        return;
                    }
                    const node = this.bus.nodePool.getByName(nodeName);
                    if (!node) {
                        this.sendError(ws, id, -32602, `node "${nodeName}" not found`);
                        return;
                    }
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
        }
        catch (err) {
            this.sendError(ws, id, -32000, String(err));
        }
    }
    /**
     * HTTP API for Process Nodes (CLI agents) to manage Bus via terminal/curl.
     * All POST endpoints accept JSON body with `from` field to identify the caller node.
     */
    handleHttp(req, res) {
        // Health check (includes log path for AI access)
        if (req.method === "GET" && req.url === "/health") {
            const logPath = log.getLogPath();
            res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok", logFile: logPath }));
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
            }
            catch (e) {
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
                const data = JSON.parse(body);
                const result = await this.handleHttpRoute(req.url || "", data);
                res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }));
            }
        });
    }
    async handleHttpRoute(url, data) {
        const from = data.from;
        switch (url) {
            // --- Channel management ---
            case "/channel/create": {
                const cwd = data.cwd || process.cwd();
                const ch = this.bus.createChannel(cwd, data.name);
                // Auto-join the calling node if identified
                if (from) {
                    const node = this.bus.nodePool.getByName(from);
                    if (node)
                        this.bus.addNodeToChannel(ch.id, node.id, from);
                }
                return { channelId: ch.id, name: ch.name, cwd: ch.cwd };
            }
            case "/channel/close": {
                const channelId = data.channelId;
                if (!channelId)
                    throw new Error("channelId required");
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
                const channelId = data.channelId;
                const nodeId = data.nodeId;
                const nodeName = data.nodeName;
                if (!channelId || !nodeId)
                    throw new Error("channelId and nodeId required");
                this.bus.addNodeToChannel(channelId, nodeId, nodeName);
                return { ok: true };
            }
            case "/channel/removeNode": {
                const channelId = data.channelId;
                const nodeName = data.nodeName;
                if (!channelId || !nodeName)
                    throw new Error("channelId and nodeName required");
                this.bus.removeNodeFromChannel(channelId, nodeName);
                return { ok: true };
            }
            case "/channel/post":
            case "/post": {
                const content = data.content;
                if (!content)
                    throw new Error("content required");
                if (!from)
                    throw new Error("from required");
                const channelId = data.channelId;
                if (channelId) {
                    // Post to specific channel
                    const msg = this.bus.postMessage(channelId, from, content);
                    return { ok: true, message: msg };
                }
                else {
                    // Post to first channel this node is in
                    this.bus.postFromProcess(from, content);
                    return { ok: true };
                }
            }
            case "/channel/history": {
                const channelId = data.channelId;
                if (!channelId)
                    throw new Error("channelId required");
                const msgs = this.bus.getHistory(channelId, data.limit, data.before);
                return { messages: msgs };
            }
            // --- Node management ---
            case "/node/spawn": {
                const adapter = data.adapter;
                if (!adapter)
                    throw new Error("adapter required");
                const name = data.name || `${adapter}-${Date.now() % 10000}`;
                const cwd = data.cwd || process.cwd();
                if (this.bus.nodePool.isNameTaken(name)) {
                    throw new Error(`name "${name}" already taken`);
                }
                const nodeId = this.bus.spawnNodeSync(adapter, name, cwd);
                return { nodeId, name, status: "connecting" };
            }
            case "/node/join": {
                const nodeName = data.nodeName;
                const channelId = data.channelId;
                if (!nodeName || !channelId)
                    throw new Error("nodeName and channelId required");
                const node = this.bus.nodePool.getByName(nodeName);
                if (!node)
                    throw new Error(`node "${nodeName}" not found`);
                this.bus.addNodeToChannel(channelId, node.id, nodeName);
                return { ok: true };
            }
            case "/node/leave": {
                const nodeName = data.nodeName;
                const channelId = data.channelId;
                if (!nodeName || !channelId)
                    throw new Error("nodeName and channelId required");
                this.bus.removeNodeFromChannel(channelId, nodeName);
                return { ok: true };
            }
            case "/node/stop": {
                const nodeId = data.nodeId;
                const nodeName = data.nodeName;
                if (nodeId) {
                    this.bus.stopNode(nodeId);
                }
                else if (nodeName) {
                    const node = this.bus.nodePool.getByName(nodeName);
                    if (node)
                        this.bus.stopNode(node.id);
                    else
                        throw new Error(`node "${nodeName}" not found`);
                }
                else {
                    throw new Error("nodeId or nodeName required");
                }
                return { ok: true };
            }
            case "/node/list": {
                const nodes = this.bus.nodePool.listAll().map(n => n.toInfo());
                return { nodes };
            }
            // --- Session management ---
            case "/session/list": {
                const nodeName = data.nodeName;
                if (!nodeName)
                    throw new Error("nodeName required");
                const node = this.bus.nodePool.getByName(nodeName);
                if (!node)
                    throw new Error(`node "${nodeName}" not found`);
                return await this.bus.nodePool.sessionList(node.id);
            }
            case "/session/load": {
                const nodeName = data.nodeName;
                const sessionId = data.sessionId;
                if (!nodeName || !sessionId)
                    throw new Error("nodeName and sessionId required");
                const node = this.bus.nodePool.getByName(nodeName);
                if (!node)
                    throw new Error(`node "${nodeName}" not found`);
                return await this.bus.nodePool.sessionLoad(node.id, sessionId);
            }
            default:
                throw new Error(`unknown endpoint: ${url}`);
        }
    }
    sendResult(ws, id, result) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    }
    sendError(ws, id, code, message) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
    }
    async shutdown() {
        // Close all WS connections
        for (const ws of this.wss.clients) {
            ws.close();
        }
        this.wss.close();
        this.httpServer.close();
        await this.bus.shutdown();
    }
}
//# sourceMappingURL=server.js.map