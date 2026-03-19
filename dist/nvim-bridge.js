#!/usr/bin/env npx tsx
/**
 * nvim ↔ Nerve bridge.
 *
 * Connects to Bus server via WebSocket, registers as "nvim" node,
 * and forwards messages bidirectionally:
 *   Bus → nvim: channel.message notification → nvim --remote-expr
 *   nvim → Bus: nvim calls `nerve channel post` (HTTP, no bridge needed)
 *
 * Usage:
 *   nerve bridge [--port 4800] [--sock $NVIM_LISTEN_ADDRESS] [--channel ID]
 *
 * Or standalone:
 *   npx tsx src/nvim-bridge.ts --sock /tmp/nvim.sock --channel abc123
 */
import { WebSocket } from "ws";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const BUS_PORT = parseInt(process.env.NERVE_PORT || "4800");
const NVIM_SOCK = process.env.NVIM_LISTEN_ADDRESS || "";
class NvimBridge {
    ws;
    opts;
    rpcId = 1;
    nodeId;
    channelId;
    connected = false;
    constructor(opts) {
        this.opts = opts;
    }
    async start() {
        await this.connectWs();
        await this.register();
        if (this.opts.channelId) {
            await this.joinChannel(this.opts.channelId);
        }
        else {
            // Auto-join first channel or create one
            const channels = await this.rpc("channel.list", {});
            const list = channels.channels || [];
            if (list.length > 0) {
                await this.joinChannel(list[0].id);
            }
            else {
                const created = await this.rpc("channel.create", {
                    cwd: process.cwd(),
                    name: "main",
                });
                await this.joinChannel(created.channelId);
            }
        }
        console.log(`[bridge] connected: node=${this.opts.nodeName} channel=${this.channelId}`);
    }
    connectWs() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.opts.busUrl);
            this.ws.on("open", () => {
                this.connected = true;
                resolve();
            });
            this.ws.on("error", (err) => {
                if (!this.connected)
                    reject(err);
                else
                    console.error(`[bridge] ws error: ${err.message}`);
            });
            this.ws.on("close", () => {
                this.connected = false;
                console.log("[bridge] disconnected from Bus");
                // Auto-reconnect after 3s
                setTimeout(() => {
                    if (!this.connected) {
                        console.log("[bridge] reconnecting...");
                        this.start().catch((e) => console.error(`[bridge] reconnect failed: ${e.message}`));
                    }
                }, 3000);
            });
            this.ws.on("message", (data) => {
                this.handleMessage(data.toString());
            });
        });
    }
    async register() {
        const result = await this.rpc("node.register", {
            name: this.opts.nodeName,
            capabilities: ["ui"],
            permissions: "operator",
        });
        this.nodeId = result.nodeId;
    }
    async joinChannel(channelId) {
        await this.rpc("channel.join", { channelId });
        this.channelId = channelId;
    }
    pendingRpc = new Map();
    rpc(method, params) {
        return new Promise((resolve, reject) => {
            const id = this.rpcId++;
            this.pendingRpc.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            setTimeout(() => {
                if (this.pendingRpc.has(id)) {
                    this.pendingRpc.delete(id);
                    reject(new Error(`${method} timeout`));
                }
            }, 10000);
        });
    }
    handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        // Response to our RPC call
        if (msg.id !== undefined && !msg.method) {
            const pending = this.pendingRpc.get(msg.id);
            if (pending) {
                this.pendingRpc.delete(msg.id);
                if (msg.error) {
                    pending.reject(new Error(msg.error.message));
                }
                else {
                    pending.resolve(msg.result);
                }
            }
            return;
        }
        // Notification from Bus
        if (msg.method === "channel.message") {
            const { message } = msg.params || {};
            if (!message)
                return;
            // Don't echo back our own messages
            if (message.from === this.opts.nodeName)
                return;
            this.forwardToNvim(message);
        }
        if (msg.method === "channel.mention") {
            const { message } = msg.params || {};
            if (message)
                this.forwardToNvim(message);
        }
        if (msg.method === "node.statusChanged") {
            const { name, status } = msg.params || {};
            console.log(`[bridge] node ${name}: ${status}`);
        }
    }
    forwardToNvim(message) {
        if (!this.opts.nvimSock) {
            // No nvim socket — just print to stdout
            console.log(`[${message.from}] ${message.content}`);
            return;
        }
        try {
            // Write message to temp file to avoid quote escaping hell
            const tmpFile = `/private/tmp/acp_bridge_msg.txt`;
            writeFileSync(tmpFile, message.content);
            const expr = `luaeval("require('acp.rpc').bus_post_file('${message.from}','${tmpFile}')")`;
            execFileSync("nvim", ["--server", this.opts.nvimSock, "--remote-expr", expr], {
                timeout: 5000,
            });
        }
        catch (err) {
            console.error(`[bridge] nvim forward failed: ${err.message}`);
        }
    }
    async stop() {
        this.connected = false;
        this.ws?.close();
    }
}
// --- CLI entry ---
export async function main(argv) {
    const args = argv || process.argv.slice(2);
    let port = BUS_PORT;
    let sock = NVIM_SOCK;
    let channelId;
    let nodeName = "nvim";
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "bridge" || args[i] === "br")
            continue; // skip subcommand name
        if (args[i] === "--port" && args[i + 1]) {
            port = parseInt(args[i + 1]);
            i++;
        }
        else if (args[i] === "--sock" && args[i + 1]) {
            sock = args[i + 1];
            i++;
        }
        else if (args[i] === "--channel" && args[i + 1]) {
            channelId = args[i + 1];
            i++;
        }
        else if (args[i] === "--name" && args[i + 1]) {
            nodeName = args[i + 1];
            i++;
        }
    }
    if (!sock) {
        console.log("[bridge] no NVIM_LISTEN_ADDRESS — running in stdout mode");
    }
    const bridge = new NvimBridge({
        busUrl: `ws://localhost:${port}`,
        nvimSock: sock,
        channelId,
        nodeName,
    });
    const shutdown = () => {
        bridge.stop();
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    await bridge.start();
}
// Auto-run when executed directly
const isDirectRun = process.argv[1]?.includes("nvim-bridge");
if (isDirectRun) {
    main().catch((err) => {
        console.error(`[bridge] fatal: ${err.message}`);
        process.exit(1);
    });
}
//# sourceMappingURL=nvim-bridge.js.map