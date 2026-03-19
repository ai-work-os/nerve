import { nanoid } from "nanoid";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BusNode } from "./node.js";
import { StdioTransport, WebSocketTransport } from "./transport.js";
import { AcpClient } from "./acp-client.js";
import { getAdapter } from "./adapter.js";
export class NodePool {
    nodes = new Map();
    acpClients = new Map();
    nameIndex = new Map(); // name → id
    onEvent;
    store;
    constructor(store, onEvent) {
        this.store = store;
        this.onEvent = onEvent;
    }
    get(id) {
        return this.nodes.get(id);
    }
    getByName(name) {
        const id = this.nameIndex.get(name);
        return id ? this.nodes.get(id) : undefined;
    }
    isNameTaken(name) {
        return this.nameIndex.has(name);
    }
    listAll() {
        return [...this.nodes.values()];
    }
    /** Register a WebSocket node (nvim, browser, CLI tool) */
    registerWebSocket(ws, name, capabilities, permissions) {
        const id = nanoid(12);
        const transport = new WebSocketTransport(ws);
        const node = new BusNode({ id, name, transport, capabilities, permissions });
        node.status = "idle";
        this.nodes.set(id, node);
        this.nameIndex.set(name, id);
        this.store.insertNode(id, name, "websocket", undefined, capabilities);
        this.store.updateNodeStatus(id, "idle");
        transport.onClose(() => {
            this.remove(id);
        });
        this.onEvent("node.registered", node);
        return node;
    }
    /** Spawn a Process Node synchronously (handshake runs in background) */
    spawnProcessSync(adapterName, name, cwd, busPort) {
        return this._spawnProcess(adapterName, name, cwd, busPort);
    }
    /** Spawn a Process Node (CLI agent) */
    async spawnProcess(adapterName, name, cwd, busPort) {
        return this._spawnProcess(adapterName, name, cwd, busPort);
    }
    _spawnProcess(adapterName, name, cwd, busPort) {
        const adapter = getAdapter(adapterName);
        if (!adapter)
            throw new Error(`unknown adapter: ${adapterName}`);
        const id = nanoid(12);
        const transport = new StdioTransport();
        const node = new BusNode({
            id,
            name,
            transport,
            capabilities: adapter.capabilities,
            adapter: adapterName,
        });
        this.nodes.set(id, node);
        this.nameIndex.set(name, id);
        this.store.insertNode(id, name, "stdio", adapterName, adapter.capabilities, cwd);
        // Ensure .claude/settings.local.json exists (claude-agent-acp requires it)
        if (adapterName.startsWith("c") && adapterName !== "codex") {
            const settingsDir = join(cwd, ".claude");
            const settingsFile = join(settingsDir, "settings.local.json");
            if (!existsSync(settingsFile)) {
                mkdirSync(settingsDir, { recursive: true });
                writeFileSync(settingsFile, JSON.stringify({
                    permissions: { allow: [], deny: [], ask: [] },
                }, null, 2));
            }
        }
        // Spawn the process
        transport.spawn({
            cmd: adapter.cmd,
            args: adapter.args,
            env: {
                ...adapter.env,
                NERVE_PORT: String(busPort),
                NERVE_NODE_NAME: name,
                PATH: join(dirname(dirname(fileURLToPath(import.meta.url))), "bin") + ":" + (process.env.PATH || ""),
            },
            cwd,
        });
        this.store.updateNodeStatus(id, "connecting", undefined, transport.pid);
        transport.onClose((code) => {
            node.status = "stopped";
            this.store.updateNodeStatus(id, "stopped");
            this.onEvent("node.stopped", node, { exitCode: code });
            // Clean up ACP client
            const client = this.acpClients.get(id);
            if (client) {
                client.cleanup();
                this.acpClients.delete(id);
            }
        });
        // ACP handshake
        const client = new AcpClient({
            transport,
            authMethod: adapter.authMethod,
            cwd,
            onUpdate: (params) => {
                this.onEvent("node.update", node, params);
            },
            onReady: (sessionId) => {
                node.sessionId = sessionId;
                node.status = "idle";
                this.store.updateNodeStatus(id, "idle", sessionId);
                this.onEvent("node.ready", node);
            },
            onError: (err) => {
                node.status = "error";
                this.store.updateNodeStatus(id, "error");
                this.onEvent("node.error", node, { error: err });
            },
        });
        this.acpClients.set(id, client);
        client.handshake(); // Don't await - let it run async
        return node;
    }
    /** Prompt a Process Node */
    async promptNode(nodeId, text) {
        const client = this.acpClients.get(nodeId);
        const node = this.nodes.get(nodeId);
        if (!client || !node)
            return { error: "node not found" };
        node.status = "busy";
        node.touch();
        this.onEvent("node.statusChanged", node);
        const result = await client.prompt(text);
        node.status = "idle";
        node.touch();
        this.onEvent("node.statusChanged", node);
        return result;
    }
    /** List sessions from a Process Node */
    async sessionList(nodeId) {
        const client = this.acpClients.get(nodeId);
        if (!client)
            return { error: "node not found" };
        return client.sessionList();
    }
    /** Load/resume a session on a Process Node */
    async sessionLoad(nodeId, sessionId) {
        const client = this.acpClients.get(nodeId);
        const node = this.nodes.get(nodeId);
        if (!client || !node)
            return { error: "node not found" };
        const result = await client.sessionLoad(sessionId);
        if (!result.error) {
            node.sessionId = sessionId;
        }
        return result;
    }
    /** Stop a Process Node */
    stopNode(nodeId) {
        const node = this.nodes.get(nodeId);
        if (!node)
            return;
        const client = this.acpClients.get(nodeId);
        if (client) {
            client.cleanup();
            this.acpClients.delete(nodeId);
        }
        node.transport.close();
        // Node removal happens in onClose handler
    }
    /** Remove a node from the pool */
    remove(nodeId) {
        const node = this.nodes.get(nodeId);
        if (!node)
            return;
        this.nodes.delete(nodeId);
        this.nameIndex.delete(node.name);
        this.onEvent("node.removed", node);
    }
    /** Shutdown all nodes */
    async shutdown() {
        for (const [id, node] of this.nodes) {
            if (node.isProcess) {
                this.stopNode(id);
            }
            else {
                node.transport.close();
            }
        }
        // Wait for process nodes to exit
        await new Promise(r => setTimeout(r, 2000));
    }
}
//# sourceMappingURL=node-pool.js.map