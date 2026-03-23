#!/usr/bin/env npx tsx
/**
 * nvim ↔ Nerve bridge.
 *
 * Connects to Nerve server via WebSocket, registers as "nvim" node,
 * and forwards messages bidirectionally:
 *   Nerve → nvim: channel.message notification → nvim --remote-expr
 *   nvim → Nerve: nvim calls `nerve channel post` (HTTP, no bridge needed)
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

const NERVE_PORT = parseInt(process.env.NERVE_PORT || "4800");
const NVIM_SOCK = process.env.NVIM_LISTEN_ADDRESS || "";

interface BridgeOptions {
  serverUrl: string;
  nvimSock: string;
  channelId?: string;
  nodeName: string;
}

class NvimBridge {
  private ws!: WebSocket;
  private opts: BridgeOptions;
  private rpcId = 1;
  private nodeId?: string;
  private channelId?: string;
  private connected = false;

  constructor(opts: BridgeOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    await this.connectWs();
    await this.register();

    if (this.opts.channelId) {
      await this.joinChannel(this.opts.channelId);
    } else {
      // Auto-join first channel or create one
      const channels = await this.rpc("channel.list", {});
      const list = (channels as any).channels || [];
      if (list.length > 0) {
        await this.joinChannel(list[0].id);
      } else {
        const created = await this.rpc("channel.create", {
          cwd: process.cwd(),
          name: "main",
        });
        await this.joinChannel((created as any).channelId);
      }
    }

    console.log(`[bridge] connected: node=${this.opts.nodeName} channel=${this.channelId}`);
  }

  private connectWs(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.opts.serverUrl);
      this.ws.on("open", () => {
        this.connected = true;
        resolve();
      });
      this.ws.on("error", (err) => {
        if (!this.connected) reject(err);
        else console.error(`[bridge] ws error: ${err.message}`);
      });
      this.ws.on("close", () => {
        this.connected = false;
        console.log("[bridge] disconnected from server");
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

  private async register(): Promise<void> {
    const result = await this.rpc("node.register", {
      name: this.opts.nodeName,
      capabilities: ["ui"],
      permissions: "operator",
    });
    this.nodeId = (result as any).nodeId;
  }

  private async joinChannel(channelId: string): Promise<void> {
    await this.rpc("channel.join", { channelId });
    this.channelId = channelId;
  }

  private pendingRpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
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

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Response to our RPC call
    if (msg.id !== undefined && !msg.method) {
      const pending = this.pendingRpc.get(msg.id);
      if (pending) {
        this.pendingRpc.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Notification from server
    if (msg.method === "channel.message") {
      const { message } = msg.params || {};
      if (!message) return;

      // Don't echo back our own messages
      if (message.from === this.opts.nodeName) return;

      this.forwardToNvim(message);
    }

    if (msg.method === "channel.mention") {
      const { message } = msg.params || {};
      if (message) this.forwardToNvim(message);
    }

    if (msg.method === "node.statusChanged") {
      const { name, status } = msg.params || {};
      console.log(`[bridge] node ${name}: ${status}`);
    }
  }

  private forwardToNvim(message: { from: string; content: string }): void {
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
    } catch (err: any) {
      console.error(`[bridge] nvim forward failed: ${err.message}`);
    }
  }

  async stop(): Promise<void> {
    this.connected = false;
    this.ws?.close();
  }
}

// --- CLI entry ---

export async function main(argv?: string[]) {
  const args = argv || process.argv.slice(2);
  let port = NERVE_PORT;
  let sock = NVIM_SOCK;
  let channelId: string | undefined;
  let nodeName = "nvim";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "bridge" || args[i] === "br") continue; // skip subcommand name
    if (args[i] === "--port" && args[i + 1]) { port = parseInt(args[i + 1]); i++; }
    else if (args[i] === "--sock" && args[i + 1]) { sock = args[i + 1]; i++; }
    else if (args[i] === "--channel" && args[i + 1]) { channelId = args[i + 1]; i++; }
    else if (args[i] === "--name" && args[i + 1]) { nodeName = args[i + 1]; i++; }
  }

  if (!sock) {
    console.log("[bridge] no NVIM_LISTEN_ADDRESS — running in stdout mode");
  }

  const bridge = new NvimBridge({
    serverUrl: `ws://localhost:${port}`,
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
